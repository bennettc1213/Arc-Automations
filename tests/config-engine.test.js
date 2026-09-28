/* ARC-110 — versioned tenant configuration, against the in-memory store.
 *
 * Every test is named after the promise it keeps. `MemoryStore` enforces what 0014's
 * constraints, triggers and functions enforce (see `config/memory.ts`); the same
 * promises are run against real Postgres in `tests/config-db.test.js`, and the exact
 * production-adapter payloads are asserted in `tests/config-adapter.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import {
  createDraft,
  discardDraft,
  importLegacyConfig,
  listHistory,
  previewDraft,
  publishDraft,
  publishEffectiveConfig,
  readHistoricalVersion,
  resolveEffectiveConfig,
  resolveVersions,
  rollbackConfig,
  updateDraft,
  validateDraft,
} from '../supabase/functions/_shared/config/engine.ts';
import { analyseChange, auditSafeImpact } from '../supabase/functions/_shared/config/impact.ts';
import { moduleScope, TENANT_SCOPE } from '../supabase/functions/_shared/config/model.ts';
import { configHash } from '../supabase/functions/_shared/canonical-json.ts';
import {
  changeImpact,
  LEAD_RECOVERY_SCHEMA,
  TENANT_SETTINGS_SCHEMA,
} from '../supabase/functions/_shared/registry/schemas.ts';
import { validateLeadRecoveryConfig } from '../supabase/functions/_shared/lead-recovery-config.ts';
import {
  intakeLead,
  loadPinnedConfig,
  runDueActions,
  handleInboundMessage,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { handleConfigAction } from '../supabase/functions/ops/config.ts';
import { leadRecoveryConfig, seedLifecycle, splitForStorage } from './config-fixtures.js';

/* ── fixtures ───────────────────────────────────────────── */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = 'ffffffff-0000-4000-8000-000000000001';
const STRANGER = 'ffffffff-0000-4000-8000-0000000000ff';
const CLIENT_USER = 'cccccccc-0000-4000-8000-000000000001';
const NUMBER_B = '+16145550200';
const CUSTOMER = '+16145559911';
const NOW = new Date('2026-09-16T14:00:00.000Z');

const operator = { kind: 'operator', userId: OPERATOR };
const client = { kind: 'client', userId: CLIENT_USER, tenantId: TENANT_A };
const LR = moduleScope('lead_recovery');

function engineStore() {
  const store = new MemoryStore();
  store.operators.push(OPERATOR);
  return store;
}

async function heads(store, tenantId) {
  const [tenant, module] = await Promise.all([store.getConfigHead(tenantId, TENANT_SCOPE), store.getConfigHead(tenantId, LR)]);
  return { tenant, module };
}

/** Publish a complete effective configuration the way the console's save button does. */
async function configure(store, tenantId = TENANT_A, config = leadRecoveryConfig()) {
  const current = await heads(store, tenantId);
  const result = await publishEffectiveConfig(store, {
    tenantId,
    moduleKey: 'lead_recovery',
    config,
    expected: { tenant: current.tenant?.version ?? 0, module: current.module?.version ?? 0 },
    actor: operator,
  });
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return result;
}

/** Draft, edit, publish — the whole ARC-110 path for one scope. */
async function draftAndPublish(store, tenantId, scope, patch, actor = operator) {
  const created = await createDraft(store, { tenantId, scope, actor });
  assert.equal(created.ok, true, created.ok ? '' : created.message);
  const updated = await updateDraft(store, { tenantId, scope, draftId: created.draft.id, expectedRevision: created.draft.revision, patch, actor });
  assert.equal(updated.ok, true, updated.ok ? '' : `${updated.code}: ${updated.message}`);
  const head = await store.getConfigHead(tenantId, scope);
  return await publishDraft(store, {
    tenantId, scope, draftId: updated.draft.id, expectedRevision: updated.draft.revision,
    expectedVersion: head?.version ?? 0, actor,
  });
}

/** A version row as it would be if an older release had published it — bypassing today's rules. */
function rawVersion(store, tenantId, scope, config, overrides = {}) {
  const list = scope.kind === 'tenant' ? store.tenantConfigVersions : store.moduleConfigVersions;
  const mine = list.filter((v) => v.tenantId === tenantId && v.moduleKey === (scope.moduleKey ?? null));
  const head = mine.reduce((b, v) => (!b || v.version > b.version ? v : b), null);
  const row = Object.freeze({
    id: crypto.randomUUID(), tenantId, scope: scope.kind, moduleKey: scope.moduleKey ?? null,
    version: (head?.version ?? 0) + 1,
    schemaKey: scope.kind === 'tenant' ? 'tenant_settings' : 'lead_recovery_config', schemaVersion: 1,
    config, configHash: 'f'.repeat(64), parentVersionId: head?.id ?? null, rollbackOfVersionId: null,
    source: 'draft', publishedFromDraftId: crypto.randomUUID(), provenance: {}, changeImpact: {},
    createdBy: OPERATOR, publishedBy: OPERATOR, publishedAt: new Date().toISOString(), note: null,
    ...overrides,
  });
  list.push(row);
  return row;
}

let uuidCounter = 0;
function deps(store, options = {}) {
  let clock = options.now ?? NOW;
  return {
    store,
    liveSender: options.liveSender ?? new RecordingSender(),
    canarySender: options.canarySender ?? new RecordingSender(),
    now: () => clock,
    advance(ms) { clock = new Date(clock.getTime() + ms); },
    classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier here' }) }),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => { uuidCounter += 1; return `cccccccc-1100-4000-8000-${String(uuidCounter).padStart(12, '0')}`; },
    worker: 'test',
  };
}

const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A,
  source: 'missed_call',
  externalRef: `CA${String(++uuidCounter).padStart(32, '0')}`,
  phone: CUSTOMER,
  customerName: 'Dana Reyes',
  intakeRef: '+16145550100',
  consentSms: true,
  consentSource: 'inbound_call',
  ...overrides,
});

/** What 0014 §4 does to one legacy module_configs row: two open drafts, provenance kept. */
async function legacyDrafts(store, tenantId, legacy) {
  const origin = { legacy: { table: 'module_configs', module_config_id: crypto.randomUUID(), module_key: 'lead_recovery', config_version: 7, schema_version: 1, migration: '0014' } };
  const tenantDoc = {};
  for (const key of ['company_name', 'timezone']) if (legacy[key] !== undefined && legacy[key] !== null) tenantDoc[key] = legacy[key];
  const { company_name: _c, timezone: _t, ...moduleDoc } = legacy;
  await store.insertDraft({ tenantId, scope: TENANT_SCOPE, schemaKey: 'tenant_settings', schemaVersion: 1, baseVersionId: null, baseVersion: 0, config: tenantDoc, origin, actorId: null });
  await store.insertDraft({ tenantId, scope: LR, schemaKey: 'lead_recovery_config', schemaVersion: 1, baseVersionId: null, baseVersion: 0, config: moduleDoc, origin, actorId: null });
  const row = { tenantId, moduleKey: 'lead_recovery', enabled: false, schemaVersion: 1, configVersion: 7, config: legacy };
  store.configs.push(row);
  return row;
}

/* ══ 1. versions ══════════════════════════════════════════ */

describe('a published version is immutable, and the highest one is current', () => {
  test('the first publication is version 1, with no parent, from a draft that is now closed', async () => {
    const store = engineStore();
    await configure(store);
    const { tenant, module } = await heads(store, TENANT_A);
    for (const head of [tenant, module]) {
      assert.equal(head.version, 1);
      assert.equal(head.parentVersionId, null);
      assert.equal(head.source, 'draft');
      const draft = await store.getDraft(TENANT_A, head.scope === 'tenant' ? TENANT_SCOPE : LR, head.publishedFromDraftId);
      assert.equal(draft.status, 'published');
      assert.equal(draft.publishedVersionId, head.id);
    }
    assert.deepEqual(module.config, splitForStorage(leadRecoveryConfig()).module);
    assert.deepEqual(tenant.config, { company_name: 'Halstead Heating', timezone: 'America/New_York' });
  });

  test('a later publication is a new row that names the one it replaced, and leaves it untouched', async () => {
    const store = engineStore();
    await configure(store);
    const v1 = await store.getConfigHead(TENANT_A, LR);
    const before = JSON.stringify(v1);

    const published = await draftAndPublish(store, TENANT_A, LR, {
      templates: { ...v1.config.templates, followup: '{{company}} again — reply with what you need.' },
    });
    assert.equal(published.ok, true);
    assert.equal(published.version.version, 2);
    assert.equal(published.version.parentVersionId, v1.id);
    assert.notEqual(published.version.id, v1.id);
    assert.equal(JSON.stringify(await store.getConfigVersion(TENANT_A, LR, v1.id)), before, 'version 1 is byte-for-byte what it was');
  });

  test('a published version cannot be changed in place', async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    assert.throws(() => { head.version = 9; }, TypeError);
    assert.throws(() => { head.config.company_name = 'Somebody Else'; }, TypeError);
    assert.throws(() => { head.config.templates.first_response = 'changed'; }, TypeError);
  });

  test('the current version is the highest number, and history lists newest first', async () => {
    const store = engineStore();
    await configure(store);
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://halstead.example/book' }));
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://halstead.example/schedule' }));
    const head = await store.getConfigHead(TENANT_A, LR);
    assert.equal(head.version, 3);
    assert.deepEqual((await listHistory(store, TENANT_A, LR)).map((v) => v.version), [3, 2, 1]);
    assert.equal((await store.getConfigHead(TENANT_A, TENANT_SCOPE)).version, 1, 'unchanged tenant settings were not republished');
  });

  test("one tenant's versions do not exist for another", async () => {
    const store = engineStore();
    await configure(store, TENANT_A);
    const theirs = await store.getConfigHead(TENANT_A, LR);
    assert.equal(await store.getConfigVersion(TENANT_B, LR, theirs.id), null);
    const read = await readHistoricalVersion(store, TENANT_B, LR, theirs.id);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'version_not_found', 'indistinguishable from an id that never existed');
  });

  test('a module version is not a tenant settings version', async () => {
    const store = engineStore();
    await configure(store);
    const moduleHead = await store.getConfigHead(TENANT_A, LR);
    assert.equal(await store.getConfigVersion(TENANT_A, TENANT_SCOPE, moduleHead.id), null);
    assert.equal(await store.getConfigVersion(TENANT_A, moduleScope('estimate_recovery'), moduleHead.id), null);
  });

  test('a version number can only ever be the next one', async () => {
    const store = engineStore();
    await configure(store);
    const draft = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator });
    await assert.rejects(
      store.publishConfigDraft({
        tenantId: TENANT_A, scope: LR, draftId: draft.draft.id, expectedDraftRevision: draft.draft.revision,
        expectedHeadVersion: 0, configHash: 'a'.repeat(64), changeImpact: {}, actorId: OPERATOR, note: null,
      }),
      (error) => error.code === 'publication_conflict',
    );
  });
});

/* ══ 2. drafts ════════════════════════════════════════════ */

describe('a draft is work in progress, and never what runs', () => {
  test('a draft opens on the current version', async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    const created = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator });
    assert.equal(created.ok, true);
    assert.equal(created.draft.baseVersion, head.version);
    assert.equal(created.draft.baseVersionId, head.id);
    assert.deepEqual(created.draft.config, head.config);
    assert.equal(created.draft.revision, 1);
    assert.equal(created.draft.status, 'open');
  });

  test("a tenant's first draft starts from the registry's defaults, without the tenant-owned fields", async () => {
    const store = engineStore();
    const created = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator });
    assert.equal(created.ok, true);
    assert.equal(created.draft.baseVersion, 0);
    assert.equal(created.draft.baseVersionId, null);
    assert.ok(!('company_name' in created.draft.config) && !('timezone' in created.draft.config));
    assert.ok('templates' in created.draft.config);

    const tenantDraft = await createDraft(store, { tenantId: TENANT_A, scope: TENANT_SCOPE, actor: operator });
    assert.deepEqual(Object.keys(tenantDraft.draft.config).sort(), ['company_name', 'timezone']);
  });

  test('a scope has at most one open draft', async () => {
    const store = engineStore();
    await configure(store);
    const first = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator });
    const second = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'draft_exists');
    assert.equal(second.detail.draft_id, first.draft.id);
  });

  test('an operator may change the fields the registry lets an operator change', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const updated = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: { booking_url: 'https://halstead.example/book' }, actor: operator,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.draft.revision, 2);
    assert.equal(updated.draft.config.booking_url, 'https://halstead.example/book');
    assert.equal(updated.draft.updatedBy, OPERATOR);
  });

  test('a client can neither open nor edit a draft — no field is client-editable (ARC-310)', async () => {
    const store = engineStore();
    await configure(store);
    const opened = await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: client });
    assert.equal(opened.ok, false);
    assert.equal(opened.code, 'edit_permission_denied');

    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const edited = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: { booking_url: 'https://evil.example' }, actor: client,
    });
    assert.equal(edited.ok, false);
    assert.equal(edited.code, 'edit_permission_denied');
    assert.deepEqual(edited.fieldErrors.map((e) => e.path), ['booking_url']);
    assert.equal((await store.getDraft(TENANT_A, LR, draft.id)).revision, 1, 'nothing was written');
  });

  test("a client cannot address another tenant's configuration at all", async () => {
    const store = engineStore();
    await configure(store, TENANT_B, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: NUMBER_B } }));
    const result = await createDraft(store, { tenantId: TENANT_B, scope: LR, actor: client });
    assert.equal(result.code, 'tenant_mismatch');
  });

  test('a module draft cannot carry a tenant-wide field', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: { company_name: 'Somebody Else' }, actor: operator,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation_failed');
    assert.deepEqual(result.fieldErrors.map((e) => e.path), ['company_name']);
  });

  test('an unknown field is refused by name', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: { custom_webhook: 'https://evil.test' }, actor: operator,
    });
    assert.equal(result.code, 'validation_failed');
    assert.equal(result.fieldErrors[0].path, 'custom_webhook');
  });

  test('an invalid value is refused, field by field, and the draft is left as it was', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: { forwarding: { destination: '614-555-0137', timeout_seconds: 20 } }, actor: operator,
    });
    assert.equal(result.code, 'validation_failed');
    assert.ok(result.fieldErrors.some((e) => e.path === 'forwarding.destination'), JSON.stringify(result.fieldErrors));
    const after = await store.getDraft(TENANT_A, LR, draft.id);
    assert.equal(after.revision, 1);
    assert.deepEqual(after.config, draft.config);
  });

  test('a credential pasted into configuration is refused, in either scope', async () => {
    const store = engineStore();
    await configure(store);
    const tenantDraft = (await createDraft(store, { tenantId: TENANT_A, scope: TENANT_SCOPE, actor: operator })).draft;
    const result = await updateDraft(store, {
      tenantId: TENANT_A, scope: TENANT_SCOPE, draftId: tenantDraft.id, expectedRevision: 1,
      patch: { company_name: 'sk-live0123456789abcdefghij' }, actor: operator,
    });
    assert.equal(result.code, 'validation_failed');
    assert.match(result.fieldErrors[0].message, /looks like an API key/);
  });

  test('a stale revision conflicts, and the newer write survives', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;

    /* two operators both read revision 1. */
    const a = await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, patch: { booking_url: 'https://a.example/book' }, actor: operator });
    const b = await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, patch: { booking_url: 'https://b.example/book' }, actor: operator });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'draft_conflict');
    assert.equal(b.detail.revision, 2);
    assert.equal((await store.getDraft(TENANT_A, LR, draft.id)).config.booking_url, 'https://a.example/book');
  });

  test('a write without the revision it read is refused', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: undefined, patch: { booking_url: 'https://x.example' }, actor: operator });
    assert.equal(result.code, 'draft_conflict');
  });

  test('an open draft is never what resolves', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: TENANT_SCOPE, actor: operator })).draft;
    await updateDraft(store, { tenantId: TENANT_A, scope: TENANT_SCOPE, draftId: draft.id, expectedRevision: 1, patch: { company_name: 'Draft Name Only' }, actor: operator });
    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(resolved.ok, true);
    assert.equal(resolved.config.company_name, 'Halstead Heating');
  });

  test('a discarded draft is closed for good, and discarding needs the current revision', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const stale = await discardDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 7, actor: operator });
    assert.equal(stale.code, 'draft_conflict');
    const discarded = await discardDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, actor: operator });
    assert.equal(discarded.ok, true);
    assert.equal(discarded.draft.status, 'discarded');
    const after = await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 2, patch: { booking_url: 'https://x.example' }, actor: operator });
    assert.equal(after.code, 'draft_closed');
    assert.ok(await store.getDraft(TENANT_A, LR, draft.id), 'kept as evidence, not deleted');
  });

  test('a module draft is validated against the tenant settings it will run with', async () => {
    const store = engineStore();
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await updateDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      patch: splitForStorage(leadRecoveryConfig()).module, actor: operator,
    });
    assert.equal(result.code, 'missing_published_configuration', 'tenant settings come first');
  });

  test('validating and previewing a draft write nothing', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, patch: { booking_url: 'https://halstead.example/book' }, actor: operator });
    const validated = await validateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id });
    assert.equal(validated.check.valid, true);
    const preview = await previewDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, actor: operator });
    assert.deepEqual(preview.impact.changedFields, ['booking_url']);
    assert.equal(preview.baseIsCurrent, true);
    assert.deepEqual(preview.deniedFields, []);
    assert.equal((await store.getDraft(TENANT_A, LR, draft.id)).revision, 2);
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1);
  });
});

/* ══ 3. publication ═══════════════════════════════════════ */

describe('publication is an operator act, atomic, and never overwrites newer work', () => {
  test('an operator publishes a draft as the next version and is told what it costs', async () => {
    const store = engineStore();
    await configure(store);
    const v1 = await store.getConfigHead(TENANT_A, LR);
    const published = await draftAndPublish(store, TENANT_A, LR, {
      compliance: { ...v1.config.compliance, status: 'pending' },
    });
    assert.equal(published.ok, true);
    assert.equal(published.version.version, 2);
    assert.equal(published.version.schemaKey, 'lead_recovery_config');
    assert.equal(published.version.schemaVersion, 1);
    assert.equal(published.version.publishedBy, OPERATOR);
    assert.deepEqual(published.impact.changedFields, ['compliance']);
    assert.equal(published.impact.aggregate.requiresReactivation, true, 'from the registry, not a second list');
  });

  test('a client cannot publish', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 1, actor: client });
    assert.equal(result.code, 'forbidden');
  });

  test('the engine refuses a client by what it is, not only by who the database knows', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    /* the same person acting through a client session: the database would accept the
       user id, so only the engine's own rule stands between this and a publication. */
    const sameUserAsClient = { kind: 'client', userId: OPERATOR, tenantId: TENANT_A };
    const result = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 1, actor: sameUserAsClient });
    assert.equal(result.code, 'forbidden');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1);
  });

  test('the publish function refuses a caller who is not an operator, whatever the engine says', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const result = await publishDraft(store, {
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 1,
      actor: { kind: 'operator', userId: STRANGER },
    });
    assert.equal(result.code, 'forbidden', 'arc_admins is checked where the version is written');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1);
  });

  test('publication validates the draft again, in full', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    /* content that got into the draft some other way than through updateDraft. */
    const tampered = await store.updateDraftContent({
      tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1,
      config: { ...draft.config, forwarding: { destination: 'nowhere', timeout_seconds: 20 } }, actorId: OPERATOR,
    });
    const result = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: tampered.revision, expectedVersion: 1, actor: operator });
    assert.equal(result.code, 'validation_failed');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1, 'nothing was published');
  });

  test('a stale writer is refused and the newer version stands', async () => {
    const store = engineStore();
    await configure(store);
    /* both operators loaded version 1. A saves first. */
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://a.example/book' }));
    const b = await publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery',
      config: leadRecoveryConfig({ booking_url: 'https://b.example/book' }),
      expected: { tenant: 1, module: 1 }, actor: operator,
    });
    assert.equal(b.ok, false);
    assert.equal(b.code, 'publication_conflict');
    const head = await store.getConfigHead(TENANT_A, LR);
    assert.equal(head.version, 2);
    assert.equal(head.config.booking_url, 'https://a.example/book');
    assert.deepEqual((await listHistory(store, TENANT_A, LR)).map((v) => v.version), [2, 1]);
  });

  test('a draft written against an older version cannot be published over a newer one', async () => {
    const store = engineStore();
    await configure(store);
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://two.example' }));
    const v1 = (await listHistory(store, TENANT_A, LR)).find((v) => v.version === 1);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v1.id, expectedVersion: 2, actor: operator });

    const asIfCurrent = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 3, actor: operator });
    assert.equal(asIfCurrent.code, 'stale_draft');
    const asRead = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 2, actor: operator });
    assert.equal(asRead.code, 'publication_conflict');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 3);
  });

  test('a draft revision the publisher did not read cannot be published', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, patch: { booking_url: 'https://x.example' }, actor: operator });
    const result = await publishDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, expectedVersion: 1, actor: operator });
    assert.equal(result.code, 'draft_conflict');
  });

  test('two publishers of the same draft at once produce exactly one version', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    const edited = await updateDraft(store, { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: 1, patch: { booking_url: 'https://x.example' }, actor: operator });
    const args = { tenantId: TENANT_A, scope: LR, draftId: draft.id, expectedRevision: edited.draft.revision, expectedVersion: 1, actor: operator };
    const outcomes = await Promise.all([publishDraft(store, args), publishDraft(store, args)]);
    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    assert.deepEqual((await listHistory(store, TENANT_A, LR)).map((v) => v.version), [2, 1], 'one head, no gap, no duplicate');
  });

  test('two saves from forms loaded at the same version produce one new version', async () => {
    const store = engineStore();
    await configure(store);
    const save = (url) => publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery', config: leadRecoveryConfig({ booking_url: url }),
      expected: { tenant: 1, module: 1 }, actor: operator,
    });
    const outcomes = await Promise.all([save('https://a.example/book'), save('https://b.example/book')]);
    assert.equal(outcomes.filter((o) => o.ok).length, 1, JSON.stringify(outcomes.map((o) => o.code ?? 'ok')));
    const versions = (await listHistory(store, TENANT_A, LR)).map((v) => v.version);
    assert.deepEqual(versions, [2, 1]);
  });

  test('publication leaves audit evidence with no configuration values in it', async () => {
    const store = engineStore();
    await configure(store);
    const v1 = await store.getConfigHead(TENANT_A, LR);
    await draftAndPublish(store, TENANT_A, LR, {
      staff_alerts: [{ name: 'Robin', channel: 'sms', address: '+16145550177' }],
      templates: { ...v1.config.templates, handoff_ack: 'Thanks — the {{company}} team will call you shortly.' },
    });
    const entry = store.adminActions.at(-1);
    assert.equal(entry.action, 'config.published');
    assert.equal(entry.actorUserId, OPERATOR);
    assert.equal(entry.targetId, TENANT_A);
    assert.equal(entry.metadata.version, 2);
    assert.deepEqual(entry.metadata.impact.changed_fields.sort(), ['staff_alerts', 'templates']);
    const logged = JSON.stringify(store.adminActions);
    for (const secretish of ['+16145550177', '+16145550188', 'Robin', 'will call you shortly', 'Halstead']) {
      assert.ok(!logged.includes(secretish), `the audit log repeats ${secretish}`);
    }
  });

  test('publishing configuration never switches a module on', async () => {
    const store = engineStore();
    await configure(store);
    const row = store.configs.find((c) => c.tenantId === TENANT_A);
    assert.equal(row.enabled, false, 'activation is ARC-120 — publication only creates the switch, off');
    assert.deepEqual(row.config, {}, 'and writes no configuration into the legacy column');
  });

  test("a number already routing to one tenant cannot be published for another (G-P5)", async () => {
    const store = engineStore();
    await configure(store, TENANT_A);
    const result = await publishEffectiveConfig(store, {
      tenantId: TENANT_B, moduleKey: 'lead_recovery', config: leadRecoveryConfig({ company_name: 'Boise Plumbing' }),
      expected: { tenant: 0, module: 0 }, actor: operator,
    });
    assert.equal(result.code, 'number_claimed');
    assert.equal(await store.getConfigHead(TENANT_B, LR), null);
    assert.equal((await store.findTenantByTwilioNumber('+16145550100')).tenantId, TENANT_A);
  });
});

/* ══ 4. rollback ══════════════════════════════════════════ */

describe('a rollback is the next version, carrying older content', () => {
  async function threeVersions() {
    const store = engineStore();
    await configure(store);
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://two.example' }));
    const [v2, v1] = await listHistory(store, TENANT_A, LR);
    return { store, v1, v2 };
  }

  test('rolling back publishes a new version with the old content and leaves history alone', async () => {
    const { store, v1, v2 } = await threeVersions();
    const before = JSON.stringify([v1, v2]);
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v1.id, expectedVersion: 2, actor: operator });
    assert.equal(result.ok, true);
    assert.equal(result.version.version, 3);
    assert.notEqual(result.version.id, v1.id);
    assert.equal(result.version.rollbackOfVersionId, v1.id);
    assert.equal(result.version.parentVersionId, v2.id);
    assert.equal(result.version.source, 'rollback');
    assert.deepEqual(result.version.config, v1.config);
    assert.equal(JSON.stringify([await store.getConfigVersion(TENANT_A, LR, v1.id), await store.getConfigVersion(TENANT_A, LR, v2.id)]), before);
    assert.deepEqual((await listHistory(store, TENANT_A, LR)).map((v) => v.version), [3, 2, 1]);
    assert.equal(store.adminActions.at(-1).action, 'config.rolled_back');
    assert.deepEqual(result.impact.changedFields, ['booking_url'], 'impact is measured against the version it replaces');
  });

  test("another tenant's version cannot be rolled back to", async () => {
    const { store, v1 } = await threeVersions();
    await configure(store, TENANT_B, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: NUMBER_B } }));
    const result = await rollbackConfig(store, { tenantId: TENANT_B, scope: LR, versionId: v1.id, expectedVersion: 1, actor: operator });
    assert.equal(result.code, 'version_not_found');
  });

  test("a version of another scope cannot be rolled back to", async () => {
    const { store, v1 } = await threeVersions();
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: TENANT_SCOPE, versionId: v1.id, expectedVersion: 1, actor: operator });
    assert.equal(result.code, 'version_not_found');
  });

  test('a rollback against a version that is no longer current is refused', async () => {
    const { store, v1 } = await threeVersions();
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v1.id, expectedVersion: 1, actor: operator });
    assert.equal(result.code, 'publication_conflict');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 2);
  });

  test('rolling back to the current version is not a change', async () => {
    const { store, v2 } = await threeVersions();
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v2.id, expectedVersion: 2, actor: operator });
    assert.equal(result.code, 'no_change');
  });

  test("a version today's rules refuse cannot be republished silently", async () => {
    const store = engineStore();
    await configure(store);
    const v1 = await store.getConfigHead(TENANT_A, LR);
    /* published by an older release whose validator allowed a placeholder today's does not. */
    const old = rawVersion(store, TENANT_A, LR, { ...v1.config, templates: { ...v1.config.templates, followup: 'Use code {{coupon}}' } });
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://three.example' }));
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: old.id, expectedVersion: 3, actor: operator });
    assert.equal(result.code, 'rollback_incompatible');
    assert.ok(result.fieldErrors.some((e) => e.path.startsWith('templates.followup')));
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 3);
  });

  test('a version in a schema this build no longer runs cannot be rolled back to', async () => {
    const store = engineStore();
    await configure(store);
    const v1 = await store.getConfigHead(TENANT_A, LR);
    const old = rawVersion(store, TENANT_A, LR, v1.config, { schemaVersion: 2 });
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://three.example' }));
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: old.id, expectedVersion: 3, actor: operator });
    assert.equal(result.code, 'rollback_incompatible');
  });

  test('a client cannot roll back', async () => {
    const { store, v1 } = await threeVersions();
    const result = await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v1.id, expectedVersion: 2, actor: client });
    assert.equal(result.code, 'forbidden');
  });
});

/* ══ 5. resolution ════════════════════════════════════════ */

describe('there is one resolver, and it only reads published versions', () => {
  test('it composes the current tenant settings and module version, and says which', async () => {
    const store = engineStore();
    await configure(store);
    const { tenant, module } = await heads(store, TENANT_A);
    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.tenantVersion, { id: tenant.id, version: 1, schemaKey: 'tenant_settings', schemaVersion: 1 });
    assert.deepEqual(resolved.moduleVersion, { id: module.id, version: 1, schemaKey: 'lead_recovery_config', schemaVersion: 1 });
    assert.deepEqual(resolved.config, leadRecoveryConfig());
    assert.equal(resolved.configHash, await configHash(leadRecoveryConfig()));
  });

  test('the same versions always resolve to the same configuration', async () => {
    const store = engineStore();
    await configure(store);
    const a = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    const b = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    const c = await resolveVersions(store, TENANT_A, 'lead_recovery', a.tenantVersion.id, a.moduleVersion.id);
    assert.deepEqual(a.config, b.config);
    assert.equal(a.configHash, b.configHash);
    assert.equal(c.configHash, a.configHash);
  });

  test('publishing changes what resolves next, and nothing already resolved', async () => {
    const store = engineStore();
    await configure(store);
    const before = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    const frozen = JSON.stringify(before);
    await configure(store, TENANT_A, leadRecoveryConfig({ company_name: 'Halstead HVAC' }));
    const after = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(after.config.company_name, 'Halstead HVAC');
    assert.equal(after.tenantVersion.version, 2);
    assert.equal(JSON.stringify(before), frozen);
    const replay = await resolveVersions(store, TENANT_A, 'lead_recovery', before.tenantVersion.id, before.moduleVersion.id);
    assert.equal(replay.config.company_name, 'Halstead Heating', 'the old pair still resolves to what it was');
  });

  test('no published configuration means none — there is no default', async () => {
    const store = engineStore();
    const nothing = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(nothing.code, 'missing_published_configuration');
    await draftAndPublish(store, TENANT_A, TENANT_SCOPE, { company_name: 'Halstead Heating', timezone: 'America/New_York' });
    const halfway = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(halfway.code, 'missing_published_configuration');
    assert.match(halfway.message, /lead_recovery/);
  });

  test('a module with no registered schema does not resolve', async () => {
    const store = engineStore();
    await configure(store);
    assert.equal((await resolveEffectiveConfig(store, TENANT_A, 'estimate_recovery')).code, 'module_not_found');
    assert.equal((await resolveEffectiveConfig(store, TENANT_A, 'made_up')).code, 'module_not_found');
  });

  test('a version in a schema this build does not run fails closed', async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    rawVersion(store, TENANT_A, LR, head.config, { schemaVersion: 2 });
    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(resolved.code, 'schema_not_supported');
  });

  test('a module version that carries a tenant field fails closed rather than choosing one', async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    rawVersion(store, TENANT_A, LR, { ...head.config, company_name: 'Which One Wins' });
    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(resolved.code, 'validation_failed');
    assert.deepEqual(resolved.fieldErrors.map((e) => e.path), ['company_name']);
  });

  test('a published version that no longer validates fails closed', async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    rawVersion(store, TENANT_A, LR, { ...head.config, forwarding: { destination: '', timeout_seconds: 20 } });
    assert.equal((await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery')).code, 'validation_failed');
  });

  test("a pair of versions from two tenants does not resolve", async () => {
    const store = engineStore();
    await configure(store, TENANT_A);
    await configure(store, TENANT_B, leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: NUMBER_B } }));
    const a = await heads(store, TENANT_A);
    const b = await heads(store, TENANT_B);
    assert.equal((await resolveVersions(store, TENANT_A, 'lead_recovery', a.tenant.id, b.module.id)).code, 'version_not_found');
  });

  test('the frozen legacy column is never read', async () => {
    const store = engineStore();
    await configure(store);
    store.configs[0].config = leadRecoveryConfig({ company_name: 'Legacy Row Says Otherwise' });
    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    assert.equal(resolved.config.company_name, 'Halstead Heating');
  });
});

/* ══ 6. change impact ═════════════════════════════════════ */

describe('change impact is the registry’s answer', () => {
  const base = splitForStorage(leadRecoveryConfig()).module;

  test('nested changes are found at their own path', () => {
    const after = structuredClone(base);
    after.templates.first_response = 'Hi{{customer_name}}, {{company}} here — what do you need?';
    after.business_hours.mon[0].open = '07:30';
    const report = analyseChange(LEAD_RECOVERY_SCHEMA, base, after);
    assert.deepEqual(report.changes.map((c) => c.path).sort(), ['business_hours.mon[0].open', 'templates.first_response']);
    assert.deepEqual(report.changedFields.sort(), ['business_hours', 'templates']);
  });

  test('every field is judged by its own registry metadata, and the total is changeImpact()', () => {
    for (const field of LEAD_RECOVERY_SCHEMA.fields) {
      if (field.ownerScope === 'tenant') continue;
      const after = { ...base, [field.key]: '__changed__' };
      const report = analyseChange(LEAD_RECOVERY_SCHEMA, base, after);
      const change = report.changes.find((c) => c.field === field.key);
      assert.equal(change.requiresRetest, field.requiresRetest, `${field.key}.requiresRetest`);
      assert.equal(change.requiresShadow, field.requiresShadow, `${field.key}.requiresShadow`);
      assert.equal(change.requiresReactivation, field.requiresReactivation, `${field.key}.requiresReactivation`);
      assert.deepEqual(report.aggregate, changeImpact('lead_recovery_config', report.changedFields));
    }
  });

  test('the impact code names no field, so there is no second list to drift', () => {
    const source = readFileSync(new URL('../supabase/functions/_shared/config/impact.ts', import.meta.url), 'utf8');
    for (const field of LEAD_RECOVERY_SCHEMA.fields) {
      assert.ok(!source.includes(`'${field.key}'`), `impact.ts hard-codes ${field.key}`);
    }
  });

  test('a sensitive field is reported without its values', () => {
    const after = { ...base, staff_alerts: [{ name: 'Robin', channel: 'sms', address: '+16145550177' }] };
    const change = analyseChange(LEAD_RECOVERY_SCHEMA, base, after).changes.find((c) => c.field === 'staff_alerts');
    assert.equal(change.redacted, true);
    assert.ok(!('before' in change) && !('after' in change));
  });

  test('an ordinary field is reported with before and after', () => {
    const after = { ...base, booking_url: 'https://halstead.example/book' };
    const [change] = analyseChange(LEAD_RECOVERY_SCHEMA, base, after).changes;
    assert.equal(change.before, null);
    assert.equal(change.after, 'https://halstead.example/book');
  });

  test('a tenant timezone change names the modules that read it', () => {
    const before = { company_name: 'Halstead Heating', timezone: 'America/New_York' };
    const report = analyseChange(TENANT_SETTINGS_SCHEMA, before, { ...before, timezone: 'America/Denver' });
    assert.deepEqual(report.affectedModules, [{ moduleKey: 'lead_recovery', fields: ['timezone'] }]);
    assert.equal(report.aggregate.requiresRetest, true);
    const renamed = analyseChange(TENANT_SETTINGS_SCHEMA, before, { ...before, company_name: 'Halstead HVAC' });
    assert.equal(renamed.aggregate.requiresRetest, false, 'the same answer the registry gives for a cosmetic change');
  });

  test('the audit copy carries paths and flags, never values', () => {
    const after = { ...base, booking_url: 'https://private.example/secret-path' };
    const safe = auditSafeImpact(analyseChange(LEAD_RECOVERY_SCHEMA, base, after));
    assert.deepEqual(safe.changed_fields, ['booking_url']);
    assert.ok(!JSON.stringify(safe).includes('private.example'));
  });
});

/* ══ 7. legacy configuration ══════════════════════════════ */

describe('legacy Lead Recovery configuration becomes version 1, or stays quarantined', () => {
  test('a valid legacy row is published as version 1 and resolves to exactly what it was', async () => {
    const store = engineStore();
    const legacy = leadRecoveryConfig();
    await legacyDrafts(store, TENANT_A, legacy);
    const result = await importLegacyConfig(store, { tenantId: null, actor: operator });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((r) => [r.tenantId, r.status]), [[TENANT_A, 'imported']]);

    const { tenant, module } = await heads(store, TENANT_A);
    assert.equal(tenant.version, 1);
    assert.equal(module.version, 1);
    assert.equal(module.provenance.legacy.config_version, 7, 'the legacy counter is kept as provenance');
    assert.equal(module.provenance.legacy.migration, '0014');

    const resolved = await resolveEffectiveConfig(store, TENANT_A, 'lead_recovery');
    const before = validateLeadRecoveryConfig(legacy);
    assert.deepEqual(resolved.config, before.config, 'the same effective behaviour');
    assert.equal(resolved.configHash, await configHash(before.config));
  });

  test('a legacy row that is not valid is not published, and its evidence stays', async () => {
    const store = engineStore();
    const legacy = { ...leadRecoveryConfig() };
    delete legacy.company_name;
    await legacyDrafts(store, TENANT_A, legacy);
    const result = await importLegacyConfig(store, { tenantId: TENANT_A, actor: operator });
    assert.equal(result.results[0].status, 'quarantined');
    assert.ok(result.results[0].fieldErrors.some((e) => e.path === 'company_name'));
    assert.equal(await store.getConfigHead(TENANT_A, TENANT_SCOPE), null);
    assert.equal(await store.getConfigHead(TENANT_A, LR), null);
    const open = await store.listOpenDrafts(TENANT_A);
    assert.equal(open.length, 2, 'both drafts stay open for an operator to correct');
    assert.ok(open.every((d) => d.origin.legacy));
  });

  test('a bad module half keeps the good tenant half from being published alone', async () => {
    const store = engineStore();
    await legacyDrafts(store, TENANT_A, { ...leadRecoveryConfig(), forwarding: { destination: '', timeout_seconds: 20 } });
    const result = await importLegacyConfig(store, { tenantId: TENANT_A, actor: operator });
    assert.equal(result.results[0].status, 'quarantined');
    assert.equal(await store.getConfigHead(TENANT_A, TENANT_SCOPE), null);
  });

  test('a quarantined tenant runs nothing — the lead is recorded, no run is started', async () => {
    const store = engineStore();
    const legacy = { ...leadRecoveryConfig() };
    delete legacy.company_name;
    const row = await legacyDrafts(store, TENANT_A, legacy);
    row.enabled = true;
    await importLegacyConfig(store, { tenantId: TENANT_A, actor: operator });
    const result = await intakeLead(deps(store), missedCall());
    assert.equal(result.ok, false);
    assert.equal(result.run, null);
    assert.equal(store.leads.length, 1);
    assert.match(result.outcome, /no published tenant settings/);
  });

  test('importing again changes nothing', async () => {
    const store = engineStore();
    await legacyDrafts(store, TENANT_A, leadRecoveryConfig());
    await importLegacyConfig(store, { tenantId: null, actor: operator });
    const again = await importLegacyConfig(store, { tenantId: null, actor: operator });
    assert.deepEqual(again.results, []);
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1);
  });

  test('only an operator imports', async () => {
    const store = engineStore();
    await legacyDrafts(store, TENANT_A, leadRecoveryConfig());
    assert.equal((await importLegacyConfig(store, { tenantId: null, actor: client })).code, 'forbidden');
  });

  test('a snapshot from before versioning keeps no provenance, and is not reused afterwards', async () => {
    const store = engineStore();
    const legacy = leadRecoveryConfig();
    const oldSnapshot = await store.createConfigSnapshot({
      tenantId: TENANT_A, moduleKey: 'lead_recovery', configVersion: 7, schemaVersion: 1,
      config: legacy, configHash: await configHash(legacy), tenantConfigVersionId: null, moduleConfigVersionId: null,
    });
    await legacyDrafts(store, TENANT_A, legacy);
    await importLegacyConfig(store, { tenantId: null, actor: operator });

    assert.equal(oldSnapshot.tenantConfigVersionId, null);
    assert.equal(oldSnapshot.moduleConfigVersionId, null);
    await assert.rejects(
      store.createRun({ id: crypto.randomUUID(), tenantId: TENANT_A, leadId: crypto.randomUUID(), moduleKey: 'lead_recovery', state: 'new', configVersion: 7, configSnapshotId: oldSnapshot.id, stoppedAt: null, completedAt: null, stopReason: null, lastError: null }),
      /versioned, so a new run must be pinned to a snapshot that names its versions/,
    );
    await assert.rejects(
      store.createConfigSnapshot({ tenantId: TENANT_A, moduleKey: 'lead_recovery', configVersion: 7, schemaVersion: 1, config: legacy, configHash: 'b'.repeat(64), tenantConfigVersionId: null, moduleConfigVersionId: null }),
      /must name the versions it was resolved from/,
    );
  });
});

/* ══ 8. runs and actions ══════════════════════════════════ */

describe('a run is pinned to a snapshot that names the versions it began under', () => {
  async function live() {
    const store = engineStore();
    await configure(store);
    /* live on these versions, as the operator path leaves it (ARC-120). every later
       publication below is priced by the lifecycle as it is published. */
    seedLifecycle(store, { tenantId: TENANT_A, state: 'active' });
    return store;
  }

  test('a new lead resolves published versions and the snapshot records them', async () => {
    const store = await live();
    const { tenant, module } = await heads(store, TENANT_A);
    await intakeLead(deps(store), missedCall());
    const run = store.runs[0];
    const snapshot = await store.getConfigSnapshot(TENANT_A, run.configSnapshotId);
    assert.equal(snapshot.tenantConfigVersionId, tenant.id);
    assert.equal(snapshot.moduleConfigVersionId, module.id);
    assert.equal(snapshot.configVersion, module.version);
    assert.equal(snapshot.schemaVersion, module.schemaVersion);
    assert.equal(run.configVersion, module.version);
    for (const action of store.actions) assert.equal(action.configSnapshotId, run.configSnapshotId);
  });

  test('every action of a run keeps the pin, and a later publication changes none of its words', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: TENANT_A });
    const followup = store.actions.find((a) => a.actionType === 'send_followup');
    const pin = followup.configSnapshotId;

    await configure(store, TENANT_A, leadRecoveryConfig({ company_name: 'Somebody Else Entirely' }));

    followup.runAt = NOW.toISOString();
    await runDueActions(d, { tenantId: TENANT_A });
    assert.equal(followup.configSnapshotId, pin);
    assert.match(sender.sent.at(-1).body, /Halstead Heating/);
    assert.doesNotMatch(sender.sent.at(-1).body, /Somebody Else/);
    for (const action of store.actions) assert.equal(action.configSnapshotId, pin);

    await intakeLead(d, missedCall({ phone: '+16145559933' }));
    const next = store.runs.at(-1);
    assert.notEqual(next.configSnapshotId, pin);
    const pinned = await loadPinnedConfig(store, next);
    assert.equal(pinned.config.company_name, 'Somebody Else Entirely');
    assert.equal(pinned.snapshot.tenantConfigVersionId, (await store.getConfigHead(TENANT_A, TENANT_SCOPE)).id);
  });

  test('a run under rolled-back content records the rollback version, not the one it copied', async () => {
    const store = await live();
    await intakeLead(deps(store), missedCall());
    const first = store.snapshots[0];
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://two.example' }));
    const v1 = (await listHistory(store, TENANT_A, LR)).find((v) => v.version === 1);
    await rollbackConfig(store, { tenantId: TENANT_A, scope: LR, versionId: v1.id, expectedVersion: 2, actor: operator });

    await intakeLead(deps(store), missedCall({ phone: '+16145559933' }));
    const latest = await store.getConfigSnapshot(TENANT_A, store.runs.at(-1).configSnapshotId);
    assert.notEqual(latest.id, first.id);
    assert.equal(latest.configHash, first.configHash, 'the same content…');
    assert.equal(latest.configVersion, 3, '…under the version that actually published it');
  });

  test('current reply state still overrides a pinned configuration', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: TENANT_A });
    const sentBefore = sender.sent.length;

    const followup = store.actions.find((a) => a.actionType === 'send_followup');
    assert.equal(followup.status, 'pending', 'a follow-up is waiting under the original pin');

    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://new.example/book' }));
    await handleInboundMessage(d, { tenantId: TENANT_A, from: CUSTOMER, to: '+16145550100', body: 'yes please, furnace is out', providerMessageId: 'SMreply0001', occurredAt: NOW });

    followup.runAt = NOW.toISOString();
    await runDueActions(d, { tenantId: TENANT_A });
    assert.notEqual(followup.status, 'done', 'the reply stopped it, whatever the pinned or current configuration says');
    assert.equal(sender.sent.filter((m) => /checking we've got this right/.test(m.body)).length, 0, 'no follow-up after a reply');
    assert.ok(sender.sent.length >= sentBefore);
  });
});

/* ══ 9. the console's save button ═════════════════════════ */

describe('the console’s save button publishes through the same engine', () => {
  test('a first save publishes tenant settings and the module as version 1 each', async () => {
    const store = engineStore();
    const result = await configure(store);
    assert.deepEqual(result.published.map((p) => [p.version.scope, p.version.version]), [['tenant', 1], ['module', 1]]);
  });

  test('a form loaded before somebody else saved publishes nothing', async () => {
    const store = engineStore();
    await configure(store);
    await configure(store, TENANT_A, leadRecoveryConfig({ company_name: 'Halstead HVAC' }));
    const stale = await publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery', config: leadRecoveryConfig({ booking_url: 'https://x.example' }),
      expected: { tenant: 1, module: 1 }, actor: operator,
    });
    assert.equal(stale.code, 'publication_conflict');
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1, 'not even the half that was not stale');
  });

  test('a form with no expected versions publishes nothing', async () => {
    const store = engineStore();
    const result = await publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery', config: leadRecoveryConfig(),
      expected: { tenant: null, module: null }, actor: operator,
    });
    assert.equal(result.code, 'publication_conflict');
  });

  test('saving what is already published publishes nothing', async () => {
    const store = engineStore();
    await configure(store);
    const again = await configure(store);
    assert.deepEqual(again.published, []);
    assert.equal(store.tenantConfigVersions.length + store.moduleConfigVersions.length, 2);
  });

  test('a rename publishes only the tenant settings', async () => {
    const store = engineStore();
    await configure(store);
    const renamed = await configure(store, TENANT_A, leadRecoveryConfig({ company_name: 'Halstead HVAC' }));
    assert.deepEqual(renamed.published.map((p) => [p.version.scope, p.version.version]), [['tenant', 2]]);
    assert.equal((await store.getConfigHead(TENANT_A, LR)).version, 1);
  });

  test('an open draft the save makes stale is superseded, not deleted', async () => {
    const store = engineStore();
    await configure(store);
    const draft = (await createDraft(store, { tenantId: TENANT_A, scope: LR, actor: operator })).draft;
    await configure(store, TENANT_A, leadRecoveryConfig({ booking_url: 'https://x.example' }));
    const closed = await store.getDraft(TENANT_A, LR, draft.id);
    assert.equal(closed.status, 'superseded');
  });

  test('an invalid configuration publishes nothing and says why, field by field', async () => {
    const store = engineStore();
    const result = await publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery',
      config: { ...leadRecoveryConfig(), forwarding: { destination: 'nope', timeout_seconds: 20 } },
      expected: { tenant: 0, module: 0 }, actor: operator,
    });
    assert.equal(result.code, 'validation_failed');
    assert.ok(result.fieldErrors.some((e) => e.path === 'forwarding.destination'));
    assert.equal(store.tenantConfigVersions.length, 0);
  });

  test('a client cannot save', async () => {
    const store = engineStore();
    const result = await publishEffectiveConfig(store, {
      tenantId: TENANT_A, moduleKey: 'lead_recovery', config: leadRecoveryConfig(),
      expected: { tenant: 0, module: 0 }, actor: client,
    });
    assert.equal(result.code, 'forbidden');
  });
});

/* ══ 10. the ops surface ══════════════════════════════════ */

describe('the ops configuration actions answer in structured errors', () => {
  const context = (store, body, actorId = OPERATOR) => ({ store, body, actorId, audit: async () => true });

  test('no actor, no action', async () => {
    const response = await handleConfigAction('config-get', context(engineStore(), { tenant_id: TENANT_A }, null));
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'unauthorized');
  });

  test('a draft edited, published and rolled back over the wire', async () => {
    const store = engineStore();
    await configure(store);
    const created = await handleConfigAction('config-draft-create', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery' }));
    assert.equal(created.status, 200);
    const draftId = created.body.draft.id;

    const stale = await handleConfigAction('config-draft-update', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', draft_id: draftId, expected_revision: 9, patch: { booking_url: 'https://x.example' } }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'draft_conflict');

    const unknown = await handleConfigAction('config-draft-update', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', draft_id: draftId, expected_revision: 1, patch: { webhook: 'x' } }));
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.field_errors[0].path, 'webhook');

    const edited = await handleConfigAction('config-draft-update', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', draft_id: draftId, expected_revision: 1, patch: { booking_url: 'https://x.example' } }));
    assert.equal(edited.status, 200);

    const noVersion = await handleConfigAction('config-publish', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', draft_id: draftId, expected_revision: 2 }));
    assert.equal(noVersion.status, 409);

    const published = await handleConfigAction('config-publish', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', draft_id: draftId, expected_revision: 2, expected_version: 1 }));
    assert.equal(published.status, 200);
    assert.equal(published.body.version, 2);
    assert.deepEqual(published.body.impact.changed_fields, ['booking_url']);

    const history = await handleConfigAction('config-history', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery' }));
    assert.deepEqual(history.body.versions.map((v) => v.version), [2, 1]);
    assert.ok(history.body.versions.every((v) => !('config' in v)), 'history is metadata; a version is read on its own');

    const v1 = history.body.versions[1];
    const rolled = await handleConfigAction('config-rollback', context(store, { tenant_id: TENANT_A, scope: 'module', module_key: 'lead_recovery', version_id: v1.id, expected_version: 2 }));
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.rollback_of_version_id, v1.id);

    const resolved = await handleConfigAction('config-resolve', context(store, { tenant_id: TENANT_A, module_key: 'lead_recovery' }));
    assert.equal(resolved.body.resolution.module_version.version, 3);
  });

  test("another tenant's version reads as not found", async () => {
    const store = engineStore();
    await configure(store);
    const head = await store.getConfigHead(TENANT_A, LR);
    const response = await handleConfigAction('config-version', context(store, { tenant_id: TENANT_B, scope: 'module', module_key: 'lead_recovery', version_id: head.id }));
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'version_not_found');
  });

  test('a scope that is not one is refused', async () => {
    const response = await handleConfigAction('config-history', context(engineStore(), { tenant_id: TENANT_A, scope: 'everything' }));
    assert.equal(response.status, 422);
  });

  test('the legacy import reports what it did', async () => {
    const store = engineStore();
    await legacyDrafts(store, TENANT_A, leadRecoveryConfig());
    const response = await handleConfigAction('config-import-legacy', context(store, {}));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.counts, { imported: 1 });
  });
});
