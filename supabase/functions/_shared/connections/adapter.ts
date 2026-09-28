/**
 * ARC-130 — the provider adapter framework.
 *
 * One interface for every provider, and one way out to the network. An adapter turns
 * ARC's intent ("exchange this code", "refresh", "who is this account") into requests
 * against the endpoints **the registry** names, and turns the answers back into typed
 * results or typed errors. It holds no state, decides nothing about lifecycles or
 * authorisation (the connection service and ARC-120 do), and never lets a provider's
 * response body out: errors are classified into `ConnectionErrorCode`s here, and only an
 * allowlisted RFC 6749 error word survives, as detail.
 *
 * The network is reached only through a `ProviderTransport`, and every transport an
 * adapter is given is wrapped by `guardedTransport`, which refuses any URL that is not
 * https on one of the connector's registered API hosts — the SSRF fence — and never
 * follows a redirect. Tests pass the synthetic provider's in-process transport, or
 * `NO_NETWORK`, which fails loudly if anything tries to leave the process.
 */

import type { ConnectorVersion, OAuthSpec, TenantConnectionSpec } from '../registry/connectors.ts';
import { type AuthMethod, ConnectionError, type ConnectionErrorCode } from './model.ts';
import { sha256Hex } from './oauth.ts';
import { SecretValue } from './redact.ts';

/* ── transport ──────────────────────────────────────────── */

export interface ProviderRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** an application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
}

export interface ProviderResponse {
  status: number;
  /** parsed JSON, or null. Never logged, never returned past the adapter. */
  body: unknown;
}

export type ProviderTransport = (request: ProviderRequest) => Promise<ProviderResponse>;

/** For tests and for any path that must not reach a provider: throws if called. */
export const NO_NETWORK: ProviderTransport = () => {
  throw new ConnectionError('operation_not_permitted', 'this context may not contact a provider');
};

export function connectionSpec(version: ConnectorVersion): TenantConnectionSpec {
  if (!version.connection) {
    throw new ConnectionError('unknown_provider', `${version.connectorKey}@${version.version} is not a tenant-connected provider`);
  }
  return version.connection;
}

/** Refuse anything but https on a registered host. The only transport an adapter uses. */
export function guardedTransport(version: ConnectorVersion, transport: ProviderTransport): ProviderTransport {
  const hosts = new Set(connectionSpec(version).apiHosts);
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new ConnectionError('endpoint_not_registered', 'a provider request named an unparseable URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.host)) {
      throw new ConnectionError('endpoint_not_registered', `${url.host || 'that host'} is not a registered endpoint of ${version.connectorKey}`);
    }
    return await transport(request);
  };
}

/** The production transport: a bounded fetch that never follows a redirect. */
export function fetchTransport(timeoutMs = 10_000): ProviderTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = request.form ? new URLSearchParams(request.form).toString() : undefined;
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...request.headers,
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    } catch {
      throw new ConnectionError('provider_unavailable', 'the provider did not answer');
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ── results ────────────────────────────────────────────── */

export interface TokenSet {
  accessToken: SecretValue;
  refreshToken: SecretValue | null;
  idToken: SecretValue | null;
  tokenType: 'Bearer';
  expiresAt: string | null;
  /** scopes the provider says it granted, normalised; null when it did not say. */
  scopes: string[] | null;
}

export interface AccountIdentity {
  /** the provider's stable account identifier (an OIDC `sub`, an account id). */
  accountId: string;
  /** safe to display: an email, a workspace name. */
  label: string | null;
  metadata: Record<string, string>;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: SecretValue;
}

export interface ProviderAdapter {
  readonly key: string;
  readonly authMethods: readonly AuthMethod[];
  authorizationUrl(version: ConnectorVersion, input: {
    clientId: string;
    redirectUri: string;
    state: SecretValue;
    codeChallenge: string | null;
    scopes: readonly string[];
    nonce: SecretValue | null;
  }): SecretValue;
  exchangeCode(version: ConnectorVersion, input: ClientCredentials & {
    code: SecretValue;
    verifier: SecretValue | null;
    redirectUri: string;
  }, transport: ProviderTransport): Promise<TokenSet>;
  refresh(version: ConnectorVersion, input: ClientCredentials & { refreshToken: SecretValue }, transport: ProviderTransport): Promise<TokenSet>;
  revoke(version: ConnectorVersion, input: ClientCredentials & { token: SecretValue }, transport: ProviderTransport): Promise<'revoked' | 'unsupported' | 'ambiguous'>;
  identity(version: ConnectorVersion, input: {
    accessToken: SecretValue;
    idToken: SecretValue | null;
    /** the SHA-256 of the nonce this authorisation sent — ARC never keeps the value. */
    nonceDigest: string | null;
    clientId: string;
    now: Date;
  }, transport: ProviderTransport): Promise<AccountIdentity>;
  normalizeScopes(version: ConnectorVersion, raw: unknown): string[];
  /** the capabilities this grant can actually serve, proven by scope or by a provider call. */
  verifyCapabilities(version: ConnectorVersion, input: { accessToken: SecretValue; grantedScopes: readonly string[] }, transport: ProviderTransport): Promise<string[]>;
  /** write-only credentials: prove the key works and whose it is. */
  verifyApiKey(version: ConnectorVersion, input: { fields: SecretValue<Record<string, string>> }, transport: ProviderTransport): Promise<{ identity: AccountIdentity; capabilities: string[] }>;
}

/* ── error classification ───────────────────────────────── */

/** RFC 6749 §5.2 / RFC 7009 error words — the only provider text ARC keeps, as detail. */
const OAUTH_ERROR_WORDS = new Set([
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error', 'unsupported_token_type',
]);

export function oauthErrorWord(body: unknown): string | null {
  const word = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null;
  return typeof word === 'string' && OAUTH_ERROR_WORDS.has(word) ? word : null;
}

/**
 * Temporary or permanent — the distinction ARC-130 exists to keep. A transient failure
 * degrades a connection; a permanent one requires a person to reauthorise. Never a
 * provider body in the message.
 */
export function classifyTokenFailure(status: number, body: unknown, during: 'exchange' | 'refresh'): ConnectionError {
  const word = oauthErrorWord(body);
  const detail = { provider_status: status, ...(word ? { provider_error: word } : {}) };
  if (status === 429 || status >= 500 || word === 'temporarily_unavailable' || word === 'server_error') {
    return new ConnectionError('provider_unavailable', `the provider is unavailable (${status}) — nothing was changed`, detail);
  }
  if (word === 'invalid_grant' || (during === 'refresh' && status === 401)) {
    return during === 'refresh'
      ? new ConnectionError('provider_revoked', 'the provider no longer accepts this grant — reauthorisation is required', detail)
      : new ConnectionError('token_exchange_failed', 'the authorisation code was not accepted — start again', detail);
  }
  if (word === 'access_denied') return new ConnectionError('provider_denied', 'the provider refused the authorisation', detail);
  return new ConnectionError('token_exchange_failed', `the provider refused the token request (${status})`, detail);
}

/* ── token responses ────────────────────────────────────── */

const TOKEN_MAX = 8192;
const TEN_YEARS_S = 10 * 365 * 24 * 3600;

function readToken(value: unknown, what: string, required: boolean): SecretValue | null {
  if (value === undefined || value === null) {
    if (required) throw new ConnectionError('invalid_token_response', `the provider's token response had no ${what}`);
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > TOKEN_MAX || /\s/.test(value)) {
    throw new ConnectionError('invalid_token_response', `the provider's ${what} is not a usable token`);
  }
  return new SecretValue(value);
}

/** Validate a token endpoint's success body. Throws typed errors naming fields, never values. */
export function parseTokenResponse(version: ConnectorVersion, body: unknown, now: Date, adapter: ProviderAdapter): TokenSet {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConnectionError('invalid_token_response', 'the provider returned no token object');
  }
  const b = body as Record<string, unknown>;
  const tokenType = typeof b.token_type === 'string' ? b.token_type.toLowerCase() : '';
  if (tokenType !== 'bearer') throw new ConnectionError('invalid_token_response', 'the provider issued a token type ARC does not use');
  const accessToken = readToken(b.access_token, 'access token', true)!;
  let expiresAt: string | null = null;
  if (b.expires_in !== undefined) {
    const seconds = Number(b.expires_in);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > TEN_YEARS_S) {
      throw new ConnectionError('invalid_token_response', 'the provider gave an invalid token lifetime');
    }
    expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return {
    accessToken,
    refreshToken: readToken(b.refresh_token, 'refresh token', false),
    idToken: readToken(b.id_token, 'id token', false),
    tokenType: 'Bearer',
    expiresAt,
    scopes: b.scope === undefined ? null : adapter.normalizeScopes(version, b.scope),
  };
}

/* ── OIDC ───────────────────────────────────────────────── */

const b64urlDecode = (part: string): Uint8Array<ArrayBuffer> => {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const decodeJson = (part: string): Record<string, unknown> => {
  const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed as Record<string, unknown>;
};

const CLOCK_SKEW_S = 120;

/**
 * Verify an OIDC id token: RS256 only, signed by a key from the provider's registered
 * JWKS endpoint, for this issuer, for this client, with this nonce, unexpired, with a
 * subject. Every failure is `oidc_invalid` with a sentence naming the claim, never a value.
 */
export async function verifyIdToken(
  oauth: OAuthSpec,
  input: { idToken: SecretValue; nonceDigest: string | null; clientId: string; now: Date },
  transport: ProviderTransport,
): Promise<{ sub: string; claims: Record<string, unknown> }> {
  const fail = (why: string) => new ConnectionError('oidc_invalid', `the id token was refused: ${why}`);
  const parts = input.idToken.reveal().split('.');
  if (parts.length !== 3) throw fail('it is not a signed JWT');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw fail('it cannot be decoded');
  }
  if (header.alg !== 'RS256') throw fail('it is not RS256-signed');
  if (!oauth.jwksEndpoint || !oauth.issuer) throw fail('the provider has no registered issuer and key set');

  const jwks = await transport({ method: 'GET', url: oauth.jwksEndpoint, headers: {} });
  const keys = jwks.status === 200 && jwks.body && typeof jwks.body === 'object'
    ? (jwks.body as { keys?: unknown }).keys
    : null;
  if (!Array.isArray(keys)) throw new ConnectionError('provider_unavailable', 'the provider key set could not be read');
  const jwk = keys.find((k) => k && typeof k === 'object' && (k as Record<string, unknown>).kid === header.kid
    && (k as Record<string, unknown>).kty === 'RSA') as JsonWebKey | undefined;
  if (!jwk) throw fail('it names a key the provider does not publish');

  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), signed);
  if (!ok) throw fail('its signature does not verify');

  const nowS = Math.floor(input.now.getTime() / 1000);
  if (claims.iss !== oauth.issuer) throw fail('the issuer is not the registered issuer');
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(input.clientId)) throw fail('it was not issued to this client');
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== input.clientId) throw fail('the authorised party is not this client');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw fail('it has expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) throw fail('it was issued in the future');
  if (!input.nonceDigest || typeof claims.nonce !== 'string' || await sha256Hex(claims.nonce) !== input.nonceDigest) {
    throw fail('the nonce does not match this authorisation');
  }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw fail('it names no subject');
  return { sub: claims.sub, claims };
}

/* ── the generic OAuth 2.0 adapter ──────────────────────── */

function oauthOf(version: ConnectorVersion): OAuthSpec {
  const oauth = connectionSpec(version).oauth;
  if (!oauth) throw new ConnectionError('unsupported_auth_method', `${version.connectorKey} does not use OAuth`);
  return oauth;
}

function clientAuth(oauth: OAuthSpec, creds: ClientCredentials): { headers: Record<string, string>; form: Record<string, string> } {
  if (oauth.clientAuth === 'client_secret_basic') {
    const basic = btoa(`${encodeURIComponent(creds.clientId)}:${encodeURIComponent(creds.clientSecret.reveal())}`);
    return { headers: { Authorization: `Basic ${basic}` }, form: {} };
  }
  return { headers: {}, form: { client_id: creds.clientId, client_secret: creds.clientSecret.reveal() } };
}

const safeText = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;

/**
 * Authorization Code (RFC 6749 §4.1) with PKCE (RFC 7636) and, where the provider is OIDC,
 * id-token verification. No implicit grant, no password grant: neither is implemented, so
 * neither can be selected.
 */
export const oauth2Adapter: ProviderAdapter = Object.freeze({
  key: 'oauth2_generic',
  authMethods: ['oauth2'] as const,

  authorizationUrl(version: ConnectorVersion, input: Parameters<ProviderAdapter['authorizationUrl']>[1]) {
    const oauth = oauthOf(version);
    const url = new URL(oauth.authorizationEndpoint);
    const params: Record<string, string> = {
      ...(oauth.extraAuthorizationParams ?? {}),
      response_type: 'code',
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: input.scopes.join(oauth.scopeSeparator),
      state: input.state.reveal(),
    };
    if (oauth.pkce === 'S256') {
      if (!input.codeChallenge) throw new ConnectionError('pkce_failed', 'PKCE is required for this provider');
      params.code_challenge = input.codeChallenge;
      params.code_challenge_method = 'S256';
    }
    if (oauth.oidc) {
      if (!input.nonce) throw new ConnectionError('oidc_invalid', 'an OIDC authorisation needs a nonce');
      params.nonce = input.nonce.reveal();
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new SecretValue(url.toString());
  },

  async exchangeCode(version, input, transport) {
    const oauth = oauthOf(version);
    const auth = clientAuth(oauth, input);
    const form: Record<string, string> = {
      ...auth.form,
      grant_type: 'authorization_code',
      code: input.code.reveal(),
      redirect_uri: input.redirectUri,
    };
    if (oauth.pkce === 'S256') {
      if (!input.verifier) throw new ConnectionError('pkce_failed', 'the PKCE verifier for this authorisation is missing');
      form.code_verifier = input.verifier.reveal();
    }
    const response = await transport({ method: 'POST', url: oauth.tokenEndpoint, headers: auth.headers, form });
    if (response.status !== 200) throw classifyTokenFailure(response.status, response.body, 'exchange');
    const tokens = parseTokenResponse(version, response.body, new Date(), oauth2Adapter);
    if (version.auth.expectsRefreshToken && !tokens.refreshToken) {
      throw new ConnectionError('missing_refresh_token', 'the provider issued no refresh token — the connection could not stay authorised');
    }
    return tokens;
  },

  async refresh(version, input, transport) {
    const oauth = oauthOf(version);
    const auth = clientAuth(oauth, input);
    const response = await transport({
      method: 'POST',
      url: oauth.tokenEndpoint,
      headers: auth.headers,
      form: { ...auth.form, grant_type: 'refresh_token', refresh_token: input.refreshToken.reveal() },
    });
    if (response.status !== 200) throw classifyTokenFailure(response.status, response.body, 'refresh');
    return parseTokenResponse(version, response.body, new Date(), oauth2Adapter);
  },

  async revoke(version, input, transport) {
    const oauth = oauthOf(version);
    if (!oauth.revocationEndpoint) return 'unsupported';
    const auth = clientAuth(oauth, input);
    try {
      const response = await transport({
        method: 'POST',
        url: oauth.revocationEndpoint,
        headers: auth.headers,
        form: { ...auth.form, token: input.token.reveal() },
      });
      /* RFC 7009: 200 whether or not the token was valid. anything else is not a no. */
      return response.status === 200 ? 'revoked' : 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  },

  async identity(version, input, transport) {
    const oauth = oauthOf(version);
    if (oauth.oidc) {
      if (!input.idToken) throw new ConnectionError('oidc_invalid', 'the provider returned no id token');
      const { sub, claims } = await verifyIdToken(oauth, { idToken: input.idToken, nonceDigest: input.nonceDigest, clientId: input.clientId, now: input.now }, transport);
      return { accountId: sub, label: safeText(claims.email) ?? safeText(claims.name), metadata: {} };
    }
    if (!oauth.userinfoEndpoint) {
      throw new ConnectionError('account_mismatch', 'this provider cannot say which account was connected');
    }
    const response = await transport({ method: 'GET', url: oauth.userinfoEndpoint, headers: { Authorization: `Bearer ${input.accessToken.reveal()}` } });
    if (response.status >= 500 || response.status === 429) throw new ConnectionError('provider_unavailable', 'the provider could not say which account this is');
    if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
      throw new ConnectionError('account_mismatch', 'the provider would not say which account this is');
    }
    const b = response.body as Record<string, unknown>;
    const accountId = safeText(b.sub ?? b.id ?? b.account_id, 255);
    if (!accountId) throw new ConnectionError('account_mismatch', 'the provider named no account');
    const metadata: Record<string, string> = {};
    for (const field of connectionSpec(version).safeMetadataFields) {
      const v = safeText(b[field]);
      if (v) metadata[field] = v;
    }
    return { accountId, label: safeText(b.email) ?? safeText(b.name), metadata };
  },

  normalizeScopes(version, raw) {
    const oauth = oauthOf(version);
    const list = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];
    const allowed = new Set([...oauth.baseScopes, ...Object.values(oauth.capabilityScopes).flat()]);
    /* scopes ARC never asked for are dropped from the record rather than trusted. */
    return [...new Set(list.filter((s): s is string => typeof s === 'string' && allowed.has(s)))].sort();
  },

  // deno-lint-ignore require-await
  async verifyCapabilities(version, input) {
    const oauth = oauthOf(version);
    const granted = new Set(input.grantedScopes);
    return version.capabilities.filter((capability) => {
      const needed = oauth.capabilityScopes[capability];
      return Array.isArray(needed) && needed.length > 0 && needed.every((s) => granted.has(s));
    });
  },

  // deno-lint-ignore require-await
  async verifyApiKey() {
    throw new ConnectionError('unsupported_auth_method', 'an OAuth provider does not take an API key');
  },
} satisfies ProviderAdapter);

/** Every scope a set of capabilities needs from this connector: base ∪ each capability's. */
export function scopesFor(version: ConnectorVersion, capabilities: readonly string[]): string[] {
  const oauth = oauthOf(version);
  const out = new Set(oauth.baseScopes);
  for (const capability of capabilities) {
    const scopes = oauth.capabilityScopes[capability];
    if (!version.capabilities.includes(capability) || !scopes) {
      throw new ConnectionError('invalid_scope_request', `${version.connectorKey} does not provide ${capability}`);
    }
    for (const s of scopes) out.add(s);
  }
  return [...out].sort();
}

export const ERROR_IS_TEMPORARY = (code: ConnectionErrorCode) => code === 'provider_unavailable';
