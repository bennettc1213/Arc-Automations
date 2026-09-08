/**
 * POST /functions/v1/client-login
 *
 * Turns a client ID into a sign-in link, without ever telling the browser where
 * that link was sent.
 *
 *   curl -X POST https://<project>.supabase.co/functions/v1/client-login \
 *     -H "Content-Type: application/json" \
 *     -d '{"client_id":"ARC-4K7P-92QX"}'
 *
 *   -> 200 {"ok":true,"account":"cascade restoration","hint":"o•••@cascade•••.com"}
 *
 * Why this exists at all: a client signs in with an ID, but Supabase mails the
 * link to an address. Resolving one to the other in the browser would mean an
 * endpoint that hands an email address to anyone holding a client ID, so the
 * resolution happens here, under the service role, and only a masked hint comes
 * back — enough for the client to recognise their own mailbox, not enough to be
 * an address-harvesting endpoint.
 *
 * The ID is not a password. It selects the account; the magic link still has to
 * land in a mailbox somebody controls. A leaked ID gets an attacker a sign-in
 * email delivered to the client, which is noise, not access.
 *
 * Deploy:  supabase functions deploy client-login --no-verify-jwt
 *          supabase secrets set ARC_SITE_URL=https://your-site.com
 *
 *          --no-verify-jwt because the caller is by definition signed out. The
 *          rate limiter and the 40-bit ID are the gate.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* where the magic link comes back to. built here rather than taken from the
   request body on purpose: a redirect target a caller can choose is an open
   redirect that mails itself a working session. */
const SITE_URL = (Deno.env.get('ARC_SITE_URL') ?? '').replace(/\/+$/, '');
const REDIRECT_TO = Deno.env.get('ARC_AUTH_REDIRECT') ?? `${SITE_URL}/auth/callback`;

/* the browser calls this from the site's own origin, not from supabase.co. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...headers },
  });
}

/**
 * ARC-XXXX-XXXX, from whatever the client actually typed.
 *
 * People paste the ID out of an email with a trailing space, type it lowercase,
 * and leave out the dashes. All three are the same ID and none of them is worth
 * an error message. O/0 and I/1 are folded because the alphabet excludes the
 * letters — anyone who typed one meant the digit.
 */
function normaliseClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const body = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^ARC/, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/U/g, 'V');

  if (!/^[0-9A-HJ-KM-NP-TV-Z]{8}$/.test(body)) return null;
  return `ARC-${body.slice(0, 4)}-${body.slice(4)}`;
}

/* enough of the address for a client to recognise their own inbox and not enough
   for this endpoint to be worth scraping. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  const [host, ...rest] = domain.split('.');
  const keep = (value: string) => (value.length <= 1 ? value : value[0] + '•••');
  return `${keep(user)}@${keep(host)}.${rest.join('.')}`;
}

/**
 * Per-IP throttle.
 *
 * In-process, so it bounds one edge instance rather than the deployment — stated
 * plainly, because a limiter you believe is global when it is not is worse than
 * none. Against a 40-bit ID space it does not need to be global; it exists so a
 * script cannot turn this endpoint into a mail cannon aimed at one client.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_PER_WINDOW;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });

  const caller =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (rateLimited(caller)) {
    return json({ error: 'too many attempts. wait a minute and try again.' }, 429, {
      'Retry-After': '60',
    });
  }

  let body: { client_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const clientId = normaliseClientId(body.client_id);
  if (!clientId) {
    return json({ error: 'that is not a client id. they look like ARC-4K7P-92QX.' }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error } = await db
    .from('tenants')
    .select('id, name, status, login_email')
    .eq('client_id', clientId)
    .limit(1);

  if (error) return json({ error: 'lookup failed' }, 500);

  /* "unknown id" is said out loud rather than hidden behind a generic response.
     Enumeration is not the threat here — the ID space is 40 bits — and a client
     who fat-fingered one character otherwise sits watching an inbox that is
     never going to receive anything. */
  if (!rows?.length) {
    return json({ error: 'that client id is not recognised.' }, 404);
  }

  const tenant = rows[0] as {
    id: string;
    name: string;
    status: string;
    login_email: string | null;
  };

  if (tenant.status === 'archived') {
    return json({ error: 'that account is closed. get in touch and we will reopen it.' }, 403);
  }

  if (!tenant.login_email) {
    /* the ID exists but onboarding was never finished. saying so is the whole
       point: the alternative is a client staring at "check your email" forever. */
    return json(
      { error: 'that account has no sign-in address attached yet. get in touch.' },
      409,
    );
  }

  const { error: otpError } = await db.auth.signInWithOtp({
    email: tenant.login_email,
    options: { emailRedirectTo: REDIRECT_TO, shouldCreateUser: false },
  });

  if (otpError) {
    /* the most common cause is an address that was never invited into auth, so
       there is no user for shouldCreateUser:false to sign in. */
    return json({ error: 'could not send the sign-in link. get in touch.' }, 502);
  }

  return json(
    { ok: true, account: tenant.name, hint: maskEmail(tenant.login_email) },
    200,
  );
});
