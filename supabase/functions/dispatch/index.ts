/**
 * POST /functions/v1/dispatch
 *
 * The worker. It claims due rows from `scheduled_actions`, re-reads the world, does the
 * work and records what happened. Everything the engine will ever do in the future is one
 * of those rows — there are no timers, no sleeping workflows and no cron job that
 * re-derives intent from the event log.
 *
 * Run it on a schedule. Once a minute is the right cadence: the first response is normally
 * queued for *now* and is sent by the webhook's own dispatch call, so the schedule exists
 * for follow-ups, closes and retries, none of which are second-sensitive.
 *
 *   supabase functions deploy dispatch --no-verify-jwt
 *   supabase secrets set ARC_DISPATCH_KEY=<a long random string>
 *
 *   -- then, in the SQL editor (pg_cron + pg_net):
 *   select cron.schedule('arc-lead-recovery-dispatch', '* * * * *', $$
 *     select net.http_post(
 *       url     := 'https://<ref>.supabase.co/functions/v1/dispatch',
 *       headers := '{"content-type":"application/json","x-arc-dispatch-key":"<the same string>"}'::jsonb,
 *       body    := '{"limit":25}'::jsonb
 *     );
 *   $$);
 *
 * Two callers are allowed and they authenticate differently: the scheduler presents
 * `x-arc-dispatch-key`, and an operator pressing "run the queue now" in the console
 * presents their own JWT, which is checked against `arc_admins` the same way the `ops`
 * function checks it. There is exactly one definition of "is this an operator" in the
 * system and this is not a second one.
 *
 * Concurrency is not this file's problem. Overlapping runs are safe because
 * `claim_scheduled_actions()` hands a row to exactly one caller — `for update skip
 * locked` — and every action carries an idempotency key besides.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { runDueActions, type EngineDeps } from '../_shared/engine/runtime.ts';
import { classifierFor } from '../_shared/classifier.ts';
import { RecordingSender, TwilioRestSender } from '../_shared/twilio.ts';
import { safeEqual } from '../_shared/twilio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const DISPATCH_KEY = Deno.env.get('ARC_DISPATCH_KEY') ?? '';
const PUBLIC_BASE = (Deno.env.get('ARC_PUBLIC_FUNCTIONS_URL') ?? `${SUPABASE_URL}/functions/v1`).replace(/\/+$/, '');
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');

/** A ceiling on one invocation, so a backlog is drained over several runs rather than
    against the function's wall-clock limit. */
const MAX_LIMIT = 100;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-arc-dispatch-key',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return json({ ok: true }, 200);
  }
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── who is asking ──
  const presentedKey = request.headers.get('x-arc-dispatch-key');
  const authorization = request.headers.get('authorization');
  let caller = '';

  if (presentedKey) {
    /* constant-time, and refused outright when no key is configured — an empty secret must
       not compare equal to an empty header. */
    if (!DISPATCH_KEY || !safeEqual(DISPATCH_KEY, presentedKey)) {
      return json({ error: 'not authorised' }, 403);
    }
    caller = 'scheduler';
  } else if (authorization) {
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isAdmin, error } = await asCaller.rpc('is_arc_admin');
    if (error) return json({ error: 'authorisation check failed' }, 500);
    if (!isAdmin) return json({ error: 'not an arc admin' }, 403);
    caller = 'operator';
  } else {
    return json({ error: 'not authorised' }, 401);
  }

  let body: { limit?: number; worker?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* an empty body from the scheduler is normal. */
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(body.limit ?? 25)));
  /* the worker name lands in `locked_by`, so an operator looking at a stuck row can see
     whether the scheduler or a person was holding it. */
  const worker = `${caller}:${(body.worker ?? Deno.env.get('SB_EXECUTION_ID') ?? crypto.randomUUID()).slice(0, 40)}`;

  const deps: EngineDeps = {
    store: supabaseStore(db as never),
    now: () => new Date(),
    liveSender: new TwilioRestSender(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
    canarySender: new RecordingSender(),
    classifierFor: (config) => classifierFor(config, { anthropicKey: ANTHROPIC_API_KEY || null }),
    urls: {
      statusCallback: `${PUBLIC_BASE}/twilio/message-status`,
      leadInConsole: (tenantId) => (SITE_URL ? `${SITE_URL}/ops/console/clients/${tenantId}` : null),
    },
    uuid: () => crypto.randomUUID(),
    worker,
  };

  try {
    /* the production dispatcher, and the only caller allowed to ask for every
       tenant's work. `tenantId: null` is written out rather than defaulted, because
       the defect ARC-015 closes was exactly a global claim reached by omission. */
    const summary = await runDueActions(deps, { limit, worker, tenantId: null });
    if (summary.claimed > 0) {
      console.log(
        `dispatch ${worker}: claimed ${summary.claimed}, done ${summary.done}, cancelled ${summary.cancelled}, retried ${summary.retried}, failed ${summary.failed}`,
      );
    }
    return json({ ok: true, ...summary }, 200);
  } catch (error) {
    console.error('dispatch failed', error);
    return json({ error: 'the dispatcher failed', detail: (error as Error)?.message ?? null }, 500);
  }
});
