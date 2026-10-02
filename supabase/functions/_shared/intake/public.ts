/**
 * ARC-350 — the public door, as a plain function: a request in, a response out.
 *
 *   GET  …/form?key=arcf_…   the published form the hosted page draws
 *   POST …/submit            one submission of it
 *   POST …/hook              a lead from the client's own system, with a bearer token
 *
 * `native-intake/index.ts` is the thin Deno wrapper; everything that decides is here, with
 * no `Deno` and no `jsr:` import, so the suite runs it over real SQL exactly as deployed.
 *
 * What protects the two unauthenticated routes, in order:
 *
 *   the key         32 random characters; an unknown, draft or archived one is one 404
 *   the origin      a submission is accepted only from ARC's own site, where the hosted
 *                   form lives. no origins configured means refuse, not allow-all.
 *   rate limits     per address and per form in this instance; per form per hour in the
 *                   database (0024), which holds across instances
 *   honeypot/dwell  silent: answered like a real submission
 *   validation      the form's own definition; anything else is ignored or refused
 *
 * A stranger is told their request arrived and nothing more. The authenticated route may
 * be told what became of its post — it is the client's own system asking about its own lead.
 */

import { type IntakeDeps, publicForm, receiveWebhook, submitForm } from './service.ts';

export interface PublicRequest {
  method: string;
  /** the path after the function's name: `/form`, `/submit`, `/hook`. */
  route: string;
  query: Record<string, string | undefined>;
  origin: string | null;
  authorization: string | null;
  idempotencyKey: string | null;
  ip: string;
  /** the parsed JSON body, or undefined when there was none or it did not parse. */
  body: unknown;
}

export interface PublicResponse {
  status: number;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface Limiter {
  /** true when this bucket has now been hit more than `ceiling` times in the window. */
  over(bucket: string, ceiling: number): boolean;
}

/**
 * In-process, so it bounds one instance rather than the deployment — said plainly, as on
 * ARC's other public functions. It stops a loop and a crude script; the hourly ceiling in
 * the database is the one that holds everywhere.
 */
export function windowLimiter(windowMs: number, now: () => number = Date.now): Limiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    over(bucket, ceiling) {
      const at = now();
      const entry = hits.get(bucket);
      if (!entry || at > entry.resetAt) {
        if (hits.size > 5000) hits.clear();
        hits.set(bucket, { count: 1, resetAt: at + windowMs });
        return false;
      }
      entry.count += 1;
      return entry.count > ceiling;
    },
  };
}

export const PUBLIC_LIMITS = Object.freeze({ perIp: 10, perForm: 60, perToken: 120, readsPerIp: 60 });

export interface PublicIntakeOptions {
  deps: IntakeDeps;
  /** the origins the hosted form is served from: ARC's site, and nothing else. */
  allowedOrigins: readonly string[];
  limiter: Limiter;
  log?: (line: string) => void;
}

export function createPublicIntake(options: PublicIntakeOptions) {
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

  return async function handle(request: PublicRequest): Promise<PublicResponse> {
    const headers = cors(request.origin);
    if (request.method === 'OPTIONS') return reply(204, null, headers);

    /* ── the client's own system ── */
    if (request.route === '/hook') {
      if (request.method !== 'POST') return reply(405, { error: 'use POST' });
      const token = /^Bearer\s+(\S+)$/i.exec(request.authorization ?? '')?.[1] ?? '';
      /* limited by the token's tail and by address, before anything is looked up. */
      if (limiter.over(`hook:${token.slice(-12)}`, PUBLIC_LIMITS.perToken) || limiter.over(`hook-ip:${request.ip}`, PUBLIC_LIMITS.perToken)) {
        return reply(429, { error: 'too many requests — slow down and retry', code: 'rate_limited' }, { 'Retry-After': '60' });
      }
      if (request.body === undefined) return reply(400, { error: 'the body is not valid JSON', code: 'invalid' });
      const outcome = await receiveWebhook(deps, token, request.body, request.idempotencyKey);
      if (!outcome.ok) {
        return reply(outcome.code === 'unauthorized' ? 401 : 422, {
          error: outcome.message, code: outcome.code, ...(outcome.fieldErrors ? { field_errors: outcome.fieldErrors } : {}),
        });
      }
      log(`native-intake hook for ${outcome.tenantId}: ${outcome.result.outcome}`);
      return reply(outcome.result.outcome === 'created' ? 201 : 200, {
        ok: true, outcome: outcome.result.outcome, lead_id: outcome.result.lead_id, contact_id: outcome.result.contact_id,
      });
    }

    /* ── the hosted form: read ── */
    if (request.route === '/form') {
      if (request.method !== 'GET') return reply(405, { error: 'use GET' }, headers);
      if (limiter.over(`read:${request.ip}`, PUBLIC_LIMITS.readsPerIp)) return reply(429, { error: 'too many requests — try again in a minute' }, { ...headers, 'Retry-After': '60' });
      const form = await publicForm(deps, request.query.key);
      if (!form) return reply(404, { error: 'unknown form' }, headers);
      return reply(200, { ok: true, form }, { ...headers, 'Cache-Control': 'public, max-age=60' });
    }

    /* ── the hosted form: submit ── */
    if (request.route === '/submit') {
      if (request.method !== 'POST') return reply(405, { error: 'use POST' }, headers);
      /* an unconfigured site origin refuses. treating "none yet" as allow-all would make
         every new deployment briefly an open endpoint. */
      if (!request.origin || !allowed.includes(request.origin)) {
        log(`native-intake refused origin ${request.origin ?? '(none)'}`);
        return reply(403, { error: 'this form cannot be submitted from here' }, headers);
      }
      if (request.body === undefined || request.body === null || typeof request.body !== 'object') return reply(400, { error: 'the body is not valid JSON' }, headers);
      const key = (request.body as Record<string, unknown>).key;
      const bucket = typeof key === 'string' ? key.slice(0, 40) : 'none';
      if (limiter.over(`ip:${request.ip}`, PUBLIC_LIMITS.perIp) || limiter.over(`form:${bucket}`, PUBLIC_LIMITS.perForm)) {
        return reply(429, { error: 'too many submissions — try again in a minute' }, { ...headers, 'Retry-After': '60' });
      }
      const outcome = await submitForm(deps, key, request.body);
      if (!outcome.ok) {
        if (outcome.code === 'not_found') return reply(404, { error: 'unknown form' }, headers);
        if (outcome.code === 'rate_limited') return reply(429, { error: outcome.message }, { ...headers, 'Retry-After': '600' });
        return reply(422, { error: outcome.message, field_errors: outcome.fieldErrors ?? [] }, headers);
      }
      log(`native-intake form for ${outcome.tenantId}: ${outcome.discarded ? `discarded (${outcome.discarded})` : outcome.outcome}`);
      return reply(200, { ok: true, received: true }, headers);
    }

    return reply(404, { error: 'not found' }, headers);
  };
}
