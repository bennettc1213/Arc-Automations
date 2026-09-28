/* ARC-220 — the n8n runner bridge without a database: signing both directions, the three
 * wire messages, and `N8nRunner` against an in-process n8n double. Nothing here reaches a
 * network; `tests/n8n-runner-db.test.js` runs the whole bridge on real SQL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { SecretValue } from '../supabase/functions/_shared/connections/redact.ts';
import { resolveRuntimeEnvironment } from '../supabase/functions/_shared/connections/runtime-env.ts';
import { findSecretShaped } from '../supabase/functions/_shared/scheduler/model.ts';
import { validateRunnerResult } from '../supabase/functions/_shared/runner/model.ts';
import { buildRunnerRequest } from '../supabase/functions/_shared/runner/orchestrator.ts';
import {
  BRIDGE_HEADERS, sha256Hex, signBridgeRequest, signDispatchToken, verifyBridgeRequest, verifyDispatchToken,
} from '../supabase/functions/_shared/n8n-runner/signing.ts';
import { callbackOutcome, callbackToResult, dispatchBody, envelopeFrom, parseCallback, parseEnvelopeRequest } from '../supabase/functions/_shared/n8n-runner/contract.ts';
import { N8nRunner } from '../supabase/functions/_shared/n8n-runner/runner.ts';
import { BridgeError, parseBridgeError } from '../supabase/functions/_shared/n8n-runner/store.ts';
import { handleCallback, handleEnvelopeRequest } from '../supabase/functions/_shared/n8n-runner/inbound.ts';
import { runnerContract } from './runner-contract.js';

const N8N_DIR = new URL('../supabase/functions/_shared/n8n-runner/', import.meta.url);

/* secrets are built from parts so no credential-shaped literal sits in the repository. */
const DISPATCH_SECRET = new SecretValue(['dispatch', 'secret', 'for', 'tests', 'only', 'x'.repeat(12)].join('-'));
const CALLBACK_SECRET = new SecretValue(['callback', 'secret', 'for', 'tests', 'only', 'y'.repeat(12)].join('-'));
const OTHER_SECRET = new SecretValue(['someone', 'elses', 'secret', 'z'.repeat(24)].join('-'));

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ACTION = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '55555555-5555-4555-8555-555555555555';
const CONNECTION = '66666666-6666-4666-8666-666666666666';
const URL_SEND = 'https://n8n.invalid/webhook/arc-send-message';
const ROUTES = { send_message: { runnerKey: 'arc-send-message-v1', workflowVersion: '1.0.0', url: URL_SEND } };

const nowSeconds = () => Math.floor(Date.now() / 1000);

const aRun = () => ({
  id: RUN, tenantId: TENANT, runKind: 'connector_test', moduleKey: 'some_module', moduleVersion: 1, leadId: null,
  configSnapshotId: SNAPSHOT, runMode: 'test', lifecycleStateAtStart: 'testing', runnerKind: 'n8n', status: 'running',
  statusReason: null, terminalCode: null, correlationId: '77777777-7777-4777-8777-777777777777', idempotencyKey: 'run:1',
  createdByType: 'system', createdBy: null, createdAt: '2026-09-26T10:00:00.000Z', startedAt: null, completedAt: null, updatedAt: '2026-09-26T10:00:00.000Z',
});
const anAction = () => ({
  id: ACTION, tenantId: TENANT, runId: RUN, moduleKey: 'some_module', actionType: 'send_message',
  scheduledFor: '2026-09-26T10:00:00.000Z', runAt: '2026-09-26T10:00:00.000Z', status: 'running', idempotencyKey: 'send:lead-7:step-1',
  attempts: 1, maxAttempts: 5, lockedBy: 'w', leaseToken: crypto.randomUUID(), leaseExpiresAt: null, fence: 1,
  connectorKey: 'synthetic_sms', connectionId: CONNECTION, payload: { template: 'followup_1', to: '+16145550137', body: 'Hi Sam' },
  configSnapshotId: SNAPSHOT, gate: null, lastError: null, createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', completedAt: null,
});
const aRequest = (overrides = {}) => {
  const built = buildRunnerRequest({
    run: aRun(), action: anAction(), runnerKind: 'n8n', attemptId: crypto.randomUUID(), attemptNumber: 1,
    issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + 90_000).toISOString(),
  });
  assert.equal(built.ok, true, built.message);
  return { ...built.value, ...overrides };
};

const ASSIGNMENT = '88888888-8888-4888-8888-888888888888';

/**
 * A ledger double: records what the runner asks of it, resolves the one assignment it was
 * given (0019 decides this for real in `n8n-runner-db`), and whether the envelope "opened".
 */
function ledger({ opened = false, failRecord = false, resolve = null, recorded = null } = {}) {
  const calls = [];
  const route = { code: 'ok', assignmentId: ASSIGNMENT, runnerKey: ROUTES.send_message.runnerKey, workflowVersion: ROUTES.send_message.workflowVersion, webhookUrl: URL_SEND };
  return {
    calls, opened,
    async resolveWorkflow(moduleKey, moduleVersion, actionType, environment) {
      calls.push(['resolve', `${moduleKey}@${moduleVersion}/${actionType}/${environment}`]);
      return { ...route, ...(resolve ?? {}) };
    },
    async recordDispatch(d) {
      calls.push(['record', d]);
      if (failRecord) throw new Error('database unavailable');
      return recorded ?? { runnerKey: route.runnerKey, workflowVersion: route.workflowVersion, workflowChecksum: `sha256:${'c'.repeat(64)}` };
    },
    async correlate(attemptId, tenantId, id) { calls.push(['correlate', id]); return 'ok'; },
    async voidDispatch(attemptId, tenantId, reason) { calls.push(['void', reason]); return this.opened ? 'envelope_opened' : 'voided'; },
  };
}

/** An n8n double: answers each POST with `answer` and each executions-API GET from `executions`. */
function n8n({ answer = { status: 202, body: { n8n_execution_id: 'exec-1' } }, executions = {} } = {}) {
  const seen = [];
  const transport = async (request) => {
    seen.push(request);
    if (request.method === 'GET') {
      const id = decodeURIComponent(request.url.split('/').pop());
      return id in executions ? { status: 200, body: { status: executions[id] } } : { status: 404, body: null };
    }
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(request) : answer;
  };
  return { transport, seen };
}

const runner = ({ environment = 'test', l = ledger(), t = n8n(), ...rest } = {}) => new N8nRunner({
  environment, actionTypes: ['send_message'], dispatchSecret: DISPATCH_SECRET, ledger: l, transport: t.transport,
  executionsApi: { url: 'https://n8n.invalid', apiKey: new SecretValue('n8n-api-key-for-tests') }, ...rest,
});

/* ══ the contract every runner passes ═════════════════════ */

runnerContract('N8nRunner', () => {
  const t = n8n({ executions: { 'exec-1': 'running' } });
  return { runner: runner({ t }), request: (o) => aRequest(o) };
});

/* ══ signing ══════════════════════════════════════════════ */

describe('ARC → n8n: a short-lived JWT bound to one body, one attempt and one nonce', () => {
  const claims = (o = {}) => ({ iss: 'arc', aud: 'arc-send-message-v1', sub: ACTION, jti: crypto.randomUUID(), iat: nowSeconds(), exp: nowSeconds() + 300, tenant_id: TENANT, body_sha256: 'a'.repeat(64), ...o });

  test('a token ARC signs verifies with the dispatch secret, and with nothing else', async () => {
    const token = await signDispatchToken(claims(), DISPATCH_SECRET);
    const ok = await verifyDispatchToken(token, DISPATCH_SECRET, nowSeconds());
    assert.equal(ok.ok, true);
    assert.equal(ok.claims.aud, 'arc-send-message-v1');
    assert.equal((await verifyDispatchToken(token, OTHER_SECRET, nowSeconds())).code, 'bad_signature');
  });

  test('a tampered, expired or unsigned token is refused', async () => {
    const token = await signDispatchToken(claims(), DISPATCH_SECRET);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ tenant_id: '99999999-9999-4999-8999-999999999999' }))).toString('base64url');
    assert.equal((await verifyDispatchToken(`${h}.${forged}.${s}`, DISPATCH_SECRET, nowSeconds())).code, 'bad_signature');
    const old = await signDispatchToken(claims({ exp: nowSeconds() - 1 }), DISPATCH_SECRET);
    assert.equal((await verifyDispatchToken(old, DISPATCH_SECRET, nowSeconds())).code, 'expired');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    assert.equal((await verifyDispatchToken(none, DISPATCH_SECRET, nowSeconds())).code, 'malformed');
  });

  test('a short secret is refused rather than used', async () => {
    await assert.rejects(signDispatchToken(claims(), new SecretValue('short')), /at least 32/);
  });
});

describe('n8n → ARC: an HMAC over the raw body, checked before anything reads it', () => {
  const body = JSON.stringify({ hello: 'world' });
  const sign = (o = {}) => signBridgeRequest(o.body ?? body, o.secret ?? CALLBACK_SECRET, { timestamp: o.timestamp ?? nowSeconds(), nonce: o.nonce ?? crypto.randomUUID() });

  test('a correctly signed request verifies and yields its nonce', async () => {
    const headers = await sign({ nonce: 'nonce-aaaaaaaaaaaaaaaa' });
    const out = await verifyBridgeRequest(body, headers, CALLBACK_SECRET, nowSeconds());
    assert.deepEqual([out.ok, out.nonce], [true, 'nonce-aaaaaaaaaaaaaaaa']);
  });

  test('a changed byte, another secret, a missing header or an old timestamp is refused', async () => {
    const headers = await sign();
    assert.equal((await verifyBridgeRequest(`${body} `, headers, CALLBACK_SECRET, nowSeconds())).code, 'invalid_signature');
    assert.equal((await verifyBridgeRequest(body, await sign({ secret: OTHER_SECRET }), CALLBACK_SECRET, nowSeconds())).code, 'invalid_signature');
    assert.equal((await verifyBridgeRequest(body, { ...headers, [BRIDGE_HEADERS.signature]: null }, CALLBACK_SECRET, nowSeconds())).code, 'missing_signature');
    const stale = await sign({ timestamp: nowSeconds() - 301 });
    assert.equal((await verifyBridgeRequest(body, stale, CALLBACK_SECRET, nowSeconds())).code, 'stale_signature');
    const staleForged = await sign({ timestamp: nowSeconds() - 3600, secret: OTHER_SECRET });
    assert.equal((await verifyBridgeRequest(body, staleForged, CALLBACK_SECRET, nowSeconds())).code, 'invalid_signature', 'a forgery is reported as a forgery');
  });
});

/* ══ the wire ═════════════════════════════════════════════ */

describe('a dispatch is identifiers only (ADR §18)', () => {
  test('exactly §18\'s fields — no payload, no phone number, no message body, no configuration value', () => {
    const body = dispatchBody(aRequest(), ROUTES.send_message, crypto.randomUUID(), new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
    assert.deepEqual(Object.keys(body).sort(), [
      'action_id', 'attempt', 'config_refs', 'contract_version', 'correlation_id', 'expires_at', 'idempotency_key', 'issued_at',
      'job_id', 'module_key', 'module_version', 'nonce', 'runner_key', 'tenant_id', 'workflow_version',
    ]);
    assert.deepEqual(Object.keys(body.config_refs), ['config_snapshot_id']);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /\+1614555|Hi Sam|followup_1|payload/, 'nothing from the payload leaves in a dispatch');
    assert.equal(findSecretShaped(body), null);
  });

  test('the envelope carries the payload and references — and still no credential', () => {
    const r = aRequest();
    const envelope = envelopeFrom(r, new Date().toISOString());
    assert.deepEqual(envelope.payload, r.payload);
    assert.deepEqual(envelope.connection, { connection_id: CONNECTION, connector_key: 'synthetic_sms' });
    assert.equal(findSecretShaped(envelope), null);
    assert.equal(parseEnvelopeRequest({ contract_version: 1, job_id: ACTION, action_id: ACTION, tenant_id: TENANT, nonce: ACTION }).ok, true);
    assert.match(parseEnvelopeRequest({ contract_version: 1, job_id: ACTION, action_id: ACTION, tenant_id: TENANT, nonce: ACTION, config: {} }).problem, /unknown fields: config/);
  });
});

describe('a callback is parsed strictly and proposes an outcome', () => {
  const good = (o = {}) => ({
    contract_version: 1, job_id: ACTION, action_id: ACTION, tenant_id: TENANT, arc_attempt: 1, n8n_execution_id: 'exec-9',
    runner_key: 'arc-send-message-v1', workflow_version: '1.0.0', status: 'succeeded', provider_refs: ['SM123'],
    safe_output_meta: { segments: 1 }, error_category: null, retryable: false, completed_at: new Date().toISOString(),
    correlation_id: RUN, idempotency_key: 'send:lead-7:step-1', ...o,
  });

  test('a well-formed callback becomes a result ARC accepts', () => {
    const parsed = parseCallback(good({ elapsed_ms: 812, diagnostics: [{ node: 'Send', code: 'ok' }] }));
    assert.equal(parsed.ok, true, parsed.problem);
    const result = callbackToResult(parsed.value);
    assert.equal(validateRunnerResult(result).ok, true);
    assert.deepEqual([result.status, result.externalRequestId, result.runnerExecutionId], ['succeeded', 'SM123', 'exec-9']);
    assert.equal(result.evidence.workflow_version, '1.0.0');
    const ambiguous = callbackToResult(parseCallback(good({ status: 'ambiguous', error_category: 'provider_timeout' })).value);
    assert.deepEqual([ambiguous.status, ambiguous.ambiguous, ambiguous.retryable], ['failed', true, false]);
  });

  test('a re-sent report is the same outcome; a different status, category or retryability is not', () => {
    const outcome = (o) => callbackOutcome(parseCallback(good(o)).value);
    const base = outcome({});
    assert.equal(outcome({ completed_at: new Date(Date.now() + 5000).toISOString(), elapsed_ms: 9 }), base, 'a later timestamp is a re-send');
    assert.equal(callbackOutcome(parseCallback(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(good()).reverse())))).value), base, 'key order is not meaning');
    assert.notEqual(outcome({ status: 'failed', error_category: 'provider_error' }), base);
    assert.notEqual(outcome({ status: 'failed', error_category: 'provider_error', retryable: true }), outcome({ status: 'failed', error_category: 'provider_error' }));
  });

  test('unknown fields, contradictions, missing categories and credentials are refused', () => {
    const cases = [
      [good({ delivered: true }), /unknown fields: delivered/],
      [good({ status: 'done' }), /status is/],
      [good({ status: 'failed' }), /names its error_category/],
      [good({ status: 'succeeded', retryable: true }), /only a failure is retryable/],
      [good({ provider_refs: Array(11).fill('x') }), /at most ten/],
      [good({ tenant_id: 'tenant-a' }), /tenant_id is a uuid/],
      [good({ safe_output_meta: { response: { access_token: 'x' } } }), /credential/],
      [good({ diagnostics: [{ node: 'Send', code: 'OK!' }] }), /diagnostics/],
    ];
    for (const [value, pattern] of cases) {
      const parsed = parseCallback(value);
      assert.equal(parsed.ok, false, JSON.stringify(value));
      assert.match(parsed.problem, pattern);
    }
  });
});

/* ══ the runner ═══════════════════════════════════════════ */

describe('N8nRunner is disabled in production (ADR §26)', () => {
  test('it refuses production and an unset environment, and is allowed in staging, development and test', () => {
    for (const env of ['production', resolveRuntimeEnvironment(undefined), resolveRuntimeEnvironment('PROD')]) {
      assert.throws(() => runner({ environment: env }), (e) => e.code === 'n8n_runner_disabled', env);
    }
    for (const env of ['staging', 'development', 'test']) assert.ok(runner({ environment: env }));
  });

  test('the inbound bridge answers 503 in production without reading anything', async () => {
    const untouchable = new Proxy({}, { get: (_t, n) => () => { throw new Error(`reached ${String(n)}`); } });
    const deps = { environment: 'production', callbackSecret: CALLBACK_SECRET, bridge: untouchable, scheduler: untouchable };
    for (const handle of [handleEnvelopeRequest, handleCallback]) {
      const out = await handle(deps, { rawBody: '{}', headers: {} });
      assert.deepEqual([out.status, out.body.error], [503, 'bridge_disabled']);
    }
  });

  test('a runner hands over only scheduler types, and holds no routes of its own', () => {
    const make = (actionTypes) => () => new N8nRunner({ environment: 'test', actionTypes, dispatchSecret: DISPATCH_SECRET, ledger: ledger(), transport: n8n().transport });
    assert.throws(make(['send_followup']), /not a scheduler action type/);
    assert.throws(make([]), /at least one/);
    assert.deepEqual(make(['send_message', 'send_message'])().describeCapabilities().actionTypes, ['send_message']);
  });
});

describe('N8nRunner runs only what ARC assigned (ARC-230)', () => {
  test('the database\'s refusal codes parse, digits and all', () => {
    const e = parseBridgeError('ERROR: arc_bridge:n8n_prohibited: lead_recovery@1 runs directly');
    assert.deepEqual([e?.code, e?.message], ['n8n_prohibited', 'lead_recovery@1 runs directly']);
    assert.equal(parseBridgeError('duplicate key value violates unique constraint'), null);
  });

  test('the workflow comes from ARC\'s assignment for the run\'s module version, here', async () => {
    const l = ledger();
    const r = aRequest();
    await runner({ l }).dispatch(r, new AbortController().signal);
    assert.deepEqual(l.calls[0], ['resolve', 'some_module@1/send_message/test']);
    assert.equal(l.calls[1][1].assignmentId, ASSIGNMENT, 'the dispatch is recorded against that assignment');
    assert.equal(l.calls[1][1].environment, 'test');
  });

  test('no assignment, a module that forbids n8n, a disabled or undeployed version: nothing is sent, and nothing took effect', async () => {
    for (const code of ['no_assignment', 'n8n_prohibited', 'workflow_disabled', 'workflow_draft', 'not_deployed']) {
      const t = n8n();
      const l = ledger({ resolve: { code, assignmentId: null, webhookUrl: null } });
      await assert.rejects(runner({ l, t }).dispatch(aRequest(), new AbortController().signal),
        (e) => e.code === code && e.effectPossible === false && e.retryable === false, code);
      assert.equal(t.seen.length, 0, `${code}: nothing was sent`);
      assert.ok(!l.calls.some((c) => c[0] === 'record'), `${code}: nothing was recorded`);
    }
  });

  test('a webhook that is not https is never called', async () => {
    const t = n8n();
    await assert.rejects(runner({ l: ledger({ resolve: { webhookUrl: 'http://n8n.invalid/webhook/x' } }), t }).dispatch(aRequest(), new AbortController().signal),
      (e) => e.code === 'not_deployed');
    assert.equal(t.seen.length, 0);
  });

  test('an assignment retired between resolving and recording stops the dispatch, retryably', async () => {
    const t = n8n();
    const l = ledger();
    l.recordDispatch = async () => { throw new BridgeError('assignment_retired', 'retired'); };
    await assert.rejects(runner({ l, t }).dispatch(aRequest(), new AbortController().signal),
      (e) => e.code === 'assignment_retired' && e.retryable && !e.effectPossible);
    assert.equal(t.seen.length, 0);
  });

  test('ARC recording a different workflow than was resolved voids the dispatch before anything is sent', async () => {
    const t = n8n();
    const l = ledger({ recorded: { runnerKey: 'arc-other-v1', workflowVersion: '9.9.9', workflowChecksum: `sha256:${'d'.repeat(64)}` } });
    await assert.rejects(runner({ l, t }).dispatch(aRequest(), new AbortController().signal),
      (e) => e.code === 'attribution_mismatch' && e.effectPossible === false);
    assert.equal(t.seen.length, 0);
    assert.deepEqual(l.calls.at(-1), ['void', 'attribution_mismatch']);
  });
});

describe('N8nRunner dispatches §18\'s reference, signed, after recording it', () => {
  test('the dispatch is recorded first, then sent with a JWT bound to its body, and reported accepted', async () => {
    const l = ledger();
    const t = n8n({ answer: { status: 202, body: { n8n_execution_id: 'exec-42' } } });
    const r = aRequest();
    const result = await runner({ l, t }).dispatch(r, new AbortController().signal);

    assert.deepEqual([result.status, result.runnerExecutionId], ['accepted', 'exec-42']);
    assert.deepEqual(l.calls.map((c) => c[0]), ['resolve', 'record', 'correlate'], 'resolved, recorded before it was sent, correlated after');
    assert.equal(result.evidence.workflow_checksum, `sha256:${'c'.repeat(64)}`);
    const [post] = t.seen;
    assert.equal(post.url, URL_SEND);
    const token = post.headers.Authorization.replace(/^Bearer /, '');
    const verified = await verifyDispatchToken(token, DISPATCH_SECRET, nowSeconds());
    assert.equal(verified.ok, true);
    const body = JSON.parse(post.body);
    assert.deepEqual([verified.claims.sub, verified.claims.jti, verified.claims.aud, verified.claims.tenant_id], [r.attemptId, body.nonce, 'arc-send-message-v1', TENANT]);
    assert.equal(verified.claims.body_sha256, await sha256Hex(post.body));
    assert.ok(verified.claims.exp - verified.claims.iat <= 900, 'minutes, not hours');
    assert.equal(l.calls.find((c) => c[0] === 'record')[1].nonce, body.nonce);
    assert.equal(body.payload, undefined);
  });

  test('a dispatch that cannot be recorded is never sent', async () => {
    const t = n8n();
    await assert.rejects(runner({ l: ledger({ failRecord: true }), t }).dispatch(aRequest(), new AbortController().signal),
      (e) => e.code === 'dispatch_not_recorded' && e.effectPossible === false && e.retryable === true);
    assert.equal(t.seen.length, 0);
  });

  test('an unknown outcome with the envelope unopened is voided and safe to retry', async () => {
    for (const answer of [{ status: 503, body: null }, new Error('socket hang up'), { status: 202, body: {} }]) {
      const l = ledger();
      await assert.rejects(runner({ l, t: n8n({ answer }) }).dispatch(aRequest(), new AbortController().signal),
        (e) => e.effectPossible === false && e.retryable === true, String(answer.status ?? answer.message));
      assert.equal(l.calls.at(-1)[0], 'void');
    }
  });

  test('an unknown outcome after the envelope opened is ambiguous', async () => {
    await assert.rejects(runner({ l: ledger({ opened: true }), t: n8n({ answer: { status: 500, body: null } }) }).dispatch(aRequest(), new AbortController().signal),
      (e) => e.code === 'dispatch_server_error' && e.effectPossible === true);
  });

  test('a refusal from n8n is final, except a rate limit', async () => {
    const at = async (status) => {
      try {
        await runner({ t: n8n({ answer: { status, body: null } }) }).dispatch(aRequest(), new AbortController().signal);
      } catch (e) {
        return [e.code, e.retryable, e.effectPossible];
      }
      return null;
    };
    assert.deepEqual(await at(401), ['dispatch_unauthorized', false, false]);
    assert.deepEqual(await at(404), ['workflow_not_found', false, false]);
    assert.deepEqual(await at(429), ['dispatch_rate_limited', true, false]);
  });

  test('status is diagnostic, and cancellation voids the dispatch', async () => {
    const r = runner({ t: n8n({ executions: { 'exec-7': 'success', 'exec-8': 'error' } }) });
    assert.equal((await r.queryStatus('exec-7')).state, 'succeeded');
    assert.equal((await r.queryStatus('exec-8')).state, 'failed');
    assert.equal((await r.queryStatus('exec-none')).known, false);
    const l = ledger();
    assert.equal((await runner({ l }).requestCancellation(aRequest())).acknowledged, true);
    assert.deepEqual(l.calls.at(-1), ['void', 'cancelled_by_arc']);
  });
});

/* ══ the code as written ══════════════════════════════════ */

describe('the bridge keeps to its boundary', () => {
  test('the runner never reaches the scheduler\'s writes — only the inbound handlers settle, through the service', () => {
    const code = readFileSync(new URL('runner.ts', N8N_DIR), 'utf8');
    assert.doesNotMatch(code, /scheduler\/service|scheduler\/store|orchestrator/);
  });

  test('nothing imports from outside the repository, and no portal code imports the bridge (§29.2)', () => {
    for (const file of readdirSync(N8N_DIR)) {
      assert.doesNotMatch(readFileSync(new URL(file, N8N_DIR), 'utf8'), /from ['"](jsr:|npm:|https?:)/, file);
    }
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
    for (const file of walk(new URL('../src/', import.meta.url)).filter((f) => /\.(jsx?|tsx?)$/.test(f.pathname))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /n8n-runner|runner-bridge/, file.pathname);
    }
  });
});
