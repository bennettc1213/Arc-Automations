/**
 * ARC-130 — the connectors this runtime can serve, and the adapters that serve them.
 *
 * There is ONE list of providers: ARC-100's `CONNECTORS`. `REGISTRY_CATALOG` is a view of
 * it plus the production adapter map, nothing more — no connector is declared here. A
 * connector the registry does not have, a version it does not have, an auth method the
 * version does not use, or an adapter the map does not hold, fails closed.
 *
 * Tests use `syntheticCatalog()` (synthetic.ts): the registry plus two synthetic
 * providers on `.invalid` hosts. Building it throws unless the environment says, in so
 * many words, that this is development or test.
 */

import {
  CONNECTORS,
  type ConnectorVersion,
  getConnectorVersion,
  isTenantCredentialed,
  latestSelectableConnectorVersion,
} from '../registry/connectors.ts';
import { SELECTABLE_STATUSES } from '../registry/capabilities.ts';
import { oauth2Adapter, type ProviderAdapter } from './adapter.ts';
import { type AuthMethod, ConnectionError } from './model.ts';

export interface ConnectorCatalog {
  readonly name: 'registry' | 'synthetic';
  /** one exact version, or null. */
  connectorVersion(key: string, version: number): ConnectorVersion | null;
  /** the newest version a tenant could connect now, or null. */
  latestConnectable(key: string): ConnectorVersion | null;
  /** selectable versions providing a capability — design-time "could". */
  connectorsProviding(capability: string): ConnectorVersion[];
  adapter(key: string): ProviderAdapter | null;
}

/** Production adapters. A real provider adapter is added here with its registry version. */
const PRODUCTION_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  [oauth2Adapter.key]: oauth2Adapter,
});

export function catalogOver(
  name: ConnectorCatalog['name'],
  versionsOf: (key: string) => readonly ConnectorVersion[],
  allVersions: () => readonly ConnectorVersion[],
  adapters: Readonly<Record<string, ProviderAdapter>>,
): ConnectorCatalog {
  return Object.freeze({
    name,
    connectorVersion: (key: string, version: number) => versionsOf(key).find((v) => v.version === version) ?? null,
    latestConnectable: (key: string) =>
      [...versionsOf(key)]
        .filter((v) => SELECTABLE_STATUSES.includes(v.status) && isTenantCredentialed(v) && v.connection)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    connectorsProviding: (capability: string) =>
      allVersions().filter((v) => SELECTABLE_STATUSES.includes(v.status) && v.capabilities.includes(capability)),
    adapter: (key: string) => adapters[key] ?? null,
  });
}

export const REGISTRY_CATALOG: ConnectorCatalog = catalogOver(
  'registry',
  (key) => CONNECTORS.find((c) => c.key === key)?.versions ?? [],
  () => CONNECTORS.flatMap((c) => c.versions),
  PRODUCTION_ADAPTERS,
);

/** Kept for symmetry with the registry's own lookups. */
export const registryConnectorVersion = getConnectorVersion;
export const registryLatest = latestSelectableConnectorVersion;

export interface ResolvedProvider {
  version: ConnectorVersion;
  adapter: ProviderAdapter;
  method: AuthMethod;
}

/**
 * Resolve what a tenant may connect: a known, selectable, tenant-credentialed connector
 * version using `method`, with an adapter that serves that method. Every failure is typed.
 */
export function resolveProvider(catalog: ConnectorCatalog, key: unknown, method: AuthMethod, version?: number): ResolvedProvider {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new ConnectionError('unknown_provider', 'that is not a provider ARC knows');
  const resolved = version === undefined ? catalog.latestConnectable(key) : catalog.connectorVersion(key, version);
  if (!resolved || !resolved.connection || !isTenantCredentialed(resolved)) {
    throw new ConnectionError('unknown_provider', `${key} is not a provider a client can connect`);
  }
  if (resolved.auth.type !== method) {
    throw new ConnectionError('unsupported_auth_method', `${key} connects with ${resolved.auth.type}, not ${method}`);
  }
  const adapter = catalog.adapter(resolved.connection.adapter);
  if (!adapter || !adapter.authMethods.includes(method)) {
    throw new ConnectionError('unknown_provider', `no adapter serves ${key} in this runtime`);
  }
  return { version: resolved, adapter, method };
}
