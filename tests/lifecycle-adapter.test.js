/* ARC-120 — what the production lifecycle adapter actually sends and reads back.
 *
 * The ARC-015B lesson again: a store that keeps whole objects passes tests the real
 * adapter fails. So every lifecycle write is asserted as the exact RPC argument list or
 * snake_case payload `supabaseLifecycleStore` produces, through `supabaseDouble`, which
 * stores only what it is sent; every read is mapped back field for field. Real SQL for
 * the same calls is `tests/lifecycle-db.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { LifecycleStoreError } from '../supabase/functions/_shared/lifecycle/model.ts';
import { transitionChangePayload } from '../supabase/functions/_shared/lifecycle/supabase-lifecycle-store.ts';
import { intakeLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { supabaseDouble } from './supabase-double.js';
import { leadRecoveryConfig, lifecycleRows, publishedConfigRows } from './config-fixtures.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'ffffffff-0000-4000-8000-000000000001';
const LIFECYCLE = 'eeeeeeee-1111-4000-8000-000000000001';
const TV = 'eeeeeeee-2222-4000-8000-000000000001';
const MV = 'eeeeeeee-3333-4000-8000-000000000001';
const EVIDENCE = 'eeeeeeee-4444-4000-8000-000000000001';
const RUN = 'eeeeeeee-5555-4000-8000-000000000001';
const NOW = '2026-09-16T14:00:00.000Z';
const pair = { tenantVersionId: TV, moduleVersionId: MV };

const lifecycleRow = (overrides = {}) => ({
  id: LIFECYCLE, tenant_id: TENANT_A, module_key: 'lead_recovery', state: 'active', state_version: '7',
  pending_requirements: ['retest'],
  observed_tenant_config_version_id: TV, observed_module_config_version_id: MV,
  authorized_tenant_config_version_id: TV, authorized_module_config_version_id: MV,
  tested_tenant_config_version_id: TV, tested_module_config_version_id: MV, test_evidence_id: EVIDENCE,
  shadow_tenant_config_version_id: null, shadow_module_config_version_id: null, shadow_evidence_id: null,
  health_status: 'degraded', health_reason: 'twilio slow', health_evidence: { source: 'monitor' }, health_checked_at: NOW,
  created_at: NOW, updated_at: NOW, ...overrides,
});

const transitionRow = (overrides = {}) => ({
  id: 'eeeeeeee-6666-4000-8000-000000000001', tenant_id: TENANT_A, module_key: 'lead_recovery', lifecycle_id: LIFECYCLE,
  state_version: 7, transition: 'record_test', from_state: 'active', to_state: 'active', actor_type: 'operator', actor_id: OPERATOR,
  reason_code: 'synthetic_test_passed', reason: 'a synthetic run passed', idempotency_key: `test:${RUN}`, correlation_id: null,
  tenant_config_version_id: TV, module_config_version_id: MV, previous_tenant_config_version_id: null, previous_module_config_version_id: null,
  evidence_id: EVIDENCE, impact: {}, policy: {}, pending_before: ['retest'], pending_after: [], health_before: 'unverified',
  health_after: 'unverified', metadata: { current: true }, occurred_at: NOW, ...overrides,
});

const evidenceRow = (overrides = {}) => ({
  id: EVIDENCE, tenant_id: TENANT_A, module_key: 'lead_recovery', lifecycle_id: LIFECYCLE, kind: 'test', outcome: 'passed',
  run_mode: 'test', tenant_config_version_id: TV, module_config_version_id: MV, config_hash: 'a'.repeat(64),
  capabilities: ['send_sms'], run_id: RUN, simulated: true, summary: { run_state: 'awaiting_reply' }, actor_type: 'operator',
  recorded_by: OPERATOR, recorded_at: NOW, ...overrides,
});

describe('every transition is one RPC carrying every expectation', () => {
  test('the call names tenant, module, transition, expected version, actor, reason, key and the whole change', async () => {
    const db = supabaseDouble({}, {
      rpc: { apply_tenant_module_transition: () => ({ data: { replayed: false, transition: transitionRow(), lifecycle: lifecycleRow(), evidence: evidenceRow(), cancelled_actions: 0 }, error: null }) },
    });
    const result = await supabaseStore(db).applyLifecycleTransition({
      tenantId: TENANT_A, moduleKey: 'lead_recovery', transition: 'record_test', expectedStateVersion: 6,
      actor: { type: 'operator', id: OPERATOR }, reasonCode: 'synthetic_test_passed', reason: 'a synthetic run passed',
      idempotencyKey: `test:${RUN}`, correlationId: 'corr-1',
      change: {
        pendingRequirements: [],
        observed: pair,
        authorized: pair,
        evidence: { kind: 'test', outcome: 'passed', runMode: 'test', versions: pair, configHash: 'a'.repeat(64), capabilities: ['send_sms'], runId: RUN, summary: { run_state: 'awaiting_reply' } },
        applyEvidenceAs: 'test',
        versions: pair,
        metadata: { current: true },
      },
    });
    assert.deepEqual(db.rpcs.at(-1), {
      name: 'apply_tenant_module_transition',
      args: {
        p_tenant: TENANT_A,
        p_module_key: 'lead_recovery',
        p_transition: 'record_test',
        p_expected_state_version: 6,
        p_actor_type: 'operator',
        p_actor: OPERATOR,
        p_reason_code: 'synthetic_test_passed',
        p_reason: 'a synthetic run passed',
        p_idempotency_key: `test:${RUN}`,
        p_change: {
          pending_requirements: [],
          observed: { tenant_version_id: TV, module_version_id: MV },
          authorized: { tenant_version_id: TV, module_version_id: MV },
          evidence: {
            kind: 'test', outcome: 'passed', run_mode: 'test', tenant_version_id: TV, module_version_id: MV,
            config_hash: 'a'.repeat(64), capabilities: ['send_sms'], run_id: RUN, summary: { run_state: 'awaiting_reply' },
          },
          apply_evidence_as: 'test',
          versions: { tenant_version_id: TV, module_version_id: MV },
          metadata: { current: true },
        },
        p_correlation_id: 'corr-1',
      },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.lifecycle.stateVersion, 7, 'a bigint read back as a number');
    assert.equal(result.evidence.id, EVIDENCE);
  });

  test('clearing authorisation is said, not implied; leaving it alone sends nothing', () => {
    assert.deepEqual(transitionChangePayload({ pendingRequirements: ['retest'], authorized: null }), { pending_requirements: ['retest'], authorized: null });
    assert.deepEqual(transitionChangePayload({ pendingRequirements: [] }), { pending_requirements: [] });
  });

  test('a health report sends status, reason and evidence together', () => {
    const payload = transitionChangePayload({ pendingRequirements: [], health: { status: 'failing', reason: 'no replies arriving', evidence: { source: 'monitor' } } });
    assert.deepEqual(payload.health, { status: 'failing', reason: 'no replies arriving', evidence: { source: 'monitor' } });
  });

  test('a system actor is sent as nobody', async () => {
    const db = supabaseDouble({}, { rpc: { apply_tenant_module_transition: () => ({ data: { replayed: false, transition: transitionRow({ actor_type: 'system', actor_id: null }), lifecycle: lifecycleRow(), evidence: null, cancelled_actions: 3 }, error: null }) } });
    const result = await supabaseStore(db).applyLifecycleTransition({
      tenantId: TENANT_A, moduleKey: 'lead_recovery', transition: 'system_pause', expectedStateVersion: 6,
      actor: { type: 'system', id: null }, reasonCode: 'config_change_requires_reactivation', reason: null, idempotencyKey: 'config:x', change: { pendingRequirements: ['review'] },
    });
    assert.equal(db.rpcs.at(-1).args.p_actor, null);
    assert.equal(db.rpcs.at(-1).args.p_actor_type, 'system');
    assert.equal(result.cancelledActions, 3);
    assert.equal(result.evidence, null);
  });

  test('the database\'s refusals come back typed, whatever the transition', async () => {
    for (const code of ['stale_state', 'illegal_transition', 'test_evidence_missing', 'requirements_pending', 'forbidden', 'idempotency_conflict']) {
      const db = supabaseDouble({}, { rpc: { apply_tenant_module_transition: () => ({ data: null, error: { code: 'P0001', message: `arc_lifecycle:${code}: refused for a reason` } }) } });
      await assert.rejects(
        supabaseStore(db).applyLifecycleTransition({ tenantId: TENANT_A, moduleKey: 'lead_recovery', transition: 'pause', expectedStateVersion: 1, actor: { type: 'operator', id: OPERATOR }, reasonCode: 'x', reason: null, idempotencyKey: 'k', change: { pendingRequirements: [] } }),
        (error) => error instanceof LifecycleStoreError && error.code === code && error.message === 'refused for a reason',
      );
    }
  });

  test('anything else stays a plain database error', async () => {
    const db = supabaseDouble({}, { rpc: { apply_tenant_module_transition: () => ({ data: null, error: { message: 'connection reset' } }) } });
    await assert.rejects(
      supabaseStore(db).applyLifecycleTransition({ tenantId: TENANT_A, moduleKey: 'lead_recovery', transition: 'pause', expectedStateVersion: 1, actor: { type: 'operator', id: OPERATOR }, reasonCode: 'x', reason: null, idempotencyKey: 'k', change: { pendingRequirements: [] } }),
      (error) => !(error instanceof LifecycleStoreError) && /lifecycle transition: connection reset/.test(error.message),
    );
  });
});

describe('reads map every column back', () => {
  test('a lifecycle row, field for field', async () => {
    const db = supabaseDouble({ tenant_modules: [lifecycleRow()] });
    const row = await supabaseStore(db).getLifecycle(TENANT_A, 'lead_recovery');
    assert.deepEqual(row, {
      id: LIFECYCLE, tenantId: TENANT_A, moduleKey: 'lead_recovery', state: 'active', stateVersion: 7,
      pendingRequirements: ['retest'], observed: pair, authorized: pair, tested: pair, testEvidenceId: EVIDENCE,
      shadowed: null, shadowEvidenceId: null, healthStatus: 'degraded', healthReason: 'twilio slow',
      healthEvidence: { source: 'monitor' }, healthCheckedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
  });

  test('a lifecycle read is scoped to its tenant and module', async () => {
    const db = supabaseDouble({ tenant_modules: [lifecycleRow({ tenant_id: 'other' })] });
    assert.equal(await supabaseStore(db).getLifecycle(TENANT_A, 'lead_recovery'), null);
  });

  test('history newest first, by state version, and an idempotency lookup by key', async () => {
    const db = supabaseDouble({ tenant_module_transitions: [transitionRow({ state_version: 6, idempotency_key: 'a' }), transitionRow({ state_version: 7, idempotency_key: 'b' })] });
    const store = supabaseStore(db);
    const history = await store.listTransitions(TENANT_A, 'lead_recovery', 10);
    assert.deepEqual(history.map((t) => t.stateVersion), [7, 6]);
    assert.deepEqual(history[0].versions, pair);
    assert.equal((await store.findTransitionByKey(TENANT_A, 'lead_recovery', 'a')).stateVersion, 6);
    assert.equal(await store.findTransitionByKey(TENANT_A, 'lead_recovery', 'nope'), null);
  });

  test('evidence is always read as simulated, and filtered by kind and exact versions', async () => {
    const db = supabaseDouble({ tenant_module_evidence: [evidenceRow(), evidenceRow({ id: 'x', kind: 'shadow_observation', module_config_version_id: 'other' })] });
    const store = supabaseStore(db);
    const tests = await store.listEvidence(TENANT_A, 'lead_recovery', { kind: 'test', versions: pair, limit: 10 });
    assert.equal(tests.length, 1);
    assert.equal(tests[0].simulated, true);
    assert.deepEqual(tests[0].versions, pair);
    assert.equal((await store.listEvidence(TENANT_A, 'lead_recovery', { kind: 'shadow_observation', versions: pair, limit: 10 })).length, 0);
  });

  test('readiness inputs: completed steps only, and an unrevoked intake key', async () => {
    const db = supabaseDouble({
      module_onboarding: [
        { tenant_id: TENANT_A, module_key: 'lead_recovery', step_key: 'twilio_connected', done_at: NOW },
        { tenant_id: TENANT_A, module_key: 'lead_recovery', step_key: 'routing_tested', done_at: null },
      ],
      intake_keys: [{ id: 'k1', tenant_id: TENANT_A, revoked_at: NOW }],
    });
    const store = supabaseStore(db);
    assert.deepEqual(await store.listCompletedOnboardingSteps(TENANT_A, 'lead_recovery'), ['twilio_connected']);
    assert.equal(await store.hasActiveIntakeKey(TENANT_A), false, 'a revoked key proves nothing');
  });
});

describe('a shadow observation is a direct, fully named insert', () => {
  test('every column is in the payload, and the actor is the system', async () => {
    const db = supabaseDouble({ tenant_modules: [lifecycleRow({ state: 'shadow' })] });
    await supabaseStore(db).recordShadowObservation({
      tenantId: TENANT_A, moduleKey: 'lead_recovery',
      evidence: { kind: 'shadow_observation', outcome: 'observed', runMode: 'shadow', versions: pair, configHash: 'c'.repeat(64), capabilities: [], runId: RUN, summary: { would_have: 'send_first_response' } },
    });
    const payload = db.writes.find((w) => w.table === 'tenant_module_evidence').payload[0];
    assert.deepEqual(payload, {
      tenant_id: TENANT_A, module_key: 'lead_recovery', lifecycle_id: LIFECYCLE, kind: 'shadow_observation', outcome: 'observed',
      run_mode: 'shadow', tenant_config_version_id: TV, module_config_version_id: MV, config_hash: 'c'.repeat(64),
      capabilities: [], run_id: RUN, summary: { would_have: 'send_first_response' }, actor_type: 'system', recorded_by: null,
    });
  });

  test('with no lifecycle there is nothing to record against', async () => {
    await assert.rejects(
      supabaseStore(supabaseDouble()).recordShadowObservation({ tenantId: TENANT_A, moduleKey: 'lead_recovery', evidence: { kind: 'shadow_observation', outcome: 'observed', runMode: 'shadow', versions: pair, configHash: 'c'.repeat(64), capabilities: [], runId: RUN, summary: {} } }),
      (error) => error instanceof LifecycleStoreError && error.code === 'module_not_selected',
    );
  });
});

describe('the engine\'s own writes carry the run mode, and reservations report the lifecycle', () => {
  test('a run insert names run_mode, and it reads back', async () => {
    const db = supabaseDouble();
    const run = await supabaseStore(db).createRun({
      id: RUN, tenantId: TENANT_A, leadId: 'l', moduleKey: 'lead_recovery', state: 'new', configVersion: 1, configSnapshotId: 's',
      runMode: 'live', stoppedAt: null, completedAt: null, stopReason: null, lastError: null,
    });
    assert.equal(db.writes.find((w) => w.table === 'automation_runs').payload[0].run_mode, 'live');
    assert.equal(run.runMode, 'live');
  });

  test('a run the database refuses for its lifecycle comes back typed', async () => {
    const db = supabaseDouble();
    const original = db.from.bind(db);
    db.from = (table) => {
      const builder = original(table);
      if (table !== 'automation_runs') return builder;
      return { ...builder, insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'arc_lifecycle:module_paused: a live run needs the module active — it is paused' } }) }) }) };
    };
    await assert.rejects(
      supabaseStore(db).createRun({ id: RUN, tenantId: TENANT_A, leadId: 'l', moduleKey: 'lead_recovery', state: 'new', configVersion: 1, configSnapshotId: 's', runMode: 'live', stoppedAt: null, completedAt: null, stopReason: null, lastError: null }),
      (error) => error instanceof LifecycleStoreError && error.code === 'module_paused',
    );
  });

  test('a reservation refused for the lifecycle comes back typed, not as a crash', async () => {
    const db = supabaseDouble({}, { rpc: { reserve_lead_recovery_effect: () => ({ data: null, error: { message: 'arc_lifecycle:module_not_active: the module is not active — nothing live may be reserved' } }) } });
    await assert.rejects(
      supabaseStore(db).reserveEffect({ tenantId: TENANT_A, effectKey: 'e', effectType: 'customer_sms', idempotencyKey: 'e', worker: 'w', leaseToken: 'l', runId: RUN, isCanary: false }),
      (error) => error instanceof LifecycleStoreError && error.code === 'module_not_active',
    );
  });

  test('a lead through the production adapter is started live, on the authorised versions, and says so', async () => {
    const rows = publishedConfigRows(TENANT_A, leadRecoveryConfig());
    const db = supabaseDouble({
      module_configs: [{ tenant_id: TENANT_A, module_key: 'lead_recovery', enabled: true, schema_version: 1, config_version: 1, config: {} }],
      tenants: [{ id: TENANT_A, status: 'active' }],
      ...rows,
      ...lifecycleRows(TENANT_A, rows, { state: 'active' }),
    });
    const result = await intakeLead({
      store: supabaseStore(db), liveSender: new RecordingSender(), canarySender: new RecordingSender(), now: () => new Date(NOW),
      classifierFor: () => ({ classify: async () => ({ ok: false }) }), urls: {}, uuid: () => crypto.randomUUID(), worker: 'test',
    }, { tenantId: TENANT_A, source: 'missed_call', externalRef: 'CA-lifecycle-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.equal(result.ok, true, result.outcome);
    const [run] = db.table('automation_runs');
    assert.equal(run.run_mode, 'live');
  });

  test('a lead whose lifecycle is paused starts no run through the production adapter either', async () => {
    const rows = publishedConfigRows(TENANT_A, leadRecoveryConfig());
    const db = supabaseDouble({
      tenants: [{ id: TENANT_A, status: 'active' }],
      ...rows,
      ...lifecycleRows(TENANT_A, rows, { state: 'paused' }),
    });
    const result = await intakeLead({
      store: supabaseStore(db), liveSender: new RecordingSender(), canarySender: new RecordingSender(), now: () => new Date(NOW),
      classifierFor: () => ({ classify: async () => ({ ok: false }) }), urls: {}, uuid: () => crypto.randomUUID(), worker: 'test',
    }, { tenantId: TENANT_A, source: 'missed_call', externalRef: 'CA-lifecycle-2', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.equal(result.ok, false);
    assert.equal(db.table('automation_runs').length, 0);
    assert.equal(db.table('leads').length, 1, 'the lead is still recorded');
  });
});
