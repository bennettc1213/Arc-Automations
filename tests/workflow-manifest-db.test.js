/* ARC-230 — workflow versions, deployments, assignments and dispatch attribution, against
 * real Postgres (0019 over 0012's registry and 0017/0018's queue and bridge).
 *
 * Two databases. The first keeps Lead Recovery v1 exactly as registered — direct, n8n
 * prohibited — and proves nothing can assign it a workflow. The second relaxes that row
 * (`permitN8n`, the only module that can hold a run today) so the rest can be exercised.
 * No real n8n is reached: the double is a function and every URL is on `.invalid`.
 *
 * Without PGlite the suites are reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { asRole, freshDatabase, loadPglite, refused, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newMember, newOperator, tenant } from './scheduler-fixtures.js';
import { actionEntry, exportOf, handlerEntry, permitN8n, wireWorkflows } from './workflow-fixtures.js';
import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { createAutomationRun, scheduleAutomationAction } from '../supabase/functions/_shared/scheduler/service.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { executeDueActions } from '../supabase/functions/_shared/runner/orchestrator.ts';
import { N8nRunner } from '../supabase/functions/_shared/n8n-runner/runner.ts';
import { supabaseBridgeStore } from '../supabase/functions/_shared/n8n-runner/supabase-bridge-store.ts';
import { handleCallback } from '../supabase/functions/_shared/n8n-runner/inbound.ts';
import { signBridgeRequest } from '../supabase/functions/_shared/n8n-runner/signing.ts';
import { checkWorkflowSync } from '../supabase/functions/_shared/n8n-runner/sync.ts';
import {
  assignWorkflow, registerDeployment, registerManifest, retireAssignment, setWorkflowStatus, supabaseWorkflowStore,
} from '../supabase/functions/_shared/n8n-runner/workflows.ts';

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;
const SQL = readFileSync(new URL('../supabase/migrations/0019_workflow_manifest.sql', import.meta.url), 'utf8');

const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'tests', 'only', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'tests', 'only', 'y'.repeat(12)].join('-'));

const must = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };
const key = (label) => `${label}:${crypto.randomUUID()}`;
const past = () => new Date(Date.now() - 60_000).toISOString();

describe('ARC-230: a module that forbids n8n, as registered', { skip }, () => {
  let db;
  let operator;
  let workflows;

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    workflows = supabaseWorkflowStore(restClient(db));
  });

  test('Lead Recovery v1 — direct, n8n prohibited — is never assigned a workflow, and nothing resolves for it', async () => {
    const entries = [await handlerEntry(), await actionEntry('arc-send-message-v1', ['send_message'])];
    must(await registerManifest(workflows, { manifest_version: 1, workflows: entries }, operator), 'register');
    for (const e of entries) must(await setWorkflowStatus(workflows, { actorId: operator, runnerKey: e.runner_key, workflowVersion: e.workflow_version, status: 'approved' }), 'approve');
    const out = await assignWorkflow(workflows, { actorId: operator, moduleKey: 'lead_recovery', moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0' });
    assert.equal(out.code, 'n8n_prohibited');
    const { rows: [route] } = await db.query(`select * from public.resolve_runner_workflow('lead_recovery', 1, 'send_message', 'test')`);
    assert.equal(route.code, 'n8n_prohibited');
    const { rows: [registered] } = await db.query(`select n8n_posture, execution_mode from registry_module_versions where module_key = 'lead_recovery' and version = 1`);
    assert.deepEqual([registered.n8n_posture, registered.execution_mode], ['prohibited', 'direct'], 'the registry itself is untouched');
  });
});

describe('ARC-230 against real Postgres', { skip }, () => {
  let db;
  let operator;
  let client;
  let workflows;
  let store;
  let bridge;
  let a;

  const double = () => {
    const dispatches = [];
    return { dispatches, transport: async (r) => { dispatches.push({ url: r.url, body: JSON.parse(r.body) }); return { status: 202, body: { n8n_execution_id: `exec-${dispatches.length}` } }; } };
  };
  const runner = (d) => new N8nRunner({ environment: 'test', actionTypes: ['send_message', 'remind_operator'], dispatchSecret: DISPATCH_SECRET, ledger: bridge, transport: d.transport });
  const execute = async (d) => must(await executeDueActions({ store, worker: 'wf-w', runners: createRunnerRegistry([runner(d)], { defaultKind: 'n8n' }) }, { tenantId: a.tenantId, limit: 10 }), 'execute');
  async function queue(actionType, extra = {}) {
    const r = must(await createAutomationRun(store, {
      tenantId: a.tenantId, runKind: 'observation_window', moduleKey: LR, configSnapshotId: await a.snapshot(), runMode: 'live',
      correlationId: crypto.randomUUID(), idempotencyKey: key('run'), runnerKind: 'n8n',
    }), 'run').run;
    return must(await scheduleAutomationAction(store, { tenantId: a.tenantId, runId: r.id, actionType, runAt: past(), idempotencyKey: key(actionType), ...extra }), 'schedule').action;
  }
  const verifiedConnection = async () => (await db.query(
    `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status) values ($1, $2, 1, 'api_key', 'verified') returning id`,
    [a.tenantId, `c_${crypto.randomUUID().slice(0, 8)}`])).rows[0].id;
  const attemptOf = async (actionId) => (await db.query('select * from automation_action_attempts where action_id = $1 order by attempt_no desc limit 1', [actionId])).rows[0];
  const dispatchOf = async (attemptId) => (await db.query('select * from runner_dispatches where attempt_id = $1', [attemptId])).rows[0];
  const status = async (actionId) => (await db.query('select status from scheduled_actions where id = $1', [actionId])).rows[0].status;
  const assignmentsFor = async (actionType) => (await db.query(`select * from runner_workflow_assignments where action_type = $1 order by assigned_at`, [actionType])).rows;

  let wired;

  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    client = restClient(db);
    workflows = supabaseWorkflowStore(client);
    store = supabaseSchedulerStore(client);
    bridge = supabaseBridgeStore(client);
    a = await tenant(db, operator);
    await a.live();
    await permitN8n(db);
    wired = await wireWorkflows(workflows, operator, [
      await handlerEntry(),
      await actionEntry('arc-send-message-v1', ['send_message'], { required_capabilities: ['send_sms'] }),
      await actionEntry('arc-reminder-v1', ['remind_operator'], { effect_class: 'none', timeout_ambiguous: false, auto_retry: false }),
    ]);
  });

  /* ── registration and review ── */

  test('registering the same manifest again changes nothing; the same version with other content is refused', async () => {
    const entries = [await handlerEntry(), await actionEntry('arc-send-message-v1', ['send_message'], { required_capabilities: ['send_sms'] })];
    const again = must(await registerManifest(workflows, { manifest_version: 1, workflows: entries }, operator), 'again');
    assert.ok(again.every((x) => x.created === false));
    const edited = await actionEntry('arc-send-message-v1', ['send_message'], { required_capabilities: ['send_sms'], checksum: `sha256:${'e'.repeat(64)}` });
    const out = await registerManifest(workflows, { manifest_version: 1, workflows: [await handlerEntry(), edited] }, operator);
    assert.equal(out.code, 'version_conflict');
  });

  test('a registered version is immutable and its status only moves forward; nothing is deleted', async () => {
    must(await registerManifest(workflows, { manifest_version: 1, workflows: [await handlerEntry(), await actionEntry('arc-send-message-v1', ['send_message'], { workflow_version: '0.1.0', required_capabilities: ['send_sms'] })] }, operator), 'register');
    assert.match(await refused(db, `update runner_workflow_versions set checksum = $1 where runner_key = 'arc-send-message-v1' and workflow_version = '0.1.0'`, [`sha256:${'f'.repeat(64)}`]), /immutable/);
    must(await setWorkflowStatus(workflows, { actorId: operator, runnerKey: 'arc-send-message-v1', workflowVersion: '0.1.0', status: 'disabled' }), 'disable a draft');
    const back = await setWorkflowStatus(workflows, { actorId: operator, runnerKey: 'arc-send-message-v1', workflowVersion: '0.1.0', status: 'approved' });
    assert.equal(back.code, 'illegal_status');
    assert.match(await refused(db, `delete from runner_workflow_versions where workflow_version = '0.1.0'`), /never deleted/);
  });

  test('the database refuses a version the manifest parser would have: an unknown capability, a missing handler', async () => {
    const bogus = await actionEntry('arc-bogus-v1', ['send_message'], { required_capabilities: ['teleport'] });
    assert.equal((await workflows.registerVersion(operator, bogus).catch((e) => e)).code, 'invalid_manifest');
    const orphan = await actionEntry('arc-orphan-v1', ['send_message'], { error_handler: { runner_key: 'arc-nobody-v1', workflow_version: '1.0.0' } });
    assert.equal((await workflows.registerVersion(operator, orphan).catch((e) => e)).code, 'invalid_manifest');
    const notOperator = crypto.randomUUID();
    assert.equal((await workflows.registerVersion(notOperator, await handlerEntry()).catch((e) => e)).code, 'forbidden');
  });

  /* ── deployments ── */

  test('a deployment is the only place an n8n id lives; production is refused by the database too', async () => {
    assert.match(await refused(db,
      `insert into runner_workflow_deployments (runner_key, workflow_version, environment, n8n_workflow_id, webhook_url, registered_by)
       values ('arc-send-message-v1', '1.0.0', 'production', 'wf-prod', 'https://n8n.invalid/x', $1)`, [operator]), /environment_check|check constraint/);
    const handlerWithWebhook = await registerDeployment(workflows, { actorId: operator, runnerKey: 'arc-runner-error-handler-v1', workflowVersion: '1.0.0', environment: 'staging', n8nWorkflowId: 'wf-h', webhookUrl: 'https://n8n.invalid/h' });
    assert.equal(handlerWithWebhook.code, 'invalid_deployment');
    const columns = (await db.query(`select table_name from information_schema.columns where column_name = 'n8n_workflow_id' and table_schema = 'public'`)).rows.map((r) => r.table_name);
    assert.deepEqual(columns, ['runner_workflow_deployments'], 'ADR §29.1: no other table holds an n8n workflow id');
  });

  /* ── assignments ── */

  test('only an approved, compatible version is assigned: not a draft, not another action, not a capability the module lacks', async () => {
    must(await registerManifest(workflows, { manifest_version: 1, workflows: [await handlerEntry(), await actionEntry('arc-draft-v1', ['send_message'])] }, operator), 'register');
    /* Lead Recovery v1 declares every capability registered today, so this suite registers
       one it does not — in its own database — to prove the subset check bites. */
    await db.query(`insert into registry_capabilities (key, description, category, direction, risk) values ('book_appointment', 'test only', 'calendar', 'write', 'medium')`);
    must(await workflows.registerVersion(operator, await actionEntry('arc-greedy-v1', ['send_message'], { required_capabilities: ['send_sms', 'book_appointment'] })).then((v) => ({ ok: true, value: v })), 'register greedy');
    const draft = await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-draft-v1', workflowVersion: '1.0.0' });
    assert.equal(draft.code, 'workflow_not_approved');
    const wrongAction = await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'call_provider_operation', runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0' });
    assert.equal(wrongAction.code, 'incompatible_workflow');
    must(await setWorkflowStatus(workflows, { actorId: operator, runnerKey: 'arc-greedy-v1', workflowVersion: '1.0.0', status: 'approved' }), 'approve greedy');
    const greedy = await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-greedy-v1', workflowVersion: '1.0.0' });
    assert.equal(greedy.code, 'incompatible_workflow', 'approved, but it needs capabilities Lead Recovery v1 never declared');
    assert.match(greedy.message, /does not declare/);
    const engineType = await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'send_followup', runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0' });
    assert.equal(engineType.code, 'not_scheduler_action');
    const notOperator = await assignWorkflow(workflows, { actorId: crypto.randomUUID(), moduleKey: LR, moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0' });
    assert.equal(notOperator.code, 'forbidden');
    assert.equal((await assignmentsFor('send_message')).filter((x) => x.status === 'active').length, 1, 'nothing changed');
  });

  /* ── attribution ── */

  test('a dispatch is attributed by ARC from the assignment — version, checksum, error handler — and the attribution never moves', async () => {
    const d = double();
    const send = await queue('send_message', { connectionId: await verifiedConnection() });
    const [report] = (await execute(d)).filter((x) => x.actionId === send.id);
    assert.equal(report.outcome, 'accepted');
    const attempt = await attemptOf(send.id);
    const row = await dispatchOf(attempt.id);
    const { rows: [version] } = await db.query(`select * from runner_workflow_versions where runner_key = 'arc-send-message-v1' and workflow_version = '1.0.0'`);
    assert.deepEqual(
      [row.assignment_id, row.runner_key, row.workflow_version, row.workflow_checksum, row.error_handler_key, row.error_handler_version, row.auto_retry],
      [wired.assignments.send_message, 'arc-send-message-v1', '1.0.0', version.checksum, 'arc-runner-error-handler-v1', '1.0.0', true],
    );
    assert.equal(d.dispatches[0].url, 'https://n8n.invalid/webhook/arc-send-message-v1', 'the webhook comes from this environment\'s deployment');
    assert.match(await refused(db, `update runner_dispatches set workflow_checksum = $2 where attempt_id = $1`, [attempt.id, `sha256:${'0'.repeat(64)}`]), /identity is fixed/);

    /* a new version is assigned: the old dispatch keeps what it ran, the next one runs the new one. */
    const next = await actionEntry('arc-send-message-v1', ['send_message'], { workflow_version: '1.1.0', required_capabilities: ['send_sms'] });
    const rewired = await wireWorkflows(workflows, operator, [await handlerEntry(), next]);
    const history = await assignmentsFor('send_message');
    assert.deepEqual(history.map((x) => [x.workflow_version, x.status, x.retire_reason]), [['1.0.0', 'retired', 'superseded'], ['1.1.0', 'active', null]]);
    assert.equal((await dispatchOf(attempt.id)).workflow_version, '1.0.0', 'history is not rewritten');

    const later = await queue('send_message', { connectionId: await verifiedConnection() });
    await execute(d);
    const laterRow = await dispatchOf((await attemptOf(later.id)).id);
    assert.deepEqual([laterRow.workflow_version, laterRow.assignment_id], ['1.1.0', rewired.assignments.send_message]);

    const { rows: view } = await db.query('select * from runner_attempt_attribution where action_id in ($1, $2) order by dispatched_at', [send.id, later.id]);
    assert.deepEqual(view.map((v) => v.workflow_version), ['1.0.0', '1.1.0']);
    assert.match(await refused(db, `update runner_workflow_assignments set workflow_version = '9.9.9' where id = $1`, [history[0].id]), /only ever retired/);
  });

  test('a disabled version stops new dispatches before anything is sent; nothing took effect', async () => {
    must(await setWorkflowStatus(workflows, { actorId: operator, runnerKey: 'arc-send-message-v1', workflowVersion: '1.1.0', status: 'disabled', reason: 'rolled back' }), 'disable');
    const d = double();
    const send = await queue('send_message', { connectionId: await verifiedConnection() });
    const [report] = (await execute(d)).filter((x) => x.actionId === send.id);
    assert.deepEqual([report.dispatched, report.outcome, report.actionStatus], [true, 'failed', 'failed']);
    assert.equal((await attemptOf(send.id)).error_code, 'workflow_disabled');
    assert.equal(d.dispatches.length, 0, 'nothing reached n8n');
    assert.equal(await dispatchOf((await attemptOf(send.id)).id), undefined, 'and nothing was recorded as dispatched');
    /* recover by assigning the reviewed earlier version again — a new row, never an edit. */
    must(await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0', reason: 'roll back' }), 'reassign');
    assert.equal((await assignmentsFor('send_message')).length, 3);
  });

  test('a retired assignment, or none, dispatches nothing', async () => {
    const [active] = (await assignmentsFor('remind_operator')).filter((x) => x.status === 'active');
    must(await retireAssignment(workflows, { actorId: operator, assignmentId: active.id, reason: 'paused while we look' }), 'retire');
    const d = double();
    const note = await queue('remind_operator');
    const [report] = (await execute(d)).filter((x) => x.actionId === note.id);
    assert.equal((await attemptOf(note.id)).error_code, 'no_assignment');
    assert.equal(report.actionStatus, 'failed');
    assert.equal(d.dispatches.length, 0);
    must(await assignWorkflow(workflows, { actorId: operator, moduleKey: LR, moduleVersion: 1, actionType: 'remind_operator', runnerKey: 'arc-reminder-v1', workflowVersion: '1.0.0' }), 'reassign');
  });

  test('a workflow ARC may not retry automatically is not retried, whatever its callback says', async () => {
    const d = double();
    const note = await queue('remind_operator');
    await execute(d);
    const body = d.dispatches.at(-1).body;
    const callback = {
      contract_version: 1, job_id: body.job_id, action_id: body.action_id, tenant_id: body.tenant_id, arc_attempt: body.attempt,
      n8n_execution_id: 'exec-r', runner_key: body.runner_key, workflow_version: body.workflow_version, status: 'failed',
      provider_refs: [], safe_output_meta: {}, error_category: 'upstream_busy', retryable: true, completed_at: new Date().toISOString(),
      correlation_id: body.correlation_id, idempotency_key: body.idempotency_key,
    };
    const rawBody = JSON.stringify(callback);
    const out = await handleCallback({ environment: 'test', callbackSecret: CALLBACK_SECRET, bridge, scheduler: store },
      { rawBody, headers: await signBridgeRequest(rawBody, CALLBACK_SECRET, { purpose: 'callback', timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() }) });
    assert.deepEqual([out.body.disposition, out.body.action_status], ['applied', 'failed']);
    assert.equal(await status(note.id), 'failed');
  });

  /* ── sync, over the database's own rows ── */

  test('sync over ARC\'s rows and a mocked n8n: in sync, then drift, then a missing workflow', async () => {
    const handler = await handlerEntry();
    const reminder = await actionEntry('arc-reminder-v1', ['remind_operator'], { effect_class: 'none', timeout_ambiguous: false, auto_retry: false });
    const manifest = { manifest_version: 1, workflows: [handler, reminder] };
    const versions = (await workflows.listVersions()).filter((v) => ['arc-runner-error-handler-v1', 'arc-reminder-v1'].includes(v.runnerKey));
    const deployments = (await workflows.listDeployments('test')).filter((x) => versions.some((v) => v.runnerKey === x.runnerKey));
    const assignments = (await workflows.listAssignments()).filter((x) => x.runnerKey === 'arc-reminder-v1');
    const handlerId = wired.n8nIds['arc-runner-error-handler-v1@1.0.0'];
    const reminderId = wired.n8nIds['arc-reminder-v1@1.0.0'];
    const held = {
      [handlerId]: exportOf('arc-runner-error-handler-v1'),
      [reminderId]: exportOf('arc-reminder-v1@1.0.0', { errorWorkflow: handlerId }),
    };
    const check = () => checkWorkflowSync({ manifest, versions, deployments, assignments, environment: 'test', n8n: { getWorkflow: async (id) => held[id] ?? null } });
    assert.deepEqual(await check(), []);
    held[reminderId].nodes[0].parameters.path = 'someone-edited-this';
    assert.deepEqual((await check()).map((f) => f.code), ['checksum_drift']);
    delete held[reminderId];
    assert.deepEqual((await check()).map((f) => f.code), ['missing_in_n8n']);
  });

  /* ── 0019 ── */

  test('no browser role reads a workflow, a deployment, an assignment or the attribution view', async () => {
    const member = await newMember(db, a.tenantId);
    await asRole(db, { role: 'authenticated', sub: member }, async (tx) => {
      for (const table of ['runner_workflow_versions', 'runner_workflow_deployments', 'runner_workflow_assignments', 'runner_attempt_attribution']) {
        assert.equal((await tx.query(`select * from ${table}`)).rows.length, 0, table);
      }
      await assert.rejects(tx.query(`select * from public.resolve_runner_workflow('lead_recovery', 1, 'send_message', 'test')`), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      assert.ok((await tx.query('select * from runner_attempt_attribution where runner_key is not null')).rows.length > 0);
    });
  });

  test('0019 as written: every function revoked from browser roles, no write policy, one deliberate drop', () => {
    const defined = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    for (const name of new Set(defined)) assert.match(SQL, new RegExp(`revoke all on function public\\.${name}\\(`), name);
    assert.doesNotMatch(SQL, /create policy [a-z_]+ on public\.[a-z_]+\s+for (insert|update|delete|all)/i);
    assert.doesNotMatch(SQL, /grant [^;]* to (anon|authenticated|public)\b/i);
    assert.doesNotMatch(SQL, /\bdrop table\b|\bdrop column\b|\btruncate\b|\bdelete from\b/i);
    const drops = [...SQL.matchAll(/drop function if exists ([^;]+);/g)].map((m) => m[1]);
    assert.deepEqual(drops, ['public.record_runner_dispatch(uuid, uuid, text, text, text, uuid, timestamptz)'], 'only 0018\'s unattributed dispatch is dropped');
  });
});
