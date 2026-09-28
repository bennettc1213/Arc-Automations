/**
 * ARC-130 — which environment this code believes it is in, failing closed.
 *
 * `ARC_ENVIRONMENT` is `production`, `staging`, `development` or `test`. Anything else —
 * including the variable being absent, which is what a hosted function that nobody
 * configured looks like — is treated as **production**. So a test double (the in-memory
 * credential store, the synthetic providers) can only ever start where someone has said,
 * in so many words, that this is not production; forgetting to say so gets Vault and the
 * real registry, never the fake.
 */

import { ConnectionError } from './model.ts';

export const RUNTIME_ENVIRONMENTS = ['production', 'staging', 'development', 'test'] as const;
export type RuntimeEnvironment = typeof RUNTIME_ENVIRONMENTS[number];

/** Environments where only real mechanisms may run. Staging rehearses production. */
export const PRODUCTION_CAPABLE: readonly RuntimeEnvironment[] = ['production', 'staging'];

export function resolveRuntimeEnvironment(value: unknown): RuntimeEnvironment {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (RUNTIME_ENVIRONMENTS as readonly string[]).includes(v) ? v as RuntimeEnvironment : 'production';
}

/** Throws unless the environment is explicitly development or test. */
export function assertTestDoubleAllowed(environment: RuntimeEnvironment, what: string): void {
  if (PRODUCTION_CAPABLE.includes(environment)) {
    throw new ConnectionError('environment_forbidden', `${what} is a test double and may not run in ${environment}`);
  }
}
