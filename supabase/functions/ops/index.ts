/**
 * POST /functions/v1/ops
 *
 * The two things the ops console cannot do from the browser, because both need
 * to touch auth.users and nothing with an anon key ever should.
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
 * Authorisation is the caller's own JWT checked against public.arc_admins, via
 * the same is_arc_admin() the row level security policies use. There is exactly
 * one definition of "is this Ben" in the system and this is not a second one.
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

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

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

  let body: { action?: string; tenant_id?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const email = body.email?.trim().toLowerCase();
  const tenantId = body.tenant_id?.trim();
  if (!email || !tenantId) return json({ error: 'tenant_id and email are required' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

  if (body.action === 'unlink-client') {
    const user = await findUser(email);
    if (!user) return json({ error: 'no account with that address' }, 404);

    const { error } = await db
      .from('tenant_members')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('user_id', user.id);

    if (error) return json({ error: `unlink failed: ${error.message}` }, 500);
    return json({ ok: true, unlinked: email }, 200);
  }

  if (body.action !== 'link-client') return json({ error: 'unknown action' }, 400);

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

  return json({ ok: true, invited, linked: email, user_id: user!.id }, 200);
});
