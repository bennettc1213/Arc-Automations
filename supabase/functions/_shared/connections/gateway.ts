/**
 * ARC-130 — the connector gateway seam, and the n8n credential boundary (ADR ARC-010 §20).
 *
 * A runner — `DirectArcWorker` today, a future `N8nRunner` (ARC-220) — asks ARC to perform
 * an approved operation. It names a run, an action, a capability and an operation: never a
 * credential, never a URL, never a connection secret. ARC then, in this order and with no
 * step skippable:
 *
 *   1. refuses any request carrying a credential-shaped field, before reading anything else;
 *   2. reloads the run, its lead and its PINNED configuration snapshot;
 *   3. asks ARC-120's `authorizeModuleExecution` (kind `effect`) whether this run may reach
 *      the world through this capability right now — which re-reads lifecycle, health and
 *      live connection evidence. A refusal returns here, and no credential is resolved;
 *   4. picks the tenant's connection verified for the capability;
 *   5. resolves the credential through `withProviderCredential` — the only credential path —
 *      and lets the provider operation use it for one call over a fenced transport;
 *   6. returns identifiers and a status. Never the credential, never the provider's body.
 *
 * Consent, suppression, STOP, reply, takeover, safety and send-once remain the module's
 * effect gate (Lead Recovery's `authorizeLeadRecoveryEffect`); the gateway does not
 * replace them and a module calls it only after its own gate has passed.
 *
 * Not built here: the signed n8n dispatch/callback bridge (ARC-220), durable operation
 * queues (ARC-200), or any real provider operation (ARC-LR-4xx).
 */

import { type AuthorizerStore, authorizeModuleExecution } from '../lifecycle/authorize.ts';
import type { EngineStore } from '../engine/store.ts';
import { ConnectionError, type ConnectionRow } from './model.ts';
import { redactDeep } from './redact.ts';
import { type ConnectionServiceDeps, type CredentialUse, withProviderCredential } from './service.ts';

/** What a runner may send. Identifiers and intent only. */
export interface ConnectorOperationRequest {
  tenant_id: string;
  module_key: string;
  run_id: string;
  capability: string;
  /** a name the module registers for an approved operation, e.g. `send_sms`. */
  operation: string;
  idempotency_key: string;
}

/** What a runner gets back. Identifiers and status only. */
export interface ConnectorOperationResult {
  status: 'performed' | 'refused' | 'failed';
  code: string | null;
  provider_reference: string | null;
  connection_id: string | null;
}

export const RUNNER_REQUEST_FIELDS: readonly (keyof ConnectorOperationRequest)[] = [
  'tenant_id', 'module_key', 'run_id', 'capability', 'operation', 'idempotency_key',
];

const CREDENTIAL_KEYS = /(token|secret|password|api[_-]?key|credential|authorization|bearer|verifier|vault|private[_-]?key|cookie|endpoint|url)/i;

/**
 * The inbound fence: a runner request with any key but the six above, or any
 * credential-shaped key anywhere in it, is refused before anything is read.
 */
export function parseRunnerRequest(input: unknown): ConnectorOperationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('invalid_request', 'a gateway request is an object');
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  const smuggled = keys.filter((k) => CREDENTIAL_KEYS.test(k));
  if (smuggled.length) throw new ConnectionError('operation_not_permitted', 'a runner never sends a credential or an endpoint to ARC');
  const extra = keys.filter((k) => !(RUNNER_REQUEST_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new ConnectionError('invalid_request', `unknown gateway fields: ${extra.map((k) => k.slice(0, 30)).join(', ')}`);
  for (const k of RUNNER_REQUEST_FIELDS) {
    if (typeof body[k] !== 'string' || !(body[k] as string).trim() || (body[k] as string).length > 200) {
      throw new ConnectionError('invalid_request', `${k} is required`);
    }
  }
  return body as unknown as ConnectorOperationRequest;
}

export type ProviderOperation = (use: CredentialUse, request: ConnectorOperationRequest) => Promise<{ providerReference: string | null }>;

export interface GatewayDeps {
  connections: ConnectionServiceDeps;
  engine: AuthorizerStore & Pick<EngineStore, 'getRun' | 'getLead' | 'getConfigSnapshot'>;
  /** the approved operations, keyed `capability:operation`. Anything else is refused. */
  operations: Readonly<Record<string, ProviderOperation>>;
}

function pickConnection(rows: ConnectionRow[], capability: string): ConnectionRow | null {
  const usable = rows.filter((r) => (r.status === 'verified' || r.status === 'degraded') && r.verifiedCapabilities.includes(capability));
  return usable.sort((a, b) => (a.status === 'verified' ? 0 : 1) - (b.status === 'verified' ? 0 : 1))[0] ?? null;
}

export async function performConnectorOperation(deps: GatewayDeps, input: unknown): Promise<ConnectorOperationResult> {
  const refused = (code: string): ConnectorOperationResult => ({ status: 'refused', code, provider_reference: null, connection_id: null });
  let req: ConnectorOperationRequest;
  try {
    req = parseRunnerRequest(input);
  } catch (error) {
    return refused(error instanceof ConnectionError ? error.code : 'invalid_request');
  }
  const operation = deps.operations[`${req.capability}:${req.operation}`];
  if (!operation) return refused('operation_not_permitted');

  const run = await deps.engine.getRun(req.tenant_id, req.run_id);
  if (!run || run.moduleKey !== req.module_key) return refused('not_found');
  const lead = await deps.engine.getLead(req.tenant_id, run.leadId);
  if (!lead) return refused('not_found');
  const snapshot = run.configSnapshotId ? await deps.engine.getConfigSnapshot(req.tenant_id, run.configSnapshotId) : null;

  /* 3. just-in-time authorisation, before anything secret is touched. */
  const decision = await authorizeModuleExecution(deps.engine, {
    kind: 'effect',
    tenantId: req.tenant_id,
    moduleKey: req.module_key,
    lead,
    run,
    action: null,
    config: snapshot?.config ?? null,
    capability: req.capability,
  });
  if (!decision.allowed) return refused(decision.code);
  /* a test or shadow run never reaches a provider through a tenant connection. */
  if (decision.mode !== 'live') return refused(decision.mode === 'shadow' ? 'shadow_no_effects' : 'mode_not_permitted');

  const connection = pickConnection(await deps.connections.store.listConnections(req.tenant_id), req.capability);
  if (!connection) return refused('connection_not_ready');

  try {
    const result = await withProviderCredential(deps.connections, {
      tenantId: req.tenant_id,
      connectionId: connection.id,
      capability: req.capability,
      correlationId: req.idempotency_key,
    }, (use) => operation(use, req));
    return { status: 'performed', code: null, provider_reference: result.providerReference, connection_id: connection.id };
  } catch (error) {
    const code = error instanceof ConnectionError ? error.code : 'provider_unavailable';
    return { status: 'failed', code: String(redactDeep(code)), provider_reference: null, connection_id: connection.id };
  }
}
