/**
 * ARC-240 — what the shared error handler reports, and what ARC makes of it (ADR ARC-010
 * §19, §23).
 *
 * When a shared workflow's execution fails, n8n runs its error workflow with the failed
 * execution's id, the workflow's n8n id and the error — never the job it was running. So
 * the handler reports only what it saw, as one code from a closed list, and ARC re-derives
 * everything else from its own rows: which dispatch that execution was (the id ARC
 * correlated at dispatch), which tenant, whether the envelope was ever opened, and whether
 * the action can change anything outside ARC. The handler never decides an outcome; the
 * error's message never leaves n8n, because it can hold anything a provider said.
 *
 * Each category records two facts about the failure itself:
 *
 *   effectFree  the provider provably did not act (it refused, or was never reached).
 *   retryable   trying the same work again may succeed.
 */

import { findSecretShaped, isPlainObject, type EffectClass } from '../scheduler/model.ts';
import { RUNNER_KEY, WORKFLOW_VERSION } from './contract.ts';

export const FAILURE_CATEGORIES = Object.freeze({
  provider_timeout: { effectFree: false, retryable: true },
  provider_rate_limited: { effectFree: true, retryable: true },
  provider_auth_failed: { effectFree: true, retryable: false },
  provider_unreachable: { effectFree: true, retryable: true },
  provider_error: { effectFree: false, retryable: true },
  validation_failed: { effectFree: true, retryable: false },
  unsupported_capability: { effectFree: true, retryable: false },
  ambiguous_result: { effectFree: false, retryable: true },
  n8n_internal: { effectFree: false, retryable: true },
  unexpected_exception: { effectFree: false, retryable: true },
} as const);
export type FailureCategory = keyof typeof FAILURE_CATEGORIES;
export const FAILURE_CATEGORY_KEYS = Object.freeze(Object.keys(FAILURE_CATEGORIES)) as readonly FailureCategory[];

export interface FailureReport {
  contract_version: number;
  /** the failed execution — the id ARC recorded when the dispatch was accepted. */
  n8n_execution_id: string;
  /** the failed workflow's id in this n8n, checked against the dispatch's deployment. */
  n8n_workflow_id: string;
  error_category: FailureCategory;
  /** the workflow's own node name, never the error's text. */
  failed_node: string | null;
  http_status: number | null;
  reported_at: string;
  /** the handler that reported, checked against the one the dispatch recorded. */
  handler: { runner_key: string; workflow_version: string };
}

const FIELDS = ['contract_version', 'n8n_execution_id', 'n8n_workflow_id', 'error_category', 'failed_node', 'http_status', 'reported_at', 'handler'];

type Check<T> = { ok: true; value: T } | { ok: false; problem: string };

/** A failure report, strictly: unknown fields and anything secret-shaped are refused. */
export function parseFailureReport(value: unknown): Check<FailureReport> {
  const bad = (problem: string): Check<FailureReport> => ({ ok: false, problem });
  if (!isPlainObject(value)) return bad('the report is not an object');
  const unknown = Object.keys(value).filter((k) => !FIELDS.includes(k));
  if (unknown.length) return bad(`unknown fields: ${unknown.join(', ')}`);
  const missing = FIELDS.filter((k) => !(k in value));
  if (missing.length) return bad(`missing fields: ${missing.join(', ')}`);
  const v = value;
  if (typeof v.contract_version !== 'number') return bad('contract_version is a number');
  if (typeof v.n8n_execution_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(v.n8n_execution_id)) return bad('n8n_execution_id names the execution');
  if (typeof v.n8n_workflow_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.n8n_workflow_id)) return bad('n8n_workflow_id names the workflow');
  if (!(FAILURE_CATEGORY_KEYS as readonly unknown[]).includes(v.error_category)) return bad(`error_category is one of ${FAILURE_CATEGORY_KEYS.join(', ')}`);
  if (v.failed_node !== null && (typeof v.failed_node !== 'string' || !v.failed_node.trim() || v.failed_node.length > 100)) return bad('failed_node is a node name or null');
  if (v.http_status !== null && (!Number.isInteger(v.http_status) || (v.http_status as number) < 100 || (v.http_status as number) > 599)) return bad('http_status is an HTTP status or null');
  if (typeof v.reported_at !== 'string' || Number.isNaN(Date.parse(v.reported_at))) return bad('reported_at is a timestamp');
  const h = v.handler;
  if (!isPlainObject(h) || Object.keys(h).length !== 2 || typeof h.runner_key !== 'string' || !RUNNER_KEY.test(h.runner_key)
      || typeof h.workflow_version !== 'string' || !WORKFLOW_VERSION.test(h.workflow_version)) {
    return bad('handler is the reporting workflow\'s runner key and version');
  }
  const secret = findSecretShaped(v, '$report');
  if (secret) return bad(`${secret} looks like a credential — a failure report never carries one`);
  return { ok: true, value: v as unknown as FailureReport };
}

/**
 * ARC's decision about a reported failure. Nothing can have happened before the envelope
 * opened — the workflow had nothing to act on — so that is a plain failure. After it, an
 * external effect whose failure does not prove the provider refused is ambiguous: it may
 * have happened, and an operator reconciles it (ARC-200). Anything else is a failure,
 * retryable when trying again may succeed.
 */
export function failureOutcome(
  category: FailureCategory,
  context: { envelopeOpened: boolean; effectClass: EffectClass },
): { status: 'failed' | 'ambiguous'; retryable: boolean } {
  const meta = FAILURE_CATEGORIES[category];
  if (!context.envelopeOpened) return { status: 'failed', retryable: meta.retryable };
  if (context.effectClass === 'external_effect' && !meta.effectFree) return { status: 'ambiguous', retryable: false };
  return { status: 'failed', retryable: meta.retryable };
}
