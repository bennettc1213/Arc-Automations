/**
 * One serialisation, one hash, for everything that identifies configuration by content.
 *
 * Lived in `engine/runtime.ts` while snapshots were its only user (ARC-015). ARC-110's
 * version store hashes published configuration the same way, and importing the engine
 * from the configuration layer would make the two depend on each other — so the pair
 * moved here and the engine re-exports them unchanged.
 */

/**
 * Stable serialisation, so the same configuration always hashes to the same string.
 *
 * `JSON.stringify` preserves insertion order, which means two identical rule sets
 * written by different code paths would hash differently and every run would mint a
 * fresh snapshot. Keys are sorted and `undefined` dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Content identity. Sixty-four hex characters, as every `config_hash` column demands. */
export async function configHash(config: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(config));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
