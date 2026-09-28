/**
 * ARC-130 — `connections`: tenant provider connections over HTTPS.
 *
 *   POST …/functions/v1/connections   { "action": "<one of CONNECTION_ACTIONS>", … }
 *
 * Signed-in users only (a Supabase JWT in the Authorization header — never a cookie, so a
 * cross-site form cannot act as anyone). The actor is whoever that token verifies as; the
 * service lets an operator (`arc_admins`) or the client's owner manage connections, and
 * 0016 checks the same actor again inside every write.
 *
 * Secrets this function holds: the service-role key (to call 0016's service-role-only
 * RPCs) and, per registered provider, the OAuth client id and secret named by the
 * registry (`clientIdEnv`/`clientSecretEnv`). Tenant credentials are in Supabase Vault and
 * are resolved only inside the service for one operation at a time.
 *
 * Environment:
 *   ARC_ENVIRONMENT          production | staging | development | test. Unset = production.
 *   ARC_SITE_URL             the site origin (the redirect must be on it).
 *   ARC_OAUTH_REDIRECT_URL   the exact redirect URI registered with every provider.
 *
 * Deploy: `supabase functions deploy connections` — after migration 0016 and the hosted
 * Vault verification in docs/architecture/ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md §15.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fetchTransport } from '../_shared/connections/adapter.ts';
import { requireAvailable, selectCredentialStore } from '../_shared/connections/credential-store.ts';
import { resolveRuntimeEnvironment } from '../_shared/connections/runtime-env.ts';
import { SupabaseVaultCredentialStore } from '../_shared/connections/supabase-connection-store.ts';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { createConnectionLimiter, handleConnectionAction } from './handler.ts';
import { SecretValue } from '../_shared/connections/redact.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SITE_URL = Deno.env.get('ARC_SITE_URL') ?? null;
const REDIRECT_URL = Deno.env.get('ARC_OAUTH_REDIRECT_URL') ?? null;
const ENVIRONMENT = resolveRuntimeEnvironment(Deno.env.get('ARC_ENVIRONMENT'));

const limiter = createConnectionLimiter();

const ORIGIN = (() => {
  try {
    return SITE_URL ? new URL(SITE_URL).origin : 'null';
  } catch {
    return 'null';
  }
})();

const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...CORS, ...headers },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'invalid_request', message: 'use POST' }, 405);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'invalid_request', message: 'send JSON' }, 415);
  }
  const authorization = request.headers.get('authorization');
  if (!authorization) return json({ error: 'forbidden', message: 'not signed in' }, 401);

  /* the actor is whoever the token verifies as — asked of Supabase Auth, not read off a claim. */
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await caller.auth.getUser();
  const actorId = who?.user?.id ?? null;
  if (!actorId) return json({ error: 'forbidden', message: 'not signed in' }, 401);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_request', message: 'body is not a JSON object' }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  /* production and staging get Vault or an error; there is no test double in this bundle to fall back to. */
  const credentials = selectCredentialStore({ environment: ENVIRONMENT, vault: () => new SupabaseVaultCredentialStore(db, { environment: ENVIRONMENT }) });
  try {
    await requireAvailable(credentials);
  } catch {
    return json({ error: 'vault_unavailable', message: 'the credential store is unavailable — nothing was changed' }, 503);
  }
  const store = { ...supabaseStore(db), credentials };

  const result = await handleConnectionAction(String(body.action ?? ''), {
    body,
    actorId,
    limiter,
    deps: {
      store,
      transport: fetchTransport(),
      environment: ENVIRONMENT,
      lifecycle: store,
      oauth: {
        siteUrl: SITE_URL,
        redirectUrl: REDIRECT_URL,
        clientCredentials: (oauth) => {
          const clientId = Deno.env.get(oauth.clientIdEnv) ?? '';
          const clientSecret = Deno.env.get(oauth.clientSecretEnv) ?? '';
          return clientId && clientSecret ? { clientId, clientSecret: new SecretValue(clientSecret) } : null;
        },
      },
    },
  });
  return json(result.body, result.status, result.headers ?? {});
});
