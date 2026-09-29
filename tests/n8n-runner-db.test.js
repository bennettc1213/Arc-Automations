/* ARC-220 — the n8n runner bridge against real Postgres.
 *
 * The orchestrator claims and starts an action; `N8nRunner` records the dispatch in 0018
 * and posts §18's reference to an in-process n8n double; the test then plays the shared
 * workflow — fetching the envelope and calling back with signed requests through the real
 * inbound handlers — and checks what ARC's rows say. No real n8n, provider or network is
 * reached: the double is a function, and every URL is on `.invalid`.
 *
 * Without PGlite the suite is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { asRole, freshDatabase, loadPglite, refused, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newMember, newOperator, tenant } from './scheduler-fixtures.js';
import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { findSecretShaped } from '../supabase/functions/_shared/scheduler/model.ts';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { createAutomationRun, scheduleAutomationAction } from '../supabase/functions/_shared/scheduler/service.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { executeDueActions } from '../supabase/functions/_shared/runner/orchestrator.ts';
import { FakeTestRunner } from '../supabase/functions/_shared/runner/fake.ts';
import { N8nRunner } from '../supabase/functions/_shared/n8n-runner/runner.ts';
import { supabaseWorkflowStore } from '../supabase/functions/_shared/n8n-runner/workflows.ts';
import { actionEntry, handlerEntry, permitN8n, wireWorkflows } from './workflow-fixtures.js';
import { supabaseBridgeStore } from '../supabase/functions/_shared/n8n-runner/supabase-bridge-store.ts';
import { handleCallback, handleEnvelopeRequest } from '../supabase/functions/_shared/n8n-runner/inbound.ts';
import { signBridgeRequest, verifyDispatchToken } from '../supabase/functions/_shared/n8n-runner/signing.ts';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;
const SQL = readFileSync(new URL('../supabase/migrations/0018_runner_bridge.sql', import.meta.url), 'utf8');

const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'tests', 'only', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'tests', 'only', 'y'.repeat(12)].join('-'));
const OTHER_SECRET = new SecretValue(['someone', 'elses', 'secret', 'z'.repeat(24)].join('-'));
const ROUTE = { runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0' };

let counter = 0;
const key = (label) => `${label}:${crypto.randomUUID()}`;
const past = () => new Date(Date.now() - 60_000).toISOString();
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('ARC-220 against real Postgres', { skip }, () => {
  let db;
  let operator;
  let store;
  let bridge;
  let a;
  let b;

  const mustOk = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };

  /** n8n, as far as ARC can tell: verifies the JWT like its Webhook node, remembers the dispatch, answers. */
  function n8nDouble({ answer = null } = {}) {
    const dispatches = [];
    let n = 0;
    const transport = async (request) => {
      const token = request.headers.Authorization.replace(/^Bearer /, '');
      const verified = await verifyDispatchToken(token, DISPATCH_SECRET, nowSeconds());
      if (!verified.ok) return { status: 401, body: null };
      dispatches.push(JSON.parse(request.body));
      if (answer) return typeof answer === 'function' ? answer(request) : answer;
      n += 1;
      return { status: 202, body: { n8n_execution_id: `exec-${counter}-${n}` } };
    };
    return { transport, dispatches };
  }
  const n8nRunner = (double, extra = {}) => new N8nRunner({
    environment: 'test', actionTypes: ['send_message', 'call_provider_operation'],
    dispatchSecret: DISPATCH_SECRET, ledger: bridge, transport: double.transport, ...extra,
  });
  const world = (runner) => ({ store, worker: 'bridge-w', runners: createRunnerRegistry([runner], { defaultKind: runner.kind }) });
  const handlerDeps = (extra = {}) => ({ environment: 'test', callbackSecret: CALLBACK_SECRET, bridge, scheduler: store, ...extra });

  async function run(t, { mode = 'live' } = {}) {
    return mustOk(await createAutomationRun(store, {
      tenantId: t.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await t.snapshot(), runMode: mode,
      correlationId: crypto.randomUUID(), idempotencyKey: key('run'), runnerKind: 'n8n',
    }), 'create run').run;
  }
  async function connection(t) {
    const { rows: [c] } = await db.query(
      `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status)
       values ($1, $2, 1, 'api_key', 'verified') returning id`, [t.tenantId, `c_${counter++}_b`]);
    return c.id;
  }
  async function send(t, r, payload = { template: 'followup_1', to_ref: 'contact:42' }) {
    return mustOk(await scheduleAutomationAction(store, {
      tenantId: t.tenantId, runId: r.id, actionType: 'send_message', runAt: past(), idempotencyKey: key('send'),
      connectionId: await connection(t), payload,
    }), 'schedule').action;
  }
  /** a signed request, exactly as the shared workflow sends one. */
  async function signed(body, { purpose = 'callback', secret = CALLBACK_SECRET, timestamp = nowSeconds(), nonce = crypto.randomUUID() } = {}) {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: await signBridgeRequest(rawBody, secret, { purpose, timestamp, nonce }) };
  }
  const envelopeAsk = (d, o = {}) => ({ contract_version: 1, job_id: d.job_id, action_id: d.action_id, tenant_id: d.tenant_id, nonce: d.nonce, ...o });
  const callbackFor = (d, o = {}) => ({
    contract_version: 1, job_id: d.job_id, action_id: d.action_id, tenant_id: d.tenant_id, arc_attempt: d.attempt,
    n8n_execution_id: `exec-cb-${d.job_id.slice(0, 8)}`, runner_key: d.runner_key, workflow_version: d.workflow_version,
    status: 'succeeded', provider_refs: ['SM0001'], safe_output_meta: { segments: 1 }, error_category: null, retryable: false,
    completed_at: new Date().toISOString(), correlation_id: d.correlation_id, idempotency_key: d.idempotency_key, ...o,
  });
  const envelope = async (d, o = {}, opts = {}) => handleEnvelopeRequest(handlerDeps(), await signed(envelopeAsk(d, o), { purpose: 'envelope', ...opts }));
  const callback = async (d, o = {}, opts = {}) => handleCallback(handlerDeps(), await signed(callbackFor(d, o), opts));

  const row = async (id) => (await db.query('select * from scheduled_actions where id = $1', [id])).rows[0];
  const runRow = async (id) => (await db.query('select * from automation_runs where id = $1', [id])).rows[0];
  const attempts = async (id) => (await db.query('select * from automation_action_attempts where action_id = $1 order by attempt_no', [id])).rows;
  const dispatchRow = async (attemptId) => (await db.query('select * from runner_dispatches where attempt_id = $1', [attemptId])).rows[0];
  const logFor = async (attemptId) => (await db.query('select * from runner_bridge_log where attempt_id = $1 order by id', [attemptId])).rows;
  const makeDue = (id) => db.query(`update scheduled_actions set run_at = now() - interval '1 second' where id = $1`, [id]);

  /** dispatch one send_message through the orchestrator and return what n8n received. */
  async function dispatched(t, { double = n8nDouble(), payload } = {}) {
    const r = await run(t);
    const action = await send(t, r, payload);
    const reports = mustOk(await executeDueActions(world(n8nRunner(double)), { tenantId: t.tenantId, limit: 5 }), 'execute');
    const report = reports.find((x) => x.actionId === action.id);
    return { r, action, report, d: double.dispatches.at(-1), double };
  }

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    const client = restClient(db);
    store = supabaseSchedulerStore(client);
    bridge = supabaseBridgeStore(client);
    a = await tenant(db, operator);
    await a.live();
    b = await tenant(db, operator);
    await b.live();
    // ARC-230: nothing dispatches without an assignment, and Lead Recovery v1 forbids n8n.
    await permitN8n(db);
    await wireWorkflows(supabaseWorkflowStore(client), operator, [
      await handlerEntry(),
      await actionEntry(ROUTE.runnerKey, ['send_message'], { required_capabilities: ['send_sms'] }),
      await actionEntry('arc-provider-op-v1', ['call_provider_operation']),
    ]);
  });

  test('end to end: a reference is dispatched, the envelope is fetched once, the callback settles the action and closes the run', async () => {
    const { r, action, report, d } = await dispatched(a);
    assert.deepEqual([report.outcome, report.code, report.actionStatus, report.dispatched], ['accepted', 'awaiting_callback', 'running', true]);
    assert.equal((await row(action.id)).status, 'running', 'the attempt waits under its lease');

    /* what left ARC: identifiers only. */
    assert.equal(d.payload, undefined);
    assert.doesNotMatch(JSON.stringify(d), /contact:42|followup_1/);
    assert.equal(d.idempotency_key, action.idempotencyKey);
    assert.equal(d.config_refs.config_snapshot_id, r.configSnapshotId);
    const ledgered = await dispatchRow(d.job_id);
    assert.deepEqual([ledgered.nonce, ledgered.runner_key, ledgered.workflow_version, ledgered.tenant_id], [d.nonce, ROUTE.runnerKey, '1.0.0', a.tenantId]);
    assert.match(ledgered.runner_execution_id, /^exec-/, 'the execution is correlated');

    /* the envelope: once, and it carries the payload and references — never a credential. */
    const opened = await envelope(d);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.deepEqual(opened.body.envelope.payload, { template: 'followup_1', to_ref: 'contact:42' });
    assert.equal(opened.body.envelope.config_refs.config_snapshot_id, r.configSnapshotId);
    assert.equal(opened.body.envelope.effect_class, 'external_effect');
    assert.equal(findSecretShaped(opened.body), null);
    const again = await envelope(d);
    assert.deepEqual([again.status, again.body.error], [409, 'envelope_already_opened']);

    /* the callback settles it. */
    const cb = await callback(d, { elapsed_ms: 640 });
    assert.deepEqual([cb.status, cb.body.disposition, cb.body.action_status, cb.body.run_status], [200, 'applied', 'done', 'completed']);
    const [attempt] = await attempts(action.id);
    assert.deepEqual([attempt.status, attempt.runner_kind, attempt.external_request_id], ['succeeded', 'n8n', 'SM0001']);
    assert.equal(attempt.evidence.workflow_version, '1.0.0');
    assert.equal(attempt.evidence.elapsed_ms, 640);
    assert.equal((await runRow(r.id)).terminal_code, 'actions_settled');

    /* a repeat changes nothing. */
    const dup = await callback(d, { elapsed_ms: 640 });
    assert.deepEqual([dup.status, dup.body.disposition], [200, 'duplicate']);
    assert.equal((await attempts(action.id)).length, 1);
    const log = await logFor(d.job_id);
    assert.ok(log.some((x) => x.code === 'envelope_already_opened' && x.alert), 'a second fetch is flagged');
  });

  test('a replayed request is refused and flagged; a bad, missing or stale signature is refused before parsing', async () => {
    const { d } = await dispatched(a);
    // a token for one route is no good at another, even untouched and in time.
    const misrouted = await handleEnvelopeRequest(handlerDeps(), await signed(envelopeAsk(d), { purpose: 'callback' }));
    assert.deepEqual([misrouted.status, misrouted.body.error], [401, 'wrong_purpose']);
    const request = await signed(envelopeAsk(d), { purpose: 'envelope' });
    assert.equal((await handleEnvelopeRequest(handlerDeps(), request)).status, 200);
    const replay = await handleEnvelopeRequest(handlerDeps(), request);
    assert.deepEqual([replay.status, replay.body.error], [409, 'replayed']);

    for (const [opts, code] of [[{ secret: OTHER_SECRET }, 'invalid_signature'], [{ timestamp: nowSeconds() - 600 }, 'stale_signature']]) {
      const out = await handleCallback(handlerDeps(), await signed(callbackFor(d), opts));
      assert.deepEqual([out.status, out.body.error], [401, code]);
    }
    const unsigned = await handleCallback(handlerDeps(), { rawBody: JSON.stringify(callbackFor(d)), headers: {} });
    assert.deepEqual([unsigned.status, unsigned.body.error], [401, 'missing_signature']);
    const garbage = await handleCallback(handlerDeps(), await (async () => {
      const rawBody = '{not json';
      return { rawBody, headers: await signBridgeRequest(rawBody, CALLBACK_SECRET, { purpose: 'callback', timestamp: nowSeconds(), nonce: crypto.randomUUID() }) };
    })());
    assert.equal(garbage.status, 400);
    assert.equal((await attempts(d.action_id))[0].status, 'running', 'none of it touched the attempt');
    const { rows } = await db.query(`select code, alert from runner_bridge_log where code in ('replayed', 'invalid_signature', 'stale_signature') and tenant_id is null`);
    assert.ok(rows.some((x) => x.code === 'replayed' && x.alert));
    await envelope(d).catch(() => {});
    await callback(d);
  });

  test('another tenant\'s job is a security event: refused, and logged against the tenant ARC knows', async () => {
    const { d } = await dispatched(a);
    const out = await callback(d, { tenant_id: b.tenantId });
    assert.deepEqual([out.status, out.body.error], [403, 'tenant_mismatch']);
    const ask = await envelope(d, { tenant_id: b.tenantId });
    assert.deepEqual([ask.status, ask.body.error], [403, 'tenant_mismatch']);
    const log = await logFor(d.job_id);
    assert.ok(log.filter((x) => x.code === 'tenant_mismatch').every((x) => x.alert && x.tenant_id === a.tenantId));
    assert.equal((await attempts(d.action_id))[0].status, 'running');
    assert.equal((await dispatchRow(d.job_id)).callback, null, 'nothing was recorded from it');
    await callback(d);
  });

  test('an unknown job is 404 and creates nothing; a version ARC did not dispatch is refused and flagged', async () => {
    const before = (await db.query('select count(*)::int as n from runner_dispatches')).rows[0].n;
    const { d } = await dispatched(a);
    const ghost = await callback({ ...d, job_id: crypto.randomUUID() });
    assert.deepEqual([ghost.status, ghost.body.error], [404, 'unknown_job']);
    assert.equal((await db.query('select count(*)::int as n from runner_dispatches')).rows[0].n, before + 1);

    const rolledBack = await callback(d, { workflow_version: '0.9.0' });
    assert.deepEqual([rolledBack.status, rolledBack.body.error], [409, 'version_mismatch']);
    const wrongAttempt = await callback(d, { arc_attempt: 2 });
    assert.deepEqual([wrongAttempt.status, wrongAttempt.body.error], [409, 'attempt_mismatch']);
    assert.ok((await logFor(d.job_id)).some((x) => x.code === 'version_mismatch' && x.alert));
    await callback(d);
  });

  test('a retryable failure goes back on the queue; the next attempt is a new dispatch with a new nonce and the same key', async () => {
    const double = n8nDouble();
    const { action, d } = await dispatched(a, { double });
    const out = await callback(d, { status: 'failed', error_category: 'provider_rate_limited', retryable: true, provider_refs: [] });
    assert.deepEqual([out.body.disposition, out.body.action_status], ['applied', 'pending']);

    await makeDue(action.id);
    mustOk(await executeDueActions(world(n8nRunner(double)), { tenantId: a.tenantId }), 'execute again');
    const [first, second] = double.dispatches.slice(-2);
    assert.equal(first.job_id, d.job_id);
    assert.notEqual(second.job_id, first.job_id);
    assert.notEqual(second.nonce, first.nonce);
    assert.equal(second.idempotency_key, first.idempotency_key);
    assert.equal(second.attempt, 2);
    const done = await callback(second);
    assert.equal(done.body.action_status, 'done');
  });

  test('an ambiguous callback blocks the action for a person, and nothing resends it', async () => {
    const double = n8nDouble();
    const { action, d } = await dispatched(a, { double });
    const out = await callback(d, { status: 'ambiguous', error_category: 'provider_timeout', provider_refs: [] });
    assert.deepEqual([out.body.outcome, out.body.action_status], ['ambiguous', 'blocked']);
    await makeDue(action.id);
    const count = double.dispatches.length;
    mustOk(await executeDueActions(world(n8nRunner(double)), { tenantId: a.tenantId }), 'execute');
    assert.equal(double.dispatches.length, count, 'no second dispatch');
    assert.equal((await row(action.id)).gate_code, 'ambiguous_outcome');
  });

  test('conflicting callbacks: the first terminal status wins and the contradiction is flagged', async () => {
    const { action, d } = await dispatched(a);
    assert.equal((await callback(d)).body.disposition, 'applied');
    const other = await callback(d, { status: 'failed', error_category: 'provider_error', provider_refs: [] });
    assert.deepEqual([other.status, other.body.disposition], [200, 'conflict']);
    assert.equal((await row(action.id)).status, 'done');
    assert.ok((await logFor(d.job_id)).some((x) => x.disposition === 'conflict' && x.alert));
  });

  test('no callback before the lease expires: the effect is ambiguous; a late callback is kept as evidence and changes nothing', async () => {
    const { action, d } = await dispatched(a);
    await db.query(`update scheduled_actions set lease_expires_at = now() - interval '1 second' where id = $1`, [action.id]);
    mustOk(await executeDueActions(world(new FakeTestRunner({ environment: 'test' })), { tenantId: a.tenantId }), 'the sweep');
    const [attempt] = await attempts(action.id);
    assert.deepEqual([attempt.status, attempt.error_code], ['ambiguous', 'lease_expired_mid_effect']);

    const late = await callback(d);
    assert.deepEqual([late.status, late.body.disposition], [200, 'late']);
    assert.equal((await row(action.id)).status, 'blocked', 'still a person\'s decision');
    assert.equal((await dispatchRow(d.job_id)).callback.status, 'succeeded', 'the late report is kept as evidence');
  });

  test('a module paused after dispatch: the envelope is refused, the dispatch voided, and the attempt safely put back', async () => {
    const c = await tenant(db, operator);
    await c.live();
    const { action, d } = await dispatched(c);
    await c.pause();
    const out = await envelope(d);
    assert.deepEqual([out.status, out.body.error], [409, 'gate_refused']);
    const voided = await dispatchRow(d.job_id);
    assert.deepEqual([voided.void_reason, voided.envelope_opened_at], ['gate_refused', null]);
    const [attempt] = await attempts(action.id);
    assert.deepEqual([attempt.status, attempt.error_code, attempt.retryable], ['failed', 'envelope_refused', true]);
    assert.equal((await row(action.id)).status, 'pending', 'held by the scheduler, not blocked for a person');
    const retry = await envelope(d);
    assert.deepEqual([retry.status, retry.body.error], [410, 'dispatch_void']);
  });

  test('an expired dispatch never opens, and its attempt is put back for a fresh one', async () => {
    const { action, d } = await dispatched(a);
    await db.query('alter table runner_dispatches disable trigger runner_dispatches_guard');
    await db.query(`update runner_dispatches set issued_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where attempt_id = $1`, [d.job_id]);
    await db.query('alter table runner_dispatches enable trigger runner_dispatches_guard');
    const out = await envelope(d);
    assert.deepEqual([out.status, out.body.error], [410, 'dispatch_expired']);
    assert.equal((await row(action.id)).status, 'pending');
    assert.equal((await attempts(action.id))[0].error_code, 'dispatch_expired');
  });

  test('n8n refusing the dispatch fails the attempt without an effect; n8n down with the envelope unopened is retried', async () => {
    const refusing = await dispatched(a, { double: n8nDouble({ answer: { status: 401, body: null } }) });
    assert.deepEqual([refusing.report.outcome, refusing.report.actionStatus], ['failed', 'failed']);
    assert.equal((await attempts(refusing.action.id))[0].error_code, 'dispatch_unauthorized');
    assert.equal((await dispatchRow((await attempts(refusing.action.id))[0].id)).void_reason, 'dispatch_unauthorized');

    const down = await dispatched(a, { double: n8nDouble({ answer: { status: 503, body: null } }) });
    assert.deepEqual([down.report.outcome, down.report.actionStatus], ['failed', 'pending']);
    const [attempt] = await attempts(down.action.id);
    assert.deepEqual([attempt.error_code, attempt.retryable], ['dispatch_server_error', true]);
    assert.equal((await dispatchRow(attempt.id)).void_reason, 'dispatch_server_error', 'voided before its envelope opened');
  });

  test('a callback carrying anything shaped like a credential is refused and never stored', async () => {
    const { d } = await dispatched(a);
    const out = await callback(d, { safe_output_meta: { response: { access_token: 'x' } } });
    assert.deepEqual([out.status, out.body.error], [400, 'secret_in_callback']);
    assert.equal((await dispatchRow(d.job_id)).callback, null);
    await callback(d);
  });

  test('FakeTestRunner still runs the same scheduler, untouched by the bridge', async () => {
    const r = await run(a);
    const { action } = { action: mustOk(await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r.id, actionType: 'remind_operator', runAt: past(), idempotencyKey: key('remind') }), 'schedule').action };
    const fake = new FakeTestRunner({ environment: 'test', kind: 'n8n' });
    const [report] = mustOk(await executeDueActions(world(fake), { tenantId: a.tenantId }), 'execute');
    assert.deepEqual([report.actionId, report.actionStatus], [action.id, 'done']);
    assert.equal(await dispatchRow((await attempts(action.id))[0].id), undefined, 'no dispatch row for a runner that is not the bridge');
  });

  /* ── 0018 ── */

  test('the ledger\'s history is fixed: identity never moves, answers are written once, the log is append-only', async () => {
    const { d } = await dispatched(a);
    assert.match(await refused(db, `update runner_dispatches set nonce = gen_random_uuid() where attempt_id = $1`, [d.job_id]), /identity is fixed/);
    assert.match(await refused(db, `update runner_dispatches set runner_execution_id = 'other' where attempt_id = $1`, [d.job_id]), /written once/);
    assert.match(await refused(db, `delete from runner_dispatches where attempt_id = $1`, [d.job_id]), /never deleted/);
    assert.match(await refused(db, `update runner_bridge_log set alert = true where attempt_id = $1`, [d.job_id]), /append/);
    assert.match(await refused(db, `delete from runner_bridge_log where attempt_id = $1`, [d.job_id]), /append/);
    await callback(d);
  });

  test('no browser role reads the bridge or calls its functions; an operator reads it', async () => {
    const member = await newMember(db, a.tenantId);
    await asRole(db, { role: 'authenticated', sub: member }, async (tx) => {
      for (const table of ['runner_dispatches', 'runner_nonces', 'runner_bridge_log']) {
        assert.equal((await tx.query(`select * from ${table}`)).rows.length, 0, table);
      }
      await assert.rejects(tx.query(`select public.claim_runner_nonce('nonce-bbbbbbbbbbbbbbbb', 'callback', 600)`), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      assert.ok((await tx.query('select * from runner_dispatches')).rows.length > 0);
    });
  });

  test('0018 as written: every function revoked from browser roles, no write policy, forward-only', () => {
    const defined = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    assert.ok(defined.length >= 9);
    for (const name of new Set(defined)) assert.match(SQL, new RegExp(`revoke all on function public\\.${name}\\(`), name);
    assert.doesNotMatch(SQL, /create policy [a-z_]+ on public\.[a-z_]+\s+for (insert|update|delete|all)/i);
    assert.doesNotMatch(SQL, /grant [^;]* to (anon|authenticated|public)\b/i);
    assert.doesNotMatch(SQL, /\bdrop table\b|\bdrop column\b|\btruncate\b/i);
    for (const table of ['runner_dispatches', 'runner_nonces', 'runner_bridge_log']) {
      assert.match(SQL, new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    }
  });
});
