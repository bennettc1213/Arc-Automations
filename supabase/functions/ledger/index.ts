/**
 * POST /functions/v1/ledger   { "action": "outcome-answer" | "outcome-asked" | "visit-booked", "tenant_id": "...", … }
 *
 * ARC-MK-220 — the owner's own door to the proof ledger, and the portal's first client write.
 *
 *   outcome-answer   { lead, answer, reason?, replaces? }   one tap: did the job happen?
 *   outcome-asked    { leads: [...] }                       the question was shown to them
 *   visit-booked     { lead, appointment_at }               they agreed a visit, and when it is
 *
 * Signed-in users only (a Supabase JWT in the Authorization header — never a cookie). The
 * actor is whoever that token verifies as, asked of Supabase Auth, and their membership of
 * the tenant is read from `tenant_members` (`handler.ts`): a body cannot claim a tenant, a
 * role or who answered. A user who is not a member is refused before anything is read. An
 * operator's door is `ops`, not this one.
 *
 * The first two append one row of evidence to `events` through the engine's own writers and
 * change nothing else — no lead, no run, no queue. The third (ARC-GO-310) is the engine's own
 * booking: it stops the automation on that lead and records the visit time. Whether the job then counts is read off
 * the log by the ledger's rule; nothing here sets a status. Everything a browser must not
 * decide is in `_shared/ledger/service.ts`.
 *
 * Deploy:  supabase functions deploy ledger
 *          (JWT verification left ON: every caller here is signed in. needs 0010.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { supabaseStore } from '../_shared/supabase-store.ts';
import { RecordingSender } from '../_shared/twilio.ts';
import { FakeClassifier } from '../_shared/classifier.ts';
import { supabaseLedgerReads } from '../_shared/ledger/service.ts';
import { handleLedgerAction, membershipFrom } from './handler.ts';

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

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const answer = await handleLedgerAction(
    {
      userId,
      membership: membershipFrom(db),
      /* the engine's writers want its whole dependency set. no action here sends or
         classifies anything, so both senders record and the classifier is the fake: there is
         no object here that could reach a customer. */
      deps: () => ({
        engine: {
          store: supabaseStore(db),
          now: () => new Date(),
          liveSender: new RecordingSender(),
          canarySender: new RecordingSender(),
          classifierFor: () => new FakeClassifier(),
          urls: { statusCallback: '', ownerNeedsYou: () => null },
          uuid: () => crypto.randomUUID(),
          worker: 'ledger',
        },
        ...supabaseLedgerReads(db),
      }),
    },
    await request.text(),
  );
  return json(answer.body, answer.status);
});
