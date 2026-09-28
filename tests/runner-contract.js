/* ARC-210 — the `AutomationRunner` contract (ADR ARC-010 §29.8, §30): what every runner
 * must do, whatever it runs on. Run against `FakeTestRunner` (tests/runner.test.js); the
 * n8n bridge (ARC-220) and the direct worker run the same suite against their own
 * backends, so the orchestrator can swap one for another without noticing.
 *
 * `make()` returns { runner, request(overrides?) } — `request` builds a valid request the
 * runner will succeed on, or accept for a later callback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RUN_MODES } from '../supabase/functions/_shared/scheduler/model.ts';
import { RUNNER_KIND, validateRunnerResult } from '../supabase/functions/_shared/runner/model.ts';

export function runnerContract(label, make) {
  const t = (name, fn) => test(`${label}: ${name}`, async () => fn(await make()));

  t('names itself with a runner kind, and says which types and modes it executes', ({ runner }) => {
    assert.match(runner.kind, RUNNER_KIND);
    const caps = runner.describeCapabilities();
    assert.ok(Array.isArray(caps.actionTypes) && caps.actionTypes.length > 0);
    assert.ok(caps.actionTypes.every((k) => typeof k === 'string' && k.length > 0));
    assert.ok(caps.runModes.length > 0 && caps.runModes.every((m) => RUN_MODES.includes(m)));
  });

  t('answers a request with a result ARC accepts, naming the execution', async ({ runner, request }) => {
    const r = request();
    const value = await runner.dispatch(r, new AbortController().signal);
    const checked = validateRunnerResult(value);
    assert.equal(checked.ok, true, checked.problem);
    assert.ok(['succeeded', 'accepted'].includes(checked.result.status), `a working runner succeeds or accepts, not ${checked.result.status}`);
    assert.ok(checked.result.runnerExecutionId.length > 0);
  });

  t('the execution it named can be asked about, and an unknown one is unknown rather than an error', async ({ runner, request }) => {
    const value = await runner.dispatch(request(), new AbortController().signal);
    const known = await runner.queryStatus(value.runnerExecutionId);
    assert.equal(known.known, true);
    assert.equal(known.runnerExecutionId, value.runnerExecutionId);
    const unknown = await runner.queryStatus('never-dispatched');
    assert.equal(unknown.known, false);
    assert.equal(unknown.state, 'unknown');
  });

  t('classifies any failure, and an unrecognised one is assumed to have possibly taken effect', ({ runner }) => {
    const f = runner.classifyFailure(new Error('something nobody planned for'));
    assert.match(f.errorCode, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(typeof f.retryable, 'boolean');
    assert.equal(f.effectPossible, true, 'the safe assumption — an unknown failure may have sent something');
  });

  t('cancellation is best-effort and says whether it was heard', async ({ runner, request }) => {
    const out = await runner.requestCancellation(request());
    assert.equal(typeof out.acknowledged, 'boolean');
  });

  t('does not change the request it was handed', async ({ runner, request }) => {
    const r = request();
    const before = JSON.stringify(r);
    await runner.dispatch(r, new AbortController().signal);
    assert.equal(JSON.stringify(r), before);
  });
}
