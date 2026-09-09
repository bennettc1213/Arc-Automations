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
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');

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
};

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
  if (!ACCOUNT_ACTIONS.includes(action) && !ALERT_ACTIONS.includes(action)) {
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
