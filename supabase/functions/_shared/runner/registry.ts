/**
 * ARC-210 — which runners this process can hand work to.
 *
 * A registry is built once, from the runners a deployment wires in, and never changes
 * while it runs. A run names its runner kind (or is assigned the default at its first
 * start, which 0017 then fixes on the run for good); a kind the registry does not hold
 * resolves to nothing, and the orchestrator refuses the attempt rather than guessing at a
 * substitute — a different runner is a different execution path, not a fallback.
 */

import { type AutomationRunner, RUNNER_KIND } from './model.ts';

export interface RunnerRegistry {
  readonly defaultKind: string;
  kinds(): string[];
  resolve(kind: string | null | undefined): AutomationRunner | null;
}

export function createRunnerRegistry(runners: readonly AutomationRunner[], options: { defaultKind: string }): RunnerRegistry {
  const byKind = new Map<string, AutomationRunner>();
  for (const runner of runners) {
    if (!runner || typeof runner.kind !== 'string' || !RUNNER_KIND.test(runner.kind)) {
      throw new Error(`a runner kind is a lower-case identifier, not ${JSON.stringify(runner?.kind)}`);
    }
    if (byKind.has(runner.kind)) throw new Error(`two runners claim the kind ${runner.kind}`);
    byKind.set(runner.kind, runner);
  }
  if (!byKind.has(options.defaultKind)) throw new Error(`the default runner ${options.defaultKind} is not registered`);
  return Object.freeze({
    defaultKind: options.defaultKind,
    kinds: () => [...byKind.keys()],
    resolve: (kind: string | null | undefined) => (typeof kind === 'string' ? byKind.get(kind) ?? null : null),
  });
}
