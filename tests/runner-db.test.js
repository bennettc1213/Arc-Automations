/* ARC-210 — the orchestrator over the real ARC-200 scheduler, against real Postgres.
 *
 * Due work is claimed, started, handed to `FakeTestRunner` and settled through the
 * scheduler's own service, on the same SQL, triggers and functions a hosted database runs
 * (PGlite, through the PostgREST-shaped client). The fake is the only runner: nothing
 * reaches a provider, n8n or the network. Each test names the promise it checks, and each
 * leaves no due work behind, so the next test's claim sees only its own.
 *
 * Without PGlite the suite is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newOperator, tenant } from './scheduler-fixtures.js';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { claimDueActions, createAutomationRun, scheduleAutomationAction } from '../supabase/functions/_shared/scheduler/service.ts';
import { findSecretShaped } from '../supabase/functions/_shared/scheduler/model.ts';
import { FakeTestRunner } from '../supabase/functions/_shared/runner/fake.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { executeDueActions } from '../supabase/functions/_shared/runner/orchestrator.ts';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const key = (label) => `${label}:${crypto.randomUUID()}`;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe('ARC-210 against real Postgres', { skip }, () => {
  let db;
  let operator;
  let store;
  let a;
  let b;

  const mustOk = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };

  async function run(t, { kind = 'observation_window', mode = 'live', runnerKind = null } = {}) {
    return mustOk(await createAutomationRun(store, {
      tenantId: t.tenantId, runKind: kind, moduleKey: LR, configSnapshotId: await t.snapshot(), runMode: mode,
      correlationId: crypto.randomUUID(), idempotencyKey: key('run'), runnerKind,
    }), 'create run').run;
  }
  async function queue(t, r, actionType, extra = {}) {
    return mustOk(await scheduleAutomationAction(store, {
      tenantId: t.tenantId, runId: r.id, actionType, runAt: past(), idempotencyKey: key(actionType), ...extra,
    }), `schedule ${actionType}`).action;
  }
  async function connection(t, status = 'verified') {
    const { rows: [c] } = await db.query(
      `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status)
       values ($1, $2, 1, 'api_key', $3) returning id`,
      [t.tenantId, `c_${counter++}_r`, status],
    );
    return c.id;
  }
  const world = (runners = [new FakeTestRunner({ environment: 'test' })], defaultKind = runners[0].kind) =>
    ({ store, worker: 'runner-w', runners: createRunnerRegistry(runners, { defaultKind }) });
  const execute = async (deps, t, extra = {}) => mustOk(await executeDueActions(deps, { tenantId: t.tenantId, limit: 20, ...extra }), 'execute');
  const row = async (actionId) => (await db.query('select * from scheduled_actions where id = $1', [actionId])).rows[0];
  const runRow = async (runId) => (await db.query('select * from automation_runs where id = $1', [runId])).rows[0];
  const attempts = async (actionId) => (await db.query('select * from automation_action_attempts where action_id = $1 order by attempt_no', [actionId])).rows;
  const makeDue = (actionId) => db.query(`update scheduled_actions set run_at = now() - interval '1 second' where id = $1`, [actionId]);

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    store = supabaseSchedulerStore(restClient(db));
    a = await tenant(db, operator);
    await a.live();
    b = await tenant(db, operator);
    await b.live();
  });

  test('the scheduler runs end to end with FakeTestRunner alone, and closes the run when its work is done', async () => {
    const fake = new FakeTestRunner({ environment: 'test' });
    const r = await run(a);
    const one = await queue(a, r, 'record_observation_checkpoint', { payload: { window: '7d' } });
    const two = await queue(a, r, 'remind_operator', { payload: { about: 'check the window' } });

    const reports = await execute(world([fake]), a);
    assert.deepEqual(reports.map((x) => [x.actionId, x.dispatched, x.outcome, x.actionStatus, x.code]).sort(),
      [[one.id, true, 'succeeded', 'done', 'ok'], [two.id, true, 'succeeded', 'done', 'ok']].sort());
    assert.deepEqual(reports.map((x) => x.runStatus), [null, 'completed'], 'open while one action waits; closed after the last');

    const [attempt] = await attempts(one.id);
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.runner_kind, 'fake_test');
    assert.equal(attempt.runner_execution_id, `fake_test:${attempt.id}`, 'the execution is correlated to ARC\'s attempt');
    assert.equal(attempt.evidence.runner, 'fake_test');
    const closed = await runRow(r.id);
    assert.equal(closed.status, 'completed');
    assert.equal(closed.terminal_code, 'actions_settled');
    assert.equal(closed.runner_kind, 'fake_test', 'the default runner is assigned to the run at its first start');
    assert.deepEqual(fake.violations, []);
  });

  test('the runner is handed the pinned snapshot, the durable idempotency key and connection metadata — and no secret', async () => {
    const fake = new FakeTestRunner({ environment: 'test' });
    const r = await run(a);
    const conn = await connection(a);
    const send = await queue(a, r, 'send_message', { connectionId: conn, payload: { template: 'followup_1', to_ref: 'contact:42' } });

    await execute(world([fake]), a);
    assert.equal(fake.received.length, 1);
    const [req] = fake.received;
    assert.equal(req.configSnapshotId, r.configSnapshotId);
    assert.equal(req.configSnapshotId, await a.snapshot());
    assert.equal(req.idempotencyKey, send.idempotencyKey);
    assert.equal(req.correlationId, r.correlationId);
    assert.equal(req.runMode, 'live');
    assert.equal(req.effectClass, 'external_effect');
    assert.equal(req.moduleVersion, 1);
    assert.deepEqual(req.connection, { connectionId: conn, connectorKey: (await row(send.id)).connector_key });
    assert.deepEqual(req.payload, { template: 'followup_1', to_ref: 'contact:42' });
    assert.equal(findSecretShaped(req), null);
    assert.deepEqual(fake.violations, []);
    assert.equal((await row(send.id)).status, 'done');
  });

  test('a retryable failure goes back on the queue after the backoff, and the next attempt keeps the key', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const fake = new FakeTestRunner({ environment: 'test' }).script(action.idempotencyKey, { do: 'fail', retryable: true, errorCode: 'rate_limited' });
    const deps = world([fake]);

    const [first] = await execute(deps, a);
    assert.deepEqual([first.outcome, first.actionStatus, first.runStatus], ['failed', 'pending', null]);
    const waiting = await row(action.id);
    const delay = (Date.parse(waiting.run_at) - Date.now()) / 1000;
    assert.ok(delay > 20 && delay <= 30, `remind_operator backs off 30s after one attempt, not ${delay}s`);
    assert.equal((await execute(deps, a)).length, 0, 'not claimable before the backoff');

    await makeDue(action.id);
    const [second] = await execute(deps, a);
    assert.deepEqual([second.outcome, second.actionStatus, second.attemptNumber], ['succeeded', 'done', 2]);
    const rows = await attempts(action.id);
    assert.deepEqual(rows.map((x) => [x.attempt_no, x.status, x.retryable, x.error_code]), [[1, 'failed', true, 'rate_limited'], [2, 'succeeded', null, null]]);
    assert.deepEqual(fake.received.map((x) => [x.attemptNumber, x.idempotencyKey]), [[1, action.idempotencyKey], [2, action.idempotencyKey]]);
    assert.notEqual(fake.received[0].attemptId, fake.received[1].attemptId);
  });

  test('a non-retryable failure is terminal, and fails the run', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up');
    const fake = new FakeTestRunner({ environment: 'test' }).script(action.idempotencyKey, { do: 'fail', retryable: false, errorCode: 'template_missing', message: 'no such template' });
    const [out] = await execute(world([fake]), a);
    assert.deepEqual([out.outcome, out.actionStatus, out.runStatus], ['failed', 'failed', 'failed']);
    assert.equal((await runRow(r.id)).terminal_code, 'action_failed');
    const [attempt] = await attempts(action.id);
    assert.equal(attempt.error_message, 'no such template');
  });

  test('retries stop at the cap in dead letter', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator', { maxAttempts: 2 });
    const fake = new FakeTestRunner({ environment: 'test' }).script(action.idempotencyKey,
      { do: 'fail', retryable: true, errorCode: 'upstream_busy' }, { do: 'fail', retryable: true, errorCode: 'upstream_busy' });
    const deps = world([fake]);
    await execute(deps, a);
    await makeDue(action.id);
    const [last] = await execute(deps, a);
    assert.deepEqual([last.outcome, last.actionStatus, last.runStatus], ['failed', 'dead_letter', 'failed']);
    assert.equal((await runRow(r.id)).terminal_code, 'action_dead_lettered');
    assert.equal(fake.received.length, 2);
  });

  test('an ambiguous outcome blocks the action, nothing resends it, and the run stays open for a person', async () => {
    const r = await run(a);
    const send = await queue(a, r, 'send_message', { connectionId: await connection(a) });
    const fake = new FakeTestRunner({ environment: 'test' }).script(send.idempotencyKey, { do: 'ambiguous', errorCode: 'provider_timeout' });
    const deps = world([fake]);

    const [out] = await execute(deps, a);
    assert.deepEqual([out.outcome, out.actionStatus, out.runStatus], ['ambiguous', 'blocked', null]);
    const blocked = await row(send.id);
    assert.equal(blocked.gate_code, 'ambiguous_outcome');
    await makeDue(send.id);
    assert.equal((await execute(deps, a)).length, 0, 'a blocked action is never claimed again');
    assert.equal(fake.received.length, 1, 'the effect was attempted once');
    assert.equal((await runRow(r.id)).status, 'running');
    const [attempt] = await attempts(send.id);
    assert.deepEqual([attempt.status, attempt.ambiguous, attempt.retryable, attempt.error_code], ['ambiguous', true, false, 'provider_timeout']);
  });

  test('a runner that never answers an external effect leaves it unknown, never failed — and is asked to stop', async () => {
    const r = await run(a);
    const send = await queue(a, r, 'call_provider_operation', { connectionId: await connection(a) });
    const fake = new FakeTestRunner({ environment: 'test' }).script(send.idempotencyKey, { do: 'hang' });
    const [out] = await execute(world([fake]), a, { timeoutMs: 50 });
    assert.deepEqual([out.outcome, out.actionStatus, out.dispatched], ['ambiguous', 'blocked', true]);
    const [attempt] = await attempts(send.id);
    assert.equal(attempt.error_code, 'runner_timeout');
    assert.equal(fake.cancellations.length, 1);
  });

  test('a runner that never answers internal work is simply tried again', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up');
    const fake = new FakeTestRunner({ environment: 'test' }).script(action.idempotencyKey, { do: 'hang' });
    const deps = world([fake]);
    const [out] = await execute(deps, a, { timeoutMs: 50 });
    assert.deepEqual([out.outcome, out.actionStatus], ['failed', 'pending']);
    assert.equal((await attempts(action.id))[0].retryable, true);
    await makeDue(action.id);
    assert.equal((await execute(deps, a))[0].actionStatus, 'done');
  });

  test('an exception during an external effect is ambiguous, unless the runner proves nothing left', async () => {
    const r = await run(a);
    const conn = await connection(a);
    const maybe = await queue(a, r, 'send_message', { connectionId: conn });
    const never = await queue(a, r, 'send_message', { connectionId: conn });
    const fake = new FakeTestRunner({ environment: 'test' })
      .script(maybe.idempotencyKey, { do: 'throw', effectPossible: true, errorCode: 'socket_reset' })
      .script(never.idempotencyKey, { do: 'throw', effectPossible: false, retryable: true, errorCode: 'provider_unreachable' });
    const deps = world([fake]);
    const reports = await execute(deps, a);
    const by = Object.fromEntries(reports.map((x) => [x.actionId, x]));
    assert.deepEqual([by[maybe.id].outcome, by[maybe.id].actionStatus], ['ambiguous', 'blocked']);
    assert.deepEqual([by[never.id].outcome, by[never.id].actionStatus], ['failed', 'pending']);
    await makeDue(never.id);
    assert.equal((await execute(deps, a))[0].actionStatus, 'done');
  });

  test('a malformed result is refused: unknown for an external effect, retried for internal work', async () => {
    const r = await run(a);
    const send = await queue(a, r, 'send_message', { connectionId: await connection(a) });
    const note = await queue(a, r, 'remind_operator');
    const garbled = { do: 'return', value: { status: 'done', delivered: true } };
    const fake = new FakeTestRunner({ environment: 'test' }).script(send.idempotencyKey, garbled).script(note.idempotencyKey, garbled);
    const deps = world([fake]);
    const by = Object.fromEntries((await execute(deps, a)).map((x) => [x.actionId, x]));
    assert.deepEqual([by[send.id].outcome, by[send.id].actionStatus], ['ambiguous', 'blocked']);
    assert.deepEqual([by[note.id].outcome, by[note.id].actionStatus], ['failed', 'pending']);
    assert.equal((await attempts(send.id))[0].error_code, 'runner_result_invalid');
    await makeDue(note.id);
    await execute(deps, a);
  });

  test('an unknown runner kind is refused safely: nothing is dispatched, and the action fails with the reason', async () => {
    const fake = new FakeTestRunner({ environment: 'test' });
    const r = await run(a, { runnerKind: 'ghost_runner' });
    const send = await queue(a, r, 'send_message', { connectionId: await connection(a) });
    const [out] = await execute(world([fake]), a);
    assert.deepEqual([out.dispatched, out.outcome, out.actionStatus, out.runnerKind], [false, 'failed', 'failed', null]);
    assert.equal(fake.received.length, 0);
    const [attempt] = await attempts(send.id);
    assert.deepEqual([attempt.error_code, attempt.retryable, attempt.runner_kind], ['runner_unknown', false, null]);
  });

  test('a runner is not handed a type or a mode it does not execute', async () => {
    const narrow = new FakeTestRunner({ environment: 'test', kind: 'narrow_fake', actionTypes: ['remind_operator'], runModes: ['test'] });
    const wide = new FakeTestRunner({ environment: 'test' });
    const deps = world([wide, narrow], 'fake_test');
    const r = await run(a, { runnerKind: 'narrow_fake' });
    const wrongType = await queue(a, r, 'schedule_follow_up');
    const wrongMode = await queue(a, r, 'remind_operator');
    const by = Object.fromEntries((await execute(deps, a)).map((x) => [x.actionId, x]));
    for (const id of [wrongType.id, wrongMode.id]) {
      assert.deepEqual([by[id].dispatched, by[id].actionStatus], [false, 'failed']);
      assert.equal((await attempts(id))[0].error_code, 'runner_unsupported');
    }
    assert.equal(narrow.received.length + wide.received.length, 0, 'no substitute runner was used');
  });

  test('a paused module holds its work: the runner is never called until an operator resumes it', async () => {
    const c = await tenant(db, operator);
    await c.live();
    const fake = new FakeTestRunner({ environment: 'test' });
    const deps = world([fake]);
    const r = await run(c);
    const held = await queue(c, r, 'schedule_follow_up');
    await c.pause();
    assert.equal((await execute(deps, c)).length, 0);
    assert.equal(fake.received.length, 0);
    assert.equal((await row(held.id)).status, 'pending');
    await c.resume();
    const [out] = await execute(deps, c);
    assert.deepEqual([out.actionId, out.actionStatus], [held.id, 'done']);
  });

  test('evidence shaped like a credential is withheld; the outcome is still recorded', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const fake = new FakeTestRunner({ environment: 'test' }).script(action.idempotencyKey, { do: 'succeed', evidence: { response: { access_token: 'x' } } });
    const [out] = await execute(world([fake]), a);
    assert.equal(out.actionStatus, 'done');
    assert.deepEqual((await attempts(action.id))[0].evidence, { evidence_withheld: 'credential_shaped' });
  });

  test('one tenant\'s execution never touches another tenant\'s work, and a held lease is never executed twice', async () => {
    const fake = new FakeTestRunner({ environment: 'test' });
    const theirs = await queue(b, await run(b), 'remind_operator');
    const r = await run(a);
    const mine = await queue(a, r, 'remind_operator');
    const held = mustOk(await claimDueActions(store, { tenantId: a.tenantId, worker: 'other-worker', limit: 5 }), 'claim');
    assert.deepEqual(held.map((c) => c.action.id), [mine.id]);

    assert.equal((await execute(world([fake]), a)).length, 0, 'another worker holds it');
    assert.equal((await row(theirs.id)).status, 'pending', 'tenant B untouched');
    assert.equal(fake.received.length, 0);
    await db.query(`update scheduled_actions set lease_expires_at = now() - interval '1 second' where id = $1`, [mine.id]);
    const after = await execute(world([fake]), b);
    assert.deepEqual(after.map((x) => x.actionId), [theirs.id]);
    await execute(world([fake]), a);
  });

  test('a claim refused outright is returned, not swallowed', async () => {
    const out = await executeDueActions(world(), { tenantId: 'not-a-tenant' });
    assert.equal(out.code, 'tenant_required');
    const tooLong = await executeDueActions(world(), { tenantId: a.tenantId, leaseSeconds: 60, timeoutMs: 55_000 });
    assert.equal(tooLong.code, 'invalid_request', 'a runner may not be waited on past the lease');
  });
});
