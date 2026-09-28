/**
 * ARC-130 — the OAuth 2.0 primitives ARC generates and checks itself.
 *
 *   state      32 random bytes, base64url. Only its SHA-256 digest is stored; the value
 *              exists in the authorisation URL and in the callback, nowhere else.
 *   PKCE       RFC 7636 S256: a 32-byte verifier, stored in Vault for the life of the
 *              authorisation session and deleted when the session is claimed; the
 *              challenge is its SHA-256, base64url.
 *   nonce      OIDC only: 32 random bytes. Its digest is stored; the id token must carry
 *              the value.
 *   redirect   derived from server configuration (`ARC_OAUTH_REDIRECT_URL`, on the same
 *              origin as `ARC_SITE_URL`) — never from a request.
 *   return to  a bounded internal path under the two workspaces, or refused.
 *
 * Cryptographic randomness and hashing are the platform's (Web Crypto). ARC invents none.
 */

import { ConnectionError } from './model.ts';
import { SecretValue } from './redact.ts';
import type { RuntimeEnvironment } from './runtime-env.ts';

/** How long an authorisation session may wait for its callback. */
export const AUTHORIZATION_TTL_SECONDS = 600;

/** Open (unexpired, unclaimed) authorisation sessions one tenant may hold at once. */
export const MAX_OPEN_SESSIONS_PER_TENANT = 5;

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` of cryptographically secure randomness, base64url, held as a secret. */
export function randomSecret(bytes = 32): SecretValue {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return new SecretValue(base64url(buffer));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The digest ARC stores in place of a state or nonce. */
export async function secretDigest(secret: SecretValue): Promise<string> {
  return await sha256Hex(secret.reveal());
}

/** RFC 7636 §4.2, S256. */
export async function pkceChallenge(verifier: SecretValue): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier.reveal())));
  return base64url(digest);
}

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
export function isValidVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** A state value as it arrives on a callback: the shape `randomSecret` produces, or refused. */
export function parseStateParam(value: unknown): SecretValue {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ConnectionError('invalid_state', 'the authorisation state is missing or malformed — start again');
  }
  return new SecretValue(value);
}

/** An authorisation code as it arrives: present, bounded, printable. Its value is never inspected further. */
export function parseCodeParam(value: unknown): SecretValue {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\s\u0000-\u001f]/.test(value)) {
    throw new ConnectionError('invalid_request', 'the provider returned no authorisation code');
  }
  return new SecretValue(value);
}

const RETURN_PATH = /^\/(portal\/dashboard|ops\/console)(\/[A-Za-z0-9._~-]{1,64}){0,6}\/?$/;

/**
 * An internal path under a workspace, or refused. No scheme, no host, no `//`, no
 * backslash, no query, no fragment, no dot segments — so it can only ever be appended to
 * ARC's own origin.
 */
export function safeReturnPath(value: unknown): string {
  if (value === undefined || value === null || value === '') return '/ops/console';
  if (typeof value !== 'string' || value.length > 200 || !RETURN_PATH.test(value) || /(^|\/)\.\.?(\/|$)/.test(value)) {
    throw new ConnectionError('invalid_return_path', 'the return path must be a page inside the portal or the console');
  }
  return value;
}

/**
 * The redirect URI registered with every provider. Must be https on the site's own origin
 * (http only for localhost, and only outside production-capable environments), with no
 * query or fragment.
 */
export function oauthRedirectUri(config: { siteUrl: string | null | undefined; redirectUrl: string | null | undefined; environment: RuntimeEnvironment }): string {
  const refuse = () => new ConnectionError('invalid_redirect', 'the OAuth redirect URI is not configured correctly on the server');
  if (!config.siteUrl || !config.redirectUrl) throw refuse();
  let site: URL;
  let redirect: URL;
  try {
    site = new URL(config.siteUrl);
    redirect = new URL(config.redirectUrl);
  } catch {
    throw refuse();
  }
  const local = redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1';
  const productionCapable = config.environment === 'production' || config.environment === 'staging';
  if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && local && !productionCapable)) throw refuse();
  if (redirect.origin !== site.origin || redirect.search || redirect.hash || redirect.username || redirect.password) throw refuse();
  return redirect.toString();
}
