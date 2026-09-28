/* ARC-130 — credentials, refresh, the connection lifecycle, write-only keys, ARC-120
 * readiness and execution authorisation, and the connector gateway's n8n boundary.
 *
 * Against `MemoryStore` + the test credential store (which enforce what 0016 enforces) and
 * a synthetic provider on `.invalid` hosts. The same storage promises run against real
 * Postgres in `tests/connections-db.test.js`. Every test is named after its promise. */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { intakeLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { ConnectionError } from '../supabase/functions/_shared/connections/model.ts';
import { setConnectionLogSink } from '../supabase/functions/_shared/connections/redact.ts';
import {
  endConnection,
  refreshAccessToken,
  requestReauthorization,
  storeApiKey,
  verifyConnection,
  withProviderCredential,
} from '../supabase/functions/_shared/connections/service.ts';
import { TestCredentialStore } from '../supabase/functions/_shared/connections/memory.ts';
import { tenantConnectionEvidence } from '../supabase/functions/_shared/connections/readiness.ts';
import { parseRunnerRequest, performConnectorOperation, RUNNER_REQUEST_FIELDS } from '../supabase/functions/_shared/connections/gateway.ts';
import { authorizeModuleExecution } from '../supabase/functions/_shared/lifecycle/authorize.ts';
import { evaluateConnectionReadiness } from '../supabase/functions/_shared/lifecycle/readiness.ts';
import { resumeModule } from '../supabase/functions/_shared/lifecycle/engine.ts';
import { latestSelectableModuleVersion } from '../supabase/functions/_shared/registry/modules.ts';
import { createConnectionLimiter, handleConnectionAction } from '../supabase/functions/connections/handler.ts';
import { connectOAuth, everythingButTheVault, liveLeadRecovery, OPERATOR, OWNER_A, OWNER_B, STAFF_A, TENANT_A, TENANT_B, world } from './connection-fixtures.js';
import { leakedSentinels, sentinelApiKey } from './synthetic-provider.js';
import { FIXTURE_OPERATOR, republish, seedLifecycle } from './config-fixtures.js';
import { credentialStoreContract } from './credential-store-contract.js';

afterEach(() => setConnectionLogSink(null));

const refusedWith = (code) => (error) => {
  assert.ok(error instanceof ConnectionError, `expected a ConnectionError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  return true;
};
const LR = 'lead_recovery';
const NOW = new Date('2026-09-16T14:00:00.000Z');
let counter = 0;
const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A, source: 'missed_call', externalRef: `CA${String(++counter).padStart(32, '0')}`, phone: '+16145559911',
  customerName: 'Dana Reyes', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call', ...overrides,
});
const runtimeDeps = (store, live = new RecordingSender()) => ({
  store, liveSender: live, canarySender: new RecordingSender(), now: () => NOW,
  classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'none' }) }),
  urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' }, uuid: () => crypto.randomUUID(), worker: 'test',
});
const resolveFor = (w, row, overrides = {}) => w.store.credentials.resolveCredential({
  tenantId: row.tenantId ?? TENANT_A, connectionId: row.id, connectorKey: row.connectorKey ?? row.connector_key, operation: 'provider_operation', capability: 'send_sms', correlationId: null, ...overrides,
});
const connection = (w) => w.store.providerConnections[0];

/** Lead Recovery live, with one run pinned — and then Twilio no longer attested, so the
    tenant's synthetic connection is the only thing that can prove `send_sms`. */
async function leadRecoveryOnConnection() {
  const w = await world({ store: liveLeadRecovery(new MemoryStore()) });
  const live = new RecordingSender();
  await intakeLead(runtimeDeps(w.store, live), missedCall());
  w.store.onboardingSteps = w.store.onboardingSteps.filter((s) => s.stepKey !== 'twilio_connected');
  const { done } = await connectOAuth(w);
  const run = w.store.runs.find((r) => r.runMode === 'live');
  const lead = w.store.leads.find((l) => l.id === run.leadId);
  return { w, run, lead, live, conn: done.connection };
}
const effect = (store, run, lead) => authorizeModuleExecution(store, { kind: 'effect', tenantId: TENANT_A, moduleKey: LR, lead, run, capability: 'send_sms' });

/* ══ 1. credential storage ═══════════════════════════════ */

describe('credential storage', () => {
  test('no raw credential in any ordinary row, event, session, configuration, snapshot, run, action or lifecycle record', async () => {
    const { w } = await leadRecoveryOnConnection();
    w.setNow(new Date(Date.now() + 3500 * 1000));
    await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id });
    const key = w.provider.registerApiKey(sentinelApiKey());
    await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: key } });
    assert.deepEqual(leakedSentinels(everythingButTheVault(w.store), w.provider), []);
    assert.deepEqual(leakedSentinels(w.logs.join('\n'), w.provider), []);
    assert.ok(w.store.connectionTables.secretValuesForTest().some((v) => v.includes(key)), 'the key is in the store');
  });

  test('connection rows and summaries carry no secret reference', async () => {
    const w = await world();
    await connectOAuth(w);
    const row = JSON.stringify(connection(w));
    assert.doesNotMatch(row, /secretRef|vault|reference/i);
    const view = await handleConnectionAction('connection-get', { body: { tenant_id: TENANT_A, connection_id: connection(w).id }, actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter() });
    assert.doesNotMatch(JSON.stringify(view.body), /secretRef|vault|SENTINEL/i);
  });

  test('a credential resolves only for its own tenant, its own provider, a verified capability and a named operation', async () => {
    const w = await world();
    await connectOAuth(w);
    const row = connection(w);
    assert.match((await resolveFor(w, row)).secret.reveal(), /SENTINEL-AT-/);
    await assert.rejects(resolveFor(w, row, { tenantId: TENANT_B }), refusedWith('not_found'));
    await assert.rejects(resolveFor(w, row, { connectorKey: 'synthetic_api_key' }), refusedWith('not_found'));
    await assert.rejects(resolveFor(w, row, { capability: 'classify_text' }), refusedWith('operation_not_permitted'));
    await assert.rejects(resolveFor(w, row, { capability: null }), refusedWith('operation_not_permitted'));
    await assert.rejects(resolveFor(w, row, { operation: 'read' }), refusedWith('operation_not_permitted'));
  });

  test('there is no way to fetch a secret by its reference', () => {
    const methods = Object.getOwnPropertyNames(TestCredentialStore.prototype);
    assert.deepEqual(methods.filter((m) => /get|read|byId|reveal|export|list(?!CredentialMetadata)/i.test(m)), []);
  });

  test('a failed rotation keeps the previous working credential', async () => {
    const w = await world();
    const first = w.provider.registerApiKey(sentinelApiKey());
    const created = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: first } });
    const second = w.provider.registerApiKey(sentinelApiKey());
    w.store.connectionTables.failNextSecretWrite = true;
    await assert.rejects(storeApiKey(w.deps, {
      tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: created.connection.id,
      expectedStatusVersion: created.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: second },
    }), refusedWith('secret_storage_failed'));
    const row = connection(w);
    assert.equal(row.credentialVersion, 1);
    const resolved = await resolveFor(w, row, { capability: 'classify_text' });
    assert.match(resolved.secret.reveal(), new RegExp(first));
  });

  test('a rotation the provider refuses changes nothing', async () => {
    const w = await world();
    const first = w.provider.registerApiKey(sentinelApiKey());
    const created = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: first } });
    await assert.rejects(storeApiKey(w.deps, {
      tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: created.connection.id,
      expectedStatusVersion: created.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: sentinelApiKey() },
    }), refusedWith('invalid_credential'));
    assert.equal(connection(w).credentialVersion, 1);
    assert.equal(connection(w).status, 'verified');
  });

  test('retired credentials cannot be used, and are purged from the store', async () => {
    const w = await world();
    const first = w.provider.registerApiKey(sentinelApiKey());
    const created = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: first } });
    const second = w.provider.registerApiKey(sentinelApiKey());
    await storeApiKey(w.deps, {
      tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: created.connection.id,
      expectedStatusVersion: created.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: second },
    });
    const versions = await w.store.credentials.listCredentialMetadata(TENANT_A, created.connection.id);
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[1, 'purged'], [2, 'active']]);
    assert.ok(!w.store.connectionTables.secretValuesForTest().some((v) => v.includes(first)));
    assert.match((await resolveFor(w, connection(w), { capability: 'classify_text' })).secret.reveal(), new RegExp(second));
  });

  test('a purge failure is recorded and never brings a retired credential back', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    w.store.connectionTables.failSecretDeletes = true;
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'disconnect' });
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'credential_purge_failed'));
    const versions = await w.store.credentials.listCredentialMetadata(TENANT_A, done.connection.id);
    assert.ok(versions.every((v) => v.status !== 'active'));
    await assert.rejects(resolveFor(w, connection(w), { operation: 'verify', capability: null }), refusedWith('credential_unavailable'));
  });
});

/* ══ 2. refresh and concurrency ══════════════════════════ */

describe('refresh', () => {
  test('a token about to expire is refreshed before use; a fresh one is not', async () => {
    const w = await world();
    await connectOAuth(w);
    const refreshCalls = () => w.provider.calls.filter((c) => c.path === '/token').length;
    const before = refreshCalls();
    await withProviderCredential(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, capability: 'send_sms' }, async () => 'ok');
    assert.equal(refreshCalls(), before, 'fresh: no refresh');
    w.setNow(new Date(Date.now() + (3600 - 200) * 1000)); // inside the 300s skew
    const used = await withProviderCredential(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, capability: 'send_sms' }, async (use) => use.credentialVersion);
    assert.equal(refreshCalls(), before + 1);
    assert.equal(used, 2);
  });

  test('concurrent refreshes spend the refresh token once', async () => {
    const w = await world();
    await connectOAuth(w);
    const id = connection(w).id;
    const results = await Promise.allSettled([1, 2, 3].map(() => refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true })));
    const refreshes = w.provider.calls.filter((c) => c.path === '/token').length - 1;
    assert.equal(refreshes, 1, 'the provider saw one refresh');
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.refreshed).length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'refresh_in_progress');
    assert.equal(connection(w).credentialVersion, 2);
  });

  test('a rotated refresh token is kept, so the next refresh works', async () => {
    const w = await world();
    await connectOAuth(w);
    const id = connection(w).id;
    const first = await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true });
    assert.equal(first.rotated, true);
    const second = await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true });
    assert.equal(second.refreshed, true, 'the old refresh token is dead at the provider; the stored one is the rotated one');
    assert.equal(connection(w).lastRefreshResult, 'rotated');
    assert.ok(w.store.connectionEvents.some((e) => e.reasonCode === 'refresh_token_rotated'));
  });

  test('a provider that does not rotate keeps its refresh token in the new version', async () => {
    const w = await world();
    w.provider.rotateRefresh = false;
    await connectOAuth(w);
    const id = connection(w).id;
    assert.equal((await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true })).rotated, false);
    assert.equal((await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true })).refreshed, true);
  });

  test('a temporary provider failure degrades, keeps the credential, and releases the lease', async () => {
    const w = await world();
    await connectOAuth(w);
    const id = connection(w).id;
    w.provider.next.refresh = 'unavailable';
    await assert.rejects(refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true }), refusedWith('provider_unavailable'));
    const row = connection(w);
    assert.equal(row.status, 'degraded');
    assert.equal(row.credentialVersion, 1);
    assert.equal(row.lastRefreshResult, 'temporary_failure');
    assert.equal((await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: id, force: true })).refreshed, true, 'the lease was released');
  });

  test('invalid_grant is permanent: reauthorisation required, and nothing may use the grant', async () => {
    const w = await world();
    await connectOAuth(w);
    w.provider.revokeAtProvider();
    await assert.rejects(refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, force: true }), refusedWith('reauthorization_required'));
    assert.equal(connection(w).status, 'reauthorization_required');
    assert.equal(connection(w).lastRefreshResult, 'permanent_failure');
    await assert.rejects(resolveFor(w, connection(w)), refusedWith('credential_unavailable'));
  });

  test('an incomplete refresh response keeps the old credential', async () => {
    const w = await world();
    await connectOAuth(w);
    w.provider.next.refresh = 'bad_body';
    await assert.rejects(refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, force: true }), refusedWith('invalid_token_response'));
    assert.equal(connection(w).credentialVersion, 1);
    assert.equal(connection(w).lastRefreshResult, 'incomplete_response');
    assert.equal(connection(w).status, 'verified');
  });

  test('a storage failure after the provider answered keeps the old credential and says so', async () => {
    const w = await world();
    w.provider.rotateRefresh = false;
    await connectOAuth(w);
    w.store.connectionTables.failNextSecretWrite = true;
    await assert.rejects(refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, force: true }), refusedWith('secret_storage_failed'));
    assert.equal(connection(w).credentialVersion, 1);
    assert.equal(connection(w).lastRefreshResult, 'storage_failed');
    assert.match((await resolveFor(w, connection(w))).secret.reveal(), /SENTINEL-AT-/);
  });

  test('a refresh that lost a verified capability\'s scope stops serving it', async () => {
    const w = await world();
    await connectOAuth(w);
    w.provider.next.refresh = 'drop_scope';
    const out = await refreshAccessToken(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, force: true });
    assert.equal(out.connection.status, 'reauthorization_required');
    await assert.rejects(resolveFor(w, connection(w)), refusedWith('credential_unavailable'));
  });
});

/* ══ 3. the connection lifecycle ═════════════════════════ */

describe('connection lifecycle through the service', () => {
  test('pending, then verified; a key the provider could not be asked about is stored unverified', async () => {
    const w = await world();
    const { began } = await connectOAuth(w).then(() => ({ began: true }));
    assert.ok(began);
    assert.equal(connection(w).status, 'verified');
    w.provider.next.whoami = 'unavailable';
    const key = w.provider.registerApiKey(sentinelApiKey());
    const stored = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: key } });
    assert.equal(stored.connection.status, 'connected_unverified');
    assert.equal(stored.connection.usable, false);
    const verified = await verifyConnection(w.deps, { tenantId: TENANT_A, connectionId: stored.connection.id, actorId: OWNER_A, expectedStatusVersion: stored.connection.status_version });
    assert.equal(verified.connection.status, 'verified');
  });

  test('a provider outage during verification degrades; recovery verifies again', async () => {
    const w = await world();
    await connectOAuth(w);
    const row = connection(w);
    w.provider.next.userinfo = 'unavailable';
    await assert.rejects(verifyConnection(w.deps, { tenantId: TENANT_A, connectionId: row.id, actorId: null }), refusedWith('provider_unavailable'));
    assert.equal(connection(w).status, 'degraded');
    assert.ok((await resolveFor(w, connection(w))).secret, 'a degraded connection still serves');
    await verifyConnection(w.deps, { tenantId: TENANT_A, connectionId: row.id, actorId: null });
    assert.equal(connection(w).status, 'verified');
  });

  test('a verification that finds a different account fails closed', async () => {
    const w = await world();
    await connectOAuth(w);
    w.provider.next.userinfo = 'other_account';
    await verifyConnection(w.deps, { tenantId: TENANT_A, connectionId: connection(w).id, actorId: null });
    assert.equal(connection(w).status, 'reauthorization_required');
    assert.ok(w.store.connectionEvents.some((e) => e.eventType === 'security_denial' && e.reasonCode === 'account_mismatch'));
  });

  test('reauthorisation on request, then revoked and disconnected are terminal', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    const reauth = await requestReauthorization(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version });
    assert.equal(reauth.connection.status, 'reauthorization_required');
    const revoked = await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OPERATOR, expectedStatusVersion: reauth.connection.status_version, mode: 'revoke' });
    assert.equal(revoked.connection.status, 'revoked');
    assert.equal(revoked.provider_revocation, 'revoked');
    await assert.rejects(endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: revoked.connection.status_version, mode: 'disconnect' }), refusedWith('illegal_transition'));
    await assert.rejects(verifyConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: null }), refusedWith('credential_unavailable'));
  });

  test('disconnection blocks local use at once, even when the provider cannot be told', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    w.provider.next.revoke = 'unavailable';
    const out = await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'disconnect' });
    assert.equal(out.provider_revocation, 'ambiguous');
    assert.equal(out.connection.status, 'disconnected');
    await assert.rejects(resolveFor(w, connection(w)), refusedWith('credential_unavailable'));
    assert.equal(w.store.connectionTables.secretCount(), 0, 'the token is gone from the store even though it may still work at the provider');
  });

  test('a reconnect after disconnection is a new connection; the old one never works again', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'disconnect' });
    const again = await connectOAuth(w);
    assert.notEqual(again.done.connection.id, done.connection.id);
    await assert.rejects(resolveFor(w, { id: done.connection.id, connectorKey: 'synthetic_oauth' }), refusedWith('credential_unavailable'));
  });

  test('a duplicate mutation with the same idempotency key is one change', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    const args = { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'disconnect', idempotencyKey: 'end-1' };
    const first = await endConnection(w.deps, args);
    const second = await endConnection(w.deps, args);
    assert.equal(second.replayed, true);
    assert.equal(second.connection.status_version, first.connection.status_version);
    assert.equal(w.store.connectionEvents.filter((e) => e.eventType === 'disconnect').length, 1);
  });

  test('a stale status version is refused, never overwritten', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    await assert.rejects(endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: 1, mode: 'disconnect' }), refusedWith('stale_version'));
    await assert.rejects(endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: undefined, mode: 'disconnect' }), refusedWith('stale_version'));
    assert.equal(connection(w).status, 'verified');
  });

  test('an unknown stored status fails closed for every use', async () => {
    const w = await world();
    await connectOAuth(w);
    connection(w).status = 'connected';
    await assert.rejects(resolveFor(w, connection(w)), refusedWith('connection_status_unknown'));
    const evidence = await tenantConnectionEvidence(w.store, TENANT_A);
    const version = latestSelectableModuleVersion(LR);
    const readiness = evaluateConnectionReadiness(version, { config: null, completedSteps: [], hasActiveIntakeKey: true, unhealthyCapabilities: [], tenant: evidence });
    assert.equal(readiness.capabilities.find((c) => c.capability === 'send_sms').status, 'invalid');
  });

  test('another tenant\'s owner, a staff member and a stranger cannot manage the connection; an operator can', async () => {
    const w = await world();
    const { done } = await connectOAuth(w);
    for (const actorId of [OWNER_B, STAFF_A, 'ffffffff-0000-4000-8000-00000000000f']) {
      await assert.rejects(endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId, expectedStatusVersion: done.connection.status_version, mode: 'revoke' }), refusedWith('forbidden'));
    }
    await assert.rejects(endConnection(w.deps, { tenantId: TENANT_B, connectionId: done.connection.id, actorId: OWNER_B, expectedStatusVersion: done.connection.status_version, mode: 'revoke' }), refusedWith('not_found'));
    const out = await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OPERATOR, expectedStatusVersion: done.connection.status_version, mode: 'revoke' });
    assert.equal(out.connection.status, 'revoked');
  });
});

/* ══ 4. write-only API keys ══════════════════════════════ */

describe('write-only credentials', () => {
  test('a key is stored, verified, never echoed; reads show only safe metadata', async () => {
    const w = await world();
    const key = w.provider.registerApiKey(sentinelApiKey());
    const response = await handleConnectionAction('api-key-store', {
      body: { tenant_id: TENANT_A, connector_key: 'synthetic_api_key', credential: { api_key: key } }, actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.connection.status, 'verified');
    assert.equal(response.body.connection.credential.hint, key.slice(-4));
    assert.deepEqual(response.body.connection.verified_capabilities, ['classify_text']);
    const list = await handleConnectionAction('connections-list', { body: { tenant_id: TENANT_A }, actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter() });
    for (const body of [response.body, list.body]) assert.ok(!JSON.stringify(body).includes(key));
  });

  test('arbitrary secret schemas, extra fields, endpoints and wrong shapes are refused before anything is stored', async () => {
    const w = await world();
    const good = sentinelApiKey();
    for (const credential of [
      { api_key: good, endpoint: 'https://attacker.example' },
      { api_key: good, api_secret: 'x'.repeat(40) },
      { token: good },
      { api_key: 'not-the-format' },
      { api_key: 12345 },
      'syn_bare_string',
      [good],
      null,
    ]) {
      await assert.rejects(storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential }), refusedWith('invalid_credential'), JSON.stringify(credential));
    }
    const smuggled = await handleConnectionAction('api-key-store', {
      body: { tenant_id: TENANT_A, connector_key: 'synthetic_api_key', credential: { api_key: good }, base_url: 'https://169.254.169.254' },
      actorId: OWNER_A, deps: w.deps, limiter: createConnectionLimiter(),
    });
    assert.equal(smuggled.body.error, 'endpoint_not_registered');
    assert.equal(w.store.providerConnections.length, 0);
    assert.equal(w.provider.calls.length, 0);
  });

  test('rotation needs the versions read and a key the provider accepts; removal blocks use', async () => {
    const w = await world();
    const first = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: w.provider.registerApiKey(sentinelApiKey()) } });
    const second = w.provider.registerApiKey(sentinelApiKey());
    await assert.rejects(storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: first.connection.id, credential: { api_key: second } }), refusedWith('stale_version'));
    await assert.rejects(storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: first.connection.id, expectedStatusVersion: 1, expectedCredentialVersion: 1, credential: { api_key: second } }), refusedWith('stale_version'));
    const rotated = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: first.connection.id, expectedStatusVersion: first.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: second } });
    assert.equal(rotated.connection.credential.version, 2);
    assert.equal(rotated.connection.credential.hint, second.slice(-4));
    const removed = await endConnection(w.deps, { tenantId: TENANT_A, connectionId: first.connection.id, actorId: OWNER_A, expectedStatusVersion: rotated.connection.status_version, mode: 'disconnect' });
    assert.equal(removed.provider_revocation, 'unsupported');
    await assert.rejects(resolveFor(w, connection(w), { capability: 'classify_text' }), refusedWith('credential_unavailable'));
  });

  test('a key for another tenant\'s connection, or by another tenant\'s owner, is refused', async () => {
    const w = await world();
    const first = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: w.provider.registerApiKey(sentinelApiKey()) } });
    const args = { connectorKey: 'synthetic_api_key', connectionId: first.connection.id, expectedStatusVersion: first.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: w.provider.registerApiKey(sentinelApiKey()) } };
    await assert.rejects(storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_B, ...args }), refusedWith('forbidden'));
    await assert.rejects(storeApiKey(w.deps, { tenantId: TENANT_B, actorId: OWNER_B, ...args }), refusedWith('not_found'));
  });

  test('a replacement key for a different account needs explicit confirmation', async () => {
    const w = await world();
    const first = await storeApiKey(w.deps, { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', credential: { api_key: w.provider.registerApiKey(sentinelApiKey()) } });
    const otherAccount = w.provider.registerApiKey(sentinelApiKey(), 'acct-2');
    const base = { tenantId: TENANT_A, actorId: OWNER_A, connectorKey: 'synthetic_api_key', connectionId: first.connection.id, expectedStatusVersion: first.connection.status_version, expectedCredentialVersion: 1, credential: { api_key: otherAccount } };
    await assert.rejects(storeApiKey(w.deps, base), refusedWith('account_replacement_unconfirmed'));
    const replaced = await storeApiKey(w.deps, { ...base, confirmAccountReplacement: true });
    assert.equal(replaced.connection.account.id, 'acct-2');
  });
});

/* ══ 5. ARC-120: readiness and just-in-time authorisation ═ */

describe('ARC-120 reads live connection evidence', () => {
  const readinessOf = async (w, completedSteps = []) => {
    const version = latestSelectableModuleVersion(LR);
    const tenant = await tenantConnectionEvidence(w.store, TENANT_A);
    return evaluateConnectionReadiness(version, { config: null, completedSteps, hasActiveIntakeKey: true, unhealthyCapabilities: [], tenant });
  };
  const status = (r, c) => r.capabilities.find((x) => x.capability === c).status;

  test('a verified connection satisfies the registered requirement it serves', async () => {
    const w = await world();
    assert.equal(status(await readinessOf(w), 'send_sms'), 'missing', 'the control: nothing proves it before');
    await connectOAuth(w);
    const r = await readinessOf(w);
    assert.equal(status(r, 'send_sms'), 'ready');
    assert.equal(status(r, 'receive_sms'), 'ready');
    assert.ok(!r.blockers.some((b) => /send_sms|receive_sms/.test(b.message) && /inbound_sms|messaging|outbound/.test(b.message)));
  });

  test('a connection verified for another capability does not satisfy this one', async () => {
    const w = await world();
    await connectOAuth(w, { capabilities: ['receive_sms'] });
    const r = await readinessOf(w);
    assert.equal(status(r, 'receive_sms'), 'ready');
    assert.equal(status(r, 'send_sms'), 'missing');
  });

  test('missing scopes, reauthorisation, revocation and disconnection are never ready', async () => {
    const w = await world();
    const began = await connectOAuth(w, { grantScopes: ['openid', 'account.read', 'messages.read'] }).catch((e) => e);
    assert.equal(began.code, 'scope_mismatch');
    assert.equal(status(await readinessOf(w), 'send_sms'), 'expired');
    const row = connection(w);
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: row.id, actorId: OWNER_A, expectedStatusVersion: row.statusVersion, mode: 'revoke' });
    assert.equal(status(await readinessOf(w), 'send_sms'), 'missing');
  });

  test('stale verification, an unknown health, and a failing health are not ready', async () => {
    const w = await world();
    await connectOAuth(w);
    w.store.providerConnections[0].lastVerifiedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    const stale = (await readinessOf(w)).capabilities.find((x) => x.capability === 'send_sms');
    assert.notEqual(stale.status, 'ready');
    assert.match(stale.reason, /synthetic_oauth connection's verification is older than 24h/);
    w.store.providerConnections[0].lastVerifiedAt = new Date().toISOString();
    w.store.providerConnections[0].healthStatus = 'mystery';
    assert.equal(status(await readinessOf(w), 'send_sms'), 'invalid');
    w.store.providerConnections[0].healthStatus = 'failing';
    assert.equal(status(await readinessOf(w), 'send_sms'), 'unhealthy');
  });

  test('another tenant\'s connection proves nothing for this one', async () => {
    const w = await world();
    await connectOAuth(w, { tenantId: TENANT_B, actorId: OWNER_B });
    assert.equal(status(await readinessOf(w), 'send_sms'), 'missing');
  });

  test('just-in-time: a pinned run may act through a verified connection, and not once it is revoked', async () => {
    const { w, run, lead, conn } = await leadRecoveryOnConnection();
    const allowed = await effect(w.store, run, lead);
    assert.equal(allowed.allowed, true, allowed.detail);
    const pin = run.configSnapshotId;
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version, mode: 'revoke' });
    const denied = await effect(w.store, run, lead);
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'module_paused', 'the loss paused the module, and the connection check would refuse too');
    assert.equal(w.store.runs.find((r) => r.id === run.id).configSnapshotId, pin, 'the run is never repinned');
  });

  test('reauthorisation required refuses execution through the connection check itself', async () => {
    const { w, run, lead, conn } = await leadRecoveryOnConnection();
    w.deps.lifecycle = null; // isolate the connection check from the pause it would also cause
    await requestReauthorization(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version });
    const denied = await effect(w.store, run, lead);
    assert.equal(denied.code, 'connection_not_ready');
    assert.match(denied.detail, /expired/);
  });

  test('pinned runs and actions hold behavioural configuration and never a token', async () => {
    const { w, run } = await leadRecoveryOnConnection();
    const snapshot = await w.store.getConfigSnapshot(TENANT_A, run.configSnapshotId);
    assert.ok(snapshot.config.twilio, 'the pinned behaviour is there');
    assert.deepEqual(leakedSentinels({ snapshot, runs: w.store.runs, actions: w.store.actions }, w.provider), []);
  });

  test('a lost connection pauses the module that needed it and marks its health; recovery reactivates nothing', async () => {
    const { w, conn } = await leadRecoveryOnConnection();
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version, mode: 'revoke' });
    const paused = await w.store.getLifecycle(TENANT_A, LR);
    assert.equal(paused.state, 'paused');
    assert.ok(paused.pendingRequirements.includes('reactivation'));
    assert.equal(paused.healthStatus, 'failing');
    assert.ok(w.store.lifecycleTransitions.some((t) => t.transition === 'system_pause' && t.reasonCode === 'connection_unusable'));

    await connectOAuth(w); // a new, verified connection
    const after = await w.store.getLifecycle(TENANT_A, LR);
    assert.equal(after.state, 'paused', 'recovery never reactivates');
    assert.equal(after.healthStatus, 'healthy', 'the overlay recovers; the decision stays with an operator');
    assert.ok(!w.store.lifecycleTransitions.some((t) => ['activate', 'resume'].includes(t.transition)));
  });

  test('a lost connection does not pause a module another connector still serves', async () => {
    const w = await world({ store: liveLeadRecovery(new MemoryStore()) }); // Twilio attested: it proves send_sms itself
    const { done } = await connectOAuth(w);
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: done.connection.id, actorId: OWNER_A, expectedStatusVersion: done.connection.status_version, mode: 'revoke' });
    assert.equal((await w.store.getLifecycle(TENANT_A, LR)).state, 'active');
  });

  test('a publication or a restored version does not bring a revoked credential back', async () => {
    const { w, conn } = await leadRecoveryOnConnection();
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version, mode: 'revoke' });
    await republish(w.store, TENANT_A, { company_name: 'Halstead Heating & Air' });
    const evidence = await tenantConnectionEvidence(w.store, TENANT_A);
    assert.equal(evidence.connections[0].status, 'revoked');
    assert.deepEqual(leakedSentinels({ t: w.store.tenantConfigVersions, m: w.store.moduleConfigVersions }, w.provider), []);
  });
});

/* ══ 6. the gateway and the n8n boundary ═════════════════ */

describe('the connector gateway', () => {
  const sent = [];
  const operations = {
    'send_sms:send_sms': async (use) => {
      await use.transport({ method: 'POST', url: 'https://synthetic-oauth.invalid/messages', headers: { Authorization: `Bearer ${use.token.reveal()}` } });
      sent.push(use.credentialVersion);
      return { providerReference: `msg-${sent.length}` };
    },
  };
  const gateway = (w) => ({ connections: w.deps, engine: w.store, operations });
  const request = (run, extra = {}) => ({ tenant_id: TENANT_A, module_key: LR, run_id: run.id, capability: 'send_sms', operation: 'send_sms', idempotency_key: `k-${run.id}`, ...extra });

  test('a runner request names intent, never a credential or an endpoint', () => {
    assert.deepEqual([...RUNNER_REQUEST_FIELDS].sort(), ['capability', 'idempotency_key', 'module_key', 'operation', 'run_id', 'tenant_id']);
    for (const smuggle of ['access_token', 'refresh_token', 'api_key', 'client_secret', 'authorization', 'credentials', 'endpoint', 'callback_url', 'vault_secret_id']) {
      assert.throws(() => parseRunnerRequest({ ...request({ id: 'r' }), [smuggle]: 'x' }), refusedWith('operation_not_permitted'), smuggle);
    }
    assert.throws(() => parseRunnerRequest({ ...request({ id: 'r' }), extra: 1 }), refusedWith('invalid_request'));
  });

  test('a live run acts through the connection; the result holds identifiers only', async () => {
    const { w, run } = await leadRecoveryOnConnection();
    const result = await performConnectorOperation(gateway(w), request(run));
    assert.equal(result.status, 'performed', result.code);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'connection_id', 'provider_reference', 'status']);
    assert.deepEqual(leakedSentinels(result, w.provider), []);
    assert.ok(w.provider.calls.some((c) => c.path === '/messages'));
  });

  test('a refusal by ARC-120 resolves no credential and reaches no provider', async () => {
    const { w, run, conn } = await leadRecoveryOnConnection();
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version, mode: 'revoke' });
    let resolved = 0;
    const original = w.store.credentials.resolveCredential.bind(w.store.credentials);
    w.store.credentials.resolveCredential = (...a) => { resolved += 1; return original(...a); };
    const calls = w.provider.calls.length;
    const result = await performConnectorOperation(gateway(w), request(run));
    assert.equal(result.status, 'refused');
    assert.equal(resolved, 0);
    assert.equal(w.provider.calls.length, calls);
  });

  test('an ARC-120 refusal stops the gateway even when the connection itself is healthy', async () => {
    const { w, run } = await leadRecoveryOnConnection();
    const { pauseModule } = await import('../supabase/functions/_shared/lifecycle/engine.ts');
    const lifecycle = await w.store.getLifecycle(TENANT_A, LR);
    const paused = await pauseModule(w.store, { tenantId: TENANT_A, moduleKey: LR, actor: { type: 'operator', id: FIXTURE_OPERATOR }, expectedStateVersion: lifecycle.stateVersion });
    assert.equal(paused.ok, true);
    assert.equal(connection(w).status, 'verified', 'the connection is fine; only the lifecycle says no');
    let resolved = 0;
    const original = w.store.credentials.resolveCredential.bind(w.store.credentials);
    w.store.credentials.resolveCredential = (...a) => { resolved += 1; return original(...a); };
    const result = await performConnectorOperation(gateway(w), request(run));
    assert.deepEqual([result.status, result.code], ['refused', 'module_paused']);
    assert.equal(resolved, 0);
  });

  test('test and shadow runs never reach a provider through a tenant connection', async () => {
    const w = await world({ store: liveLeadRecovery(new MemoryStore()) });
    await connectOAuth(w);
    seedLifecycle(w.store, { tenantId: TENANT_A, state: 'shadow' });
    await intakeLead(runtimeDeps(w.store), missedCall());
    const shadowRun = w.store.runs.find((r) => r.runMode === 'shadow');
    assert.ok(shadowRun, 'a shadow run exists');
    const calls = w.provider.calls.length;
    const shadow = await performConnectorOperation(gateway(w), request(shadowRun));
    assert.equal(shadow.status, 'refused');
    assert.equal(shadow.code, 'shadow_no_effects');
    assert.equal(w.provider.calls.length, calls);
  });

  test('an operation nobody approved is refused before anything is read', async () => {
    const { w, run } = await leadRecoveryOnConnection();
    const result = await performConnectorOperation(gateway(w), request(run, { operation: 'delete_everything' }));
    assert.deepEqual(result, { status: 'refused', code: 'operation_not_permitted', provider_reference: null, connection_id: null });
  });

  test('resuming a module paused by a lost connection is an operator decision the lifecycle still gates', async () => {
    const { w, conn } = await leadRecoveryOnConnection();
    await endConnection(w.deps, { tenantId: TENANT_A, connectionId: conn.id, actorId: OWNER_A, expectedStatusVersion: conn.status_version, mode: 'revoke' });
    const lifecycle = await w.store.getLifecycle(TENANT_A, LR);
    const attempt = await resumeModule(w.store, { tenantId: TENANT_A, moduleKey: LR, actor: { type: 'operator', id: FIXTURE_OPERATOR }, expectedStateVersion: lifecycle.stateVersion });
    assert.equal(attempt.ok, false, 'no connection proves send_sms: resuming is refused, not forced');
    assert.equal(attempt.code, 'connection_not_ready');
  });
});

/* ══ 7. the credential-store contract, against the test double ═ */

describe('the credential-store contract', () => {
  credentialStoreContract('TestCredentialStore', async () => {
    const w = await world();
    return { deps: w.deps, provider: w.provider, tenantA: TENANT_A, tenantB: TENANT_B, ownerA: OWNER_A, ownerB: OWNER_B };
  });
});
