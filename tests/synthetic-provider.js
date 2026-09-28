/* ARC-130 — a deterministic, in-process OAuth 2.0 / OIDC provider and API-key service.
 *
 * It answers ARC's adapters through a `ProviderTransport` — the only way ARC-130 code
 * reaches a network — on the `.invalid` hosts the synthetic connectors register. Nothing
 * here opens a socket. Every secret it issues carries a recognisable SENTINEL so the
 * suites can prove none escapes into a row, an event, a log, a response or a snapshot.
 *
 * Behaviour switches (`provider.next…`) make it fail the ways real providers do: outage,
 * invalid_grant, a malformed token body, no refresh token, a tampered id token, a revoked
 * grant, rotation on refresh.
 */
import { createHash, randomBytes } from 'node:crypto';

export const SYNTHETIC_OAUTH_HOST = 'synthetic-oauth.invalid';
export const SYNTHETIC_KEYS_HOST = 'synthetic-keys.invalid';
export const SENTINEL = 'SENTINEL';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const rand = (n = 12) => randomBytes(n).toString('hex');

/** a well-formed synthetic API key carrying the sentinel: `syn_` + 32 lowercase characters. */
export function sentinelApiKey() {
  return `syn_sentinel${rand(12)}`;
}

export class SyntheticProvider {
  constructor({ clientId = 'synthetic-client-id' } = {}) {
    this.clientId = clientId;
    this.clientSecret = `${SENTINEL}-CS-${rand()}`;
    this.accounts = {
      'acct-1': { sub: 'acct-1', email: 'owner@halstead.example', workspace: 'Halstead' },
      'acct-2': { sub: 'acct-2', email: 'other@elsewhere.example', workspace: 'Elsewhere' },
    };
    this.codes = new Map();
    this.access = new Map();
    this.refresh = new Map();
    this.apiKeys = new Map();
    this.calls = [];
    this.issued = [];            // every secret this provider ever issued
    this.rotateRefresh = true;
    this.next = {};              // one-shot behaviours: token, refresh, userinfo, jwks, revoke, whoami
    this.idTokenOverrides = null;
  }

  async init() {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    this.privateKey = pair.privateKey;
    this.kid = `kid-${rand(4)}`;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    this.jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: this.kid, alg: 'RS256', use: 'sig' }] };
    return this;
  }

  issue(kind) {
    const value = `${SENTINEL}-${kind}-${rand()}`;
    this.issued.push(value);
    return value;
  }

  registerApiKey(key, account = 'acct-1', capabilities = ['classify_text']) {
    this.apiKeys.set(key, { account, capabilities });
    this.issued.push(key);
    return key;
  }

  async signIdToken(claims) {
    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
    const body = { ...claims, ...(this.idTokenOverrides ?? {}) };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.privateKey, new TextEncoder().encode(input));
    const token = `${input}.${b64url(new Uint8Array(sig))}`;
    this.issued.push(token);
    return token;
  }

  /**
   * The person at the provider: reads ARC's authorisation URL, and approves (or refuses)
   * for `account`. Returns what the provider would put on the redirect.
   */
  consent(authorizationUrl, { account = 'acct-1', approve = true, grantScopes = null } = {}) {
    const url = new URL(authorizationUrl);
    if (url.host !== SYNTHETIC_OAUTH_HOST || url.pathname !== '/authorize') throw new Error('not this provider');
    const p = Object.fromEntries(url.searchParams);
    if (p.client_id !== this.clientId) throw new Error('unknown client');
    if (p.response_type !== 'code') throw new Error('only the code flow');
    if (p.code_challenge_method !== 'S256' || !p.code_challenge) throw new Error('PKCE S256 required');
    this.lastAuthorization = p;
    if (!approve) return { state: p.state, error: 'access_denied' };
    const code = this.issue('CODE');
    const scopes = grantScopes ?? p.scope.split(' ');
    this.codes.set(code, { clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, scopes, nonce: p.nonce, account, used: false });
    return { state: p.state, code };
  }

  authOk(req) {
    const header = req.headers.Authorization ?? req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
    return id === this.clientId && secret === this.clientSecret;
  }

  async tokens(account, scopes, nonce) {
    const access = this.issue('AT');
    const refresh = this.issue('RT');
    this.access.set(access, { account, scopes, revoked: false });
    this.refresh.set(refresh, { account, scopes, revoked: false });
    const now = Math.floor(Date.now() / 1000);
    const id_token = await this.signIdToken({
      iss: `https://${SYNTHETIC_OAUTH_HOST}`, aud: this.clientId, sub: this.accounts[account].sub,
      email: this.accounts[account].email, nonce, iat: now, exp: now + 600,
    });
    return { access_token: access, refresh_token: refresh, id_token, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') };
  }

  /** the ProviderTransport. */
  transport = async (req) => {
    const url = new URL(req.url);
    this.calls.push({ method: req.method, host: url.host, path: url.pathname });
    const once = (k) => { const v = this.next[k]; delete this.next[k]; return v; };

    if (url.host === SYNTHETIC_KEYS_HOST && url.pathname === '/whoami') {
      const mode = once('whoami');
      if (mode === 'unavailable') return { status: 503, body: null };
      const key = (req.headers.Authorization ?? '').replace(/^Bearer /, '');
      const found = this.apiKeys.get(key);
      if (!found) return { status: 401, body: { error: 'invalid key', echoed: key } };
      return { status: 200, body: { account_id: found.account, workspace: this.accounts[found.account].workspace, capabilities: found.capabilities } };
    }
    if (url.host !== SYNTHETIC_OAUTH_HOST) return { status: 404, body: null };

    if (url.pathname === '/jwks') return { status: 200, body: this.jwks };

    if (url.pathname === '/token') {
      if (!this.authOk(req)) return { status: 401, body: { error: 'invalid_client' } };
      const f = req.form ?? {};
      if (f.grant_type === 'authorization_code') {
        const mode = once('token');
        if (mode === 'unavailable') return { status: 503, body: { error: 'temporarily_unavailable', error_description: `leak ${f.code}` } };
        const grant = this.codes.get(f.code);
        if (!grant || grant.used) return { status: 400, body: { error: 'invalid_grant', error_description: `code ${f.code} not valid` } };
        grant.used = true;
        if (grant.redirectUri !== f.redirect_uri) return { status: 400, body: { error: 'invalid_grant' } };
        const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
        if (challenge !== grant.challenge) return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } };
        const body = await this.tokens(grant.account, grant.scopes, grant.nonce);
        if (mode === 'bad_body') return { status: 200, body: { ...body, token_type: 'mac' } };
        if (mode === 'no_refresh') { delete body.refresh_token; return { status: 200, body }; }
        return { status: 200, body };
      }
      if (f.grant_type === 'refresh_token') {
        const mode = once('refresh');
        if (mode === 'unavailable') return { status: 503, body: { error: 'server_error' } };
        if (mode === 'bad_body') return { status: 200, body: { token_type: 'Bearer' } };
        const held = this.refresh.get(f.refresh_token);
        if (!held || held.revoked || mode === 'invalid_grant') return { status: 400, body: { error: 'invalid_grant', error_description: `refresh ${f.refresh_token} revoked` } };
        const access = this.issue('AT');
        this.access.set(access, { account: held.account, scopes: held.scopes, revoked: false });
        const body = { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: held.scopes.join(' ') };
        if (this.rotateRefresh) {
          held.revoked = true;
          const rotated = this.issue('RT');
          this.refresh.set(rotated, { ...held, revoked: false });
          body.refresh_token = rotated;
        }
        if (mode === 'drop_scope') body.scope = held.scopes.filter((s) => s !== 'messages.write').join(' ');
        return { status: 200, body };
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } };
    }

    if (url.pathname === '/userinfo') {
      const mode = once('userinfo');
      if (mode === 'unavailable') return { status: 503, body: null };
      const token = (req.headers.Authorization ?? '').replace(/^Bearer /, '');
      const held = this.access.get(token);
      if (!held || held.revoked) return { status: 401, body: { error: 'invalid_token' } };
      const account = mode === 'other_account' ? 'acct-2' : held.account;
      return { status: 200, body: { sub: this.accounts[account].sub, email: this.accounts[account].email, workspace: this.accounts[account].workspace } };
    }

    if (url.pathname === '/revoke') {
      if (!this.authOk(req)) return { status: 401, body: null };
      const mode = once('revoke');
      if (mode === 'unavailable') return { status: 503, body: null };
      const token = req.form?.token;
      for (const map of [this.access, this.refresh]) if (map.has(token)) map.get(token).revoked = true;
      return { status: 200, body: null };
    }
    return { status: 404, body: null };
  };

  /** revoke everything this account holds, as a person would at the provider's own site. */
  revokeAtProvider() {
    for (const map of [this.access, this.refresh]) for (const v of map.values()) v.revoked = true;
  }
}

/** Every string anywhere in `value` that carries a sentinel issued by `provider` (or any sentinel). */
export function leakedSentinels(value, provider = null) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const found = [];
  if (provider) for (const secret of provider.issued) if (text.includes(secret)) found.push(secret.slice(0, 16));
  if (/SENTINEL-(AT|RT|CODE|CS)-|syn_sentinel/.test(text)) found.push('SENTINEL');
  return found;
}
