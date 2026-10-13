/* The four Lead Recovery workflows the SaaS brief asks for, held as drafts (2026-10-13).
 *
 * n8n/drafts/ holds an export for each: a newly accepted inquiry, an inbound reply, a
 * confirmed missed call and due follow-up work. Each is ARC-240's reviewed frame around a
 * module step, and this file holds them to four things:
 *
 *   - each is exactly what scripts/n8n-drafts.mjs builds from the reference frame, and
 *     passes the same frame check a registered action workflow passes;
 *   - none is in the manifest, and none could be assigned: no module version permits n8n;
 *   - each, *run* in the simulator against ARC's real verifiers, authenticates the dispatch,
 *     fetches its envelope, refuses work that is not its own kind, and reports back;
 *   - and what it reports is `skipped`. A draft's step performs nothing, because the
 *     connector gateway it would ask does not take a workflow's request yet. It never
 *     reports work as done.
 *
 * Nothing here reaches a network, an n8n instance or a database. Whether a real n8n imports
 * and runs these is not proven by this file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { MODULES } from '../supabase/functions/_shared/registry/modules.ts';
import { actionType } from '../supabase/functions/_shared/scheduler/model.ts';
import { parseCallback } from '../supabase/functions/_shared/n8n-runner/contract.ts';
import { BRIDGE_URL_PLACEHOLDER, parseManifest } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { workflowExportProblems } from '../supabase/functions/_shared/n8n-runner/exports.ts';
import { sha256Hex, signDispatchToken, verifyBridgeRequest } from '../supabase/functions/_shared/n8n-runner/signing.ts';
import { createN8n, ERROR_HANDLER, loadExport, REFERENCE_ACTION } from './n8n-sim.js';
import { buildDraft, DRAFT_VERSION, draftFile, DRAFTS, serialise } from '../scripts/n8n-drafts.mjs';

const DRAFTS_DIR = new URL('../n8n/drafts/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL('../n8n/manifest.json', import.meta.url), 'utf8'));
const BRIDGE = 'https://arc-test.invalid/functions/v1/runner-bridge';
/* secrets are built from parts so no credential-shaped literal sits in the repository. */
const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'draft', 'tests', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'draft', 'tests', 'y'.repeat(12)].join('-'));
const CREDENTIALS = { 'ARC dispatch': DISPATCH_SECRET.reveal(), 'ARC bridge signing': CALLBACK_SECRET.reveal() };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const stored = (draft) => JSON.parse(readFileSync(new URL(draftFile(draft), DRAFTS_DIR), 'utf8'));

describe('the four draft workflows are the reviewed frame, and nothing registered', () => {
  test('there is one for each job the brief lists, and no other file', () => {
    assert.deepEqual(DRAFTS.map((draft) => draft.work), ['new_inquiry', 'inbound_reply', 'missed_call', 'due_followup']);
    const files = readdirSync(DRAFTS_DIR).filter((name) => name.endsWith('.json')).sort();
    assert.deepEqual(files, DRAFTS.map(draftFile).sort());
  });

  for (const draft of DRAFTS) {
    test(`${draft.runner_key}: exactly what the script builds, and a valid shared action workflow`, () => {
      const text = readFileSync(new URL(draftFile(draft), DRAFTS_DIR), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(text, serialise(buildDraft(draft)), 'run node scripts/n8n-drafts.mjs --write');
      const entry = { runner_key: draft.runner_key, workflow_version: DRAFT_VERSION, role: 'action' };
      assert.deepEqual(workflowExportProblems(stored(draft), entry), []);
    });

    test(`${draft.runner_key}: only its name, its webhook path, its step and its own identity differ from the reference frame`, () => {
      const reference = loadExport(REFERENCE_ACTION);
      const exported = stored(draft);
      assert.deepEqual(exported.connections, reference.connections);
      assert.deepEqual(exported.settings, reference.settings);
      const differing = exported.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(reference.nodes[index])).map((node) => node.name);
      assert.deepEqual(differing.sort(), ['ARC dispatch', 'Perform action', 'Prepare callback']);
      const environment = exported.nodes.find((node) => node.name === 'ARC environment');
      assert.equal(environment.parameters.assignments.assignments[0].value, BRIDGE_URL_PLACEHOLDER, 'the repository holds the placeholder, never an environment');
    });

    test(`${draft.runner_key}: it names scheduler action types, never one of the engine's own`, () => {
      for (const key of draft.action_types) {
        const definition = actionType(key);
        assert.equal(definition?.dispatcher, 'scheduler', `${key} is the direct engine's — a workflow never takes one of those`);
      }
    });
  }

  test('none is in the manifest, and the manifest is still valid without them', () => {
    const parsed = parseManifest(MANIFEST);
    assert.equal(parsed.ok, true, parsed.problems?.join('\n'));
    for (const draft of DRAFTS) assert.ok(!MANIFEST.workflows.some((entry) => entry.runner_key === draft.runner_key), draft.runner_key);
    assert.deepEqual(MANIFEST.workflows.map((entry) => entry.role), ['error_handler']);
  });

  test('none could be assigned: the only module that holds a run forbids n8n, so the direct dispatcher stays the path', () => {
    const versions = MODULES.find((module) => module.key === 'lead_recovery').versions;
    for (const version of versions) {
      assert.deepEqual([version.runtime.executionMode, version.runtime.n8n], ['direct', 'prohibited'], `lead_recovery@${version.version}`);
    }
  });
});

describe('each draft, run in the simulator against ARC\'s real verifiers', () => {
  const JOB = '44444444-4444-4444-8444-444444444444';
  const ACTION = '33333333-3333-4333-8333-333333333333';
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const NONCE = '77777777-7777-4777-8777-777777777777';
  const CORRELATION = '88888888-8888-4888-8888-888888888888';

  function world(draft, { actionType: type = draft.action_types[0], payload = { work: draft.work } } = {}) {
    const seen = { envelope: [], callback: [], failure: [] };
    const n8n = createN8n({
      credentials: CREDENTIALS, bridgeUrl: BRIDGE,
      http: async (url, { headers, body }) => {
        const route = url.slice(BRIDGE.length + 1);
        const verified = await verifyBridgeRequest(body, headers, CALLBACK_SECRET, nowSeconds(), route);
        assert.equal(verified.ok, true, `${route}: ${verified.code}`);
        seen[route].push(JSON.parse(body));
        if (route === 'envelope') {
          return { status: 200, text: JSON.stringify({ contract_version: 1, envelope: {
            contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, run_id: crypto.randomUUID(), module_key: 'lead_recovery', module_version: 1,
            action_type: type, effect_class: draft.effect_class, run_mode: 'test', attempt: 1, config_refs: { config_snapshot_id: crypto.randomUUID() },
            idempotency_key: 'draft:1', correlation_id: CORRELATION, connection: null, payload, expires_at: new Date(Date.now() + 300_000).toISOString(),
          } }) };
        }
        return { status: 200, text: '{}' };
      },
    });
    n8n.deploy(loadExport(ERROR_HANDLER), 'wf-handler');
    n8n.deploy(stored(draft), 'wf-draft', { errorWorkflow: 'wf-handler' });
    return { n8n, seen };
  }

  async function dispatch(n8n, draft, { secret = DISPATCH_SECRET } = {}) {
    const body = JSON.stringify({
      contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, module_key: 'lead_recovery', module_version: 1,
      runner_key: draft.runner_key, workflow_version: DRAFT_VERSION, attempt: 1, config_refs: { config_snapshot_id: crypto.randomUUID() },
      idempotency_key: 'draft:1', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(), correlation_id: CORRELATION, nonce: NONCE,
    });
    const token = await signDispatchToken({
      iss: 'arc', aud: draft.runner_key, sub: JOB, jti: NONCE, iat: nowSeconds(), exp: nowSeconds() + 300, tenant_id: TENANT, body_sha256: await sha256Hex(body),
    }, secret);
    return await n8n.webhook(`https://n8n.invalid/webhook/${draft.path}`, { headers: { Authorization: `Bearer ${token}` }, body });
  }

  for (const draft of DRAFTS) {
    test(`${draft.runner_key}: answers ARC at once, fetches its envelope, and reports the work as skipped — never as done`, async () => {
      const { n8n, seen } = world(draft);
      const answer = await dispatch(n8n, draft);
      assert.deepEqual([answer.status, typeof answer.body.n8n_execution_id], [202, 'string']);
      await n8n.drain();
      assert.deepEqual(seen.envelope, [{ contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, nonce: NONCE }]);
      assert.equal(seen.callback.length, 1);
      const callback = parseCallback(seen.callback[0]);
      assert.equal(callback.ok, true, callback.problem);
      assert.deepEqual(
        [callback.value.status, callback.value.runner_key, callback.value.workflow_version, callback.value.provider_refs],
        ['skipped', draft.runner_key, DRAFT_VERSION, []],
      );
      assert.deepEqual(callback.value.safe_output_meta, { work: draft.work, performed: false, reason: 'connector_gateway_not_built' });
      assert.equal(seen.failure.length, 0);
    });

    test(`${draft.runner_key}: work that is not its own kind is refused, and the error handler says so by execution id`, async () => {
      const other = DRAFTS.find((candidate) => candidate.work !== draft.work).work;
      for (const [options, category] of [
        [{ actionType: 'call_provider_operation' }, 'unsupported_capability'],
        [{ payload: { work: other } }, 'validation_failed'],
        [{ payload: {} }, 'validation_failed'],
      ]) {
        const { n8n, seen } = world(draft, options);
        const answer = await dispatch(n8n, draft);
        await n8n.drain();
        assert.equal(seen.callback.length, 0, 'a refused step reports nothing itself');
        assert.deepEqual(seen.failure.map((report) => [report.error_category, report.n8n_execution_id, report.failed_node]), [[category, answer.body.n8n_execution_id, 'Perform action']]);
      }
    });

    test(`${draft.runner_key}: a dispatch not signed with ARC's secret never starts`, async () => {
      const { n8n, seen } = world(draft);
      const answer = await dispatch(n8n, draft, { secret: new SecretValue(['someone', 'elses', 'secret', 'z'.repeat(24)].join('-')) });
      assert.equal(answer.status, 403);
      await n8n.drain();
      assert.deepEqual([seen.envelope.length, n8n.executions.length], [0, 0]);
    });
  }
});
