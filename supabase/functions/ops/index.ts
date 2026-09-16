/**
 * POST /functions/v1/ops
 *
 * Everything the ops console cannot do from the browser.
 *
 * Account actions — these need auth.users, and nothing with an anon key ever
 * should:
 *
 *   { "action": "link-client", "tenant_id": "...", "email": "owner@co.com" }
 *     invites the address if it has no account yet, then attaches it to the
 *     tenant as owner. This is the step that turns a row in `tenants` into an
 *     account somebody can actually sign into.
 *
 *   { "action": "unlink-client", "tenant_id": "...", "email": "owner@co.com" }
 *     detaches it again. The auth user is left alone — deleting a person's
 *     login because an engagement ended is not this button's decision to make.
 *
 * Alert actions — the write path for the only mutable table in the schema:
 *
 *   { "action": "raise-alert", "tenant_id": "...", "check_type": "canary",
 *     "severity": "critical", "message": "..." }
 *   { "action": "acknowledge-alert", "alert_id": "..." }
 *   { "action": "resolve-alert", "alert_id": "..." }
 *
 *     `alerts` has a select policy and an admin update policy, and until now
 *     nothing anywhere inserted a row. The reliability page rendered incidents
 *     from a table that could never have any, and the client-facing support page
 *     promised "the hourly end-to-end check fails, we get paged, and the
 *     incident appears on your reliability page" — a promise the system had no
 *     way to keep. This is that path.
 *
 *     NOTE: this is the write half only. The thing that DETECTS silence — the
 *     n8n poller that sweeps for tenants with no events in N hours and calls
 *     raise-alert — is Phase 2 (N4) and does not exist yet. Until it does, an
 *     alert appears because a human noticed, which is better than the previous
 *     state (no alert could exist at all) and is not the same as monitoring.
 *
 * Lifecycle — taking a client out of the system, and bringing one back:
 *
 *   { "action": "deboard-client", "tenant_id": "...", "reason": "contract ended",
 *     "note": "...", "delete_logins": false }
 *     revokes every ingest token, removes every login's access, retires every
 *     connection and archives the tenant — in one transaction, inside
 *     public.deboard_tenant (migration 0007). With delete_logins, a login that
 *     belongs to no other client and is not an operator is then deleted from
 *     auth as well. No event is deleted: a past client's history is still the
 *     record of what the service did.
 *
 *   { "action": "restore-client", "tenant_id": "...", "status": "paused" }
 *
 * The live pipeline check — read-only, so not audited:
 *
 *   { "action": "probe-pipelines",
 *     "tenants": [{ "tenant_id": "...", "workflow_ids": ["WgCrNV0MwlwwxUWM"] }] }
 *     asks the systems themselves, right now: is the ingest endpoint up, does
 *     the client hold a token n8n can post with and when was it last used, when
 *     did the last event land, does the n8n instance answer /healthz, and — with
 *     N8N_API_URL and N8N_API_KEY set as function secrets — is each workflow
 *     switched on in n8n and how did its last execution go. It returns the
 *     facts; the console decides what they add up to (lib/ops.js,
 *     pipelineVerdict), so the verdict has one definition.
 *
 *   { "action": "capabilities" }
 *     which of the above this deployment knows. The console asks, so a stale
 *     deploy is reported as "redeploy the ops function" rather than as a
 *     generic unknown-action error on the first button pressed.
 *
 * Authorisation is the caller's own JWT checked against public.arc_admins, via
 * the same is_arc_admin() the row level security policies use. There is exactly
 * one definition of "is this Ben" in the system and this is not a second one.
 *
 * Every action that changes something writes a row to public.admin_actions
 * before it returns. That write happens here rather than in the browser for the
 * same reason the admin check does: a log the client is trusted to write is a
 * log an attacker can simply skip.
 *
 * Deploy:  supabase functions deploy ops
 *          (JWT verification left ON: every caller here is signed in.)
 *          supabase secrets set N8N_API_URL=https://you.app.n8n.cloud N8N_API_KEY=...
 *          (optional: without them the probe still checks ingest, tokens, events
 *          and /healthz, and says the workflows could not be asked.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');

/* arc's own n8n. the key never leaves this function: the browser holds an anon
   key and a session, and an n8n api key in a bundle is every workflow and every
   credential in the account handed to whoever opens devtools. */
const N8N_API_URL = (Deno.env.get('N8N_API_URL') ?? '').replace(/\/+$/, '');
const N8N_API_KEY = Deno.env.get('N8N_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* mirrors the check constraints on public.alerts. validated here as well as in
   postgres so a bad value comes back as a sentence rather than a constraint
   violation string. */
const CHECK_TYPES = ['canary', 'watermark', 'schema'];
const SEVERITIES = ['info', 'warning', 'critical'];

const ACCOUNT_ACTIONS = ['link-client', 'unlink-client'];
const ALERT_ACTIONS = ['raise-alert', 'acknowledge-alert', 'resolve-alert'];
const LIFECYCLE_ACTIONS = ['deboard-client', 'restore-client'];
const PROBE_ACTIONS = ['probe-pipelines', 'capabilities'];
const ACTIONS = [...ACCOUNT_ACTIONS, ...ALERT_ACTIONS, ...LIFECYCLE_ACTIONS, ...PROBE_ACTIONS];

const RESTORE_STATUSES = ['onboarding', 'active', 'paused'];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

type Body = {
  action?: string;
  tenant_id?: string;
  email?: string;
  alert_id?: string;
  check_type?: string;
  severity?: string;
  message?: string;
  reason?: string;
  note?: string;
  status?: string;
  delete_logins?: boolean;
  tenants?: { tenant_id?: string; workflow_ids?: unknown }[];
};

/* ── the live check's plumbing ───────────────────────────────────────── */

type Reach = { ok: boolean; status: number | null; ms: number; detail: string | null };

/**
 * one outbound request with a hard ceiling on how long it may take.
 *
 * redirects are not followed: /healthz answering with a redirect to a login page
 * is an instance that is up but not the one we meant, and following it would
 * turn that into a green tick.
 */
async function timedFetch(url: string, init: RequestInit = {}, ceilingMs = 6000) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ceilingMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    return { response, ms: Math.round(performance.now() - started), error: null as string | null };
  } catch (error) {
    return {
      response: null,
      ms: Math.round(performance.now() - started),
      error: controller.signal.aborted
        ? `no answer in ${ceilingMs / 1000}s`
        : (error as Error)?.message ?? 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* an n8n endpoint worth calling /healthz on: https, and nothing but an origin.
   the connection's endpoint is typed by an operator and may be a phone number or
   a sub-account id; only a real url becomes a request. */
function httpsOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);

  const authorization = request.headers.get('authorization');
  if (!authorization) return json({ error: 'not signed in' }, 401);

  /* the caller's own client, carrying the caller's own JWT. is_arc_admin()
     resolves auth.uid() from that token, so this asks postgres the question
     rather than deciding it here off a claim. */
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: isAdmin, error: adminError } = await asCaller.rpc('is_arc_admin');
  if (adminError) return json({ error: 'authorisation check failed' }, 500);
  if (!isAdmin) return json({ error: 'not an arc admin' }, 403);

  /* who is acting, for the audit row. taken from the verified token rather than
     from anything in the body — an actor a caller can name is not an actor. */
  const { data: caller } = await asCaller.auth.getUser();
  const actorId = caller?.user?.id ?? null;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const action = body.action ?? '';
  if (!ACTIONS.includes(action)) {
    return json({ error: 'unknown action' }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /**
   * append a row to the audit log.
   *
   * deliberately does not throw and deliberately does not gate the response: an
   * action that succeeded and failed to log is a gap in the record, but an
   * action that is rolled back because the logging failed is a worse outcome for
   * the person holding the button. the failure is surfaced in the response as
   * `logged: false` rather than swallowed silently.
   */
  async function audit(
    verb: string,
    targetType: string | null,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    const { error } = await db.from('admin_actions').insert({
      actor_user_id: actorId,
      action: verb,
      target_type: targetType,
      target_id: targetId,
      metadata,
    });
    if (error) console.error('audit write failed', verb, error.message);
    return !error;
  }

  // ── alerts ────────────────────────────────────────────────────────────

  if (action === 'raise-alert') {
    const tenantId = body.tenant_id?.trim();
    const message = body.message?.trim();
    const checkType = body.check_type?.trim() ?? 'canary';
    const severity = body.severity?.trim() ?? 'critical';

    if (!tenantId || !message) {
      return json({ error: 'tenant_id and message are required' }, 400);
    }
    if (!CHECK_TYPES.includes(checkType)) {
      return json({ error: `check_type must be one of ${CHECK_TYPES.join(', ')}` }, 400);
    }
    if (!SEVERITIES.includes(severity)) {
      return json({ error: `severity must be one of ${SEVERITIES.join(', ')}` }, 400);
    }

    const { data, error } = await db
      .from('alerts')
      .insert({ tenant_id: tenantId, check_type: checkType, severity, message })
      .select('*')
      .single();

    if (error) return json({ error: `raise failed: ${error.message}` }, 500);

    const logged = await audit('alert.raised', 'alert', data.id, {
      tenant_id: tenantId,
      check_type: checkType,
      severity,
      message,
    });
    return json({ ok: true, alert: data, logged }, 200);
  }

  if (action === 'acknowledge-alert' || action === 'resolve-alert') {
    const alertId = body.alert_id?.trim();
    if (!alertId) return json({ error: 'alert_id is required' }, 400);

    const resolving = action === 'resolve-alert';
    const now = new Date().toISOString();

    /* resolving also stamps acknowledged_at if nothing did: an incident that
       went straight from detected to fixed still had a moment somebody saw it,
       and a null there would render as "acknowledged: not yet" on a timeline
       whose next row says resolved. */
    const patch = resolving
      ? { resolved_at: now, acknowledged_at: now }
      : { acknowledged_at: now };

    const existing = await db
      .from('alerts')
      .select('id, tenant_id, acknowledged_at, resolved_at')
      .eq('id', alertId)
      .maybeSingle();

    if (existing.error) return json({ error: existing.error.message }, 500);
    if (!existing.data) return json({ error: 'no alert with that id' }, 404);

    if (resolving && existing.data.acknowledged_at) {
      delete (patch as Record<string, unknown>).acknowledged_at;
    }

    const { data, error } = await db
      .from('alerts')
      .update(patch)
      .eq('id', alertId)
      .select('*')
      .single();

    if (error) return json({ error: `update failed: ${error.message}` }, 500);

    const logged = await audit(
      resolving ? 'alert.resolved' : 'alert.acknowledged',
      'alert',
      alertId,
      { tenant_id: existing.data.tenant_id },
    );
    return json({ ok: true, alert: data, logged }, 200);
  }

  // ── capabilities ──────────────────────────────────────────────────────

  if (action === 'capabilities') {
    return json(
      {
        ok: true,
        actions: ACTIONS,
        n8n: {
          configured: Boolean(N8N_API_URL && N8N_API_KEY),
          host: N8N_API_URL ? new URL(N8N_API_URL).host : null,
        },
      },
      200,
    );
  }

  // ── the live pipeline check ───────────────────────────────────────────

  if (action === 'probe-pipelines') {
    const requested = new Map<string, Set<string>>();
    for (const entry of (body.tenants ?? []).slice(0, 200)) {
      const id = entry?.tenant_id?.trim();
      if (!id) continue;
      const ids = Array.isArray(entry.workflow_ids) ? entry.workflow_ids : [];
      requested.set(
        id,
        new Set(
          ids.filter((w): w is string => typeof w === 'string' && WORKFLOW_ID.test(w)).slice(0, 50),
        ),
      );
    }

    /* no list means every client still on the books. */
    if (requested.size === 0) {
      const { data, error } = await db.from('tenants').select('id').neq('status', 'archived');
      if (error) return json({ error: `tenant read: ${error.message}` }, 500);
      for (const row of data ?? []) requested.set(row.id, new Set());
    }

    const tenantIds = [...requested.keys()];
    const checkedAt = new Date().toISOString();

    const [tokenRead, connectionRead] = await Promise.all([
      db.from('ingest_tokens').select('tenant_id, revoked_at, last_used_at').in('tenant_id', tenantIds),
      db.from('connections').select('tenant_id, kind, provider, endpoint, workflow_id, status').in('tenant_id', tenantIds),
    ]);
    if (tokenRead.error) return json({ error: `token read: ${tokenRead.error.message}` }, 500);
    if (connectionRead.error) return json({ error: `connection read: ${connectionRead.error.message}` }, 500);

    /* declared workflow ids join the ones the browser saw in the event log. a
       connection nobody has sent an event for yet is exactly the one worth
       asking n8n about. retired connections are left out: they are meant to be
       off. */
    const origins = new Map<string, Set<string>>();
    for (const row of connectionRead.data ?? []) {
      if (row.status === 'retired') continue;
      if (row.workflow_id && WORKFLOW_ID.test(row.workflow_id)) {
        requested.get(row.tenant_id)?.add(row.workflow_id);
      }
      const isN8n = row.kind === 'n8n' || row.provider === 'n8n';
      const origin = isN8n ? httpsOrigin(row.endpoint) : null;
      if (origin) {
        const set = origins.get(row.tenant_id) ?? new Set<string>();
        set.add(origin);
        origins.set(row.tenant_id, set);
      }
    }

    /* the ingest endpoint, asked the way a broken n8n credential would ask it:
       no token. `missing bearer token` back means the function is deployed,
       running and checking — the same answer every real post gets past. */
    const ingestProbe = (async (): Promise<Reach> => {
      const { response, ms, error } = await timedFetch(`${SUPABASE_URL}/functions/v1/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
        body: '{}',
      });
      if (!response) return { ok: false, status: null, ms, detail: error };
      const payload = await response.json().catch(() => null);
      if (response.status === 401 && payload?.error === 'missing bearer token') {
        return { ok: true, status: 401, ms, detail: 'up, and refusing posts without a token' };
      }
      return {
        ok: false,
        status: response.status,
        ms,
        detail: response.status === 404 ? 'the ingest function is not deployed' : `answered ${response.status}`,
      };
    })();

    /* every distinct instance once, however many clients share it. */
    const allOrigins = new Set<string>();
    for (const set of origins.values()) for (const origin of set) allOrigins.add(origin);
    const arcOrigin = httpsOrigin(N8N_API_URL);
    if (arcOrigin) allOrigins.add(arcOrigin);

    const healthProbes = new Map<string, Promise<Reach>>();
    for (const origin of allOrigins) {
      healthProbes.set(
        origin,
        (async () => {
          const { response, ms, error } = await timedFetch(`${origin}/healthz`);
          if (!response) return { ok: false, status: null, ms, detail: error };
          await response.body?.cancel();
          return {
            ok: response.status === 200,
            status: response.status,
            ms,
            detail: response.status === 200 ? 'answering /healthz' : `/healthz answered ${response.status}`,
          };
        })(),
      );
    }

    /* the workflow list, once, paged. one call per page rather than one per id,
       because a book of ten clients with four workflows each is forty calls a
       page load otherwise, against an api with a rate limit. */
    type N8nWorkflow = { id: string; name: string; active: boolean };
    const n8nConfigured = Boolean(N8N_API_URL && N8N_API_KEY);
    let n8nApi: { ok: boolean; status: number | null; detail: string | null; count: number } = {
      ok: false,
      status: null,
      detail: n8nConfigured ? null : 'N8N_API_URL and N8N_API_KEY are not set on this function',
      count: 0,
    };
    const workflows = new Map<string, N8nWorkflow>();

    if (n8nConfigured) {
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const url = new URL(`${N8N_API_URL}/api/v1/workflows`);
        url.searchParams.set('limit', '250');
        if (cursor) url.searchParams.set('cursor', cursor);
        const { response, error } = await timedFetch(url.toString(), {
          headers: { 'X-N8N-API-KEY': N8N_API_KEY, accept: 'application/json' },
        }, 8000);
        if (!response || !response.ok) {
          n8nApi = {
            ok: false,
            status: response?.status ?? null,
            detail: !response
              ? error
              : response.status === 401
                ? 'n8n rejected the api key'
                : `n8n answered ${response.status}`,
            count: 0,
          };
          await response?.body?.cancel();
          break;
        }
        const payload = await response.json().catch(() => null);
        for (const wf of payload?.data ?? []) {
          workflows.set(String(wf.id), { id: String(wf.id), name: wf.name, active: Boolean(wf.active) });
        }
        n8nApi = { ok: true, status: 200, detail: null, count: workflows.size };
        cursor = payload?.nextCursor ?? null;
        if (!cursor) break;
      }
    }

    /* the last execution of every workflow somebody asked about that n8n
       actually holds. */
    const wanted = new Set<string>();
    for (const set of requested.values()) for (const id of set) if (workflows.has(id)) wanted.add(id);

    const lastRuns = new Map<string, { status: string; at: string } | null>();
    await Promise.all(
      [...wanted].map(async (id) => {
        const url = new URL(`${N8N_API_URL}/api/v1/executions`);
        url.searchParams.set('workflowId', id);
        url.searchParams.set('limit', '1');
        const { response } = await timedFetch(url.toString(), {
          headers: { 'X-N8N-API-KEY': N8N_API_KEY, accept: 'application/json' },
        });
        if (!response?.ok) {
          await response?.body?.cancel();
          return;
        }
        const payload = await response.json().catch(() => null);
        const run = payload?.data?.[0];
        lastRuns.set(id, run ? { status: run.status ?? (run.finished ? 'success' : 'unknown'), at: run.startedAt } : null);
      }),
    );

    /* the newest event per client, read now rather than taken from the page's
       copy of the roster, which may be minutes old. events_feed_idx makes each
       one an index lookup. */
    const lastEvents = new Map<string, { at: string; type: string; canary: boolean } | null>();
    await Promise.all(
      tenantIds.map(async (id) => {
        const { data } = await db
          .from('events')
          .select('occurred_at, event_type, is_canary')
          .eq('tenant_id', id)
          .order('occurred_at', { ascending: false })
          .limit(1);
        const row = data?.[0];
        lastEvents.set(id, row ? { at: row.occurred_at, type: row.event_type, canary: row.is_canary } : null);
      }),
    );

    const health = new Map<string, Reach>();
    for (const [origin, probe] of healthProbes) health.set(origin, await probe);
    const ingest = await ingestProbe;

    const tenants: Record<string, unknown> = {};
    for (const id of tenantIds) {
      const own = (tokenRead.data ?? []).filter((row) => row.tenant_id === id);
      const live = own.filter((row) => !row.revoked_at);
      const lastUsed = live
        .map((row) => row.last_used_at)
        .filter(Boolean)
        .sort()
        .pop() ?? null;

      tenants[id] = {
        tokens: { active: live.length, total: own.length, last_used_at: lastUsed },
        last_event: lastEvents.get(id) ?? null,
        instances: [...(origins.get(id) ?? [])].map((origin) => ({
          origin,
          arc: origin === arcOrigin,
          ...health.get(origin)!,
        })),
        workflows: [...(requested.get(id) ?? [])].map((wfId) => {
          const wf = workflows.get(wfId);
          return {
            id: wfId,
            /* null when n8n could not be asked at all — "not found" would claim
               an answer nobody got. */
            found: n8nApi.ok ? Boolean(wf) : null,
            name: wf?.name ?? null,
            active: wf ? wf.active : null,
            last_run: wf ? lastRuns.get(wfId) ?? null : null,
          };
        }),
      };
    }

    return json(
      {
        ok: true,
        checked_at: checkedAt,
        ingest,
        n8n: {
          configured: n8nConfigured,
          host: N8N_API_URL ? new URL(N8N_API_URL).host : null,
          health: arcOrigin ? health.get(arcOrigin) ?? null : null,
          api: n8nApi,
        },
        tenants,
      },
      200,
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /* the rpc error for a function that is not there, which is migration 0007
     not having been applied. named, because it has one fix. */
  const missingMigration = (message: string) =>
    /deboard_tenant|restore_tenant|schema cache|does not exist/i.test(message);

  if (action === 'deboard-client') {
    const tenantId = body.tenant_id?.trim();
    const reason = body.reason?.trim();
    const note = body.note?.trim() || null;
    if (!tenantId || !reason) return json({ error: 'tenant_id and reason are required' }, 400);

    const { data: tenant } = await db
      .from('tenants')
      .select('id, name, client_id, login_email')
      .eq('id', tenantId)
      .maybeSingle();
    if (!tenant) return json({ error: 'no client with that id' }, 404);

    const { data, error } = await db.rpc('deboard_tenant', {
      p_tenant: tenantId,
      p_reason: reason,
      p_note: note,
    });

    if (error) {
      if (error.code === 'P0001') return json({ error: error.message }, 409);
      if (error.code === 'P0002') return json({ error: error.message }, 404);
      if (missingMigration(error.message)) {
        return json(
          { error: 'deboarding needs supabase/migrations/0007_client_offboarding.sql applied first' },
          501,
        );
      }
      return json({ error: `deboard failed: ${error.message}` }, 500);
    }

    /* the transaction is committed by here. deleting logins is the one step
       that cannot be inside it — auth.users belongs to the auth service — so it
       runs after, reports per person, and never undoes the deboarding. a login
       that is also another client's, or an operator's, is kept: ending one
       engagement is not a reason to lock somebody out of a different one. */
    const loginsDeleted: string[] = [];
    const loginsKept: { user_id: string; why: string }[] = [];

    if (body.delete_logins) {
      for (const userId of (data?.member_ids ?? []) as string[]) {
        const [{ count: otherTenants }, { count: operator }] = await Promise.all([
          db.from('tenant_members').select('user_id', { count: 'exact', head: true }).eq('user_id', userId),
          db.from('arc_admins').select('user_id', { count: 'exact', head: true }).eq('user_id', userId),
        ]);
        if ((operator ?? 0) > 0) {
          loginsKept.push({ user_id: userId, why: 'is an operator' });
          continue;
        }
        if ((otherTenants ?? 0) > 0) {
          loginsKept.push({ user_id: userId, why: 'still belongs to another client' });
          continue;
        }
        const { error: deleteError } = await db.auth.admin.deleteUser(userId);
        if (deleteError) loginsKept.push({ user_id: userId, why: deleteError.message });
        else loginsDeleted.push(userId);
      }
    }

    const logged = await audit('client.deboarded', 'tenant', tenantId, {
      name: tenant.name,
      client_id: tenant.client_id,
      reason,
      note,
      tokens_revoked: data?.tokens_revoked ?? 0,
      access_removed: data?.members_removed ?? 0,
      connections_retired: data?.connections_retired ?? 0,
      logins_deleted: loginsDeleted.length,
    });

    return json(
      {
        ok: true,
        archived_at: data?.archived_at,
        tokens_revoked: data?.tokens_revoked ?? 0,
        members_removed: data?.members_removed ?? 0,
        connections_retired: data?.connections_retired ?? 0,
        logins_deleted: loginsDeleted.length,
        logins_kept: loginsKept,
        logged,
      },
      200,
    );
  }

  if (action === 'restore-client') {
    const tenantId = body.tenant_id?.trim();
    const status = body.status?.trim() || 'paused';
    if (!tenantId) return json({ error: 'tenant_id is required' }, 400);
    if (!RESTORE_STATUSES.includes(status)) {
      return json({ error: `status must be one of ${RESTORE_STATUSES.join(', ')}` }, 400);
    }

    const { error } = await db.rpc('restore_tenant', { p_tenant: tenantId, p_status: status });
    if (error) {
      if (error.code === 'P0001') return json({ error: error.message }, 409);
      if (error.code === 'P0002') return json({ error: error.message }, 404);
      if (missingMigration(error.message)) {
        return json(
          { error: 'restoring needs supabase/migrations/0007_client_offboarding.sql applied first' },
          501,
        );
      }
      return json({ error: `restore failed: ${error.message}` }, 500);
    }

    const logged = await audit('client.restored', 'tenant', tenantId, { status });
    return json({ ok: true, status, logged }, 200);
  }

  // ── accounts ──────────────────────────────────────────────────────────

  const email = body.email?.trim().toLowerCase();
  const tenantId = body.tenant_id?.trim();
  if (!email || !tenantId) return json({ error: 'tenant_id and email are required' }, 400);

  /**
   * supabase-js has no getUserByEmail, so the list is paged through instead.
   *
   * paged rather than "the first two hundred", because a lookup that quietly
   * stops short does not report "not found" — it reports "not found" for an
   * account that exists, and the caller then tries to invite an address that is
   * already registered and gets an error naming neither problem.
   */
  async function findUser(address: string) {
    for (let page = 1; page <= 20; page += 1) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      const match = data.users.find((u) => u.email?.toLowerCase() === address);
      if (match) return match;
      if (data.users.length < 200) return null;
    }
    return null;
  }

  if (action === 'unlink-client') {
    const user = await findUser(email);
    if (!user) return json({ error: 'no account with that address' }, 404);

    const { error } = await db
      .from('tenant_members')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('user_id', user.id);

    if (error) return json({ error: `unlink failed: ${error.message}` }, 500);

    const logged = await audit('client.unlinked', 'tenant', tenantId, {
      email,
      user_id: user.id,
    });
    return json({ ok: true, unlinked: email, logged }, 200);
  }

  /* an address that already has an account is the normal case on a re-run of
     this button, and it must not be an error: the operation is "make sure this
     person can sign into this tenant", which is idempotent by intent. */
  let user = await findUser(email);
  let invited = false;

  if (!user) {
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
      redirectTo: SITE_URL ? `${SITE_URL}/auth/callback` : undefined,
    });
    if (error) return json({ error: `invite failed: ${error.message}` }, 500);
    user = data.user;
    invited = true;
  }

  const { error: linkError } = await db
    .from('tenant_members')
    .upsert({ user_id: user!.id, tenant_id: tenantId, role: 'owner' }, {
      onConflict: 'user_id,tenant_id',
    });

  if (linkError) return json({ error: `link failed: ${linkError.message}` }, 500);

  /* keep the sign-in address on the tenant in step with the account just
     attached, so the client-login function and this stay in agreement. */
  await db.from('tenants').update({ login_email: email }).eq('id', tenantId);

  const logged = await audit('client.linked', 'tenant', tenantId, {
    email,
    user_id: user!.id,
    invited,
  });

  return json({ ok: true, invited, linked: email, user_id: user!.id, logged }, 200);
});
