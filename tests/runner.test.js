/* ARC-210 — the runner contract, `FakeTestRunner`, the registry, and the rules that turn
 * what a runner says into an outcome. None of this needs a database:
 * `tests/runner-db.test.js` runs the orchestrator over the real scheduler in PGlite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { resolveRuntimeEnvironment } from '../supabase/functions/_shared/connections/runtime-env.ts';
import { findSecretShaped } from '../supabase/functions/_shared/scheduler/model.ts';
import {
  classifyOrAssume,
  RUNNER_CONTRACT_VERSION,
  runnerRequestProblem,
  settlementFor,
  validateRunnerResult,
} from '../supabase/functions/_shared/runner/model.ts';
import { FakeTestRunner } from '../supabase/functions/_shared/runner/fake.ts';
import { createRunnerRegistry } from '../supabase/functions/_shared/runner/registry.ts';
import { buildRunnerRequest } from '../supabase/functions/_shared/runner/orchestrator.ts';
import { runnerContract } from './runner-contract.js';

const RUNNER_DIR = new URL('../supabase/functions/_shared/runner/', import.meta.url);

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ACTION = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '55555555-5555-4555-8555-555555555555';
const CONNECTION = '66666666-6666-4666-8666-666666666666';

const aRun = (overrides = {}) => ({
  id: RUN, tenantId: TENANT, runKind: 'connector_test', moduleKey: 'some_module', moduleVersion: 1, leadId: null,
  configSnapshotId: SNAPSHOT, runMode: 'test', lifecycleStateAtStart: 'testing', runnerKind: null, status: 'running',
  statusReason: null, terminalCode: null, correlationId: crypto.randomUUID(), idempotencyKey: 'run:1', createdByType: 'system',
  createdBy: null, createdAt: '2026-09-26T10:00:00.000Z', startedAt: null, completedAt: null, updatedAt: '2026-09-26T10:00:00.000Z',
  ...overrides,
});
const anAction = (overrides = {}) => ({
  id: ACTION, tenantId: TENANT, runId: RUN, moduleKey: 'some_module', actionType: 'send_message',
  scheduledFor: '2026-09-26T10:00:00.000Z', runAt: '2026-09-26T10:00:00.000Z', status: 'running', idempotencyKey: 'send:lead-7:step-1',
  attempts: 1, maxAttempts: 5, lockedBy: 'w', leaseToken: crypto.randomUUID(), leaseExpiresAt: null, fence: 1,
  connectorKey: 'synthetic_sms', connectionId: CONNECTION, payload: { template: 'followup_1', step: 1 }, configSnapshotId: SNAPSHOT,
  gate: null, lastError: null, createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', completedAt: null,
  ...overrides,
});
const build = ({ run = aRun(), action = anAction(), runnerKind = 'fake_test', attemptNumber = 1 } = {}) => buildRunnerRequest({
  run, action, runnerKind, attemptId: crypto.randomUUID(), attemptNumber,
  issuedAt: '2026-09-26T10:00:01.000Z', deadline: '2026-09-26T10:01:31.000Z',
});
const validRequest = (overrides = {}) => {
  const built = build();
  assert.equal(built.ok, true, built.message);
  return { ...built.value, ...overrides };
};
const fake = (options = {}) => new FakeTestRunner({ environment: 'test', ...options });
const signal = () => new AbortController().signal;

/* ══ the contract ═════════════════════════════════════════ */

runnerContract('FakeTestRunner', () => ({ runner: fake(), request: (o) => validRequest(o) }));

/* ══ the request ══════════════════════════════════════════ */

describe('a runner request is references, not values, and never a credential', () => {
  test('it carries the pinned snapshot, the durable idempotency key, ARC\'s attempt and the connection as metadata', () => {
    const r = validRequest();
    assert.equal(r.contractVersion, RUNNER_CONTRACT_VERSION);
    assert.equal(r.configSnapshotId, SNAPSHOT);
    assert.equal(r.idempotencyKey, 'send:lead-7:step-1');
    assert.equal(r.attemptNumber, 1);
    assert.equal(r.effectClass, 'external_effect');
    assert.equal(r.runMode, 'test');
    assert.deepEqual(r.connection, { connectionId: CONNECTION, connectorKey: 'synthetic_sms' });
    assert.equal(findSecretShaped(r), null);
    assert.deepEqual(Object.keys(r).filter((k) => /config$|settings|template_body|token|secret|password|credential/i.test(k)), [],
      'no field could carry configuration values or a credential');
  });

  test('a request is refused, not repaired, when it is unpinned, unowned, unkeyed or secret-shaped', () => {
    assert.match(build({ action: anAction({ configSnapshotId: '77777777-7777-4777-8777-777777777777' }) }).message, /not pinned/);
    assert.match(build({ action: anAction({ configSnapshotId: null }) }).message, /not pinned/);
    assert.match(build({ action: anAction({ runId: CONNECTION }) }).message, /does not belong/);
    assert.match(build({ run: aRun({ correlationId: null }) }).message, /correlation/);
    assert.match(build({ run: aRun({ runMode: null }) }).message, /no mode/);
    const secret = build({ action: anAction({ payload: { provider: { refresh_token: 'x' } } }) });
    assert.equal(secret.code, 'runner_request_refused');
    assert.match(secret.message, /refresh_token.*credential/);
  });

  test('the contract check names what is wrong with a hand-made request', () => {
    assert.equal(runnerRequestProblem(validRequest()), null);
    assert.match(runnerRequestProblem(validRequest({ idempotencyKey: '' })), /idempotency/);
    assert.match(runnerRequestProblem(validRequest({ configSnapshotId: null })), /pinned/);
    assert.match(runnerRequestProblem(validRequest({ contractVersion: 2 })), /contract version/);
    assert.match(runnerRequestProblem(validRequest({ runMode: 'dry_run' })), /runMode/);
    assert.match(runnerRequestProblem(validRequest({ payload: { headers: { Authorization: 'Basic abc' } } })), /Authorization/);
  });
});

/* ══ the fake ═════════════════════════════════════════════ */

describe('FakeTestRunner is a test double, and a strict one', () => {
  test('it refuses to exist in production, in staging, or where nobody said which environment this is', () => {
    for (const env of ['production', 'staging', resolveRuntimeEnvironment(undefined), resolveRuntimeEnvironment('prod')]) {
      assert.throws(() => new FakeTestRunner({ environment: env }), (e) => e.code === 'environment_forbidden', env);
    }
    assert.ok(new FakeTestRunner({ environment: resolveRuntimeEnvironment('development') }));
  });

  test('it receives no secrets: a request carrying one is recorded as a violation and refused', async () => {
    const runner = fake();
    const bad = validRequest({ payload: { api_key: 'abc' } });
    await assert.rejects(runner.dispatch(bad, signal()), (e) => e.errorCode === 'contract_violation' && e.effectPossible === false);
    assert.equal(runner.violations.length, 1);
    assert.match(runner.violations[0].problem, /api_key/);
    assert.equal(runner.received.length, 0, 'a refused request is never executed');
  });

  test('it refuses a request that is unpinned, unkeyed, for another runner, or of a type it does not execute', async () => {
    const runner = fake({ actionTypes: ['send_message'] });
    for (const bad of [
      validRequest({ configSnapshotId: '' }),
      validRequest({ idempotencyKey: ' ' }),
      validRequest({ runnerKind: 'someone_else' }),
      validRequest({ actionType: 'remind_operator', effectClass: 'none' }),
    ]) {
      await assert.rejects(runner.dispatch(bad, signal()), (e) => e.errorCode === 'contract_violation');
    }
    assert.equal(runner.violations.length, 4);
  });

  test('scripts are per logical action and consumed in order across its attempts', async () => {
    const runner = fake().script('send:lead-7:step-1', { do: 'fail', retryable: true, errorCode: 'rate_limited' }, { do: 'ambiguous' });
    const one = await runner.dispatch(validRequest({ attemptNumber: 1 }), signal());
    const two = await runner.dispatch(validRequest({ attemptNumber: 2 }), signal());
    const three = await runner.dispatch(validRequest({ attemptNumber: 3 }), signal());
    assert.deepEqual([one.status, one.retryable, one.errorCode], ['failed', true, 'rate_limited']);
    assert.deepEqual([two.status, two.ambiguous], ['failed', true]);
    assert.equal(three.status, 'succeeded', 'unscripted attempts take the default');
    assert.deepEqual(runner.received.map((r) => r.attemptNumber), [1, 2, 3]);
    assert.ok(runner.received.every((r) => Object.isFrozen(r) && Object.isFrozen(r.payload)));
  });

  test('a hung dispatch ends when ARC stops waiting', async () => {
    const runner = fake({ defaultStep: { do: 'hang' } });
    const controller = new AbortController();
    const pending = runner.dispatch(validRequest(), controller.signal);
    controller.abort();
    await assert.rejects(pending, (e) => e.errorCode === 'runner_aborted' && e.effectPossible === true);
  });

  test('it reaches nothing outside the process', () => {
    const code = readFileSync(new URL('fake.ts', RUNNER_DIR), 'utf8');
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|createClient|https?:\/\//);
  });
});

/* ══ the result ═══════════════════════════════════════════ */

describe('a runner result is validated strictly', () => {
  const good = { status: 'succeeded', retryable: false, ambiguous: false, errorCode: null, message: null, evidence: {}, evidenceRef: null, externalRequestId: null, runnerExecutionId: 'x:1' };

  test('a well-formed result passes', () => {
    assert.equal(validateRunnerResult(good).ok, true);
    assert.equal(validateRunnerResult({ ...good, status: 'failed', retryable: true, errorCode: 'rate_limited' }).ok, true);
  });

  test('contradictions, unknown fields and missing identity are refused', () => {
    const problems = [
      [{ ...good, delivered: true }, /unknown result fields: delivered/],
      [{ ...good, status: 'done' }, /status/],
      [{ ...good, ambiguous: true }, /only a failure can be ambiguous/],
      [{ ...good, status: 'failed', errorCode: 'x', ambiguous: true, retryable: true }, /never retryable/],
      [{ ...good, retryable: true }, /only a failure is retryable/],
      [{ ...good, status: 'failed' }, /names its error code/],
      [{ ...good, status: 'failed', errorCode: 'Rate Limited' }, /lower-case code/],
      [{ ...good, runnerExecutionId: '' }, /runnerExecutionId/],
      [{ ...good, evidence: ['a'] }, /evidence/],
      [null, /not an object/],
    ];
    for (const [value, pattern] of problems) {
      const checked = validateRunnerResult(value);
      assert.equal(checked.ok, false, JSON.stringify(value));
      assert.match(checked.problem, pattern);
    }
  });
});

describe('what a runner reports becomes an outcome by what the action could have done', () => {
  const result = (r) => ({ kind: 'result', result: { retryable: false, ambiguous: false, errorCode: null, message: null, evidence: {}, evidenceRef: null, externalRequestId: null, runnerExecutionId: 'x', ...r } });

  test('a valid result is taken at its word, whatever the effect class', () => {
    for (const cls of ['none', 'external_read', 'external_effect']) {
      assert.equal(settlementFor(cls, result({ status: 'succeeded' })).outcome, 'succeeded');
      assert.equal(settlementFor(cls, result({ status: 'skipped' })).outcome, 'skipped');
      assert.deepEqual(settlementFor(cls, result({ status: 'failed', retryable: true, errorCode: 'rate_limited' })),
        { outcome: 'failed', retryable: true, errorCode: 'rate_limited', message: null });
      assert.equal(settlementFor(cls, result({ status: 'failed', ambiguous: true, errorCode: 'x' })).outcome, 'ambiguous');
    }
  });

  test('an external effect whose outcome is unknown is ambiguous — a timeout, a garbled result, an exception', () => {
    assert.equal(settlementFor('external_effect', { kind: 'timeout', afterMs: 50 }).outcome, 'ambiguous');
    assert.equal(settlementFor('external_effect', { kind: 'invalid', problem: 'x' }).outcome, 'ambiguous');
    assert.equal(settlementFor('external_effect', { kind: 'threw', failure: { errorCode: 'boom', retryable: true, effectPossible: true } }).outcome, 'ambiguous');
  });

  test('an external effect the runner proves did nothing may be retried, if it says so', () => {
    const s = settlementFor('external_effect', { kind: 'threw', failure: { errorCode: 'provider_unreachable', retryable: true, effectPossible: false } });
    assert.deepEqual([s.outcome, s.retryable, s.errorCode], ['failed', true, 'provider_unreachable']);
  });

  test('work that touches nothing outside ARC, or only reads, is retried whatever went wrong', () => {
    for (const cls of ['none', 'external_read']) {
      for (const report of [{ kind: 'timeout', afterMs: 50 }, { kind: 'invalid', problem: 'x' }]) {
        const s = settlementFor(cls, report);
        assert.deepEqual([s.outcome, s.retryable], ['failed', true], `${cls} ${report.kind}`);
      }
      assert.equal(settlementFor(cls, { kind: 'threw', failure: { errorCode: 'boom', retryable: false, effectPossible: true } }).outcome, 'failed');
    }
  });

  test('a runner that cannot classify its own failure gets the worst case', () => {
    const broken = { classifyFailure: () => { throw new Error('no idea'); } };
    assert.deepEqual(classifyOrAssume(broken, new Error('x')), { errorCode: 'runner_error', retryable: false, effectPossible: true });
    const sloppy = { classifyFailure: () => ({ errorCode: 'Bad Code', retryable: true, effectPossible: false }) };
    assert.equal(classifyOrAssume(sloppy, new Error('x')).effectPossible, true);
  });
});

/* ══ the registry ═════════════════════════════════════════ */

describe('the registry knows exactly the runners it was built with', () => {
  test('an unknown kind resolves to nothing — never to a substitute', () => {
    const registry = createRunnerRegistry([fake()], { defaultKind: 'fake_test' });
    assert.equal(registry.resolve('fake_test').kind, 'fake_test');
    for (const kind of ['n8n', 'ghost_runner', null, undefined, '']) assert.equal(registry.resolve(kind), null, String(kind));
    assert.deepEqual(registry.kinds(), ['fake_test']);
    assert.ok(Object.isFrozen(registry));
  });

  test('a registry with two runners of one kind, a bad kind, or an unregistered default is refused', () => {
    assert.throws(() => createRunnerRegistry([fake(), fake()], { defaultKind: 'fake_test' }), /two runners/);
    assert.throws(() => createRunnerRegistry([fake({ kind: 'Fake Runner' })], { defaultKind: 'Fake Runner' }), /lower-case identifier/);
    assert.throws(() => createRunnerRegistry([fake()], { defaultKind: 'direct' }), /not registered/);
  });
});

/* ══ the code as written ══════════════════════════════════ */

describe('the runner layer is not n8n-shaped', () => {
  test('its code names no runner backend, provider or module, and imports nothing from outside the repository', () => {
    for (const file of readdirSync(RUNNER_DIR)) {
      const code = readFileSync(new URL(file, RUNNER_DIR), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.doesNotMatch(code, /n8n|twilio|lead_recovery/i, `${file} names a backend, provider or module`);
      assert.doesNotMatch(code, /from ['"](jsr:|npm:|https?:)/, `${file} imports from outside the repository`);
    }
  });

  test('a runner is never handed the means to write state: the orchestrator alone calls the scheduler', () => {
    for (const file of ['model.ts', 'fake.ts', 'registry.ts']) {
      const code = readFileSync(new URL(file, RUNNER_DIR), 'utf8');
      assert.doesNotMatch(code, /scheduler\/service|scheduler\/store|SchedulerStore/, `${file} reaches the scheduler's writes`);
    }
  });
});
