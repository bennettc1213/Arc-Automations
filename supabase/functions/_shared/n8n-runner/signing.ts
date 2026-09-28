/**
 * ARC-220 — signing both directions of the bridge (ADR ARC-010 §18, §24).
 *
 *   ARC → n8n   a JWT (HS256) in the Authorization header. n8n's Webhook node verifies it
 *               natively — signature and `exp` — so no in-workflow code can be edited away
 *               to skip the check. The token is bound to one body (`body_sha256`), one
 *               attempt (`sub`) and one dispatch (`jti`, the single-use nonce).
 *   n8n → ARC   HMAC-SHA256 over `timestamp.nonce.rawBody`, verified before the body is
 *               parsed, within a five-minute window, with the nonce refused on replay by
 *               0018's `claim_runner_nonce` — the same discipline as the Twilio webhook.
 *
 * Two secrets, never one: the dispatch secret is shared with n8n's JWT credential, the
 * callback secret with the workflows that call back. Both are held as `SecretValue` and
 * revealed only here, at the moment of signing or verifying. Web Crypto only — the same
 * code runs in Deno and in Node's test runner.
 */

import type { SecretValue } from '../connections/redact.ts';

const encoder = new TextEncoder();

export const BRIDGE_HEADERS = Object.freeze({
  timestamp: 'x-arc-timestamp',
  nonce: 'x-arc-nonce',
  signature: 'x-arc-signature',
});

/** How far an inbound timestamp may be from ARC's clock. */
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

function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) return null;
  return Uint8Array.from(text.match(/../g)!.map((h) => parseInt(h, 16)));
}

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

export async function signDispatchToken(claims: DispatchClaims, secret: SecretValue<string>): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * What n8n does natively, for tests and for any ARC-side check of a token it issued.
 * HS256 only — a token naming any other algorithm is refused, never downgraded.
 */
export async function verifyDispatchToken(
  token: string,
  secret: SecretValue<string>,
  nowSeconds: number,
): Promise<{ ok: true; claims: DispatchClaims } | { ok: false; code: 'malformed' | 'bad_signature' | 'expired' }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'malformed' };
  const [h, p, s] = parts;
  const headerBytes = fromBase64url(h);
  const payloadBytes = fromBase64url(p);
  const signature = fromBase64url(s);
  if (!headerBytes || !payloadBytes || !signature) return { ok: false, code: 'malformed' };
  let header: { alg?: unknown };
  let claims: DispatchClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (header.alg !== 'HS256') return { ok: false, code: 'malformed' };
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, encoder.encode(`${h}.${p}`));
  if (!valid) return { ok: false, code: 'bad_signature' };
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { ok: false, code: 'expired' };
  return { ok: true, claims };
}

/* ── n8n → ARC ────────────────────────────────────────────── */

const signingBase = (timestamp: string, nonce: string, rawBody: string) => `${timestamp}.${nonce}.${rawBody}`;

/** The headers a caller of ARC sends. Used by the workflows (ARC-240) and by tests. */
export async function signBridgeRequest(
  rawBody: string,
  secret: SecretValue<string>,
  options: { timestamp: number; nonce: string },
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(options.timestamp));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(signingBase(timestamp, options.nonce, rawBody)));
  return {
    [BRIDGE_HEADERS.timestamp]: timestamp,
    [BRIDGE_HEADERS.nonce]: options.nonce,
    [BRIDGE_HEADERS.signature]: `v1=${hex(mac)}`,
  };
}

export type InboundCheck =
  | { ok: true; nonce: string; timestamp: number }
  | { ok: false; code: 'missing_signature' | 'invalid_signature' | 'stale_signature' };

/**
 * Verify an inbound request over its raw bytes, before anything reads them. The MAC is
 * compared by `crypto.subtle.verify`, which is constant-time. Replay is the caller's next
 * step: the nonce this returns must be claimed once in 0018.
 */
export async function verifyBridgeRequest(
  rawBody: string,
  headers: Record<string, string | null | undefined>,
  secret: SecretValue<string>,
  nowSeconds: number,
): Promise<InboundCheck> {
  const timestamp = headers[BRIDGE_HEADERS.timestamp] ?? '';
  const nonce = headers[BRIDGE_HEADERS.nonce] ?? '';
  const signature = headers[BRIDGE_HEADERS.signature] ?? '';
  if (!timestamp || !nonce || !signature) return { ok: false, code: 'missing_signature' };
  if (!/^\d{9,11}$/.test(timestamp) || !NONCE.test(nonce) || !signature.startsWith('v1=')) return { ok: false, code: 'invalid_signature' };
  const mac = fromHex(signature.slice(3));
  if (!mac || mac.length !== 32) return { ok: false, code: 'invalid_signature' };
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), mac, encoder.encode(signingBase(timestamp, nonce, rawBody)));
  if (!valid) return { ok: false, code: 'invalid_signature' };
  // checked after the MAC, so a stale-but-forged request is reported as forged.
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, code: 'stale_signature' };
  return { ok: true, nonce, timestamp: Number(timestamp) };
}
