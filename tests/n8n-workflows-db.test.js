/* ARC-240 — the shared workflows, run end to end against real Postgres.
 *
 * The orchestrator claims and starts an action; `N8nRunner` resolves ARC's assignment and
 * dispatches it; `n8n-sim.js` runs the reference action workflow's own export (and, when it
 * fails, the shared error handler's), reaching ARC only through the real inbound handlers.
 * What each test checks is ARC's rows. No real n8n, provider or network is reached.
 *
 * Like the ARC-220 and ARC-230 suites, this one relaxes Lead Recovery v1's n8n posture in its
 * own throwaway database (`permitN8n`) — the only module that can hold a run today forbids
 * n8n, and `workflow-manifest-db` proves that refusal on the real posture.
 *
 * Without PGlite the suite is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { asRole, freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newOperator, tenant } from './scheduler-fixtures.js';
import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { createAutomationRun, scheduleAutomationAction } from '../supabase/functions/_shared/scheduler/service.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { executeDueActions } from '../supabase/functions/_shared/runner/orchestrator.ts';
import { N8nRunner } from '../supabase/functions/_shared/n8n-runner/runner.ts';
import { workflowChecksum } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { supabaseWorkflowStore } from '../supabase/functions/_shared/n8n-runner/workflows.ts';
import { supabaseBridgeStore } from '../supabase/functions/_shared/n8n-runner/supabase-bridge-store.ts';
import { handleCallback, handleEnvelopeRequest, handleFailureReport } from '../supabase/functions/_shared/n8n-runner/inbound.ts';
import { signBridgeRequest } from '../supabase/functions/_shared/n8n-runner/signing.ts';
import { HANDLER, permitN8n, wireWorkflows } from './workflow-fixtures.js';
import { createN8n, ERROR_HANDLER, loadExport, REFERENCE_ACTION } from './n8n-sim.js';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;
const SQL = readFileSync(new URL('../supabase/migrations/0020_runner_failure_reports.sql', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../n8n/manifest.json', import.meta.url), 'utf8'));

const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'tests', 'only', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'tests', 'only', 'y'.repeat(12)].join('-'));
const BRIDGE = 'https://arc-db.invalid/functions/v1/runner-bridge';
const REFERENCE = { runner_key: 'arc-reference-action', workflow_version: '1.0.0' };

let counter = 0;
let executionBase = 1000;
const key = (label) => `${label}:${crypto.randomUUID()}`;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe('ARC-240: the shared workflows against real Postgres', { skip }, () => {
  let db;
  let store;
  let bridge;
  let a;
  let ids;
  let referenceChecksum;

  const mustOk = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };
  const deps = () => ({ environment: 'test', callbackSecret: CALLBACK_SECRET, bridge, scheduler: store });

  /** n8n, holding the repository's error handler and the reference workflow, reaching ARC's real handlers. */
  function n8nWorld({ dropCallback = false } = {}) {
    const n8n = createN8n({
      credentials: { 'ARC dispatch': DISPATCH_SECRET.reveal(), 'ARC bridge signing': CALLBACK_SECRET.reveal() },
      bridgeUrl: BRIDGE,
      firstExecutionId: (executionBase += 1000),
      http: async (url, { headers, body }) => {
        const route = url.slice(BRIDGE.length + 1);
        if (route === 'callback' && dropCallback) throw new Error('read ECONNRESET');
        const input = { rawBody: body, headers: { authorization: headers.authorization } };
        const out = route === 'envelope' ? await handleEnvelopeRequest(deps(), input)
          : route === 'callback' ? await handleCallback(deps(), input)
          : await handleFailureReport(deps(), input);
        return { status: out.status, text: JSON.stringify(out.body) };
      },
    });
    n8n.deploy(loadExport(ERROR_HANDLER), ids.handler);
    n8n.deploy(loadExport(REFERENCE_ACTION), ids.action, { errorWorkflow: ids.handler });
    return n8n;
  }

  const runner = (n8n) => new N8nRunner({
    environment: 'test', actionTypes: ['send_message'], dispatchSecret: DISPATCH_SECRET, ledger: bridge,
    transport: async (request) => n8n.webhook(request.url, { headers: request.headers, body: request.body }),
  });

  async function connection(t) {
    const { rows: [c] } = await db.query(
      `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status)
       values ($1, $2, 1, 'api_key', 'verified') returning id`, [t.tenantId, `c_${counter++}_w`]);
    return c.id;
  }

  /** one send_message, dispatched through the orchestrator to the simulated n8n, which then runs to the end. */
  async function runOnce(n8n, payload = { template: 'followup_1', to_ref: 'contact:42' }) {
    const r = mustOk(await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: key('run'), runnerKind: 'n8n',
    }), 'create run').run;
    const action = mustOk(await scheduleAutomationAction(store, {
      tenantId: a.tenantId, runId: r.id, actionType: 'send_message', runAt: past(), idempotencyKey: key('send'),
      connectionId: await connection(a), payload,
    }), 'schedule').action;
    const reports = mustOk(await executeDueActions({ store, worker: 'w240', runners: createRunnerRegistry([runner(n8n)], { defaultKind: 'n8n' }) },
      { tenantId: a.tenantId, limit: 5 }), 'execute');
    const report = reports.find((x) => x.actionId === action.id);
    await n8n.drain();
    return { r, action, report };
  }

  const actionRow = async (id) => (await db.query('select * from scheduled_actions where id = $1', [id])).rows[0];
  const attempt = async (actionId) => (await db.query('select * from automation_action_attempts where action_id = $1 order by attempt_no desc limit 1', [actionId])).rows[0];
  const dispatchRow = async (attemptId) => (await db.query('select * from runner_dispatches where attempt_id = $1', [attemptId])).rows[0];
  const logFor = async (attemptId) => (await db.query('select * from runner_bridge_log where attempt_id = $1 order by id', [attemptId])).rows;

  before(async () => {
    db = await freshDatabase();
    const operator = await newOperator(db);
    const client = restClient(db);
    store = supabaseSchedulerStore(client);
    bridge = supabaseBridgeStore(client);
    a = await tenant(db, operator);
    await a.live();
    await permitN8n(db);

    /* the repository's own error handler entry, and the reference fixture as an action workflow. */
    const handler = MANIFEST.workflows.find((e) => e.runner_key === HANDLER.runner_key);
    referenceChecksum = await workflowChecksum(loadExport(REFERENCE_ACTION));
    const reference = {
      ...REFERENCE, role: 'action', display_name: 'Reference action (test fixture)', module_key: 'lead_recovery', module_versions: [1],
      action_types: ['send_message'], runner_kind: 'n8n', export_path: 'workflows/arc-reference-action@1.0.0.json', checksum: referenceChecksum,
      input_contract_version: 1, output_contract_version: 1, effect_class: 'external_effect', required_capabilities: [], auto_retry: true,
      timeout_ambiguous: true, error_handler: { ...HANDLER },
    };
    const wired = await wireWorkflows(supabaseWorkflowStore(client), operator, [handler, reference]);
    ids = { handler: wired.n8nIds[`${HANDLER.runner_key}@${HANDLER.workflow_version}`], action: wired.n8nIds[`${REFERENCE.runner_key}@${REFERENCE.workflow_version}`] };
  });

  test('end to end: dispatched, answered with its execution id, envelope opened, callback applied — attributed to the reviewed workflow', async () => {
    const n8n = n8nWorld();
    const { r, action, report } = await runOnce(n8n);
    assert.deepEqual([report.outcome, report.code], ['accepted', 'awaiting_callback']);
    const done = await attempt(action.id);
    assert.deepEqual([done.status, done.external_request_id], ['succeeded', `reference:${done.id}`]);
    assert.equal((await actionRow(action.id)).status, 'done');
    assert.equal((await db.query('select status from automation_runs where id = $1', [r.id])).rows[0].status, 'completed');
    const d = await dispatchRow(done.id);
    assert.deepEqual([d.runner_key, d.workflow_checksum, d.error_handler_key], [REFERENCE.runner_key, referenceChecksum, HANDLER.runner_key]);
    assert.equal(d.runner_execution_id, n8n.executions.find((e) => e.workflowId === ids.action).id);
    assert.ok(d.envelope_opened_at && d.callback.status === 'succeeded');
    const codes = (await logFor(done.id)).map((x) => x.code);
    assert.ok(codes.includes('envelope_opened') && codes.includes('outcome_succeeded'), codes.join(', '));
    assert.ok(!codes.some((c) => /rejected|conflict|replayed/.test(c)), codes.join(', '));
  });

  test('a provider that refused (rate limit): the error handler reports it, and ARC retries — nothing happened', async () => {
    const { action } = await runOnce(n8nWorld(), { reference_outcome: 'fail:provider_rate_limited' });
    const failed = await attempt(action.id);
    assert.deepEqual([failed.status, failed.error_code], ['failed', 'provider_rate_limited']);
    assert.equal((await actionRow(action.id)).status, 'pending', 'retried under the type\'s backoff');
    const d = await dispatchRow(failed.id);
    assert.deepEqual([d.callback.status, d.callback.retryable, d.callback.safe_output_meta.reported_by], ['failed', true, 'error_handler']);
    assert.ok((await logFor(failed.id)).some((x) => x.direction === 'failure' && x.code === 'outcome_failed'));
  });

  test('an action the workflow cannot do fails for good; a crash after the envelope opened is ambiguous and blocks', async () => {
    const unsupported = await runOnce(n8nWorld(), { reference_outcome: 'fail:unsupported_capability' });
    assert.deepEqual([(await attempt(unsupported.action.id)).status, (await actionRow(unsupported.action.id)).status], ['failed', 'failed']);

    const crash = await runOnce(n8nWorld(), { reference_outcome: 'crash' });
    const ambiguous = await attempt(crash.action.id);
    assert.deepEqual([ambiguous.status, ambiguous.error_code], ['ambiguous', 'unexpected_exception']);
    assert.equal((await actionRow(crash.action.id)).status, 'blocked', 'an operator reconciles it — it is never retried blind');
  });

  test('a callback that never arrived, after the module step, is ambiguous — never a failure, never a retry', async () => {
    const { action } = await runOnce(n8nWorld({ dropCallback: true }));
    const lost = await attempt(action.id);
    assert.deepEqual([lost.status, lost.error_code], ['ambiguous', 'ambiguous_result']);
    assert.equal((await dispatchRow(lost.id)).callback.safe_output_meta.failed_node, 'Send callback');
  });

  test('a failure reported after the workflow already reported success is a conflict: the first report stands', async () => {
    const n8n = n8nWorld();
    const { action } = await runOnce(n8n);
    const succeeded = await attempt(action.id);
    const execution = n8n.executions.find((e) => e.workflowId === ids.action && e.status === 'success');
    await n8n.start(ids.handler, [{ json: {
      execution: { id: execution.id, error: { message: 'late crash', node: { name: 'Perform action' } }, lastNodeExecuted: 'Perform action', mode: 'webhook' },
      workflow: { id: ids.action, name: 'arc-reference-action@1.0.0' },
    } }]);
    assert.equal((await attempt(action.id)).status, 'succeeded');
    assert.ok((await logFor(succeeded.id)).some((x) => x.code === 'callback_conflict' && x.alert));
  });

  /* ── a report ARC cannot place is refused, by ARC's rows ── */

  async function report(o = {}) {
    const body = JSON.stringify({
      contract_version: 1, n8n_execution_id: 'unknown-1', n8n_workflow_id: ids.action, error_category: 'provider_timeout', failed_node: null,
      http_status: null, reported_at: new Date().toISOString(), handler: { ...HANDLER }, ...o,
    });
    const headers = await signBridgeRequest(body, CALLBACK_SECRET, { purpose: 'failure', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() });
    return handleFailureReport(deps(), { rawBody: body, headers });
  }

  test('an execution ARC never correlated is 404; the wrong workflow is a security event; another handler is refused', async () => {
    const n8n = n8nWorld();
    const { action } = await runOnce(n8n);
    const execution = (await dispatchRow((await attempt(action.id)).id)).runner_execution_id;

    const ghost = await report();
    assert.deepEqual([ghost.status, ghost.body.error], [404, 'unknown_execution']);
    const foreign = await report({ n8n_execution_id: execution, n8n_workflow_id: 'wf-somebody-else' });
    assert.deepEqual([foreign.status, foreign.body.error], [403, 'workflow_mismatch']);
    const rolledBack = await report({ n8n_execution_id: execution, handler: { ...HANDLER, workflow_version: '0.9.0' } });
    assert.deepEqual([rolledBack.status, rolledBack.body.error], [409, 'handler_mismatch']);
    const { rows } = await db.query(`select code, alert from runner_bridge_log where direction = 'failure' and code in ('workflow_mismatch', 'handler_mismatch')`);
    assert.ok(rows.length >= 2 && rows.every((x) => x.alert));
    assert.equal((await attempt(action.id)).status, 'succeeded', 'none of them touched the attempt');
  });

  test('a failure token is for the failure route only, and is used once', async () => {
    const body = JSON.stringify({ contract_version: 1 });
    const asCallback = await signBridgeRequest(body, CALLBACK_SECRET, { purpose: 'callback', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() });
    assert.deepEqual((await handleFailureReport(deps(), { rawBody: body, headers: asCallback })).body, { error: 'wrong_purpose' });
    const once = await signBridgeRequest(body, CALLBACK_SECRET, { purpose: 'failure', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() });
    assert.equal((await handleFailureReport(deps(), { rawBody: body, headers: once })).status, 400, 'a malformed report, read once');
    assert.deepEqual((await handleFailureReport(deps(), { rawBody: body, headers: once })).body, { error: 'replayed' });
  });

  test('a module paused before n8n fetched the envelope: ARC settles the attempt itself, and the handler\'s later report changes nothing', async () => {
    const n8n = n8nWorld();
    const r = mustOk(await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: key('run'), runnerKind: 'n8n',
    }), 'create run').run;
    const action = mustOk(await scheduleAutomationAction(store, {
      tenantId: a.tenantId, runId: r.id, actionType: 'send_message', runAt: past(), idempotencyKey: key('send'), connectionId: await connection(a), payload: {},
    }), 'schedule').action;
    mustOk(await executeDueActions({ store, worker: 'w240', runners: createRunnerRegistry([runner(n8n)], { defaultKind: 'n8n' }) }, { tenantId: a.tenantId, limit: 5 }), 'execute');
    await a.pause();
    try {
      await n8n.drain();
      const refused = await attempt(action.id);
      assert.deepEqual([refused.status, refused.error_code], ['failed', 'envelope_refused'], 'nothing could have happened: the envelope never opened');
      const d = await dispatchRow(refused.id);
      assert.equal(d.envelope_opened_at, null);
      assert.ok((await logFor(refused.id)).some((x) => x.direction === 'failure' && x.code === 'callback_after_settlement'), 'the report is evidence only');
    } finally {
      await a.resume();
    }
  });

  test('no browser role may resolve a failure', async () => {
    for (const role of [{ role: 'anon' }, { role: 'authenticated', sub: crypto.randomUUID() }]) {
      await asRole(db, role, async (tx) => {
        await assert.rejects(tx.query(`select * from resolve_runner_failure('1', 'x', 'y', 'z')`), /permission denied/);
      });
    }
  });

  test('0020 as written: its function revoked from browser roles, nothing dropped but the two checks it widens', () => {
    const code = SQL.replace(/--[^\n]*/g, '');  // the rollback notes in the header are not the migration
    const defined = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    assert.deepEqual(defined, ['resolve_runner_failure']);
    assert.match(code, /revoke all on function public\.resolve_runner_failure\(/);
    assert.doesNotMatch(code, /grant [^;]* to (anon|authenticated|public)\b/i);
    assert.doesNotMatch(code, /\bdrop table\b|\bdrop column\b|\bdrop function\b|\bdrop index\b|\btruncate\b|\bdelete from\b|\bupdate public\./i);
    assert.deepEqual([...code.matchAll(/drop constraint if exists ([a-z_]+)/g)].map((m) => m[1]), ['runner_nonces_purpose_check', 'runner_bridge_log_direction_check']);
  });
});
