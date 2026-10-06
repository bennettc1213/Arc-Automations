/**
 * POST /functions/v1/crm   { "action": "<one of WORKSPACE_ACTIONS>", "tenant_id": "...", … }
 *
 * ARC-360 — a client's own team working their leads: the inbox, the pipeline, tasks, notes
 * and contacts. The operator's door to the same workspace is `ops`; both run
 * `_shared/crm/actions.ts`, so they cannot disagree about what a button does.
 *
 * Signed-in users only (a Supabase JWT in the Authorization header — never a cookie, so a
 * cross-site form cannot act as anyone). The actor is whoever that token verifies as, asked
 * of Supabase Auth, and their role for the tenant is read here from `tenant_members` — a
 * body cannot claim one. A user who is not a member of the tenant named is refused before
 * anything is read. 0023/0025 check the same actor again inside every write, and the
 * timeline (`crm_activities`) is written by the database in the same statement.
 *
 * ARC-370 adds the conversation with a customer through the same table. A message a person
 * writes here is never sent by this function: it becomes one row and one durable
 * `send_message` action (0026, on ARC-200's queue), and what sends it is a runner that
 * re-reads the do-not-contact list first. A provider's inbound message has no action here —
 * a signed-in person cannot post one.
 *
 * ARC-380 adds appointments through the same table: the calendar, booking a time for a lead,
 * confirming, moving and cancelling one. The time is given by 0027's guard under a lock, never
 * by this function, and nothing here tells the customer — a confirmation is a message, and a
 * message is ARC-370's.
 *
 * Nothing here starts an automation or writes `events`.
 *
 * Deploy:  supabase functions deploy crm
 *          (JWT verification left ON: every caller here is signed in. needs 0023–0027.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clientActor, handleWorkspaceAction, WORKSPACE_ACTIONS } from '../_shared/crm/actions.ts';
import { supabaseCrmStore } from '../_shared/crm/supabase-crm-store.ts';
import { supabaseIntakeStore } from '../_shared/intake/supabase-intake-store.ts';
import { supabaseBookingStore } from '../_shared/booking/supabase-booking-store.ts';
import { conversationDeps } from '../_shared/communications/wiring.ts';
import { resolveRuntimeEnvironment } from '../_shared/connections/runtime-env.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/* the same rule as `ops` and `connections`: an unset environment is production. */
const ENVIRONMENT = resolveRuntimeEnvironment(Deno.env.get('ARC_ENVIRONMENT'));
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');
const OAUTH_REDIRECT_URL = Deno.env.get('ARC_OAUTH_REDIRECT_URL') ?? null;

/* the same as `ops`: the bearer token is the credential, so no cookie rides along and any
   origin may ask — what it gets back is decided by whose token it is. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BODY_BYTES = 64_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...CORS },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
  const authorization = request.headers.get('authorization');
  if (!authorization) return json({ error: 'not signed in', code: 'unauthorized' }, 401);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await caller.auth.getUser();
  const userId = who?.user?.id ?? null;
  if (!userId) return json({ error: 'not signed in', code: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'the request is too large' }, 413);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'body is not a JSON object' }, 400);
  }

  const action = String(body.action ?? '');
  if (action === 'capabilities') return json({ ok: true, actions: WORKSPACE_ACTIONS }, 200);
  if (!WORKSPACE_ACTIONS.includes(action)) return json({ error: 'unknown action' }, 400);
  if (typeof body.tenant_id !== 'string' || !UUID.test(body.tenant_id)) {
    return json({ error: 'tenant_id is required', code: 'invalid' }, 422);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: membership, error } = await db
    .from('tenant_members')
    .select('role')
    .eq('tenant_id', body.tenant_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return json({ error: 'could not check membership' }, 500);
  /* not a member: the same answer whether or not the tenant exists. */
  const actor = clientActor(userId, body.tenant_id, membership);
  if (!actor) return json({ error: 'this account does not belong to that client', code: 'forbidden' }, 403);

  try {
    const result = await handleWorkspaceAction(action, {
      deps: {
        crm: supabaseCrmStore(db),
        intake: supabaseIntakeStore(db),
        booking: supabaseBookingStore(db),
        ...conversationDeps(db, {
          environment: ENVIRONMENT,
          siteUrl: SITE_URL || null,
          oauthRedirectUrl: OAUTH_REDIRECT_URL,
          env: (name) => Deno.env.get(name),
          worker: 'crm-messages',
        }),
      },
      actor,
      body,
    });
    return json(result.body, result.status);
  } catch (failure) {
    const message = (failure as Error)?.message ?? 'the action failed';
    if (/crm_appointment|crm_booking|crm_book_appointment/i.test(message) && /does not exist|could not find/i.test(message)) {
      return json({ error: 'booking needs supabase/migrations/0027_crm_booking.sql applied first' }, 501);
    }
    if (/crm_conversations|crm_messages|crm_snippets|crm_message_|crm_queue_message|crm_conversation_/i.test(message) && /does not exist|could not find/i.test(message)) {
      return json({ error: 'conversations need supabase/migrations/0026_crm_communications.sql applied first' }, 501);
    }
    if (/crm_save_stages|waits_on|crm_pipeline_revisions/i.test(message) && /does not exist|could not find/i.test(message)) {
      return json({ error: 'the workspace needs supabase/migrations/0025_crm_workspace.sql applied first' }, 501);
    }
    if (/crm_|business_/i.test(message) && /does not exist|could not find/i.test(message)) {
      return json({ error: 'the workspace needs supabase/migrations/0023_crm_core.sql and 0024_native_intake.sql applied first' }, 501);
    }
    console.error(`crm action ${action} failed`, failure);
    return json({ error: 'the action failed' }, 500);
  }
});
