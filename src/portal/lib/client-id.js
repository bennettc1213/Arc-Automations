/* client IDs, and the ingest tokens that get minted alongside them.
 *
 * the ID is what a client types to sign in, so every decision here is about a
 * string that gets read off a phone screen, written on a whiteboard, and dictated
 * over a bad phone line.
 *
 * the alphabet is Crockford base32 — the digits plus the letters, minus I, L, O
 * and U. I and L are 1, O is 0, and U is dropped so no ID ever spells anything.
 * that leaves 32 symbols, eight of them per ID: 40 bits, which is far past
 * guessing and still short enough to say out loud in one breath.
 *
 * this file mirrors normaliseClientId in supabase/functions/client-login. the
 * duplication is deliberate and small: the browser has to reject a malformed ID
 * before spending a network round trip on it, and the server can never trust the
 * browser to have done so.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY = /^[0-9A-HJ-KM-NP-TV-Z]{8}$/;

export const CLIENT_ID_EXAMPLE = 'ARC-4K7P-92QX';

/* 32 divides 256 exactly, so masking the low five bits of a random byte is
   unbiased — no rejection sampling needed, and no Math.random anywhere near a
   string that selects an account. */
function randomSymbols(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ALPHABET[byte % 32]).join('');
}

export function generateClientId() {
  const body = randomSymbols(8);
  return `ARC-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * whatever was typed, as a client ID — or null.
 *
 * people paste the ID out of an email with a trailing space, type it lowercase,
 * and leave the dashes out. none of those is a different ID and none is worth an
 * error message. O, I, L and U are folded to the symbols they were misread from,
 * because the alphabet does not contain them: anyone who typed an O meant a zero.
 */
export function normaliseClientId(raw) {
  if (typeof raw !== 'string') return null;

  const body = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^ARC/, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');

  if (!BODY.test(body)) return null;
  return `ARC-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * the same folding, applied on every keystroke, without demanding a complete ID.
 *
 * the sign-in box formats as you type rather than validating on submit: a field
 * that silently accepts twenty characters and then says "not a client id" has
 * watched you make the mistake and said nothing.
 */
export function formatClientIdInput(raw) {
  const body = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^ARC/, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
    .slice(0, 8);

  if (body.length === 0) return '';
  if (body.length <= 4) return `ARC-${body}`;
  return `ARC-${body.slice(0, 4)}-${body.slice(4)}`;
}

export function isClientId(value) {
  return normaliseClientId(value) !== null;
}

/**
 * a fresh ingest token, in the shape the edge function expects.
 *
 * 24 bytes, base64url. longer and less speakable than a client ID on purpose:
 * this one is pasted into an n8n credential and never read by a human, so
 * legibility buys nothing and entropy buys everything.
 */
export function generateIngestToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `arc_${b64}`;
}

/**
 * SHA-256, hex, matching hashToken in the ingest function byte for byte.
 *
 * the raw token is hashed here and only the hash is stored, so the value shown
 * once on screen is the only copy that ever exists. a database read cannot be
 * replayed as write access to a client's pipeline, which is the entire reason
 * the tokens table holds a digest instead of a secret.
 */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* a slug from a company name, for the tenant's human-readable handle. kept
   alongside the ID generator because both answer "what do we call this account"
   and both have to be unique. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
