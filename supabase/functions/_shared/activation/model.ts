/**
 * ARC-320 — what the activation console says about a module, derived in one place.
 *
 * **Portal-safe.** The `ops` function's `activation-overview` stamps each connection with
 * `connectionDisplay` before it leaves the server, and the console imports this same file to
 * group the readiness checklist and word the impact of going live — so the page and the
 * response cannot use two vocabularies. Nothing here decides anything: whether a module may
 * be activated is ARC-120's `evaluateActivation`, re-run on the server when the button is
 * pressed, and whether a connection serves is ARC-130's. This file only names what those
 * answers already say.
 */

import { parseConnectionStatus } from '../connections/model.ts';
import { normaliseRequirements } from '../lifecycle/model.ts';

/* ── a connection, as an operator reads it ──────────────── */

/**
 * The roadmap's six words — missing, connected, needs reauth, revoked, expired, unsupported —
 * and the in-between states ARC-130 really has, so nothing is rounded up to "connected".
 * `connected` is only ever a connection that serves (`verified`); a stored credential nobody
 * has verified is `unverified`, because a token is not readiness.
 */
export const CONNECTION_DISPLAY = Object.freeze({
  missing: { label: 'missing', tone: 'warn', serves: false, sentence: 'nothing is connected for this provider' },
  pending: { label: 'authorising', tone: 'neutral', serves: false, sentence: 'an authorisation was started and has not come back' },
  unverified: { label: 'unverified', tone: 'warn', serves: false, sentence: 'a credential is stored but has not been verified — test it' },
  connected: { label: 'connected', tone: 'ok', serves: true, sentence: 'verified, and serving the capabilities listed' },
  degraded: { label: 'degraded', tone: 'warn', serves: true, sentence: 'verified, but the provider is failing transiently' },
  needs_reauth: { label: 'needs reauth', tone: 'fail', serves: false, sentence: 'the grant was rejected or lost scope — the client must reauthorise' },
  expired: { label: 'expired', tone: 'fail', serves: false, sentence: 'the authorisation has expired and cannot be refreshed' },
  revoked: { label: 'revoked', tone: 'fail', serves: false, sentence: 'withdrawn — reconnecting makes a new connection' },
  disconnected: { label: 'disconnected', tone: 'idle', serves: false, sentence: 'removed by a person — reconnecting makes a new connection' },
  failed: { label: 'failed', tone: 'fail', serves: false, sentence: 'an authorisation attempt never produced a grant' },
  unsupported: { label: 'unsupported', tone: 'idle', serves: false, sentence: 'no adapter serves this provider in this build' },
  unknown: { label: 'unknown', tone: 'fail', serves: false, sentence: 'a status this build does not recognise — treated as unusable' },
} as const);

export type ConnectionDisplay = keyof typeof CONNECTION_DISPLAY;

/** The fields of ARC-130's safe connection summary this reads — nothing else is needed. */
export interface DisplayableConnection {
  status: string;
  access_expires_at?: string | null;
  refreshable?: boolean;
}

/**
 * One connection's word. `connectable` is whether a tenant could connect this provider at
 * all in this build (a tenant-credentialed version with an adapter); a provider that cannot
 * be connected is `unsupported` whether or not a row exists.
 */
export function connectionDisplay(
  connection: DisplayableConnection | null,
  options: { connectable: boolean; now?: Date },
): ConnectionDisplay {
  if (!connection) return options.connectable ? 'missing' : 'unsupported';
  const status = parseConnectionStatus(connection.status);
  if (!status) return 'unknown';
  switch (status) {
    case 'revoked': return 'revoked';
    case 'disconnected': return 'disconnected';
    case 'failed': return 'failed';
    case 'authorization_pending': return 'pending';
    case 'reauthorization_required': return 'needs_reauth';
  }
  const now = options.now ?? new Date();
  const expiresAt = connection.access_expires_at ? Date.parse(connection.access_expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime() && connection.refreshable !== true) return 'expired';
  if (status === 'connected_unverified') return 'unverified';
  return status === 'degraded' ? 'degraded' : 'connected';
}

/**
 * The credential hint, and only the hint: at most the four characters ARC-130 recorded where
 * the provider spec says they are safe to show. Anything longer than that is not a hint, and
 * is not shown.
 */
export function credentialHint(credential: { hint?: unknown; stored?: unknown } | null | undefined): string | null {
  if (!credential || credential.stored !== true) return null;
  const hint = typeof credential.hint === 'string' ? credential.hint : '';
  return /^[A-Za-z0-9]{1,4}$/.test(hint) ? `••••${hint}` : 'stored';
}

/* ── the readiness checklist ────────────────────────────── */

export const CHECKLIST = [
  { key: 'selection', label: 'selected and eligible', codes: ['module_unavailable', 'module_not_selected', 'lifecycle_state_unknown', 'tenant_inactive'] },
  { key: 'configuration', label: 'configuration published and valid', codes: ['config_not_ready'] },
  { key: 'module_checks', label: 'module checks', codes: ['activation_checks_failed'] },
  { key: 'onboarding', label: 'onboarding steps ticked', codes: ['onboarding_incomplete'] },
  { key: 'connections', label: 'connections ready', codes: ['connection_not_ready'] },
  { key: 'test', label: 'passing test of the current configuration', codes: ['test_evidence_missing'] },
  { key: 'shadow', label: 'shadow evidence', codes: ['shadow_evidence_missing'] },
  { key: 'requirements', label: 'nothing unrecognised pending', codes: ['requirements_pending'] },
  { key: 'health', label: 'health permits activation', codes: ['health_blocks_activation'] },
] as const;

export interface Blocker {
  code: string;
  message: string;
}

export interface ChecklistItem {
  key: string;
  label: string;
  /** ok: nothing blocks it · blocked: at least one blocker · not_required: does not apply. */
  state: 'ok' | 'blocked' | 'not_required';
  detail: string;
  blockers: Blocker[];
}

/** The readiness half of an `ops` lifecycle status, as `statusOut` puts it on the wire. */
export interface WireReadiness {
  ok: boolean;
  blockers: Blocker[];
  onboarding?: { required: string[]; missing: string[] } | null;
  test?: { satisfied: boolean } | null;
  shadow?: { required: boolean; satisfied: boolean } | null;
  pending?: string[];
  health?: { status: string; permits: boolean } | null;
  connections?: { ready: boolean; capabilities: { capability: string; status: string; required: boolean }[] } | null;
}

/**
 * The activation gate's answer, grouped under the questions an operator asks. Every blocker
 * lands under exactly one line; a code this build does not group is shown under "other"
 * rather than dropped, because a reason the screen hides is a reason the operator cannot fix.
 */
export function readinessChecklist(readiness: WireReadiness | null | undefined): ChecklistItem[] {
  const blockers = readiness?.blockers ?? [];
  const grouped = new Set<Blocker>();
  const items: ChecklistItem[] = CHECKLIST.map((entry) => {
    const mine = blockers.filter((b) => (entry.codes as readonly string[]).includes(b.code));
    mine.forEach((b) => grouped.add(b));
    const notRequired = entry.key === 'shadow' && readiness?.shadow?.required === false && mine.length === 0;
    return {
      key: entry.key,
      label: entry.label,
      state: mine.length > 0 ? 'blocked' : notRequired ? 'not_required' : 'ok',
      detail: mine.length > 0 ? mine[0].message : okDetail(entry.key, readiness),
      blockers: mine,
    };
  });
  const other = blockers.filter((b) => !grouped.has(b));
  if (other.length > 0) {
    items.push({ key: 'other', label: 'other', state: 'blocked', detail: other[0].message, blockers: other });
  }
  return items;
}

function okDetail(key: string, readiness: WireReadiness | null | undefined): string {
  switch (key) {
    case 'onboarding': {
      const required = readiness?.onboarding?.required ?? [];
      return required.length ? `${required.length} required step${required.length === 1 ? '' : 's'} ticked` : 'no steps are required';
    }
    case 'connections': {
      const caps = readiness?.connections?.capabilities ?? [];
      const ready = caps.filter((c) => c.status === 'ready').length;
      return caps.length ? `${ready} of ${caps.length} capabilities proven` : 'the module needs no connection';
    }
    case 'shadow':
      return readiness?.shadow?.required ? 'reviewed shadow evidence of the current configuration' : 'this module version does not require shadow mode';
    case 'health':
      return `health is ${readiness?.health?.status ?? 'unverified'}`;
    case 'test':
      return 'a passing synthetic test of exactly these versions';
    default:
      return 'ok';
  }
}

/* ── would a new live run start right now ───────────────── */

export interface WireEffective {
  state: string;
  health: string;
  live: boolean;
  headline: string;
  holds: Blocker[];
}

/**
 * The just-in-time answer, stated once. It is ARC-120's `effectiveStatus` — the same facts
 * `authorizeModuleExecution` reads at every run start — and not a promise: every action and
 * every effect is asked again at the moment it happens.
 */
export function liveRunVerdict(effective: WireEffective | null | undefined): { allowed: boolean; sentence: string; holds: Blocker[] } {
  if (!effective) return { allowed: false, sentence: 'no lifecycle — nothing runs live', holds: [] };
  if (effective.live) return { allowed: true, sentence: 'a new live run would be authorised now — each action and effect is still checked when it happens', holds: [] };
  if (effective.state === 'active') {
    return { allowed: false, sentence: 'active, but new live runs are held', holds: effective.holds ?? [] };
  }
  if (effective.state === 'shadow') {
    return { allowed: false, sentence: 'shadow — real leads are evaluated and recorded as "would have"; nothing is sent', holds: [] };
  }
  return { allowed: false, sentence: `${effective.state} — only an active module runs live`, holds: effective.holds ?? [] };
}

/* ── what going live would change ───────────────────────── */

export interface WirePair {
  tenant_version_id: string;
  module_version_id: string;
}

const same = (a: WirePair | null | undefined, b: WirePair | null | undefined) =>
  Boolean(a && b && a.tenant_version_id === b.tenant_version_id && a.module_version_id === b.module_version_id);

export interface ActivationImpact {
  /** the versions an activation or resumption now would authorise. */
  authorizes: WirePair | null;
  /** what is authorised today. */
  currentlyAuthorized: WirePair | null;
  /** whether the authorisation would move to different versions. */
  changesAuthorization: boolean;
  /** a publication the lifecycle has not evaluated yet — the gate evaluates it first and sends the operator back. */
  unevaluatedChange: boolean;
  /** requirements this act would clear: `review` and `reactivation` are cleared by the act itself. */
  clears: string[];
  sentences: string[];
}

/**
 * What pressing activate (or resume) would do, before it is pressed. Read off the same
 * status the gate is judged on, so it cannot promise anything the server would not do — and
 * the server re-evaluates everything when the button is pressed regardless.
 */
export function activationImpact(status: {
  lifecycle: { authorized: WirePair | null; observed: WirePair | null; pending_requirements?: string[] } | null;
  heads: WirePair | null;
}): ActivationImpact {
  const lifecycle = status.lifecycle;
  const heads = status.heads;
  const pending = normaliseRequirements(lifecycle?.pending_requirements ?? []);
  const unevaluatedChange = Boolean(heads && lifecycle && !same(lifecycle.observed, heads));
  const changesAuthorization = Boolean(heads && !same(lifecycle?.authorized ?? null, heads));
  const sentences: string[] = [];
  if (!heads) sentences.push('nothing is published, so there is nothing to authorise');
  else if (unevaluatedChange) {
    sentences.push('a published change has not been evaluated yet — the first press evaluates it and asks you to review what it requires');
  } else if (changesAuthorization) {
    sentences.push(lifecycle?.authorized
      ? 'authorises the current published versions in place of the ones authorised before'
      : 'authorises the current published versions for live runs for the first time');
  } else {
    sentences.push('authorises the versions already authorised — nothing about the configuration changes');
  }
  if (pending.length > 0) sentences.push(`clears ${pending.join(', ')} — evidence is checked for retest and shadow; this act is the review and the reactivation`);
  sentences.push('new live runs are pinned to exactly these versions; runs already in flight keep their own');
  return {
    authorizes: heads,
    currentlyAuthorized: lifecycle?.authorized ?? null,
    changesAuthorization,
    unevaluatedChange,
    clears: pending,
    sentences,
  };
}

/* ── a connection test, as the console shows it ─────────── */

export interface WireConnectionTest {
  run_status: string;
  action_status: string;
  outcome: string | null;
  error_code: string | null;
  message: string | null;
  gate: { code: string; detail: string | null } | null;
}

/** One line for the latest test of a connection, from ARC's own rows. */
export function connectionTestVerdict(test: WireConnectionTest | null | undefined): { tone: string; word: string; sentence: string } {
  if (!test) return { tone: 'idle', word: 'never tested', sentence: 'no test has been run against this connection' };
  if (test.action_status === 'done' && test.outcome === 'succeeded') return { tone: 'ok', word: 'passed', sentence: 'the provider confirmed the account and its capabilities' };
  if (test.action_status === 'pending' && test.gate && test.gate.code !== 'ok') {
    return { tone: 'warn', word: 'held', sentence: test.gate.detail ?? test.gate.code };
  }
  if (test.action_status === 'pending' || test.action_status === 'claimed' || test.action_status === 'running') {
    return { tone: 'neutral', word: 'queued', sentence: 'waiting for the scheduler to run it' };
  }
  if (test.action_status === 'blocked') return { tone: 'fail', word: 'blocked', sentence: test.gate?.detail ?? test.message ?? 'blocked for a person' };
  if (test.action_status === 'skipped') return { tone: 'idle', word: 'skipped', sentence: test.gate?.detail ?? 'nothing to test' };
  return { tone: 'fail', word: 'failed', sentence: [test.error_code, test.message].filter(Boolean).join(' — ') || 'the test failed' };
}
