/**
 * The registry's public surface.
 *
 * Two audiences, and the split between them is load-bearing:
 *
 *   - `modules.ts` and `capabilities.ts` are **portal-safe**. Pure metadata, no
 *     validators, importable by the browser bundle.
 *   - `schemas.ts` is **server-side**. It imports the Lead Recovery validator, which
 *     has no business in a client bundle.
 *
 * Importing this barrel pulls in both, so it is for edge functions and tests. Portal
 * code imports `registry/modules.ts` directly.
 */

export * from './capabilities.ts';
export * from './modules.ts';
export * from './connectors.ts';
export * from './schemas.ts';
export * from './resolve.ts';

import { getModuleVersion, latestSelectableModuleVersion, type ModuleVersion } from './modules.ts';
import { getConfigSchema, type ConfigSchema } from './schemas.ts';
import { validateConnectorRegistry } from './connectors.ts';
import { validateModuleRegistry } from './modules.ts';

/**
 * Everything the running engine needs to know about a module version, resolved in
 * one call.
 *
 * This is the adapter ARC-100 exists to provide: the engine stops importing the Lead
 * Recovery validator by name and asks the registry for "the schema belonging to the
 * version this run is pinned to". Today that resolves to exactly the same function it
 * always called, which is the point — the registry becomes load-bearing without any
 * behavioural change to prove.
 */
export interface ResolvedModule {
  version: ModuleVersion;
  schema: ConfigSchema;
}

export function resolveModuleRuntime(moduleKey: string, version?: number): ResolvedModule | null {
  const moduleVersion = version === undefined
    ? latestSelectableModuleVersion(moduleKey)
    : getModuleVersion(moduleKey, version);
  if (!moduleVersion || !moduleVersion.configSchemaKey) return null;

  const schema = getConfigSchema(moduleVersion.configSchemaKey, moduleVersion.configSchemaVersion ?? undefined);
  if (!schema) return null;

  return { version: moduleVersion, schema };
}

/**
 * Resolve the trusted validator for a module version.
 *
 * Returns null rather than a permissive fallback when nothing is registered. A caller
 * that cannot find a validator must refuse the configuration, never accept it — which
 * is why this signature has no "or else" branch.
 */
export function validatorFor(moduleKey: string, version?: number): ConfigSchema['validate'] | null {
  return resolveModuleRuntime(moduleKey, version)?.schema.validate ?? null;
}

/** Runs every registry self-check. Called by the drift tests and safe to call anywhere. */
export function validateRegistries(): void {
  validateModuleRegistry();
  validateConnectorRegistry();
}
