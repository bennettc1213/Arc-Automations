/* ARC-130 — the database's half of provider connections, against real Postgres.
 *
 *   1. The text of 0016, always: Vault-or-nothing, no browser grants, search_path = '' on
 *      every privileged function, no literal secret, forward-only.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js), over the
 *      harness's contract-compatible Vault double: every API role kept out of Vault and
 *      arc_private, only the narrow wrappers executable and only by the service role, RLS
 *      and column grants as the roles a browser holds, append-only history even for the
 *      table owner, one-time sessions, optimistic locking, idempotency, tenant consistency —
 *      and the full OAuth flow, write-only keys and the credential-store contract through
 *      the PRODUCTION adapter (`supabaseConnectionStore` + `SupabaseVaultCredentialStore`).
 *
 * Real Vault's encryption and Supabase's own grants cannot be exercised here; they are the
 * hosted verification checklist (ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md §15), which is
 * still pending. Without PGlite part 2 is reported as skipped, never as passed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseConnectionStore, SupabaseVaultCredentialStore } from '../supabase/functions/_shared/connections/supabase-connection-store.ts';
import { syntheticCatalog } from '../supabase/functions/_shared/connections/synthetic.ts';
import { expandedConnectionRules, ConnectionError } from '../supabase/functions/_shared/connections/model.ts';
import { SecretValue, setConnectionLogSink } from '../supabase/functions/_shared/connections/redact.ts';
import { requireAvailable } from '../supabase/functions/_shared/connections/credential-store.ts';
import { beginOAuthAuthorization, completeOAuthCallback, endConnection, refreshAccessToken, storeApiKey } from '../supabase/functions/_shared/connections/service.ts';
import { SyntheticProvider, leakedSentinels, sentinelApiKey } from './synthetic-provider.js';
import { credentialStoreContract } from './credential-store-contract.js';

const SQL = readFileSync(new URL('../supabase/migrations/0016_provider_connections.sql', import.meta.url), 'utf8');
const SITE = 'https://arc.example.test';

const refusedWith = (code) => (error) => {
  assert.ok(error instanceof ConnectionError, `expected a ConnectionError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  return true;
};

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0016 as written', () => {
  test('Vault or nothing: no other encryption, and a clear failure where Vault is absent', () => {
    assert.match(SQL, /create extension if not exists supabase_vault with schema vault/);
    assert.match(SQL, /raise exception 'arc_connection:vault_unavailable: Supabase Vault is not available/);
    assert.doesNotMatch(SQL, /pgp_sym_encrypt|pgp_pub_encrypt|encrypt\(|pgsodium\.|crypto_aead/i, 'no home-made encryption path');
  });

  test('no browser role is granted a connection function or a write', () => {
    assert.doesNotMatch(SQL, /grant [^;]*execute[^;]* to [^;]*(anon|authenticated)/i);
    assert.doesNotMatch(SQL, /grant (insert|update|delete|all)[^;]* to [^;]*(anon|authenticated)/i);
    assert.doesNotMatch(SQL, /create policy [a-z_]+ on [a-z_.]+\s+for (insert|update|delete|all)/i);
  });

  test('every function 0016 creates sets search_path to empty, and only the wrappers are SECURITY DEFINER', () => {
    const fns = [...SQL.matchAll(/create or replace function ([a-z_.]+)\(([\s\S]*?)\$fn\$;/g)];
    assert.ok(fns.length > 30);
    for (const [, name, body] of fns) {
      assert.match(body, /set search_path = ''/, `${name} pins its search path`);
      if (/security definer/.test(body)) assert.match(name, /^public\.connection_/, `${name} is the only kind that runs as owner`);
    }
  });

  test('no literal secret is written by the migration', () => {
    assert.doesNotMatch(SQL, /create_secret\('[^']/);
    assert.doesNotMatch(SQL, /SENTINEL|sk_live|Bearer [A-Za-z0-9]/);
  });

  test('the production adapter sends a secret only as its own parameter, never inside a request object', async () => {
    const calls = [];
    const conn = {
      id: 'c1', tenant_id: 't1', connector_key: 'synthetic_api_key', connector_version: 1, auth_method: 'api_key', status: 'verified',
      status_version: 3, display_metadata: {}, granted_scopes: [], verified_capabilities: ['classify_text'], credential_version: 2,
      health_status: 'healthy', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const db = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'connection_claim_authorization') return { data: { refused: null, session_id: 's', tenant_id: 't1', connection_id: 'c1', connector_key: 'synthetic_oauth', connector_version: 1, purpose: 'connect', verifier: 'v'.repeat(43), return_path: '/ops/console' }, error: null };
        if (name === 'connection_begin_authorization') return { data: { session_id: 's', connection_id: 'c1', expires_at: new Date().toISOString() }, error: null };
        return { data: { connection: conn, credential: null }, error: null };
      },
      from: () => { throw new Error('no table reads here'); },
    };
    const store = supabaseConnectionStore(db);
    const secret = new SecretValue('SENTINEL-AT-adapter');
    await store.storeApiKey({ tenantId: 't1', actor: { type: 'manager', id: 'u1' }, connectionId: null, connectorKey: 'synthetic_api_key', connectorVersion: 1, expectedStatusVersion: null, expectedCredentialVersion: null, secret, hint: 'abcd', verification: null, confirmAccountReplacement: false, idempotencyKey: 'k', correlationId: null });
    await store.completeAuthorization({ sessionId: 's', tenantId: 't1', actorId: 'u1', secret, identity: { accountId: 'a', label: null, metadata: {} }, grantedScopes: [], accessExpiresAt: null, refreshable: true, confirmAccountReplacement: false, correlationId: null });
    await store.beginAuthorization({ tenantId: 't1', actor: { type: 'manager', id: 'u1' }, connectorKey: 'synthetic_oauth', connectorVersion: 1, purpose: 'connect', targetConnectionId: null, expectedStatusVersion: null, stateDigest: 'a'.repeat(64), nonceDigest: null, pkceVerifier: new SecretValue('SENTINEL-VERIFIER-' + 'x'.repeat(30)), pkceMethod: 'S256', requestedScopes: [], requestedCapabilities: [], redirectUri: 'https://a/b', returnPath: '/ops/console', ttlSeconds: 600, idempotencyKey: 'b', correlationId: null });
    for (const { name, args } of calls) {
      assert.doesNotMatch(JSON.stringify(args.p_request), /SENTINEL/, `${name}: the request object carries no secret`);
    }
    assert.equal(calls.find((c) => c.name === 'connection_store_api_key').args.p_secret, 'SENTINEL-AT-adapter');
    assert.match(calls.find((c) => c.name === 'connection_begin_authorization').args.p_pkce_verifier, /^SENTINEL-VERIFIER-/);
    const claimed = await store.claimAuthorization({ stateDigest: 'a'.repeat(64), actorId: 'u1' });
    assert.doesNotMatch(JSON.stringify(claimed), /vvvv/, 'the claimed verifier arrives wrapped, and does not serialise');
  });

  test('forward-only: nothing dropped but triggers and policies being replaced', () => {
    const drops = [...SQL.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), drops.join(','));
    assert.doesNotMatch(SQL, /\btruncate\b|alter table public\.connections\b/i);
  });
});

/* ══ 2. applied ═══════════════════════════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const uuid = (prefix) => `${prefix}-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

async function seed(db) {
  const tenant = async (name) => (await db.query(`insert into public.tenants (name, slug, status) values ($1, $2, 'active') returning id`, [name, `t-${uuid('bbbbbbbb')}`])).rows[0].id;
  const user = async () => {
    const id = uuid('cccccccc');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  };
  const tenantA = await tenant('A');
  const tenantB = await tenant('B');
  const ownerA = await user();
  const staffA = await user();
  const ownerB = await user();
  const operator = await user();
  await db.query(`insert into public.tenant_members (user_id, tenant_id, role) values ($1, $2, 'owner'), ($3, $2, 'staff'), ($4, $5, 'owner')`, [ownerA, tenantA, staffA, ownerB, tenantB]);
  await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
  return { tenantA, tenantB, ownerA, staffA, ownerB, operator };
}

async function productionWorld() {
  const db = await freshDatabase();
  const ids = await seed(db);
  const provider = await new SyntheticProvider().init();
  const store = supabaseConnectionStore(restClient(db), { catalog: syntheticCatalog('test'), environment: 'test' });
  const logs = [];
  setConnectionLogSink((l) => logs.push(l));
  const deps = {
    store, transport: provider.transport, environment: 'test', lifecycle: null,
    oauth: {
      siteUrl: SITE, redirectUrl: `${SITE}/portal/dashboard/connections/callback`,
      clientCredentials: (o) => (o.clientIdEnv === 'SYNTHETIC_OAUTH_CLIENT_ID' ? { clientId: provider.clientId, clientSecret: new SecretValue(provider.clientSecret) } : null),
    },
  };
  return { db, ...ids, provider, store, deps, logs };
}

async function connected(w, actorId = w.ownerA, tenantId = w.tenantA) {
  const began = await beginOAuthAuthorization(w.deps, { tenantId, actorId, connectorKey: 'synthetic_oauth' });
  const redirect = w.provider.consent(began.authorization_url);
  const done = await completeOAuthCallback(w.deps, { actorId, ...redirect });
  return { began, redirect, done };
}

/** Every row of every table in public and arc_private, as text: where a secret must never be. */
async function everyOrdinaryRow(db) {
  const { rows: tables } = await db.query(`select table_schema, table_name from information_schema.tables
     where table_schema in ('public', 'arc_private') and table_type = 'BASE TABLE'`);
  const out = [];
  for (const t of tables) {
    const { rows } = await db.query(`select row_to_json(x)::text as r from ${t.table_schema}."${t.table_name}" x`);
    out.push(...rows.map((r) => r.r));
  }
  return out.join('\n');
}

describe('0016 applied', { skip }, () => {
  test('refuses to apply to a database with no Vault', async () => {
    await assert.rejects(freshDatabase({ vault: false }), /0016_provider_connections\.sql did not apply: arc_connection:vault_unavailable/);
  });

  test('refuses a Vault look-alike that nobody declared a test double', async () => {
    await assert.rejects(
      freshDatabase({ before: async (db, file) => { if (file.startsWith('0016')) await db.exec(`reset arc.vault_test_double`); } }),
      /vault_unavailable/,
    );
  });

  test('keeps every API role out of Vault and arc_private, although the double granted them everything', async () => {
    const db = await freshDatabase();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const sql of [
        'select * from vault.secrets',
        'select * from vault.decrypted_secrets',
        `select vault.create_secret('x', 'y', 'z')`,
        'select * from arc_private.credential_versions',
        'select * from arc_private.authorization_sessions',
        `select arc_private.resolve_credential('{}'::jsonb)`,
      ]) {
        const message = await asRole(db, { role }, async (tx) => {
          try { await tx.query(sql); return 'ALLOWED'; } catch (e) { return e.message; }
        });
        assert.match(message, /permission denied/, `${role}: ${sql}`);
      }
    }
  });

  test('only the service role may execute the wrappers, and they are the only definer functions', async () => {
    const db = await freshDatabase();
    const { rows } = await db.query(`
      select p.oid::regprocedure::text as fn, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname like 'connection\\_%') or n.nspname = 'arc_private'`);
    const wrappers = rows.filter((r) => r.fn.startsWith('connection_'));
    assert.equal(wrappers.length, 14);
    for (const r of rows) {
      assert.ok((r.proconfig ?? []).includes('search_path=""'), `${r.fn} has an empty search path`);
      assert.equal(r.anon, false, `anon cannot execute ${r.fn}`);
      assert.equal(r.auth, false, `authenticated cannot execute ${r.fn}`);
      assert.equal(r.svc, r.fn.startsWith('connection_'), `service_role executes ${r.fn} only if it is a wrapper`);
      assert.equal(r.prosecdef, r.fn.startsWith('connection_'), `${r.fn} runs as owner only if it is a wrapper`);
    }
  });

  test('the Data API cannot reach arc_private, and a browser cannot call a wrapper', async () => {
    const db = await freshDatabase();
    const service = restClient(db);
    const hidden = await service.rpc('resolve_credential', { p: {} });
    assert.equal(hidden.error.code, 'PGRST202');
    const browser = restClient(db, { role: 'authenticated', sub: '00000000-0000-4000-8000-000000000001' });
    const attempt = await browser.rpc('connection_resolve_credential', { p_request: {} });
    assert.match(attempt.error.message, /permission denied/);
  });

  test('the transition rules in the database are exactly the typed matrix', async () => {
    const db = await freshDatabase();
    const { rows } = await db.query(`select event, from_status as "from", to_status as "to", actor_type as actor from public.connection_transition_rules`);
    const sorted = rows.sort((a, b) => `${a.event}|${a.from}|${a.actor}`.localeCompare(`${b.event}|${b.from}|${b.actor}`));
    assert.deepEqual(sorted, expandedConnectionRules());
    assert.match(await refused(db, `delete from public.connection_transition_rules`), /fixed by migration/);
  });

  test('production refuses the double; a declared test environment accepts it', async () => {
    const db = await freshDatabase();
    const rest = restClient(db);
    await assert.rejects(requireAvailable(new SupabaseVaultCredentialStore(rest)), refusedWith('vault_unavailable'));
    await assert.rejects(requireAvailable(new SupabaseVaultCredentialStore(rest, { environment: 'staging' })), refusedWith('vault_unavailable'));
    await requireAvailable(new SupabaseVaultCredentialStore(rest, { environment: 'test' }));
  });

  test('0016 leaves the legacy connections table and its rows exactly as they were', async () => {
    let before = null;
    const db = await freshDatabase({
      before: async (d, file) => {
        if (!file.startsWith('0016')) return;
        const t = (await d.query(`insert into public.tenants (name, slug, status) values ('L', 'legacy-t', 'active') returning id`)).rows[0].id;
        await d.query(`insert into public.connections (tenant_id, kind, label, provider, credential_hint, credential_location) values ($1, 'n8n', 'n8n', 'n8n', 'ab12', 'n8n')`, [t]);
        before = (await d.query(`select row_to_json(c)::text as r from public.connections c`)).rows;
      },
    });
    const after = (await db.query(`select row_to_json(c)::text as r from public.connections c`)).rows;
    assert.deepEqual(after, before);
    assert.equal((await db.query(`select count(*)::int as n from public.provider_connections`)).rows[0].n, 0, 'nothing is migrated or invented');
  });

  test('the full OAuth flow through the production adapter: verified, and the grant in Vault alone', async () => {
    const w = await productionWorld();
    const { done, began, redirect } = await connected(w);
    assert.equal(done.connection.status, 'verified');
    const everywhere = await everyOrdinaryRow(w.db);
    assert.deepEqual(leakedSentinels(everywhere, w.provider), [], 'no secret in any public or arc_private row');
    const state = new URL(began.authorization_url).searchParams.get('state');
    assert.ok(!everywhere.includes(state), 'the state is stored as a digest only');
    const vault = (await w.db.query(`select secret from vault.secrets`)).rows.map((r) => r.secret).join('\n');
    assert.match(vault, /SENTINEL-AT-/, 'the grant is in Vault');
    assert.equal((await w.db.query(`select count(*)::int as n from vault.secrets where name like 'arc130:pkce:%'`)).rows[0].n, 0, 'the verifier was deleted at claim');
    assert.deepEqual(leakedSentinels(w.logs.join('\n'), w.provider), []);
    assert.ok(!w.logs.join('\n').includes(redirect.code));
  });

  test('RLS: a member reads their own tenant\'s connection, never another\'s, never the lease; anon reads nothing', async () => {
    const w = await productionWorld();
    await connected(w);
    await connected(w, w.ownerB, w.tenantB);
    const as = (role, sub, sql) => asRole(w.db, { role, sub }, async (tx) => {
      try { return (await tx.query(sql)).rows; } catch (e) { return e.message; }
    });
    const cols = 'id, tenant_id, status, verified_capabilities';
    const staff = await as('authenticated', w.staffA, `select ${cols} from public.provider_connections`);
    assert.deepEqual(staff.map((r) => r.tenant_id), [w.tenantA]);
    assert.match(await as('authenticated', w.staffA, `select refresh_lease_token from public.provider_connections`), /permission denied/);
    assert.match(await as('anon', null, `select ${cols} from public.provider_connections`), /permission denied/);
    assert.deepEqual(await as('authenticated', '00000000-0000-4000-8000-0000000000ff', `select ${cols} from public.provider_connections`), [], 'a signed-in stranger sees nothing');
    const events = await as('authenticated', w.ownerB, `select tenant_id from public.provider_connection_events`);
    assert.ok(events.every((e) => e.tenant_id === w.tenantB));
  });

  test('nobody writes a connection table directly: not a browser, not the service role', async () => {
    const w = await productionWorld();
    const { done } = await connected(w);
    const id = done.connection.id;
    for (const role of ['authenticated', 'service_role']) {
      for (const sql of [
        `update public.provider_connections set status = 'verified', verified_capabilities = '{send_sms}' where id = '${id}'`,
        `insert into public.provider_connection_events (tenant_id, event_type, actor_type, reason_code) values ('${w.tenantA}', 'verification_succeeded', 'system', 'forged')`,
        `delete from public.provider_connections where id = '${id}'`,
      ]) {
        const message = await asRole(w.db, { role, sub: w.ownerA }, async (tx) => {
          try { await tx.query(sql); return 'ALLOWED'; } catch (e) { return e.message; }
        });
        assert.match(message, /permission denied/, `${role}: ${sql.slice(0, 40)}`);
      }
    }
  });

  test('history is append-only and credentials are never deleted, even by the table owner', async () => {
    const w = await productionWorld();
    const { done } = await connected(w);
    await refreshAccessToken(w.deps, { tenantId: w.tenantA, connectionId: done.connection.id, force: true }); // version 1 is now purged
    assert.equal((await w.db.query(`select count(*)::int as n from arc_private.credential_versions where status = 'purged'`)).rows[0].n, 1);
    assert.match(await refused(w.db, `update public.provider_connection_events set reason_code = 'edited'`), /append-only/);
    assert.match(await refused(w.db, `delete from public.provider_connection_events`), /append-only/);
    assert.match(await refused(w.db, `delete from arc_private.credential_versions`), /retire, then purge/);
    assert.match(await refused(w.db, `delete from public.provider_connections`), /never deleted/);
    assert.match(await refused(w.db, `update arc_private.credential_versions set status = 'active' where status = 'purged'`), /cannot go from/);
    assert.match(await refused(w.db, `update public.provider_connections set status = 'failed' where id = '${done.connection.id}'`), /not a legal connection transition|advance its status version/);
  });

  test('tenant consistency: a credential or session cannot point at another tenant\'s connection', async () => {
    const w = await productionWorld();
    const { done } = await connected(w);
    assert.match(await refused(w.db,
      `insert into arc_private.credential_versions (connection_id, tenant_id, version, kind, status, vault_secret_id, retired_at) values ($1, $2, 9, 'api_key', 'retired', gen_random_uuid(), now())`,
      [done.connection.id, w.tenantB]), /foreign key/);
    assert.match(await refused(w.db,
      `insert into public.provider_connection_events (tenant_id, connection_id, event_type, actor_type, reason_code) values ($1, $2, 'revoke', 'system', 'forged')`,
      [w.tenantB, done.connection.id]), /foreign key/);
  });

  test('one live connection per tenant and provider', async () => {
    const w = await productionWorld();
    await connected(w);
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' }), refusedWith('connection_exists'));
    await connected(w, w.ownerB, w.tenantB);
  });

  test('authorisation sessions: single use, bound to the actor, expiring', async () => {
    const w = await productionWorld();
    const began = await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    const redirect = w.provider.consent(began.authorization_url);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: w.operator, ...redirect }), refusedWith('session_binding_mismatch'));
    await w.db.query(`update arc_private.authorization_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'`);
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: w.ownerA, ...redirect }), refusedWith('state_expired'));
    await assert.rejects(completeOAuthCallback(w.deps, { actorId: w.ownerA, ...redirect }), refusedWith('state_replayed'));
    const { rows } = await w.db.query(`select outcome, pkce_verifier_secret_id from arc_private.authorization_sessions`);
    assert.deepEqual(rows, [{ outcome: 'expired', pkce_verifier_secret_id: null }]);
    const kinds = (await w.db.query(`select event_type from public.provider_connection_events order by created_at`)).rows.map((r) => r.event_type);
    for (const k of ['authorization_initiated', 'security_denial', 'authorization_expired', 'authorization_replayed']) assert.ok(kinds.includes(k), k);
    assert.match(await refused(w.db, `update arc_private.authorization_sessions set expires_at = created_at + interval '1 hour'`), /short_lived/);
  });

  test('SQL caps open authorisation sessions per client', async () => {
    const w = await productionWorld();
    for (let i = 0; i < 5; i++) await beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' });
    await assert.rejects(beginOAuthAuthorization(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_oauth' }), refusedWith('rate_limited'));
    await beginOAuthAuthorization(w.deps, { tenantId: w.tenantB, actorId: w.ownerB, connectorKey: 'synthetic_oauth' });
  });

  test('SQL refuses to replace a working key with one the provider has not accepted', async () => {
    const w = await productionWorld();
    const out = await storeApiKey(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', credential: { api_key: w.provider.registerApiKey(sentinelApiKey()) } });
    const { error } = await restClient(w.db).rpc('connection_store_api_key', {
      p_request: {
        tenant_id: w.tenantA, actor_id: w.ownerA, connection_id: out.connection.id, connector_key: 'synthetic_api_key', connector_version: 1,
        expected_status_version: out.connection.status_version, expected_credential_version: 1, verified: false, idempotency_key: 'unverified-rotation',
      },
      p_secret: '{"kind":"api_key","fields":{"api_key":"syn_unverifiedxxxxxxxxxxxxxxxxxxxxxxxx"}}',
    });
    assert.match(error.message, /arc_connection:invalid_credential/);
    assert.equal((await w.db.query(`select credential_version from public.provider_connections`)).rows[0].credential_version, 1);
  });

  test('the service role cannot act for a person who is not a manager, or impersonate one', async () => {
    const w = await productionWorld();
    const rest = restClient(w.db);
    const req = (actor) => ({ tenant_id: w.tenantA, actor_id: actor, connector_key: 'synthetic_oauth', connector_version: 1, auth_method: 'oauth2', purpose: 'connect', state_digest: 'a'.repeat(64), requested_scopes: [], requested_capabilities: [], redirect_uri: 'https://arc.example.test/cb', return_path: '/ops/console', ttl_seconds: 600, idempotency_key: `k-${actor}` });
    for (const actor of [w.staffA, w.ownerB]) {
      const { error } = await rest.rpc('connection_begin_authorization', { p_request: req(actor) });
      assert.match(error.message, /arc_connection:forbidden/);
    }
    const impersonating = restClient(w.db, { sub: w.staffA });
    const { error } = await impersonating.rpc('connection_begin_authorization', { p_request: req(w.ownerA) });
    assert.match(error.message, /actor must be the signed-in caller/);
  });

  test('optimistic locking and idempotency hold in SQL', async () => {
    const w = await productionWorld();
    const { done } = await connected(w);
    await assert.rejects(endConnection(w.deps, { tenantId: w.tenantA, connectionId: done.connection.id, actorId: w.ownerA, expectedStatusVersion: 1, mode: 'disconnect' }), refusedWith('stale_version'));
    const args = { tenantId: w.tenantA, connectionId: done.connection.id, actorId: w.ownerA, expectedStatusVersion: done.connection.status_version, mode: 'disconnect', idempotencyKey: 'once' };
    await endConnection(w.deps, args);
    assert.equal((await endConnection(w.deps, args)).replayed, true);
    assert.equal((await w.db.query(`select count(*)::int as n from public.provider_connection_events where event_type = 'disconnect'`)).rows[0].n, 1);
  });

  test('disconnection retires and purges in Vault, whatever the provider says', async () => {
    const w = await productionWorld();
    const { done } = await connected(w);
    w.provider.next.revoke = 'unavailable';
    const out = await endConnection(w.deps, { tenantId: w.tenantA, connectionId: done.connection.id, actorId: w.ownerA, expectedStatusVersion: done.connection.status_version, mode: 'disconnect' });
    assert.equal(out.provider_revocation, 'ambiguous');
    assert.equal((await w.db.query(`select count(*)::int as n from vault.secrets`)).rows[0].n, 0);
    const { rows } = await w.db.query(`select status, vault_secret_id from arc_private.credential_versions`);
    assert.deepEqual(rows, [{ status: 'purged', vault_secret_id: null }]);
  });

  test('a Vault write failure during refresh keeps the previous credential, atomically', async () => {
    const w = await productionWorld();
    w.provider.rotateRefresh = false;
    const { done } = await connected(w);
    await w.db.exec(`create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
      returns uuid language plpgsql as $$ begin raise exception 'vault is down'; end $$;`);
    await assert.rejects(refreshAccessToken(w.deps, { tenantId: w.tenantA, connectionId: done.connection.id, force: true }), refusedWith('secret_storage_failed'));
    const { rows } = await w.db.query(`select version, status from arc_private.credential_versions`);
    assert.deepEqual(rows, [{ version: 1, status: 'active' }]);
    const conn = (await w.db.query(`select credential_version, last_refresh_result from public.provider_connections`)).rows[0];
    assert.deepEqual(conn, { credential_version: 1, last_refresh_result: 'storage_failed' });
  });

  test('a stored key is write-only through the whole stack', async () => {
    const w = await productionWorld();
    const key = w.provider.registerApiKey(sentinelApiKey());
    const out = await storeApiKey(w.deps, { tenantId: w.tenantA, actorId: w.ownerA, connectorKey: 'synthetic_api_key', credential: { api_key: key } });
    assert.equal(out.connection.status, 'verified');
    assert.equal(out.connection.credential.hint, key.slice(-4));
    assert.ok(!JSON.stringify(out).includes(key));
    assert.ok(!(await everyOrdinaryRow(w.db)).includes(key));
    assert.match((await w.db.query(`select secret from vault.secrets`)).rows[0].secret, new RegExp(key));
  });
});

describe('the credential-store contract over real SQL', { skip }, () => {
  credentialStoreContract('SupabaseVaultCredentialStore', async () => {
    const w = await productionWorld();
    return { deps: w.deps, provider: w.provider, tenantA: w.tenantA, tenantB: w.tenantB, ownerA: w.ownerA, ownerB: w.ownerB };
  }, { skip });
});
