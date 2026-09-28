/**
 * ARC-220 — the two requests n8n makes to ARC: fetch an envelope, and report an outcome
 * (ADR ARC-010 §15, §18, §19). Framework-free: the `runner-bridge` edge function hands
 * these the raw body and three headers, and returns what they answer.
 *
 * Every request passes the same door, in this order, and each step refuses on its own:
 *
 *   1. the bridge is disabled in production (ADR §26) — nothing else is looked at;
 *   2. the HMAC over the raw bytes, before they are parsed;
 *   3. the nonce, once (0018) — a replay is refused, and flagged;
 *   4. the body, strictly — unknown fields and anything secret-shaped are refused;
 *   5. the job, re-derived from ARC's own rows. The tenant in the body is compared,
 *      never trusted; another tenant's job is a security event.
 *
 * A callback proposes; ARC disposes. The first verified callback for an attempt is kept;
 * a later one reporting the same outcome (`callbackOutcome`) is a duplicate, a different
 * outcome a conflict.
 * If the attempt still runs under the lease it was dispatched with, the callback settles
 * it through the scheduler's service — the same four calls the orchestrator makes — and a
 * repeat of it is a no-op. A callback that arrives after the attempt was settled is kept
 * as evidence and changes nothing. Nothing here trusts n8n's execution history.
 */

import type { RuntimeEnvironment } from '../connections/runtime-env.ts';
import type { SecretValue } from '../connections/redact.ts';
import { actionType } from '../scheduler/model.ts';
import type { SchedulerStore } from '../scheduler/store.ts';
import { settlementFor, validateRunnerResult } from '../runner/model.ts';
import { buildRunnerRequest, finishRunIfSettled, settleAttempt } from '../runner/orchestrator.ts';
import { BRIDGE_CONTRACT_VERSION, callbackOutcome, callbackToResult, envelopeFrom, parseCallback, parseEnvelopeRequest } from './contract.ts';
import { NONCE_TTL_SECONDS, sha256Hex, verifyBridgeRequest } from './signing.ts';
import type { BridgeStore, LogEntry } from './store.ts';

export interface BridgeHandlerDeps {
  environment: RuntimeEnvironment;
  callbackSecret: SecretValue<string>;
  bridge: BridgeStore;
  scheduler: SchedulerStore;
  now?: () => Date;
}

export interface BridgeInbound {
  rawBody: string;
  /** lower-case header names. */
  headers: Record<string, string | null | undefined>;
}

export interface BridgeAnswer {
  status: number;
  body: Record<string, unknown>;
}

const answer = (status: number, body: Record<string, unknown>): BridgeAnswer => ({ status, body });

type Direction = 'envelope' | 'callback';

/** Steps 1–3, and the parse. Returns the parsed body, or the answer that ends the request. */
async function door(deps: BridgeHandlerDeps, direction: Direction, input: BridgeInbound): Promise<{ parsed: unknown; digest: string } | BridgeAnswer> {
  if (deps.environment === 'production') {
    return answer(503, { error: 'bridge_disabled', detail: 'the runner bridge is disabled in production (ADR ARC-010 §26)' });
  }
  const now = deps.now ?? (() => new Date());
  const digest = await sha256Hex(input.rawBody);
  const reject = async (status: number, code: string, alert: boolean, detail: string | null = null) => {
    await deps.bridge.log({ tenantId: null, attemptId: null, direction, disposition: 'rejected', code, alert, detail, bodyDigest: digest });
    return answer(status, { error: code });
  };

  const checked = await verifyBridgeRequest(input.rawBody, input.headers, deps.callbackSecret, Math.floor(now().getTime() / 1000));
  if (!checked.ok) return await reject(401, checked.code, checked.code !== 'missing_signature');
  if (!(await deps.bridge.claimNonce(checked.nonce, direction, NONCE_TTL_SECONDS))) return await reject(409, 'replayed', true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return await reject(400, 'invalid_json', false);
  }
  return { parsed, digest };
}

const isAnswer = (x: unknown): x is BridgeAnswer => typeof (x as BridgeAnswer)?.status === 'number' && 'body' in (x as object);

/* ── envelope ─────────────────────────────────────────────── */

export async function handleEnvelopeRequest(deps: BridgeHandlerDeps, input: BridgeInbound): Promise<BridgeAnswer> {
  const opened = await door(deps, 'envelope', input);
  if (isAnswer(opened)) return opened;
  const { parsed, digest } = opened;
  const log = (entry: Omit<LogEntry, 'direction' | 'bodyDigest'>) => deps.bridge.log({ ...entry, direction: 'envelope', bodyDigest: digest });

  const request = parseEnvelopeRequest(parsed);
  if (!request.ok) {
    await log({ tenantId: null, attemptId: null, disposition: 'rejected', code: 'invalid_request', alert: false, detail: request.problem });
    return answer(400, { error: 'invalid_request', detail: request.problem });
  }
  const r = request.value;
  if (r.contract_version !== BRIDGE_CONTRACT_VERSION) {
    await log({ tenantId: null, attemptId: r.job_id, disposition: 'rejected', code: 'contract_version_unsupported', alert: true, detail: null });
    return answer(409, { error: 'contract_version_unsupported' });
  }

  const dispatch = await deps.bridge.getDispatch(r.job_id);
  if (!dispatch) {
    await log({ tenantId: null, attemptId: r.job_id, disposition: 'rejected', code: 'unknown_job', alert: true, detail: null });
    return answer(404, { error: 'unknown_job' });
  }

  // the envelope is built from ARC's rows before the one-time open, so a refusal to build
  // never burns the envelope. `open_runner_envelope` re-checks everything under a lock.
  const tenantId = dispatch.tenantId;
  const matches = r.tenant_id === tenantId && r.action_id === dispatch.actionId && r.nonce === dispatch.nonce;
  let envelope = null;
  if (matches) {
    const [run, action, lease] = await Promise.all([
      deps.scheduler.getRun(tenantId, dispatch.runId),
      deps.scheduler.getAction(tenantId, dispatch.actionId),
      deps.bridge.getAttemptLease(dispatch.attemptId, tenantId),
    ]);
    const built = run && action && lease
      ? buildRunnerRequest({
        run, action, runnerKind: dispatch.runnerKind, attemptId: dispatch.attemptId, attemptNumber: lease.attemptNo,
        issuedAt: dispatch.issuedAt, deadline: dispatch.expiresAt,
      })
      : null;
    if (built?.ok) envelope = envelopeFrom(built.value, dispatch.expiresAt);
  }

  const verdict = await deps.bridge.openEnvelope({ attemptId: r.job_id, tenantId: r.tenant_id, actionId: r.action_id, nonce: r.nonce });
  switch (verdict.code) {
    case 'ok':
      if (!envelope) {
        // unreachable while 0017 pins actions to their runs; refused rather than guessed at.
        await log({ tenantId, attemptId: r.job_id, disposition: 'rejected', code: 'envelope_unbuildable', alert: true, detail: null });
        return answer(409, { error: 'envelope_unbuildable' });
      }
      await log({ tenantId, attemptId: r.job_id, disposition: 'accepted', code: 'envelope_opened', alert: false, detail: null });
      return answer(200, { contract_version: BRIDGE_CONTRACT_VERSION, envelope });
    case 'tenant_mismatch':
    case 'action_mismatch':
    case 'nonce_mismatch':
      await log({ tenantId, attemptId: r.job_id, disposition: 'rejected', code: verdict.code, alert: true, detail: null });
      return answer(403, { error: verdict.code });
    case 'envelope_already_opened':
      await log({ tenantId, attemptId: r.job_id, disposition: 'rejected', code: verdict.code, alert: true, detail: null });
      return answer(409, { error: verdict.code });
    case 'dispatch_expired':
    case 'gate_refused': {
      // the envelope never opened and now never will: nothing can have taken effect, so
      // the attempt goes back to the scheduler to be retried (or held, or skipped) there.
      const settled = await settleUnopened(deps, dispatch.attemptId, tenantId, verdict.code === 'dispatch_expired' ? 'dispatch_expired' : 'envelope_refused', verdict.detail);
      await log({ tenantId, attemptId: r.job_id, disposition: 'voided', code: verdict.code, alert: false, detail: verdict.detail ?? settled });
      return answer(verdict.code === 'dispatch_expired' ? 410 : 409, { error: verdict.code });
    }
    default:
      await log({ tenantId, attemptId: r.job_id, disposition: 'rejected', code: verdict.code, alert: false, detail: verdict.detail });
      return answer(verdict.code === 'dispatch_void' ? 410 : 409, { error: verdict.code });
  }
}

async function settleUnopened(deps: BridgeHandlerDeps, attemptId: string, tenantId: string, code: string, detail: string | null): Promise<string> {
  const lease = await deps.bridge.getAttemptLease(attemptId, tenantId);
  if (!lease || lease.status !== 'running') return 'attempt_not_running';
  const settled = await settleAttempt(deps.scheduler, { actionId: lease.actionId, tenantId, leaseToken: lease.leaseToken },
    { outcome: 'failed', retryable: true, errorCode: code, message: detail }, null);
  if (settled.ok) await finishRunIfSettled(deps.scheduler, tenantId, lease.runId);
  return settled.ok ? `settled_${settled.value.actionStatus}` : settled.code;
}

/* ── callback ─────────────────────────────────────────────── */

const CALLBACK_REFUSALS: Record<string, { status: number; alert: boolean }> = {
  unknown_job: { status: 404, alert: true },
  tenant_mismatch: { status: 403, alert: true },
  action_mismatch: { status: 403, alert: true },
  attempt_mismatch: { status: 409, alert: true },
  idempotency_mismatch: { status: 409, alert: true },
  // a rolled-back or foreign workflow is still calling back.
  version_mismatch: { status: 409, alert: true },
};

export async function handleCallback(deps: BridgeHandlerDeps, input: BridgeInbound): Promise<BridgeAnswer> {
  const opened = await door(deps, 'callback', input);
  if (isAnswer(opened)) return opened;
  const { parsed, digest } = opened;
  const log = (entry: Omit<LogEntry, 'direction' | 'bodyDigest'>) => deps.bridge.log({ ...entry, direction: 'callback', bodyDigest: digest });

  const checked = parseCallback(parsed);
  if (!checked.ok) {
    const secret = /credential/.test(checked.problem);
    await log({ tenantId: null, attemptId: null, disposition: 'rejected', code: secret ? 'secret_in_callback' : 'invalid_callback', alert: secret, detail: secret ? null : checked.problem });
    return answer(400, { error: secret ? 'secret_in_callback' : 'invalid_callback', detail: secret ? undefined : checked.problem });
  }
  const c = checked.value;
  if (c.contract_version !== BRIDGE_CONTRACT_VERSION) {
    await log({ tenantId: null, attemptId: c.job_id, disposition: 'rejected', code: 'contract_version_unsupported', alert: true, detail: null });
    return answer(409, { error: 'contract_version_unsupported' });
  }

  const recorded = await deps.bridge.recordCallback({
    attemptId: c.job_id, tenantId: c.tenant_id, actionId: c.action_id, attemptNo: c.arc_attempt,
    idempotencyKey: c.idempotency_key, runnerKey: c.runner_key, workflowVersion: c.workflow_version,
    digest: await sha256Hex(callbackOutcome(c)), callback: c as unknown as Record<string, unknown>,
  });
  const refusal = CALLBACK_REFUSALS[recorded];
  if (refusal) {
    // the tenant logged is ARC's, from the dispatch — never the one the body named.
    const dispatch = recorded === 'unknown_job' ? null : await deps.bridge.getDispatch(c.job_id);
    await log({ tenantId: dispatch?.tenantId ?? null, attemptId: c.job_id, disposition: 'rejected', code: recorded, alert: refusal.alert, detail: null });
    return answer(refusal.status, { error: recorded });
  }
  if (recorded === 'conflict') {
    // first terminal status wins; the contradiction is evidence and a person should see it.
    await log({ tenantId: c.tenant_id, attemptId: c.job_id, disposition: 'conflict', code: 'callback_conflict', alert: true, detail: `a second, different callback reported ${c.status}` });
    return answer(200, { disposition: 'conflict' });
  }

  /* first or duplicate: settle if the attempt still runs under the lease it was dispatched with. */
  const lease = await deps.bridge.getAttemptLease(c.job_id, c.tenant_id);
  const action = lease ? await deps.scheduler.getAction(c.tenant_id, lease.actionId) : null;
  const type = action ? actionType(action.actionType) : null;
  if (!lease || !type || lease.status !== 'running') {
    const disposition = recorded === 'first' ? 'late' : 'duplicate';
    await log({ tenantId: c.tenant_id, attemptId: c.job_id, disposition, code: disposition === 'late' ? 'callback_after_settlement' : 'callback_duplicate', alert: false, detail: lease ? `the attempt is ${lease.status}` : null });
    return answer(200, { disposition });
  }

  const result = validateRunnerResult(callbackToResult(c));
  if (!result.ok) {
    await log({ tenantId: c.tenant_id, attemptId: c.job_id, disposition: 'rejected', code: 'invalid_callback', alert: true, detail: result.problem });
    return answer(400, { error: 'invalid_callback', detail: result.problem });
  }
  let settlement = settlementFor(type.effectClass, { kind: 'result', result: result.result });
  // a workflow whose manifest says ARC may not retry it automatically is not retried,
  // whatever its callback claims (ARC-230).
  if (settlement.outcome === 'failed' && settlement.retryable && (await deps.bridge.getDispatch(c.job_id))?.autoRetry === false) {
    settlement = { ...settlement, retryable: false };
  }
  const settled = await settleAttempt(deps.scheduler, { actionId: lease.actionId, tenantId: c.tenant_id, leaseToken: lease.leaseToken }, settlement, result.result);
  if (!settled.ok) {
    const disposition = recorded === 'first' ? 'late' : 'duplicate';
    await log({ tenantId: c.tenant_id, attemptId: c.job_id, disposition, code: settled.code, alert: false, detail: null });
    return answer(200, { disposition });
  }
  const runStatus = await finishRunIfSettled(deps.scheduler, c.tenant_id, lease.runId);
  await log({ tenantId: c.tenant_id, attemptId: c.job_id, disposition: 'applied', code: `outcome_${settlement.outcome}`, alert: false, detail: null });
  return answer(200, { disposition: 'applied', outcome: settlement.outcome, action_status: settled.value.actionStatus, run_status: runStatus });
}
