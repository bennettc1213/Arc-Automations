/**
 * ARC-130 — the `connections` function's actions, apart from Deno.serve so node can test
 * them (index.ts imports supabase-js from jsr:, which node cannot load).
 *
 * The caller is whoever the verified JWT says; `tenant_id` in a body is only a question
 * ("may this person manage this client?"), answered by the service and re-checked in SQL.
 * Every action takes an explicit list of fields and refuses any other — so a body cannot
 * smuggle scopes, endpoints, a redirect URI, a secret reference or a replacement target
 * past the service. Responses are built from safe summaries only: no token, key, verifier,
 * state digest, Vault reference or provider body can be in one, because none is ever given
 * to the code that builds them. The OAuth authorisation URL is returned once, to the person
 * who asked for it, because carrying it to the provider is what it is for.
 *
 * Abuse control: a per-actor, per-action sliding window here, and a cap on open
 * authorisation sessions per client in 0016.
 */

import { ConnectionError, CONNECTION_ERROR_STATUS } from '../_shared/connections/model.ts';
import { safeLog } from '../_shared/connections/redact.ts';
import {
  beginOAuthAuthorization,
  completeOAuthCallback,
  type ConnectionServiceDeps,
  endConnection,
  getConnection,
  listConnections,
  requestReauthorization,
  storeApiKey,
  verifyConnection,
} from '../_shared/connections/service.ts';

export const CONNECTION_ACTIONS = [
  'connections-list',
  'connection-get',
  'oauth-begin',
  'oauth-callback',
  'api-key-store',
  'connection-verify',
  'connection-reauthorize',
  'connection-disconnect',
  'connection-revoke',
] as const;
export type ConnectionAction = typeof CONNECTION_ACTIONS[number];

/** The only fields each action reads. Anything else in a body is refused. */
const FIELDS: Readonly<Record<ConnectionAction, readonly string[]>> = Object.freeze({
  'connections-list': ['tenant_id'],
  'connection-get': ['tenant_id', 'connection_id'],
  'oauth-begin': ['tenant_id', 'connector_key', 'purpose', 'connection_id', 'expected_status_version', 'capabilities', 'return_path'],
  'oauth-callback': ['state', 'code', 'error', 'error_description', 'connector_key', 'confirm_account_replacement'],
  'api-key-store': ['tenant_id', 'connector_key', 'connection_id', 'expected_status_version', 'expected_credential_version', 'credential', 'confirm_account_replacement', 'idempotency_key'],
  'connection-verify': ['tenant_id', 'connection_id', 'expected_status_version'],
  'connection-reauthorize': ['tenant_id', 'connection_id', 'expected_status_version', 'idempotency_key'],
  'connection-disconnect': ['tenant_id', 'connection_id', 'expected_status_version', 'idempotency_key'],
  'connection-revoke': ['tenant_id', 'connection_id', 'expected_status_version', 'idempotency_key'],
});

/** Actions that start or finish something with a provider: rate-limited per actor. */
const LIMITED: readonly ConnectionAction[] = ['oauth-begin', 'oauth-callback', 'api-key-store', 'connection-verify'];

export interface ConnectionLimiter {
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createConnectionLimiter(options: { perMinute?: number; now?: () => number } = {}): ConnectionLimiter {
  const perMinute = options.perMinute ?? 10;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, number[]>();
  return {
    take(key) {
      const t = now();
      const w = (windows.get(key) ?? []).filter((at) => t - at < 60_000);
      if (w.length >= perMinute) {
        windows.set(key, w);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (t - w[0])) / 1000)) };
      }
      w.push(t);
      windows.set(key, w);
      return { ok: true };
    },
  };
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(error: unknown, correlationId: string): HandlerResult {
  if (error instanceof ConnectionError) {
    /* only ARC's own sentence and code; detail only when it is a safe connection summary. */
    const connection = error.detail?.connection;
    return {
      status: CONNECTION_ERROR_STATUS[error.code] ?? 400,
      body: { error: error.code, message: error.message, correlation_id: correlationId, ...(connection ? { connection } : {}) },
    };
  }
  safeLog('handler_error', { correlation_id: correlationId, name: (error as Error)?.name ?? 'unknown' });
  return { status: 500, body: { error: 'internal', message: 'the request could not be completed', correlation_id: correlationId } };
}

export async function handleConnectionAction(
  action: string,
  ctx: {
    body: Record<string, unknown>;
    /** from the verified JWT — never from the body. */
    actorId: string | null;
    deps: ConnectionServiceDeps;
    limiter: ConnectionLimiter;
    correlationId?: string;
  },
): Promise<HandlerResult> {
  const correlationId = ctx.correlationId ?? crypto.randomUUID();
  try {
    if (!(CONNECTION_ACTIONS as readonly string[]).includes(action)) throw new ConnectionError('invalid_request', 'unknown action');
    const a = action as ConnectionAction;
    if (!ctx.actorId) throw new ConnectionError('forbidden', 'not signed in');

    const unexpected = Object.keys(ctx.body).filter((k) => k !== 'action' && !FIELDS[a].includes(k));
    if (unexpected.length > 0) {
      /* the classic smuggles get a specific answer; everything else a generic one. */
      if (unexpected.some((k) => /scope/i.test(k))) throw new ConnectionError('invalid_scope_request', 'scopes come from the provider registry, never from a request');
      if (unexpected.some((k) => /(endpoint|url|uri|host)/i.test(k))) throw new ConnectionError('endpoint_not_registered', 'provider endpoints and redirects are server-controlled');
      throw new ConnectionError('invalid_request', `unexpected fields: ${unexpected.map((k) => k.slice(0, 40)).join(', ')}`);
    }

    if (LIMITED.includes(a)) {
      const allowed = ctx.limiter.take(`${ctx.actorId}:${a}`);
      if (!allowed.ok) {
        return {
          status: 429,
          body: { error: 'rate_limited', message: 'too many requests — wait a moment', correlation_id: correlationId },
          headers: { 'Retry-After': String(allowed.retryAfterSeconds) },
        };
      }
    }

    const b = ctx.body;
    const tenantId = typeof b.tenant_id === 'string' && UUID.test(b.tenant_id) ? b.tenant_id : null;
    if (a !== 'oauth-callback' && !tenantId) throw new ConnectionError('invalid_request', 'tenant_id is required');
    const t = tenantId as string;

    switch (a) {
      case 'connections-list':
        return { status: 200, body: { ...(await listConnections(ctx.deps, { tenantId: t, actorId: ctx.actorId })), correlation_id: correlationId } };
      case 'connection-get':
        return { status: 200, body: { ...(await getConnection(ctx.deps, { tenantId: t, actorId: ctx.actorId, connectionId: b.connection_id })), correlation_id: correlationId } };
      case 'oauth-begin':
        return {
          status: 200,
          body: {
            ...(await beginOAuthAuthorization(ctx.deps, {
              tenantId: t,
              actorId: ctx.actorId,
              connectorKey: b.connector_key,
              purpose: b.purpose,
              targetConnectionId: b.connection_id,
              expectedStatusVersion: b.expected_status_version,
              capabilities: b.capabilities,
              returnPath: b.return_path,
              correlationId,
            })),
            correlation_id: correlationId,
          },
        };
      case 'oauth-callback':
        return {
          status: 200,
          body: {
            ...(await completeOAuthCallback(ctx.deps, {
              actorId: ctx.actorId,
              state: b.state,
              code: b.code,
              error: b.error,
              connectorKey: b.connector_key,
              confirmAccountReplacement: b.confirm_account_replacement,
              correlationId,
            })),
            correlation_id: correlationId,
          },
        };
      case 'api-key-store':
        return {
          status: 200,
          body: {
            ...(await storeApiKey(ctx.deps, {
              tenantId: t,
              actorId: ctx.actorId,
              connectorKey: b.connector_key,
              connectionId: b.connection_id,
              expectedStatusVersion: b.expected_status_version,
              expectedCredentialVersion: b.expected_credential_version,
              credential: b.credential,
              confirmAccountReplacement: b.confirm_account_replacement,
              idempotencyKey: b.idempotency_key,
              correlationId,
            })),
            correlation_id: correlationId,
          },
        };
      case 'connection-verify':
        return {
          status: 200,
          body: {
            ...(await verifyConnection(ctx.deps, { tenantId: t, connectionId: b.connection_id, actorId: ctx.actorId, expectedStatusVersion: b.expected_status_version, correlationId })),
            correlation_id: correlationId,
          },
        };
      case 'connection-reauthorize':
        return {
          status: 200,
          body: {
            ...(await requestReauthorization(ctx.deps, { tenantId: t, connectionId: b.connection_id, actorId: ctx.actorId, expectedStatusVersion: b.expected_status_version, idempotencyKey: b.idempotency_key, correlationId })),
            correlation_id: correlationId,
          },
        };
      case 'connection-disconnect':
      case 'connection-revoke':
        return {
          status: 200,
          body: {
            ...(await endConnection(ctx.deps, {
              tenantId: t,
              connectionId: b.connection_id,
              actorId: ctx.actorId,
              expectedStatusVersion: b.expected_status_version,
              mode: a === 'connection-revoke' ? 'revoke' : 'disconnect',
              idempotencyKey: b.idempotency_key,
              correlationId,
            })),
            correlation_id: correlationId,
          },
        };
    }
  } catch (error) {
    return failure(error, correlationId);
  }
}
