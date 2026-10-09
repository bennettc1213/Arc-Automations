/**
 * POST /functions/v1/ledger   { "action": "outcome-answer" | "outcome-asked", "tenant_id": "...", … }
 *
 * ARC-MK-220 — the owner's own door to the proof ledger, and the portal's first client write.
 *
 *   outcome-answer   { lead, answer, reason?, replaces? }   one tap: did the job happen?
 *   outcome-asked    { leads: [...] }                       the question was shown to them
 *
 * Signed-in users only (a Supabase JWT in the Authorization header — never a cookie). The
 * actor is whoever that token verifies as, asked of Supabase Auth, and their membership of
 * the tenant is read here from `tenant_members`: a body cannot claim a tenant, a role or who
 * answered. A user who is not a member is refused before anything is read. An operator's
 * door is `ops`, not this one.
 *
 * Both actions append one row of evidence to `events` through the engine's own writers and
 * change nothing else — no lead, no run, no queue. Whether the job then counts is read off
 * the log by the ledger's rule; nothing here sets a status. Everything a browser must not
 * decide is in `_shared/ledger/service.ts`.
 *
 * Deploy:  supabase functions deploy ledger
 *          (JWT verification left ON: every caller here is signed in. needs 0010.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clientActor } from '../_shared/crm/actions.ts';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { RecordingSender } from '../_shared/twilio.ts';
import { FakeClassifier } from '../_shared/classifier.ts';
import { answerOutcome, LEDGER_ERROR_STATUS, markAsked, supabaseLedgerReads, type LedgerDeps } from '../_shared/ledger/service.ts';

const ACTIONS = ['outcome-answer', 'outcome-asked'];

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/* the same as `crm`: the bearer token is the credential, so no cookie rides along and any
   origin may ask — what it gets back is decided by whose token it is. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BODY_BYTES = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...CORS },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
  const authorization = request.headers.get('authorization');
  if (!authorization) return json({ error: 'not signed in', code: 'unauthorized' }, 401);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await caller.auth.getUser();
  const userId = who?.user?.id ?? null;
  if (!userId) return json({ error: 'not signed in', code: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'the request is too large' }, 413);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'body is not a JSON object' }, 400);
  }

  const action = String(body.action ?? '');
  if (action === 'capabilities') return json({ ok: true, actions: ACTIONS }, 200);
  if (!ACTIONS.includes(action)) return json({ error: 'unknown action' }, 400);
  if (typeof body.tenant_id !== 'string' || !UUID.test(body.tenant_id)) {
    return json({ error: 'tenant_id is required', code: 'invalid' }, 422);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: membership, error } = await db
    .from('tenant_members')
    .select('role')
    .eq('tenant_id', body.tenant_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return json({ error: 'could not check membership' }, 500);
  /* not a member: the same answer whether or not the tenant exists. */
  const actor = clientActor(userId, body.tenant_id, membership);
  if (!actor) return json({ error: 'this account does not belong to that client', code: 'forbidden' }, 403);

  /* the engine's writers want its whole dependency set. neither action sends or classifies
     anything, so both senders record and the classifier is the fake: there is no object here
     that could reach a customer. */
  const deps: LedgerDeps = {
    engine: {
      store: supabaseStore(db),
      now: () => new Date(),
      liveSender: new RecordingSender(),
      canarySender: new RecordingSender(),
      classifierFor: () => new FakeClassifier(),
      urls: { statusCallback: '', leadInConsole: () => null },
      uuid: () => crypto.randomUUID(),
      worker: 'ledger',
    },
    ...supabaseLedgerReads(db),
  };

  try {
    const outcome =
      action === 'outcome-answer'
        ? await answerOutcome(deps, actor, { tenantId: body.tenant_id, lead: body.lead, input: body })
        : await markAsked(deps, actor, { tenantId: body.tenant_id, leads: body.leads });
    if (!outcome.ok) return json({ error: outcome.message, code: outcome.code }, LEDGER_ERROR_STATUS[outcome.code] ?? 409);
    return json({ ok: true, ...outcome.result }, 200);
  } catch (failure) {
    console.error(`ledger action ${action} failed`, failure);
    return json({ error: 'the answer could not be recorded' }, 500);
  }
});
