/* ARC-110 — the database's half of versioned configuration, against real Postgres.
 *
 * Two parts:
 *
 *   1. The text of 0014, always. Cheap guards on what the file declares — no browser
 *      write policy, no browser execute grant, no destructive statement — in the style
 *      of the 0010–0013 tests.
 *
 *   2. The migration APPLIED, when PGlite is available (see tests/pglite-harness.js):
 *      every invariant exercised by statements that should succeed or be refused; RLS
 *      tested as the roles a browser actually holds; the legacy import applied over a
 *      0013 database with real legacy rows; and the production adapter (`supabaseStore`)
 *      driven end to end — publish, intake, snapshot, run, actions, synthetic canary —
 *      over real SQL.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import {
  createDraft,
  importLegacyConfig,
  listHistory,
  publishDraft,
  publishEffectiveConfig,
  resolveEffectiveConfig,
  rollbackConfig,
  updateDraft,
} from '../supabase/functions/_shared/config/engine.ts';
import { moduleScope, TENANT_SCOPE } from '../supabase/functions/_shared/config/model.ts';
import { configHash } from '../supabase/functions/_shared/canonical-json.ts';
import { CONFIG_SCHEMAS } from '../supabase/functions/_shared/registry/schemas.ts';
import { REQUIRED_STEPS, validateLeadRecoveryConfig } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { intakeLead, loadPinnedConfig, runDueActions } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { handleLeadRecoveryAction } from '../supabase/functions/ops/lead-recovery.ts';
import { handleLifecycleAction } from '../supabase/functions/ops/lifecycle.ts';
import {
  activateModule,
  beginTesting,
  recordTestResult,
  selectModule,
} from '../supabase/functions/_shared/lifecycle/engine.ts';
import { leadRecoveryConfig, splitForStorage } from './config-fixtures.js';

const SQL = readFileSync(new URL('../supabase/migrations/0014_versioned_configuration.sql', import.meta.url), 'utf8');
const LR = moduleScope('lead_recovery');
const NOW = new Date('2026-09-16T14:00:00.000Z');

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0014 as written', () => {
  test('no browser role is given a write policy on any configuration table', () => {
    assert.ok(!/create policy[^;]*for\s+(insert|update|delete|all)/i.test(SQL));
    for (const table of ['tenant_config_versions', 'module_config_versions', 'tenant_config_drafts', 'module_config_drafts']) {
      assert.match(SQL, new RegExp(`create policy ${table}_admin_read on public\\.${table}\\s+for select to authenticated using \\(public\\.is_arc_admin\\(\\)\\)`));
    }
  });

  test('publication and rollback are revoked from every browser role and granted to the service role', () => {
    for (const fn of ['publish_config_draft', 'rollback_config_version']) {
      assert.match(SQL, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`));
      assert.match(SQL, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`));
    }
  });

  test('nothing runs with elevated rights, and every function pins its search_path', () => {
    assert.ok(!/security definer/i.test(SQL), 'invoker rights throughout: the only caller is the service role');
    const functions = SQL.match(/create or replace function[\s\S]*?\$fn\$;/g);
    assert.ok(functions.length >= 10);
    for (const fn of functions) assert.match(fn, /set search_path = public/, fn.slice(0, 80));
  });

  test('forward-only: nothing is dropped but one uniqueness rule, which is replaced', () => {
    assert.ok(!/drop table|drop column|truncate|delete from/i.test(SQL));
    const dropped = [...SQL.matchAll(/drop constraint if exists (\w+)/g)].map((m) => m[1]);
    const readded = [...SQL.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(dropped.filter((c) => !readded.includes(c)), ['lead_recovery_config_snapshots_tenant_id_config_hash_key']);
    assert.match(SQL, /create unique index if not exists lead_recovery_config_snapshots_legacy_hash_key/);
  });

  test('the legacy import writes drafts and never versions', () => {
    const section = SQL.slice(SQL.indexOf('-- 4. legacy configuration'), SQL.indexOf('-- 5. snapshots'));
    assert.match(section, /insert into public\.tenant_config_drafts/);
    assert.match(section, /insert into public\.module_config_drafts/);
    assert.ok(!/config_versions/.test(section.replace(/not exists \(select 1 from public\.(tenant|module)_config_versions[^)]*\)/g, '')),
      'the only mention of a version table is the "no versions yet" guard');
  });

  test('the SQL registry seeds exactly the configuration schemas the code registers', () => {
    const seeded = [...SQL.matchAll(/\('(\w+)',\s*(\d+),\s*'(tenant|module)'/g)].map((m) => `${m[1]}@${m[2]}:${m[3]}`).sort();
    const coded = CONFIG_SCHEMAS.map((s) => `${s.key}@${s.version}:${s.scope}`).sort();
    assert.deepEqual(seeded, coded);
  });
});

/* ══ 2. the database ══════════════════════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const uuid = (prefix = 'aaaaaaaa') => {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

async function newTenant(db, name = 'Tenant') {
  const { rows } = await db.query(`insert into public.tenants (name, slug, status) values ($1, $2, 'active') returning id`, [name, `t-${uuid('bbbbbbbb')}`]);
  return rows[0].id;
}

async function newUser(db) {
  const id = uuid('cccccccc');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
  return id;
}

async function newOperator(db) {
  const id = await newUser(db);
  await db.query('insert into public.arc_admins (user_id) values ($1)', [id]);
  return id;
}

async function newMember(db, tenantId) {
  const id = await newUser(db);
  await db.query('insert into public.tenant_members (user_id, tenant_id) values ($1, $2)', [id, tenantId]);
  return id;
}

/** A Twilio number no other tenant in this database holds — G-P5 refuses a shared one. */
let numbers = 1000;
const freshNumber = () => `+1614556${String(numbers++).padStart(4, '0')}`;

/** A tenant configured through the real adapter and the real publish function. */
async function configured(
  db,
  operatorId,
  config = leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: freshNumber() } }),
  name = 'Halstead',
) {
  const tenantId = await newTenant(db, name);
  const store = supabaseStore(restClient(db));
  const result = await publishEffectiveConfig(store, {
    tenantId, moduleKey: 'lead_recovery', config, expected: { tenant: 0, module: 0 },
    actor: { kind: 'operator', userId: operatorId },
  });
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return { tenantId, store, config };
}

/* ── ARC-120: the operator path to live, through the real service and the real 0015 ── */

async function onboard(db, tenantId) {
  for (const step of REQUIRED_STEPS) {
    await db.query(
      `insert into module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, 'lead_recovery', $2, now())
       on conflict (tenant_id, module_key, step_key) do update set done_at = now()`,
      [tenantId, step],
    );
  }
}

const syntheticDeps = (store) => ({
  store,
  liveSender: new RecordingSender(),
  canarySender: new RecordingSender(),
  now: () => new Date(),
  classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier' }) }),
  urls: {},
  uuid: () => crypto.randomUUID(),
  worker: 'db-canary',
});

/** Selected and under test — where a canary may run and nothing live may. */
async function underTest(db, store, tenantId, operatorId) {
  const actor = { type: 'operator', id: operatorId };
  const at = async () => (await store.getLifecycle(tenantId, 'lead_recovery'))?.stateVersion ?? 0;
  const selected = await selectModule(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await at() });
  assert.equal(selected.ok, true, selected.message);
  await onboard(db, tenantId);
  const testing = await beginTesting(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await at() });
  assert.equal(testing.ok, true, testing.message);
}

/** Live on the current versions: select, onboard, test, a passing canary, activate. */
async function goLive(db, store, tenantId, operatorId) {
  const actor = { type: 'operator', id: operatorId };
  const at = async () => (await store.getLifecycle(tenantId, 'lead_recovery'))?.stateVersion ?? 0;
  await underTest(db, store, tenantId, operatorId);
  const d = syntheticDeps(store);
  const intake = await intakeLead(d, {
    tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006',
    customerName: 'Arc canary', serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary',
    consentSms: true, consentSource: 'operator', isCanary: true,
  });
  await runDueActions(d, { tenantId, canaryOnly: true, worker: 'db-canary', limit: 10 });
  const tested = await recordTestResult(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await at(), runId: intake.run.id, passed: true });
  assert.equal(tested.ok, true, tested.message);
  const live = await activateModule(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await at() });
  assert.equal(live.ok, true, live.ok ? '' : `${live.code}: ${JSON.stringify(live.blockers)}`);
}

describe('versions and drafts, enforced by Postgres', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('a publication through the real function is version 1, draft closed, switch created off', async () => {
    const { tenantId } = await configured(db, operator);
    const { rows: versions } = await db.query('select * from module_config_versions where tenant_id = $1', [tenantId]);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[0].published_by, operator);
    const { rows: drafts } = await db.query('select status, published_version_id from module_config_drafts where tenant_id = $1', [tenantId]);
    assert.deepEqual(drafts, [{ status: 'published', published_version_id: versions[0].id }]);
    const { rows: switches } = await db.query('select enabled, config from module_configs where tenant_id = $1', [tenantId]);
    assert.deepEqual(switches, [{ enabled: false, config: {} }]);
    const { rows: audit } = await db.query(`select action, metadata from admin_actions where target_id = $1 order by occurred_at`, [tenantId]);
    assert.deepEqual(audit.map((a) => a.action), ['config.published', 'config.published']);
    assert.ok(!JSON.stringify(audit).includes('+16145550188'), 'no staff number in the audit log');
  });

  test('a published version cannot be updated or deleted, even by the service role', async () => {
    const { tenantId } = await configured(db, operator);
    const { rows: [v] } = await db.query('select id from module_config_versions where tenant_id = $1', [tenantId]);
    assert.match(await refused(db, `update module_config_versions set note = 'x' where id = $1`, [v.id]), /immutable/);
    assert.match(await refused(db, 'delete from module_config_versions where id = $1', [v.id]), /immutable/);
    assert.match(await refused(db, `update tenant_config_versions set config = '{}'::jsonb where tenant_id = $1`, [tenantId]), /immutable/);
  });

  test('a version must be the next number and name the version it replaces', async () => {
    const { tenantId } = await configured(db, operator);
    const { rows: [head] } = await db.query('select * from tenant_config_versions where tenant_id = $1', [tenantId]);
    const insert = `insert into tenant_config_versions (tenant_id, version, schema_key, schema_version, config, config_hash, parent_version_id, source, published_from_draft_id, published_by)
                    values ($1, $2, 'tenant_settings', 1, '{"company_name":"x","timezone":"America/Denver"}', repeat('a', 64), $3, 'draft', $4, $5)`;
    assert.match(await refused(db, insert, [tenantId, 3, head.id, head.published_from_draft_id, operator]), /not the next/);
    assert.match(await refused(db, insert, [tenantId, 2, null, head.published_from_draft_id, operator]), /lineage|must name the version it replaces/);
  });

  test('two versions can never share a number', async () => {
    const { tenantId } = await configured(db, operator);
    await db.exec(`alter table tenant_config_versions disable trigger tenant_config_versions_guard`);
    try {
      const { rows: [head] } = await db.query('select * from tenant_config_versions where tenant_id = $1', [tenantId]);
      const message = await refused(db, `insert into tenant_config_versions (tenant_id, version, schema_key, schema_version, config, config_hash, source, published_from_draft_id, published_by)
                                         values ($1, 1, 'tenant_settings', 1, '{}', repeat('a', 64), 'draft', $2, $3)`, [tenantId, head.published_from_draft_id, operator]);
      assert.match(message, /duplicate key|unique/);
    } finally {
      await db.exec(`alter table tenant_config_versions enable trigger tenant_config_versions_guard`);
    }
  });

  test("a version cannot name another tenant's parent, or the wrong kind of schema", async () => {
    const a = await configured(db, operator);
    const b = await configured(db, operator, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550201' } }), 'B');
    const { rows: [aHead] } = await db.query('select * from tenant_config_versions where tenant_id = $1', [a.tenantId]);
    const { rows: [bHead] } = await db.query('select * from tenant_config_versions where tenant_id = $1', [b.tenantId]);
    await db.exec(`alter table tenant_config_versions disable trigger tenant_config_versions_guard`);
    try {
      assert.match(
        await refused(db, `insert into tenant_config_versions (tenant_id, version, schema_key, schema_version, config, config_hash, parent_version_id, source, published_from_draft_id, published_by)
                           values ($1, 2, 'tenant_settings', 1, '{}', repeat('a', 64), $2, 'draft', $3, $4)`, [b.tenantId, aHead.id, bHead.published_from_draft_id, operator]),
        /foreign key/,
      );
      assert.match(
        await refused(db, `insert into tenant_config_versions (tenant_id, version, schema_key, schema_version, config, config_hash, parent_version_id, source, published_from_draft_id, published_by)
                           values ($1, 2, 'lead_recovery_config', 1, '{}', repeat('a', 64), $2, 'draft', $3, $4)`, [b.tenantId, bHead.id, bHead.published_from_draft_id, operator]),
        /foreign key/,
        'a tenant version cannot be written in a module schema',
      );
    } finally {
      await db.exec(`alter table tenant_config_versions enable trigger tenant_config_versions_guard`);
    }
  });

  test('a module document in a schema no selectable version names is refused', async () => {
    const tenantId = await newTenant(db);
    assert.match(
      await refused(db, `insert into module_config_drafts (tenant_id, module_key, schema_key, schema_version, config) values ($1, 'lead_recovery', 'lead_recovery_config', 2, '{}')`, [tenantId]),
      /arc_config:schema_not_supported|foreign key/,
    );
    assert.match(
      await refused(db, `insert into module_config_drafts (tenant_id, module_key, schema_key, schema_version, config) values ($1, 'estimate_recovery', 'lead_recovery_config', 1, '{}')`, [tenantId]),
      /arc_config:schema_not_supported/,
    );
  });

  test('secret-shaped content is refused in drafts and versions alike', async () => {
    const tenantId = await newTenant(db);
    assert.match(
      await refused(db, `insert into tenant_config_drafts (tenant_id, schema_key, schema_version, config) values ($1, 'tenant_settings', 1, '{"auth_token":"abc"}')`, [tenantId]),
      /no_secrets/,
    );
  });

  test('a draft: one open per scope, revision set by the database, frozen once closed, never deleted', async () => {
    const tenantId = await newTenant(db);
    const { rows: [draft] } = await db.query(
      `insert into tenant_config_drafts (tenant_id, schema_key, schema_version, config, revision) values ($1, 'tenant_settings', 1, '{}', 42) returning *`, [tenantId]);
    assert.equal(draft.revision, 1, 'a caller cannot choose its starting revision');
    assert.match(await refused(db, `insert into tenant_config_drafts (tenant_id, schema_key, schema_version, config) values ($1, 'tenant_settings', 1, '{}')`, [tenantId]), /one_open|duplicate key/);

    const { rows: [edited] } = await db.query(`update tenant_config_drafts set config = '{"company_name":"x"}', revision = 99 where id = $1 returning revision`, [draft.id]);
    assert.equal(edited.revision, 2, 'every write bumps the revision, whatever the caller sends');

    assert.match(await refused(db, `update tenant_config_drafts set base_version = 5 where id = $1`, [draft.id]), /fixed when it is created/);
    await db.query(`update tenant_config_drafts set status = 'discarded' where id = $1`, [draft.id]);
    assert.match(await refused(db, `update tenant_config_drafts set config = '{}' where id = $1`, [draft.id]), /draft_closed/);
    assert.match(await refused(db, 'delete from tenant_config_drafts where id = $1', [draft.id]), /not deleted/);
  });

  test('a draft must start from the current version', async () => {
    const { tenantId } = await configured(db, operator);
    assert.match(
      await refused(db, `insert into module_config_drafts (tenant_id, module_key, schema_key, schema_version, config, base_version) values ($1, 'lead_recovery', 'lead_recovery_config', 1, '{}', 0)`, [tenantId]),
      /stale_draft/,
    );
  });

  test('a stale conditional write touches nothing', async () => {
    const tenantId = await newTenant(db);
    const store = supabaseStore(restClient(db));
    const draft = await store.insertDraft({ tenantId, scope: TENANT_SCOPE, schemaKey: 'tenant_settings', schemaVersion: 1, baseVersionId: null, baseVersion: 0, config: { company_name: 'A' }, actorId: operator });
    assert.ok(await store.updateDraftContent({ tenantId, scope: TENANT_SCOPE, draftId: draft.id, expectedRevision: 1, config: { company_name: 'B' }, actorId: operator }));
    assert.equal(await store.updateDraftContent({ tenantId, scope: TENANT_SCOPE, draftId: draft.id, expectedRevision: 1, config: { company_name: 'C' }, actorId: operator }), null);
    assert.deepEqual((await store.getDraft(tenantId, TENANT_SCOPE, draft.id)).config, { company_name: 'B' });
  });
});

describe('publish and roll back, through the real functions', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('a stale publisher is refused and the newer version stands', async () => {
    const { tenantId, store, config } = await configured(db, operator);
    const actor = { kind: 'operator', userId: operator };
    const a = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config: { ...config, booking_url: 'https://a.example/book' }, expected: { tenant: 1, module: 1 }, actor });
    const b = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config: { ...config, booking_url: 'https://b.example/book' }, expected: { tenant: 1, module: 1 }, actor });
    assert.equal(a.ok, true);
    assert.equal(b.code, 'publication_conflict');
    const { rows } = await db.query('select version, config->>$2 as url from module_config_versions where tenant_id = $1 order by version', [tenantId, 'booking_url']);
    assert.deepEqual(rows, [{ version: 1, url: null }, { version: 2, url: 'https://a.example/book' }]);
  });

  test('the function itself refuses a wrong expected version, a stale revision and a non-operator', async () => {
    const { tenantId, store } = await configured(db, operator);
    const actor = { kind: 'operator', userId: operator };
    const draft = (await createDraft(store, { tenantId, scope: LR, actor })).draft;
    const call = (overrides) => store.publishConfigDraft({
      tenantId, scope: LR, draftId: draft.id, expectedDraftRevision: 1, expectedHeadVersion: 1,
      configHash: 'a'.repeat(64), changeImpact: {}, actorId: operator, note: null, ...overrides,
    });
    await assert.rejects(call({ expectedHeadVersion: 0 }), (e) => e.code === 'publication_conflict');
    await assert.rejects(call({ expectedDraftRevision: 2 }), (e) => e.code === 'draft_conflict');
    const stranger = await newUser(db);
    await assert.rejects(call({ actorId: stranger }), (e) => e.code === 'forbidden');
    const { rows } = await db.query('select count(*)::int as n from module_config_versions where tenant_id = $1', [tenantId]);
    assert.equal(rows[0].n, 1, 'no refused call wrote a version');
  });

  test('no browser role can call the publish or rollback function at all', async () => {
    const tenantId = await newTenant(db);
    for (const role of ['anon', 'authenticated']) {
      const message = await asRole(db, { role, sub: operator }, async (tx) => {
        try {
          await tx.query(`select public.publish_config_draft('tenant', $1, null, gen_random_uuid(), 1, 0, repeat('a', 64), '{}'::jsonb, $2)`, [tenantId, operator]);
          return 'allowed';
        } catch (error) {
          return error.message;
        }
      });
      assert.match(message, /permission denied for function publish_config_draft/, `${role} reached the function: ${message}`);
    }
  });

  test('a rollback through the function is the next version with the old content', async () => {
    const { tenantId, store, config } = await configured(db, operator);
    const actor = { kind: 'operator', userId: operator };
    const two = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config: { ...config, booking_url: 'https://two.example/book' }, expected: { tenant: 1, module: 1 }, actor });
    assert.equal(two.ok, true, two.message);
    const v1 = (await listHistory(store, tenantId, LR)).find((v) => v.version === 1);
    const rolled = await rollbackConfig(store, { tenantId, scope: LR, versionId: v1.id, expectedVersion: 2, actor });
    assert.equal(rolled.ok, true, rolled.message);
    const { rows } = await db.query('select version, source, rollback_of_version_id, config = (select config from module_config_versions where id = $2) as same from module_config_versions where tenant_id = $1 order by version', [tenantId, v1.id]);
    assert.deepEqual(rows.map((r) => [r.version, r.source, r.same]), [[1, 'draft', true], [2, 'draft', false], [3, 'rollback', true]]);
    assert.equal(rows[2].rollback_of_version_id, v1.id);
    const again = await rollbackConfig(store, { tenantId, scope: LR, versionId: rows[2].rollback_of_version_id, expectedVersion: 2, actor });
    assert.equal(again.code, 'publication_conflict');
  });

  test("a number another tenant's current version holds cannot be published (G-P5)", async () => {
    await configured(db, operator, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550300' } }));
    const tenantId = await newTenant(db, 'Copycat');
    const store = supabaseStore(restClient(db));
    const result = await publishEffectiveConfig(store, {
      tenantId, moduleKey: 'lead_recovery', expected: { tenant: 0, module: 0 },
      config: leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550300' } }),
      actor: { kind: 'operator', userId: operator },
    });
    assert.equal(result.code, 'number_claimed');
  });

  test('a draft published by the engine is exactly what the draft held', async () => {
    const { tenantId, store } = await configured(db, operator);
    const actor = { kind: 'operator', userId: operator };
    const draft = (await createDraft(store, { tenantId, scope: TENANT_SCOPE, actor })).draft;
    const edited = await updateDraft(store, { tenantId, scope: TENANT_SCOPE, draftId: draft.id, expectedRevision: 1, patch: { company_name: '  Halstead HVAC  ' }, actor });
    assert.equal(edited.draft.config.company_name, 'Halstead HVAC', 'normalised on the way in');
    const published = await publishDraft(store, { tenantId, scope: TENANT_SCOPE, draftId: draft.id, expectedRevision: edited.draft.revision, expectedVersion: 1, actor });
    assert.equal(published.ok, true, published.message);
    const { rows: [row] } = await db.query('select v.config = d.config as same, v.config_hash from tenant_config_versions v join tenant_config_drafts d on d.id = v.published_from_draft_id where v.id = $1', [published.version.id]);
    assert.equal(row.same, true);
    assert.equal(row.config_hash, await configHash(edited.draft.config));
  });
});

describe('RLS: configuration is operator material', { skip }, () => {
  let db;
  let operator;
  let tenantA;
  let tenantB;
  let memberA;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    tenantA = (await configured(db, operator)).tenantId;
    tenantB = (await configured(db, operator, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550401' } }), 'B')).tenantId;
    memberA = await newMember(db, tenantA);
    const store = supabaseStore(restClient(db));
    await createDraft(store, { tenantId: tenantA, scope: LR, actor: { kind: 'operator', userId: operator } });
  });

  const count = (db, who, table, tenantId) => asRole(db, who, async (tx) =>
    (await tx.query(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenantId])).rows[0].n);

  test('an operator reads every tenant’s versions, drafts and heads', async () => {
    const who = { role: 'authenticated', sub: operator };
    assert.equal(await count(db, who, 'module_config_versions', tenantA), 1);
    assert.equal(await count(db, who, 'module_config_versions', tenantB), 1);
    assert.equal(await count(db, who, 'module_config_drafts', tenantA), 2);
    assert.equal(await count(db, who, 'module_config_heads', tenantA), 1);
  });

  test('a tenant member reads none of it — not their own, not anyone else’s', async () => {
    const who = { role: 'authenticated', sub: memberA };
    for (const table of ['tenant_config_versions', 'module_config_versions', 'tenant_config_drafts', 'module_config_drafts', 'tenant_config_heads', 'module_config_heads']) {
      assert.equal(await count(db, who, table, tenantA), 0, `${table}: own tenant`);
      assert.equal(await count(db, who, table, tenantB), 0, `${table}: other tenant`);
    }
  });

  test('an anonymous caller reads none of it', async () => {
    assert.equal(await count(db, { role: 'anon' }, 'module_config_versions', tenantA), 0);
  });

  test('no browser role can write a version or a draft directly — not even an operator', async () => {
    for (const who of [{ role: 'authenticated', sub: operator }, { role: 'authenticated', sub: memberA }, { role: 'anon' }]) {
      const outcome = await asRole(db, who, async (tx) => {
        const results = [];
        for (const sql of [
          `insert into public.tenant_config_drafts (tenant_id, schema_key, schema_version, config) values ('${tenantB}', 'tenant_settings', 1, '{}')`,
          `update public.module_config_drafts set config = '{}' where tenant_id = '${tenantA}'`,
          `delete from public.module_config_versions where tenant_id = '${tenantA}'`,
        ]) {
          try {
            const r = await tx.query(sql);
            results.push(r.affectedRows ?? 0);
          } catch (error) {
            results.push(error.message);
          }
        }
        return results;
      });
      assert.match(String(outcome[0]), /row-level security|permission denied|arc_config/, `${who.role} inserted a draft`);
      assert.equal(typeof outcome[1] === 'number' ? outcome[1] : 0, 0, `${who.role} updated a draft`);
      assert.equal(typeof outcome[2] === 'number' ? outcome[2] : 0, 0, `${who.role} deleted a version`);
    }
  });

  test('the registry of configuration schemas is readable and unwritable', async () => {
    const who = { role: 'authenticated', sub: memberA };
    const seen = await asRole(db, who, async (tx) => (await tx.query('select key from public.registry_config_schemas order by key')).rows.map((r) => r.key));
    assert.deepEqual(seen, ['lead_recovery_config', 'tenant_settings']);
    assert.match(await refused(db, `update registry_config_schemas set scope = 'tenant' where key = 'lead_recovery_config'`), /fixed at registration/);
  });
});

describe('snapshots and runs, as 0014 leaves them', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('once a tenant is versioned, an unversioned snapshot is refused', async () => {
    const { tenantId } = await configured(db, operator);
    assert.match(
      await refused(db, `insert into lead_recovery_config_snapshots (tenant_id, config_version, schema_version, config, config_hash) values ($1, 1, 1, '{}', repeat('d', 64))`, [tenantId]),
      /must name the versions it was resolved from/,
    );
  });

  test('a snapshot records its module version’s number and schema, of its own tenant', async () => {
    const a = await configured(db, operator);
    const b = await configured(db, operator, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550501' } }), 'B');
    const { rows: [tv] } = await db.query('select id from tenant_config_versions where tenant_id = $1', [a.tenantId]);
    const { rows: [mv] } = await db.query('select id from module_config_versions where tenant_id = $1', [a.tenantId]);
    const { rows: [theirs] } = await db.query('select id from module_config_versions where tenant_id = $1', [b.tenantId]);
    const insert = `insert into lead_recovery_config_snapshots (tenant_id, config_version, schema_version, config, config_hash, tenant_config_version_id, module_config_version_id) values ($1, $2, 1, '{}', repeat('d', 64), $3, $4)`;
    assert.match(await refused(db, insert, [a.tenantId, 5, tv.id, mv.id]), /records its module version's number/);
    assert.match(await refused(db, insert, [a.tenantId, 1, tv.id, theirs.id]), /tenant_mismatch|foreign key/);
    /* a tenant version with no module version is refused by the guard before the check
       constraint is reached; a module version with no tenant version reaches it. */
    assert.match(await refused(db, insert, [a.tenantId, 1, tv.id, null]), /must name the versions/);
    assert.match(await refused(db, insert, [a.tenantId, 1, null, mv.id]), /sources_paired/);
  });

  test('a tenant that is not versioned yet still takes an unversioned snapshot — the import window', async () => {
    const tenantId = await newTenant(db);
    const { rows } = await db.query(`insert into lead_recovery_config_snapshots (tenant_id, config_version, schema_version, config, config_hash) values ($1, 1, 1, '{}', repeat('e', 64)) returning module_config_version_id`, [tenantId]);
    assert.equal(rows[0].module_config_version_id, null);
  });
});

describe('the production adapter, end to end over real SQL', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  const deps = (store, options = {}) => ({
    store,
    liveSender: options.liveSender ?? new RecordingSender(),
    canarySender: options.canarySender ?? new RecordingSender(),
    now: () => options.now ?? new Date(),
    classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier' }) }),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => crypto.randomUUID(),
    worker: 'db-test',
  });

  test('a lead is pinned to a snapshot naming its versions, and every action the database derives carries it', async () => {
    const { tenantId, store } = await configured(db, operator);
    await goLive(db, store, tenantId, operator);
    const result = await intakeLead(deps(store), {
      tenantId, source: 'missed_call', externalRef: 'CA-db-1', phone: '+16145559911',
      intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call',
    });
    assert.equal(result.ok, true, result.outcome);

    const { rows: [row] } = await db.query(`
      select r.config_snapshot_id, r.config_version, r.run_mode, s.tenant_config_version_id, s.module_config_version_id,
             s.config_version as snapshot_version, tv.version as tenant_version, mv.version as module_version
        from automation_runs r
        join lead_recovery_config_snapshots s on s.id = r.config_snapshot_id
        join tenant_config_versions tv on tv.id = s.tenant_config_version_id
        join module_config_versions mv on mv.id = s.module_config_version_id
       where r.tenant_id = $1 and r.id = $2`, [tenantId, result.run.id]);
    assert.equal(row.run_mode, 'live');
    assert.equal(row.tenant_version, 1);
    assert.equal(row.module_version, 1);
    assert.equal(row.config_version, 1);
    const { rows: actions } = await db.query('select config_snapshot_id from scheduled_actions where tenant_id = $1 and run_id = $2', [tenantId, result.run.id]);
    assert.ok(actions.length >= 1);
    for (const a of actions) assert.equal(a.config_snapshot_id, row.config_snapshot_id);
  });

  test('publishing mid-run changes nothing the run was pinned to, and the next lead gets the new version', async () => {
    const { tenantId, store, config } = await configured(db, operator);
    await goLive(db, store, tenantId, operator);
    const lead = (ref, phone) => intakeLead(deps(store), { tenantId, source: 'missed_call', externalRef: ref, phone, intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    const first = await lead('CA-db-2', '+16145559912');

    const renamed = await publishEffectiveConfig(store, {
      tenantId, moduleKey: 'lead_recovery', config: { ...config, company_name: 'Halstead HVAC' },
      expected: { tenant: 1, module: 1 }, actor: { kind: 'operator', userId: operator },
    });
    assert.equal(renamed.ok, true, renamed.message);

    const pinned = await loadPinnedConfig(store, await store.getRun(tenantId, first.run.id));
    assert.equal(pinned.config.company_name, 'Halstead Heating');
    const second = await lead('CA-db-3', '+16145559913');
    const next = await loadPinnedConfig(store, await store.getRun(tenantId, second.run.id));
    assert.equal(next.config.company_name, 'Halstead HVAC');
    assert.equal(next.snapshot.tenantConfigVersionId, (await store.getConfigHead(tenantId, TENANT_SCOPE)).id);
    assert.notEqual(next.snapshot.id, pinned.snapshot.id);
  });

  test('the synthetic canary reaches awaiting_reply, pinned end to end, and sends nothing real', async () => {
    const { tenantId, store } = await configured(db, operator);
    await underTest(db, store, tenantId, operator);
    const live = new RecordingSender();
    const canary = new RecordingSender();
    const d = deps(store, { liveSender: live, canarySender: canary });
    const intake = await intakeLead(d, {
      tenantId, source: 'web_form', externalRef: `canary:${Date.now()}`, phone: '+15005550006',
      customerName: 'Arc canary', serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary',
      consentSms: true, consentSource: 'operator', isCanary: true,
    });
    assert.equal(intake.ok, true, intake.outcome);
    const summary = await runDueActions(d, { tenantId, canaryOnly: true, worker: 'ops-canary', limit: 10 });
    assert.equal(summary.claimed >= 1, true, JSON.stringify(summary));

    const run = await store.getRun(tenantId, intake.run.id);
    assert.equal(run.state, 'awaiting_reply', 'the state the ops canary checks for');
    const { rows } = await db.query(`
      select a.config_snapshot_id = r.config_snapshot_id as same, s.module_config_version_id is not null as versioned
        from scheduled_actions a join automation_runs r on r.id = a.run_id
        join lead_recovery_config_snapshots s on s.id = r.config_snapshot_id
       where a.tenant_id = $1`, [tenantId]);
    assert.ok(rows.length >= 1 && rows.every((r) => r.same && r.versioned));
    assert.equal(live.sent.length, 0, 'the live sender was never used');
    assert.equal(canary.sent.length, 1);
  });

  test('both stores keep the same contract on the same operations', async () => {
    const tenantId = await newTenant(db, 'Parity');
    const production = supabaseStore(restClient(db));
    const memory = new MemoryStore();
    memory.operators.push(operator);
    const actor = { kind: 'operator', userId: operator };
    const config = leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550601' } });

    const run = async (store) => {
      const out = [];
      const first = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config, expected: { tenant: 0, module: 0 }, actor });
      out.push(first.published.map((p) => `${p.version.scope}@${p.version.version}`));
      const stale = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config, expected: { tenant: 0, module: 0 }, actor });
      out.push(stale.code);
      const draft = await createDraft(store, { tenantId, scope: LR, actor });
      const dup = await createDraft(store, { tenantId, scope: LR, actor });
      out.push(dup.code);
      const edit = await updateDraft(store, { tenantId, scope: LR, draftId: draft.draft.id, expectedRevision: 1, patch: { booking_url: 'https://p.example/book' }, actor });
      out.push(edit.draft.revision);
      const conflict = await updateDraft(store, { tenantId, scope: LR, draftId: draft.draft.id, expectedRevision: 1, patch: { booking_url: 'https://q.example/book' }, actor });
      out.push(conflict.code);
      const published = await publishDraft(store, { tenantId, scope: LR, draftId: draft.draft.id, expectedRevision: edit.draft.revision, expectedVersion: 1, actor });
      out.push(published.version.version, published.version.parentVersionId !== null);
      const v1 = (await listHistory(store, tenantId, LR)).at(-1);
      const rolled = await rollbackConfig(store, { tenantId, scope: LR, versionId: v1.id, expectedVersion: 2, actor });
      out.push(rolled.version.version, rolled.version.rollbackOfVersionId === v1.id);
      const resolved = await resolveEffectiveConfig(store, tenantId, 'lead_recovery');
      out.push(resolved.moduleVersion.version, resolved.configHash);
      return out;
    };
    assert.deepEqual(await run(production), await run(memory));
  });
});

describe('the Lead Recovery ops actions, over real SQL', { skip }, () => {
  let db;
  let operator;
  let tenantId;
  let audits;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    tenantId = await newTenant(db, 'Panel');
    audits = [];
  });

  const action = (name, body = {}) => handleLeadRecoveryAction(name, {
    db: restClient(db),
    body: { tenant_id: tenantId, ...body },
    actorId: operator,
    audit: async (verb, targetType, targetId, metadata) => { audits.push({ verb, metadata }); return true; },
    env: { twilioAccountSid: '', twilioAuthToken: '', anthropicKey: '', publicFunctionsBase: 'https://example.test/functions/v1', siteUrl: '' },
  });

  test('the panel reads an unconfigured tenant as unconfigured, with versions 0/0', async () => {
    const got = await action('lead-recovery-get');
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.configured, false);
    assert.deepEqual(got.body.versions, { tenant: 0, module: 0 });
    assert.equal(got.body.valid, false);
    assert.equal(got.body.activation.ok, false);
  });

  test('save publishes through the engine, and a stale form is a 409', async () => {
    const config = leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550801' } });
    const saved = await action('lead-recovery-save-config', { config, expected: { tenant: 0, module: 0 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config_version, 1);
    assert.deepEqual(saved.body.versions, { tenant: 1, module: 1 });

    const stale = await action('lead-recovery-save-config', { config: { ...config, booking_url: 'https://x.example/book' }, expected: { tenant: 0, module: 0 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'publication_conflict');

    const got = await action('lead-recovery-get');
    assert.equal(got.body.configured, true);
    assert.equal(got.body.valid, true);
    assert.deepEqual(got.body.versions, { tenant: 1, module: 1 });
    assert.deepEqual(got.body.config, config);
    const { rows } = await db.query(`select done_at is not null as done from module_onboarding where tenant_id = $1 and step_key = 'business_rules'`, [tenantId]);
    assert.equal(rows[0]?.done, true, 'saving valid rules still ticks step 2');
  });

  test('the routing test reads the published number and finds no other claimant', async () => {
    const routed = await action('lead-recovery-test-routing');
    assert.equal(routed.status, 200, JSON.stringify(routed.body));
    assert.equal(routed.body.number, '+16145550801');
    assert.equal(routed.body.resolves, true);
  });

  test('selection is explicit: the canary is refused until an operator selects the module', async () => {
    const refusedCanary = await action('lead-recovery-canary');
    assert.equal(refusedCanary.status, 409);
    assert.equal(refusedCanary.body.code, 'module_not_selected');
    const selected = await handleLifecycleAction('module-select', {
      store: supabaseStore(restClient(db)), body: { tenant_id: tenantId, expected_state_version: 0 }, actorId: operator,
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.lifecycle.state, 'configuring');
  });

  test('the synthetic canary begins testing, passes, is pinned to the published versions, and is recorded as evidence', async () => {
    const canary = await action('lead-recovery-canary');
    assert.equal(canary.status, 200, JSON.stringify(canary.body));
    assert.equal(canary.body.passed, true);
    assert.equal(canary.body.state, 'awaiting_reply');
    assert.equal(canary.body.lifecycle.state, 'testing', 'asking for a canary on a configuring module began testing it');
    assert.equal(canary.body.evidence.recorded, true);
    assert.equal(canary.body.evidence.accepted, true, 'a pass for the current versions is the accepted test');
    const { rows: [pin] } = await db.query(`
      select s.tenant_config_version_id is not null and s.module_config_version_id is not null as versioned,
             bool_and(a.config_snapshot_id = r.config_snapshot_id) as actions_pinned
        from automation_runs r
        join lead_recovery_config_snapshots s on s.id = r.config_snapshot_id
        join scheduled_actions a on a.run_id = r.id
       where r.tenant_id = $1
       group by s.tenant_config_version_id, s.module_config_version_id`, [tenantId]);
    assert.deepEqual(pin, { versioned: true, actions_pinned: true });
    const { rows } = await db.query(`select done_at is not null as done from module_onboarding where tenant_id = $1 and step_key = 'canary_passed'`, [tenantId]);
    assert.equal(rows[0]?.done, true);
  });

  test('activation is judged on the resolved configuration and still fails closed on missing steps', async () => {
    const refusedActivation = await action('lead-recovery-activate');
    assert.equal(refusedActivation.status, 409);
    assert.ok(refusedActivation.body.missing_steps.length > 0);
    const { rows } = await db.query('select enabled from module_configs where tenant_id = $1', [tenantId]);
    assert.equal(rows[0].enabled, false);
  });

  test('with the checklist done the panel activates, the switch follows, and pause cancels and switches it back', async () => {
    for (const step of REQUIRED_STEPS) {
      const ticked = await action('lead-recovery-set-step', { step_key: step, done: true });
      assert.equal(ticked.status, 200, JSON.stringify(ticked.body));
    }
    const got = await action('lead-recovery-get');
    assert.equal(got.body.activation.ok, true, JSON.stringify(got.body.activation));
    const activated = await action('lead-recovery-activate', { expected_state_version: got.body.lifecycle.lifecycle.state_version });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.lifecycle.state, 'active');
    const { rows: [on] } = await db.query('select enabled from module_configs where tenant_id = $1', [tenantId]);
    assert.equal(on.enabled, true, 'the switch mirrors the lifecycle');
    const { rows: [audit] } = await db.query(`select count(*)::int as n from admin_actions where action = 'module.activate' and target_id = $1`, [tenantId]);
    assert.equal(audit.n, 1, 'written by the transition, in its transaction');

    const stale = await action('lead-recovery-pause', { expected_state_version: got.body.lifecycle.lifecycle.state_version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_state', 'a screen drawn before the activation cannot pause over it');

    const paused = await action('lead-recovery-pause', { expected_state_version: activated.body.lifecycle.state_version });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const { rows: [off] } = await db.query('select enabled from module_configs where tenant_id = $1', [tenantId]);
    assert.equal(off.enabled, false);
  });
});

describe('legacy configuration, migrated over a real 0013 database', { skip }, () => {
  let db;
  let operator;
  let good;
  let bad;
  let legacySnapshot;
  const legacyGood = leadRecoveryConfig();
  const legacyBad = (() => { const c = { ...leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550701' } }) }; delete c.company_name; return c; })();

  before(async () => {
    db = await freshDatabase({
      before: async (d, file) => {
        if (!file.startsWith('0014')) return;
        /* the world as 0013 left it: two tenants configured the old way, one run pinned
           to an unversioned snapshot. */
        good = (await d.query(`insert into tenants (name, slug, status) values ('Legacy Good', 'legacy-good', 'active') returning id`)).rows[0].id;
        bad = (await d.query(`insert into tenants (name, slug, status) values ('Legacy Bad', 'legacy-bad', 'active') returning id`)).rows[0].id;
        await d.query(`insert into module_configs (tenant_id, module_key, enabled, config) values ($1, 'lead_recovery', true, $2)`, [good, JSON.stringify(legacyGood)]);
        await d.query(`insert into module_configs (tenant_id, module_key, enabled, config) values ($1, 'lead_recovery', false, $2)`, [bad, JSON.stringify(legacyBad)]);
        legacySnapshot = (await d.query(`insert into lead_recovery_config_snapshots (tenant_id, config_version, schema_version, config, config_hash) values ($1, 1, 1, $2, repeat('9', 64)) returning *`, [good, JSON.stringify(legacyGood)])).rows[0];
      },
    });
    operator = await newOperator(db);
  });

  test('every legacy row became a pair of open drafts with its provenance, and nothing was published', async () => {
    const { rows: tenantDrafts } = await db.query('select tenant_id, config, origin, status, base_version from tenant_config_drafts order by tenant_id');
    const { rows: moduleDrafts } = await db.query('select tenant_id, config, origin from module_config_drafts');
    assert.equal(tenantDrafts.length, 2);
    assert.equal(moduleDrafts.length, 2);
    const goodDraft = tenantDrafts.find((d) => d.tenant_id === good);
    assert.deepEqual(goodDraft.config, { company_name: 'Halstead Heating', timezone: 'America/New_York' });
    assert.equal(goodDraft.status, 'open');
    assert.equal(goodDraft.origin.legacy.migration, '0014');
    assert.ok(!('company_name' in moduleDrafts.find((d) => d.tenant_id === good).config));
    assert.deepEqual(tenantDrafts.find((d) => d.tenant_id === bad).config, { timezone: 'America/New_York' }, 'a missing field stays missing');
    const { rows } = await db.query('select (select count(*) from tenant_config_versions)::int + (select count(*) from module_config_versions)::int as n');
    assert.equal(rows[0].n, 0);
  });

  test('the legacy column is frozen; the switch now follows the lifecycle and nothing else', async () => {
    assert.match(await refused(db, `update module_configs set config = '{}' where tenant_id = $1`, [good]), /no longer written/);
    assert.match(await refused(db, `insert into module_configs (tenant_id, module_key, config) values ($1, 'lead_recovery', '{"a":1}')`, [await newTenant(db)]), /no longer written/);
    /* 0015: the legacy "on" was backfilled as paused and switched off; writing the mirror
       back on is refused. only an operator's resumption, on tested versions, moves it. */
    const { rows: [row] } = await db.query('select enabled from module_configs where tenant_id = $1', [good]);
    assert.equal(row.enabled, false);
    assert.match(await refused(db, 'update module_configs set enabled = true where tenant_id = $1', [good]), /mirrors the lifecycle/);
  });

  test('the import publishes the valid tenant as version 1 and quarantines the other', async () => {
    const store = supabaseStore(restClient(db));
    const result = await importLegacyConfig(store, { tenantId: null, actor: { kind: 'operator', userId: operator } });
    assert.equal(result.ok, true);
    const byTenant = Object.fromEntries(result.results.map((r) => [r.tenantId, r.status]));
    assert.equal(byTenant[good], 'imported');
    assert.equal(byTenant[bad], 'quarantined');

    const resolved = await resolveEffectiveConfig(store, good, 'lead_recovery');
    assert.equal(resolved.ok, true, resolved.message);
    assert.deepEqual(resolved.config, validateLeadRecoveryConfig(legacyGood).config, 'the same effective behaviour');
    const { rows: [provenance] } = await db.query(`select provenance from module_config_versions where tenant_id = $1`, [good]);
    assert.equal(provenance.provenance.legacy.table, 'module_configs');

    assert.equal((await resolveEffectiveConfig(store, bad, 'lead_recovery')).code, 'missing_published_configuration');
    const { rows: open } = await db.query(`select count(*)::int as n from tenant_config_drafts where tenant_id = $1 and status = 'open'`, [bad]);
    assert.equal(open[0].n, 1, 'the quarantined drafts stay, for an operator to correct');

    const again = await importLegacyConfig(store, { tenantId: good, actor: { kind: 'operator', userId: operator } });
    assert.deepEqual(again.results, [], 'importing twice changes nothing');
  });

  test('the historical snapshot keeps no provenance and cannot start a new run', async () => {
    const { rows: [snapshot] } = await db.query('select tenant_config_version_id, module_config_version_id from lead_recovery_config_snapshots where id = $1', [legacySnapshot.id]);
    assert.deepEqual(snapshot, { tenant_config_version_id: null, module_config_version_id: null });
    const lead = (await db.query(`insert into leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual') returning id`, [good])).rows[0].id;
    assert.match(
      await refused(db, `insert into automation_runs (tenant_id, lead_id, config_snapshot_id) values ($1, $2, $3)`, [good, lead, legacySnapshot.id]),
      /versioned, so a new run must be pinned to a snapshot that names its versions/,
    );
  });

  test('re-applying 0014 is harmless', async () => {
    await db.exec(SQL);
    const { rows } = await db.query('select count(*)::int as n from tenant_config_drafts');
    assert.equal(rows[0].n, 2, 'no second copy of the legacy drafts');
  });
});

describe('the fixture configuration is what the tests say it is', () => {
  test('the split of the fixture puts only tenant fields in the tenant document', () => {
    const { tenant, module } = splitForStorage(leadRecoveryConfig());
    assert.deepEqual(Object.keys(tenant).sort(), ['company_name', 'timezone']);
    assert.ok(!('company_name' in module));
  });
});
