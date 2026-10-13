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
 * ARC-MK-200 adds one read beside the table, `account-settings`: the client's own published
 * hours, service area, out-of-hours rule, alert recipients and do-not-contact list, as a
 * projection with every address reduced to a hint (`_shared/account/`). It writes nothing.
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
import { supabaseConfigStore } from '../_shared/config/supabase-config-store.ts';
import { ACCOUNT_ERROR_STATUS, readAccountSettings, supabaseStopList } from '../_shared/account/service.ts';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { resumeAutomation, sendOwnerReply, takeOverLead } from '../_shared/engine/runtime.ts';
import { RecordingSender } from '../_shared/twilio.ts';
import { UnavailableClassifier } from '../_shared/classifier.ts';

import { CAMPAIGN_ACTIONS, handleCampaignAction } from '../_shared/campaigns/service.ts';
import { supabaseCampaignStore } from '../_shared/campaigns/supabase-campaign-store.ts';

/** the owner portal's one read that is not a workspace action. */
const ACCOUNT_ACTION = 'account-settings';
const LEAD_TAKEOVER_ACTION = 'lead-takeover';
/* the owner's own words to a customer, and handing the conversation back (0036). both are
   the engine's: this door checks who is asking and queues or transitions, and sends nothing. */
const LEAD_REPLY_ACTION = 'lead-reply';
const LEAD_RESUME_ACTION = 'lead-resume';
const LEAD_ACTIONS = [LEAD_TAKEOVER_ACTION, LEAD_REPLY_ACTION, LEAD_RESUME_ACTION];
/* a refusal the owner can act on is a 409 with its code; a lead that is not theirs is a 404. */
const OWNER_REFUSAL_STATUS: Record<string, number> = { not_found: 404, empty: 422, too_long: 422, invalid: 422, withheld: 422 };

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
  if (action === 'capabilities') return json({ ok: true, actions: [...WORKSPACE_ACTIONS, ACCOUNT_ACTION, ...LEAD_ACTIONS, ...CAMPAIGN_ACTIONS] }, 200);
  if (action !== ACCOUNT_ACTION && !LEAD_ACTIONS.includes(action) && !CAMPAIGN_ACTIONS.includes(action) && !WORKSPACE_ACTIONS.includes(action)) return json({ error: 'unknown action' }, 400);
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

  if (action === LEAD_TAKEOVER_ACTION) {
    if (membership?.role !== 'owner') return json({ error: 'owner access required', code: 'forbidden' }, 403);
    if (typeof body.lead_id !== 'string' || !UUID.test(body.lead_id)) return json({ error: 'lead_id is required', code: 'invalid' }, 422);
    try {
      const recording = new RecordingSender();
      const result = await takeOverLead({
        store: supabaseStore(db as never), now: () => new Date(),
        liveSender: recording, canarySender: recording,
        classifierFor: () => new UnavailableClassifier('owner action'),
        uuid: () => crypto.randomUUID(), worker: `owner:${userId}`,
      }, { tenantId: body.tenant_id, leadId: body.lead_id, actor: userId });
      return result.ok ? json({ ok: true, outcome: result.outcome }, 200)
        : json({ error: 'lead not found', code: 'not_found' }, 404);
    } catch (failure) {
      console.error('crm lead-takeover failed', failure);
      return json({ error: 'could not take over this inquiry', code: 'failed' }, 500);
    }
  }

  /* the owner writes to the customer, or hands the conversation back to ARC (0036). who is
     asking is their sign-in and their role is `tenant_members`'; the lead is found by tenant
     and id together. nothing is sent from here: a reply becomes one action on the queue, and
     the dispatcher sends it through the same reservation as every other text. the sender
     this function holds records and reaches nobody, as for a takeover. */
  if (action === LEAD_REPLY_ACTION || action === LEAD_RESUME_ACTION) {
    if (membership?.role !== 'owner') return json({ error: 'owner access required', code: 'forbidden' }, 403);
    if (typeof body.lead_id !== 'string' || !UUID.test(body.lead_id)) return json({ error: 'lead_id is required', code: 'invalid' }, 422);
    try {
      const recording = new RecordingSender();
      const deps = {
        store: supabaseStore(db as never), now: () => new Date(),
        liveSender: recording, canarySender: recording,
        classifierFor: () => new UnavailableClassifier('owner action'),
        uuid: () => crypto.randomUUID(), worker: `owner:${userId}`,
      };
      const result = action === LEAD_REPLY_ACTION
        ? await sendOwnerReply(deps, {
          tenantId: body.tenant_id, leadId: body.lead_id, actorId: userId,
          body: typeof body.body === 'string' ? body.body : '',
          requestKey: typeof body.request_key === 'string' ? body.request_key : '',
        })
        : await resumeAutomation(deps, { tenantId: body.tenant_id, leadId: body.lead_id, actor: userId });
      return result.ok
        ? json({ ok: true, outcome: result.outcome }, 200)
        : json({ error: result.outcome, code: result.code }, OWNER_REFUSAL_STATUS[result.code] ?? 409);
    } catch (failure) {
      const message = (failure as Error)?.message ?? '';
      /* the queue does not know the action yet: 0036 has not been applied to this database. */
      if (/automation_action_types|scheduled_actions_action_type_fk|send_owner_reply/i.test(message)) {
        return json({ error: 'replying from ARC is not available on this account yet', code: 'unavailable' }, 501);
      }
      console.error(`crm ${action} failed`, failure);
      return json({ error: 'that did not go through, and nothing was changed', code: 'failed' }, 500);
    }
  }

  /* an owner previewing or publishing their own campaign (0034). the store is the full one,
     so the lifecycle hears about the new version in the same request; the service reads the
     words from the saved row, never from this body. */
  if (CAMPAIGN_ACTIONS.includes(action)) {
    if (membership?.role !== 'owner') return json({ error: 'owner access required', code: 'forbidden' }, 403);
    try {
      const result = await handleCampaignAction(
        action,
        { config: supabaseStore(db as never), campaigns: supabaseCampaignStore(db) },
        { tenantId: body.tenant_id, actor: { kind: 'client', userId, tenantId: body.tenant_id }, body },
      );
      return json(result.body, result.status);
    } catch (failure) {
      const message = (failure as Error)?.message ?? '';
      if (/customer_campaign_drafts|published_revision|self_service_mark_campaign_published|config_require_publisher/i.test(message)
        && /does not exist|could not find/i.test(message)) {
        return json({ error: 'switching a campaign on is not available on this account yet', code: 'unavailable' }, 501);
      }
      console.error(`crm action ${action} failed`, failure);
      return json({ error: 'the campaign could not be switched on', code: 'failed' }, 500);
    }
  }

  if (action === ACCOUNT_ACTION) {
    try {
      const outcome = await readAccountSettings({ config: supabaseConfigStore(db), stopList: supabaseStopList(db) }, actor, body.tenant_id);
      if (!outcome.ok) return json({ error: outcome.message, code: outcome.code }, ACCOUNT_ERROR_STATUS[outcome.code] ?? 409);
      return json({ ok: true, settings: outcome.result }, 200);
    } catch (failure) {
      console.error('crm action account-settings failed', failure);
      return json({ error: 'the settings could not be read' }, 500);
    }
  }

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
