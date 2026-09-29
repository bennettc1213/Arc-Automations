/**
 * ARC-220 — signing both directions of the bridge (ADR ARC-010 §18, §24).
 *
 *   ARC → n8n   a JWT (HS256) in the Authorization header. n8n's Webhook node verifies it
 *               natively — signature and `exp` — so no in-workflow code can be edited away
 *               to skip the check. The token is bound to one body (`body_sha256`), one
 *               attempt (`sub`) and one dispatch (`jti`, the single-use nonce).
 *   n8n → ARC   also a JWT (HS256), signed by n8n's own JWT node with a secret held in an n8n
 *               credential — never in a workflow (ADR amendment, ARC-240). It is bound to one
 *               purpose (envelope, callback or failure), one body (`body_sha256` of the exact
 *               bytes sent), a five-minute window and a single-use `jti` that 0018's
 *               `claim_runner_nonce` refuses on replay. All of it is checked before the body
 *               is parsed — the discipline of the Twilio webhook, in a form n8n can produce.
 *
 * Two secrets, never one: the dispatch secret is shared with n8n's JWT credential on its
 * webhooks, the callback secret with the credential its JWT node signs with. Both are held
 * as `SecretValue` and revealed only here, at the moment of signing or verifying. Web Crypto
 * only — the same code runs in Deno and in Node's test runner.
 */

import type { SecretValue } from '../connections/redact.ts';

const encoder = new TextEncoder();

/** Who an n8n → ARC token is for. */
export const BRIDGE_AUDIENCE = 'arc-runner-bridge';
/** What an n8n → ARC token may be used for — one each, never interchangeably. */
export const BRIDGE_PURPOSES = ['envelope', 'callback', 'failure'] as const;
export type BridgePurpose = typeof BRIDGE_PURPOSES[number];

/** How far an inbound token's issue time may be from ARC's clock, and the most it may live. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** How long a presented nonce is remembered — longer than the window it guards. */
export const NONCE_TTL_SECONDS = 900;

const NONCE = /^[A-Za-z0-9_-]{16,100}$/;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacKey(secret: SecretValue<string>, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const raw = secret.reveal();
  if (typeof raw !== 'string' || raw.length < 32) throw new Error('a bridge secret is at least 32 characters');
  return await crypto.subtle.importKey('raw', encoder.encode(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/* ── ARC → n8n ────────────────────────────────────────────── */

export interface DispatchClaims {
  iss: 'arc';
  /** the runner key the dispatch is for. */
  aud: string;
  /** the job id — ARC's attempt id. */
  sub: string;
  /** the dispatch's single-use nonce. */
  jti: string;
  iat: number;
  exp: number;
  tenant_id: string;
  body_sha256: string;
}

async function signHs256(claims: object, secret: SecretValue<string>): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/** HS256 only — a token naming any other algorithm (or none) is refused, never downgraded. */
async function verifyHs256(
  token: string,
  secret: SecretValue<string>,
): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; code: 'malformed' | 'bad_signature' }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'malformed' };
  const [h, p, s] = parts;
  const headerBytes = fromBase64url(h);
  const payloadBytes = fromBase64url(p);
  const signature = fromBase64url(s);
  if (!headerBytes || !payloadBytes || !signature) return { ok: false, code: 'malformed' };
  let header: { alg?: unknown };
  let claims: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (header?.alg !== 'HS256' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, code: 'malformed' };
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, encoder.encode(`${h}.${p}`));
  return valid ? { ok: true, claims: claims as Record<string, unknown> } : { ok: false, code: 'bad_signature' };
}

export async function signDispatchToken(claims: DispatchClaims, secret: SecretValue<string>): Promise<string> {
  return await signHs256(claims, secret);
}

/** What n8n does natively, for tests and for any ARC-side check of a token it issued. */
export async function verifyDispatchToken(
  token: string,
  secret: SecretValue<string>,
  nowSeconds: number,
): Promise<{ ok: true; claims: DispatchClaims } | { ok: false; code: 'malformed' | 'bad_signature' | 'expired' }> {
  const verified = await verifyHs256(token, secret);
  if (!verified.ok) return verified;
  const claims = verified.claims as unknown as DispatchClaims;
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { ok: false, code: 'expired' };
  return { ok: true, claims };
}

/* ── n8n → ARC ────────────────────────────────────────────── */

export interface BridgeRequestClaims {
  aud: typeof BRIDGE_AUDIENCE;
  purpose: BridgePurpose;
  iat: number;
  exp: number;
  /** single-use: refused on any second presentation. */
  jti: string;
  /** hex SHA-256 of the exact body bytes sent. */
  body_sha256: string;
}

const CLAIM_KEYS = ['aud', 'purpose', 'iat', 'exp', 'jti', 'body_sha256'];

/**
 * The Authorization header a caller of ARC sends — what the workflows' JWT node produces
 * from the same claims. Used by tests and by the workflow simulator.
 */
export async function signBridgeRequest(
  rawBody: string,
  secret: SecretValue<string>,
  options: { purpose: BridgePurpose; timestamp: number; nonce: string; ttlSeconds?: number },
): Promise<Record<string, string>> {
  const iat = Math.floor(options.timestamp);
  const claims: BridgeRequestClaims = {
    aud: BRIDGE_AUDIENCE, purpose: options.purpose, iat, exp: iat + (options.ttlSeconds ?? 120),
    jti: options.nonce, body_sha256: await sha256Hex(rawBody),
  };
  return { authorization: `Bearer ${await signHs256(claims, secret)}` };
}

export type InboundCheck =
  | { ok: true; nonce: string; issuedAt: number }
  | { ok: false; code: 'missing_signature' | 'invalid_signature' | 'stale_signature' | 'wrong_purpose' | 'body_mismatch' };

/**
 * Verify an inbound request over its raw bytes, before anything reads them: the signature
 * (constant-time, by `crypto.subtle.verify`), then exactly the expected claims, then the
 * window, the purpose and the body's hash. Replay is the caller's next step: the nonce this
 * returns must be claimed once in 0018.
 */
export async function verifyBridgeRequest(
  rawBody: string,
  headers: Record<string, string | null | undefined>,
  secret: SecretValue<string>,
  nowSeconds: number,
  purpose: BridgePurpose,
): Promise<InboundCheck> {
  const authorization = headers.authorization ?? '';
  if (!authorization) return { ok: false, code: 'missing_signature' };
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
  if (!token) return { ok: false, code: 'invalid_signature' };
  const verified = await verifyHs256(token, secret);
  if (!verified.ok) return { ok: false, code: 'invalid_signature' };

  const c = verified.claims;
  const keys = Object.keys(c);
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((k) => k in c)) return { ok: false, code: 'invalid_signature' };
  if (c.aud !== BRIDGE_AUDIENCE || !(BRIDGE_PURPOSES as readonly unknown[]).includes(c.purpose)
      || !Number.isInteger(c.iat) || !Number.isInteger(c.exp) || typeof c.jti !== 'string' || !NONCE.test(c.jti)
      || typeof c.body_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.body_sha256)) {
    return { ok: false, code: 'invalid_signature' };
  }
  const iat = c.iat as number;
  const exp = c.exp as number;
  if (exp <= iat || exp - iat > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, code: 'invalid_signature' };
  // checked after the signature, so a stale-but-forged request is reported as forged.
  if (Math.abs(nowSeconds - iat) > SIGNATURE_TOLERANCE_SECONDS || exp <= nowSeconds) return { ok: false, code: 'stale_signature' };
  if (c.purpose !== purpose) return { ok: false, code: 'wrong_purpose' };
  if (c.body_sha256 !== await sha256Hex(rawBody)) return { ok: false, code: 'body_mismatch' };
  return { ok: true, nonce: c.jti, issuedAt: iat };
}
