/**
 * POST /functions/v1/ingest
 *
 * The only write path into `events`. n8n posts here with a per-tenant bearer token instead
 * of holding a Supabase service_role key, so a compromised n8n can write events for one
 * tenant rather than read and rewrite the whole database. The token is also rotatable
 * without touching Supabase.
 *
 *   curl -X POST https://<project>.supabase.co/functions/v1/ingest \
 *     -H "Authorization: Bearer arc_..." \
 *     -H "Content-Type: application/json" \
 *     -d '{"event_type":"lead_received","occurred_at":"2026-09-03T14:00:00Z"}'
 *
 * Deploy:  supabase functions deploy ingest --no-verify-jwt
 *          (--no-verify-jwt because this endpoint authenticates with its own per-tenant
 *          bearer token, not a Supabase user JWT. The token check below is the gate.)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { validateBody } from './validate.ts';
import { supabaseEventSink, writeEvents } from '../_shared/event-writer.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Per-token throttle.
 *
 * In-process only, so it bounds a single edge instance rather than the whole deployment.
 * Stated plainly because a limiter you believe is global when it is not is worse than none.
 * It exists to stop a looping n8n workflow, not a determined attacker; the bearer token is
 * what does that job.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 600;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(tokenHash: string): boolean {
  const now = Date.now();
  const entry = hits.get(tokenHash);

  if (!entry || now > entry.resetAt) {
    hits.set(tokenHash, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_PER_WINDOW;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'use POST' }, 405, { Allow: 'POST' });
  }

  const raw = bearerToken(request);
  if (!raw) return json({ error: 'missing bearer token' }, 401);

  const tokenHash = await hashToken(raw);
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* looked up by hash, so the raw token is never stored and a database read cannot be
     replayed as write access to the pipeline. */
  const { data: tokenRows, error: tokenError } = await db
    .from('ingest_tokens')
    .select('id, tenant_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .limit(1);

  if (tokenError) return json({ error: 'token lookup failed' }, 500);
  if (!tokenRows?.length) {
    /* same response for an unknown token and a revoked one: distinguishing them tells a
       caller which guesses were once valid. */
    return json({ error: 'invalid token' }, 401);
  }

  const { id: tokenId, tenant_id: tenantId } = tokenRows[0] as {
    id: string;
    tenant_id: string;
  };

  if (rateLimited(tokenHash)) {
    return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return json({ error: 'validation failed', details: validation.errors }, 400);
  }

  /* idempotency, and the write itself, both live in ../_shared/event-writer.ts. They moved
     there when the Lead Recovery engine started emitting events of its own: this endpoint
     and Arc's own functions must deduplicate the same way, or a retried Twilio callback
     counts as a second text sent to a customer. */
  const sink = supabaseEventSink(db);
  const result = await writeEvents(sink, tenantId, validation.events);
  if (result.error) return json({ error: 'insert failed', details: result.error }, 500);

  // fire and forget: a failed bookkeeping update must not fail the ingest.
  db.from('ingest_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenId)
    .then(() => {});

  return json({ accepted: result.accepted, written: result.written, duplicates: result.duplicates }, 202);
});
