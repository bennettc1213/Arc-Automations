/* ARC-320 — the activation console: connections, readiness, tests and activation.
 *
 *   1. The words (`activation/model.ts`): one vocabulary for the server and the screen.
 *   2. The ops actions over the in-memory stores and the synthetic providers: what blocks
 *      activation, who may press it, and that no response carries a credential.
 *   3. `ConnectionTestRunner`: the runner contract, and a failed verification reported as
 *      ARC's own code and sentence.
 *   4. What renders: the real panel, drawn from the real `activation-overview` answer.
 *
 * The durable half — the run, the action, the attempt, pause and resume at the claim — is
 * `tests/activation-db.test.js`, on real SQL: the scheduler has no in-memory twin.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { endConnection, storeApiKey } from '../supabase/functions/_shared/connections/service.ts';
import { setConnectionLogSink } from '../supabase/functions/_shared/connections/redact.ts';
import { RUNNER_CONTRACT_VERSION, validateRunnerResult } from '../supabase/functions/_shared/runner/model.ts';
import {
  activationImpact,
  connectionDisplay,
  connectionTestVerdict,
  credentialHint,
  liveRunVerdict,
  readinessChecklist,
} from '../supabase/functions/_shared/activation/model.ts';
import { ConnectionTestRunner, requestConnectionTest } from '../supabase/functions/_shared/activation/connection-test.ts';
import { handleActivationAction } from '../supabase/functions/ops/activation.ts';
import { handleLifecycleAction } from '../supabase/functions/ops/lifecycle.ts';
import { connectOAuth, OWNER_A, TENANT_A, TENANT_B, world } from './connection-fixtures.js';
import { FIXTURE_OPERATOR, leadRecoveryConfig, seedLifecycle, seedPublishedConfig } from './config-fixtures.js';
import { leakedSentinels, sentinelApiKey } from './synthetic-provider.js';
import { runnerContract } from './runner-contract.js';

afterEach(() => setConnectionLogSink(null));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LR = 'lead_recovery';
const STRANGER = 'ffffffff-0000-4000-8000-0000000000ff';

/* ── fixtures ───────────────────────────────────────────── */

/** Lead Recovery published and paused on tested, authorised versions — one press from live. */
async function pausedLeadRecovery({ attested = true } = {}) {
  const w = await world({ store: new MemoryStore() });
  seedPublishedConfig(w.store, { tenantId: TENANT_A, config: leadRecoveryConfig(), enabled: true });
  seedLifecycle(w.store, { tenantId: TENANT_A, state: 'paused' });
  if (!attested) w.store.onboardingSteps = w.store.onboardingSteps.filter((s) => s.stepKey !== 'twilio_connected');
  return w;
}

const noScheduler = new Proxy({}, { get: () => () => { throw new Error('the scheduler was reached'); } });

const context = (w, body, actorId = FIXTURE_OPERATOR, extra = {}) => ({
  store: w.store,
  scheduler: noScheduler,
  tests: null,
  body: { tenant_id: TENANT_A, module_key: LR, ...body },
  actorId,
  audit: async () => true,
  runners: async () => ({ registry: null, reason: 'no runners in this test' }),
  ...extra,
});

const overview = async (w) => {
  const res = await handleActivationAction('activation-overview', context(w, {}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const lifecycleAction = async (w, action, actorId = FIXTURE_OPERATOR) => {
  const version = (await w.store.getLifecycle(TENANT_A, LR))?.stateVersion ?? 0;
  return await handleLifecycleAction(action, { store: w.store, actorId, body: { tenant_id: TENANT_A, module_key: LR, expected_state_version: version } });
};

const providerOf = (data, capability, connector) =>
  data.requirements.flatMap((r) => r.capabilities).find((c) => c.key === capability)?.providers.find((p) => p.connector_key === connector);

/* ══ 1. the words ═════════════════════════════════════════ */

describe('what a connection is called', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const at = (status, extra = {}) => connectionDisplay({ status, ...extra }, { connectable: true, now });

  test('the roadmap\'s six words, and never "connected" for a token nobody verified', () => {
    assert.equal(connectionDisplay(null, { connectable: true }), 'missing');
    assert.equal(connectionDisplay(null, { connectable: false }), 'unsupported');
    assert.equal(at('verified'), 'connected');
    assert.equal(at('reauthorization_required'), 'needs_reauth');
    assert.equal(at('revoked'), 'revoked');
    assert.equal(at('verified', { access_expires_at: '2026-09-30T11:00:00Z', refreshable: false }), 'expired');
    assert.equal(at('connected_unverified'), 'unverified', 'a stored credential is not readiness');
  });

  test('the in-between states keep their own words, and an unknown status is unusable', () => {
    assert.equal(at('degraded'), 'degraded');
    assert.equal(at('disconnected'), 'disconnected');
    assert.equal(at('authorization_pending'), 'pending');
    assert.equal(at('failed'), 'failed');
    assert.equal(at('verified', { access_expires_at: '2026-09-30T11:00:00Z', refreshable: true }), 'connected', 'a refreshable token is not expired');
    assert.equal(at('mystery'), 'unknown');
  });

  test('the credential hint is at most four characters — anything else is only "stored"', () => {
    assert.equal(credentialHint({ hint: 'a1b2', stored: true }), '••••a1b2');
    assert.equal(credentialHint({ hint: 'SENTINEL-AT-abcdef', stored: true }), 'stored');
    assert.equal(credentialHint({ hint: 'a1b2', stored: false }), null);
    assert.equal(credentialHint(null), null);
  });
});

describe('the readiness checklist and the impact of going live', () => {
  test('every blocker lands under one line, and a code nobody grouped is shown, not dropped', () => {
    const items = readinessChecklist({
      ok: false,
      blockers: [
        { code: 'connection_not_ready', message: 'messaging: send_sms is missing' },
        { code: 'test_evidence_missing', message: 'run the canary' },
        { code: 'something_new', message: 'a reason from a newer build' },
      ],
      shadow: { required: false, satisfied: false },
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    assert.equal(byKey.connections.state, 'blocked');
    assert.equal(byKey.connections.detail, 'messaging: send_sms is missing');
    assert.equal(byKey.test.state, 'blocked');
    assert.equal(byKey.configuration.state, 'ok');
    assert.equal(byKey.shadow.state, 'not_required');
    assert.equal(byKey.other.detail, 'a reason from a newer build');
  });

  test('a live run is only ever "allowed" when ARC-120 says so; shadow says nothing is sent', () => {
    assert.equal(liveRunVerdict({ state: 'active', live: true, holds: [] }).allowed, true);
    const held = liveRunVerdict({ state: 'active', live: false, holds: [{ code: 'health_blocks_execution', message: 'health is failing' }] });
    assert.equal(held.allowed, false);
    assert.equal(held.holds[0].code, 'health_blocks_execution');
    assert.match(liveRunVerdict({ state: 'shadow', live: false, holds: [] }).sentence, /nothing is sent/);
    assert.equal(liveRunVerdict(null).allowed, false);
  });

  test('the impact of activating names what it authorises and what it clears', () => {
    const heads = { tenant_version_id: 't2', module_version_id: 'm3' };
    const first = activationImpact({ lifecycle: { authorized: null, observed: heads, pending_requirements: [] }, heads });
    assert.equal(first.changesAuthorization, true);
    assert.match(first.sentences[0], /for the first time/);
    const unevaluated = activationImpact({ lifecycle: { authorized: heads, observed: { tenant_version_id: 't1', module_version_id: 'm3' } }, heads });
    assert.equal(unevaluated.unevaluatedChange, true);
    const cleared = activationImpact({ lifecycle: { authorized: heads, observed: heads, pending_requirements: ['reactivation', 'retest'] }, heads });
    assert.deepEqual(cleared.clears, ['retest', 'reactivation']);
    assert.equal(cleared.changesAuthorization, false);
  });

  test('a connection test reads as ARC\'s rows say — queued, held, passed or failed with its code', () => {
    assert.equal(connectionTestVerdict(null).word, 'never tested');
    assert.equal(connectionTestVerdict({ action_status: 'done', outcome: 'succeeded' }).word, 'passed');
    assert.equal(connectionTestVerdict({ action_status: 'pending', gate: { code: 'module_not_active', detail: 'the module is configuring' } }).word, 'held');
    const failed = connectionTestVerdict({ action_status: 'failed', outcome: 'failed', error_code: 'invalid_credential', message: 'the provider refused the key' });
    assert.equal(failed.word, 'failed');
    assert.equal(failed.sentence, 'invalid_credential — the provider refused the key');
  });
});

/* ══ 2. the ops actions ═══════════════════════════════════ */

describe('activation, and what stops it', () => {
  test('without a signed-in operator nothing is read and nothing is requested', async () => {
    const w = await pausedLeadRecovery();
    assert.equal((await handleActivationAction('activation-overview', context(w, {}, null))).status, 401);
    assert.equal((await handleActivationAction('connection-test', context(w, { connection_id: crypto.randomUUID() }, null))).status, 401);
  });

  test('a missing connection blocks activation, and the console says which capability and which provider', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    const res = await lifecycleAction(w, 'module-resume');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'connection_not_ready');
    assert.ok(res.body.blockers.some((b) => b.code === 'connection_not_ready' && /send_sms/.test(b.message)));
    assert.equal((await w.store.getLifecycle(TENANT_A, LR)).state, 'paused', 'nothing changed');

    const data = await overview(w);
    assert.equal(data.status.readiness.ok, false);
    const connections = readinessChecklist(data.status.readiness).find((i) => i.key === 'connections');
    assert.equal(connections.state, 'blocked');
    const sms = data.requirements.flatMap((r) => r.capabilities).find((c) => c.key === 'send_sms');
    assert.notEqual(sms.status, 'ready');
    assert.equal(providerOf(data, 'send_sms', 'synthetic_oauth').connection, null);
    assert.equal(providerOf(data, 'send_sms', 'synthetic_oauth').connectable, true);
    assert.equal(providerOf(data, 'send_sms', 'twilio').owner, 'arc', 'Twilio is ARC\'s account, proven by attestation');
  });

  test('a revoked connection blocks activation that a verified one satisfied', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    const { done } = await connectOAuth(w);
    let data = await overview(w);
    assert.equal(providerOf(data, 'send_sms', 'synthetic_oauth').connection.display, 'connected');
    assert.equal(data.requirements.flatMap((r) => r.capabilities).find((c) => c.key === 'send_sms').status, 'ready');
    assert.ok(!data.status.readiness.blockers.some((b) => /send_sms/.test(b.message)), 'the verified connection proves send_sms');

    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'revoke' });
    data = await overview(w);
    assert.equal(providerOf(data, 'send_sms', 'synthetic_oauth').connection.display, 'revoked');
    const res = await lifecycleAction(w, 'module-resume');
    assert.equal(res.status, 409);
    /* the loss also marked the capabilities failing on the health overlay (ARC-130 §12). */
    assert.ok(res.body.blockers.some((b) => b.code === 'connection_not_ready' && /send_sms/.test(b.message)), JSON.stringify(res.body.blockers));
    assert.equal(data.status.lifecycle.health.status, 'failing');
  });

  test('activation requires an operator: no one and a stranger are both refused, and nothing moves', async () => {
    const w = await pausedLeadRecovery();
    const before = await w.store.getLifecycle(TENANT_A, LR);
    const nobody = await lifecycleAction(w, 'module-resume', null);
    assert.equal(nobody.status, 401);
    const stranger = await lifecycleAction(w, 'module-resume', STRANGER);
    assert.equal(stranger.body.code, 'forbidden');
    assert.equal(stranger.status, 403);
    const after = await w.store.getLifecycle(TENANT_A, LR);
    assert.equal(after.stateVersion, before.stateVersion);
    const operator = await lifecycleAction(w, 'module-resume');
    assert.equal(operator.status, 200, JSON.stringify(operator.body));
    assert.equal((await w.store.getLifecycle(TENANT_A, LR)).state, 'active');
  });

  test('the overview never carries a credential — only the four-character hint', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    await connectOAuth(w);
    const key = w.provider.registerApiKey(sentinelApiKey());
    await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: key } });
    const data = await overview(w);
    const text = JSON.stringify(data);
    assert.deepEqual(leakedSentinels(text, w.provider), []);
    assert.doesNotMatch(text, /vault|refresh_token|access_token|lease/i);
    const keyed = providerOf(data, 'classify_text', 'synthetic_api_key').connection;
    assert.equal(keyed.hint, `••••${key.slice(-4)}`);
    assert.deepEqual(providerOf(data, 'classify_text', 'synthetic_api_key').credential_fields, ['api_key'], 'field names, never values');
  });

  test('the overview joins the module to ARC-120\'s status, evidence and version numbers', async () => {
    const w = await pausedLeadRecovery();
    const data = await overview(w);
    assert.equal(data.module.key, LR);
    assert.equal(data.module.test_action, 'lead-recovery-canary');
    assert.equal(data.status.lifecycle.state, 'paused');
    assert.ok(data.status.transitions.includes('resume'));
    assert.equal(data.evidence.test.outcome, 'passed');
    assert.deepEqual(data.versions.heads, data.versions.authorized, 'paused on the versions it was authorised for');
    assert.equal(typeof data.versions.heads.module, 'number');
  });
});

describe('requesting a connection test, before anything durable is written', () => {
  test('an ended connection, another client\'s, or a module not under test is refused without reaching the scheduler', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    const { done } = await connectOAuth(w);
    const theirs = await connectOAuth(w, { tenantId: TENANT_B, actorId: 'bbbbbbbb-0000-4000-8000-00000000000a' }).catch(() => null);

    const deps = { store: w.store, scheduler: noScheduler };
    const req = (connectionId, extra = {}) => requestConnectionTest(deps, { tenantId: TENANT_A, moduleKey: LR, connectionId, actorId: FIXTURE_OPERATOR, ...extra });

    assert.equal((await req(done.connection.id, { actorId: null })).code, 'unauthorized');
    if (theirs) assert.equal((await req(theirs.done.connection.id)).code, 'not_found');
    assert.equal((await req('not-a-uuid')).code, 'invalid_request');

    seedLifecycle(w.store, { tenantId: TENANT_A, state: 'configuring' });
    assert.equal((await req(done.connection.id)).code, 'module_not_testing');

    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'disconnect' });
    assert.equal((await req(done.connection.id)).code, 'connection_ended');
  });
});

/* ══ 3. the connection-test runner ═══════════════════════ */

/* the OAuth synthetic, not the key one: a connector literally named `synthetic_api_key` is
   refused by the runner contract's own secret-shape rule before any provider is asked. */
async function connectedWorld() {
  const w = await world({ store: new MemoryStore() });
  const { done } = await connectOAuth(w);
  let n = 0;
  const request = (overrides = {}) => {
    n += 1;
    return {
      contractVersion: RUNNER_CONTRACT_VERSION,
      runnerKind: 'arc_connection_test',
      tenantId: TENANT_A,
      runId: crypto.randomUUID(),
      actionId: crypto.randomUUID(),
      attemptId: `attempt-${n}`,
      attemptNumber: 1,
      moduleKey: LR,
      moduleVersion: 1,
      actionType: 'test_connection',
      effectClass: 'external_read',
      configSnapshotId: crypto.randomUUID(),
      runMode: 'test',
      correlationId: crypto.randomUUID(),
      idempotencyKey: `test_connection:${n}`,
      connection: { connectionId: done.connection.id, connectorKey: 'synthetic_oauth' },
      payload: { requested_by: 'activation_console' },
      issuedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 20_000).toISOString(),
      ...overrides,
    };
  };
  return { w, connection: done.connection, runner: new ConnectionTestRunner(w.deps), request };
}

describe('ConnectionTestRunner', () => {
  runnerContract('ConnectionTestRunner', async () => {
    const { runner, request } = await connectedWorld();
    return { runner, request };
  });

  test('a verification that passes reports the status and capabilities, and nothing secret', async () => {
    const { w, runner, request } = await connectedWorld();
    const result = await runner.dispatch(request(), new AbortController().signal);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.deepEqual({ ...result.evidence, verified_capabilities: [...result.evidence.verified_capabilities].sort() },
      { connector_key: 'synthetic_oauth', connection_status: 'verified', verified_capabilities: ['receive_sms', 'send_sms'], serves: true });
    assert.deepEqual(leakedSentinels(result, w.provider), []);
  });

  test('a provider outage is a retryable failure with ARC\'s own sentence; a revoked grant is not retryable', async () => {
    const { w, runner, request } = await connectedWorld();
    w.provider.next.userinfo = 'unavailable';
    const down = await runner.dispatch(request(), new AbortController().signal);
    assert.equal(validateRunnerResult(down).ok, true);
    assert.deepEqual([down.status, down.errorCode, down.retryable], ['failed', 'provider_unavailable', true]);

    w.provider.revokeAtProvider();
    const rejected = await runner.dispatch(request(), new AbortController().signal);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.retryable, false);
    assert.notEqual(rejected.errorCode, 'provider_unavailable');
    assert.deepEqual(leakedSentinels(rejected, w.provider), []);
    assert.equal(w.store.providerConnections[0].status, 'reauthorization_required', 'ARC-130 recorded what the provider said — the runner wrote nothing itself');
  });

  test('it runs only connection tests, only in test mode, and contacts nothing when refusing', async () => {
    const { w, runner, request } = await connectedWorld();
    const calls = w.provider.calls.length;
    for (const bad of [request({ actionType: 'send_message', effectClass: 'external_effect' }), request({ runMode: 'live' }), request({ connection: null })]) {
      const result = await runner.dispatch(bad, new AbortController().signal);
      assert.deepEqual([result.status, result.errorCode], ['failed', 'runner_request_refused']);
    }
    assert.equal(w.provider.calls.length, calls);
    assert.deepEqual(runner.describeCapabilities(), { actionTypes: ['test_connection'], runModes: ['test'] });
  });
});

/* ══ 4. what renders ══════════════════════════════════════ */

async function loadComponents() {
  const { build } = await import('esbuild');
  const stub = {
    name: 'supabase-stub',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\/(\.\.\/)*(lib\/)?supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: "export const anonKey = ''; export const functionUrl = (n) => '/functions/v1/' + n; export const getSupabase = () => null; export const isConfigured = false;",
        loader: 'js',
      }));
    },
  };
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import ActivationPanel from './src/portal/components/ActivationPanel.jsx';",
        "export { takeCallbackParams } from './src/portal/pages/ConnectionCallback.jsx';",
        'const never = { overview: () => new Promise(() => {}) };',
        /* the panel has no links, so it renders without a router. */
        'export const renderPanel = (props) => renderToStaticMarkup(createElement(ActivationPanel, { tenantId: "t-1", moduleKey: "lead_recovery", api: never, ...props }));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx' },
    plugins: [stub],
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'activation-ui-'));
  const file = path.join(dir, 'activation.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { renderPanel, takeCallbackParams } = await loadComponents();

describe('the activation panel', () => {
  test('loading is said, not drawn as an empty page', () => {
    assert.match(renderPanel(), /reading the module’s lifecycle, connections and evidence…/);
  });

  test('a module that is not selected says so, and still shows what it would need', async () => {
    const w = await world({ store: new MemoryStore() });
    seedPublishedConfig(w.store, { tenantId: TENANT_A, config: leadRecoveryConfig(), lifecycle: false });
    const html = renderPanel({ initial: await overview(w) });
    assert.match(html, /is not selected for this client/);
    assert.match(html, /send_sms/);
  });

  test('blocked reasons are displayed, and activation is disabled while readiness says no', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    const html = renderPanel({ initial: await overview(w) });
    assert.match(html, /send_sms/);
    assert.match(html, /nobody has attested the Twilio resources are connected/);
    assert.match(html, /connections ready/);
    assert.match(html, /<button[^>]*disabled=""[^>]*title="blocked: [^"]+"[^>]*>.*resume/s, 'resume is disabled with the first reason');
    assert.match(html, /resume is disabled until every line of the readiness checklist below passes/);
  });

  test('with every check passing, resume is offered — the server still re-checks it', async () => {
    const w = await pausedLeadRecovery();
    const html = renderPanel({ initial: await overview(w) });
    assert.match(html, /every activation check passes/);
    assert.doesNotMatch(html, /title="blocked:/);
    assert.match(html, /resume<\/button>/);
  });

  test('a token is never rendered — the four-character hint, and nothing else of the credential', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    await connectOAuth(w);
    const key = w.provider.registerApiKey(sentinelApiKey());
    await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: key } });
    const data = await overview(w);
    /* and even if a response somehow carried one in a field the panel has no business showing. */
    const tampered = structuredClone(data);
    const oauth = providerOf(tampered, 'send_sms', 'synthetic_oauth').connection;
    oauth.account.metadata = { note: 'SENTINEL-AT-planted' };
    oauth.granted_scopes = ['SENTINEL-RT-planted'];
    const html = renderPanel({ initial: tampered });
    assert.deepEqual(leakedSentinels(html, w.provider), []);
    assert.match(html, new RegExp(`••••${key.slice(-4)}`));
    assert.match(html, /connected/);
  });

  test('the latest connection test is shown with its code and ARC\'s own sentence', async () => {
    const w = await pausedLeadRecovery({ attested: false });
    await connectOAuth(w);
    const data = await overview(w);
    const failed = {
      connection_id: providerOf(data, 'send_sms', 'synthetic_oauth').connection.id, connector_key: 'synthetic_oauth', run_id: 'r1', action_id: 'a1',
      run_status: 'failed', action_status: 'failed', requested_at: '2026-09-30T12:00:00Z', completed_at: '2026-09-30T12:00:01Z', attempts: 1,
      outcome: 'failed', error_code: 'invalid_credential', message: 'the provider refused this key', evidence: {}, gate: null,
    };
    providerOf(data, 'send_sms', 'synthetic_oauth').connection.latest_test = failed;
    providerOf(data, 'receive_sms', 'synthetic_oauth').connection.latest_test = failed;
    data.tests = [failed];
    const html = renderPanel({ initial: data });
    assert.match(html, /last test: <b>failed<\/b> — invalid_credential — the provider refused this key/);
    assert.match(html, /connection tests/);
  });

  test('shadow says nothing is sent; health, history and the impact of going live are drawn', async () => {
    const w = await world({ store: new MemoryStore() });
    seedPublishedConfig(w.store, { tenantId: TENANT_A, config: leadRecoveryConfig(), enabled: true });
    seedLifecycle(w.store, { tenantId: TENANT_A, state: 'shadow', health: 'degraded' });
    const html = renderPanel({ initial: await overview(w) });
    assert.match(html, /shadow — nothing is sent/);
    assert.match(html, /health degraded/);
    assert.match(html, /transition history/);
    assert.match(html, /what going live would change/);
    assert.match(html, /accept what shadow observed/);
  });

  test('read-only for a deboarded client: everything shown, nothing to press', async () => {
    const w = await pausedLeadRecovery();
    const html = renderPanel({ initial: await overview(w), readOnly: true });
    assert.match(html, /read-only/);
    assert.doesNotMatch(html, />resume<|>pause<|run the synthetic test|connect with a key|>record</);
  });
});

describe('the OAuth callback page', () => {
  test('the code and state are read once and stripped from the address bar before anything else', () => {
    const replaced = [];
    const params = takeCallbackParams(
      { href: 'https://arc.example.test/portal/dashboard/connections/callback?state=s-123&code=SENTINEL-CODE-x' },
      { replaceState: (_s, _t, url) => replaced.push(url) },
    );
    assert.deepEqual(params, { state: 's-123', code: 'SENTINEL-CODE-x', error: null, errorDescription: null });
    assert.deepEqual(replaced, ['/portal/dashboard/connections/callback'], 'history keeps the path and nothing of the query');
  });
});
