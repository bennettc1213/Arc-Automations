/* ARC-130 — one test world: a MemoryStore over the synthetic catalog, a synthetic
 * provider behind the only transport ARC-130 code may use, and every log line captured. */
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { syntheticCatalog } from '../supabase/functions/_shared/connections/synthetic.ts';
import { SecretValue, setConnectionLogSink } from '../supabase/functions/_shared/connections/redact.ts';
import { beginOAuthAuthorization, completeOAuthCallback } from '../supabase/functions/_shared/connections/service.ts';
import { SyntheticProvider } from './synthetic-provider.js';
import { FIXTURE_OPERATOR, leadRecoveryConfig, seedPublishedConfig } from './config-fixtures.js';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const OPERATOR = FIXTURE_OPERATOR;
export const OWNER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const STAFF_A = 'aaaaaaaa-0000-4000-8000-00000000000b';
export const OWNER_B = 'bbbbbbbb-0000-4000-8000-00000000000a';
export const SITE = 'https://arc.example.test';
export const REDIRECT = `${SITE}/portal/dashboard/connections/callback`;

export async function world({ store = new MemoryStore(), provider = null } = {}) {
  const p = provider ?? await new SyntheticProvider().init();
  store.connectorCatalog = syntheticCatalog('test');
  if (!store.operators.includes(OPERATOR)) store.operators.push(OPERATOR);
  store.tenantMembers.push(
    { tenantId: TENANT_A, userId: OWNER_A, role: 'owner' },
    { tenantId: TENANT_A, userId: STAFF_A, role: 'staff' },
    { tenantId: TENANT_B, userId: OWNER_B, role: 'owner' },
  );
  const logs = [];
  setConnectionLogSink((line) => logs.push(line));
  let clock = new Date();
  const deps = {
    store,
    transport: p.transport,
    environment: 'test',
    lifecycle: store,
    now: () => clock,
    oauth: {
      siteUrl: SITE,
      redirectUrl: REDIRECT,
      clientCredentials: (oauth) => (oauth.clientIdEnv === 'SYNTHETIC_OAUTH_CLIENT_ID'
        ? { clientId: p.clientId, clientSecret: new SecretValue(p.clientSecret) }
        : null),
    },
  };
  return {
    store, provider: p, deps, logs,
    setNow(date) { clock = date; store.connectionTables.clock = () => date; },
    advance(ms) { clock = new Date(clock.getTime() + ms); store.connectionTables.clock = () => clock; },
  };
}

/** Begin, consent and call back, as the owner of tenant A would. */
export async function connectOAuth(w, { tenantId = TENANT_A, actorId = OWNER_A, account = 'acct-1', capabilities, grantScopes = null, purpose, connectionId, expected, confirm } = {}) {
  const began = await beginOAuthAuthorization(w.deps, {
    tenantId, actorId, connectorKey: 'synthetic_oauth', capabilities, returnPath: '/portal/dashboard/settings',
    purpose, targetConnectionId: connectionId, expectedStatusVersion: expected,
  });
  const redirect = w.provider.consent(began.authorization_url, { account, grantScopes });
  const done = await completeOAuthCallback(w.deps, { actorId, state: redirect.state, code: redirect.code, confirmAccountReplacement: confirm });
  return { began, redirect, done };
}

/** A tenant with Lead Recovery published and ACTIVE (ARC-120), onboarding complete. */
export function liveLeadRecovery(store, tenantId = TENANT_A) {
  seedPublishedConfig(store, { tenantId, config: leadRecoveryConfig(), enabled: true });
  return store;
}

/** Every text surface a secret must never reach, as one string. */
export function everythingButTheVault(store, extra = []) {
  return JSON.stringify({
    connections: store.providerConnections,
    events: store.connectionEvents,
    sessions: store.connectionTables.sessions,
    credentialVersions: store.connectionTables.credentialVersions,
    tenantConfigVersions: store.tenantConfigVersions,
    moduleConfigVersions: store.moduleConfigVersions,
    snapshots: store.snapshots,
    runs: store.runs,
    actions: store.actions,
    lifecycles: store.lifecycles,
    lifecycleTransitions: store.lifecycleTransitions,
    lifecycleEvidence: store.lifecycleEvidence,
    extra,
  });
}
