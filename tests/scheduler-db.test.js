/* ARC-200 — durable runs, actions, attempts and scheduling, against real Postgres.
 *
 * The scheduler service (`_shared/scheduler/service.ts`) over its production adapter,
 * through PGlite and the PostgREST-shaped client — the same SQL, triggers, functions and
 * RLS a hosted database runs. Each test names the promise it checks. Tenants are put into
 * the lifecycle states a run needs by the real lifecycle engine, exactly as ARC-120's own
 * database suite does, and nothing reaches a provider: the Lead Recovery canary uses a
 * recording sender and no scheduler action is executed by anything but the test itself.
 *
 * One honest limit: PGlite is one connection, so two "concurrent" claims run one after
 * the other. What is tested is that a claimed action is never handed out again while its
 * lease holds; that two simultaneous transactions skip each other's rows is `for update
 * skip locked`, which is Postgres's guarantee, not something this suite can race.
 *
 * Without PGlite the suite is reported as skipped, never as passed. Tenants come from
 * `scheduler-fixtures.js`, shared with the ARC-210 runner suite.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { LR, newMember, newOperator, tenant } from './scheduler-fixtures.js';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import {
  blockRun,
  cancelFutureActions,
  cancelRun,
  claimDueActions,
  completeFailure,
  completeSkipped,
  completeSuccess,
  createAutomationRun,
  finishRun,
  listDueActions,
  listRunTimeline,
  listUpcomingActions,
  markAmbiguous,
  pauseRun,
  rescheduleRetry,
  resolveAmbiguousAction,
  resumeRun,
  scheduleAutomationAction,
  startAttempt,
} from '../supabase/functions/_shared/scheduler/service.ts';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const key = (label) => `${label}:${crypto.randomUUID()}`;
const past = () => new Date(Date.now() - 60_000).toISOString();
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('ARC-200 against real Postgres', { skip }, () => {
  let db;
  let operator;
  let store;
  let a;
  let b;

  const mustOk = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };

  async function run(t, { kind = 'observation_window', mode = 'live', idempotencyKey = key('run'), runnerKind = null } = {}) {
    return mustOk(await createAutomationRun(store, {
      tenantId: t.tenantId, runKind: kind, moduleKey: LR, configSnapshotId: await t.snapshot(), runMode: mode,
      correlationId: crypto.randomUUID(), idempotencyKey, runnerKind,
    }), 'create run').run;
  }
  async function queue(t, r, actionType, extra = {}) {
    return mustOk(await scheduleAutomationAction(store, {
      tenantId: t.tenantId, runId: r.id, actionType, runAt: past(), idempotencyKey: key(actionType), ...extra,
    }), `schedule ${actionType}`).action;
  }
  const claim = async (t, extra = {}) => mustOk(await claimDueActions(store, { tenantId: t.tenantId, worker: 'w-1', ...extra }), 'claim');
  const claimOne = async (t, actionId) => {
    const got = (await claim(t, { limit: 50 })).find((c) => c.action.id === actionId);
    assert.ok(got, `action ${actionId} was not claimed`);
    return got;
  };
  const row = async (actionId) => (await db.query('select * from scheduled_actions where id = $1', [actionId])).rows[0];
  const attempts = async (actionId) => (await db.query('select * from automation_action_attempts where action_id = $1 order by attempt_no', [actionId])).rows;
  const expireLease = (actionId) => db.query(`update scheduled_actions set lease_expires_at = now() - interval '1 second' where id = $1`, [actionId]);
  const makeDue = (actionId) => db.query(`update scheduled_actions set run_at = now() - interval '1 second' where id = $1`, [actionId]);
  async function connection(t, status, { connector = `c_${counter++}_x`, expiresAt = null, refreshable = false } = {}) {
    const { rows: [c] } = await db.query(
      `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status, ended_at, access_expires_at, refreshable)
       values ($1, $2, 1, 'api_key', $3, case when $3 in ('revoked', 'disconnected') then now() end, $4, $5) returning id`,
      [t.tenantId, connector, status, expiresAt, refreshable],
    );
    return c.id;
  }

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    store = supabaseSchedulerStore(restClient(db));
    a = await tenant(db, operator);
    await a.live();
    b = await tenant(db, operator);
    await b.live();
  });

  /* ── runs ── */

  test('a run is pinned to its snapshot, and the database writes where it came from', async () => {
    const correlationId = crypto.randomUUID();
    const idempotencyKey = key('pinned');
    const created = mustOk(await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live',
      correlationId, idempotencyKey, runnerKind: 'fake_test_runner',
    }), 'create');
    assert.equal(created.created, true);
    const r = created.run;
    assert.equal(r.configSnapshotId, await a.snapshot());
    assert.equal(r.status, 'pending');
    assert.equal(r.startedAt, null, 'nothing has been claimed for it yet');
    assert.equal(r.lifecycleStateAtStart, 'active');
    assert.equal(r.moduleVersion, 1);
    assert.equal(r.correlationId, correlationId);
    assert.equal(r.runnerKind, 'fake_test_runner');
    assert.equal(r.leadId, null);

    const replay = mustOk(await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live',
      correlationId, idempotencyKey,
    }), 'replay');
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, r.id);
    const conflict = await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'connector_test', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live', correlationId, idempotencyKey,
    });
    assert.equal(conflict.code, 'idempotency_conflict');

    assert.match(await refused(db, `update automation_runs set lifecycle_state_at_start = 'paused' where id = $1`, [r.id]), /run_identity_fixed/);
    assert.match(await refused(db, `update automation_runs set lead_id = (select lead_id from automation_runs where lead_id is not null and tenant_id = $2 limit 1) where id = $1`, [r.id, a.tenantId]), /fixed when a run is created|lead_matches_kind/);
    assert.match(await refused(db, `update automation_runs set runner_kind = 'something_else' where id = $1`, [r.id]), /assigned once/);
  });

  test('a run cannot borrow another tenant\'s snapshot, and a live run needs the module active', async () => {
    const theirs = await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'connector_test', moduleKey: LR, configSnapshotId: await b.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: key('borrow'),
    });
    assert.equal(theirs.ok, false);
    assert.equal(theirs.code, 'guard_refused');
    assert.match(theirs.message, /does not belong to tenant/);

    const c = await tenant(db, operator);
    await c.underTest();
    const live = await createAutomationRun(store, {
      tenantId: c.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await c.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: key('not-live'),
    });
    assert.equal(live.code, 'module_not_active', 'a module under test cannot start a live run');
    const testing = await createAutomationRun(store, {
      tenantId: c.tenantId, runKind: 'connector_test', moduleKey: LR, configSnapshotId: await c.snapshot(), runMode: 'test',
      correlationId: crypto.randomUUID(), idempotencyKey: key('under-test'),
    });
    assert.equal(testing.ok, true, 'a test-mode run with no lead needs no synthetic lead');
  });

  /* ── actions ── */

  test('an action pins its tenant, module and configuration snapshot, and none of them moves', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up', { payload: { step: 2 } });
    assert.equal(action.tenantId, a.tenantId);
    assert.equal(action.moduleKey, LR);
    assert.equal(action.configSnapshotId, r.configSnapshotId);
    assert.equal(action.scheduledFor, action.runAt);
    assert.equal(action.maxAttempts, 3, 'the type\'s default');
    assert.match(await refused(db, 'update scheduled_actions set config_snapshot_id = null where id = $1', [action.id]), /snapshot is fixed/);
    assert.match(await refused(db, `update scheduled_actions set payload = '{"step":3}' where id = $1`, [action.id]), /payload is fixed/);
    assert.match(await refused(db, `update scheduled_actions set action_type = 'remind_operator' where id = $1`, [action.id]), /identity_fixed/);
  });

  test('a secret-shaped payload is refused by the service and, if something bypasses it, by the database', async () => {
    const r = await run(a);
    const viaService = await scheduleAutomationAction(store, {
      tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: key('secret'),
      payload: { note: `Bearer ${'z'.repeat(24)}` },
    });
    assert.equal(viaService.code, 'secret_in_payload');
    await assert.rejects(store.scheduleAction({
      tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: key('secret'),
      payload: { api_key: 'abc' }, maxAttempts: null, connectionId: null,
    }), (e) => e.code === 'constraint_refused' && /no_secrets/.test(e.message));
    assert.equal((await db.query(`select count(*)::int as n from scheduled_actions where payload::text ilike '%api_key%'`)).rows[0].n, 0);
  });

  test('one idempotency key is one logical action: a replay returns it, a different action under it is refused', async () => {
    const r = await run(a);
    const k = key('idem');
    const first = mustOk(await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: k, payload: { n: 1 } }), 'first');
    const again = mustOk(await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: k, payload: { n: 1 } }), 'again');
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.action.id, first.action.id);
    const different = await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: k, payload: { n: 2 } });
    assert.equal(different.code, 'idempotency_conflict');
    /* the key is the tenant's: another tenant may use the same words. */
    const rb = await run(b);
    assert.equal((await scheduleAutomationAction(store, { tenantId: b.tenantId, runId: rb.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: k, payload: { n: 1 } })).ok, true);
    assert.match(await refused(db, `insert into scheduled_actions (tenant_id, run_id, action_type, run_at, idempotency_key) values ($1, $2, 'remind_operator', now(), $3)`, [a.tenantId, r.id, k]), /duplicate key|unique/);
  });

  /* ── claiming ── */

  test('a due action is claimable; a future one is not, and the scheduler shows it as upcoming', async () => {
    const r = await run(a);
    const due = await queue(a, r, 'remind_operator');
    const later = await queue(a, r, 'remind_operator', { runAt: inHours(3) });
    const claimed = (await claim(a, { limit: 50 })).map((c) => c.action.id);
    assert.ok(claimed.includes(due.id));
    assert.ok(!claimed.includes(later.id), 'a future action is not claimable');
    const upcoming = mustOk(await listUpcomingActions(store, { tenantId: a.tenantId, from: new Date().toISOString(), until: inHours(4) }), 'upcoming');
    assert.ok(upcoming.some((x) => x.id === later.id));
    const dueNow = mustOk(await listDueActions(store, { tenantId: a.tenantId, asOf: new Date().toISOString() }), 'due');
    assert.ok(!dueNow.some((x) => x.id === later.id));
    assert.equal((await row(later.id)).status, 'pending');
  });

  test('two claims never both win an action, and its run starts on the first', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const [one, two] = await Promise.all([claim(a, { limit: 50, worker: 'w-a' }), claim(a, { limit: 50, worker: 'w-b' })]);
    const winners = [...one, ...two].filter((c) => c.action.id === action.id);
    assert.equal(winners.length, 1, 'exactly one worker holds it');
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === action.id).length, 0, 'a held lease is not handed out again');
    const after = (await db.query('select status, started_at from automation_runs where id = $1', [r.id])).rows[0];
    assert.equal(after.status, 'running');
    assert.ok(after.started_at);
  });

  test('an expired lease is reclaimed with a new attempt, and the old holder can do nothing', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up');
    const first = await claimOne(a, action.id);
    await expireLease(action.id);
    const second = await claimOne(a, action.id);
    assert.notEqual(second.lease.leaseToken, first.lease.leaseToken);
    assert.equal(second.action.fence, first.action.fence + 1);
    const rows = await attempts(action.id);
    assert.deepEqual(rows.map((x) => `${x.attempt_no}:${x.status}`), ['1:lease_expired', '2:claimed'], 'the prior attempt is kept, and closed');
    assert.equal((await startAttempt(store, first.lease)).code, 'lost_lease');
    assert.equal((await completeSuccess(store, first.lease)).code, 'lost_lease');
    mustOk(await completeSuccess(store, second.lease), 'the current holder settles it');
  });

  test('only the holder of the current lease can start or settle, and only in its own tenant', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const held = await claimOne(a, action.id);
    const forged = { ...held.lease, leaseToken: crypto.randomUUID() };
    assert.equal((await startAttempt(store, forged)).code, 'lost_lease');
    assert.equal((await completeSuccess(store, forged)).code, 'lost_lease');
    assert.equal((await completeSuccess(store, { ...held.lease, tenantId: b.tenantId })).code, 'not_found');
    assert.equal((await row(action.id)).status, 'claimed', 'nothing moved');
    mustOk(await completeSuccess(store, held.lease), 'the holder');
  });

  test('success is terminal: the action is never claimed, settled or re-queued again', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const held = await claimOne(a, action.id);
    mustOk(await startAttempt(store, held.lease, { runnerKind: 'fake_test_runner' }), 'start');
    const done = mustOk(await completeSuccess(store, held.lease, { runnerExecutionId: 'exec-1', evidence: { reminded: true } }), 'succeed');
    assert.equal(done.actionStatus, 'done');
    await makeDue(action.id).catch(() => {});
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === action.id).length, 0);
    assert.equal((await completeSuccess(store, held.lease)).code, 'already_completed');
    assert.match(await refused(db, `update scheduled_actions set status = 'pending' where id = $1`, [action.id]), /action_finished/);
    const [att] = await attempts(action.id);
    assert.equal(att.status, 'succeeded');
    assert.equal(att.runner_kind, 'fake_test_runner');
    assert.equal(att.runner_execution_id, 'exec-1');
    assert.equal((await db.query('select runner_kind from automation_runs where id = $1', [r.id])).rows[0].runner_kind, 'fake_test_runner');
  });

  /* ── retries ── */

  test('a retryable failure backs off exponentially, and every attempt is kept', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up', { maxAttempts: 5 });
    const gap = async () => Number((await db.query('select round(extract(epoch from run_at - updated_at))::int as s from scheduled_actions where id = $1', [action.id])).rows[0].s);

    let held = await claimOne(a, action.id);
    const one = mustOk(await completeFailure(store, held.lease, { retryable: true, errorCode: 'upstream_timeout', message: 'the model timed out' }), 'fail 1');
    assert.equal(one.actionStatus, 'pending');
    assert.equal(await gap(), 30, 'base');
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === action.id).length, 0, 'not before the backoff');

    await makeDue(action.id);
    held = await claimOne(a, action.id);
    mustOk(await completeFailure(store, held.lease, { retryable: true, errorCode: 'upstream_timeout' }), 'fail 2');
    assert.equal(await gap(), 60, 'doubled');

    await makeDue(action.id);
    held = await claimOne(a, action.id);
    mustOk(await rescheduleRetry(store, held.lease, { retryAt: new Date(Date.now() + 1000).toISOString(), errorCode: 'rate_limited' }), 'sooner than the backoff');
    assert.equal(await gap(), 120, 'a caller cannot ask for a sooner retry than the backoff');

    await makeDue(action.id);
    held = await claimOne(a, action.id);
    mustOk(await rescheduleRetry(store, held.lease, { retryAt: inHours(2), errorCode: 'rate_limited' }), 'later than the backoff');
    assert.ok(await gap() >= 7190, 'a later retry is honoured');

    const rows = await attempts(action.id);
    assert.deepEqual(rows.map((x) => `${x.attempt_no}:${x.status}:${x.retryable}`), ['1:failed:true', '2:failed:true', '3:failed:true', '4:failed:true']);
    assert.equal(rows[0].error_message, 'the model timed out');
  });

  test('retries stop at max attempts, in dead_letter; a non-retryable failure is terminal at once', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'schedule_follow_up', { maxAttempts: 2 });
    let held = await claimOne(a, action.id);
    mustOk(await completeFailure(store, held.lease, { retryable: true }), 'fail 1');
    await makeDue(action.id);
    held = await claimOne(a, action.id);
    const last = mustOk(await completeFailure(store, held.lease, { retryable: true }), 'fail 2');
    assert.equal(last.actionStatus, 'dead_letter');
    assert.equal((await row(action.id)).gate_code, 'attempts_exhausted');
    await makeDue(action.id).catch(() => {});
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === action.id).length, 0);

    const other = await queue(a, r, 'schedule_follow_up');
    held = await claimOne(a, other.id);
    const failed = mustOk(await completeFailure(store, held.lease, { retryable: false, errorCode: 'invalid_input' }), 'fail');
    assert.equal(failed.actionStatus, 'failed');
  });

  /* ── external effects ── */

  test('an ambiguous outcome is never resent: it waits for a person, and only an operator can release it', async () => {
    const r = await run(a);
    const conn = await connection(a, 'verified');
    const action = await queue(a, r, 'send_message', { connectionId: conn, payload: { template: 'followup_1' } });
    const held = await claimOne(a, action.id);
    assert.equal((await completeSuccess(store, held.lease)).code, 'not_started', 'an external effect settles only after it was recorded as started');
    mustOk(await startAttempt(store, held.lease, { runnerKind: 'fake_test_runner' }), 'start');
    const out = mustOk(await markAmbiguous(store, held.lease, { errorCode: 'provider_timeout', message: 'timed out after the request left' }), 'ambiguous');
    assert.equal(out.actionStatus, 'blocked');
    const blocked = await row(action.id);
    assert.equal(blocked.gate_code, 'ambiguous_outcome');

    await makeDue(action.id);
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === action.id).length, 0, 'never claimed again on its own');
    assert.equal(mustOk(await cancelFutureActions(store, { tenantId: a.tenantId, runId: r.id, reason: 'tidying up' }), 'cancel'), 0, 'cancelling future work does not erase an unknown outcome');
    assert.equal((await finishRun(store, { tenantId: a.tenantId, runId: r.id, status: 'completed', code: 'done' })).code, 'actions_outstanding');

    const member = await newMember(db, a.tenantId);
    assert.equal((await resolveAmbiguousAction(store, { tenantId: a.tenantId, actionId: action.id, resolution: 'effect_absent', operatorId: member })).code, 'forbidden');
    assert.equal(mustOk(await resolveAmbiguousAction(store, { tenantId: a.tenantId, actionId: action.id, resolution: 'effect_absent', operatorId: operator, note: 'provider log shows nothing sent' }), 'resolve'), 'pending');
    const again = await claimOne(a, action.id);
    const rows = await attempts(action.id);
    assert.deepEqual(rows.map((x) => `${x.attempt_no}:${x.status}`), ['1:ambiguous', '2:claimed']);
    assert.equal(rows[0].reconciliation, 'effect_absent');
    assert.equal(rows[0].reconciled_by, operator);
    assert.match(await refused(db, `update automation_action_attempts set reconciliation = 'effect_happened' where id = $1`, [rows[0].id]), /reconciled, once/);

    mustOk(await startAttempt(store, again.lease), 'start 2');
    mustOk(await markAmbiguous(store, again.lease), 'ambiguous again');
    assert.equal(mustOk(await resolveAmbiguousAction(store, { tenantId: a.tenantId, actionId: action.id, resolution: 'effect_happened', operatorId: operator }), 'resolve 2'), 'done');
  });

  test('a worker that vanishes mid-effect leaves an ambiguous outcome, not a retry — unless the action touched nothing outside ARC', async () => {
    const r = await run(a);
    const conn = await connection(a, 'verified');
    const send = await queue(a, r, 'send_message', { connectionId: conn });
    const held = await claimOne(a, send.id);
    mustOk(await startAttempt(store, held.lease), 'start');
    await expireLease(send.id);
    assert.equal((await claim(a, { limit: 50 })).filter((c) => c.action.id === send.id).length, 0, 'the sweep does not resend it');
    const after = await row(send.id);
    assert.equal(after.status, 'blocked');
    assert.equal(after.gate_code, 'ambiguous_outcome');
    const [att] = await attempts(send.id);
    assert.equal(att.status, 'ambiguous');
    assert.equal(att.error_code, 'lease_expired_mid_effect');
    assert.equal((await completeSuccess(store, held.lease)).code, 'already_completed', 'the vanished worker cannot come back and claim success');

    const internal = await queue(a, r, 'schedule_follow_up');
    const h2 = await claimOne(a, internal.id);
    mustOk(await startAttempt(store, h2.lease), 'start internal');
    await expireLease(internal.id);
    await claimOne(a, internal.id);
    assert.deepEqual((await attempts(internal.id)).map((x) => x.status), ['lease_expired', 'claimed']);
    assert.match(await refused(db, `update automation_action_attempts set status = 'lease_expired' where action_id = $1 and status = 'ambiguous'`, [send.id]), /attempt_history/);
  });

  /* ── pause, resume, cancel ── */

  test('a paused module holds its work, and the resume releases it; bookkeeping proceeds throughout', async () => {
    const c = await tenant(db, operator);
    await c.live();
    const r = await run(c);
    /* claimed first, alone, so the claim takes nothing else. */
    const inFlight = await queue(c, r, 'evaluate_reply');
    const claimedBeforePause = await claimOne(c, inFlight.id);
    const held = await queue(c, r, 'schedule_follow_up');
    const bookkeeping = await queue(c, r, 'record_observation_checkpoint');

    await c.pause();
    assert.equal((await row(held.id)).status, 'pending', 'a pause does not cancel the scheduler\'s work — it holds it');
    const during = (await claim(c, { limit: 50 })).map((x) => x.action.id);
    assert.ok(!during.includes(held.id), 'pause blocks the claim');
    assert.ok(during.includes(bookkeeping.id), 'an action that touches nothing outside ARC proceeds');
    assert.equal((await row(held.id)).gate_code, 'module_paused');

    const late = await startAttempt(store, claimedBeforePause.lease);
    assert.equal(late.code, 'module_paused', 'a pause between the claim and the start stops the start');
    const refunded = await row(inFlight.id);
    assert.equal(refunded.status, 'pending');
    assert.equal(refunded.attempts, 0, 'nothing was attempted, so nothing is charged');
    assert.equal((await attempts(inFlight.id))[0].status, 'released');

    await c.resume();
    const after = (await claim(c, { limit: 50 })).map((x) => x.action.id);
    assert.ok(after.includes(held.id), 'resume permits the claim');
    assert.ok(after.includes(inFlight.id));
  });

  test('a paused or blocked run holds its work; the system can pause and block it but never resume it', async () => {
    const r = await run(a);
    const held = await queue(a, r, 'schedule_follow_up');
    const human = await queue(a, r, 'request_human_review');
    mustOk(await pauseRun(store, { tenantId: a.tenantId, runId: r.id, code: 'operator_review', reason: 'checking the numbers' }), 'pause');
    let claimed = (await claim(a, { limit: 50 })).map((x) => x.action.id);
    assert.ok(!claimed.includes(held.id));
    assert.ok(claimed.includes(human.id), 'putting a person on it still proceeds');
    assert.equal((await row(held.id)).gate_code, 'run_paused');
    assert.equal((await db.query('select status_reason from automation_runs where id = $1', [r.id])).rows[0].status_reason, 'checking the numbers');

    mustOk(await blockRun(store, { tenantId: a.tenantId, runId: r.id, code: 'safety', reason: 'a distress signal' }), 'block');
    assert.equal((await store.setRunStatus({ tenantId: a.tenantId, runId: r.id, status: 'running', code: null, reason: null, actor: { type: 'system', id: null } }).catch((e) => e)).code, 'forbidden');
    const member = await newMember(db, a.tenantId);
    assert.equal((await resumeRun(store, { tenantId: a.tenantId, runId: r.id, operatorId: member })).code, 'forbidden');
    mustOk(await resumeRun(store, { tenantId: a.tenantId, runId: r.id, operatorId: operator }), 'resume');
    claimed = (await claim(a, { limit: 50 })).map((x) => x.action.id);
    assert.ok(claimed.includes(held.id));
  });

  test('cancel prevents the claim: cancelled work never runs, and a cancelled run takes no more', async () => {
    const r = await run(a);
    const one = await queue(a, r, 'schedule_follow_up');
    const two = await queue(a, r, 'remind_operator', { runAt: inHours(1) });
    assert.equal(mustOk(await cancelFutureActions(store, { tenantId: a.tenantId, runId: r.id, reason: 'customer booked', types: ['schedule_follow_up'] }), 'cancel one type'), 1);
    assert.equal((await row(one.id)).status, 'cancelled');
    assert.equal((await row(two.id)).status, 'pending');

    const r2 = await run(a);
    const inFlight = await queue(a, r2, 'remind_operator');
    const held = await claimOne(a, inFlight.id);
    const waiting = await queue(a, r2, 'schedule_follow_up', { runAt: inHours(1) });
    const finished = mustOk(await cancelRun(store, { tenantId: a.tenantId, runId: r2.id, code: 'operator_cancelled', reason: 'wrong customer' }), 'cancel run');
    assert.equal(finished.runStatus, 'cancelled');
    assert.equal(finished.cancelledActions, 1);
    assert.equal(finished.inFlightActions, 1, 'what a worker holds is left to its lease');
    await makeDue(waiting.id).catch(() => {});
    assert.equal((await claim(a, { limit: 50 })).filter((x) => x.action.id === waiting.id).length, 0);
    assert.equal((await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r2.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: key('late') })).code, 'run_finished');
    mustOk(await completeSkipped(store, held.lease, { message: 'the run was cancelled' }), 'the holder settles');
    assert.match(await refused(db, `update automation_runs set status = 'running' where id = $1`, [r2.id]), /run_finished/);
  });

  test('a run finishes completed only when nothing is waiting, in flight or ambiguous', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    assert.equal((await finishRun(store, { tenantId: a.tenantId, runId: r.id, status: 'completed', code: 'window_closed' })).code, 'actions_outstanding');
    const held = await claimOne(a, action.id);
    mustOk(await completeSuccess(store, held.lease), 'done');
    const done = mustOk(await finishRun(store, { tenantId: a.tenantId, runId: r.id, status: 'completed', code: 'window_closed' }), 'finish');
    assert.equal(done.runStatus, 'completed');
    const after = (await db.query('select status, terminal_code, completed_at from automation_runs where id = $1', [r.id])).rows[0];
    assert.equal(after.terminal_code, 'window_closed');
    assert.ok(after.completed_at);
  });

  /* ── connections ── */

  test('a connection-dependent action is claimed only while its connection can serve it', async () => {
    const r = await run(a);
    const cases = [
      ['verified', 'send_message', {}, 'claimed', null],
      ['connected_unverified', 'send_message', {}, 'pending', 'connection_not_ready'],
      ['reauthorization_required', 'send_message', {}, 'pending', 'connection_not_ready'],
      ['verified', 'send_message', { expiresAt: new Date(Date.now() - 1000).toISOString(), refreshable: false }, 'pending', 'connection_expired'],
      ['verified', 'send_message', { expiresAt: new Date(Date.now() - 1000).toISOString(), refreshable: true }, 'claimed', null],
      ['revoked', 'send_message', {}, 'blocked', 'connection_revoked'],
      ['connected_unverified', 'test_connection', {}, 'claimed', null],
      ['revoked', 'test_connection', {}, 'blocked', 'connection_revoked'],
    ];
    const queued = [];
    for (const [status, type, opts, expected, gate] of cases) {
      const conn = await connection(a, status, opts);
      queued.push([await queue(a, r, type, { connectionId: conn }), expected, gate, `${type} on ${status} ${JSON.stringify(opts)}`]);
    }
    await claim(a, { limit: 100 });
    for (const [action, expected, gate, label] of queued) {
      const now = await row(action.id);
      assert.equal(now.status, expected, label);
      if (gate) assert.equal(now.gate_code, gate, label);
    }
    const theirs = await connection(b, 'verified');
    const borrowed = await scheduleAutomationAction(store, {
      tenantId: a.tenantId, runId: r.id, actionType: 'send_message', runAt: past(), idempotencyKey: key('borrow'), connectionId: theirs,
    });
    assert.equal(borrowed.code, 'reference_invalid', 'another tenant\'s connection cannot be referenced');
  });

  /* ── observation windows and reminders ── */

  test('observation windows and reminders are durable future work the scheduler holds without deciding anything', async () => {
    const r = await run(a, { kind: 'observation_window' });
    const reminder = await queue(a, r, 'remind_operator', { runAt: inHours(72), payload: { about: 'review the follow-up change', recommendation_id: 'rec-1' } });
    const checkpoint = await queue(a, r, 'record_observation_checkpoint', { runAt: inHours(168), payload: { window: '7d', metric: 'reply_rate' } });
    const upcoming = mustOk(await listUpcomingActions(store, { tenantId: a.tenantId, from: new Date().toISOString(), until: inHours(200) }), 'upcoming')
      .filter((x) => x.runId === r.id);
    assert.deepEqual(upcoming.map((x) => x.id), [reminder.id, checkpoint.id], 'in the order they fall due');
    assert.deepEqual(upcoming[1].payload, { window: '7d', metric: 'reply_rate' }, 'carried, not interpreted');
    assert.equal((await claim(a, { limit: 50 })).filter((x) => x.action.runId === r.id).length, 0, 'nothing is due yet');
    const timeline = mustOk(await listRunTimeline(store, { tenantId: a.tenantId, runId: r.id }), 'timeline');
    assert.deepEqual(timeline.entries.map((e) => e.kind), ['run_created', 'action_scheduled', 'action_scheduled']);
  });

  /* ── the two dispatchers ── */

  test('the two dispatchers never take each other\'s work, and Lead Recovery claims now leave an attempt history', async () => {
    const canary = a.canaryRun;
    const scheduled = await queue(a, canary, 'request_human_review');
    await db.query(`insert into scheduled_actions (tenant_id, run_id, action_type, run_at, idempotency_key) values ($1, $2, 'close_run', now() - interval '1 second', $3)`,
      [a.tenantId, canary.id, key('lr-close')]);
    const { rows: [lrAction] } = await db.query(`select id from scheduled_actions where run_id = $1 and action_type = 'close_run' and status = 'pending'`, [canary.id]);

    const lrClaim = (await db.query(`select * from claim_tenant_scheduled_actions($1, 50, 'lr-worker', 120, true)`, [a.tenantId])).rows;
    assert.ok(lrClaim.some((x) => x.id === lrAction.id), 'the Lead Recovery claim takes its own type');
    assert.ok(!lrClaim.some((x) => x.id === scheduled.id), 'and never a scheduler action it has no handler for');
    const schedulerClaim = (await claim(a, { limit: 50 })).map((x) => x.action.id);
    assert.ok(schedulerClaim.includes(scheduled.id));
    assert.ok(!schedulerClaim.includes(lrAction.id), 'the scheduler never takes a Lead Recovery action');

    const lease = lrClaim.find((x) => x.id === lrAction.id).lease_token;
    const { rows: [{ ok }] } = await db.query(`select complete_scheduled_action($1, $2, $3, 'done', null) as ok`, [lrAction.id, a.tenantId, lease]);
    assert.equal(ok, true);
    assert.deepEqual((await attempts(lrAction.id)).map((x) => x.status), ['succeeded']);

    /* the canary the tenant helper ran went through the real Lead Recovery dispatcher. */
    const { rows: history } = await db.query(
      `select a.action_type, p.status from automation_action_attempts p join scheduled_actions a on a.id = p.action_id
        where p.run_id = $1 and a.action_type = 'send_first_response'`, [canary.id]);
    assert.deepEqual(history.map((x) => `${x.action_type}:${x.status}`), ['send_first_response:succeeded']);
  });

  test('a lead conversation\'s status is its state machine\'s, and only its own controls move it', async () => {
    const canary = a.canaryRun;
    const { rows: [r] } = await db.query('select state, status, run_kind, correlation_id, lead_id from automation_runs where id = $1', [canary.id]);
    assert.equal(r.run_kind, 'lead_conversation');
    assert.equal(r.status, (await db.query('select lead_conversation_status($1) as s', [r.state])).rows[0].s);
    const { rows: [lead] } = await db.query('select correlation_id from leads where id = $1', [r.lead_id]);
    assert.equal(r.correlation_id, lead.correlation_id);
    assert.equal((await pauseRun(store, { tenantId: a.tenantId, runId: canary.id })).code, 'lead_conversation');
    assert.equal((await finishRun(store, { tenantId: a.tenantId, runId: canary.id, status: 'completed', code: 'x' })).code, 'lead_conversation');
    await db.query(`update automation_runs set state = 'handed_off' where id = $1`, [canary.id]);
    assert.equal((await db.query('select status from automation_runs where id = $1', [canary.id])).rows[0].status, 'blocked', 'a person holding the lead blocks automation');
  });

  /* ── history ── */

  test('attempts are history: never deleted, and a settled one never changes', async () => {
    const r = await run(a);
    const action = await queue(a, r, 'remind_operator');
    const held = await claimOne(a, action.id);
    mustOk(await completeSuccess(store, held.lease), 'done');
    const [att] = await attempts(action.id);
    assert.match(await refused(db, 'delete from automation_action_attempts where id = $1', [att.id]), /never deleted/);
    assert.match(await refused(db, `update automation_action_attempts set status = 'failed' where id = $1`, [att.id]), /is settled/);
    assert.match(await refused(db, `update automation_action_types set paused_policy = 'proceed' where key = 'send_message'`), /vocabulary_immutable/);
    assert.match(await refused(db, `insert into automation_action_attempts (tenant_id, action_id, run_id, attempt_no, worker, lease_token, fence, status) values ($1, $2, $3, 99, 'forger', gen_random_uuid(), 0, 'succeeded')`, [a.tenantId, action.id, r.id]), /begins claimed/);
  });

  /* ── RLS ── */

  test('tenant isolation: a member reads their own runs and nothing of the queue; nobody in a browser writes or claims', async () => {
    const ra = await run(a);
    const rb = await run(b);
    const actionA = await queue(a, ra, 'remind_operator', { runAt: inHours(5) });
    const member = await newMember(db, a.tenantId);

    await asRole(db, { role: 'authenticated', sub: member }, async (tx) => {
      const runs = (await tx.query('select id, tenant_id from automation_runs')).rows;
      assert.ok(runs.some((x) => x.id === ra.id), 'their own run');
      assert.ok(runs.every((x) => x.tenant_id === a.tenantId), 'nothing of another tenant\'s');
      assert.ok(!runs.some((x) => x.id === rb.id));
      for (const table of ['scheduled_actions', 'automation_action_attempts', 'automation_action_types']) {
        assert.equal((await tx.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, `${table} is operator material`);
      }
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      assert.ok((await tx.query('select count(*)::int as n from scheduled_actions where id = $1', [actionA.id])).rows[0].n === 1, 'an operator sees the queue');
      assert.ok((await tx.query('select count(*)::int as n from automation_action_types')).rows[0].n === 16);
    });
    await asRole(db, { role: 'anon' }, async (tx) => {
      assert.equal((await tx.query('select count(*)::int as n from automation_runs')).rows[0].n, 0);
    });

    for (const [role, sub] of [['authenticated', member], ['authenticated', operator], ['anon', null]]) {
      const client = restClient(db, { role, sub });
      for (const [fn, args] of [
        ['claim_tenant_automation_actions', { p_tenant: a.tenantId }],
        ['claim_automation_actions_global', {}],
        ['schedule_automation_action', { p_tenant: a.tenantId, p_run: ra.id, p_action_type: 'remind_operator', p_run_at: past(), p_idempotency_key: key('browser') }],
        ['settle_automation_attempt', { p_action: actionA.id, p_tenant: a.tenantId, p_lease: crypto.randomUUID(), p_outcome: 'succeeded' }],
        ['resolve_ambiguous_automation_action', { p_tenant: a.tenantId, p_action: actionA.id, p_resolution: 'effect_happened', p_actor: operator }],
        ['finish_automation_run', { p_tenant: a.tenantId, p_run: ra.id, p_status: 'cancelled', p_code: 'x' }],
      ]) {
        const { error } = await client.rpc(fn, args);
        assert.ok(error && /permission denied/.test(error.message), `${role} (${sub ?? 'no one'}) executed ${fn}: ${error?.message ?? 'it succeeded'}`);
      }
      const { error } = await client.from('scheduled_actions').update({ status: 'cancelled' }).eq('id', actionA.id);
      assert.equal(error, null, 'RLS filters the update to nothing rather than erroring');
      assert.equal((await row(actionA.id)).status, 'pending', `${role} changed nothing`);
    }
  });
});
