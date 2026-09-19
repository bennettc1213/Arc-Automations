/**
 * Twilio, reduced to the four things this module needs: prove a request came from them,
 * answer a call with TwiML, send a message, and read a status callback.
 *
 * No SDK. The Twilio helper library is a large dependency for one HMAC and two form posts,
 * and keeping it out means this file is importable by the test runner, which is where the
 * signature check is actually verified against Twilio's published example.
 *
 * The credential model, stated once because it is the thing most often got wrong:
 *
 *   - the account SID and auth token are **global secrets** on the edge function. They are
 *     Arc's, one pair, and they never appear in configuration, in a database row, in an
 *     event or in a response body.
 *   - a tenant's subaccount SID, messaging service SID and phone number are **non-secret
 *     identifiers**. They live in `module_configs.config.twilio` and are how a webhook is
 *     resolved to a tenant. Knowing them grants nothing.
 *
 * Every inbound webhook is signature-checked before its body is read for anything except
 * the signature. An unsigned request is rejected with 403 and nothing is written.
 */

/* ── signature verification ─────────────────────────────── */

const encoder = new TextEncoder();

async function hmacSha1(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  /* base64 without Buffer, so this runs unchanged in Deno and in the test runner. */
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Constant-time string comparison.
 *
 * Worth doing even though the practical attack is remote: `a === b` on a signature leaks
 * how many leading characters were right, and there is no reason to hand that out when the
 * alternative is four lines.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The scheme Twilio actually uses: the full request URL, then every POST parameter
 * appended as key+value in **lexicographic order by key**, HMAC-SHA1 with the auth token,
 * base64.
 *
 * The URL has to be the one Twilio called, character for character, including the query
 * string — which is why the webhook passes an explicitly configured public base URL rather
 * than reconstructing one from headers. A proxy that rewrites the host silently breaks
 * every signature, and "silently" is the word that matters: the requests still arrive.
 */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const sorted = Object.keys(params).sort();
  let payload = url;
  for (const key of sorted) payload += key + params[key];
  return hmacSha1(authToken, payload);
}

export async function verifyTwilioSignature(args: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  header: string | null;
}): Promise<{ ok: boolean; reason: string | null }> {
  if (!args.authToken) return { ok: false, reason: 'no Twilio auth token is configured on this function' };
  if (!args.header) return { ok: false, reason: 'no X-Twilio-Signature header' };
  const expected = await twilioSignature(args.authToken, args.url, args.params);
  return safeEqual(expected, args.header)
    ? { ok: true, reason: null }
    : { ok: false, reason: 'signature does not match' };
}

/** Form-encoded body → a flat record. Twilio posts `application/x-www-form-urlencoded`. */
export function formToParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) params[key] = value;
  return params;
}

/* ── TwiML ──────────────────────────────────────────────── */

/** XML escaping. A caller name carrying an ampersand must not produce malformed TwiML. */
export function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Forward the call, and ask to be told how it went.
 *
 * `answerOnBridge` matters: without it Twilio answers the inbound leg immediately and the
 * caller hears silence instead of ringing, and every call then reports as "answered"
 * whatever the contractor's phone did. With it, the caller hears the real ringing and the
 * dial result is the real result — which is the fact this entire module hangs off.
 *
 * `action` is what makes a missed call detectable at all. Without it, an unanswered call
 * simply ends.
 */
export function dialTwiml(args: {
  destination: string;
  timeoutSeconds: number;
  actionUrl: string;
  callerId?: string | null;
}): string {
  const callerId = args.callerId ? ` callerId="${xmlEscape(args.callerId)}"` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Dial answerOnBridge="true" timeout="${Math.max(5, Math.min(120, Math.round(args.timeoutSeconds)))}"`
      + ` action="${xmlEscape(args.actionUrl)}" method="POST"${callerId}>`,
    `    <Number>${xmlEscape(args.destination)}</Number>`,
    '  </Dial>',
    '</Response>',
  ].join('\n');
}

/** Nothing to say. Returned to every callback Twilio does not need an instruction from. */
export function emptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>';
}

/**
 * The call could not be routed — no config, or a tenant switched off.
 *
 * Says one plain sentence and hangs up rather than failing silently. A caller who reaches a
 * misconfigured number should hear something; a dead line is indistinguishable from the
 * business being gone.
 */
export function sayAndHangupTwiml(message: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say voice="alice">${xmlEscape(message)}</Say>`,
    '  <Hangup/>',
    '</Response>',
  ].join('\n');
}

/* ── dial results ───────────────────────────────────────── */

/**
 * The four DialCallStatus values that mean nobody picked up.
 *
 * `completed` is the one that is *not* here, and the distinction is the whole feature: a
 * completed call was answered by a human and needs no recovery text. Sending one anyway —
 * "sorry we missed you" to somebody who just spoke to you — is worse than sending nothing.
 */
export const MISSED_DIAL_STATUSES = ['no-answer', 'busy', 'failed', 'canceled'] as const;

export function isMissedCall(dialCallStatus: string | null | undefined): boolean {
  return (MISSED_DIAL_STATUSES as readonly string[]).includes(String(dialCallStatus ?? '').toLowerCase());
}

/* ── message status ─────────────────────────────────────── */

/** Twilio's message states, mapped onto the eight-value error vocabulary the log uses. */
export function messageErrorClass(status: string, errorCode: string | null): string {
  const code = Number(errorCode ?? 0);
  /* 21610: the recipient has replied STOP. that is a suppression, not an outage, and
     classifying it as a delivery failure would make an honoured opt-out look like a broken
     pipeline on the reliability page. */
  if (code === 21610) return 'config';
  if (code === 20003 || code === 20429) return code === 20003 ? 'auth' : 'rate_limit';
  if (code === 21606 || code === 21612 || code === 21408) return 'config';
  /* 30034 / 30038: unregistered or pending A2P campaign. a compliance problem, not a
     carrier one, and the operator needs to be told which. */
  if (code === 30034 || code === 30038) return 'config';
  if (status === 'undelivered' || status === 'failed') return 'delivery';
  return 'unknown';
}

/** Is this a failure worth retrying, or one that will fail identically forever? */
export function isPermanentFailure(errorCode: string | null): boolean {
  const code = Number(errorCode ?? 0);
  return [
    21211, // invalid 'To' number
    21610, // recipient has opted out
    21614, // not a mobile number
    21606, // 'From' is not a valid, SMS-capable number on this account
    21612, // cannot route to this number
    30003, // unreachable handset
    30005, // unknown destination
    30006, // landline or unreachable carrier
    30034, // A2P campaign not registered
  ].includes(code);
}

/* ── sending ────────────────────────────────────────────── */

export interface SendResult {
  ok: boolean;
  sid: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  permanent: boolean;
  ms: number;
}

export interface TwilioSender {
  send(args: {
    to: string;
    body: string;
    messagingServiceSid?: string | null;
    from?: string | null;
    statusCallback?: string | null;
  }): Promise<SendResult>;
}

/**
 * The real sender.
 *
 * Posts to the Messages resource with basic auth. `MessagingServiceSid` is preferred over
 * a bare `From` because it is what carries the A2P campaign registration — sending from a
 * naked number on a registered brand is how a shop's messages start getting filtered
 * without anything reporting an error.
 */
export class TwilioRestSender implements TwilioSender {
  /* fields declared and assigned rather than written as constructor parameter properties:
     that shorthand is not erasable TypeScript, and this file is imported directly by the
     test runner, which strips types without compiling them. */
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(accountSid: string, authToken: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(args: {
    to: string;
    body: string;
    messagingServiceSid?: string | null;
    from?: string | null;
    statusCallback?: string | null;
  }): Promise<SendResult> {
    const started = Date.now();
    const form = new URLSearchParams();
    form.set('To', args.to);
    form.set('Body', args.body);
    if (args.messagingServiceSid) form.set('MessagingServiceSid', args.messagingServiceSid);
    else if (args.from) form.set('From', args.from);
    if (args.statusCallback) form.set('StatusCallback', args.statusCallback);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );

      const ms = Date.now() - started;
      const body = (await response.json().catch(() => ({}))) as {
        sid?: string;
        status?: string;
        code?: number;
        message?: string;
      };

      if (!response.ok) {
        const code = body.code ? String(body.code) : String(response.status);
        return {
          ok: false,
          sid: null,
          status: null,
          errorCode: code,
          /* the provider's words, truncated. never the request, which carries the body. */
          errorMessage: (body.message ?? `Twilio answered ${response.status}`).slice(0, 300),
          permanent: isPermanentFailure(code) || response.status === 400,
          ms,
        };
      }

      return {
        ok: true,
        sid: body.sid ?? null,
        status: body.status ?? 'queued',
        errorCode: null,
        errorMessage: null,
        permanent: false,
        ms,
      };
    } catch (error) {
      const ms = Date.now() - started;
      return {
        ok: false,
        sid: null,
        status: null,
        errorCode: null,
        errorMessage: controller.signal.aborted ? `no answer in ${this.timeoutMs / 1000}s` : (error as Error)?.message ?? 'request failed',
        permanent: false,
        ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The sender used by tests, by dry runs and by every canary.
 *
 * It records what *would* have been sent and returns a synthetic SID. The dispatcher
 * selects it — rather than merely skipping the send — whenever the lead is a canary, so a
 * synthetic run exercises the entire code path including the message row and the event,
 * and still cannot reach a handset.
 */
export class RecordingSender implements TwilioSender {
  readonly sent: { to: string; body: string; messagingServiceSid?: string | null; from?: string | null }[] = [];

  private readonly outcome: Partial<SendResult>;

  constructor(outcome: Partial<SendResult> = {}) {
    this.outcome = outcome;
  }

  // deno-lint-ignore require-await
  async send(args: { to: string; body: string; messagingServiceSid?: string | null; from?: string | null }): Promise<SendResult> {
    this.sent.push(args);
    return {
      ok: true,
      sid: `SMtest${String(this.sent.length).padStart(26, '0')}`,
      status: 'queued',
      errorCode: null,
      errorMessage: null,
      permanent: false,
      ms: 0,
      ...this.outcome,
    };
  }
}
