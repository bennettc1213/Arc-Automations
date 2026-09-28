/**
 * ARC-130 — keeping secrets out of everything that is not the secret store.
 *
 * Three tools, used everywhere a credential could leak:
 *
 *   SecretValue      holds a raw secret in a private field. Serialising, printing,
 *                    interpolating or inspecting it yields `[redacted]`; only `reveal()`
 *                    returns the value, and only the credential service and a provider
 *                    adapter call it, immediately before the one request that needs it.
 *   redactUrl        strips every query parameter and fragment that could carry a code,
 *                    a state, a verifier or a token before a URL is logged.
 *   redactDeep       replaces secret-named fields and secret-shaped strings anywhere in a
 *                    structure before it is logged, audited or returned.
 *
 * `safeLog` is the only logger ARC-130 code uses. It never receives a provider response
 * body — adapters classify errors into codes first (adapter.ts).
 */

const REDACTED = '[redacted]';

const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|token|code|authorization_?code|state|nonce|code_?verifier|verifier|client_?secret|secret|api_?key|apikey|password|passwd|authorization|auth_?token|private_?key|credential|credentials|bearer|cookie|set-cookie|session|vault_?secret_?id|secret_?ref|secret_?id)$/i;

/** Strings that look like a credential whatever field they are in. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,   // a JWT
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const DENO_INSPECT = Symbol.for('Deno.customInspect');

export class SecretValue<T = string> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
    Object.freeze(this);
  }
  /** The raw secret. Call only at the point of use, and never pass the result onward. */
  reveal(): T {
    return this.#value;
  }
  toJSON(): string { return REDACTED; }
  toString(): string { return REDACTED; }
  [Symbol.toPrimitive](): string { return REDACTED; }
  [INSPECT](): string { return `SecretValue(${REDACTED})`; }
  [DENO_INSPECT](): string { return `SecretValue(${REDACTED})`; }
}

export function isSecretValue(value: unknown): value is SecretValue<unknown> {
  return value instanceof SecretValue;
}

/** A URL with its query and fragment reduced to parameter names. Unparseable → a marker. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const seen = new Set<string>();
    url.searchParams.forEach((_value, name) => seen.add(name));
    const names = [...seen];
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return names.length ? `${url.toString()}?[${names.join(',')}: ${REDACTED}]` : url.toString();
  } catch {
    return '[unparseable url]';
  }
}

export function looksSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

/**
 * A copy of `value` safe to log, audit or return: secret-named keys and secret-shaped
 * strings replaced, `SecretValue`s replaced, URLs with queries reduced, depth bounded.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (isSecretValue(value)) return REDACTED;
  if (typeof value === 'string') {
    if (looksSecret(value)) return REDACTED;
    if (/^https?:\/\/\S+[?#]/.test(value)) return redactUrl(value);
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redactDeep(value.message, depth + 1) };
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? REDACTED : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => console.log(line);

/** Tests capture every line ARC-130 would log, and assert no sentinel appears in any. */
export function setConnectionLogSink(next: LogSink | null): void {
  sink = next ?? ((line) => console.log(line));
}

/** The only logger in ARC-130 code: a structured line, redacted before it is formatted. */
export function safeLog(event: string, fields: Record<string, unknown> = {}): void {
  sink(JSON.stringify({ event: `arc_connections.${event}`, ...(redactDeep(fields) as Record<string, unknown>) }));
}
