/* ARC-110 — what the production adapter actually sends.
 *
 * ARC-015B's defect was an insert that named every column but one, while the in-memory
 * store kept whole objects and every test passed. So every persistence operation that
 * touches version identity or run pinning is asserted here as the exact snake_case
 * payload, RPC argument list or filter the production adapter produces, through
 * `supabaseDouble`, which stores only what it is sent. Real SQL for the same calls is
 * `tests/config-db.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { moduleScope, TENANT_SCOPE, ConfigStoreError } from '../supabase/functions/_shared/config/model.ts';
import { resolveEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { intakeLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { supabaseDouble } from './supabase-double.js';
import { leadRecoveryConfig, lifecycleRows, publishedConfigRows, seedPublishedConfig } from './config-fixtures.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'ffffffff-0000-4000-8000-000000000001';
const DRAFT = 'dddddddd-1111-4000-8000-000000000001';
const VERSION = 'dddddddd-2222-4000-8000-000000000001';
const LR = moduleScope('lead_recovery');
const NOW = new Date('2026-09-16T14:00:00.000Z');

const lastWrite = (db, table) => db.writes.filter((w) => w.table === table).at(-1);

describe('drafts are written with every identifying column, and guarded by revision', () => {
  test('a module draft insert names its tenant, module, schema and base', async () => {
    const db = supabaseDouble();
    await supabaseStore(db).insertDraft({
      tenantId: TENANT_A, scope: LR, schemaKey: 'lead_recovery_config', schemaVersion: 1,
      baseVersionId: VERSION, baseVersion: 3, config: { booking_url: null }, origin: { legacy: { x: 1 } }, actorId: OPERATOR,
    });
    assert.deepEqual(lastWrite(db, 'module_config_drafts').payload[0], {
      tenant_id: TENANT_A,
      module_key: 'lead_recovery',
      schema_key: 'lead_recovery_config',
      schema_version: 1,
      base_version_id: VERSION,
      base_version: 3,
      config: { booking_url: null },
      origin: { legacy: { x: 1 } },
      created_by: OPERATOR,
    });
  });

  test('a tenant settings draft goes to its own table, with no module column', async () => {
    const db = supabaseDouble();
    await supabaseStore(db).insertDraft({
      tenantId: TENANT_A, scope: TENANT_SCOPE, schemaKey: 'tenant_settings', schemaVersion: 1,
      baseVersionId: null, baseVersion: 0, config: { company_name: 'X', timezone: 'America/Denver' }, actorId: OPERATOR,
    });
    const payload = lastWrite(db, 'tenant_config_drafts').payload[0];
    assert.ok(!('module_key' in payload));
    assert.equal(payload.base_version, 0);
    assert.equal(payload.base_version_id, null);
  });

  test('a draft update sends content and editor only, and matches on the revision it read', async () => {
    const db = supabaseDouble({
      module_config_drafts: [{ id: DRAFT, tenant_id: TENANT_A, module_key: 'lead_recovery', revision: 4, status: 'open', config: {} }],
    });
    const updated = await supabaseStore(db).updateDraftContent({
      tenantId: TENANT_A, scope: LR, draftId: DRAFT, expectedRevision: 4, config: { booking_url: null }, actorId: OPERATOR,
    });
    assert.ok(updated);
    const write = lastWrite(db, 'module_config_drafts');
    assert.deepEqual(write.payload[0], { config: { booking_url: null }, updated_by: OPERATOR },
      'the revision is the trigger’s to set, never the caller’s');
    const filters = write.filters.map(([kind, col, v]) => `${kind}:${col}=${v}`).sort();
    assert.deepEqual(filters, [
      `eq:id=${DRAFT}`, 'eq:module_key=lead_recovery', 'eq:revision=4', 'eq:status=open', `eq:tenant_id=${TENANT_A}`,
    ]);
  });

  test('a stale revision matches no row and comes back as null, not as a write', async () => {
    const db = supabaseDouble({
      module_config_drafts: [{ id: DRAFT, tenant_id: TENANT_A, module_key: 'lead_recovery', revision: 5, status: 'open', config: { a: 1 } }],
    });
    const result = await supabaseStore(db).updateDraftContent({
      tenantId: TENANT_A, scope: LR, draftId: DRAFT, expectedRevision: 4, config: { a: 2 }, actorId: OPERATOR,
    });
    assert.equal(result, null);
    assert.deepEqual(db.table('module_config_drafts')[0].config, { a: 1 });
  });

  test('closing a draft sends its new status only', async () => {
    const db = supabaseDouble({
      tenant_config_drafts: [{ id: DRAFT, tenant_id: TENANT_A, revision: 1, status: 'open', config: {} }],
    });
    await supabaseStore(db).closeDraft({ tenantId: TENANT_A, scope: TENANT_SCOPE, draftId: DRAFT, expectedRevision: 1, status: 'discarded', actorId: OPERATOR });
    assert.deepEqual(lastWrite(db, 'tenant_config_drafts').payload[0], { status: 'discarded', updated_by: OPERATOR });
  });

  test("the database's refusals come back as the engine's codes", async () => {
    const failing = (error) => {
      const db = supabaseDouble();
      const from = db.from;
      db.from = (table) => {
        const builder = from(table);
        builder.single = () => ({ then: (resolve) => resolve({ data: null, error }) });
        return builder;
      };
      return supabaseStore(db);
    };
    const input = { tenantId: TENANT_A, scope: LR, schemaKey: 'lead_recovery_config', schemaVersion: 1, baseVersionId: null, baseVersion: 0, config: {}, actorId: OPERATOR };
    await assert.rejects(failing({ code: '23505', message: 'duplicate key value violates unique constraint "module_config_drafts_one_open"' }).insertDraft(input),
      (e) => e instanceof ConfigStoreError && e.code === 'draft_exists');
    await assert.rejects(failing({ code: 'P0001', message: 'arc_config:stale_draft: a new draft must start from the current version (2)' }).insertDraft(input),
      (e) => e instanceof ConfigStoreError && e.code === 'stale_draft');
    await assert.rejects(failing({ code: '42P01', message: 'relation "module_config_drafts" does not exist' }).insertDraft(input),
      (e) => !(e instanceof ConfigStoreError) && /does not exist/.test(e.message));
  });
});

describe('publication and rollback are one call each, with every expectation in it', () => {
  const returned = {
    id: VERSION, tenant_id: TENANT_A, module_key: 'lead_recovery', version: 4, schema_key: 'lead_recovery_config',
    schema_version: 1, config: { booking_url: null }, config_hash: 'a'.repeat(64), parent_version_id: 'p', rollback_of_version_id: null,
    source: 'draft', published_from_draft_id: DRAFT, provenance: { draft_revision: 2 }, change_impact: { changed_fields: ['booking_url'] },
    created_by: OPERATOR, published_by: OPERATOR, published_at: NOW.toISOString(), note: null, scope: 'module',
  };

  test('publish sends scope, tenant, module, draft, both expectations, hash, impact and actor', async () => {
    const db = supabaseDouble({}, { rpc: { publish_config_draft: () => ({ data: returned, error: null }) } });
    const version = await supabaseStore(db).publishConfigDraft({
      tenantId: TENANT_A, scope: LR, draftId: DRAFT, expectedDraftRevision: 2, expectedHeadVersion: 3,
      configHash: 'a'.repeat(64), changeImpact: { changed_fields: ['booking_url'] }, actorId: OPERATOR, note: 'why',
    });
    assert.deepEqual(db.rpcs.at(-1), {
      name: 'publish_config_draft',
      args: {
        p_scope: 'module',
        p_tenant: TENANT_A,
        p_module_key: 'lead_recovery',
        p_draft_id: DRAFT,
        p_expected_draft_revision: 2,
        p_expected_version: 3,
        p_config_hash: 'a'.repeat(64),
        p_change_impact: { changed_fields: ['booking_url'] },
        p_actor: OPERATOR,
        p_note: 'why',
      },
    });
    assert.equal(version.id, VERSION);
    assert.equal(version.version, 4);
    assert.equal(version.scope, 'module');
    assert.equal(version.moduleKey, 'lead_recovery');
    assert.equal(version.publishedFromDraftId, DRAFT);
    assert.equal(version.parentVersionId, 'p');
  });

  test('a tenant settings publication sends a null module', async () => {
    const db = supabaseDouble({}, { rpc: { publish_config_draft: () => ({ data: { ...returned, module_key: null, scope: 'tenant' }, error: null }) } });
    const version = await supabaseStore(db).publishConfigDraft({
      tenantId: TENANT_A, scope: TENANT_SCOPE, draftId: DRAFT, expectedDraftRevision: 1, expectedHeadVersion: 0,
      configHash: 'b'.repeat(64), changeImpact: {}, actorId: OPERATOR, note: null,
    });
    assert.equal(db.rpcs.at(-1).args.p_scope, 'tenant');
    assert.equal(db.rpcs.at(-1).args.p_module_key, null);
    assert.equal(version.scope, 'tenant');
    assert.equal(version.moduleKey, null);
  });

  test('rollback sends the source version and the expected head, and no content', async () => {
    const db = supabaseDouble({}, { rpc: { rollback_config_version: () => ({ data: { ...returned, source: 'rollback', rollback_of_version_id: 'old' }, error: null }) } });
    const version = await supabaseStore(db).rollbackConfigVersion({
      tenantId: TENANT_A, scope: LR, sourceVersionId: 'old', expectedHeadVersion: 3, changeImpact: {}, actorId: OPERATOR, note: null,
    });
    assert.deepEqual(Object.keys(db.rpcs.at(-1).args).sort(), [
      'p_actor', 'p_change_impact', 'p_expected_version', 'p_module_key', 'p_note', 'p_scope', 'p_source_version_id', 'p_tenant',
    ], 'the function copies the historical content itself — the caller cannot supply any');
    assert.equal(version.rollbackOfVersionId, 'old');
  });

  test("a refusal from the function is the engine's code; a lost race is a conflict", async () => {
    const answer = (error) => supabaseStore(supabaseDouble({}, { rpc: { publish_config_draft: () => ({ data: null, error }) } }));
    const input = { tenantId: TENANT_A, scope: LR, draftId: DRAFT, expectedDraftRevision: 1, expectedHeadVersion: 1, configHash: 'a'.repeat(64), changeImpact: {}, actorId: OPERATOR, note: null };
    for (const code of ['forbidden', 'draft_conflict', 'publication_conflict', 'stale_draft', 'number_claimed', 'module_not_found']) {
      await assert.rejects(answer({ code: 'P0001', message: `arc_config:${code}: the database said so` }).publishConfigDraft(input),
        (e) => e instanceof ConfigStoreError && e.code === code && e.message === 'the database said so');
    }
    await assert.rejects(answer({ code: '23505', message: 'duplicate key value violates unique constraint "module_config_versions_tenant_id_module_key_version_key"' }).publishConfigDraft(input),
      (e) => e.code === 'publication_conflict');
  });
});

describe('heads and history are read from the database, not reconstructed', () => {
  test('the current version comes from the head view, narrowed to the tenant and module', async () => {
    const rows = publishedConfigRows(TENANT_A, leadRecoveryConfig());
    const v2 = { ...rows.module_config_versions[0], id: VERSION, version: 2, config: { ...rows.module_config_versions[0].config, booking_url: 'https://two.example/' } };
    const db = supabaseDouble({ ...rows, module_config_versions: [...rows.module_config_versions, v2] });
    const head = await supabaseStore(db).getConfigHead(TENANT_A, LR);
    assert.equal(head.id, VERSION);
    assert.equal(head.version, 2);
  });

  test('history is newest first', async () => {
    const rows = publishedConfigRows(TENANT_A, leadRecoveryConfig());
    const v2 = { ...rows.module_config_versions[0], id: VERSION, version: 2 };
    const db = supabaseDouble({ ...rows, module_config_versions: [...rows.module_config_versions, v2] });
    const history = await supabaseStore(db).listConfigVersions(TENANT_A, LR, 10);
    assert.deepEqual(history.map((v) => v.version), [2, 1]);
  });

  test('a number routes by published versions, and the frozen legacy column is ignored', async () => {
    const db = supabaseDouble({
      module_configs: [{ tenant_id: '99999999-9999-4999-8999-999999999999', module_key: 'lead_recovery', enabled: true, config: leadRecoveryConfig() }],
      ...publishedConfigRows(TENANT_A, leadRecoveryConfig()),
    });
    const found = await supabaseStore(db).findTenantByTwilioNumber('+16145550100');
    assert.deepEqual(found, { tenantId: TENANT_A, moduleKey: 'lead_recovery' });
  });
});

describe('a production run records exactly which versions it began under', () => {
  function production() {
    const rows = publishedConfigRows(TENANT_A, leadRecoveryConfig(), { versions: { tenant: 1, module: 1 } });
    const db = supabaseDouble({
      module_configs: [{ tenant_id: TENANT_A, module_key: 'lead_recovery', enabled: true, schema_version: 1, config_version: 1, config: {} }],
      tenants: [{ id: TENANT_A, status: 'active' }],
      ...rows,
      /* 0015: live on exactly these versions. */
      ...lifecycleRows(TENANT_A, rows, { state: 'active' }),
    });
    return { db, rows, store: supabaseStore(db) };
  }

  const deps = (store) => ({
    store,
    liveSender: new RecordingSender(),
    canarySender: new RecordingSender(),
    now: () => NOW,
    classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'none' }) }),
    urls: {},
    uuid: () => crypto.randomUUID(),
    worker: 'test',
  });

  test('the snapshot insert names both versions, and the run and its action point at it', async () => {
    const { db, rows, store } = production();
    const result = await intakeLead(deps(store), {
      tenantId: TENANT_A, source: 'missed_call', externalRef: 'CA-adapter-1', phone: '+16145559911',
      intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call',
    });
    assert.equal(result.ok, true, result.outcome);

    const insert = lastWrite(db, 'lead_recovery_config_snapshots').payload[0];
    assert.equal(insert.tenant_config_version_id, rows.tenant_config_versions[0].id);
    assert.equal(insert.module_config_version_id, rows.module_config_versions[0].id);
    assert.equal(insert.config_version, 1, 'the module version number');
    assert.equal(insert.schema_version, 1);

    const [snapshot] = db.table('lead_recovery_config_snapshots');
    const [run] = db.table('automation_runs');
    assert.equal(snapshot.tenant_config_version_id, rows.tenant_config_versions[0].id, 'and it is what Postgres holds');
    assert.equal(run.config_snapshot_id, snapshot.id);
    assert.equal(run.config_version, 1);
    for (const action of db.table('scheduled_actions')) assert.equal(action.config_snapshot_id, snapshot.id);
  });

  test('an unversioned snapshot still names both columns, as null', async () => {
    const db = supabaseDouble();
    await supabaseStore(db).createConfigSnapshot({
      tenantId: TENANT_A, moduleKey: 'lead_recovery', configVersion: 1, schemaVersion: 1, config: {}, configHash: 'c'.repeat(64),
      tenantConfigVersionId: null, moduleConfigVersionId: null,
    });
    const payload = lastWrite(db, 'lead_recovery_config_snapshots').payload[0];
    assert.ok('tenant_config_version_id' in payload && 'module_config_version_id' in payload);
    assert.equal(payload.module_config_version_id, null);
  });

  test('a snapshot that already exists for a version pair is read back by that pair', async () => {
    const existing = { id: 'snap-existing', tenant_id: TENANT_A, module_key: 'lead_recovery', config_version: 1, schema_version: 1, config: {}, config_hash: 'e'.repeat(64), tenant_config_version_id: 'tv', module_config_version_id: 'mv' };
    const db = supabaseDouble({ lead_recovery_config_snapshots: [existing] });
    const from = db.from;
    let first = true;
    db.from = (table) => {
      const builder = from(table);
      if (table === 'lead_recovery_config_snapshots' && first) {
        first = false;
        builder.maybeSingle = () => ({ then: (resolve) => resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "lead_recovery_config_snapshots_sources_key"' } }) });
      }
      return builder;
    };
    const snapshot = await supabaseStore(db).createConfigSnapshot({
      tenantId: TENANT_A, moduleKey: 'lead_recovery', configVersion: 1, schemaVersion: 1, config: {}, configHash: 'f'.repeat(64),
      tenantConfigVersionId: 'tv', moduleConfigVersionId: 'mv',
    });
    assert.equal(snapshot.id, 'snap-existing', 'found by (tenant version, module version), not by content hash');
  });

  test('both stores resolve the same published content to the same configuration and hash', async () => {
    const { store: production_ } = production();
    const memory = new MemoryStore();
    seedPublishedConfig(memory, { tenantId: TENANT_A, config: leadRecoveryConfig() });
    const [fromPostgres, fromMemory] = await Promise.all([
      resolveEffectiveConfig(production_, TENANT_A, 'lead_recovery'),
      resolveEffectiveConfig(memory, TENANT_A, 'lead_recovery'),
    ]);
    assert.equal(fromPostgres.ok, true);
    assert.deepEqual(fromPostgres.config, fromMemory.config);
    assert.equal(fromPostgres.configHash, fromMemory.configHash);
  });
});
