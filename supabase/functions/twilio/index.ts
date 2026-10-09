/**
 * POST /functions/v1/twilio/{voice|dial-status|sms|message-status}
 *
 * The telephony boundary. Four webhooks, one tenant-aware handler each, and one rule that
 * runs before any of them: **verify the signature**. An unsigned or wrongly-signed request
 * is answered 403 and nothing is read from its body, nothing is written, and no lead is
 * created. These endpoints are public by necessity — Twilio cannot present a Supabase JWT —
 * so the HMAC is the entire authentication story and it is not optional in any environment.
 *
 * The URLs to enter in the Twilio console, for a project at https://<ref>.supabase.co:
 *
 *   A Number → Voice → "A call comes in"        POST  …/functions/v1/twilio/voice
 *   (the dial action callback is set by the TwiML we return, not in the console)
 *   A Number → Messaging → "A message comes in" POST  …/functions/v1/twilio/sms
 *   Messaging Service → delivery status         POST  …/functions/v1/twilio/message-status
 *
 * Tenant routing is one rule and one rule only: **the number that was called owns the
 * request**. `To` on a voice or SMS webhook is matched against `twilio.phone_number` in
 * each tenant's current published Lead Recovery version (0014). There is no tenant id in the URL, no
 * subaccount in a header and no query parameter, because every one of those is something a
 * caller could change. A number claimed by two tenants is refused rather than guessed at.
 *
 * The four handlers and the gate are `handler.ts` (ARC-GO-320), so the safety test pass can
 * post a signed request at them. This file is the secrets, the database client and the
 * senders — everything a forged request must never reach, built only once `open()` is called.
 *
 * Deploy:  supabase functions deploy twilio --no-verify-jwt
 *          supabase secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=...
 *          supabase secrets set ARC_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseStore } from '../_shared/supabase-store.ts';
import type { EngineDeps } from '../_shared/engine/runtime.ts';
import { classifierFor } from '../_shared/classifier.ts';
import { TwilioRestSender, RecordingSender } from '../_shared/twilio.ts';
import { handleTwilioWebhook, messageTenantFrom } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* Arc's own Twilio credentials. One pair for the whole platform; tenant separation is the
   number, the subaccount reference and `tenant_id` on every row — never a second key. */
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

/**
 * The public base for these functions, as Twilio sees it.
 *
 * Configured rather than reconstructed from the request. A signature is computed over the
 * exact URL Twilio called, and `request.url` behind a proxy that rewrote the host is a
 * different string — which would make every signature fail, or, worse, make a forged
 * `X-Forwarded-Host` part of what we verify against.
 */
const PUBLIC_BASE = (Deno.env.get('ARC_PUBLIC_FUNCTIONS_URL') ?? `${SUPABASE_URL}/functions/v1`).replace(/\/+$/, '');
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');

function depsFor(db: ReturnType<typeof createClient>): EngineDeps {
  const store = supabaseStore(db as never);
  return {
    store,
    now: () => new Date(),
    liveSender: new TwilioRestSender(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
    /* a canary gets a sender that records and returns a synthetic SID. it is supplied here
       rather than chosen in the engine so a deployment cannot end up with a canary path
       that silently falls back to the live one. */
    canarySender: new RecordingSender(),
    classifierFor: (config) => classifierFor(config, { anthropicKey: ANTHROPIC_API_KEY || null }),
    urls: {
      statusCallback: `${PUBLIC_BASE}/twilio/message-status`,
      /* the owner's own screen. an alert used to link to the operator console. */
      ownerNeedsYou: () => (SITE_URL ? `${SITE_URL}/portal/dashboard/needs-you` : null),
    },
    uuid: () => crypto.randomUUID(),
    worker: 'twilio-webhook',
  };
}

Deno.serve(async (request) => {
  const answer = await handleTwilioWebhook(
    {
      authToken: TWILIO_AUTH_TOKEN,
      publicBase: PUBLIC_BASE,
      /* reached only by a request whose signature has passed. */
      open() {
        const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        return { deps: depsFor(db), messageTenant: messageTenantFrom(db) };
      },
    },
    {
      method: request.method,
      url: request.url,
      /* a GET has no body to read, and is refused before anything looks for one. */
      body: request.method === 'POST' ? await request.text() : '',
      signature: request.headers.get('x-twilio-signature'),
    },
  );
  return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.contentType } });
});
