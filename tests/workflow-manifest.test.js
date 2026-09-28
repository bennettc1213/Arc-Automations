/* ARC-230 — the workflow manifest, its checksum and the sync check, without a database.
 * `tests/workflow-manifest-db.test.js` runs registration, assignment and attribution on
 * real SQL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { parseManifest, refOf, workflowChecksum } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { checkWorkflowSync, SYNC_FINDINGS } from '../supabase/functions/_shared/n8n-runner/sync.ts';
import { assignWorkflow, registerDeployment, registerManifest } from '../supabase/functions/_shared/n8n-runner/workflows.ts';
import { actionEntry, exportOf, handlerEntry, HANDLER } from './workflow-fixtures.js';

const MANIFEST_URL = new URL('../n8n/manifest.json', import.meta.url);
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const untouchable = new Proxy({}, { get: (_t, n) => () => { throw new Error(`reached the store (${String(n)})`); } });

const manifest = async (...extra) => ({ manifest_version: 1, workflows: [await handlerEntry(), await actionEntry('arc-send-message-v1', ['send_message']), ...extra] });

describe('the repository\'s manifest', () => {
  test('parses, and every entry\'s export exists and is exactly what was reviewed', async () => {
    const json = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
    const parsed = parseManifest(json);
    assert.equal(parsed.ok, true, parsed.problems?.join('\n'));
    for (const entry of parsed.manifest.workflows) {
      const file = new URL(entry.export_path, MANIFEST_URL);
      assert.ok(existsSync(file), `${refOf(entry)}: ${entry.export_path} is missing`);
      assert.equal(await workflowChecksum(JSON.parse(readFileSync(file, 'utf8'))), entry.checksum, `${refOf(entry)}: the export is not what was reviewed`);
    }
  });
});

describe('a manifest entry says what a workflow may do, and nothing environmental', () => {
  test('a well-formed manifest parses', async () => {
    assert.equal(parseManifest(await manifest()).ok, true);
  });

  test('every problem is listed, not just the first', async () => {
    const problems = (m) => { const r = parseManifest(m); assert.equal(r.ok, false); return r.problems.join('\n'); };
    const base = await actionEntry('arc-thing-v1', ['send_message']);
    const cases = [
      [{ ...base, n8n_workflow_id: 'abc' }, /unknown fields n8n_workflow_id/],
      [{ ...base, webhook_url: 'https://n8n.invalid/x' }, /unknown fields webhook_url/],
      [{ ...base, action_types: ['send_followup'] }, /send_followup is not a scheduler action type/],
      [{ ...base, action_types: ['launch_rocket'] }, /launch_rocket is not a scheduler action type/],
      [{ ...base, effect_class: 'none' }, /send_message is external_effect, so the workflow cannot declare itself none/],
      [{ ...base, timeout_ambiguous: false }, /cannot claim a timeout leaves nothing unknown/],
      [{ ...base, input_contract_version: 2 }, /contract versions are 1/],
      [{ ...base, module_versions: [7] }, /module_versions are registered versions/],
      [{ ...base, module_key: 'estimate_recovery' }, /module_versions are registered versions of estimate_recovery/],
      [{ ...base, required_capabilities: ['teleport'] }, /registered capability keys/],
      [{ ...base, runner_kind: 'direct' }, /runner_kind is n8n/],
      [{ ...base, checksum: 'md5:abc' }, /checksum is sha256/],
      [{ ...base, error_handler: { runner_key: 'arc-missing-handler-v1', workflow_version: '1.0.0' } }, /not in the manifest/],
      [{ ...base, error_handler: { runner_key: 'arc-send-message-v1', workflow_version: '1.0.0' } }, /is not an error handler/],
      [{ ...base, display_name: 'uses api_key abc' }, /looks like a credential/],
    ];
    for (const [entry, pattern] of cases) assert.match(problems(await manifest(entry)), pattern, JSON.stringify(Object.keys(entry)));
    const twice = await manifest(await actionEntry('arc-send-message-v1', ['send_message']));
    assert.match(problems(twice), /listed twice/);
    assert.match(problems({ manifest_version: 1, workflows: [{ ...(await handlerEntry()), action_types: ['send_message'] }] }), /error handler serves no module/);
  });
});

describe('the checksum is the workflow\'s behaviour, not its export', () => {
  test('the same workflow exported from another instance, with new ids, layout and timestamps, checks out the same', async () => {
    const a = exportOf('flow', { id: 'staging-17' });
    const b = exportOf('flow', { id: 'dev-3', errorWorkflow: 'dev-handler-9', extra: { pinData: { x: 1 }, tags: [{ id: 't' }] } });
    b.nodes = b.nodes.map((n, i) => ({ ...n, id: `other-${i}`, position: [i * 999, 42], credentials: { jwtAuth: { id: 'cred-7' } } })).reverse();
    b.meta.instanceId = 'somewhere-else';
    assert.equal(await workflowChecksum(a), await workflowChecksum(b));
  });

  test('any change to what it does changes the checksum', async () => {
    const base = await workflowChecksum(exportOf('flow'));
    const changed = exportOf('flow');
    changed.nodes[1].parameters.method = 'GET';
    assert.notEqual(await workflowChecksum(changed), base);
    const rewired = exportOf('flow');
    rewired.connections = {};
    assert.notEqual(await workflowChecksum(rewired), base);
    assert.match(base, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await workflowChecksum({ nodes: 'no' }), null);
  });
});

describe('operator decisions refuse bad input before the database', () => {
  test('production is not a deployment environment until the licensing gate closes', async () => {
    const out = await registerDeployment(untouchable, { actorId: OPERATOR, runnerKey: 'arc-x-v1', workflowVersion: '1', environment: 'production', n8nWorkflowId: 'a', webhookUrl: 'https://n8n.invalid/x' });
    assert.equal(out.code, 'n8n_production_gated');
  });

  test('an invalid manifest registers nothing; a decision without an operator is refused', async () => {
    assert.equal((await registerManifest(untouchable, { manifest_version: 2, workflows: [] }, OPERATOR)).code, 'invalid_manifest');
    assert.equal((await registerManifest(untouchable, await manifest(), 'somebody')).code, 'forbidden');
    assert.equal((await assignWorkflow(untouchable, { actorId: 'system', moduleKey: 'lead_recovery', moduleVersion: 1, actionType: 'send_message', runnerKey: 'arc-x-v1', workflowVersion: '1' })).code, 'forbidden');
  });
});

describe('the sync check reports what runs that was not reviewed (mocked n8n)', () => {
  const version = (e, status = 'approved') => ({
    id: crypto.randomUUID(), runnerKey: e.runner_key, workflowVersion: e.workflow_version, role: e.role, moduleKey: e.module_key,
    moduleVersions: e.module_versions, actionTypes: e.action_types, checksum: e.checksum, inputContractVersion: 1, outputContractVersion: 1,
    effectClass: e.effect_class, autoRetry: e.auto_retry, errorHandlerKey: e.error_handler?.runner_key ?? null,
    errorHandlerVersion: e.error_handler?.workflow_version ?? null, status,
  });
  const deployment = (e, n8nWorkflowId) => ({ id: crypto.randomUUID(), runnerKey: e.runner_key, workflowVersion: e.workflow_version, environment: 'staging', n8nWorkflowId, webhookUrl: null });

  async function world({ n8nOverrides = {}, statuses = {}, drop = [] } = {}) {
    const handler = await handlerEntry();
    const action = await actionEntry('arc-send-message-v1', ['send_message']);
    const m = { manifest_version: 1, workflows: [handler, action] };
    const held = {
      'wf-handler': exportOf('arc-runner-error-handler-v1'),
      'wf-send': exportOf('arc-send-message-v1@1.0.0', { errorWorkflow: 'wf-handler' }),
      ...n8nOverrides,
    };
    const input = {
      manifest: m,
      versions: [version(handler, statuses.handler), version(action, statuses.action)].filter((v) => !drop.includes(v.runnerKey)),
      deployments: [deployment(handler, 'wf-handler'), deployment(action, 'wf-send')],
      assignments: [{ id: crypto.randomUUID(), moduleKey: 'lead_recovery', moduleVersion: 1, actionType: 'send_message', runnerKey: action.runner_key, workflowVersion: '1.0.0', status: 'active' }],
      environment: 'staging',
      n8n: { getWorkflow: async (id) => held[id] ?? null },
    };
    return checkWorkflowSync(input);
  }
  const codes = (findings) => findings.map((f) => f.code);

  test('in sync: nothing to report', async () => {
    assert.deepEqual(await world(), []);
  });

  test('a workflow edited in n8n is drift', async () => {
    const edited = exportOf('arc-send-message-v1@1.0.0', { errorWorkflow: 'wf-handler' });
    edited.nodes[1].parameters.method = 'GET';
    assert.deepEqual(codes(await world({ n8nOverrides: { 'wf-send': edited } })), ['checksum_drift']);
  });

  test('a workflow deleted from n8n is missing; an unlinked error handler is reported', async () => {
    assert.deepEqual(codes(await world({ n8nOverrides: { 'wf-send': null } })), ['missing_in_n8n']);
    const unlinked = exportOf('arc-send-message-v1@1.0.0', { errorWorkflow: 'somebody-else' });
    assert.deepEqual(codes(await world({ n8nOverrides: { 'wf-send': unlinked } })), ['error_handler_unlinked']);
  });

  test('an assignment to a disabled version, and a manifest entry ARC never registered', async () => {
    assert.ok(codes(await world({ statuses: { action: 'disabled' } })).includes('assignment_not_runnable'));
    assert.deepEqual(codes(await world({ drop: ['arc-send-message-v1'] })), ['assignment_not_runnable', 'not_registered']);
  });

  test('every finding the check can make is a named code', () => {
    assert.equal(new Set(SYNC_FINDINGS).size, SYNC_FINDINGS.length);
    assert.ok(SYNC_FINDINGS.includes('checksum_drift') && SYNC_FINDINGS.includes('assignment_not_deployed'));
    assert.equal(HANDLER.runner_key, 'arc-runner-error-handler-v1', 'the ADR §21 error handler key');
  });
});
