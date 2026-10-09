/**
 * The `twilio` function's four webhooks, apart from Deno.serve so node can test them
 * (index.ts imports supabase-js from jsr:, which node cannot load) — ARC-GO-320.
 *
 * Nothing about what the door does changed in the move. What changed is that the safety
 * test pass can now post a signed request at it and read what comes back, on real SQL:
 * the gate before the body is used, the tenant taken from the number that was called, and
 * a redelivered webhook making one lead, one message, one event.
 *
 * One rule runs before any of the four: **verify the signature**. An unsigned or
 * wrongly-signed request is answered 403, and the door is never opened for it — `open()`
 * is what builds the database client and the senders, so a forged request reaches neither.
 *
 * Tenant routing is one rule and one rule only: **the number that was called owns the
 * request**. There is no tenant id in the URL, no subaccount in a header and no query
 * parameter, because every one of those is something a caller could change.
 */

import {
  handleInboundMessage,
  handleMessageStatus,
  intakeLead,
  loadConfig,
  recordAnsweredCall,
  shouldRecoverCall,
} from '../_shared/engine/runtime.ts';
import type { EngineDeps } from '../_shared/engine/runtime.ts';
import {
  emptyTwiml,
  formToParams,
  messageErrorClass,
  isPermanentFailure,
  sayAndHangupTwiml,
  verifyTwilioSignature,
  voiceResponse,
} from '../_shared/twilio.ts';
import { normalisePhone } from '../_shared/phone.ts';

export const TWILIO_ROUTES = ['voice', 'dial-status', 'sms', 'message-status'] as const;

/** What a signed request is allowed to reach. Built by `open()`, never before the gate. */
export interface TwilioDoorway {
  deps: EngineDeps;
  /**
   * Which client sent this message, read off ARC's own `messages` row. A status callback
   * carries no `To` to route on reliably, and a SID ARC did not send is simply unknown.
   */
  messageTenant(providerMessageId: string): Promise<string | null>;
}

export interface TwilioDoor {
  /** Arc's Twilio auth token. Empty means every request is refused. */
  authToken: string;
  /**
   * The public base for these functions, as Twilio sees it — configured, never rebuilt from
   * the request. A signature is computed over the exact URL Twilio called, and `request.url`
   * behind a proxy that rewrote the host is a different string.
   */
  publicBase: string;
  open(): TwilioDoorway;
}

export interface TwilioRequest {
  method: string;
  /** the request's own url: only its last path segment and its query string are used. */
  url: string;
  body: string;
  /** the X-Twilio-Signature header. */
  signature: string | null;
}

export interface TwilioAnswer {
  status: number;
  contentType: string;
  body: string;
}

function twiml(body: string, status = 200): TwilioAnswer {
  return { status, contentType: 'text/xml; charset=utf-8', body };
}

function json(body: unknown, status: number): TwilioAnswer {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

/** The one read the door makes itself: the tenant a message ARC sent belongs to. */
export function messageTenantFrom(db: Db): TwilioDoorway['messageTenant'] {
  return async (providerMessageId) => {
    const { data: owner } = await db
      .from('messages')
      .select('tenant_id')
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    return owner?.tenant_id ?? null;
  };
}

export async function handleTwilioWebhook(door: TwilioDoor, request: TwilioRequest): Promise<TwilioAnswer> {
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);

  const url = new URL(request.url);
  /* the last path segment, so the function works whether it is mounted at
     /functions/v1/twilio/voice or behind a rewrite. */
  const route = url.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!(TWILIO_ROUTES as readonly string[]).includes(route)) {
    return json({ error: `unknown route "${route}". Expected one of ${TWILIO_ROUTES.join(', ')}` }, 404);
  }

  const params = formToParams(request.body);

  /* ── the gate ──
     Before anything else, and over the URL we were configured with rather than the one the
     request claims. A failure here is 403 with no detail beyond the reason: a forger does
     not need help. */
  const signedUrl = `${door.publicBase}/twilio/${route}${url.search}`;
  const signature = await verifyTwilioSignature({
    authToken: door.authToken,
    url: signedUrl,
    params,
    header: request.signature,
  });

  if (!signature.ok) {
    console.warn(`twilio webhook rejected on ${route}: ${signature.reason}`);
    return json({ error: 'invalid signature' }, 403);
  }

  const { deps, messageTenant } = door.open();
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
         switching a client's module off must never stop their calls reaching them.
         the dial-status callback is tied to this call by the CallSid in Twilio's own body. */
      const config = loaded.loaded.config;
      const answer = voiceResponse(config, { dialStatus: `${door.publicBase}/twilio/dial-status` });

      /* ARC-GO-310: where the business keeps its own number, a call only reaches ARC once
         nobody there has answered it. it is the missed call, so the lead is recorded now —
         keyed on the CallSid, like the other setup's. the caller gets their one sentence
         whatever happens here: a failed write is logged, never spoken as an error. */
      if (answer.missed) {
        const caller = normalisePhone(params.From ?? params.Caller);
        const callSid = params.CallSid ?? '';
        if (callSid) {
          try {
            const result = await intakeLead(deps, {
              tenantId: tenantConfig.tenantId,
              source: 'missed_call',
              externalRef: callSid,
              phone: caller,
              customerName: null,
              intakeRef: called,
              consentSms: true,
              consentSource: 'inbound_call',
            });
            console.log(`voice (forwarded unanswered) for ${tenantConfig.tenantId}: ${result.outcome}`);
          } catch (error) {
            console.error(`voice: the forwarded call for ${tenantConfig.tenantId} was not recorded`, error);
          }
        }
      }
      return twiml(answer.twiml);
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

      /* a dial result only exists where ARC rang the business. a client whose own phone
         company forwards the unanswered calls has its lead from the voice webhook, and a
         stray callback for that number is nothing. */
      const dialled = await loadConfig(store, tenantConfig.tenantId);
      if (dialled.ok && dialled.loaded.config.forwarding.mode === 'business_first') return twiml(emptyTwiml());

      /* the branch the whole module hangs off. an answered call produces no lead, no run and
         no text — only a count (ARC-MK-210), so the ledger can say how many calls the
         business picked up itself. `completed` is the one status that means a person
         answered; anything else unrecognised is recorded as nothing. the count must never
         cost a call its 200, so a failed write is logged and swallowed. */
      if (!shouldRecoverCall(dialStatus)) {
        if (dialStatus.toLowerCase() === 'completed') {
          try {
            await recordAnsweredCall(deps, { tenantId: tenantConfig.tenantId, callSid });
          } catch (error) {
            console.error(`dial-status: answered call for ${tenantConfig.tenantId} was not counted`, error);
          }
        }
        return twiml(emptyTwiml());
      }

      const result = await intakeLead(deps, {
        tenantId: tenantConfig.tenantId,
        source: 'missed_call',
        /* the CallSid is the same on every redelivery of this callback, which is what makes
           a duplicate webhook produce one lead. */
        externalRef: callSid,
        phone: caller,
        /* the network's caller name is not used as the customer's (ARC-GO-310): where it is
           supplied it is often a carrier label or a town, and it would open the text. */
        customerName: null,
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
    const tenantId = await messageTenant(sid);
    if (!tenantId) return twiml(emptyTwiml());

    const result = await handleMessageStatus(deps, {
      tenantId,
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
}
