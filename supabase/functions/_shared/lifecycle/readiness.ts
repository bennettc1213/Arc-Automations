/**
 * ARC-120 — readiness, evaluated from facts every time it is asked.
 *
 * Nothing here is a stored boolean that could drift from what it summarises. Each answer
 * is recomputed from the thing it is about:
 *
 *   configuration   the ARC-110 resolver's answer for the current published versions,
 *                   validated by the ARC-100 registered schema — never a draft
 *   connections     the ARC-100 requirement groups, evaluated against the capabilities
 *                   ARC holds evidence for today (see `capabilityEvidence`)
 *   onboarding      the registry's `activationTestKeys`, against the ticked checklist
 *   module checks   anything a module needs before it may go live that its schema cannot
 *                   express (Lead Recovery: an approved campaign, a sending number)
 *   evidence        a synthetic test, and shadow evidence where required, of exactly the
 *                   versions that would be authorised
 *
 * Every blocker carries a stable code and a sentence; none carries a configuration value.
 */

import { type Resolution } from '../config/compose.ts';
import { resolveEffectiveConfig } from '../config/engine.ts';
import { TENANT_SCOPE, moduleScope, type ConfigFailure } from '../config/model.ts';
import type { ConfigStore } from '../config/store.ts';
import { canActivate, REQUIRED_STEPS } from '../lead-recovery-config.ts';
import { getCapability } from '../registry/capabilities.ts';
import { connectorsProviding } from '../registry/connectors.ts';
import { getModule, latestSelectableModuleVersion, type ModuleVersion } from '../registry/modules.ts';
import { evaluateCapabilities, requiredCapabilities } from '../registry/resolve.ts';
import {
  type LifecycleRow,
  normaliseRequirements,
  parseLifecycleState,
  type Requirement,
  samePair,
  type VersionPair,
} from './model.ts';
import { healthPermits } from './policy.ts';
import type { LifecycleStore } from './store.ts';

export interface Blocker {
  code: string;
  message: string;
}

/* ── configuration ──────────────────────────────────────── */

export type ConfigReadiness =
  | { ready: true; resolution: Resolution; versions: VersionPair; configHash: string }
  | { ready: false; code: string; message: string; fieldErrors: { path: string; message: string }[] };

/**
 * Whether the module's effective configuration can be proven: both scopes published,
 * composable, and valid by the registered schema today. A draft never counts — the
 * resolver reads published versions only — and nothing is defaulted.
 */
export async function evaluateConfigReadiness(
  store: ConfigStore,
  tenantId: string,
  moduleKey: string,
): Promise<ConfigReadiness> {
  const resolution = await resolveEffectiveConfig(store, tenantId, moduleKey);
  if (!resolution.ok) {
    const failure = resolution as ConfigFailure;
    return {
      ready: false,
      code: failure.code,
      message: failure.message,
      /* paths and the validator's sentences. the validators name fields, not values. */
      fieldErrors: (failure.fieldErrors ?? []).slice(0, 20),
    };
  }
  return {
    ready: true,
    resolution,
    versions: { tenantVersionId: resolution.tenantVersion.id, moduleVersionId: resolution.moduleVersion.id },
    configHash: resolution.configHash,
  };
}

/** The current published pair, or null. Cheaper than a resolution when only ids matter. */
export async function currentHeads(store: ConfigStore, tenantId: string, moduleKey: string): Promise<VersionPair | null> {
  const [tenant, module] = await Promise.all([
    store.getConfigHead(tenantId, TENANT_SCOPE),
    store.getConfigHead(tenantId, moduleScope(moduleKey)),
  ]);
  return tenant && module ? { tenantVersionId: tenant.id, moduleVersionId: module.id } : null;
}

/* ── connections — the seam ARC-130 replaces ─────────────── */

/**
 * What ARC can prove about a capability, before ARC-130 gives tenants real connections.
 *
 *   ready        evidence exists that ARC's adapter can do this for this tenant
 *   missing      a thing the capability needs is absent (no number, no intake key)
 *   invalid      present but unusable
 *   expired      a credential that was valid is not now — ARC-130's, reserved
 *   unhealthy    the health overlay names this capability as failing
 *   unsupported  no available connector provides it
 *   unknown      nothing proves it either way — never treated as ready
 */
export const CAPABILITY_STATUSES = ['ready', 'missing', 'invalid', 'expired', 'unhealthy', 'unsupported', 'unknown'] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];

export interface CapabilityReadiness {
  capability: string;
  status: CapabilityStatus;
  reason: string;
  /** whether a blocking requirement group of the module version uses it. */
  required: boolean;
}

export interface ConnectionEvidence {
  /** the effective configuration: holds non-secret provider references (a number, a SID). */
  config: Record<string, unknown> | null;
  completedSteps: readonly string[];
  hasActiveIntakeKey: boolean;
  /** capabilities the health overlay reports as failing. */
  unhealthyCapabilities: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The evidence ARC holds for one capability. Keyed on the connector that provides it, so a
 * module is judged on what its connectors can prove — never on a provider brand in the
 * module's own requirements (ARC-100 §13).
 *
 * Twilio: the tenant's configuration names a number and a messaging service, and an
 * operator attested the resources are connected (`twilio_connected`) — for the voice
 * capabilities, also that a routing dry-run was checked (`routing_tested`). The ARC web
 * intake: an unrevoked intake key. Anything else: unknown until ARC-130 records a
 * connection. A configured reference is never taken as proof of health.
 */
export function capabilityEvidence(capability: string, evidence: ConnectionEvidence): { status: CapabilityStatus; reason: string } {
  if (!getCapability(capability)) return { status: 'unsupported', reason: `${capability} is not a registered capability` };
  const connectors = connectorsProviding(capability).map((v) => v.connectorKey);
  if (connectors.length === 0) return { status: 'unsupported', reason: `no available connector provides ${capability}` };
  if (evidence.unhealthyCapabilities.includes(capability)) {
    return { status: 'unhealthy', reason: `the health overlay reports ${capability} as failing` };
  }

  const done = new Set(evidence.completedSteps);
  const reasons: string[] = [];
  for (const connector of connectors) {
    if (connector === 'twilio') {
      const twilio = isRecord(evidence.config) && isRecord(evidence.config.twilio) ? evidence.config.twilio : null;
      if (!twilio?.phone_number || !twilio?.messaging_service_sid) {
        reasons.push('no Twilio number and messaging service are recorded');
        continue;
      }
      if (!done.has('twilio_connected')) {
        reasons.push('nobody has attested the Twilio resources are connected');
        continue;
      }
      if ((capability === 'receive_calls' || capability === 'receive_call_status') && !done.has('routing_tested')) {
        reasons.push('the voice routing dry-run has not been checked');
        continue;
      }
      return { status: 'ready', reason: 'Twilio references recorded and attested' };
    }
    if (connector === 'arc_web_intake') {
      if (evidence.hasActiveIntakeKey) return { status: 'ready', reason: 'an unrevoked website intake key exists' };
      reasons.push('no unrevoked website intake key');
      continue;
    }
    reasons.push(`no ${connector} connection evidence exists until ARC-130`);
  }
  const missing = reasons.some((r) => /^no (Twilio|unrevoked)/.test(r));
  return { status: missing ? 'missing' : 'unknown', reason: reasons.join('; ') };
}

export interface ConnectionReadiness {
  ready: boolean;
  /** capabilities with evidence — what a test or activation was judged against. */
  readyCapabilities: string[];
  capabilities: CapabilityReadiness[];
  blockers: Blocker[];
}

/**
 * The ARC-100 requirement groups, evaluated against the capabilities ARC can prove.
 * `optional` groups never block; `any_of` needs one; `all_of` needs every one; a
 * `conditional` group binds only when the configuration turns its feature on.
 */
export function evaluateConnectionReadiness(version: ModuleVersion, evidence: ConnectionEvidence): ConnectionReadiness {
  const all = requiredCapabilities(version);
  const everything = [...new Set([...all.required, ...all.optional, ...all.conditional])].sort();
  const capabilities: CapabilityReadiness[] = everything.map((capability) => ({
    capability,
    ...capabilityEvidence(capability, evidence),
    required: all.required.includes(capability),
  }));
  const readyCapabilities = capabilities.filter((c) => c.status === 'ready').map((c) => c.capability);
  const evaluation = evaluateCapabilities(version, readyCapabilities, evidence.config);

  const blockers: Blocker[] = evaluation.outcomes
    .filter((o) => !o.satisfied && o.blocking)
    .map((o) => ({
      code: 'connection_not_ready',
      message: `${o.key}: ${o.missing.map((c) => {
        const found = capabilities.find((x) => x.capability === c);
        return found ? `${c} is ${found.status} (${found.reason})` : `${c} is unknown`;
      }).join('; ')}`,
    }));

  return { ready: evaluation.satisfied, readyCapabilities, capabilities, blockers };
}

/* ── module-specific activation checks ──────────────────── */

/**
 * Anything a module needs before going live that its schema does not express. Registered
 * per module, so the lifecycle engine itself knows nothing about Lead Recovery; a module
 * with no entry has no extra checks.
 */
const MODULE_ACTIVATION_CHECKS: Readonly<Record<string, (config: Record<string, unknown>) => Blocker[]>> = Object.freeze({
  lead_recovery: (config) =>
    /* the same function the pre-ARC-120 gate called, with the checklist handled separately. */
    canActivate(config, [...REQUIRED_STEPS]).blockers.map((message) => ({ code: 'activation_checks_failed', message })),
});

export function moduleActivationChecks(moduleKey: string, config: Record<string, unknown>): Blocker[] {
  const check = MODULE_ACTIVATION_CHECKS[moduleKey];
  return check ? check(config) : [];
}

/* ── the whole activation question ──────────────────────── */

export interface ActivationReadiness {
  ok: boolean;
  blockers: Blocker[];
  /** the versions an activation now would authorise. */
  versions: VersionPair | null;
  config: ConfigReadiness;
  connections: ConnectionReadiness | null;
  onboarding: { required: string[]; missing: string[] };
  test: { satisfied: boolean; evidenceId: string | null; testedVersions: VersionPair | null };
  shadow: { required: boolean; satisfied: boolean; evidenceId: string | null };
  pending: Requirement[];
  health: { status: string; permits: boolean };
}

/**
 * Everything an activation (or a resumption, or entering shadow) would be judged on,
 * with every reason it would fail. `for` narrows the gates: entering shadow needs the
 * configuration, the connections and a passing test, not the checklist or a review.
 */
export async function evaluateActivation(
  store: ConfigStore & LifecycleStore,
  args: { tenantId: string; moduleKey: string; lifecycle: LifecycleRow | null; for: 'activate' | 'shadow' },
): Promise<ActivationReadiness> {
  const { tenantId, moduleKey, lifecycle } = args;
  const blockers: Blocker[] = [];

  const module = getModule(moduleKey);
  const version = latestSelectableModuleVersion(moduleKey);
  if (!module || !version) blockers.push({ code: 'module_unavailable', message: `${moduleKey} has no selectable version in the registry` });
  if (!lifecycle || parseLifecycleState(lifecycle.state) === 'unselected') {
    blockers.push({ code: 'module_not_selected', message: `${moduleKey} is not selected for this client` });
  } else if (!parseLifecycleState(lifecycle.state)) {
    blockers.push({ code: 'lifecycle_state_unknown', message: `the stored lifecycle state "${lifecycle.state}" is not one this build knows` });
  }

  const config = await evaluateConfigReadiness(store, tenantId, moduleKey);
  if (!config.ready) blockers.push({ code: 'config_not_ready', message: config.message });
  const effective = config.ready ? config.resolution.config : null;

  const [completedSteps, hasIntakeKey] = await Promise.all([
    store.listCompletedOnboardingSteps(tenantId, moduleKey),
    store.hasActiveIntakeKey(tenantId),
  ]);
  const unhealthyCapabilities = Array.isArray(lifecycle?.healthEvidence?.capabilities)
    ? (lifecycle!.healthEvidence.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  const connections = version
    ? evaluateConnectionReadiness(version, { config: effective, completedSteps, hasActiveIntakeKey: hasIntakeKey, unhealthyCapabilities })
    : null;
  if (connections && !connections.ready) blockers.push(...connections.blockers);

  const requiredSteps = version ? [...version.safety.activationTestKeys] : [];
  const missingSteps = requiredSteps.filter((s) => !completedSteps.includes(s));

  const versions = config.ready ? config.versions : null;
  const pending = normaliseRequirements(lifecycle?.pendingRequirements ?? []);

  const testSatisfied = Boolean(versions && lifecycle?.testEvidenceId && samePair(lifecycle.tested, versions));
  if (!testSatisfied) {
    blockers.push({
      code: 'test_evidence_missing',
      message: lifecycle?.tested && versions && !samePair(lifecycle.tested, versions)
        ? 'the last passing synthetic test ran against an earlier configuration — run the canary again'
        : 'no passing synthetic test of the current configuration — run the canary',
    });
  }

  const shadowRequired = Boolean(version?.safety.requiresShadowMode) || pending.includes('shadow');
  const shadowSatisfied = Boolean(versions && lifecycle?.shadowEvidenceId && samePair(lifecycle.shadowed, versions));

  if (args.for === 'activate') {
    if (config.ready) blockers.push(...moduleActivationChecks(moduleKey, config.resolution.config));
    if (missingSteps.length > 0) {
      blockers.push({ code: 'onboarding_incomplete', message: `required onboarding steps outstanding: ${missingSteps.join(', ')}` });
    }
    if (shadowRequired && !shadowSatisfied) {
      blockers.push({ code: 'shadow_evidence_missing', message: 'shadow evidence of the current configuration is required — run in shadow and record a review' });
    }
    /* retest and shadow are satisfied by evidence, above; review and reactivation by this
       activation itself. anything else pending is a requirement this build does not know. */
    const unknown = (lifecycle?.pendingRequirements ?? []).filter((r) => !['retest', 'shadow', 'review', 'reactivation'].includes(r));
    if (unknown.length > 0) {
      blockers.push({ code: 'requirements_pending', message: `unrecognised requirements are pending: ${unknown.join(', ')}` });
    }
  }

  const healthStatus = lifecycle?.healthStatus ?? 'unverified';
  const healthOk = healthPermits(healthStatus, args.for === 'shadow' ? 'shadow' : 'activate');
  if (!healthOk) {
    blockers.push({ code: 'health_blocks_activation', message: `health is ${healthStatus}${lifecycle?.healthReason ? ` — ${lifecycle.healthReason}` : ''}` });
  }

  return {
    ok: blockers.length === 0,
    blockers,
    versions,
    config,
    connections,
    onboarding: { required: requiredSteps, missing: missingSteps },
    test: { satisfied: testSatisfied, evidenceId: lifecycle?.testEvidenceId ?? null, testedVersions: lifecycle?.tested ?? null },
    shadow: { required: shadowRequired, satisfied: shadowSatisfied, evidenceId: lifecycle?.shadowEvidenceId ?? null },
    pending,
    health: { status: healthStatus, permits: healthOk },
  };
}
