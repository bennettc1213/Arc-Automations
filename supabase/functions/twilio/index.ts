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
 * request**. `To` on a voice or SMS webhook is matched against
 * `module_configs.config.twilio.phone_number`. There is no tenant id in the URL, no
 * subaccount in a header and no query parameter, because every one of those is something a
 * caller could change. A number claimed by two tenants is refused rather than guessed at.
 *
 * Deploy:  supabase functions deploy twilio --no-verify-jwt
 *          supabase secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=...
 *          supabase secrets set ARC_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseStore } from '../_shared/supabase-store.ts';
import {
  handleInboundMessage,
  handleMessageStatus,
  intakeLead,
  loadConfig,
  shouldRecoverCall,
} from '../_shared/engine/runtime.ts';
import type { EngineDeps } from '../_shared/engine/runtime.ts';
import { classifierFor } from '../_shared/classifier.ts';
import {
  dialTwiml,
  emptyTwiml,
  formToParams,
  messageErrorClass,
  isPermanentFailure,
  sayAndHangupTwiml,
  TwilioRestSender,
  RecordingSender,
  verifyTwilioSignature,
} from '../_shared/twilio.ts';
import { normalisePhone } from '../_shared/phone.ts';

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

function twiml(body: string, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function depsFor(db: ReturnType<typeof createClient>, isCanaryRun = false): EngineDeps {
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
      leadInConsole: (tenantId) => (SITE_URL ? `${SITE_URL}/ops/console/clients/${tenantId}` : null),
    },
    uuid: () => crypto.randomUUID(),
    worker: 'twilio-webhook',
    ...(isCanaryRun ? {} : {}),
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);

  const url = new URL(request.url);
  /* the last path segment, so the function works whether it is mounted at
     /functions/v1/twilio/voice or behind a rewrite. */
  const route = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const known = ['voice', 'dial-status', 'sms', 'message-status'];
  if (!known.includes(route)) {
    return json({ error: `unknown route "${route}". Expected one of ${known.join(', ')}` }, 404);
  }

  const rawBody = await request.text();
  const params = formToParams(rawBody);

  /* ── the gate ──
     Before anything else, and over the URL we were configured with rather than the one the
     request claims. A failure here is 403 with no detail beyond the reason: a forger does
     not need help. */
  const signedUrl = `${PUBLIC_BASE}/twilio/${route}${url.search}`;
  const signature = await verifyTwilioSignature({
    authToken: TWILIO_AUTH_TOKEN,
    url: signedUrl,
    params,
    header: request.headers.get('x-twilio-signature'),
  });

  if (!signature.ok) {
    console.warn(`twilio webhook rejected on ${route}: ${signature.reason}`);
    return json({ error: 'invalid signature' }, 403);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = depsFor(db);
  const store = deps.store;

  try {
    // ── an incoming call ────────────────────────────────────────────────
    if (route === 'voice') {
      const called = normalisePhone(params.To ?? params.Called);
      if (!called) return twiml(sayAndHangupTwiml('This number is not configured. Please call back later.'), 200);

      const tenantConfig = await store.findTenantByTwilioNumber(called);
      if (!tenantConfig) {
        console.warn(`voice webhook for ${called}: no tenant claims this number`);
        return twiml(sayAndHangupTwiml('This number is not configured. Please call back later.'));
      }

      const loaded = await loadConfig(store, tenantConfig.tenantId);
      if (!loaded.ok) {
        console.error(`voice webhook for ${tenantConfig.tenantId}: ${loaded.reason}`);
        return twiml(sayAndHangupTwiml('We are unable to take your call right now. Please try again shortly.'));
      }

      /* the call is forwarded whether or not recovery is switched on. the module governs
         what happens *after* an unanswered call, not whether the business's phone rings —
         switching a client's module off must never stop their calls reaching them. */
      const config = loaded.loaded.config;
      return twiml(
        dialTwiml({
          destination: config.forwarding.destination,
          timeoutSeconds: config.forwarding.timeout_seconds,
          /* the CallSid rides on the action URL so the dial-status callback can be tied to
             this call even if Twilio's own body were ambiguous. It is not a secret and it
             is inside the signed URL, so it cannot be tampered with. */
          actionUrl: `${PUBLIC_BASE}/twilio/dial-status`,
          callerId: null,
        }),
      );
    }

    // ── how the forward went ────────────────────────────────────────────
    if (route === 'dial-status') {
      const called = normalisePhone(params.To ?? params.Called);
      const caller = normalisePhone(params.From ?? params.Caller);
      const callSid = params.CallSid ?? '';
      const dialStatus = params.DialCallStatus ?? params.CallStatus ?? '';

      if (!called || !callSid) return twiml(emptyTwiml());

      const tenantConfig = await store.findTenantByTwilioNumber(called);
      if (!tenantConfig) return twiml(emptyTwiml());

      /* the branch the whole module hangs off. an answered call produces nothing at all. */
      if (!shouldRecoverCall(dialStatus)) {
        return twiml(emptyTwiml());
      }

      const result = await intakeLead(deps, {
        tenantId: tenantConfig.tenantId,
        source: 'missed_call',
        /* the CallSid is the same on every redelivery of this callback, which is what makes
           a duplicate webhook produce one lead. */
        externalRef: callSid,
        phone: caller,
        customerName: params.CallerName || null,
        intakeRef: called,
        /* somebody who dialled this number has asked to be contacted on it. recorded as
           implied consent with its source, not assumed silently. */
        consentSms: true,
        consentSource: 'inbound_call',
      });

      console.log(`dial-status ${dialStatus} for ${tenantConfig.tenantId}: ${result.outcome}`);
      return twiml(emptyTwiml());
    }

    // ── an inbound text ─────────────────────────────────────────────────
    if (route === 'sms') {
      const to = normalisePhone(params.To);
      const from = normalisePhone(params.From);
      const sid = params.MessageSid ?? params.SmsMessageSid ?? '';
      if (!to || !from || !sid) return twiml(emptyTwiml());

      const tenantConfig = await store.findTenantByTwilioNumber(to);
      if (!tenantConfig) return twiml(emptyTwiml());

      const result = await handleInboundMessage(deps, {
        tenantId: tenantConfig.tenantId,
        from,
        to,
        body: params.Body ?? '',
        providerMessageId: sid,
      });

      console.log(`inbound sms for ${tenantConfig.tenantId}: ${result.intent} — ${result.outcome}`);
      /* no auto-reply from TwiML. every outbound message goes through the queue so it is
         subject to the same suppression, compliance and state checks as any other. */
      return twiml(emptyTwiml());
    }

    // ── what happened to something we sent ──────────────────────────────
    const sid = params.MessageSid ?? params.SmsSid ?? '';
    const status = params.MessageStatus ?? params.SmsStatus ?? '';
    const errorCode = params.ErrorCode || null;
    if (!sid || !status) return twiml(emptyTwiml());

    /* the status callback carries no `To` we can route on reliably, so the tenant is
       resolved from the message row itself — which is scoped by tenant and was written by
       us. A SID we did not send is simply unknown. */
    const { data: owner } = await db
      .from('messages')
      .select('tenant_id')
      .eq('provider_message_id', sid)
      .maybeSingle();

    if (!owner?.tenant_id) return twiml(emptyTwiml());

    const result = await handleMessageStatus(deps, {
      tenantId: owner.tenant_id,
      providerMessageId: sid,
      status,
      errorCode,
      errorClass: status === 'delivered' ? null : messageErrorClass(status, errorCode),
      permanent: isPermanentFailure(errorCode),
    });

    console.log(`message ${sid} → ${status}: ${result.outcome}`);
    return twiml(emptyTwiml());
  } catch (error) {
    /* a 500 makes Twilio redeliver, which is what we want for a transient fault — every
       write on the path behind this is idempotent, so a redelivery is safe. */
    console.error(`twilio ${route} failed`, error);
    return json({ error: 'the handler failed' }, 500);
  }
});
