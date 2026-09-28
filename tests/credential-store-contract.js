/* ARC-130 — the credential-store contract (ADR ARC-010 §20a): the behaviour the test
 * double must share with Supabase Vault's adapter. Run against `TestCredentialStore`
 * (tests/connections-credentials.test.js) and against `SupabaseVaultCredentialStore` over
 * real SQL (tests/connections-db.test.js). It does not test cryptography — the double has
 * none — only what every caller relies on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionError } from '../supabase/functions/_shared/connections/model.ts';
import { endConnection, storeApiKey } from '../supabase/functions/_shared/connections/service.ts';
import { beginOAuthAuthorization, completeOAuthCallback } from '../supabase/functions/_shared/connections/service.ts';
import { leakedSentinels, sentinelApiKey } from './synthetic-provider.js';

const refusedWith = (code) => (error) => {
  assert.ok(error instanceof ConnectionError, `expected a ConnectionError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  assert.deepEqual(leakedSentinels(error.message), [], 'no secret in an error');
  assert.doesNotMatch(error.message, /violates|constraint|DETAIL|relation "/, 'no database text in an error');
  return true;
};

/**
 * `make()` returns { deps, provider, tenantA, tenantB, ownerA, ownerB, skip? }.
 */
export function credentialStoreContract(label, make, options = {}) {
  const t = (name, fn) => test(`${label}: ${name}`, { skip: options.skip ?? false }, async () => fn(await make()));
  const key = async (w, account = 'acct-1') => w.provider.registerApiKey(sentinelApiKey(), account);
  const store = (w) => w.deps.store;

  t('reports itself available', async (w) => {
    assert.deepEqual(await store(w).credentials.availability(), { available: true, code: null });
  });

  t('stores, verifies and resolves a key for its own tenant and provider only', async (w) => {
    const k = await key(w);
    const out = await storeApiKey(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', credential: { api_key: k } });
    const ctx = { tenantId: w.tenantA, connectionId: out.connection.id, connectorKey: 'synthetic_api_key', operation: 'provider_operation', capability: 'classify_text', correlationId: null };
    const resolved = await store(w).credentials.resolveCredential(ctx);
    assert.match(resolved.secret.reveal(), new RegExp(k));
    assert.equal(resolved.credentialVersion, 1);
    assert.doesNotMatch(JSON.stringify(resolved), new RegExp(k), 'a resolved credential does not serialise');
    await assert.rejects(store(w).credentials.resolveCredential({ ...ctx, tenantId: w.tenantB }), refusedWith('not_found'));
    await assert.rejects(store(w).credentials.resolveCredential({ ...ctx, connectorKey: 'synthetic_oauth' }), refusedWith('not_found'));
    await assert.rejects(store(w).credentials.resolveCredential({ ...ctx, capability: 'send_sms' }), refusedWith('operation_not_permitted'));
    await assert.rejects(store(w).credentials.resolveCredential({ ...ctx, operation: 'export' }), refusedWith('operation_not_permitted'));
  });

  t('versions: rotation makes a new active version and purges the retired one', async (w) => {
    const first = await storeApiKey(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', credential: { api_key: await key(w) } });
    const next = await key(w);
    const rotated = await storeApiKey(w.deps, {
      tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', connectionId: first.connection.id,
      expectedStatusVersion: first.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: next },
    });
    assert.equal(rotated.connection.credential.version, 2);
    const meta = await store(w).credentials.listCredentialMetadata(w.tenantA, first.connection.id);
    assert.deepEqual(meta.map((m) => [m.version, m.status]), [[1, 'purged'], [2, 'active']]);
    assert.doesNotMatch(JSON.stringify(meta), /syn_sentinel|vault/i);
  });

  t('retirement: an ended connection resolves nothing', async (w) => {
    const out = await storeApiKey(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', credential: { api_key: await key(w) } });
    await endConnection(w.deps, { tenantId: w.tenantA, connectionId: out.connection.id, actorId: w.ownerA, expectedStatusVersion: out.connection.status_version, mode: 'disconnect' });
    await assert.rejects(store(w).credentials.resolveCredential({
      tenantId: w.tenantA, connectionId: out.connection.id, connectorKey: 'synthetic_api_key', operation: 'revoke', capability: null, correlationId: null,
    }), refusedWith('credential_unavailable'));
    const meta = await store(w).credentials.listCredentialMetadata(w.tenantA, out.connection.id);
    assert.ok(meta.every((m) => m.status === 'purged'));
  });

  t('a missing credential is typed, not empty', async (w) => {
    const began = await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    await assert.rejects(store(w).credentials.resolveCredential({
      tenantId: w.tenantA, connectionId: began.connection_id, connectorKey: 'synthetic_oauth', operation: 'verify', capability: null, correlationId: null,
    }), refusedWith('credential_unavailable'));
  });

  t('a refresh lease is single-flight, and a stale lease commits nothing', async (w) => {
    const began = await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    const done = await completeOAuthCallback(w.deps, { actorId: w.ownerA, ...redirect });
    const args = { tenantId: w.tenantA, connectionId: done.connection.id, connectorKey: 'synthetic_oauth', expectedCredentialVersion: 1, leaseSeconds: 30 };
    const lease = await store(w).credentials.beginRefresh(args);
    await assert.rejects(store(w).credentials.beginRefresh(args), refusedWith('refresh_in_progress'));
    await store(w).credentials.releaseRefresh({ tenantId: w.tenantA, connectionId: done.connection.id, leaseToken: lease.leaseToken, result: 'abandoned' });
    const { SecretValue } = await import('../supabase/functions/_shared/connections/redact.ts');
    await assert.rejects(store(w).credentials.commitRefresh({
      tenantId: w.tenantA, connectionId: done.connection.id, connectorKey: 'synthetic_oauth', leaseToken: lease.leaseToken,
      expectedCredentialVersion: 1, secret: new SecretValue('{"kind":"oauth_tokens","access_token":"x"}'), accessExpiresAt: null,
      grantedScopes: null, refreshable: true, rotated: false, idempotencyKey: `stale-${lease.leaseToken}`, correlationId: null,
    }), refusedWith('refresh_in_progress'));
    const again = await store(w).credentials.beginRefresh(args);
    assert.ok(again.leaseToken && again.leaseToken !== lease.leaseToken);
  });

  t('a stale expected credential version cannot start a refresh', async (w) => {
    const began = await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    const done = await completeOAuthCallback(w.deps, { actorId: w.ownerA, ...redirect });
    await assert.rejects(store(w).credentials.beginRefresh({
      tenantId: w.tenantA, connectionId: done.connection.id, connectorKey: 'synthetic_oauth', expectedCredentialVersion: 7, leaseSeconds: 30,
    }), refusedWith('stale_version'));
  });

  t('the OAuth flow ends verified, with the grant held by the store alone', async (w) => {
    const began = await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    const done = await completeOAuthCallback(w.deps, { actorId: w.ownerA, ...redirect });
    assert.equal(done.connection.status, 'verified');
    assert.deepEqual(leakedSentinels(done, w.provider), []);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: w.ownerB, ...redirect }), refusedWith('state_replayed'));
  });
}
