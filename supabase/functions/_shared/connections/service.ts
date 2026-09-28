/**
 * ARC-130 — the connection service. Every rule a caller could get wrong lives here, not in
 * a handler; every provider call goes through an adapter over a guarded transport; every
 * write is one store call that 0016 re-checks.
 *
 *   beginOAuthAuthorization    state, PKCE S256, nonce, server-derived redirect, scopes from
 *                              the registry's capability map — never from the request.
 *   completeOAuthCallback      claim the state once (for the actor who began it), exchange
 *                              server-side with the verifier, verify the account and the
 *                              scopes, store the grant in Vault, then verify capabilities.
 *   storeApiKey                write-only: validated against the provider's own field
 *                              schema, verified by the provider, stored, never echoed.
 *   verifyConnection           re-prove identity, scopes and capabilities.
 *   refreshAccessToken         on demand, single-flight under a lease, new credential stored
 *                              before the old one is retired, temporary ≠ permanent.
 *   withProviderCredential     THE credential-access path: a named operation on a connection
 *                              verified for the capability, the secret in scope for one call.
 *   disconnect / revoke        local use stops in the same transaction; provider revocation
 *                              is attempted and its answer recorded, never relied on.
 *   requestReauthorization     a person says the grant must be redone.
 *
 * A lost or broken connection pauses the active modules that depend on it and marks their
 * health (lifecycle-effects.ts). Nothing here ever activates or resumes a module.
 */

import type { ConnectorVersion, OAuthSpec } from '../registry/connectors.ts';
import {
  type ClientCredentials,
  connectionSpec,
  guardedTransport,
  type ProviderTransport,
  scopesFor,
  type TokenSet,
} from './adapter.ts';
import { resolveProvider } from './catalog.ts';
import { requireAvailable } from './credential-store.ts';
import { applyConnectionLoss, applyConnectionRecovery, type LifecycleEffectsStore } from './lifecycle-effects.ts';
import {
  AUTH_METHODS,
  ConnectionError,
  type ConnectionRow,
  type CredentialOperation,
  SYSTEM_CONNECTION_ACTOR,
} from './model.ts';
import {
  AUTHORIZATION_TTL_SECONDS,
  oauthRedirectUri,
  parseCodeParam,
  parseStateParam,
  pkceChallenge,
  randomSecret,
  safeReturnPath,
  secretDigest,
} from './oauth.ts';
import { safeLog, SecretValue } from './redact.ts';
import type { RuntimeEnvironment } from './runtime-env.ts';
import type { ConnectionStore, VerificationFacts } from './store.ts';

export interface ConnectionServiceDeps {
  store: ConnectionStore;
  /** the raw transport; every use is wrapped by `guardedTransport` for the provider in question. */
  transport: ProviderTransport;
  environment: RuntimeEnvironment;
  oauth: {
    siteUrl: string | null;
    redirectUrl: string | null;
    /** the provider application's client id and secret, from server environment; null when unset. */
    clientCredentials(oauth: OAuthSpec): ClientCredentials | null;
  };
  /** the lifecycle tables, when this runtime has them: a lost connection pauses its dependants. */
  lifecycle?: LifecycleEffectsStore | null;
  now?: () => Date;
}

const now = (deps: ConnectionServiceDeps) => (deps.now ? deps.now() : new Date());
const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;

/* ── what anyone outside the service may see of a connection ── */

export interface ConnectionSummary {
  id: string;
  connector_key: string;
  connector_version: number;
  auth_method: string;
  status: string;
  status_version: number;
  usable: boolean;
  account: { id: string | null; label: string | null; metadata: Record<string, unknown> };
  granted_scopes: string[];
  verified_capabilities: string[];
  credential: { version: number; hint: string | null; stored: boolean };
  access_expires_at: string | null;
  refreshable: boolean;
  last_verified_at: string | null;
  last_refresh_result: string | null;
  health: { status: string; reason: string | null; checked_at: string | null };
  created_at: string;
  ended_at: string | null;
}

export function summarize(row: ConnectionRow): ConnectionSummary {
  return {
    id: row.id,
    connector_key: row.connectorKey,
    connector_version: row.connectorVersion,
    auth_method: row.authMethod,
    status: row.status,
    status_version: row.statusVersion,
    usable: row.status === 'verified' || row.status === 'degraded',
    account: { id: row.externalAccountId, label: row.externalAccountLabel, metadata: { ...row.displayMetadata } },
    granted_scopes: [...row.grantedScopes],
    verified_capabilities: [...row.verifiedCapabilities],
    credential: { version: row.credentialVersion, hint: row.credentialHint, stored: row.credentialVersion > 0 && !row.endedAt },
    access_expires_at: row.accessExpiresAt,
    refreshable: row.refreshable,
    last_verified_at: row.lastVerifiedAt,
    last_refresh_result: row.lastRefreshResult,
    health: { status: row.healthStatus, reason: row.healthReason, checked_at: row.healthCheckedAt },
    created_at: row.createdAt,
    ended_at: row.endedAt,
  };
}

async function requireManager(deps: ConnectionServiceDeps, tenantId: string, actorId: string | null): Promise<string> {
  if (!actorId) throw new ConnectionError('forbidden', 'not signed in');
  if (!(await deps.store.isConnectionManager(tenantId, actorId))) {
    throw new ConnectionError('forbidden', 'managing this client\'s connections needs an operator or the client\'s owner');
  }
  return actorId;
}

async function requireConnection(deps: ConnectionServiceDeps, tenantId: string, connectionId: unknown): Promise<ConnectionRow> {
  const id = text(connectionId, 36);
  /* another tenant's connection and no connection are the same answer. */
  const row = id ? await deps.store.getConnection(tenantId, id) : null;
  if (!row) throw new ConnectionError('not_found', 'no such connection for this client');
  return row;
}

function versionOf(deps: ConnectionServiceDeps, row: ConnectionRow): { version: ConnectorVersion; adapter: ReturnType<typeof resolveProvider>['adapter'] } {
  const method = (AUTH_METHODS as readonly string[]).includes(row.authMethod) ? row.authMethod : null;
  if (!method) throw new ConnectionError('unsupported_auth_method', 'this connection uses an auth method this build does not know');
  return resolveProvider(deps.store.connectorCatalog, row.connectorKey, method, row.connectorVersion);
}

function clientFor(deps: ConnectionServiceDeps, version: ConnectorVersion): ClientCredentials {
  const oauth = connectionSpec(version).oauth!;
  const credentials = deps.oauth.clientCredentials(oauth);
  if (!credentials || !credentials.clientId) {
    throw new ConnectionError('unknown_provider', `${version.connectorKey} is not configured in this environment`);
  }
  return credentials;
}

/* ── OAuth: begin ───────────────────────────────────────── */

export interface BeginOAuthRequest {
  tenantId: string;
  actorId: string | null;
  connectorKey: unknown;
  purpose?: unknown;
  targetConnectionId?: unknown;
  expectedStatusVersion?: unknown;
  /** capabilities the connection should serve; defaults to everything the provider offers. Never scopes. */
  capabilities?: unknown;
  returnPath?: unknown;
  correlationId?: string | null;
}

export async function beginOAuthAuthorization(deps: ConnectionServiceDeps, req: BeginOAuthRequest) {
  const actorId = await requireManager(deps, req.tenantId, req.actorId);
  await requireAvailable(deps.store.credentials);
  const { version, adapter } = resolveProvider(deps.store.connectorCatalog, req.connectorKey, 'oauth2');
  const oauth = connectionSpec(version).oauth!;

  const purpose = req.purpose === undefined || req.purpose === null ? 'connect' : req.purpose;
  if (purpose !== 'connect' && purpose !== 'reauthorize' && purpose !== 'replace') {
    throw new ConnectionError('invalid_request', 'purpose is connect, reauthorize or replace');
  }
  let capabilities: string[];
  if (req.capabilities === undefined || req.capabilities === null) {
    capabilities = [...version.capabilities];
  } else if (Array.isArray(req.capabilities) && req.capabilities.length > 0 && req.capabilities.every((c) => typeof c === 'string')) {
    capabilities = [...new Set(req.capabilities as string[])].sort();
  } else {
    throw new ConnectionError('invalid_scope_request', 'capabilities must be a list of capability keys');
  }
  const scopes = scopesFor(version, capabilities); // refuses a capability the provider does not offer

  const client = clientFor(deps, version);
  const redirectUri = oauthRedirectUri({ siteUrl: deps.oauth.siteUrl, redirectUrl: deps.oauth.redirectUrl, environment: deps.environment });
  const returnPath = safeReturnPath(req.returnPath);

  const state = randomSecret(32);
  const verifier = oauth.pkce === 'S256' ? randomSecret(32) : null;
  const nonce = oauth.oidc ? randomSecret(32) : null;

  const targetConnectionId = purpose === 'connect' ? null : text(req.targetConnectionId, 36);
  const expected = purpose === 'connect' ? null : req.expectedStatusVersion;
  if (purpose !== 'connect' && (!targetConnectionId || typeof expected !== 'number' || !Number.isInteger(expected))) {
    throw new ConnectionError('stale_version', 'reauthorising or replacing names the connection and the status version you read');
  }

  const began = await deps.store.beginAuthorization({
    tenantId: req.tenantId,
    actor: { type: 'manager', id: actorId },
    connectorKey: version.connectorKey,
    connectorVersion: version.version,
    purpose,
    targetConnectionId,
    expectedStatusVersion: expected as number | null,
    stateDigest: await secretDigest(state),
    nonceDigest: nonce ? await secretDigest(nonce) : null,
    pkceVerifier: verifier,
    pkceMethod: verifier ? 'S256' : null,
    requestedScopes: scopes,
    requestedCapabilities: capabilities,
    redirectUri,
    returnPath,
    ttlSeconds: AUTHORIZATION_TTL_SECONDS,
    /* the state exists only in this response, so a begin is never replayed: each is its own session. */
    idempotencyKey: `oauth:begin:${crypto.randomUUID()}`,
    correlationId: req.correlationId ?? null,
  });

  const url = adapter.authorizationUrl(version, {
    clientId: client.clientId,
    redirectUri,
    state,
    codeChallenge: verifier ? await pkceChallenge(verifier) : null,
    scopes,
    nonce,
  });
  safeLog('authorization_initiated', { tenant_id: req.tenantId, connection_id: began.connectionId, connector: version.connectorKey, url: url.reveal(), correlation_id: req.correlationId ?? null });
  return {
    session_id: began.sessionId,
    connection_id: began.connectionId,
    expires_at: began.expiresAt,
    /* the only place state, challenge and nonce travel: to the browser, which takes them to the provider. */
    authorization_url: url.reveal(),
  };
}

/* ── OAuth: the callback ────────────────────────────────── */

export interface OAuthCallbackRequest {
  actorId: string | null;
  state: unknown;
  code?: unknown;
  /** the provider's `error` parameter, when consent was refused. */
  error?: unknown;
  /** the provider the callback route claims; must match the session's, when present. */
  connectorKey?: unknown;
  confirmAccountReplacement?: unknown;
  correlationId?: string | null;
}

export async function completeOAuthCallback(deps: ConnectionServiceDeps, req: OAuthCallbackRequest) {
  if (!req.actorId) throw new ConnectionError('forbidden', 'not signed in');
  await requireAvailable(deps.store.credentials);
  const state = parseStateParam(req.state);
  /* nothing about the tenant, the connection, the provider, the scopes or the redirect is taken from the callback. */
  const claim = await deps.store.claimAuthorization({ stateDigest: await secretDigest(state), actorId: req.actorId });
  const fail = async (error: ConnectionError): Promise<never> => {
    await deps.store.failAuthorization({ sessionId: claim.sessionId, tenantId: claim.tenantId, actorId: req.actorId, code: error.code });
    safeLog('authorization_failed', { tenant_id: claim.tenantId, connection_id: claim.connectionId, code: error.code, correlation_id: req.correlationId ?? null });
    throw error;
  };

  if (claim.alreadyCompleted) {
    const row = await requireConnection(deps, claim.tenantId, claim.connectionId);
    return { replayed: true, return_path: claim.returnPath, connection: summarize(row) };
  }
  if (req.connectorKey !== undefined && req.connectorKey !== null && req.connectorKey !== claim.connectorKey) {
    return await fail(new ConnectionError('session_binding_mismatch', 'the callback is for a different provider than the authorisation'));
  }
  if (req.error !== undefined && req.error !== null) {
    return await fail(new ConnectionError('provider_denied', 'the provider did not grant access'));
  }
  let code: SecretValue;
  try {
    code = parseCodeParam(req.code);
  } catch (error) {
    return await fail(error as ConnectionError);
  }

  let version: ConnectorVersion;
  let adapter;
  let client: ClientCredentials;
  try {
    ({ version, adapter } = resolveProvider(deps.store.connectorCatalog, claim.connectorKey, 'oauth2', claim.connectorVersion));
    client = clientFor(deps, version);
  } catch (error) {
    return await fail(error instanceof ConnectionError ? error : new ConnectionError('unknown_provider', 'the provider is not available'));
  }
  const transport = guardedTransport(version, deps.transport);

  let tokens: TokenSet;
  let identity;
  try {
    tokens = await adapter.exchangeCode(version, { ...client, code, verifier: claim.verifier, redirectUri: claim.redirectUri }, transport);
    identity = await adapter.identity(version, {
      accessToken: tokens.accessToken, idToken: tokens.idToken, nonceDigest: claim.nonceDigest, clientId: client.clientId, now: now(deps),
    }, transport);
  } catch (error) {
    return await fail(error instanceof ConnectionError ? error : new ConnectionError('token_exchange_failed', 'the provider exchange failed'));
  }

  const granted = tokens.scopes ?? [...claim.requestedScopes];
  const bundle = new SecretValue(JSON.stringify({
    kind: 'oauth_tokens',
    access_token: tokens.accessToken.reveal(),
    refresh_token: tokens.refreshToken?.reveal() ?? null,
    token_type: tokens.tokenType,
    expires_at: tokens.expiresAt,
  }));

  let completed;
  try {
    completed = await deps.store.completeAuthorization({
      sessionId: claim.sessionId,
      tenantId: claim.tenantId,
      actorId: req.actorId,
      secret: bundle,
      identity,
      grantedScopes: granted,
      accessExpiresAt: tokens.expiresAt,
      refreshable: tokens.refreshToken !== null,
      confirmAccountReplacement: req.confirmAccountReplacement === true,
      correlationId: req.correlationId ?? null,
    });
  } catch (error) {
    /* the grant was issued but will not be kept: give it back to the provider. */
    await adapter.revoke(version, { ...client, token: tokens.refreshToken ?? tokens.accessToken }, transport).catch(() => 'ambiguous');
    return await fail(error instanceof ConnectionError ? error : new ConnectionError('secret_storage_failed', 'the grant could not be stored'));
  }

  /* a token is not readiness: prove scopes and capabilities, as a separate, recorded step. */
  const verifiedCapabilities = await adapter.verifyCapabilities(version, { accessToken: tokens.accessToken, grantedScopes: granted }, transport);
  const missing = claim.requestedCapabilities.filter((c) => !verifiedCapabilities.includes(c));
  const facts: VerificationFacts = { ...identity, grantedScopes: granted, verifiedCapabilities };
  const verified = await deps.store.recordConnectionEvent({
    tenantId: claim.tenantId,
    connectionId: completed.connection.id,
    event: missing.length === 0 ? 'verification_succeeded' : 'verification_failed',
    actor: SYSTEM_CONNECTION_ACTOR,
    expectedStatusVersion: completed.connection.statusVersion,
    reasonCode: missing.length === 0 ? 'verified_at_authorization' : 'scope_mismatch',
    verification: facts,
    idempotencyKey: `oauth:verify:${claim.sessionId}`,
    correlationId: req.correlationId ?? null,
    metadata: missing.length ? { missing_capabilities: missing } : {},
  });
  await deps.store.credentials.purgeRetired({ tenantId: claim.tenantId, connectionId: completed.connection.id });
  safeLog('authorization_completed', { tenant_id: claim.tenantId, connection_id: completed.connection.id, status: verified.connection.status, correlation_id: req.correlationId ?? null });

  if (missing.length > 0) {
    await applyConnectionLoss(deps.lifecycle ?? null, deps.store, verified.connection, 'scope_mismatch');
    throw new ConnectionError('scope_mismatch', `the provider did not grant what ${missing.join(', ')} needs — reauthorise and approve every permission`, {
      connection: summarize(verified.connection),
    });
  }
  /* the overlay may recover; a paused module stays paused. */
  await applyConnectionRecovery(deps.lifecycle ?? null, deps.store, verified.connection);
  return { replayed: false, return_path: claim.returnPath, connection: summarize(verified.connection) };
}

/* ── write-only API keys ────────────────────────────────── */

export interface StoreApiKeyRequest {
  tenantId: string;
  actorId: string | null;
  connectorKey: unknown;
  connectionId?: unknown;
  expectedStatusVersion?: unknown;
  expectedCredentialVersion?: unknown;
  /** the provider-defined fields. The only place a key is accepted, and it is never echoed. */
  credential: unknown;
  confirmAccountReplacement?: unknown;
  idempotencyKey?: unknown;
  correlationId?: string | null;
}

/** Exactly the provider's declared fields, each matching its declared shape — or refused, naming the field only. */
export function validateCredentialFields(version: ConnectorVersion, input: unknown): { fields: Record<string, string>; hint: string | null } {
  const specs = connectionSpec(version).credentialFields ?? [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConnectionError('invalid_credential', 'the credential must be an object of the provider\'s fields');
  }
  const given = Object.keys(input as Record<string, unknown>);
  const unknown = given.filter((k) => !specs.some((s) => s.name === k));
  if (unknown.length > 0) throw new ConnectionError('invalid_credential', `the provider takes no field named ${unknown.map((k) => k.slice(0, 40)).join(', ')}`);
  const fields: Record<string, string> = {};
  let hint: string | null = null;
  for (const spec of specs) {
    const value = (input as Record<string, unknown>)[spec.name];
    if (typeof value !== 'string' || value.length < spec.minLength || value.length > spec.maxLength || !new RegExp(spec.pattern).test(value)) {
      throw new ConnectionError('invalid_credential', `${spec.name} is not in the provider's format`);
    }
    fields[spec.name] = value;
    if (spec.hintSafe && hint === null) hint = value.slice(-4);
  }
  return { fields, hint };
}

export async function storeApiKey(deps: ConnectionServiceDeps, req: StoreApiKeyRequest) {
  const actorId = await requireManager(deps, req.tenantId, req.actorId);
  await requireAvailable(deps.store.credentials);
  const connectionId = req.connectionId === undefined || req.connectionId === null ? null : text(req.connectionId, 36);
  let row: ConnectionRow | null = null;
  if (connectionId) row = await requireConnection(deps, req.tenantId, connectionId);
  const { version, adapter } = row
    ? versionOf(deps, row)
    : resolveProvider(deps.store.connectorCatalog, req.connectorKey, 'api_key');
  if (row && row.connectorKey !== req.connectorKey) throw new ConnectionError('not_found', 'no such connection for this client');
  const { fields, hint } = validateCredentialFields(version, req.credential);
  const secret = new SecretValue(fields);

  /* the provider is asked BEFORE anything is stored, so a rotation never replaces a working key with a bad one. */
  let verification: VerificationFacts | null = null;
  try {
    const result = await adapter.verifyApiKey(version, { fields: secret }, guardedTransport(version, deps.transport));
    verification = { ...result.identity, grantedScopes: [], verifiedCapabilities: result.capabilities };
  } catch (error) {
    const code = error instanceof ConnectionError ? error.code : 'provider_unavailable';
    /* a first key the provider could not be asked about is stored unverified; a rotation is refused. */
    if (code !== 'provider_unavailable' || row) throw error instanceof ConnectionError ? error : new ConnectionError(code, 'the provider could not verify the key');
  }

  const expectedStatus = row ? req.expectedStatusVersion : null;
  const expectedCredential = row ? req.expectedCredentialVersion : null;
  if (row && (typeof expectedStatus !== 'number' || typeof expectedCredential !== 'number')) {
    throw new ConnectionError('stale_version', 'rotating a key names the status and credential versions you read');
  }
  const mutation = await deps.store.storeApiKey({
    tenantId: req.tenantId,
    actor: { type: 'manager', id: actorId },
    connectionId: row?.id ?? null,
    connectorKey: version.connectorKey,
    connectorVersion: version.version,
    expectedStatusVersion: expectedStatus as number | null,
    expectedCredentialVersion: expectedCredential as number | null,
    secret: new SecretValue(JSON.stringify({ kind: 'api_key', fields })),
    hint,
    verification,
    confirmAccountReplacement: req.confirmAccountReplacement === true,
    idempotencyKey: text(req.idempotencyKey, 200) ?? `api_key:${crypto.randomUUID()}`,
    correlationId: req.correlationId ?? null,
  });
  if (verification) await applyConnectionRecovery(deps.lifecycle ?? null, deps.store, mutation.connection);
  safeLog('api_key_stored', { tenant_id: req.tenantId, connection_id: mutation.connection.id, status: mutation.connection.status, correlation_id: req.correlationId ?? null });
  return { replayed: mutation.replayed, connection: summarize(mutation.connection) };
}

/* ── the credential-access path ─────────────────────────── */

interface OAuthBundle {
  kind: 'oauth_tokens';
  access_token: string;
  refresh_token: string | null;
  token_type: 'Bearer';
  expires_at: string | null;
}

function parseBundle(secret: SecretValue): OAuthBundle | { kind: 'api_key'; fields: Record<string, string> } {
  try {
    const parsed = JSON.parse(String(secret.reveal()));
    if (parsed?.kind === 'oauth_tokens' && typeof parsed.access_token === 'string') return parsed;
    if (parsed?.kind === 'api_key' && parsed.fields && typeof parsed.fields === 'object') return parsed;
  } catch { /* falls through */ }
  throw new ConnectionError('credential_unavailable', 'the stored credential is not in a shape this build reads');
}

export interface CredentialUse {
  /** the access token or key fields, as secrets, valid for this one call. */
  token: SecretValue | null;
  fields: SecretValue<Record<string, string>> | null;
  credentialVersion: number;
  version: ConnectorVersion;
  transport: ProviderTransport;
}

/**
 * Run `fn` with a connection's credential for one named operation. There is no other way
 * to hold a credential: it is resolved for this call (after a refresh if it is about to
 * expire), passed in as a `SecretValue`, and not returned. `fn` gets a transport already
 * fenced to the provider's registered hosts. ARC-120's execution authorisation must have
 * allowed the effect BEFORE this is called — the gateway (gateway.ts) enforces that order.
 */
export async function withProviderCredential<T>(
  deps: ConnectionServiceDeps,
  target: { tenantId: string; connectionId: string; capability: string; operation?: CredentialOperation; correlationId?: string | null },
  fn: (use: CredentialUse) => Promise<T>,
): Promise<T> {
  const row = await requireConnection(deps, target.tenantId, target.connectionId);
  const { version } = versionOf(deps, row);
  if (row.authMethod === 'oauth2' && row.refreshable && expiresSoon(row, version, now(deps))) {
    await refreshAccessToken(deps, { tenantId: target.tenantId, connectionId: row.id });
  }
  const resolved = await deps.store.credentials.resolveCredential({
    tenantId: target.tenantId,
    connectionId: row.id,
    connectorKey: row.connectorKey,
    operation: target.operation ?? 'provider_operation',
    capability: target.capability,
    correlationId: target.correlationId ?? null,
  });
  const bundle = parseBundle(resolved.secret);
  if (bundle.kind === 'oauth_tokens' && bundle.expires_at && Date.parse(bundle.expires_at) <= now(deps).getTime()) {
    throw new ConnectionError('reauthorization_required', 'the access token has expired and could not be refreshed');
  }
  return await fn({
    token: bundle.kind === 'oauth_tokens' ? new SecretValue(bundle.access_token) : null,
    fields: bundle.kind === 'api_key' ? new SecretValue(bundle.fields) : null,
    credentialVersion: resolved.credentialVersion,
    version,
    transport: guardedTransport(version, deps.transport),
  });
}

function expiresSoon(row: ConnectionRow, version: ConnectorVersion, at: Date): boolean {
  if (!row.accessExpiresAt) return false;
  const skew = connectionSpec(version).freshness.refreshSkewSeconds * 1000;
  return Date.parse(row.accessExpiresAt) - skew <= at.getTime();
}

/* ── refresh ────────────────────────────────────────────── */

export const REFRESH_LEASE_SECONDS = 30;

/**
 * Refresh an OAuth access token, once, for everyone. The lease makes it single-flight: a
 * second caller gets `refresh_in_progress` (temporary) rather than spending the refresh
 * token again. The new credential is stored before the old one is retired; if the provider
 * answer is incomplete or storing fails, the old credential stays active and the lease is
 * released with the reason. `invalid_grant` means a person must reauthorise; a provider
 * outage degrades the connection. Never retried here — the caller's own backoff decides.
 */
export async function refreshAccessToken(
  deps: ConnectionServiceDeps,
  req: { tenantId: string; connectionId: string; force?: boolean; correlationId?: string | null },
): Promise<{ refreshed: boolean; rotated: boolean; connection: ConnectionSummary }> {
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  const { version, adapter } = versionOf(deps, row);
  if (row.authMethod !== 'oauth2' || !row.refreshable) throw new ConnectionError('credential_unavailable', 'this connection has nothing to refresh');
  if (!req.force && !expiresSoon(row, version, now(deps))) return { refreshed: false, rotated: false, connection: summarize(row) };

  let lease;
  try {
    lease = await deps.store.credentials.beginRefresh({
      tenantId: req.tenantId, connectionId: row.id, connectorKey: row.connectorKey,
      expectedCredentialVersion: row.credentialVersion, leaseSeconds: REFRESH_LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof ConnectionError && error.code === 'stale_version') {
      /* someone else refreshed first: their credential is the one to use. */
      return { refreshed: false, rotated: false, connection: summarize(await requireConnection(deps, req.tenantId, row.id)) };
    }
    throw error;
  }
  const release = (result: string) =>
    deps.store.credentials.releaseRefresh({ tenantId: req.tenantId, connectionId: row.id, leaseToken: lease.leaseToken, result }).catch(() => undefined);

  let old: OAuthBundle;
  try {
    const resolved = await deps.store.credentials.resolveCredential({
      tenantId: req.tenantId, connectionId: row.id, connectorKey: row.connectorKey, operation: 'refresh', capability: null, correlationId: req.correlationId ?? null,
    });
    const parsed = parseBundle(resolved.secret);
    if (parsed.kind !== 'oauth_tokens') throw new ConnectionError('credential_unavailable', 'this connection has nothing to refresh');
    old = parsed;
  } catch (error) {
    await release('abandoned');
    throw error;
  }
  if (!old.refresh_token) {
    await release('permanent_failure');
    await markReauthorization(deps, row, 'missing_refresh_token', req.correlationId ?? null);
    throw new ConnectionError('missing_refresh_token', 'there is no refresh token — reauthorisation is required');
  }

  const client = clientFor(deps, version);
  let tokens: TokenSet;
  try {
    tokens = await adapter.refresh(version, { ...client, refreshToken: new SecretValue(old.refresh_token) }, guardedTransport(version, deps.transport));
  } catch (error) {
    const e = error instanceof ConnectionError ? error : new ConnectionError('provider_unavailable', 'the provider did not answer');
    if (e.code === 'provider_revoked') {
      await release('permanent_failure');
      await markReauthorization(deps, row, 'invalid_grant', req.correlationId ?? null);
      throw new ConnectionError('reauthorization_required', 'the provider no longer accepts this grant — a person must reauthorise', e.detail);
    }
    if (e.code === 'provider_unavailable') {
      await release('temporary_failure');
      await deps.store.recordConnectionEvent({
        tenantId: req.tenantId, connectionId: row.id, event: 'provider_degraded', actor: SYSTEM_CONNECTION_ACTOR,
        expectedStatusVersion: null, reasonCode: 'refresh_unavailable', idempotencyKey: `refresh:degraded:${lease.leaseToken}`,
        correlationId: req.correlationId ?? null,
      }).then((m) => applyConnectionLoss(deps.lifecycle ?? null, deps.store, m.connection, 'provider_degraded')).catch(() => undefined);
      throw e;
    }
    await release('incomplete_response');
    throw e;
  }

  const rotated = tokens.refreshToken !== null && tokens.refreshToken.reveal() !== old.refresh_token;
  const bundle = new SecretValue(JSON.stringify({
    kind: 'oauth_tokens',
    access_token: tokens.accessToken.reveal(),
    refresh_token: tokens.refreshToken?.reveal() ?? old.refresh_token,
    token_type: tokens.tokenType,
    expires_at: tokens.expiresAt,
  }));
  try {
    const committed = await deps.store.credentials.commitRefresh({
      tenantId: req.tenantId, connectionId: row.id, connectorKey: row.connectorKey, leaseToken: lease.leaseToken,
      expectedCredentialVersion: lease.credentialVersion, secret: bundle, accessExpiresAt: tokens.expiresAt,
      grantedScopes: tokens.scopes, refreshable: true, rotated,
      idempotencyKey: `refresh:commit:${lease.leaseToken}`, correlationId: req.correlationId ?? null,
    });
    safeLog('credential_refreshed', { tenant_id: req.tenantId, connection_id: row.id, rotated, correlation_id: req.correlationId ?? null });
    /* a refreshed grant that lost scopes no longer serves what it was verified for. */
    const stillServed = tokens.scopes
      ? await adapter.verifyCapabilities(version, { accessToken: tokens.accessToken, grantedScopes: tokens.scopes }, guardedTransport(version, deps.transport))
      : committed.connection.verifiedCapabilities;
    if (committed.connection.verifiedCapabilities.some((c) => !stillServed.includes(c))) {
      const failed = await deps.store.recordConnectionEvent({
        tenantId: req.tenantId, connectionId: row.id, event: 'verification_failed', actor: SYSTEM_CONNECTION_ACTOR,
        expectedStatusVersion: committed.connection.statusVersion, reasonCode: 'scope_mismatch',
        verification: {
          accountId: committed.connection.externalAccountId ?? '', label: committed.connection.externalAccountLabel,
          metadata: {}, grantedScopes: tokens.scopes ?? [], verifiedCapabilities: stillServed,
        },
        idempotencyKey: `refresh:scopes:${lease.leaseToken}`, correlationId: req.correlationId ?? null,
      });
      await applyConnectionLoss(deps.lifecycle ?? null, deps.store, failed.connection, 'scope_mismatch');
      return { refreshed: true, rotated, connection: summarize(failed.connection) };
    }
    return { refreshed: true, rotated, connection: summarize(committed.connection) };
  } catch (error) {
    await release('storage_failed');
    safeLog('refresh_storage_failed', { tenant_id: req.tenantId, connection_id: row.id, rotated, correlation_id: req.correlationId ?? null });
    throw error instanceof ConnectionError ? error : new ConnectionError('secret_storage_failed', 'the refreshed credential could not be stored; the previous one is still in place');
  }
}

async function markReauthorization(deps: ConnectionServiceDeps, row: ConnectionRow, reason: string, correlationId: string | null) {
  const mutation = await deps.store.recordConnectionEvent({
    tenantId: row.tenantId, connectionId: row.id, event: 'reauthorization_required', actor: SYSTEM_CONNECTION_ACTOR,
    expectedStatusVersion: null, reasonCode: reason, idempotencyKey: `reauth:${row.id}:${row.credentialVersion}:${reason}`,
    correlationId,
  });
  await applyConnectionLoss(deps.lifecycle ?? null, deps.store, mutation.connection, reason);
  return mutation;
}

/* ── verification ───────────────────────────────────────── */

export async function verifyConnection(
  deps: ConnectionServiceDeps,
  req: { tenantId: string; connectionId: unknown; actorId: string | null; expectedStatusVersion?: unknown; correlationId?: string | null },
) {
  const actorId = req.actorId ? await requireManager(deps, req.tenantId, req.actorId) : null;
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  if (actorId && req.expectedStatusVersion !== row.statusVersion) {
    throw new ConnectionError('stale_version', `the connection is at version ${row.statusVersion} — reload before verifying`);
  }
  const { version, adapter } = versionOf(deps, row);
  const actor = actorId ? { type: 'manager' as const, id: actorId } : SYSTEM_CONNECTION_ACTOR;
  const key = `verify:${row.id}:${row.statusVersion}`;
  let facts: VerificationFacts;
  try {
    if (row.authMethod === 'oauth2' && row.refreshable && expiresSoon(row, version, now(deps))) {
      await refreshAccessToken(deps, { tenantId: req.tenantId, connectionId: row.id, correlationId: req.correlationId });
    }
    const current = await requireConnection(deps, req.tenantId, row.id);
    const resolved = await deps.store.credentials.resolveCredential({
      tenantId: req.tenantId, connectionId: row.id, connectorKey: row.connectorKey, operation: 'verify', capability: null, correlationId: req.correlationId ?? null,
    });
    const bundle = parseBundle(resolved.secret);
    const transport = guardedTransport(version, deps.transport);
    if (bundle.kind === 'api_key') {
      const result = await adapter.verifyApiKey(version, { fields: new SecretValue(bundle.fields) }, transport);
      facts = { ...result.identity, grantedScopes: [], verifiedCapabilities: result.capabilities };
    } else {
      const client = clientFor(deps, version);
      const oauth = connectionSpec(version).oauth!;
      const token = new SecretValue(bundle.access_token);
      /* an OIDC provider re-proves identity through its userinfo endpoint; the id token was single-use. */
      const identity = await (oauth.oidc && oauth.userinfoEndpoint
        ? adapter.identity(version, { accessToken: token, idToken: null, nonceDigest: null, clientId: client.clientId, now: now(deps) }, transport).catch(async (e) => {
          if (e instanceof ConnectionError && e.code === 'oidc_invalid') {
            return await userinfoIdentity(version, token, transport);
          }
          throw e;
        })
        : adapter.identity(version, { accessToken: token, idToken: null, nonceDigest: null, clientId: client.clientId, now: now(deps) }, transport));
      const capabilities = await adapter.verifyCapabilities(version, { accessToken: token, grantedScopes: current.grantedScopes }, transport);
      facts = { ...identity, grantedScopes: current.grantedScopes, verifiedCapabilities: capabilities };
    }
  } catch (error) {
    const e = error instanceof ConnectionError ? error : new ConnectionError('provider_unavailable', 'the provider could not be reached');
    if (e.code === 'provider_unavailable' && ['verified', 'degraded'].includes(row.status)) {
      const m = await deps.store.recordConnectionEvent({
        tenantId: req.tenantId, connectionId: row.id, event: 'provider_degraded', actor: SYSTEM_CONNECTION_ACTOR,
        expectedStatusVersion: null, reasonCode: 'verification_unavailable', idempotencyKey: `${key}:degraded`, correlationId: req.correlationId ?? null,
      });
      await applyConnectionLoss(deps.lifecycle ?? null, deps.store, m.connection, 'provider_degraded');
    } else if (['provider_revoked', 'invalid_credential', 'account_mismatch', 'reauthorization_required'].includes(e.code)) {
      const current = await requireConnection(deps, req.tenantId, row.id);
      if (['connected_unverified', 'verified', 'degraded', 'reauthorization_required'].includes(current.status)) {
        await markReauthorization(deps, current, e.code === 'account_mismatch' ? 'account_mismatch' : 'grant_rejected', req.correlationId ?? null);
      }
    }
    throw e;
  }
  const current = await requireConnection(deps, req.tenantId, row.id);
  const needed = current.authMethod === 'oauth2' ? versionCapabilitiesRequested(current, version) : version.capabilities;
  const missing = needed.filter((c) => !facts.verifiedCapabilities.includes(c));
  const mutation = await deps.store.recordConnectionEvent({
    tenantId: req.tenantId,
    connectionId: row.id,
    event: missing.length === 0 ? 'verification_succeeded' : 'verification_failed',
    actor,
    expectedStatusVersion: current.statusVersion,
    reasonCode: missing.length === 0 ? 'verified' : 'capability_mismatch',
    verification: facts,
    idempotencyKey: key,
    correlationId: req.correlationId ?? null,
    metadata: missing.length ? { missing_capabilities: missing } : {},
  });
  if (mutation.connection.status === 'verified') {
    await applyConnectionRecovery(deps.lifecycle ?? null, deps.store, mutation.connection);
  } else {
    await applyConnectionLoss(deps.lifecycle ?? null, deps.store, mutation.connection, mutation.connection.healthReason ?? 'verification_failed');
  }
  return { connection: summarize(mutation.connection) };
}

/** What an OAuth connection was granted to serve: the capabilities its scopes can serve. */
function versionCapabilitiesRequested(row: ConnectionRow, version: ConnectorVersion): string[] {
  const oauth = connectionSpec(version).oauth!;
  const granted = new Set(row.grantedScopes);
  return version.capabilities.filter((c) => (oauth.capabilityScopes[c] ?? []).every((s) => granted.has(s)) && (oauth.capabilityScopes[c] ?? []).length > 0);
}

async function userinfoIdentity(version: ConnectorVersion, token: SecretValue, transport: ProviderTransport) {
  const oauth = connectionSpec(version).oauth!;
  const response = await transport({ method: 'GET', url: oauth.userinfoEndpoint!, headers: { Authorization: `Bearer ${token.reveal()}` } });
  if (response.status >= 500 || response.status === 429) throw new ConnectionError('provider_unavailable', 'the provider could not say which account this is');
  if (response.status === 401) throw new ConnectionError('provider_revoked', 'the provider no longer accepts this grant');
  const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
  const accountId = text(body.sub, 255);
  if (response.status !== 200 || !accountId) throw new ConnectionError('account_mismatch', 'the provider would not say which account this is');
  return { accountId, label: text(body.email) ?? text(body.name), metadata: {} };
}

/* ── ending and reauthorising ───────────────────────────── */

export async function endConnection(
  deps: ConnectionServiceDeps,
  req: { tenantId: string; connectionId: unknown; actorId: string | null; expectedStatusVersion: unknown; mode: 'disconnect' | 'revoke'; idempotencyKey?: unknown; correlationId?: string | null },
) {
  const actorId = await requireManager(deps, req.tenantId, req.actorId);
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  if (typeof req.expectedStatusVersion !== 'number') throw new ConnectionError('stale_version', 'ending a connection names the status version you read');

  /* ask the provider to revoke — and never depend on the answer. */
  let providerRevocation: 'revoked' | 'unsupported' | 'ambiguous' | 'not_attempted' = 'not_attempted';
  if (row.authMethod === 'oauth2' && ['connected_unverified', 'verified', 'degraded', 'reauthorization_required'].includes(row.status)) {
    try {
      const { version, adapter } = versionOf(deps, row);
      const resolved = await deps.store.credentials.resolveCredential({
        tenantId: req.tenantId, connectionId: row.id, connectorKey: row.connectorKey, operation: 'revoke', capability: null, correlationId: req.correlationId ?? null,
      });
      const bundle = parseBundle(resolved.secret);
      if (bundle.kind === 'oauth_tokens') {
        providerRevocation = await adapter.revoke(version, {
          ...clientFor(deps, version),
          token: new SecretValue(bundle.refresh_token ?? bundle.access_token),
        }, guardedTransport(version, deps.transport));
      }
    } catch {
      providerRevocation = 'ambiguous';
    }
  } else if (row.authMethod === 'api_key') {
    providerRevocation = 'unsupported';
  }

  const mutation = await deps.store.endConnection({
    tenantId: req.tenantId,
    connectionId: row.id,
    event: req.mode,
    actor: { type: 'manager', id: actorId },
    expectedStatusVersion: req.expectedStatusVersion,
    providerRevocation,
    reasonCode: req.mode === 'revoke' ? 'revoked_by_manager' : 'disconnected_by_manager',
    idempotencyKey: text(req.idempotencyKey, 200) ?? `end:${row.id}:${req.expectedStatusVersion}`,
    correlationId: req.correlationId ?? null,
  });
  await applyConnectionLoss(deps.lifecycle ?? null, deps.store, mutation.connection, req.mode);
  safeLog('connection_ended', { tenant_id: req.tenantId, connection_id: row.id, mode: req.mode, provider_revocation: providerRevocation, correlation_id: req.correlationId ?? null });
  return { replayed: mutation.replayed, provider_revocation: providerRevocation, connection: summarize(mutation.connection) };
}

/** Revoke on the system's own authority (a compromise): local use stops whatever the provider says. */
export async function systemRevoke(deps: ConnectionServiceDeps, req: { tenantId: string; connectionId: string; reasonCode: string; correlationId?: string | null }) {
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  const mutation = await deps.store.endConnection({
    tenantId: req.tenantId, connectionId: row.id, event: 'revoke', actor: SYSTEM_CONNECTION_ACTOR, expectedStatusVersion: null,
    providerRevocation: 'not_attempted', reasonCode: req.reasonCode, idempotencyKey: `system_revoke:${row.id}:${row.statusVersion}`,
    correlationId: req.correlationId ?? null,
  });
  await applyConnectionLoss(deps.lifecycle ?? null, deps.store, mutation.connection, 'revoke');
  return { connection: summarize(mutation.connection) };
}

export async function requestReauthorization(
  deps: ConnectionServiceDeps,
  req: { tenantId: string; connectionId: unknown; actorId: string | null; expectedStatusVersion: unknown; idempotencyKey?: unknown; correlationId?: string | null },
) {
  const actorId = await requireManager(deps, req.tenantId, req.actorId);
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  if (typeof req.expectedStatusVersion !== 'number') throw new ConnectionError('stale_version', 'requesting reauthorisation names the status version you read');
  const mutation = await deps.store.recordConnectionEvent({
    tenantId: req.tenantId, connectionId: row.id, event: 'reauthorization_required', actor: { type: 'manager', id: actorId },
    expectedStatusVersion: req.expectedStatusVersion, reasonCode: 'requested_by_manager',
    idempotencyKey: text(req.idempotencyKey, 200) ?? `reauth:request:${row.id}:${req.expectedStatusVersion}`, correlationId: req.correlationId ?? null,
  });
  await applyConnectionLoss(deps.lifecycle ?? null, deps.store, mutation.connection, 'reauthorization_required');
  return { replayed: mutation.replayed, connection: summarize(mutation.connection) };
}

export async function listConnections(deps: ConnectionServiceDeps, req: { tenantId: string; actorId: string | null }) {
  await requireManager(deps, req.tenantId, req.actorId);
  return { connections: (await deps.store.listConnections(req.tenantId)).map(summarize) };
}

export async function getConnection(deps: ConnectionServiceDeps, req: { tenantId: string; actorId: string | null; connectionId: unknown }) {
  await requireManager(deps, req.tenantId, req.actorId);
  const row = await requireConnection(deps, req.tenantId, req.connectionId);
  const [events, credentials] = await Promise.all([
    deps.store.listConnectionEvents(req.tenantId, row.id, 50),
    deps.store.credentials.listCredentialMetadata(req.tenantId, row.id),
  ]);
  return {
    connection: summarize(row),
    credentials: credentials.map((c) => ({ version: c.version, kind: c.kind, status: c.status, hint: c.hint, created_at: c.createdAt, retired_at: c.retiredAt })),
    events: events.map((e) => ({
      type: e.eventType, from: e.fromStatus, to: e.toStatus, status_version: e.statusVersion, actor_type: e.actorType,
      reason: e.reasonCode, at: e.createdAt, correlation_id: e.correlationId,
    })),
  };
}
