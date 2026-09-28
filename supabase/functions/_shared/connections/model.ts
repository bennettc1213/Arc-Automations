/**
 * ARC-130 — tenant provider connections: the vocabulary, the legal transitions, and the
 * typed errors. The one list of each; 0016 seeds and checks the same matrix, and a drift
 * test holds the two together.
 *
 * A provider connection is a tenant's authorised account at an external provider,
 * reusable by every module whose requirements that provider's capabilities satisfy. It is
 * not a workflow, not configuration, and not a credential: the credential behind it lives
 * in Supabase Vault (ADR ARC-010 §20a), and ordinary tables hold only an opaque reference
 * to it in a schema no API exposes.
 *
 * The rule the statuses are written to obey: **a token is not readiness.** A connection
 * is usable for a provider operation only once its account identity, its granted scopes
 * and its capabilities have been verified — `verified`, or `degraded` (verified, with a
 * transient provider problem since). Anything else, and anything this build does not
 * recognise, fails closed.
 */

/* ── statuses ───────────────────────────────────────────── */

export const CONNECTION_STATUSES = [
  'authorization_pending',     // a flow was started; nothing has been granted yet
  'connected_unverified',      // a credential is stored; identity/scopes/capabilities not yet proven
  'verified',                  // identity, scopes and capabilities proven — usable
  'degraded',                  // verified, but the provider is failing transiently — usable, watched
  'reauthorization_required',  // the grant is gone or insufficient; a person must reconnect
  'revoked',                   // authorisation withdrawn (by ARC or at the provider) — terminal
  'disconnected',              // removed by a person — terminal
  'failed',                    // an authorisation attempt that never produced a usable grant
] as const;
export type ConnectionStatus = typeof CONNECTION_STATUSES[number];

export const TERMINAL_STATUSES: readonly ConnectionStatus[] = ['revoked', 'disconnected'];

/** Statuses under which a stored credential may be used for a provider operation. */
export const USABLE_STATUSES: readonly ConnectionStatus[] = ['verified', 'degraded'];

/**
 * Statuses under which a stored credential may be used for ARC's own housekeeping of the
 * grant — verifying it, refreshing it, revoking it — but never for a provider operation.
 */
export const MAINTAINABLE_STATUSES: readonly ConnectionStatus[] = ['connected_unverified', 'verified', 'degraded', 'reauthorization_required'];

export function parseConnectionStatus(value: unknown): ConnectionStatus | null {
  return typeof value === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(value)
    ? value as ConnectionStatus
    : null;
}

export const AUTH_METHODS = ['oauth2', 'api_key'] as const;
export type AuthMethod = typeof AUTH_METHODS[number];

/** What a credential-store operation is for. There is no "read" operation. */
export const CREDENTIAL_OPERATIONS = ['provider_operation', 'verify', 'refresh', 'revoke'] as const;
export type CredentialOperation = typeof CREDENTIAL_OPERATIONS[number];

export const CREDENTIAL_KINDS = ['oauth_tokens', 'api_key'] as const;
export type CredentialKind = typeof CREDENTIAL_KINDS[number];

export const CREDENTIAL_VERSION_STATUSES = ['active', 'retired', 'purged', 'purge_failed'] as const;
export type CredentialVersionStatus = typeof CREDENTIAL_VERSION_STATUSES[number];

export const CONNECTION_ACTOR_TYPES = ['manager', 'system'] as const;
export type ConnectionActorType = typeof CONNECTION_ACTOR_TYPES[number];
export type ConnectionActor = { type: 'manager'; id: string } | { type: 'system'; id: null };
export const SYSTEM_CONNECTION_ACTOR: ConnectionActor = Object.freeze({ type: 'system' as const, id: null });

export const AUTHORIZATION_PURPOSES = ['connect', 'reauthorize', 'replace'] as const;
export type AuthorizationPurpose = typeof AUTHORIZATION_PURPOSES[number];

export const SESSION_OUTCOMES = ['pending', 'exchanging', 'completed', 'denied', 'expired', 'failed'] as const;
export type SessionOutcome = typeof SESSION_OUTCOMES[number];

/* ── the transition matrix ──────────────────────────────── */

export const CONNECTION_EVENTS = [
  'begin_authorization',
  'complete_authorization',
  'authorization_failed',
  'verification_succeeded',
  'verification_failed',
  'provider_degraded',
  'credential_rotated',
  'reauthorization_required',
  'disconnect',
  'revoke',
] as const;
export type ConnectionEvent = typeof CONNECTION_EVENTS[number];

export interface ConnectionTransitionRule {
  event: ConnectionEvent;
  from: readonly ConnectionStatus[];
  /** `same` leaves the status where it was (the event is still recorded). */
  to: ConnectionStatus | 'same';
  actors: readonly ConnectionActorType[];
  meaning: string;
}

const NON_TERMINAL: readonly ConnectionStatus[] = CONNECTION_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

/**
 * Every legal (event, from) pair and where it lands. Deterministic: at most one rule per
 * (event, from). Terminal statuses have no way out — reconnecting after a disconnection
 * creates a new connection with a new id, so nothing that referred to the old one can
 * quietly start working again.
 */
export const CONNECTION_TRANSITIONS: readonly ConnectionTransitionRule[] = Object.freeze([
  {
    event: 'begin_authorization',
    from: ['authorization_pending', 'failed'],
    to: 'authorization_pending',
    actors: ['manager'],
    meaning: 'a person started (or restarted) an authorisation for a connection that has no usable grant',
  },
  {
    event: 'begin_authorization',
    from: ['connected_unverified', 'verified', 'degraded', 'reauthorization_required'],
    to: 'same',
    actors: ['manager'],
    meaning: 'a person started reauthorising an existing connection; it keeps working on its current grant until the new one lands',
  },
  {
    event: 'complete_authorization',
    from: ['authorization_pending', 'failed', 'connected_unverified', 'verified', 'degraded', 'reauthorization_required'],
    to: 'connected_unverified',
    actors: ['manager'],
    meaning: 'a grant was exchanged server-side and its credential stored — nothing is usable until it is verified',
  },
  {
    event: 'authorization_failed',
    from: ['authorization_pending'],
    to: 'failed',
    actors: ['manager', 'system'],
    meaning: 'a first authorisation was denied, expired or could not be exchanged',
  },
  {
    event: 'authorization_failed',
    from: ['connected_unverified', 'verified', 'degraded', 'reauthorization_required', 'failed'],
    to: 'same',
    actors: ['manager', 'system'],
    meaning: 'a reauthorisation attempt failed; the existing grant, if any, is untouched',
  },
  {
    event: 'verification_succeeded',
    from: ['connected_unverified', 'verified', 'degraded'],
    to: 'verified',
    actors: ['manager', 'system'],
    meaning: 'account identity, granted scopes and capabilities were proven against the provider',
  },
  {
    event: 'verification_failed',
    from: ['connected_unverified', 'verified', 'degraded'],
    to: 'reauthorization_required',
    actors: ['manager', 'system'],
    meaning: 'the grant is missing scopes or capabilities a registered requirement needs, or names another account',
  },
  {
    event: 'provider_degraded',
    from: ['verified', 'degraded'],
    to: 'degraded',
    actors: ['system'],
    meaning: 'the provider failed transiently; the grant is believed valid',
  },
  {
    event: 'credential_rotated',
    from: ['connected_unverified', 'verified', 'degraded'],
    to: 'same',
    actors: ['manager', 'system'],
    meaning: 'a new credential version became active and the previous one was retired',
  },
  {
    event: 'reauthorization_required',
    from: ['connected_unverified', 'verified', 'degraded', 'reauthorization_required'],
    to: 'reauthorization_required',
    actors: ['manager', 'system'],
    meaning: 'the grant was refused permanently (invalid_grant, revoked at the provider) or a person asked for it to be redone',
  },
  {
    event: 'disconnect',
    from: NON_TERMINAL,
    to: 'disconnected',
    actors: ['manager'],
    meaning: 'a person removed the connection; its credentials are retired at once',
  },
  {
    event: 'revoke',
    from: NON_TERMINAL,
    to: 'revoked',
    actors: ['manager', 'system'],
    meaning: 'authorisation was withdrawn; its credentials are retired at once, whatever the provider said',
  },
]);

export type LegalTransition = { ok: true; to: ConnectionStatus } | { ok: false; code: ConnectionErrorCode; message: string };

export function legalConnectionTransition(
  event: string,
  from: ConnectionStatus | null,
  actor: ConnectionActorType,
): LegalTransition {
  if (!(CONNECTION_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, code: 'illegal_transition', message: `${event} is not a connection event` };
  }
  if (from === null) {
    return { ok: false, code: 'connection_status_unknown', message: 'the stored connection status is not one this build knows — nothing will be changed on top of it' };
  }
  const rule = CONNECTION_TRANSITIONS.find((r) => r.event === event && r.from.includes(from));
  if (!rule) return { ok: false, code: 'illegal_transition', message: `${event} is not allowed from ${from}` };
  if (!rule.actors.includes(actor)) return { ok: false, code: 'forbidden', message: `${event} is not something ${actor === 'system' ? 'the system' : 'a person'} may do` };
  return { ok: true, to: rule.to === 'same' ? from : rule.to };
}

/** Every (event, from, to, actor) the matrix allows — what 0016 seeds, for the drift test. */
export function expandedConnectionRules(): { event: string; from: string; to: string; actor: string }[] {
  const out: { event: string; from: string; to: string; actor: string }[] = [];
  for (const rule of CONNECTION_TRANSITIONS) {
    for (const from of rule.from) {
      for (const actor of rule.actors) out.push({ event: rule.event, from, to: rule.to === 'same' ? from : rule.to, actor });
    }
  }
  return out.sort((a, b) => `${a.event}|${a.from}|${a.actor}`.localeCompare(`${b.event}|${b.from}|${b.actor}`));
}

/* ── rows (safe: nothing here is secret, and no row carries a secret reference) ── */

export interface ConnectionRow {
  id: string;
  tenantId: string;
  connectorKey: string;
  connectorVersion: number;
  authMethod: AuthMethod;
  status: string;
  /** the optimistic lock. every change increments it. */
  statusVersion: number;
  externalAccountId: string | null;
  externalAccountLabel: string | null;
  displayMetadata: Record<string, unknown>;
  grantedScopes: string[];
  verifiedCapabilities: string[];
  /** 0 when no credential is stored. */
  credentialVersion: number;
  /** last four characters of an API key, when the provider schema says that is safe. */
  credentialHint: string | null;
  accessExpiresAt: string | null;
  refreshable: boolean;
  lastVerifiedAt: string | null;
  lastRefreshAttemptAt: string | null;
  lastRefreshResult: string | null;
  healthStatus: 'unverified' | 'healthy' | 'degraded' | 'failing';
  healthReason: string | null;
  healthCheckedAt: string | null;
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface ConnectionEventRow {
  id: string;
  tenantId: string;
  connectionId: string | null;
  sessionId: string | null;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  statusVersion: number | null;
  actorType: ConnectionActorType;
  actorId: string | null;
  reasonCode: string;
  correlationId: string | null;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** What a browser, an operator or a log may see of a credential version. */
export interface CredentialMetadata {
  connectionId: string;
  version: number;
  kind: CredentialKind;
  status: CredentialVersionStatus;
  hint: string | null;
  createdAt: string;
  retiredAt: string | null;
}

/* ── typed errors ───────────────────────────────────────── */

export const CONNECTION_ERROR_CODES = [
  'invalid_state',
  'state_expired',
  'state_replayed',
  'session_binding_mismatch',
  'pkce_failed',
  'provider_denied',
  'token_exchange_failed',
  'invalid_token_response',
  'missing_refresh_token',
  'scope_mismatch',
  'capability_mismatch',
  'account_mismatch',
  'account_replacement_unconfirmed',
  'oidc_invalid',
  'provider_unavailable',
  'provider_revoked',
  'reauthorization_required',
  'secret_storage_failed',
  'credential_unavailable',
  'stale_version',
  'idempotency_conflict',
  'forbidden',
  'not_found',
  'illegal_transition',
  'connection_status_unknown',
  'unknown_provider',
  'unsupported_auth_method',
  'invalid_scope_request',
  'invalid_return_path',
  'invalid_redirect',
  'endpoint_not_registered',
  'refresh_in_progress',
  'rate_limited',
  'invalid_credential',
  'environment_forbidden',
  'vault_unavailable',
  'operation_not_permitted',
  'connection_exists',
  'invalid_request',
] as const;
export type ConnectionErrorCode = typeof CONNECTION_ERROR_CODES[number];

/** HTTP status for each code — used by the edge function, never a provider's own. */
export const CONNECTION_ERROR_STATUS: Readonly<Record<ConnectionErrorCode, number>> = Object.freeze({
  invalid_state: 400,
  state_expired: 410,
  state_replayed: 409,
  session_binding_mismatch: 403,
  pkce_failed: 400,
  provider_denied: 400,
  token_exchange_failed: 502,
  invalid_token_response: 502,
  missing_refresh_token: 502,
  scope_mismatch: 422,
  capability_mismatch: 422,
  account_mismatch: 409,
  account_replacement_unconfirmed: 409,
  oidc_invalid: 502,
  provider_unavailable: 503,
  provider_revoked: 409,
  reauthorization_required: 409,
  secret_storage_failed: 500,
  credential_unavailable: 409,
  stale_version: 409,
  idempotency_conflict: 409,
  forbidden: 403,
  not_found: 404,
  illegal_transition: 409,
  connection_status_unknown: 409,
  unknown_provider: 400,
  unsupported_auth_method: 400,
  invalid_scope_request: 400,
  invalid_return_path: 400,
  invalid_redirect: 500,
  endpoint_not_registered: 500,
  refresh_in_progress: 409,
  rate_limited: 429,
  invalid_credential: 400,
  environment_forbidden: 500,
  vault_unavailable: 503,
  operation_not_permitted: 403,
  connection_exists: 409,
  invalid_request: 400,
});

/**
 * A refusal with a stable code and a sentence that names no secret. Every message that
 * reaches a caller is built by ARC; a provider's own error body never is.
 */
export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: ConnectionErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
    this.detail = detail;
  }
}

export function isConnectionErrorCode(value: unknown): value is ConnectionErrorCode {
  return typeof value === 'string' && (CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 0016 raises `arc_connection:<code>: <sentence>`. Anything else from the database is
 * reported as a storage failure with no database text attached — a constraint message
 * can quote a value.
 */
export function parseConnectionStoreError(message: unknown): ConnectionError {
  const text = typeof message === 'string' ? message : '';
  const match = /arc_connection:([a-z_]+):\s*([^\n]*)/.exec(text);
  if (match && isConnectionErrorCode(match[1])) return new ConnectionError(match[1], match[2].trim().slice(0, 300));
  return new ConnectionError('secret_storage_failed', 'the connection store refused the request');
}

/** A connection's facts as ARC-120's readiness reads them. No secret, no reference. */
export interface ConnectionFact {
  id: string;
  connectorKey: string;
  connectorVersion: number;
  status: string;
  grantedScopes: string[];
  verifiedCapabilities: string[];
  credentialVersion: number;
  accessExpiresAt: string | null;
  refreshable: boolean;
  lastVerifiedAt: string | null;
  healthStatus: string;
}

export function factOf(row: ConnectionRow): ConnectionFact {
  return {
    id: row.id,
    connectorKey: row.connectorKey,
    connectorVersion: row.connectorVersion,
    status: row.status,
    grantedScopes: [...row.grantedScopes],
    verifiedCapabilities: [...row.verifiedCapabilities],
    credentialVersion: row.credentialVersion,
    accessExpiresAt: row.accessExpiresAt,
    refreshable: row.refreshable,
    lastVerifiedAt: row.lastVerifiedAt,
    healthStatus: row.healthStatus,
  };
}
