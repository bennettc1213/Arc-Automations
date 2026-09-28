/**
 * ARC-130 — what a tenant's connections prove about a capability, for ARC-120.
 *
 * This replaces the "unknown until ARC-130" branch of `capabilityEvidence`
 * (lifecycle/readiness.ts): for a connector the tenant connects with a credential, a
 * capability is `ready` only when a connection of that provider is `verified` (or
 * `degraded`) for exactly that capability, holds a stored credential, was verified within
 * the provider's freshness window, is not expired without a way to refresh, and reports a
 * health this build recognises. Everything else — reauthorisation required, revoked,
 * disconnected, unverified, stale, unknown — is not ready, and says why.
 *
 * Evaluated from the live rows every time: the same facts at run start, before every
 * action and before every effect.
 */

import type { ConnectorVersion } from '../registry/connectors.ts';
import { type ConnectorCatalog, REGISTRY_CATALOG } from './catalog.ts';
import { type ConnectionFact, parseConnectionStatus } from './model.ts';

export interface TenantConnectionEvidence {
  connections: readonly ConnectionFact[];
  catalog: ConnectorCatalog;
  now: Date;
}

export type TenantCapabilityStatus = 'ready' | 'missing' | 'invalid' | 'expired' | 'unhealthy' | 'unknown';

const HEALTH = ['unverified', 'healthy', 'degraded', 'failing'];
const RANK: Record<string, number> = { verified: 0, degraded: 1, connected_unverified: 2, reauthorization_required: 3, authorization_pending: 4, failed: 5, revoked: 6, disconnected: 7 };

/** Whatever this store can tell us about the tenant's connections — nothing, if it has none. */
export async function tenantConnectionEvidence(store: unknown, tenantId: string, now = new Date()): Promise<TenantConnectionEvidence> {
  const s = store as { listConnectionFacts?: (t: string) => Promise<ConnectionFact[]>; connectorCatalog?: ConnectorCatalog };
  const connections = typeof s?.listConnectionFacts === 'function' ? await s.listConnectionFacts(tenantId) : [];
  return { connections, catalog: s?.connectorCatalog ?? REGISTRY_CATALOG, now };
}

/** One capability through one tenant-credentialed connector version. */
export function tenantConnectionCapability(
  capability: string,
  version: ConnectorVersion,
  evidence: TenantConnectionEvidence,
): { status: TenantCapabilityStatus; reason: string } {
  const key = version.connectorKey;
  const facts = evidence.connections
    .filter((c) => c.connectorKey === key)
    .sort((a, b) => (RANK[a.status] ?? -1) - (RANK[b.status] ?? -1));
  if (facts.length === 0) return { status: 'missing', reason: `no ${key} connection exists` };
  const fact = facts[0];
  const status = parseConnectionStatus(fact.status);
  if (!status) return { status: 'invalid', reason: `the ${key} connection is in a status this build does not know` };
  switch (status) {
    case 'revoked':
    case 'disconnected':
    case 'failed':
    case 'authorization_pending':
      return { status: 'missing', reason: `the ${key} connection is ${status}` };
    case 'reauthorization_required':
      return { status: 'expired', reason: `the ${key} connection must be reauthorised` };
    case 'connected_unverified':
      return { status: 'unknown', reason: `the ${key} connection has not been verified` };
  }
  if (!fact.verifiedCapabilities.includes(capability)) {
    return { status: 'missing', reason: `the ${key} connection is not verified for ${capability}` };
  }
  if (!(fact.credentialVersion > 0)) return { status: 'invalid', reason: `the ${key} connection holds no credential` };
  if (!HEALTH.includes(fact.healthStatus)) return { status: 'invalid', reason: `the ${key} connection reports an unknown health` };
  if (fact.healthStatus === 'failing') return { status: 'unhealthy', reason: `the ${key} connection is failing` };
  const hours = version.connection?.freshness.reverifyAfterHours ?? 0;
  const verifiedAt = fact.lastVerifiedAt ? Date.parse(fact.lastVerifiedAt) : NaN;
  if (!Number.isFinite(verifiedAt) || evidence.now.getTime() - verifiedAt > hours * 3600_000) {
    return { status: 'unknown', reason: `the ${key} connection's verification is older than ${hours}h` };
  }
  if (fact.accessExpiresAt && Date.parse(fact.accessExpiresAt) <= evidence.now.getTime() && !fact.refreshable) {
    return { status: 'expired', reason: `the ${key} access token has expired and cannot be refreshed` };
  }
  return { status: 'ready', reason: status === 'degraded' ? `the ${key} connection is verified (provider degraded)` : `the ${key} connection is verified` };
}
