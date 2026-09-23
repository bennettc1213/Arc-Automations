/**
 * Capability resolution.
 *
 * Pure and deterministic: given a module version and a set of capability keys, decide
 * which requirement groups are satisfied and explain any that are not. No I/O, no
 * clock, no tenant.
 *
 * **What this deliberately cannot tell you.** Whether a tenant has connected anything,
 * whether a credential is still valid, whether a connection is healthy. Those are live
 * facts owned by ARC-130 (connections) and ARC-120 (lifecycle), and answering them
 * here from static declarations is exactly the mistake that would let a module
 * activate against a revoked token. This answers a design question — *could* this
 * shape of connection serve this module — and the callers above it supply reality.
 */

import { getCapability } from './capabilities.ts';
import { connectorsProviding } from './connectors.ts';
import type { CapabilityRequirement, ModuleVersion } from './modules.ts';

export interface RequirementOutcome {
  key: string;
  kind: CapabilityRequirement['kind'];
  satisfied: boolean;
  /** true when failing this stops activation. optional groups never do. */
  blocking: boolean;
  required: readonly string[];
  present: string[];
  missing: string[];
  explanation: string;
  /** connector versions that could close the gap, for an operator to act on. */
  couldBeSatisfiedBy: { connectorKey: string; version: number }[];
}

export interface CapabilityEvaluation {
  moduleKey: string;
  moduleVersion: number;
  satisfied: boolean;
  outcomes: RequirementOutcome[];
  /** every capability still missing from a blocking group. */
  missingCapabilities: string[];
  /** human-readable reasons, blocking ones first. */
  reasons: string[];
}

/** Whether a requirement group blocks activation when unmet. */
function isBlocking(requirement: CapabilityRequirement, config: Record<string, unknown> | null): boolean {
  if (requirement.kind === 'optional') return false;
  if (requirement.kind === 'conditional') {
    /* conditional groups bind only when the configuration turns the feature on. with
       no configuration to read, a conditional requirement is treated as not yet
       binding rather than as failing — the caller has not said which mode it wants. */
    if (!config || !requirement.whenConfigField) return false;
    return Boolean(readPath(config, requirement.whenConfigField));
  }
  return true;
}

/** Dotted-path read, so a conditional can point at `booking.mode`. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function satisfies(requirement: CapabilityRequirement, present: Set<string>): boolean {
  const have = requirement.capabilities.filter((c) => present.has(c));
  if (requirement.kind === 'any_of') return have.length > 0;
  return have.length === requirement.capabilities.length;
}

/**
 * Evaluate a module version against a set of capabilities.
 *
 * `available` is whatever the caller can vouch for. ARC-120 will pass the capabilities
 * of a tenant's *healthy, authorised* connections; a design-time caller can pass
 * `availableCapabilities()` to ask whether the module is buildable at all.
 */
export function evaluateCapabilities(
  version: ModuleVersion,
  available: readonly string[],
  config: Record<string, unknown> | null = null,
): CapabilityEvaluation {
  const present = new Set(available);
  const outcomes: RequirementOutcome[] = [];
  const missingCapabilities = new Set<string>();
  const reasons: string[] = [];

  for (const requirement of version.requirements) {
    const blocking = isBlocking(requirement, config);
    const ok = satisfies(requirement, present);
    const have = requirement.capabilities.filter((c) => present.has(c));
    const missing = requirement.capabilities.filter((c) => !present.has(c));

    let explanation: string;
    if (ok) {
      explanation = `satisfied by ${have.join(', ')}`;
    } else if (requirement.kind === 'any_of') {
      explanation = `needs at least one of ${requirement.capabilities.join(', ')} — none present`;
    } else {
      explanation = `missing ${missing.join(', ')}`;
    }

    outcomes.push({
      key: requirement.key,
      kind: requirement.kind,
      satisfied: ok,
      blocking,
      required: requirement.capabilities,
      present: have,
      missing,
      explanation,
      couldBeSatisfiedBy: missing.flatMap((capability) =>
        connectorsProviding(capability).map((v) => ({ connectorKey: v.connectorKey, version: v.version })),
      ),
    });

    if (!ok && blocking) {
      for (const capability of missing) missingCapabilities.add(capability);
      reasons.push(`${requirement.description} (${explanation})`);
    }
  }

  /* non-blocking gaps are reported after the blocking ones, so the first line an
     operator reads is always the thing actually stopping them. */
  for (const outcome of outcomes) {
    if (!outcome.satisfied && !outcome.blocking) {
      reasons.push(`optional: ${outcome.explanation}`);
    }
  }

  return {
    moduleKey: version.moduleKey,
    moduleVersion: version.version,
    satisfied: outcomes.every((o) => o.satisfied || !o.blocking),
    outcomes,
    missingCapabilities: [...missingCapabilities].sort(),
    reasons,
  };
}

/** Every capability a version can use, blocking or not. */
export function requiredCapabilities(version: ModuleVersion): {
  required: string[];
  optional: string[];
  conditional: string[];
} {
  const required = new Set<string>();
  const optional = new Set<string>();
  const conditional = new Set<string>();
  for (const requirement of version.requirements) {
    const target = requirement.kind === 'optional'
      ? optional
      : requirement.kind === 'conditional'
        ? conditional
        : required;
    for (const capability of requirement.capabilities) target.add(capability);
  }
  return {
    required: [...required].sort(),
    optional: [...optional].sort(),
    conditional: [...conditional].sort(),
  };
}

/**
 * Whether a connector version is compatible with a module version.
 *
 * Compatibility means "this adapter provides at least one capability this module can
 * use" — not that it is sufficient on its own. Lead Recovery needs both Twilio and,
 * for web leads, the intake connector; neither alone satisfies every group.
 */
export function isCompatible(
  version: ModuleVersion,
  connector: { capabilities: readonly string[] },
): { compatible: boolean; provides: string[] } {
  const wanted = new Set<string>();
  for (const requirement of version.requirements) {
    for (const capability of requirement.capabilities) wanted.add(capability);
  }
  const provides = connector.capabilities.filter((c) => wanted.has(c)).sort();
  return { compatible: provides.length > 0, provides };
}

/** Capabilities that reach a member of the public. ARC-120 gates these hardest. */
export function externalEffectCapabilities(version: ModuleVersion): string[] {
  const { required, optional, conditional } = requiredCapabilities(version);
  return [...required, ...optional, ...conditional]
    .filter((key) => getCapability(key)?.externalSideEffect)
    .sort();
}
