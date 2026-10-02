/* ARC-320 — the activation console's durable half, against real Postgres.
 *
 * A connection test is ARC-200 work: a `connector_test` run and a `test_connection` action,
 * written before anything is asked of anybody, then claimed, started and settled through the
 * ARC-210 orchestrator. Here it runs through the real `ops` handlers and the production
 * scheduler adapter on PGlite, with `FakeTestRunner` as the runner — it contacts nothing —
 * and the synthetic connector catalog, since every real tenant-connected provider is still
 * `planned`. Pause and resume go through the console's own lifecycle actions and are checked
 * where they bite: at the claim.
 *
 * Without PGlite the suite is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newOperator, tenant } from './scheduler-fixtures.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { claimDueActions, createAutomationRun, scheduleAutomationAction } from '../supabase/functions/_shared/scheduler/service.ts';
import { syntheticCatalog } from '../supabase/functions/_shared/connections/synthetic.ts';
import { FakeTestRunner } from '../supabase/functions/_shared/runner/fake.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { requestConnectionTest, runConsolePass, supabaseConnectionTestLog } from '../supabase/functions/_shared/activation/connection-test.ts';
import { handleActivationAction } from '../supabase/functions/ops/activation.ts';
import { handleLifecycleAction } from '../supabase/functions/ops/lifecycle.ts';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

const past = () => new Date(Date.now() - 60_000).toISOString();

describe('ARC-320 against real Postgres', { skip }, () => {
  let db;
  let operator;
  let scheduler;
  let log;

  /* the production adapter, serving the synthetic catalog so a tenant-connected provider exists. */
  const storeFor = () => {
    const base = supabaseStore(restClient(db));
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { connectorCatalog: syntheticCatalog('test') });
  };

  async function connection(t, status = 'verified', connector = 'synthetic_oauth') {
    const { rows: [c] } = await db.query(
      `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status, ended_at, verified_capabilities, credential_version, last_verified_at)
       values ($1, $2, 1, 'oauth2', $3, case when $3 in ('revoked', 'disconnected') then now() end, array['send_sms','receive_sms'], 1, now()) returning id`,
      [t.tenantId, connector, status],
    );
    return c.id;
  }

  /* succeeds unless told otherwise; it contacts nothing either way. */
  const fake = (defaultStep = { do: 'succeed' }) =>
    new FakeTestRunner({ environment: 'test', actionTypes: ['test_connection'], runModes: ['test'], defaultStep });
  const registryOf = (runner) => createRunnerRegistry([runner], { defaultKind: runner.kind });

  const audits = [];
  const ctx = (t, body, runner, extra = {}) => ({
    store: storeFor(),
    scheduler,
    tests: log,
    body: { tenant_id: t.tenantId, module_key: LR, ...body },
    actorId: operator,
    audit: async (...args) => { audits.push(args); return true; },
    runners: async () => (runner ? { registry: registryOf(runner) } : { registry: null, reason: 'no runner here' }),
    worker: 'db-activation',
    ...extra,
  });

  const count = async (table, tenantId) => Number((await db.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId])).rows[0].n);

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    scheduler = supabaseSchedulerStore(restClient(db));
    log = supabaseConnectionTestLog(restClient(db));
  });

  test('a readiness test creates a durable run and action before anything runs, pinned to the current configuration', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    const conn = await connection(t, 'connected_unverified');
    const requested = await requestConnectionTest({ store: storeFor(), scheduler }, {
      tenantId: t.tenantId, moduleKey: LR, connectionId: conn, actorId: operator, runnerKind: 'fake_test',
    });
    assert.equal(requested.ok, true, requested.message);

    const { rows: [run] } = await db.query('select * from automation_runs where id = $1', [requested.run.id]);
    assert.deepEqual([run.run_kind, run.run_mode, run.status, run.created_by_type, run.created_by], ['connector_test', 'test', 'pending', 'operator', operator]);
    assert.ok(run.config_snapshot_id, 'pinned');
    const { rows: [snapshot] } = await db.query('select tenant_config_version_id, module_config_version_id from lead_recovery_config_snapshots where id = $1', [run.config_snapshot_id]);
    const { rows: [life] } = await db.query('select observed_tenant_config_version_id, observed_module_config_version_id from tenant_modules where tenant_id = $1 and module_key = $2', [t.tenantId, LR]);
    assert.deepEqual([snapshot.tenant_config_version_id, snapshot.module_config_version_id], [life.observed_tenant_config_version_id, life.observed_module_config_version_id], 'the current published versions');

    const { rows: [action] } = await db.query('select * from scheduled_actions where id = $1', [requested.action.id]);
    assert.deepEqual([action.action_type, action.status, action.connection_id, action.connector_key, action.attempts], ['test_connection', 'pending', conn, 'synthetic_oauth', 0]);
    assert.doesNotMatch(JSON.stringify(action.payload), /token|secret|key/i, 'a reference, never a credential');
  });

  test('a successful readiness test settles the attempt and the run, and the overview shows its evidence', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    const conn = await connection(t);
    const res = await handleActivationAction('connection-test', ctx(t, { connection_id: conn }, fake()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.pass.deferred, null);
    assert.equal(res.body.pass.executed.length, 1);
    assert.deepEqual([res.body.pass.executed[0].outcome, res.body.pass.executed[0].action_status, res.body.pass.executed[0].run_status], ['succeeded', 'done', 'completed']);
    assert.equal(res.body.test.outcome, 'succeeded');
    assert.equal(res.body.logged, true);
    assert.ok(audits.some(([verb, , id]) => verb === 'connection.test_requested' && id === conn));

    const attempts = (await db.query('select * from automation_action_attempts where action_id = $1', [res.body.action_id])).rows;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'succeeded');
    assert.equal(attempts[0].runner_kind, 'fake_test');

    const overview = await handleActivationAction('activation-overview', ctx(t, {}, null));
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const provider = overview.body.requirements.flatMap((r) => r.capabilities).find((c) => c.key === 'send_sms').providers.find((p) => p.connector_key === 'synthetic_oauth');
    assert.equal(provider.connection.id, conn);
    assert.equal(provider.connection.latest_test.outcome, 'succeeded');
    assert.equal(provider.connection.latest_test.action_status, 'done');
    assert.ok(Object.keys(provider.connection.latest_test.evidence).length > 0, 'the runner\'s evidence, as 0017 accepted it');
    assert.equal(overview.body.tests[0].action_id, res.body.action_id);
  });

  test('a failed readiness test shows its code and a safe sentence — never a credential-shaped message', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    const conn = await connection(t);
    const runner = fake({ do: 'fail', retryable: false, errorCode: 'invalid_credential', message: 'provider said: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' });
    const requested = await requestConnectionTest({ store: storeFor(), scheduler }, { tenantId: t.tenantId, moduleKey: LR, connectionId: conn, actorId: operator, runnerKind: runner.kind });
    assert.equal(requested.ok, true, requested.message);
    const pass = await runConsolePass({ store: scheduler, runners: registryOf(runner), worker: 'db-activation' }, t.tenantId);
    assert.equal(pass.executed[0].outcome, 'failed');

    const record = (await log.recent(t.tenantId)).find((r) => r.action_id === requested.action.id);
    assert.equal(record.error_code, 'invalid_credential');
    assert.equal(record.action_status, 'failed');
    assert.ok(record.message, 'a sentence is still shown');
    assert.doesNotMatch(record.message, /Bearer|eyJ/, '0017 replaced the credential-shaped message before it was stored');
  });

  test('a revoked connection is refused before a run or an action is written', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    const conn = await connection(t, 'revoked');
    const [runs, actions] = [await count('automation_runs', t.tenantId), await count('scheduled_actions', t.tenantId)];
    const res = await handleActivationAction('connection-test', ctx(t, { connection_id: conn }, fake()));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'connection_ended');
    assert.equal(await count('automation_runs', t.tenantId), runs);
    assert.equal(await count('scheduled_actions', t.tenantId), actions);
  });

  test('the console\'s pass defers — and touches nothing — when other work is due for the client', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const other = (await createAutomationRun(scheduler, {
      tenantId: t.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await t.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: `other:${crypto.randomUUID()}`,
    })).value.run;
    const followUp = (await scheduleAutomationAction(scheduler, {
      tenantId: t.tenantId, runId: other.id, actionType: 'schedule_follow_up', runAt: past(), idempotencyKey: `follow:${crypto.randomUUID()}`,
    })).value.action;

    const conn = await connection(t);
    const res = await handleActivationAction('connection-test', ctx(t, { connection_id: conn }, fake()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.pass.executed.length, 0);
    assert.match(res.body.pass.deferred.reason, /schedule_follow_up/);
    const { rows: [untouched] } = await db.query('select status, attempts from scheduled_actions where id = $1', [followUp.id]);
    assert.deepEqual([untouched.status, untouched.attempts], ['pending', 0]);
    const { rows: [queued] } = await db.query('select status from scheduled_actions where id = $1', [res.body.action_id]);
    assert.equal(queued.status, 'pending', 'the test is still queued for the scheduler worker');
  });

  test('pause from the console blocks future claims; resume from the console permits them', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const run = (await createAutomationRun(scheduler, {
      tenantId: t.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await t.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: `pause:${crypto.randomUUID()}`,
    })).value.run;
    const action = (await scheduleAutomationAction(scheduler, {
      tenantId: t.tenantId, runId: run.id, actionType: 'schedule_follow_up', runAt: past(), idempotencyKey: `pause-follow:${crypto.randomUUID()}`,
    })).value.action;

    const lifecycle = async (name) => {
      const version = (await storeFor().getLifecycle(t.tenantId, LR)).stateVersion;
      return await handleLifecycleAction(name, { store: storeFor(), actorId: operator, body: { tenant_id: t.tenantId, module_key: LR, expected_state_version: version } });
    };

    const paused = await lifecycle('module-pause');
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const held = await claimDueActions(scheduler, { tenantId: t.tenantId, worker: 'w-1', limit: 10 });
    assert.equal(held.ok, true);
    assert.ok(!held.value.some((c) => c.action.id === action.id), 'a paused module\'s live work is not claimed');
    const { rows: [gate] } = await db.query('select status, gate_code from scheduled_actions where id = $1', [action.id]);
    assert.deepEqual([gate.status, gate.gate_code], ['pending', 'module_paused'], 'held, not cancelled');

    /* a paused module can still be tested — that is how a person finds out what is wrong. */
    const conn = await connection(t);
    const test = await handleActivationAction('connection-test', ctx(t, { connection_id: conn }, null));
    assert.equal(test.status, 200, JSON.stringify(test.body));

    const resumed = await lifecycle('module-resume');
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const claimed = await claimDueActions(scheduler, { tenantId: t.tenantId, worker: 'w-1', limit: 10 });
    assert.ok(claimed.value.some((c) => c.action.id === action.id), 'resumed: the held action is claimed');
  });

  test('the overview over real SQL carries no credential and names the module\'s test', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    await connection(t);
    const res = await handleActivationAction('activation-overview', ctx(t, {}, null));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.module.test_action, 'lead-recovery-canary');
    assert.equal(res.body.status.lifecycle.state, 'testing');
    assert.doesNotMatch(JSON.stringify(res.body), /vault|refresh_lease|access_token|refresh_token/i);
  });
});
