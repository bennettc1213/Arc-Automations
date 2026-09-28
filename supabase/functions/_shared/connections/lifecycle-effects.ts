/**
 * ARC-130 → ARC-120: what a connection's loss or recovery does to the modules that need it.
 *
 * Just-in-time authorisation already refuses any live work the moment a connection stops
 * proving a capability — it reads the connection rows, not this. These effects make that
 * refusal visible and durable, through ARC-120's own transitions and history:
 *
 *   loss (revoked, disconnected, reauthorisation required, scope/capability mismatch)
 *     → every module that can no longer prove its connection readiness gets a system health
 *       report of `failing` naming the capabilities, and if it was ACTIVE, a `system_pause`
 *       that adds `reactivation` to what it requires. The operator's decision is the only way
 *       back.
 *   degraded (a transient provider failure) → `degraded` health. Nothing pauses.
 *   recovery (verified again) → health that this code set is reported `healthy` again. The
 *       lifecycle state is never touched: a paused module stays paused, and nothing here can
 *       select, activate or resume.
 *
 * Best effort by design: if the lifecycle write loses a race, the next evaluation (and
 * every execution check in between) still sees the connection as it is.
 */

import type { ConfigStore } from '../config/store.ts';
import { evaluateConfigReadiness, evaluateConnectionReadiness, type ConnectionEvidence } from '../lifecycle/readiness.ts';
import { type LifecycleRow, LifecycleStoreError, normaliseRequirements, parseLifecycleState, type Requirement, SYSTEM_ACTOR } from '../lifecycle/model.ts';
import type { LifecycleStore } from '../lifecycle/store.ts';
import { latestSelectableModuleVersion } from '../registry/modules.ts';
import { requiredCapabilities } from '../registry/resolve.ts';
import type { ConnectionRow } from './model.ts';
import { safeLog } from './redact.ts';
import { tenantConnectionEvidence } from './readiness.ts';
import type { ConnectionStore } from './store.ts';

export type LifecycleEffectsStore = ConfigStore & LifecycleStore;

export const HEALTH_SOURCE = 'arc130_connection';

export interface ConnectionEffects {
  paused: string[];
  health: { moduleKey: string; status: string }[];
}

/** Capabilities of this connection's provider that a module's blocking requirements use. */
function dependentCapabilities(connections: ConnectionStore, row: ConnectionRow, moduleKey: string): string[] {
  const provider = connections.connectorCatalog.connectorVersion(row.connectorKey, row.connectorVersion);
  const version = latestSelectableModuleVersion(moduleKey);
  if (!provider || !version) return [];
  const needs = requiredCapabilities(version);
  const blocking = new Set([...needs.required, ...needs.conditional]);
  return provider.capabilities.filter((c) => blocking.has(c));
}

async function readinessWithout(store: LifecycleEffectsStore, connections: ConnectionStore, lifecycle: LifecycleRow): Promise<boolean> {
  const version = latestSelectableModuleVersion(lifecycle.moduleKey);
  if (!version) return false;
  const config = await evaluateConfigReadiness(store, lifecycle.tenantId, lifecycle.moduleKey);
  const [completedSteps, hasActiveIntakeKey, tenant] = await Promise.all([
    store.listCompletedOnboardingSteps(lifecycle.tenantId, lifecycle.moduleKey),
    store.hasActiveIntakeKey(lifecycle.tenantId),
    tenantConnectionEvidence(connections, lifecycle.tenantId),
  ]);
  const evidence: ConnectionEvidence = {
    config: config.ready ? config.resolution.config : null,
    completedSteps,
    hasActiveIntakeKey,
    unhealthyCapabilities: [],
    tenant,
  };
  return evaluateConnectionReadiness(version, evidence).ready;
}

async function transition(store: LifecycleEffectsStore, lifecycle: LifecycleRow, request: {
  transition: 'system_pause' | 'report_health';
  reasonCode: string;
  reason: string;
  idempotencyKey: string;
  pending: Requirement[];
  health?: { status: 'failing' | 'degraded' | 'healthy'; reason: string | null; evidence: Record<string, unknown> };
}): Promise<boolean> {
  try {
    await store.applyLifecycleTransition({
      tenantId: lifecycle.tenantId,
      moduleKey: lifecycle.moduleKey,
      transition: request.transition,
      expectedStateVersion: lifecycle.stateVersion,
      actor: SYSTEM_ACTOR,
      reasonCode: request.reasonCode,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      change: {
        pendingRequirements: request.pending,
        versions: lifecycle.authorized,
        ...(request.health ? { health: request.health } : {}),
        metadata: { source: HEALTH_SOURCE },
      },
    });
    return true;
  } catch (error) {
    if (error instanceof LifecycleStoreError) {
      safeLog('lifecycle_effect_skipped', { tenant_id: lifecycle.tenantId, module: lifecycle.moduleKey, code: error.code });
      return false;
    }
    throw error;
  }
}

/** A connection can no longer be relied on. Pause the active modules that needed it; mark their health. */
export async function applyConnectionLoss(
  store: LifecycleEffectsStore | null,
  connections: ConnectionStore,
  row: ConnectionRow,
  reason: string,
): Promise<ConnectionEffects> {
  const effects: ConnectionEffects = { paused: [], health: [] };
  if (!store) return effects;
  const degradedOnly = reason === 'provider_degraded';
  for (const listed of await store.listLifecycles(row.tenantId)) {
    const state = parseLifecycleState(listed.state);
    if (!state || state === 'unselected') continue;
    const capabilities = dependentCapabilities(connections, row, listed.moduleKey);
    if (capabilities.length === 0) continue;
    if (!degradedOnly && await readinessWithout(store, connections, listed)) continue; // another connection still serves it

    let lifecycle = listed;
    const pending = normaliseRequirements(lifecycle.pendingRequirements);
    if (!degradedOnly && state === 'active') {
      const next = [...new Set<Requirement>([...pending, 'reactivation'])];
      if (await transition(store, lifecycle, {
        transition: 'system_pause',
        reasonCode: 'connection_unusable',
        reason: `the ${row.connectorKey} connection is ${row.status} (${reason}) — paused until an operator reactivates it`,
        idempotencyKey: `connection:${row.id}:${row.statusVersion}:${lifecycle.moduleKey}:pause`,
        pending: next,
      })) {
        effects.paused.push(lifecycle.moduleKey);
        lifecycle = (await store.getLifecycle(row.tenantId, lifecycle.moduleKey)) ?? lifecycle;
      }
    }
    const status = degradedOnly ? 'degraded' : 'failing';
    if (await transition(store, lifecycle, {
      transition: 'report_health',
      reasonCode: `health_${status}`,
      reason: `the ${row.connectorKey} connection is ${row.status}`,
      idempotencyKey: `connection:${row.id}:${row.statusVersion}:${lifecycle.moduleKey}:health`,
      pending: normaliseRequirements(lifecycle.pendingRequirements),
      health: {
        status,
        reason: `${row.connectorKey} connection ${row.status}`,
        evidence: {
          source: HEALTH_SOURCE,
          connection_id: row.id,
          connector: row.connectorKey,
          ...(degradedOnly ? {} : { capabilities }),
        },
      },
    })) effects.health.push({ moduleKey: lifecycle.moduleKey, status });
  }
  return effects;
}

/**
 * A connection is verified again. Health this code marked is reported healthy; the state is
 * left exactly as it is. A module paused by the loss stays paused.
 */
export async function applyConnectionRecovery(
  store: LifecycleEffectsStore | null,
  connections: ConnectionStore,
  row: ConnectionRow,
): Promise<ConnectionEffects> {
  const effects: ConnectionEffects = { paused: [], health: [] };
  if (!store) return effects;
  for (const lifecycle of await store.listLifecycles(row.tenantId)) {
    const state = parseLifecycleState(lifecycle.state);
    if (!state || state === 'unselected') continue;
    const evidence = lifecycle.healthEvidence ?? {};
    if (evidence.source !== HEALTH_SOURCE || evidence.connector !== row.connectorKey || lifecycle.healthStatus === 'healthy') continue;
    if (dependentCapabilities(connections, row, lifecycle.moduleKey).length === 0) continue;
    if (await transition(store, lifecycle, {
      transition: 'report_health',
      reasonCode: 'health_healthy',
      reason: `the ${row.connectorKey} connection is verified again`,
      idempotencyKey: `connection:${row.id}:${row.statusVersion}:${lifecycle.moduleKey}:recovered`,
      pending: normaliseRequirements(lifecycle.pendingRequirements),
      health: { status: 'healthy', reason: null, evidence: { source: HEALTH_SOURCE, connection_id: row.id, connector: row.connectorKey, recovered: true } },
    })) effects.health.push({ moduleKey: lifecycle.moduleKey, status: 'healthy' });
  }
  return effects;
}
