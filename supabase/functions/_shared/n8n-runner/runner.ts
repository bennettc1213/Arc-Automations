/**
 * ARC-220 — `N8nRunner`: the `AutomationRunner` that hands work to a shared n8n workflow
 * (ADR ARC-010 §15, §18, §19, §30).
 *
 * **Disabled in production** (ADR §26). The constructor refuses a production
 * environment — including an unset `ARC_ENVIRONMENT` — until the licensing gate is closed
 * by a recorded decision and this check is changed on purpose. Staging, development and
 * test may build one, so the bridge can be proven end to end before anything relies on it.
 *
 * What it sends is §18's minimal reference: identifiers, version references and the
 * idempotency key, signed as a short-lived JWT bound to the body. No configuration value,
 * payload, template, credential, phone number or message body leaves in a dispatch; the
 * workflow fetches the envelope from ARC with a signed request, once, and only while ARC
 * still allows the action (0018's `open_runner_envelope`).
 *
 * The dispatch is recorded before it is sent, so a callback that beats the 202 still finds
 * its job. When the outcome of the send is unknown — a timeout, a 5xx, a garbled reply —
 * the runner voids the dispatch. If the envelope had not been opened, it never will be,
 * and since n8n holds no credential and learns the payload only from the envelope, the
 * attempt provably took no effect: it is reported retryable. If the envelope had opened,
 * the outcome is unknown and ARC blocks it for a person.
 *
 * Which workflow runs is never the runner's choice (ARC-230): each dispatch resolves the
 * active assignment for its run's module version and action type in this environment
 * (0019), and ARC records the dispatch — runner key, version, checksum, error handler —
 * from that assignment. A module the registry forbids n8n has no assignment to resolve.
 *
 * An accepted dispatch is reported as `accepted`; the signed callback settles the attempt
 * (`inbound.ts`), and if none arrives before the lease expires, 0017's sweep records an
 * external effect as ambiguous.
 */

import { type RuntimeEnvironment } from '../connections/runtime-env.ts';
import type { SecretValue } from '../connections/redact.ts';
import { actionType, RUN_MODES, type RunMode } from '../scheduler/model.ts';
import {
  type AutomationRunner,
  type RunnerCapabilities,
  type RunnerExecutionStatus,
  type RunnerFailure,
  type RunnerRequest,
  runnerRequestProblem,
  type RunnerResult,
} from '../runner/model.ts';
import { dispatchBody } from './contract.ts';
import { sha256Hex, signDispatchToken } from './signing.ts';
import { BridgeError, type BridgeLedger } from './store.ts';

/* ── transport ────────────────────────────────────────────── */

export interface BridgeHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface BridgeHttpResponse {
  status: number;
  /** parsed JSON, or null. Never logged. */
  body: unknown;
}

export type BridgeTransport = (request: BridgeHttpRequest) => Promise<BridgeHttpResponse>;

/** The production transport: bounded, and never follows a redirect. */
export function fetchBridgeTransport(timeoutMs = 10_000): BridgeTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(request.url, {
        method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/* ── configuration ────────────────────────────────────────── */

export interface N8nRunnerOptions {
  environment: RuntimeEnvironment;
  kind?: string;
  /**
   * The action types this worker will hand to n8n at all. Which workflow executes each
   * one is not configuration here: it is resolved from ARC's assignments (0019) at every
   * dispatch, so a module whose registry posture forbids n8n is never dispatched, and a
   * rollback is a change of assignment, never a redeploy of this worker.
   */
  actionTypes: readonly string[];
  runModes?: readonly RunMode[];
  dispatchSecret: SecretValue<string>;
  ledger: BridgeLedger;
  transport: BridgeTransport;
  /** n8n's executions API, for the diagnostic `queryStatus` only. */
  executionsApi?: { url: string; apiKey: SecretValue<string> };
  /** minutes, not hours (§18). default five. */
  dispatchTtlSeconds?: number;
  now?: () => Date;
}

/** Refuses production until ADR §26's gate is closed. An unset environment is production. */
export function assertN8nRunnerAllowed(environment: RuntimeEnvironment): void {
  if (environment === 'production') {
    throw new BridgeError('n8n_runner_disabled',
      'the n8n runner is disabled in production until the licensing gate (ADR ARC-010 §26) is closed by a recorded decision',
      { retryable: false, effectPossible: false });
  }
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export class N8nRunner implements AutomationRunner {
  readonly kind: string;
  private readonly capabilities: RunnerCapabilities;
  private readonly options: N8nRunnerOptions;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: N8nRunnerOptions) {
    assertN8nRunnerAllowed(options.environment);
    this.kind = options.kind ?? 'n8n';
    const types = [...new Set(options.actionTypes ?? [])];
    for (const type of types) {
      const def = actionType(type);
      if (!def || def.dispatcher !== 'scheduler') throw new Error(`${type} is not a scheduler action type`);
    }
    if (!types.length) throw new Error('an n8n runner hands over at least one action type');
    if (options.executionsApi && !httpsUrl(options.executionsApi.url)) throw new Error('the executions API is reached over https only');
    const ttl = options.dispatchTtlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) throw new Error('dispatchTtlSeconds is 30–900');
    this.capabilities = Object.freeze({
      actionTypes: Object.freeze(types),
      runModes: Object.freeze([...(options.runModes ?? RUN_MODES)]),
    });
    this.options = options;
    this.ttlSeconds = ttl;
    this.now = options.now ?? (() => new Date());
  }

  describeCapabilities(): RunnerCapabilities {
    return this.capabilities;
  }

  async dispatch(request: RunnerRequest, signal: AbortSignal): Promise<RunnerResult> {
    const problem = runnerRequestProblem(request);
    if (problem) throw new BridgeError('contract_violation', problem, { effectPossible: false });
    if (!this.capabilities.actionTypes.includes(request.actionType)) {
      throw new BridgeError('no_route', `this worker does not hand ${request.actionType} to n8n`, { effectPossible: false });
    }
    if (request.moduleVersion === null) {
      throw new BridgeError('no_assignment', 'a run with no module version has no workflow assignment', { effectPossible: false });
    }

    /* which workflow: ARC's assignment for this module version and action type, here. */
    let resolved;
    try {
      resolved = await this.options.ledger.resolveWorkflow(request.moduleKey, request.moduleVersion, request.actionType, this.options.environment);
    } catch {
      throw new BridgeError('workflow_unresolved', 'the workflow assignment could not be read', { retryable: true, effectPossible: false });
    }
    if (resolved.code !== 'ok' || !resolved.assignmentId || !resolved.runnerKey || !resolved.workflowVersion
        || !resolved.webhookUrl || !httpsUrl(resolved.webhookUrl)) {
      // n8n_prohibited, no_assignment, workflow_draft, workflow_disabled, not_deployed: an operator's to fix.
      throw new BridgeError(resolved.code === 'ok' ? 'not_deployed' : resolved.code,
        `no workflow may execute ${request.actionType} for ${request.moduleKey}@${request.moduleVersion} here (${resolved.code})`,
        { effectPossible: false });
    }
    const route = { runnerKey: resolved.runnerKey, workflowVersion: resolved.workflowVersion };

    const issued = this.now();
    const expires = new Date(issued.getTime() + this.ttlSeconds * 1000);
    const nonce = crypto.randomUUID();
    const body = JSON.stringify(dispatchBody(request, route, nonce, issued.toISOString(), expires.toISOString()));

    // recorded before it is sent, and attributed by ARC from the assignment: nothing has
    // left ARC if this fails, and a retired assignment stops the dispatch here.
    let attribution;
    try {
      attribution = await this.options.ledger.recordDispatch({
        attemptId: request.attemptId, tenantId: request.tenantId, runnerKind: this.kind,
        assignmentId: resolved.assignmentId, environment: this.options.environment, nonce, expiresAt: expires.toISOString(),
      });
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'dispatch_not_recorded';
      const retryable = ['dispatch_not_recorded', 'assignment_retired'].includes(code);
      throw new BridgeError(code, 'the dispatch could not be recorded, so it was not sent', { retryable, effectPossible: false });
    }
    if (attribution.runnerKey !== route.runnerKey || attribution.workflowVersion !== route.workflowVersion) {
      const voided = await this.void(request, 'attribution_mismatch');
      throw new BridgeError('attribution_mismatch', 'ARC recorded a different workflow than was resolved; nothing was sent',
        { retryable: true, effectPossible: voided !== 'voided' && voided !== 'already_void' });
    }
    const url = resolved.webhookUrl;

    const token = await signDispatchToken({
      iss: 'arc', aud: route.runnerKey, sub: request.attemptId, jti: nonce,
      iat: Math.floor(issued.getTime() / 1000), exp: Math.floor(expires.getTime() / 1000),
      tenant_id: request.tenantId, body_sha256: await sha256Hex(body),
    }, this.options.dispatchSecret);

    let response;
    try {
      response = await this.options.transport({
        method: 'POST', url, body, signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      });
    } catch {
      return await this.unknownOutcome(request, 'dispatch_unreachable');
    }

    if (response.status >= 200 && response.status < 300) {
      const executionId = (response.body as { n8n_execution_id?: unknown } | null)?.n8n_execution_id;
      if (typeof executionId !== 'string' || !executionId.trim() || executionId.length > 200) {
        return await this.unknownOutcome(request, 'dispatch_response_invalid');
      }
      await this.options.ledger.correlate(request.attemptId, request.tenantId, executionId).catch(() => 'not_found');
      return {
        status: 'accepted', retryable: false, ambiguous: false, errorCode: null, message: null,
        evidence: { runner_key: route.runnerKey, workflow_version: route.workflowVersion, workflow_checksum: attribution.workflowChecksum },
        evidenceRef: null, externalRequestId: null, runnerExecutionId: executionId,
      };
    }
    if (response.status >= 500) return await this.unknownOutcome(request, 'dispatch_server_error');

    // a 4xx is a refusal before the workflow ran: nothing opened the envelope.
    const code = response.status === 401 || response.status === 403 ? 'dispatch_unauthorized'
      : response.status === 404 ? 'workflow_not_found'
      : response.status === 429 ? 'dispatch_rate_limited'
      : 'dispatch_refused';
    const voided = await this.void(request, code);
    if (voided === 'envelope_opened') {
      throw new BridgeError(code, `n8n answered ${response.status} after the envelope was opened`, { effectPossible: true });
    }
    throw new BridgeError(code, `n8n refused the dispatch (${response.status})`, { retryable: code === 'dispatch_rate_limited', effectPossible: false });
  }

  /** Void, then say whether the attempt could have taken effect. */
  private async unknownOutcome(request: RunnerRequest, code: string): Promise<never> {
    const voided = await this.void(request, code);
    if (voided === 'voided' || voided === 'already_void') {
      throw new BridgeError(code, 'the dispatch was voided before its envelope opened; nothing took effect', { retryable: true, effectPossible: false });
    }
    throw new BridgeError(code, 'the envelope may have been opened; whether the effect happened is unknown', { effectPossible: true });
  }

  private async void(request: RunnerRequest, reason: string) {
    try {
      return await this.options.ledger.voidDispatch(request.attemptId, request.tenantId, reason);
    } catch {
      return 'unknown' as const;
    }
  }

  classifyFailure(error: unknown): RunnerFailure {
    if (error instanceof BridgeError) return { errorCode: error.code, retryable: error.retryable, effectPossible: error.effectPossible };
    return { errorCode: 'runner_error', retryable: false, effectPossible: true };
  }

  async queryStatus(runnerExecutionId: string): Promise<RunnerExecutionStatus> {
    const unknown: RunnerExecutionStatus = { runnerExecutionId, known: false, state: 'unknown' };
    const api = this.options.executionsApi;
    if (!api) return unknown;
    try {
      const response = await this.options.transport({
        method: 'GET',
        url: `${api.url.replace(/\/+$/, '')}/api/v1/executions/${encodeURIComponent(runnerExecutionId)}`,
        headers: { 'X-N8N-API-KEY': api.apiKey.reveal(), Accept: 'application/json' },
      });
      if (response.status !== 200) return unknown;
      const status = (response.body as { status?: unknown } | null)?.status;
      const state = status === 'success' ? 'succeeded'
        : status === 'error' || status === 'crashed' ? 'failed'
        : status === 'canceled' ? 'cancelled'
        : status === 'running' || status === 'new' || status === 'waiting' ? 'running'
        : 'unknown';
      return { runnerExecutionId, known: true, state };
    } catch {
      return unknown;
    }
  }

  /** Voiding the dispatch is the cancellation that works: without the envelope, nothing can act. */
  async requestCancellation(request: RunnerRequest): Promise<{ acknowledged: boolean }> {
    const voided = await this.void(request, 'cancelled_by_arc');
    return { acknowledged: voided === 'voided' || voided === 'already_void' };
  }
}
