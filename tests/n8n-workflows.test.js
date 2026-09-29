/* ARC-240 — the shared n8n workflows, checked without n8n.
 *
 * The repository's exports are validated as they are stored; the shared error handler and
 * a reference action workflow (a fixture, never registered) are *run* — their own graphs,
 * Code nodes and expressions — by `n8n-sim.js`, against ARC's real verifiers and parsers.
 * Nothing here reaches a network, an n8n instance or a database; `n8n-workflows-db.test.js`
 * runs the same workflows through the orchestrator on real SQL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { getModuleVersion } from '../supabase/functions/_shared/registry/modules.ts';
import { parseCallback, parseEnvelopeRequest } from '../supabase/functions/_shared/n8n-runner/contract.ts';
import { BRIDGE_URL_PLACEHOLDER, parseManifest, workflowChecksum } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { workflowExportProblems } from '../supabase/functions/_shared/n8n-runner/exports.ts';
import { FAILURE_CATEGORIES, FAILURE_CATEGORY_KEYS, failureOutcome, parseFailureReport } from '../supabase/functions/_shared/n8n-runner/failures.ts';
import { sha256Hex, signDispatchToken, verifyBridgeRequest } from '../supabase/functions/_shared/n8n-runner/signing.ts';
import { checkWorkflowSync } from '../supabase/functions/_shared/n8n-runner/sync.ts';
import { createN8n, ERROR_HANDLER, loadExport, REFERENCE_ACTION } from './n8n-sim.js';

const MANIFEST_URL = new URL('../n8n/manifest.json', import.meta.url);
const BRIDGE = 'https://arc-test.invalid/functions/v1/runner-bridge';
/* secrets are built from parts so no credential-shaped literal sits in the repository. */
const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'tests', 'only', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'tests', 'only', 'y'.repeat(12)].join('-'));
const CREDENTIALS = { 'ARC dispatch': DISPATCH_SECRET.reveal(), 'ARC bridge signing': CALLBACK_SECRET.reveal() };
const nowSeconds = () => Math.floor(Date.now() / 1000);

const HANDLER_ENTRY = { runner_key: 'arc-runner-error-handler-v1', workflow_version: '1.0.0', role: 'error_handler' };
const ACTION_ENTRY = { runner_key: 'arc-reference-action', workflow_version: '1.0.0', role: 'action' };

/* ══ the repository ══════════════════════════════════════ */

describe('the repository\'s shared workflows', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));

  test('every export in the manifest is a valid shared workflow, and exactly what was reviewed', async () => {
    const parsed = parseManifest(manifest);
    assert.equal(parsed.ok, true, parsed.problems?.join('\n'));
    assert.ok(manifest.workflows.length > 0, 'the shared error handler is in the manifest');
    for (const entry of manifest.workflows) {
      const exported = JSON.parse(readFileSync(new URL(entry.export_path, MANIFEST_URL), 'utf8'));
      assert.deepEqual(workflowExportProblems(exported, entry), [], `${entry.runner_key}@${entry.workflow_version}`);
      assert.equal(await workflowChecksum(exported), entry.checksum);
    }
  });

  test('the error handler is ADR §21\'s key; an action workflow serves only a module version that may use n8n', () => {
    assert.ok(manifest.workflows.some((e) => e.role === 'error_handler' && e.runner_key === 'arc-runner-error-handler-v1'));
    for (const e of manifest.workflows.filter((x) => x.role === 'action')) {
      for (const v of e.module_versions) {
        const runtime = getModuleVersion(e.module_key, v).runtime;
        assert.ok(runtime.n8n !== 'prohibited' && runtime.executionMode !== 'direct', `${e.runner_key} serves ${e.module_key}@${v}, which may not use n8n`);
      }
    }
  });

  test('the reference action workflow is a fixture, never in the manifest, and itself valid', async () => {
    assert.ok(!manifest.workflows.some((e) => e.runner_key === ACTION_ENTRY.runner_key));
    assert.deepEqual(workflowExportProblems(loadExport(REFERENCE_ACTION), ACTION_ENTRY), []);
  });
});

/* ══ what an export may never hold ═══════════════════════ */

describe('a shared workflow export is refused for what it may never hold', () => {
  const base = () => loadExport(REFERENCE_ACTION);
  const node = (x, name) => x.nodes.find((n) => n.name === name);
  const code = (x, name, edit) => { node(x, name).parameters.jsCode = edit(node(x, name).parameters.jsCode); return x; };
  const cases = [
    ['a hard-coded tenant id', (x) => code(x, 'Perform action', (c) => `const tenant = '11111111-1111-4111-8111-111111111111';\n${c}`), /holds an id/],
    ['a read of n8n\'s environment', (x) => code(x, 'Perform action', (c) => `const key = $env.TWILIO_TOKEN;\n${c}`), /reads n8n's environment/],
    ['a read of n8n\'s variables', (x) => { node(x, 'Accept').parameters.responseBody = '={{ $vars.anything }}'; return x; }, /reads n8n's environment or variables/],
    ['a provider token in a node', (x) => { node(x, 'Send callback').parameters.headerParameters.parameters[0].value = ['Bearer', 'sk_live_', 'a'.repeat(20)].join(' '); return x; }, /looks like a credential/],
    ['a tenant credential', (x) => { node(x, 'Perform action').credentials = { twilioApi: { name: 'Acme Twilio' } }; return x; }, /a twilioApi credential/],
    ['an environment\'s credential id', (x) => { node(x, 'ARC dispatch').credentials.jwtAuth.id = 'cred-17'; return x; }, /carries an environment's id/],
    ['a node type nobody reviewed', (x) => { node(x, 'Perform action').type = 'n8n-nodes-base.twilio'; return x; }, /not a node type reviewed/],
    ['a call to anywhere but ARC', (x) => { node(x, 'Send callback').parameters.url = 'https://example.com/hook'; return x; }, /goes to ARC's bridge only/],
    ['code that fetches', (x) => code(x, 'Perform action', (c) => `await fetch('https://example.com');\n${c}`), /makes a network call/],
    ['code that loads a module', (x) => code(x, 'Perform action', (c) => `const fs = require('fs');\n${c}`), /loads a module/],
    ['an environment\'s workflow id', (x) => { x.id = 'wf-staging-9'; return x; }, /carries an n8n workflow id/],
    ['a linked error workflow id', (x) => { x.settings.errorWorkflow = 'wf-handler-2'; return x; }, /names an error workflow id/],
    ['kept execution data', (x) => { x.settings.saveDataErrorExecution = 'all'; return x; }, /saveDataErrorExecution/],
    ['a real bridge URL in the repository', (x) => { node(x, 'ARC environment').parameters.assignments.assignments[0].value = BRIDGE; return x; }, /holds https:\/\/arc-bridge\.invalid/],
    ['a second value in the environment node', (x) => { node(x, 'ARC environment').parameters.assignments.assignments.push({ id: 'b', name: 'tenant', value: 'acme', type: 'string' }); return x; }, /Set node holding only arc_bridge_url/],
    ['a webhook without ARC\'s JWT', (x) => { node(x, 'ARC dispatch').parameters.authentication = 'none'; return x; }, /verifies ARC's JWT/],
    ['no callback stage', (x) => { x.nodes = x.nodes.filter((n) => n.name !== 'Hash callback'); return x; }, /the callback stage has Hash callback/],
    ['a name that is not its manifest entry', (x) => { x.name = 'My workflow'; return x; }, /not arc-reference-action@1\.0\.0/],
    ['pinned test data', (x) => { x.pinData = { 'ARC dispatch': [{ json: { tenant_id: 'x' } }] }; return x; }, /pinned data/],
  ];

  for (const [label, mutate, pattern] of cases) {
    test(`refused: ${label}`, () => {
      const problems = workflowExportProblems(mutate(base()), ACTION_ENTRY);
      assert.match(problems.join('\n'), pattern, problems.join('\n'));
    });
  }

  test('an error handler takes no dispatch and reports only failures', () => {
    const handler = loadExport(ERROR_HANDLER);
    assert.deepEqual(workflowExportProblems(handler, HANDLER_ENTRY), []);
    assert.match(workflowExportProblems(loadExport(REFERENCE_ACTION), HANDLER_ENTRY).join('\n'), /takes no dispatch/);
  });
});

/* ══ the checksum and the environment node ═══════════════ */

describe('one reviewed version checks out the same in every environment — and only the bridge URL may differ', () => {
  const withUrl = (url) => {
    const x = loadExport(ERROR_HANDLER);
    x.nodes.find((n) => n.name === 'ARC environment').parameters.assignments.assignments[0].value = url;
    return x;
  };

  test('the environment\'s bridge URL is not part of the checksum', async () => {
    const reviewed = await workflowChecksum(loadExport(ERROR_HANDLER));
    assert.equal(await workflowChecksum(withUrl(BRIDGE)), reviewed);
    assert.equal(await workflowChecksum(withUrl('https://staging.invalid/functions/v1/runner-bridge')), reviewed);
  });

  test('anything else in that node is hashed, so it is drift — never a hiding place', async () => {
    const reviewed = await workflowChecksum(loadExport(ERROR_HANDLER));
    const extra = loadExport(ERROR_HANDLER);
    extra.nodes.find((n) => n.name === 'ARC environment').parameters.assignments.assignments.push({ id: 'x', name: 'note', value: 'hi', type: 'string' });
    assert.notEqual(await workflowChecksum(extra), reviewed);
    assert.notEqual(await workflowChecksum(withUrl('http://plain.invalid/functions/v1/runner-bridge')), reviewed, 'not https: not the environment node');
    assert.notEqual(await workflowChecksum(withUrl('https://elsewhere.invalid/collect')), reviewed, 'not the bridge: not the environment node');
  });

  test('the sync check compares the URL itself: a workflow reporting to another environment\'s ARC is reported', async () => {
    const e = { ...HANDLER_ENTRY, display_name: 'h', module_key: null, module_versions: [], action_types: [], runner_kind: 'n8n', export_path: 'workflows/x.json',
      checksum: await workflowChecksum(loadExport(ERROR_HANDLER)), input_contract_version: 1, output_contract_version: 1, effect_class: 'none',
      required_capabilities: [], auto_retry: false, timeout_ambiguous: false, error_handler: null };
    const sync = (held) => checkWorkflowSync({
      manifest: { manifest_version: 1, workflows: [e] },
      versions: [{ id: 'v', runnerKey: e.runner_key, workflowVersion: e.workflow_version, role: 'error_handler', moduleKey: null, moduleVersions: [], actionTypes: [],
        checksum: e.checksum, inputContractVersion: 1, outputContractVersion: 1, effectClass: 'none', autoRetry: false, errorHandlerKey: null, errorHandlerVersion: null, status: 'approved' }],
      deployments: [{ id: 'd', runnerKey: e.runner_key, workflowVersion: e.workflow_version, environment: 'staging', n8nWorkflowId: 'wf-h', webhookUrl: null }],
      assignments: [], environment: 'staging', n8n: { getWorkflow: async () => held }, bridgeUrl: BRIDGE,
    });
    assert.deepEqual(await sync(withUrl(BRIDGE)), []);
    assert.deepEqual((await sync(withUrl('https://prod.invalid/functions/v1/runner-bridge'))).map((f) => f.code), ['bridge_url_mismatch']);
  });
});

/* ══ ARC's side of a failure ═════════════════════════════ */

describe('ARC decides what a reported failure means, from what only ARC knows', () => {
  test('before the envelope opened, nothing can have happened: a plain failure, whatever the category', () => {
    for (const category of FAILURE_CATEGORY_KEYS) {
      const out = failureOutcome(category, { envelopeOpened: false, effectClass: 'external_effect' });
      assert.equal(out.status, 'failed', category);
    }
  });

  test('after it, an external effect is ambiguous unless the failure proves the provider did not act', () => {
    for (const [category, meta] of Object.entries(FAILURE_CATEGORIES)) {
      const out = failureOutcome(category, { envelopeOpened: true, effectClass: 'external_effect' });
      assert.deepEqual(out, meta.effectFree ? { status: 'failed', retryable: meta.retryable } : { status: 'ambiguous', retryable: false }, category);
    }
    assert.deepEqual(failureOutcome('provider_timeout', { envelopeOpened: true, effectClass: 'external_read' }), { status: 'failed', retryable: true }, 'a read is never ambiguous');
    assert.deepEqual(failureOutcome('provider_auth_failed', { envelopeOpened: true, effectClass: 'external_effect' }), { status: 'failed', retryable: false });
  });

  test('the roadmap\'s eight failure kinds each have a category', () => {
    for (const category of ['provider_timeout', 'provider_rate_limited', 'provider_auth_failed', 'validation_failed', 'unsupported_capability', 'ambiguous_result', 'n8n_internal', 'unexpected_exception']) {
      assert.ok(FAILURE_CATEGORY_KEYS.includes(category), category);
    }
  });

  test('a failure report is read strictly', () => {
    const good = {
      contract_version: 1, n8n_execution_id: '812', n8n_workflow_id: 'wf-9', error_category: 'provider_timeout', failed_node: 'Send envelope request',
      http_status: 504, reported_at: new Date().toISOString(), handler: { runner_key: 'arc-runner-error-handler-v1', workflow_version: '1.0.0' },
    };
    assert.equal(parseFailureReport(good).ok, true);
    for (const [bad, pattern] of [
      [{ ...good, message: 'the provider said no' }, /unknown fields: message/],
      [{ ...good, error_category: 'it_broke' }, /error_category is one of/],
      [{ ...good, http_status: 700 }, /http_status/],
      [{ ...good, failed_node: ['Bearer', 'x'.repeat(20)].join(' ') }, /looks like a credential/],
      [{ ...good, handler: { runner_key: 'arc-runner-error-handler-v1' } }, /handler is/],
      [{ ...good, tenant_id: crypto.randomUUID() }, /unknown fields: tenant_id/],
    ]) assert.match(parseFailureReport(bad).problem, pattern);
  });
});

/* ══ the shared error handler, run ═══════════════════════ */

describe('the shared error handler, run on n8n\'s error payloads', () => {
  function world() {
    const reports = [];
    const n8n = createN8n({
      credentials: CREDENTIALS, bridgeUrl: BRIDGE,
      http: async (url, { headers, body }) => {
        assert.equal(url, `${BRIDGE}/failure`);
        const verified = await verifyBridgeRequest(body, headers, CALLBACK_SECRET, nowSeconds(), 'failure');
        assert.equal(verified.ok, true, verified.code);
        const parsed = parseFailureReport(JSON.parse(body));
        assert.equal(parsed.ok, true, parsed.problem);
        reports.push({ report: parsed.value, raw: body, nonce: verified.nonce });
        return { status: 200, text: '{}' };
      },
    });
    n8n.deploy(loadExport(ERROR_HANDLER), 'wf-handler');
    return { n8n, reports };
  }
  const failed = (error, { node = 'Perform action', last = node, id = '812' } = {}) => [{
    json: {
      execution: { id, url: 'https://n8n.invalid/x', retryOf: null, error: { stack: 'hidden', ...error, ...(node ? { node: { name: node, type: 'x' } } : {}) }, lastNodeExecuted: last, mode: 'webhook' },
      workflow: { id: 'wf-action-3', name: 'arc-reference-action@1.0.0' },
    },
  }];

  const SAMPLES = [
    ['a provider rate limit', { message: 'Request failed with status code 429', httpCode: '429' }, {}, 'provider_rate_limited', 429],
    ['an authorization failure', { message: 'Request failed with status code 401', httpCode: '401' }, {}, 'provider_auth_failed', 401],
    ['a provider timeout, by status', { message: 'Gateway Timeout', httpCode: '504' }, {}, 'provider_timeout', 504],
    ['a provider timeout, by message', { message: 'timeout of 10000ms exceeded' }, {}, 'provider_timeout', null],
    ['a provider error', { message: 'Request failed with status code 500', httpCode: '500' }, {}, 'provider_error', 500],
    ['a validation failure', { message: 'Request failed with status code 422', httpCode: '422' }, {}, 'validation_failed', 422],
    ['an unreachable provider', { message: 'connect ECONNREFUSED 10.0.0.1:443' }, {}, 'provider_unreachable', null],
    ['an unsupported capability, said deliberately', { message: 'arc:unsupported_capability [line 7]' }, {}, 'unsupported_capability', null],
    ['an ambiguous result, said deliberately', { message: 'arc:ambiguous_result' }, {}, 'ambiguous_result', null],
    ['a dropped connection', { message: 'socket hang up' }, {}, 'ambiguous_result', null],
    ['a failure after the module step: the outcome is unknown', { message: 'Request failed with status code 409', httpCode: '409' }, { node: 'Send callback' }, 'ambiguous_result', 409],
    ['n8n itself', { message: 'Workflow could not be started', name: 'WorkflowOperationError' }, { node: null, last: null }, 'n8n_internal', null],
    ['anything else', { message: 'Cannot read properties of undefined (reading \'x\')', name: 'TypeError' }, {}, 'unexpected_exception', null],
  ];

  for (const [label, error, where, category, status] of SAMPLES) {
    test(`${label} → ${category}`, async () => {
      const { n8n, reports } = world();
      const run = await n8n.start('wf-handler', failed(error, where));
      assert.equal(run.status, 'success');
      assert.equal(reports.length, 1);
      const { report, raw } = reports[0];
      assert.deepEqual([report.error_category, report.http_status, report.n8n_execution_id, report.n8n_workflow_id], [category, status, '812', 'wf-action-3']);
      assert.deepEqual(report.handler, { runner_key: 'arc-runner-error-handler-v1', workflow_version: '1.0.0' });
      assert.ok(!raw.includes(error.message), 'the error\'s text never leaves n8n');
    });
  }

  test('a provider\'s words stay in n8n, however credential-shaped', async () => {
    const { n8n, reports } = world();
    await n8n.start('wf-handler', failed({ message: ['token rejected: Bearer', 'sk_live_', 'z'.repeat(20)].join(' '), httpCode: '401' }));
    assert.doesNotMatch(reports[0].raw, /sk_live|Bearer|rejected/);
  });

  test('a trigger that failed before any execution existed reports nothing', async () => {
    const { n8n, reports } = world();
    const run = await n8n.start('wf-handler', [{ json: { trigger: { error: { message: 'bad cron' }, mode: 'trigger' }, workflow: { id: 'wf-1', name: 'x' } } }]);
    assert.equal(run.status, 'success');
    assert.equal(reports.length, 0);
  });

  test('each report is signed once, with its own nonce', async () => {
    const { n8n, reports } = world();
    await n8n.start('wf-handler', failed({ message: 'x' }));
    await n8n.start('wf-handler', failed({ message: 'y' }));
    assert.notEqual(reports[0].nonce, reports[1].nonce);
  });

  test('the handler\'s category list is ARC\'s, word for word, and every category is reached above', () => {
    const code = loadExport(ERROR_HANDLER).nodes.find((n) => n.name === 'Prepare failure report').parameters.jsCode;
    const listed = /const CATEGORIES = \[([^\]]+)\]/.exec(code)[1].match(/'([a-z0-9_]+)'/g).map((s) => s.slice(1, -1));
    assert.deepEqual(listed, [...FAILURE_CATEGORY_KEYS]);
    assert.deepEqual([...new Set(SAMPLES.map((s) => s[3]))].sort(), [...FAILURE_CATEGORY_KEYS].sort());
  });
});

/* ══ the reference action workflow, run ══════════════════ */

describe('the reference action workflow speaks the bridge\'s contract, end to end (stand-in ARC, no database)', () => {
  const JOB = '44444444-4444-4444-8444-444444444444';
  const ACTION = '33333333-3333-4333-8333-333333333333';
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const NONCE = '77777777-7777-4777-8777-777777777777';
  const CORRELATION = '88888888-8888-4888-8888-888888888888';

  function world({ actionType = 'send_message', payload = {}, refuseCallback = false } = {}) {
    const seen = { envelope: [], callback: [], failure: [] };
    const n8n = createN8n({
      credentials: CREDENTIALS, bridgeUrl: BRIDGE,
      http: async (url, { headers, body }) => {
        const route = url.slice(BRIDGE.length + 1);
        const verified = await verifyBridgeRequest(body, headers, CALLBACK_SECRET, nowSeconds(), route);
        assert.equal(verified.ok, true, `${route}: ${verified.code}`);
        seen[route].push(JSON.parse(body));
        if (route === 'envelope') {
          const ask = parseEnvelopeRequest(JSON.parse(body));
          assert.equal(ask.ok, true, ask.problem);
          return { status: 200, text: JSON.stringify({ contract_version: 1, envelope: {
            contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, run_id: crypto.randomUUID(), module_key: 'lead_recovery', module_version: 1,
            action_type: actionType, effect_class: 'external_effect', run_mode: 'live', attempt: 1, config_refs: { config_snapshot_id: crypto.randomUUID() },
            idempotency_key: 'send:1', correlation_id: CORRELATION, connection: null, payload, expires_at: new Date(Date.now() + 300_000).toISOString(),
          } }) };
        }
        if (route === 'callback' && refuseCallback) return { status: 409, text: '{"error":"version_mismatch"}' };
        return { status: 200, text: '{}' };
      },
    });
    n8n.deploy(loadExport(ERROR_HANDLER), 'wf-handler');
    n8n.deploy(loadExport(REFERENCE_ACTION), 'wf-action', { errorWorkflow: 'wf-handler' });
    return { n8n, seen };
  }

  async function dispatch(n8n, { secret = DISPATCH_SECRET } = {}) {
    const body = JSON.stringify({
      contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, module_key: 'lead_recovery', module_version: 1,
      runner_key: 'arc-reference-action', workflow_version: '1.0.0', attempt: 1, config_refs: { config_snapshot_id: crypto.randomUUID() },
      idempotency_key: 'send:1', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(), correlation_id: CORRELATION, nonce: NONCE,
    });
    const token = await signDispatchToken({
      iss: 'arc', aud: 'arc-reference-action', sub: JOB, jti: NONCE, iat: nowSeconds(), exp: nowSeconds() + 300, tenant_id: TENANT, body_sha256: await sha256Hex(body),
    }, secret);
    return await n8n.webhook('https://n8n.invalid/webhook/arc-reference-action', { headers: { Authorization: `Bearer ${token}` }, body });
  }

  test('ARC\'s dispatch is answered at once with the execution id; the envelope and the callback follow, each as ARC reads them', async () => {
    const { n8n, seen } = world();
    const answer = await dispatch(n8n);
    assert.deepEqual([answer.status, typeof answer.body.n8n_execution_id], [202, 'string']);
    assert.equal(seen.envelope.length, 0, 'nothing more happens until n8n carries on after answering');
    await n8n.drain();
    assert.deepEqual(seen.envelope, [{ contract_version: 1, job_id: JOB, action_id: ACTION, tenant_id: TENANT, nonce: NONCE }]);
    assert.equal(seen.callback.length, 1);
    const cb = parseCallback(seen.callback[0]);
    assert.equal(cb.ok, true, cb.problem);
    assert.deepEqual([cb.value.status, cb.value.runner_key, cb.value.workflow_version, cb.value.n8n_execution_id, cb.value.idempotency_key, cb.value.correlation_id],
      ['succeeded', 'arc-reference-action', '1.0.0', answer.body.n8n_execution_id, 'send:1', CORRELATION]);
    assert.equal(seen.failure.length, 0);
  });

  test('a dispatch not signed with ARC\'s secret never starts', async () => {
    const { n8n, seen } = world();
    const other = new SecretValue(['someone', 'elses', 'secret', 'z'.repeat(24)].join('-'));
    const answer = await dispatch(n8n, { secret: other });
    assert.equal(answer.status, 403);
    await n8n.drain();
    assert.deepEqual([seen.envelope.length, n8n.executions.length], [0, 0]);
  });

  test('a module step that fails reports nothing itself: the error handler reports the execution, by id', async () => {
    const { n8n, seen } = world({ payload: { reference_outcome: 'fail:provider_rate_limited' } });
    const answer = await dispatch(n8n);
    await n8n.drain();
    assert.equal(seen.callback.length, 0);
    assert.equal(seen.failure.length, 1);
    assert.deepEqual([seen.failure[0].error_category, seen.failure[0].n8n_execution_id, seen.failure[0].n8n_workflow_id, seen.failure[0].failed_node],
      ['provider_rate_limited', answer.body.n8n_execution_id, 'wf-action', 'Perform action']);
    assert.equal(JSON.stringify(seen.failure[0]).includes(JOB), false, 'the report names the execution, never the job');
  });

  test('an action type the workflow does not handle is unsupported; a crash is unexpected', async () => {
    for (const [options, category] of [[{ actionType: 'call_provider_operation' }, 'unsupported_capability'], [{ payload: { reference_outcome: 'crash' } }, 'unexpected_exception']]) {
      const { n8n, seen } = world(options);
      await dispatch(n8n);
      await n8n.drain();
      assert.deepEqual(seen.failure.map((f) => f.error_category), [category]);
    }
  });

  test('a callback ARC refuses happened after the module step: reported as an unknown outcome', async () => {
    const { n8n, seen } = world({ refuseCallback: true });
    await dispatch(n8n);
    await n8n.drain();
    assert.deepEqual(seen.failure.map((f) => [f.error_category, f.failed_node, f.http_status]), [['ambiguous_result', 'Send callback', 409]]);
  });

  test('skipped work is reported as skipped, with no provider reference', async () => {
    const { n8n, seen } = world({ payload: { reference_outcome: 'skip' } });
    await dispatch(n8n);
    await n8n.drain();
    assert.deepEqual([seen.callback[0].status, seen.callback[0].provider_refs], ['skipped', []]);
  });

  test('the repository keeps the placeholder; the simulator\'s import set this environment\'s bridge', () => {
    const stored = loadExport(REFERENCE_ACTION).nodes.find((n) => n.name === 'ARC environment').parameters.assignments.assignments[0].value;
    assert.equal(stored, BRIDGE_URL_PLACEHOLDER);
  });
});
