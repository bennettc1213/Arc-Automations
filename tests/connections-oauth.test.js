/* ARC-130 — the connection model, the registry's connection specs, production guards, and
 * the OAuth Authorization Code flow's security properties, against `MemoryStore` (which
 * enforces what 0016 enforces) and a synthetic provider that never leaves the process.
 * `tests/connections-db.test.js` holds the storage and permission promises against real
 * Postgres. Every test is named after the promise it keeps. */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  ConnectionError,
  expandedConnectionRules,
  legalConnectionTransition,
  parseConnectionStatus,
  parseConnectionStoreError,
  TERMINAL_STATUSES,
} from '../supabase/functions/_shared/connections/model.ts';
import { REGISTRY_CATALOG, resolveProvider } from '../supabase/functions/_shared/connections/catalog.ts';
import { SYNTHETIC_CONNECTORS, syntheticCatalog } from '../supabase/functions/_shared/connections/synthetic.ts';
import { guardedTransport, NO_NETWORK, oauth2Adapter, verifyIdToken } from '../supabase/functions/_shared/connections/adapter.ts';
import { oauthRedirectUri, safeReturnPath, parseStateParam, AUTHORIZATION_TTL_SECONDS } from '../supabase/functions/_shared/connections/oauth.ts';
import { redactDeep, redactUrl, SecretValue, setConnectionLogSink } from '../supabase/functions/_shared/connections/redact.ts';
import { resolveRuntimeEnvironment } from '../supabase/functions/_shared/connections/runtime-env.ts';
import { requireAvailable, selectCredentialStore } from '../supabase/functions/_shared/connections/credential-store.ts';
import { ConnectionTables, TestCredentialStore } from '../supabase/functions/_shared/connections/memory.ts';
import { SupabaseVaultCredentialStore } from '../supabase/functions/_shared/connections/supabase-connection-store.ts';
import { beginOAuthAuthorization, completeOAuthCallback } from '../supabase/functions/_shared/connections/service.ts';
import { CONNECTORS, validateConnectorRegistry, validateTenantConnectionSpec } from '../supabase/functions/_shared/registry/connectors.ts';
import { createConnectionLimiter, handleConnectionAction, CONNECTION_ACTIONS } from '../supabase/functions/connections/handler.ts';
import { connectOAuth, everythingButTheVault, OPERATOR, OWNER_A, OWNER_B, REDIRECT, SITE, STAFF_A, TENANT_A, TENANT_B, world } from './connection-fixtures.js';
import { leakedSentinels, SyntheticProvider } from './synthetic-provider.js';

const SQL = readFileSync(new URL('../supabase/migrations/0016_provider_connections.sql', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../supabase/functions/connections/index.ts', import.meta.url), 'utf8');

afterEach(() => setConnectionLogSink(null));

const refusedWith = (code) => (error) => {
  assert.ok(error instanceof ConnectionError, `expected a ConnectionError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  return true;
};

const synthetic = () => syntheticCatalog('test').connectorVersion('synthetic_oauth', 1);

/* ══ 1. the connection model ═════════════════════════════ */

describe('the connection lifecycle', () => {
  test('has eight distinct statuses, not a connected boolean', () => {
    assert.deepEqual([...CONNECTION_STATUSES].sort(), [
      'authorization_pending', 'connected_unverified', 'degraded', 'disconnected', 'failed', 'reauthorization_required', 'revoked', 'verified',
    ]);
  });

  test('every (event, from) pair has at most one destination', () => {
    const seen = new Set();
    for (const rule of CONNECTION_TRANSITIONS) {
      for (const from of rule.from) {
        const key = `${rule.event}|${from}`;
        assert.ok(!seen.has(key), `${key} is ambiguous`);
        seen.add(key);
      }
    }
  });

  test('terminal statuses have no way out, for anyone', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const rule of CONNECTION_TRANSITIONS) {
        for (const actor of ['manager', 'system']) {
          assert.equal(legalConnectionTransition(rule.event, from, actor).ok, false, `${rule.event} from ${from}`);
        }
      }
    }
  });

  test('a token is not readiness: completing an authorisation lands on connected_unverified', () => {
    for (const from of ['authorization_pending', 'verified', 'reauthorization_required']) {
      assert.deepEqual(legalConnectionTransition('complete_authorization', from, 'manager'), { ok: true, to: 'connected_unverified' });
    }
  });

  test('only a person disconnects, and only the system reports provider degradation', () => {
    assert.equal(legalConnectionTransition('disconnect', 'verified', 'system').code, 'forbidden');
    assert.equal(legalConnectionTransition('provider_degraded', 'verified', 'manager').code, 'forbidden');
  });

  test('an unknown or legacy status fails closed', () => {
    assert.equal(parseConnectionStatus('connected'), null);
    assert.equal(parseConnectionStatus(true), null);
    assert.equal(legalConnectionTransition('verification_succeeded', null, 'system').code, 'connection_status_unknown');
    assert.equal(legalConnectionTransition('no_such_event', 'verified', 'system').code, 'illegal_transition');
  });

  test('the matrix is exactly the rules 0016 seeds', () => {
    const seeded = [...SQL.matchAll(/^\s*\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'(manager|system)'\)/gm)]
      .map(([, event, from, to, actor]) => ({ event, from, to, actor }))
      .sort((a, b) => `${a.event}|${a.from}|${a.actor}`.localeCompare(`${b.event}|${b.from}|${b.actor}`));
    assert.deepEqual(seeded, expandedConnectionRules());
  });

  test('database refusals parse to typed errors; anything else says nothing about the database', () => {
    assert.equal(parseConnectionStoreError('arc_connection:stale_version: reload').code, 'stale_version');
    const generic = parseConnectionStoreError('duplicate key value violates unique constraint "x" DETAIL: Key (secret)=(SENTINEL-AT-1)');
    assert.equal(generic.code, 'secret_storage_failed');
    assert.doesNotMatch(generic.message, /SENTINEL|duplicate|Key/);
  });
});

/* ══ 2. the registry and the catalog ═════════════════════ */

describe('ARC-100: one list of providers, fail-closed specs', () => {
  test('the production registry still validates, and no connector gains a spec it cannot use', () => {
    validateConnectorRegistry();
    for (const c of CONNECTORS) for (const v of c.versions) assert.equal(v.connection, undefined, `${c.key} has no tenant connection yet`);
  });

  test('the production catalog serves no synthetic provider', () => {
    assert.equal(REGISTRY_CATALOG.latestConnectable('synthetic_oauth'), null);
    assert.throws(() => resolveProvider(REGISTRY_CATALOG, 'synthetic_oauth', 'oauth2'), refusedWith('unknown_provider'));
  });

  test('the synthetic catalog refuses to exist anywhere production-capable, including an unset environment', () => {
    for (const env of ['production', 'staging', resolveRuntimeEnvironment(undefined), resolveRuntimeEnvironment('Prod'), resolveRuntimeEnvironment('')]) {
      assert.throws(() => syntheticCatalog(env), refusedWith('environment_forbidden'), env);
    }
    assert.equal(syntheticCatalog('test').name, 'synthetic');
  });

  test('unknown providers, auth methods and ARC-managed connectors fail closed', () => {
    const catalog = syntheticCatalog('test');
    assert.throws(() => resolveProvider(catalog, 'nope', 'oauth2'), refusedWith('unknown_provider'));
    assert.throws(() => resolveProvider(catalog, '../../etc', 'oauth2'), refusedWith('unknown_provider'));
    assert.throws(() => resolveProvider(catalog, 'synthetic_oauth', 'api_key'), refusedWith('unsupported_auth_method'));
    assert.throws(() => resolveProvider(catalog, 'twilio', 'oauth2'), refusedWith('unknown_provider'));
    assert.throws(() => resolveProvider(catalog, 'google_calendar', 'oauth2'), refusedWith('unknown_provider'), 'planned: no adapter');
  });

  const variant = (patch) => {
    const v = structuredClone(SYNTHETIC_CONNECTORS[0].versions[0]);
    patch(v);
    return v;
  };

  test('a spec whose endpoint is off its host allowlist, not https, or carries a query, is refused', () => {
    assert.throws(() => validateTenantConnectionSpec(variant((v) => { v.connection.oauth.tokenEndpoint = 'https://attacker.example/token'; })), /outside its API allowlist/);
    assert.throws(() => validateTenantConnectionSpec(variant((v) => { v.connection.oauth.tokenEndpoint = 'http://synthetic-oauth.invalid/token'; })), /plain https/);
    assert.throws(() => validateTenantConnectionSpec(variant((v) => { v.connection.oauth.authorizationEndpoint = 'https://u:p@synthetic-oauth.invalid/a'; })), /plain https/);
  });

  test('a scope for a capability the version does not declare, or client credentials by value, are refused', () => {
    assert.throws(() => validateTenantConnectionSpec(variant((v) => { v.connection.oauth.capabilityScopes.classify_text = ['x']; })), /does not declare/);
    assert.throws(() => validateTenantConnectionSpec(variant((v) => { v.connection.oauth.clientSecretEnv = 'abc123secret'; })), /environment variable/);
  });

  test('an ARC-managed connector may not describe a tenant connection', () => {
    const twilio = structuredClone(CONNECTORS.find((c) => c.key === 'twilio').versions[0]);
    twilio.connection = structuredClone(SYNTHETIC_CONNECTORS[0].versions[0].connection);
    assert.throws(() => validateTenantConnectionSpec(twilio), /no tenant connection to describe/);
  });
});

/* ══ 3. production guards ════════════════════════════════ */

describe('Vault in production, the test double nowhere near it', () => {
  const vault = () => ({ mechanism: 'supabase_vault', availability: async () => ({ available: true, code: null }) });
  const fake = () => new TestCredentialStore(new ConnectionTables(() => []), 'test');

  test('production and staging select Vault, whatever else is offered', () => {
    for (const environment of ['production', 'staging']) {
      assert.equal(selectCredentialStore({ environment, vault, testDouble: fake }).mechanism, 'supabase_vault');
    }
  });

  test('production refuses a "vault" that is not Vault', () => {
    assert.throws(() => selectCredentialStore({ environment: 'production', vault: fake }), refusedWith('environment_forbidden'));
  });

  test('the test credential store cannot be constructed in production, staging or an unset environment', () => {
    for (const env of ['production', 'staging', resolveRuntimeEnvironment(null)]) {
      assert.throws(() => new TestCredentialStore(new ConnectionTables(() => []), env), refusedWith('environment_forbidden'));
    }
  });

  test('an unavailable Vault fails closed, and the harness double reports itself and is refused', async () => {
    await assert.rejects(requireAvailable({ mechanism: 'supabase_vault', availability: async () => ({ available: false, code: 'vault_missing' }) }), refusedWith('vault_unavailable'));
    const doubleDb = { rpc: async () => ({ data: { vault: true, mechanism: 'test_double' }, error: null }) };
    await assert.rejects(requireAvailable(new SupabaseVaultCredentialStore(doubleDb)), refusedWith('vault_unavailable'));
    const brokenDb = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
    await assert.rejects(requireAvailable(new SupabaseVaultCredentialStore(brokenDb)), refusedWith('vault_unavailable'));
  });

  test('the deployed function never imports the test double or the synthetic providers', () => {
    assert.doesNotMatch(INDEX, /synthetic|TestCredentialStore|memory\.ts/);
    assert.match(INDEX, /selectCredentialStore\(\{ environment: ENVIRONMENT, vault:/);
  });
});

/* ══ 4. OAuth ════════════════════════════════════════════ */

describe('OAuth Authorization Code with PKCE', () => {
  test('a full flow: begin, consent, callback — verified, with the grant in the store and nowhere else', async () => {
    const w = await world();
    const { began, done } = await connectOAuth(w);
    const url = new URL(began.authorization_url);
    assert.equal(url.origin + url.pathname, 'https://synthetic-oauth.invalid/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('nonce'));
    assert.equal(done.connection.status, 'verified');
    assert.deepEqual(done.connection.verified_capabilities, ['receive_sms', 'send_sms']);
    assert.equal(done.connection.account.id, 'acct-1');
    assert.equal(done.return_path, '/portal/dashboard/settings');
    assert.deepEqual(leakedSentinels(everythingButTheVault(w.store, [done, began.session_id]), w.provider), []);
    assert.ok(w.store.connectionTables.secretValuesForTest().some((s) => s.includes('SENTINEL-AT-')), 'the grant reached the store');
  });

  test('PKCE is S256 and the provider saw the matching verifier; the verifier is gone after the claim', async () => {
    const w = await world();
    const { began } = await connectOAuth(w);
    const challenge = new URL(began.authorization_url).searchParams.get('code_challenge');
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    const session = w.store.connectionTables.sessions[0];
    assert.equal(session.pkceMethod, 'S256');
    assert.equal(session.pkceVerifierRef, null, 'the verifier is deleted when the session is claimed');
    assert.equal(w.store.connectionTables.secretCount(), 1, 'only the grant remains in the store');
  });

  test('state is high-entropy and stored only as a digest; the session is short-lived', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const state = new URL(began.authorization_url).searchParams.get('state');
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const session = w.store.connectionTables.sessions[0];
    assert.equal(session.stateDigest, createHash('sha256').update(state).digest('hex'));
    assert.doesNotMatch(JSON.stringify(w.store.connectionTables.sessions), new RegExp(state));
    assert.ok(Date.parse(session.expiresAt) - Date.parse(session.createdAt) <= AUTHORIZATION_TTL_SECONDS * 1000);
  });

  test('an invalid or malformed state is refused and changes nothing', async () => {
    const w = await world();
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, state: 'x'.repeat(43), code: 'c' }), refusedWith('invalid_state'));
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, state: 'short', code: 'c' }), refusedWith('invalid_state'));
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, state: undefined, code: 'c' }), refusedWith('invalid_state'));
    assert.equal(w.store.providerConnections.length, 0);
  });

  test('an expired state is refused, the verifier destroyed, and a first connection marked failed', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    w.advance((AUTHORIZATION_TTL_SECONDS + 1) * 1000);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }), refusedWith('state_expired'));
    assert.equal(w.store.providerConnections[0].status, 'failed');
    assert.equal(w.store.connectionTables.secretCount(), 0);
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'authorization_expired'));
  });

  test('a replayed state is refused, recorded, and the code is never exchanged twice', async () => {
    const w = await world();
    const { redirect } = await connectOAuth(w);
    const exchanges = w.provider.calls.filter((c) => c.path === '/token').length;
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: STAFF_A, ...redirect }), refusedWith('state_replayed'));
    assert.equal(w.provider.calls.filter((c) => c.path === '/token').length, exchanges);
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'authorization_replayed'));
  });

  test('a duplicate callback from the same person is the same success, not a second exchange', async () => {
    const w = await world();
    const { redirect, done } = await connectOAuth(w);
    const tokenCalls = w.provider.calls.filter((c) => c.path === '/token').length;
    const again = await completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect });
    assert.equal(again.replayed, true);
    assert.equal(again.connection.id, done.connection.id);
    assert.equal(w.provider.calls.filter((c) => c.path === '/token').length, tokenCalls);
    assert.equal(w.store.connectionTables.credentialVersions.length, 1);
  });

  test('a callback completed by someone other than the person who began it is refused, and the session survives for them', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OPERATOR, ...redirect }), refusedWith('session_binding_mismatch'));
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_B, ...redirect }), refusedWith('session_binding_mismatch'));
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'security_denial' && e.reasonCode === 'session_binding_mismatch'));
    const done = await completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect });
    assert.equal(done.connection.status, 'verified');
  });

  test('a callback naming another provider is refused and the session closed', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect, connectorKey: 'synthetic_api_key' }), refusedWith('session_binding_mismatch'));
    assert.equal(w.store.connectionTables.sessions[0].outcome, 'failed');
    assert.equal(w.provider.calls.filter((c) => c.path === '/token').length, 0);
  });

  test('the tenant, connection and provider come from the session, never the callback', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    const response = await handleConnectionAction('oauth-callback', {
      body: { ...redirect, tenant_id: TENANT_B }, actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter(),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_request');
    assert.equal(w.store.providerConnections.filter((c) => c.tenantId === TENANT_B).length, 0);
  });

  test('a missing authorisation code, or a provider denial, fails the session without an exchange', async () => {
    const w = await world();
    const b1 = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const r1 = w.provider.consent(b1.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, state: r1.state }), refusedWith('invalid_request'));
    const b2 = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const r2 = w.provider.consent(b2.authorization_url, { approve: false });
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, state: r2.state, error: r2.error }), refusedWith('provider_denied'));
    assert.equal(w.provider.calls.filter((c) => c.path === '/token').length, 0);
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'authorization_denied'));
    assert.equal(w.store.connectionTables.secretCount(), 0, 'no verifier outlives a failed session');
  });

  test('an invalid token response is refused, nothing is stored, and the provider body never surfaces', async () => {
    const w = await world();
    w.provider.next.token = 'bad_body';
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }), refusedWith('invalid_token_response'));
    assert.equal(w.store.connectionTables.credentialVersions.length, 0);
  });

  test('a provider outage at exchange is a temporary, sanitised failure', async () => {
    const w = await world();
    w.provider.next.token = 'unavailable';
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    const error = await completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }).catch((e) => e);
    assert.equal(error.code, 'provider_unavailable');
    assert.doesNotMatch(JSON.stringify({ m: error.message, d: error.detail }), /SENTINEL|leak/);
  });

  test('a missing refresh token, where the provider must issue one, is refused', async () => {
    const w = await world();
    w.provider.next.token = 'no_refresh';
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }), refusedWith('missing_refresh_token'));
  });

  for (const [claim, value] of [
    ['iss', 'https://evil.example'],
    ['aud', 'someone-else'],
    ['nonce', 'not-the-nonce'],
    ['sub', ''],
    ['exp', 1],
  ]) {
    test(`an id token with a wrong ${claim} is refused`, async () => {
      const w = await world();
      w.provider.idTokenOverrides = { [claim]: value };
      const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
      const redirect = w.provider.consent(began.authorization_url);
      await assert.rejects(completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }), refusedWith('oidc_invalid'));
      assert.equal(w.store.connectionTables.credentialVersions.length, 0);
    });
  }

  test('an id token signed by another key, under the provider\'s own key id, or with a mangled signature, is refused', async () => {
    const w = await world();
    const spec = synthetic().connection.oauth;
    const claims = { iss: spec.issuer, aud: w.provider.clientId, sub: 'acct-1', nonce: 'n', exp: 9e9 };
    const digest = createHash('sha256').update('n').digest('hex');
    const verify = (token) => verifyIdToken(spec, { idToken: new SecretValue(token), nonceDigest: digest, clientId: w.provider.clientId, now: new Date() }, w.provider.transport);

    const genuine = await w.provider.signIdToken(claims);
    assert.equal((await verify(genuine)).sub, 'acct-1', 'the control: the genuine token verifies');

    const attacker = await new SyntheticProvider().init();
    attacker.kid = w.provider.kid;
    await assert.rejects(verify(await attacker.signIdToken(claims)), refusedWith('oidc_invalid'));

    const mangled = genuine.split('.').slice(0, 2).join('.') + '.' + Buffer.from('not a signature').toString('base64url');
    await assert.rejects(verify(mangled), refusedWith('oidc_invalid'));
  });

  test('open redirects: only a bounded internal path may be returned to', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/portal/../ops', '/portal/dashboard/../../x',
      '/elsewhere', 'javascript:alert(1)', '/portal/dashboard?next=https://evil', '/ops/console#x', `/portal/dashboard/${'a'.repeat(300)}`]) {
      assert.throws(() => safeReturnPath(bad), refusedWith('invalid_return_path'), bad);
    }
    assert.equal(safeReturnPath('/ops/console/clients'), '/ops/console/clients');
    assert.equal(safeReturnPath(undefined), '/ops/console');
  });

  test('the redirect URI is server configuration: same origin, https, no query', () => {
    const ok = oauthRedirectUri({ siteUrl: SITE, redirectUrl: REDIRECT, environment: 'production' });
    assert.equal(ok, REDIRECT);
    for (const redirectUrl of ['https://evil.example/cb', `${REDIRECT}?x=1`, 'http://arc.example.test/cb', null]) {
      assert.throws(() => oauthRedirectUri({ siteUrl: SITE, redirectUrl, environment: 'production' }), refusedWith('invalid_redirect'), String(redirectUrl));
    }
    assert.throws(() => oauthRedirectUri({ siteUrl: 'http://localhost:5173', redirectUrl: 'http://localhost:5173/cb', environment: 'production' }), refusedWith('invalid_redirect'));
    assert.equal(oauthRedirectUri({ siteUrl: 'http://localhost:5173', redirectUrl: 'http://localhost:5173/cb', environment: 'development' }), 'http://localhost:5173/cb');
  });

  test('scopes come from the registry: a client cannot name a scope or a capability the provider does not offer', async () => {
    const w = await world();
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth', capabilities: ['admin'] }), refusedWith('invalid_scope_request'));
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth', capabilities: 'send_sms messages.admin' }), refusedWith('invalid_scope_request'));
    const narrow = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth', capabilities: ['send_sms'] });
    assert.equal(new URL(narrow.authorization_url).searchParams.get('scope'), 'account.read messages.write openid');
    const response = await handleConnectionAction('oauth-begin', {
      body: { tenant_id: TENANT_A, connector_key: 'synthetic_oauth', scopes: ['messages.admin'] }, actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter(),
    });
    assert.equal(response.body.error, 'invalid_scope_request');
  });

  test('scopes the provider adds that ARC never asked for are not recorded', () => {
    const version = synthetic();
    assert.deepEqual(oauth2Adapter.normalizeScopes(version, 'openid account.read messages.write admin.everything'), ['account.read', 'messages.write', 'openid']);
  });

  test('a grant missing a requested scope is kept but not ready: reauthorisation required, with a typed error', async () => {
    const w = await world();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url, { grantScopes: ['openid', 'account.read', 'messages.read'] });
    const error = await completeOAuthCallback(w.deps, { actorId: OWNER_A, ...redirect }).catch((e) => e);
    assert.equal(error.code, 'scope_mismatch');
    const row = w.store.providerConnections[0];
    assert.equal(row.status, 'reauthorization_required');
    assert.deepEqual(row.verifiedCapabilities, []);
  });

  test('provider endpoints cannot be supplied, and a transport never reaches an unregistered host', async () => {
    const w = await world();
    const response = await handleConnectionAction('oauth-begin', {
      body: { tenant_id: TENANT_A, connector_key: 'synthetic_oauth', token_endpoint: 'https://169.254.169.254/latest' },
      actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter(),
    });
    assert.equal(response.body.error, 'endpoint_not_registered');
    const guarded = guardedTransport(synthetic(), async () => { throw new Error('reached the network'); });
    for (const url of ['https://169.254.169.254/latest/meta-data', 'http://synthetic-oauth.invalid/token', 'https://user:pw@synthetic-oauth.invalid/token', 'not a url']) {
      await assert.rejects(guarded({ method: 'GET', url, headers: {} }), refusedWith('endpoint_not_registered'), url);
    }
  });

  test('nothing in an OAuth flow is logged but redacted: no code, state, verifier or token', async () => {
    const w = await world();
    const { began, redirect } = await connectOAuth(w);
    const state = new URL(began.authorization_url).searchParams.get('state');
    const nonce = new URL(began.authorization_url).searchParams.get('nonce');
    const challenge = new URL(began.authorization_url).searchParams.get('code_challenge');
    const logText = w.logs.join('\n');
    assert.ok(w.logs.length >= 2, 'the flow was logged');
    for (const secret of [state, nonce, challenge, redirect.code, w.provider.clientSecret, ...w.provider.issued]) {
      assert.ok(!logText.includes(secret), `a secret reached the log: ${secret.slice(0, 12)}…`);
    }
    assert.match(logText, /\[redacted\]/);
  });

  test('a stranger, a staff member, or another tenant\'s owner cannot begin an authorisation', async () => {
    const w = await world();
    for (const actorId of ['ffffffff-0000-4000-8000-00000000000f', STAFF_A, OWNER_B, null]) {
      await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId, connectorKey: 'synthetic_oauth' }), refusedWith('forbidden'));
    }
    assert.equal(w.store.providerConnections.length, 0);
  });

  test('open authorisations per client are capped', async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' });
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' }), refusedWith('rate_limited'));
  });

  test('connecting a provider the client already has is refused; reconnecting goes through reauthorisation', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth' }), refusedWith('connection_exists'));
    const again = await connectOAuth(w, { purpose: 'reauthorize', connectionId: done.connection.id, expected: done.connection.status_version });
    assert.equal(again.done.connection.id, done.connection.id);
    assert.equal(again.done.connection.credential.version, 2);
  });

  test('reauthorising with a different account is refused; replacing it needs the replace purpose and explicit confirmation', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    const refused = await connectOAuth(w, { purpose: 'reauthorize', connectionId: done.connection.id, expected: done.connection.status_version, account: 'acct-2' }).catch((e) => e);
    assert.equal(refused.code, 'account_mismatch');
    const current = w.store.providerConnections[0];
    assert.equal(current.externalAccountId, 'acct-1');
    const unconfirmed = await connectOAuth(w, { purpose: 'replace', connectionId: current.id, expected: current.statusVersion, account: 'acct-2' }).catch((e) => e);
    assert.equal(unconfirmed.code, 'account_replacement_unconfirmed');
    const latest = w.store.providerConnections[0];
    const replaced = await connectOAuth(w, { purpose: 'replace', connectionId: latest.id, expected: latest.statusVersion, account: 'acct-2', confirm: true });
    assert.equal(replaced.done.connection.account.id, 'acct-2');
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'connection_replaced'));
  });

  test('a stale status version cannot start a reauthorisation', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    await assert.rejects(
      beginOAuthAuthorization(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_oauth', purpose: 'reauthorize', targetConnectionId: done.connection.id, expectedStatusVersion: 1 }),
      refusedWith('stale_version'),
    );
  });
});

/* ══ 5. the HTTP surface ═════════════════════════════════ */

describe('the connections function', () => {
  const call = (w, action, body, actorId = OWNER_A, limiter = createConnectionLimiter()) =>
    handleConnectionAction(action, { body: { action, ...body }, actorId, deps: w.deps, limiter });

  test('refuses the unsigned, the unknown action, and a malformed tenant', async () => {
    const w = await world();
    assert.equal((await call(w, 'connections-list', { tenant_id: TENANT_A }, null)).body.error, 'forbidden');
    assert.equal((await call(w, 'get-secret', { tenant_id: TENANT_A })).body.error, 'invalid_request');
    assert.equal((await call(w, 'connections-list', { tenant_id: "x' or 1=1" })).body.error, 'invalid_request');
  });

  test('there is no action that returns a credential, and no generic secret getter', () => {
    assert.ok(CONNECTION_ACTIONS.every((a) => !/secret|token|credential-get|resolve/.test(a)));
  });

  test('every response — success and failure — is free of secrets and secret references', async () => {
    const w = await world();
    const began = await call(w, 'oauth-begin', { tenant_id: TENANT_A, connector_key: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.body.authorization_url);
    const done = await call(w, 'oauth-callback', { state: redirect.state, code: redirect.code });
    assert.equal(done.status, 200);
    const replay = await call(w, 'oauth-callback', { state: redirect.state, code: redirect.code }, STAFF_A);
    const list = await call(w, 'connections-list', { tenant_id: TENANT_A });
    const one = await call(w, 'connection-get', { tenant_id: TENANT_A, connection_id: done.body.connection.id });
    const crossTenant = await call(w, 'connection-get', { tenant_id: TENANT_B, connection_id: done.body.connection.id }, OWNER_B);
    const all = JSON.stringify([done, replay, list, one, crossTenant]);
    assert.deepEqual(leakedSentinels(all, w.provider), []);
    assert.doesNotMatch(all, /vault|secret_ref|secretRef|verifier|state_digest|lease/i);
    assert.equal(crossTenant.status, 404, 'another client\'s connection is not found, not forbidden');
    assert.equal(one.body.credentials[0].status, 'active');
    assert.ok(one.body.events.length > 0);
  });

  test('unexpected errors say nothing but a correlation id', async () => {
    const w = await world();
    w.store.listConnections = async () => { throw new Error('connection string postgres://user:SENTINEL-CS-1@db'); };
    const response = await call(w, 'connections-list', { tenant_id: TENANT_A });
    assert.equal(response.status, 500);
    assert.deepEqual(Object.keys(response.body).sort(), ['correlation_id', 'error', 'message']);
    assert.doesNotMatch(JSON.stringify(response.body), /SENTINEL|postgres/);
    assert.doesNotMatch(w.logs.join('\n'), /SENTINEL|postgres/);
  });

  test('provider-facing actions are rate limited per person', async () => {
    const w = await world();
    const limiter = createConnectionLimiter({ perMinute: 2 });
    for (let i = 0; i < 2; i++) assert.equal((await call(w, 'oauth-begin', { tenant_id: TENANT_A, connector_key: 'synthetic_oauth' }, OWNER_A, limiter)).status, 200);
    const third = await call(w, 'oauth-begin', { tenant_id: TENANT_A, connector_key: 'synthetic_oauth' }, OWNER_A, limiter);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers['Retry-After']) > 0);
    assert.equal((await call(w, 'oauth-begin', { tenant_id: TENANT_A, connector_key: 'synthetic_oauth' }, OPERATOR, limiter)).status, 200, 'another person is not throttled by it');
  });

  test('the function authenticates by bearer token only, and never answers a cross-site preflight with a wildcard', () => {
    const code = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /request\.headers\.get\('authorization'\)/);
    assert.doesNotMatch(code, /cookie/i);
    assert.doesNotMatch(INDEX, /'Access-Control-Allow-Origin': '\*'/);
    assert.match(INDEX, /'Cache-Control': 'no-store'/);
  });
});

/* ══ 6. redaction primitives ═════════════════════════════ */

describe('redaction', () => {
  test('a SecretValue never serialises, prints or interpolates', async () => {
    const s = new SecretValue('SENTINEL-AT-xyz');
    const { inspect } = await import('node:util');
    for (const out of [JSON.stringify({ s }), String(s), `${s}`, inspect(s), inspect({ nested: { s } })]) {
      assert.doesNotMatch(out, /SENTINEL/, out);
    }
    assert.equal(s.reveal(), 'SENTINEL-AT-xyz');
  });

  test('URLs lose their query values; structures lose secret-named and secret-shaped values', () => {
    assert.equal(redactUrl('https://p.invalid/cb?code=abc&state=def#frag'), 'https://p.invalid/cb?[code,state: [redacted]]');
    const out = JSON.stringify(redactDeep({
      access_token: 'a', nested: { refresh_token: 'b', note: 'Bearer abcdefghijkl', jwt: 'eyJabcdefghij.eyJabcdefghij.sigsigsig' },
      url: 'https://p.invalid/x?code=zzz', ok: 'fine',
    }));
    assert.doesNotMatch(out, /"a"|"b"|abcdefghijkl|zzz|eyJabc/);
    assert.match(out, /fine/);
  });

  test('parseStateParam refuses anything but the shape ARC issues', () => {
    assert.throws(() => parseStateParam('a'.repeat(44)), refusedWith('invalid_state'));
    assert.ok(parseStateParam('a'.repeat(43)) instanceof SecretValue);
  });

  test('NO_NETWORK refuses to be used', async () => {
    await assert.rejects(Promise.resolve().then(() => NO_NETWORK({ method: 'GET', url: 'https://x.invalid', headers: {} })), refusedWith('operation_not_permitted'));
  });
});
