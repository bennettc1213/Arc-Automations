/**
 * GET  /functions/v1/native-booking/page?key=arcb_…    the page the hosted screen draws
 * GET  /functions/v1/native-booking/slots?key=…&type=… the times it can offer
 * POST /functions/v1/native-booking/book               one booking
 * POST /functions/v1/native-booking/manage             the appointment a customer's link is for
 * POST /functions/v1/native-booking/manage/slots       the times it could move to
 * POST /functions/v1/native-booking/manage/change      move or cancel it
 *
 * ARC-380's public door (0027). A member of the public books a time with the business that
 * published the page, and can move or cancel it from the link they were given. Everything
 * that decides is in `_shared/booking/public.ts` — this file only reads the request and the
 * environment. Nothing here sends a message or starts an automation.
 *
 * Deploy:  supabase functions deploy native-booking --no-verify-jwt
 *          (--no-verify-jwt: the caller is a member of the public. the page key, the origin
 *          check and a customer's own token are the gates.)
 *          It reads the same two secrets `native-intake` does: ARC_SITE_URL (the origin the
 *          hosted pages are served from) and the optional comma-separated ARC_FORM_ORIGINS.
 *          With neither set, every booking is refused.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseCrmStore } from '../_shared/crm/supabase-crm-store.ts';
import { supabaseBookingStore } from '../_shared/booking/supabase-booking-store.ts';
import { createPublicBooking, windowLimiter } from '../_shared/booking/public.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const originOf = (value: string): string | null => {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
};
const ALLOWED_ORIGINS = [Deno.env.get('ARC_SITE_URL') ?? '', ...(Deno.env.get('ARC_FORM_ORIGINS') ?? '').split(',')]
  .map(originOf)
  .filter((origin): origin is string => origin !== null);

/** larger than any booking ARC accepts; smaller than anything worth sending to waste time. */
const MAX_BODY_BYTES = 16_000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const handle = createPublicBooking({
  deps: { crm: supabaseCrmStore(db), booking: supabaseBookingStore(db) },
  allowedOrigins: ALLOWED_ORIGINS,
  limiter: windowLimiter(60_000),
  log: (line) => console.log(line),
});

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^.*\/native-booking/, '').replace(/\/+$/, '') || '/';

  let body: unknown;
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'the request is too large' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
    }
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  try {
    const response = await handle({
      method: request.method,
      route,
      query: Object.fromEntries(url.searchParams),
      origin: request.headers.get('origin'),
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
      body,
    });
    return new Response(response.body === null ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { ...(response.body === null ? {} : { 'Content-Type': 'application/json' }), ...response.headers },
    });
  } catch (error) {
    console.error('native-booking failed', error);
    return new Response(JSON.stringify({ error: 'we could not take that booking — please call instead' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
