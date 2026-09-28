/**
 * ARC-220 — `runner-bridge`: where a shared n8n workflow reaches ARC.
 *
 *   POST …/functions/v1/runner-bridge/envelope   fetch the envelope for a dispatched job
 *   POST …/functions/v1/runner-bridge/callback   report an attempt's outcome
 *
 * Deployed with `--no-verify-jwt`: the caller is n8n, not a signed-in user, and the gate is
 * an HMAC over the raw body (ADR ARC-010 §18, §24), verified in `_shared/n8n-runner/inbound.ts`
 * before a byte is parsed, with a single-use nonce and a five-minute window.
 *
 * **Disabled in production** (ADR §26): with `ARC_ENVIRONMENT` production — or unset —
 * every request is answered 503 before anything else is read.
 *
 * Environment:
 *   ARC_ENVIRONMENT               production | staging | development | test. Unset = production.
 *   ARC_RUNNER_CALLBACK_SECRET    the HMAC secret the workflows sign with. ≥ 32 characters.
 *
 * Holds the service-role key to call 0018's and 0017's service-role functions. Never a
 * tenant credential: there is none to hold, and nothing here could hand one out.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolveRuntimeEnvironment } from '../_shared/connections/runtime-env.ts';
import { SecretValue } from '../_shared/connections/redact.ts';
import { supabaseSchedulerStore } from '../_shared/scheduler/supabase-scheduler-store.ts';
import { supabaseBridgeStore } from '../_shared/n8n-runner/supabase-bridge-store.ts';
import { handleCallback, handleEnvelopeRequest } from '../_shared/n8n-runner/inbound.ts';
import { BRIDGE_HEADERS } from '../_shared/n8n-runner/signing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ENVIRONMENT = resolveRuntimeEnvironment(Deno.env.get('ARC_ENVIRONMENT'));
const CALLBACK_SECRET = new SecretValue(Deno.env.get('ARC_RUNNER_CALLBACK_SECRET') ?? '');

/** A callback is small; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (route !== 'envelope' && route !== 'callback') return json(404, { error: 'not_found' });
  if (ENVIRONMENT === 'production') return json(503, { error: 'bridge_disabled' });
  if (CALLBACK_SECRET.reveal().length < 32) return json(503, { error: 'bridge_unconfigured' });

  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const deps = {
    environment: ENVIRONMENT,
    callbackSecret: CALLBACK_SECRET,
    bridge: supabaseBridgeStore(db),
    scheduler: supabaseSchedulerStore(db),
  };
  const input = {
    rawBody,
    headers: {
      [BRIDGE_HEADERS.timestamp]: req.headers.get(BRIDGE_HEADERS.timestamp),
      [BRIDGE_HEADERS.nonce]: req.headers.get(BRIDGE_HEADERS.nonce),
      [BRIDGE_HEADERS.signature]: req.headers.get(BRIDGE_HEADERS.signature),
    },
  };

  try {
    const out = route === 'envelope' ? await handleEnvelopeRequest(deps, input) : await handleCallback(deps, input);
    return json(out.status, out.body);
  } catch {
    // nothing about the failure is echoed: the bridge log has what a person needs.
    return json(500, { error: 'bridge_error' });
  }
});
