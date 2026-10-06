/**
 * ARC-380 — the public door for booking, as a plain function: a request in, a response out.
 *
 *   GET  …/page?key=arcb_…                     the published page the hosted screen draws
 *   GET  …/slots?key=…&type=…&from=YYYY-MM-DD   the times it can offer (`&token=…` instead of
 *                                               a type: the times one appointment could move to)
 *   POST …/book                                 one booking
 *   POST …/manage          { key, token }       the appointment a customer's own link is for
 *   POST …/manage/slots    { key, token, from? } the times it could move to
 *   POST …/manage/change   { key, token, action: cancel | reschedule, starts_at?, reason? }
 *
 * `native-booking/index.ts` is the thin Deno wrapper; everything that decides is here, with no
 * `Deno` and no `jsr:` import, so the suite runs it over real SQL exactly as deployed.
 *
 * What protects it, in order — ARC-350's list, for a time instead of an enquiry:
 *
 *   the key         32 random characters; an unknown, draft or archived one is one 404
 *   the token       a customer's own link: 40 random characters, kept only as a hash, sent
 *                   in a request body and never in an address
 *   the origin      anything that writes is accepted only from ARC's own site, where the
 *                   hosted page lives. no origins configured means refuse, not allow-all.
 *   rate limits     per address and per page in this instance; per page per hour in the
 *                   database (0027), which holds across instances
 *   honeypot/dwell  silent: answered like a real booking
 *   validation      the page's own definition; anything else is ignored or refused
 *   the calendar    0027's guard, under a lock: a time is given to one booking
 *
 * A stranger is told the time they now have, whether the business still has to confirm it,
 * and their own link. Never the lead, the customer record, or whether they were on file.
 */

import { type Limiter, windowLimiter } from '../intake/public.ts';
import { type BookingDeps, manageChange, manageView, publicBookingPage, publicSlots, submitBooking } from './service.ts';

export { windowLimiter };

export interface PublicRequest {
  method: string;
  /** the path after the function's name: `/page`, `/slots`, `/book`, `/manage`, `/manage/change`. */
  route: string;
  query: Record<string, string | undefined>;
  origin: string | null;
  ip: string;
  /** the parsed JSON body, or undefined when there was none or it did not parse. */
  body: unknown;
}

export interface PublicResponse {
  status: number;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export const PUBLIC_LIMITS = Object.freeze({ perIp: 8, perPage: 40, readsPerIp: 120, managePerIp: 20 });

export interface PublicBookingOptions {
  deps: BookingDeps;
  /** the origins the hosted page is served from: ARC's site, and nothing else. */
  allowedOrigins: readonly string[];
  limiter: Limiter;
  log?: (line: string) => void;
}

export function createPublicBooking(options: PublicBookingOptions) {
  const { deps, limiter } = options;
  const allowed = options.allowedOrigins.map((o) => o.replace(/\/+$/, '')).filter(Boolean);
  const log = options.log ?? (() => {});

  /* echoes the one origin that matched, never `*`, so another site cannot read the answer. */
  const cors = (origin: string | null): Record<string, string> => ({
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : 'null',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  const reply = (status: number, body: Record<string, unknown> | null, headers: Record<string, string> = {}): PublicResponse => ({ status, body, headers });
  const busy = (headers: Record<string, string>) => reply(429, { error: 'too many requests — try again in a minute' }, { ...headers, 'Retry-After': '60' });

  return async function handle(request: PublicRequest): Promise<PublicResponse> {
    const headers = cors(request.origin);
    if (request.method === 'OPTIONS') return reply(204, null, headers);

    /* ── read: the page, and its times ── */
    if (request.route === '/page' || request.route === '/slots') {
      if (request.method !== 'GET') return reply(405, { error: 'use GET' }, headers);
      if (limiter.over(`read:${request.ip}`, PUBLIC_LIMITS.readsPerIp)) return busy(headers);
      if (request.route === '/page') {
        const page = await publicBookingPage(deps, request.query.key);
        if (!page) return reply(404, { error: 'unknown booking page' }, headers);
        return reply(200, { ok: true, page }, { ...headers, 'Cache-Control': 'public, max-age=60' });
      }
      const availability = await publicSlots(deps, request.query.key, { type: request.query.type, from: request.query.from, days: request.query.days });
      if (!availability) return reply(404, { error: 'unknown booking page' }, headers);
      /* never cached: a time somebody just took must not be offered from a copy. */
      return reply(200, { ok: true, availability }, { ...headers, 'Cache-Control': 'no-store' });
    }

    if (!['/book', '/manage', '/manage/slots', '/manage/change'].includes(request.route)) return reply(404, { error: 'not found' }, headers);
    if (request.method !== 'POST') return reply(405, { error: 'use POST' }, headers);
    /* an unconfigured site origin refuses. treating "none yet" as allow-all would make every
       new deployment briefly an open endpoint. */
    if (!request.origin || !allowed.includes(request.origin)) {
      log(`native-booking refused origin ${request.origin ?? '(none)'}`);
      return reply(403, { error: 'this page cannot be used from here' }, headers);
    }
    if (request.body === undefined || request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return reply(400, { error: 'the body is not valid JSON' }, headers);
    }
    const body = request.body as Record<string, unknown>;
    const bucket = typeof body.key === 'string' ? body.key.slice(0, 40) : 'none';

    /* ── one booking ── */
    if (request.route === '/book') {
      if (limiter.over(`ip:${request.ip}`, PUBLIC_LIMITS.perIp) || limiter.over(`page:${bucket}`, PUBLIC_LIMITS.perPage)) return busy(headers);
      const outcome = await submitBooking(deps, body.key, body);
      if (!outcome.ok) {
        if (outcome.code === 'not_found') return reply(404, { error: 'unknown booking page' }, headers);
        if (outcome.code === 'rate_limited') return reply(429, { error: outcome.message }, { ...headers, 'Retry-After': '600' });
        if (outcome.code === 'slot_unavailable') return reply(409, { error: outcome.message, code: 'slot_unavailable' }, headers);
        return reply(422, { error: outcome.message, code: outcome.code, field_errors: outcome.fieldErrors ?? [] }, headers);
      }
      log(`native-booking for ${outcome.tenantId}: ${outcome.discarded ? `discarded (${outcome.discarded})` : `${outcome.outcome} ${outcome.booking.status}`}`);
      return reply(200, { ok: true, booking: outcome.booking }, { ...headers, 'Cache-Control': 'no-store' });
    }

    /* ── a customer's own link ── */
    if (limiter.over(`manage:${request.ip}`, PUBLIC_LIMITS.managePerIp)) return busy(headers);
    const privately = { ...headers, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (request.route === '/manage') {
      const view = await manageView(deps, body.key, body.token);
      /* a wrong link, a mistyped one and a made-up one are the same answer. */
      if (!view) return reply(404, { error: 'unknown link' }, privately);
      return reply(200, { ok: true, appointment: view }, privately);
    }
    if (request.route === '/manage/slots') {
      const availability = await publicSlots(deps, body.key, { token: body.token, from: body.from, days: body.days });
      if (!availability) return reply(404, { error: 'unknown link' }, privately);
      return reply(200, { ok: true, availability }, privately);
    }
    const outcome = await manageChange(deps, body.key, body.token, body);
    if (!outcome.ok) {
      if (outcome.code === 'not_found') return reply(404, { error: 'unknown link' }, privately);
      return reply(outcome.code === 'invalid' ? 422 : 409, { error: outcome.message, code: outcome.code }, privately);
    }
    log(`native-booking manage for ${outcome.tenantId}: ${String(body.action)}`);
    return reply(200, { ok: true, appointment: outcome.view }, privately);
  };
}
