/**
 * ARC-320 — everything the activation console draws for one module, read in one place.
 *
 * Nothing here is a new source of truth. The lifecycle, readiness and history are ARC-120's
 * `getLifecycleStatus`; the connections are ARC-130's rows, passed through `summarize` (the
 * only shape of a connection any caller outside the service ever sees — no credential, no
 * Vault reference, no lease); the tests are ARC-200's rows. This file only joins them under
 * the module's own requirement groups, so an operator reads "send_sms: needs one of Twilio or
 * <provider> — missing" instead of three tables.
 *
 * Server-side: it imports the connection service for `summarize`. The console gets the
 * result as JSON and words it with `activation/model.ts`.
 */

import type { ConnectorCatalog } from '../connections/catalog.ts';
import { REGISTRY_CATALOG } from '../connections/catalog.ts';
import type { ConnectionRow } from '../connections/model.ts';
import { summarize, type ConnectionSummary } from '../connections/service.ts';
import { moduleScope, TENANT_SCOPE } from '../config/model.ts';
import type { ConfigStore } from '../config/store.ts';
import type { CapabilityReadiness } from '../lifecycle/readiness.ts';
import type { EvidenceRow, VersionPair } from '../lifecycle/model.ts';
import type { LifecycleStore } from '../lifecycle/store.ts';
import { type ConnectorVersion, getConnector, isTenantCredentialed } from '../registry/connectors.ts';
import { getModule, latestSelectableModuleVersion } from '../registry/modules.ts';
import { connectionDisplay, credentialHint } from './model.ts';
import type { ConnectionTestLog, ConnectionTestRecord } from './connection-test.ts';

/**
 * The synthetic test each module has, by the `ops` action that runs it. A module with none
 * cannot produce test evidence, and the console says so rather than offering a button.
 */
export const MODULE_TEST_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  lead_recovery: 'lead-recovery-canary',
});

export interface ProviderRow {
  connector_key: string;
  name: string;
  /** `arc`: ARC's own account or an ARC-issued key — proven by attestation and config, not a tenant connection. */
  owner: 'arc' | 'tenant';
  auth_type: string;
  /** a tenant could connect it in this build: tenant-credentialed, with an adapter. */
  connectable: boolean;
  /** for a key-based provider, the names of the fields its key is entered as — never values. */
  credential_fields: string[];
  connection: (ConnectionSummary & { display: string; hint: string | null; latest_test: ConnectionTestRecord | null }) | null;
}

export interface CapabilityRow {
  key: string;
  status: string;
  reason: string;
  required: boolean;
  providers: ProviderRow[];
}

export interface RequirementRow {
  key: string;
  kind: string;
  description: string;
  blocking: boolean;
  capabilities: CapabilityRow[];
}

type OverviewStore = ConfigStore & Pick<LifecycleStore, 'getEvidence' | 'listEvidence'> & {
  listConnections(tenantId: string): Promise<ConnectionRow[]>;
  readonly connectorCatalog?: ConnectorCatalog;
};

function providerFor(
  connectorKey: string,
  known: ConnectorVersion | null,
  catalog: ConnectorCatalog,
  connections: ConnectionRow[],
  latestTests: Map<string, ConnectionTestRecord>,
  now: Date,
): ProviderRow {
  const version = catalog.latestConnectable(connectorKey);
  const any = version ?? known;
  const tenantCredentialed = any ? isTenantCredentialed(any) : false;
  const connectable = Boolean(version?.connection && catalog.adapter(version.connection.adapter));
  /* the freshest row for this provider: the schema allows one live connection per provider,
     so a live one wins, and otherwise the most recent ended one says what happened. */
  const rows = connections.filter((c) => c.connectorKey === connectorKey);
  const live = rows.find((c) => !c.endedAt) ?? rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  const summary = live ? summarize(live) : null;
  return {
    connector_key: connectorKey,
    name: getConnector(connectorKey)?.displayName ?? connectorKey,
    owner: tenantCredentialed ? 'tenant' : 'arc',
    auth_type: any?.auth.type ?? 'unknown',
    connectable,
    credential_fields: connectable ? (version?.connection?.credentialFields ?? []).map((f) => f.name) : [],
    connection: tenantCredentialed
      ? summary
        ? { ...summary, display: connectionDisplay(summary, { connectable, now }), hint: credentialHint(summary.credential), latest_test: latestTests.get(summary.id) ?? null }
        : null
      : null,
  };
}

/**
 * The module's requirement groups, each capability with ARC-120's verdict on it and every
 * provider that could serve it — and, for a provider the tenant connects, the connection.
 */
export async function connectionPanel(
  store: OverviewStore,
  args: { tenantId: string; moduleKey: string; capabilities: CapabilityReadiness[]; tests: ConnectionTestLog | null; now?: Date },
): Promise<{ requirements: RequirementRow[]; connections: ProviderRow['connection'][]; tests: ConnectionTestRecord[] }> {
  const now = args.now ?? new Date();
  const catalog = store.connectorCatalog ?? REGISTRY_CATALOG;
  const version = latestSelectableModuleVersion(args.moduleKey);
  const [rows, tests] = await Promise.all([
    store.listConnections(args.tenantId),
    args.tests ? args.tests.recent(args.tenantId, 20) : Promise.resolve([] as ConnectionTestRecord[]),
  ]);
  const latestTests = new Map<string, ConnectionTestRecord>();
  for (const test of tests) if (test.connection_id && !latestTests.has(test.connection_id)) latestTests.set(test.connection_id, test);
  const verdict = new Map(args.capabilities.map((c) => [c.capability, c]));

  const requirements: RequirementRow[] = (version?.requirements ?? []).map((requirement) => ({
    key: requirement.key,
    kind: requirement.kind,
    description: requirement.description,
    blocking: requirement.kind === 'all_of' || requirement.kind === 'any_of',
    capabilities: requirement.capabilities.map((capability) => {
      const found = verdict.get(capability);
      const versions = new Map<string, ConnectorVersion>();
      for (const v of catalog.connectorsProviding(capability)) if (!versions.has(v.connectorKey)) versions.set(v.connectorKey, v);
      return {
        key: capability,
        status: found?.status ?? 'unknown',
        reason: found?.reason ?? 'not evaluated',
        required: found?.required ?? false,
        providers: [...versions].map(([key, v]) => providerFor(key, v, catalog, rows, latestTests, now)),
      };
    }),
  }));

  /* every connection the client has, including one no requirement of this module names —
     an operator deciding whether to disconnect something should see all of them. */
  const connections = rows
    .map((row) => providerFor(row.connectorKey, catalog.connectorVersion(row.connectorKey, row.connectorVersion), catalog, [row], latestTests, now).connection)
    .filter((c): c is NonNullable<ProviderRow['connection']> => c !== null);
  return { requirements, connections, tests };
}

/* ── versions, by number ────────────────────────────────── */

export interface PairNumbers {
  tenant: number | null;
  module: number | null;
}

/** The version numbers behind a pair of ids, for a sentence like "tenant v3 · module v5". */
export async function pairNumbers(store: ConfigStore, tenantId: string, moduleKey: string, pair: VersionPair | null): Promise<PairNumbers | null> {
  if (!pair) return null;
  const [tenant, module] = await Promise.all([
    store.getConfigVersion(tenantId, TENANT_SCOPE, pair.tenantVersionId),
    store.getConfigVersion(tenantId, moduleScope(moduleKey), pair.moduleVersionId),
  ]);
  return { tenant: tenant?.version ?? null, module: module?.version ?? null };
}

/** The recent synthetic tests of this module, newest first. */
export async function recentTestEvidence(store: OverviewStore, tenantId: string, moduleKey: string, limit = 5): Promise<EvidenceRow[]> {
  return await store.listEvidence(tenantId, moduleKey, { kind: 'test', limit });
}

export function moduleHeader(moduleKey: string) {
  const module = getModule(moduleKey);
  const version = latestSelectableModuleVersion(moduleKey);
  return {
    key: moduleKey,
    name: module?.displayName ?? moduleKey,
    version: version?.version ?? null,
    execution_mode: version?.runtime.executionMode ?? null,
    requires_shadow: Boolean(version?.safety.requiresShadowMode),
    test_action: MODULE_TEST_ACTIONS[moduleKey] ?? null,
  };
}
