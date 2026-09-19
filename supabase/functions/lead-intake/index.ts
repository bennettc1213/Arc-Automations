/**
 * POST /functions/v1/lead-intake          a website form submission
 * GET  /functions/v1/lead-intake/embed.js an embeddable snippet that posts to it
 *
 * The second door into the same engine. A form submission and a missed call differ in
 * exactly one place — the two lines that call `intakeLead` with a different `source` — and
 * after that they are the same lead, the same run, the same queue, the same stop-on-reply
 * rule and the same safety pass. There is no website-form workflow, deliberately: the
 * moment there are two engines, a fix to one of them is a bug in the other.
 *
 * What identifies the tenant is a rotatable opaque key (`arcw_…`), not a tenant UUID. It is
 * printed in the client's own HTML, so it is public by construction; what protects the
 * endpoint is the layered set below, and the fact that the only thing a valid request can
 * do is create a lead for the tenant that published the key.
 *
 *   origin allowlist   the key names the origins it may be posted from. empty means refuse,
 *                      not allow-all — an unconfigured key is a key that does not work yet.
 *   honeypot           a field a person never sees and a bot always fills.
 *   dwell time         a form submitted in under a second was not typed.
 *   rate limits        per key and per IP, in-process.
 *   validation         phone, email, ZIP, consent, length caps.
 *
 * Deploy:  supabase functions deploy lead-intake --no-verify-jwt
 *          (--no-verify-jwt: the caller is a member of the public on a contractor's
 *          website. the intake key and the origin allowlist are the gate.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { intakeLead, type EngineDeps } from '../_shared/engine/runtime.ts';
import { classifierFor } from '../_shared/classifier.ts';
import { RecordingSender, TwilioRestSender } from '../_shared/twilio.ts';
import { normaliseEmail, normalisePhone } from '../_shared/phone.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const PUBLIC_BASE = (Deno.env.get('ARC_PUBLIC_FUNCTIONS_URL') ?? `${SUPABASE_URL}/functions/v1`).replace(/\/+$/, '');
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');

const KEY_PATTERN = /^arcw_[a-z0-9]{24,48}$/;

/** A form nobody could have typed this fast. */
const MIN_DWELL_MS = 1200;

/* ── in-process rate limits ──
   Bounds one edge instance rather than the deployment, stated plainly here as it is on the
   other two public functions. It stops a loop and a crude script; the origin allowlist and
   the honeypot are what handle the rest. */
const WINDOW_MS = 60_000;
const PER_KEY = 60;
const PER_IP = 12;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(bucket: string, ceiling: number): boolean {
  const now = Date.now();
  const entry = hits.get(bucket);
  if (!entry || now > entry.resetAt) {
    hits.set(bucket, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ceiling;
}

function corsFor(origin: string | null, allowed: string[]): Record<string, string> {
  /* echoes the one origin that matched rather than `*`, so a browser will not let another
     site read the response even if it somehow reached the endpoint. */
  const match = origin && allowed.includes(origin) ? origin : null;
  return {
    'Access-Control-Allow-Origin': match ?? 'null',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function depsFor(db: ReturnType<typeof createClient>): EngineDeps {
  return {
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
    worker: 'lead-intake',
  };
}

/* ── the embeddable snippet ─────────────────────────────── */

/**
 * The smallest thing that can be pasted into a contractor's site.
 *
 * Renders into `<div data-arc-lead-form></div>`, posts JSON, and carries the honeypot and
 * the dwell timestamp so the server's checks have something to check. It is served from
 * here rather than shipped as a file so the endpoint it posts to can never drift from the
 * endpoint that served it.
 */
function embedScript(publicKey: string): string {
  return `/* Arc Lead Recovery — intake form. Generated for one site; the key is public. */
(function () {
  var ENDPOINT = ${JSON.stringify(`${PUBLIC_BASE}/lead-intake`)};
  var KEY = ${JSON.stringify(publicKey)};
  var mounted = document.querySelectorAll('[data-arc-lead-form]');
  if (!mounted.length) return;

  var CSS = '.arc-lf{display:grid;gap:.65rem;max-width:32rem;font:inherit}'
    + '.arc-lf label{display:grid;gap:.25rem;font-size:.85rem}'
    + '.arc-lf input,.arc-lf textarea{font:inherit;padding:.55rem .65rem;border:1px solid currentColor;border-radius:.25rem;background:transparent;color:inherit}'
    + '.arc-lf textarea{min-height:5rem;resize:vertical}'
    + '.arc-lf button{font:inherit;padding:.6rem 1rem;cursor:pointer}'
    + '.arc-lf .arc-lf__consent{display:flex;gap:.5rem;align-items:flex-start;font-size:.8rem}'
    + '.arc-lf__hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}'
    + '.arc-lf__note{font-size:.85rem}';
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  mounted.forEach(function (host) {
    var renderedAt = Date.now();
    var form = document.createElement('form');
    form.className = 'arc-lf';
    form.noValidate = true;
    form.innerHTML =
      '<label>Your name<input name="name" autocomplete="name" required maxlength="80"></label>' +
      '<label>Mobile number<input name="phone" type="tel" autocomplete="tel" required maxlength="24"></label>' +
      '<label>Email (optional)<input name="email" type="email" autocomplete="email" maxlength="120"></label>' +
      '<label>ZIP code<input name="zip" inputmode="numeric" pattern="[0-9]{5}" required maxlength="5"></label>' +
      '<label>What do you need?<textarea name="message" required maxlength="1000"></textarea></label>' +
      '<div class="arc-lf__hp" aria-hidden="true"><label>Company website<input name="company_website" tabindex="-1" autocomplete="off"></label></div>' +
      '<label class="arc-lf__consent"><input type="checkbox" name="consent" value="yes" required>' +
      '<span>Text me about this enquiry. Message and data rates may apply. Reply STOP to opt out.</span></label>' +
      '<button type="submit">Send</button>' +
      '<p class="arc-lf__note" role="status" aria-live="polite"></p>';

    var note = form.querySelector('.arc-lf__note');
    var button = form.querySelector('button');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;
      button.disabled = true;
      note.textContent = 'Sending…';

      var data = new FormData(form);
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: KEY,
          name: data.get('name'),
          phone: data.get('phone'),
          email: data.get('email'),
          zip: data.get('zip'),
          message: data.get('message'),
          consent: data.get('consent') === 'yes',
          company_website: data.get('company_website'),
          rendered_at: renderedAt,
          page: location.href.slice(0, 300)
        })
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body && result.body.error || 'could not send');
          form.querySelectorAll('input,textarea,button').forEach(function (el) { el.disabled = true; });
          note.textContent = 'Thanks — we have your details and will be in touch shortly.';
        })
        .catch(function (error) {
          button.disabled = false;
          note.textContent = 'Sorry, that did not send. ' + error.message;
        });
    });

    host.appendChild(form);
  });
})();`;
}

/* ── validation ─────────────────────────────────────────── */

interface Submission {
  name: string | null;
  phone: string;
  email: string | null;
  zip: string | null;
  message: string;
  consent: boolean;
  page: string | null;
}

function validateSubmission(body: Record<string, unknown>): { ok: true; value: Submission } | { ok: false; error: string } {
  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.slice(0, max);
  };

  const phone = normalisePhone(body.phone);
  if (!phone) return { ok: false, error: 'a valid mobile number is required' };

  const message = text(body.message, 1000);
  if (!message) return { ok: false, error: 'tell us what you need' };

  const zip = text(body.zip, 5);
  if (zip && !/^[0-9]{5}$/.test(zip)) return { ok: false, error: 'the ZIP code should be five digits' };

  /* consent is required rather than defaulted. a form that texts somebody because the box
     was pre-ticked is the compliance failure this whole module is careful about. */
  if (body.consent !== true) return { ok: false, error: 'please tick the box so we can text you back' };

  const emailRaw = text(body.email, 120);
  if (emailRaw && !normaliseEmail(emailRaw)) return { ok: false, error: 'that email address does not look right' };

  return {
    ok: true,
    value: {
      name: text(body.name, 80),
      phone,
      email: normaliseEmail(emailRaw),
      zip,
      message,
      consent: true,
      page: text(body.page, 300),
    },
  };
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');

  // ── the snippet ──
  if (request.method === 'GET' && url.pathname.endsWith('/embed.js')) {
    const key = url.searchParams.get('key') ?? '';
    if (!KEY_PATTERN.test(key)) return json({ error: 'a valid intake key is required' }, 400);
    return new Response(embedScript(key), {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (request.method === 'OPTIONS') {
    /* the preflight has to answer before the key is known, so it is permissive about
       headers and strict about nothing — the POST itself is where the origin is actually
       checked against the key's allowlist. */
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
      },
    });
  }

  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_PATTERN.test(key)) return json({ error: 'unknown form' }, 400);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (rateLimited(`key:${key}`, PER_KEY) || rateLimited(`ip:${ip}`, PER_IP)) {
    return json({ error: 'too many submissions — try again in a minute' }, 429, { 'Retry-After': '60' });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = depsFor(db);

  const intakeKey = await deps.store.findIntakeKey(key);
  if (!intakeKey) return json({ error: 'unknown form' }, 404);

  const cors = corsFor(origin, intakeKey.allowedOrigins);

  /* an unconfigured allowlist refuses. "no origins yet" is a key mid-onboarding, and
     treating it as allow-all would mean every new key is briefly an open endpoint. */
  if (intakeKey.allowedOrigins.length === 0) {
    return json({ error: 'this form is not finished being set up' }, 403, cors);
  }
  if (!origin || !intakeKey.allowedOrigins.includes(origin)) {
    console.warn(`lead-intake refused origin ${origin ?? '(none)'} for key on tenant ${intakeKey.tenantId}`);
    return json({ error: 'this form cannot be submitted from here' }, 403, cors);
  }

  /* the two silent checks. both answer 200 with the same body a real submission gets: a
     bot that is told it was detected is a bot that gets fixed. */
  const honeypotFilled = typeof body.company_website === 'string' && body.company_website.trim() !== '';
  const renderedAt = typeof body.rendered_at === 'number' ? body.rendered_at : 0;
  const tooFast = renderedAt > 0 && Date.now() - renderedAt < MIN_DWELL_MS;

  if (honeypotFilled || tooFast) {
    console.warn(`lead-intake discarded a submission for ${intakeKey.tenantId} (${honeypotFilled ? 'honeypot' : 'dwell'})`);
    return json({ ok: true, received: true }, 200, cors);
  }

  const validated = validateSubmission(body);
  if (!validated.ok) return json({ error: validated.error }, 400, cors);

  try {
    const result = await intakeLead(deps, {
      tenantId: intakeKey.tenantId,
      source: 'web_form',
      /* stable across a double-click or a retried fetch: the same person, number and words
         within the same minute are one submission. it deliberately does not include the
         message body's full text, so a resend of an identical form is folded rather than
         duplicated. */
      externalRef: `web:${validated.value.phone}:${new Date().toISOString().slice(0, 16)}`,
      phone: validated.value.phone,
      email: validated.value.email,
      customerName: validated.value.name,
      serviceRequest: validated.value.message,
      zip: validated.value.zip,
      locationText: validated.value.page,
      intakeRef: origin,
      consentSms: true,
      consentSource: 'web_form',
    });

    await deps.store.touchIntakeKey(intakeKey.id);

    /* the caller is a member of the public on somebody else's website. they are told it
       arrived and nothing else — not the lead id, not the tenant, not whether the module
       is switched on, not why nothing was sent. */
    console.log(`lead-intake for ${intakeKey.tenantId}: ${result.outcome}`);
    return json({ ok: true, received: true }, 200, cors);
  } catch (error) {
    console.error('lead-intake failed', error);
    return json({ error: 'we could not record that — please call us instead' }, 500, cors);
  }
});
