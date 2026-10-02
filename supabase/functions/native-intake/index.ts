/**
 * GET  /functions/v1/native-intake/form?key=arcf_…   the form the hosted page draws
 * POST /functions/v1/native-intake/submit            a submission of it
 * POST /functions/v1/native-intake/hook              a lead from a client's own system
 *
 * ARC-350's public door into the CRM (0023, 0024). Not Lead Recovery's `lead-intake`: that
 * one starts a conversation; this one records a lead and stops. Everything that decides is
 * in `_shared/intake/public.ts` — this file only reads the request and the environment.
 *
 * Deploy:  supabase functions deploy native-intake --no-verify-jwt
 *          (--no-verify-jwt: the callers are a member of the public on a form, and a
 *          client's system holding an endpoint token. the form key, the origin check and
 *          the token are the gates.)
 *          supabase secrets set ARC_SITE_URL=https://arcautomation.site
 *          (required: a submission is accepted only from this origin. ARC_FORM_ORIGINS is
 *          an optional comma-separated list of further origins, for a preview deployment.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseCrmStore } from '../_shared/crm/supabase-crm-store.ts';
import { supabaseIntakeStore } from '../_shared/intake/supabase-intake-store.ts';
import { createPublicIntake, windowLimiter } from '../_shared/intake/public.ts';

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

/** larger than any form or lead ARC accepts; smaller than anything worth sending to waste time. */
const MAX_BODY_BYTES = 64_000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const handle = createPublicIntake({
  deps: { crm: supabaseCrmStore(db), intake: supabaseIntakeStore(db) },
  allowedOrigins: ALLOWED_ORIGINS,
  limiter: windowLimiter(60_000),
  log: (line) => console.log(line),
});

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^.*\/native-intake/, '') || '/';

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
      authorization: request.headers.get('authorization'),
      idempotencyKey: request.headers.get('idempotency-key'),
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
      body,
    });
    return new Response(response.body === null ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { ...(response.body === null ? {} : { 'Content-Type': 'application/json' }), ...response.headers },
    });
  } catch (error) {
    console.error('native-intake failed', error);
    return new Response(JSON.stringify({ error: 'we could not record that — please call instead' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
