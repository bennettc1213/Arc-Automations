/**
 * One spelling of a phone number.
 *
 * A suppression list holding "(614) 555-0137" does not match "+16145550137", and the
 * consequence of that mismatch is a text to somebody who typed STOP. So every number that
 * enters the system — from a Twilio webhook, a web form, an operator's keyboard — is
 * normalised to E.164 here, once, and stored that way. Nothing downstream compares numbers
 * in any other shape.
 *
 * North-America-only defaulting, said out loud: a bare ten-digit string is assumed to be
 * +1, because this product is sold to owner-operated HVAC and plumbing companies in the
 * United States and a ten-digit number with no country code is one of theirs. Anything
 * already carrying a `+` is taken as written. A number that fits neither reading is
 * rejected rather than guessed at.
 */

const E164 = /^\+[1-9][0-9]{7,15}$/;

export function normalisePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '') return null;

  /* an explicit country code is never second-guessed. */
  if (raw.startsWith('+')) {
    const cleaned = `+${raw.slice(1).replace(/[^0-9]/g, '')}`;
    return E164.test(cleaned) ? cleaned : null;
  }

  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164.test(value);
}

/**
 * Last four, for anywhere a whole number would be more than is needed.
 *
 * The run log and the ops console both name a customer by the end of their number; the
 * whole thing lives on the lead row, where it belongs, and is read by the people who are
 * allowed to call them.
 */
export function maskPhone(value: unknown): string | null {
  const phone = typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
  if (phone.length < 4) return null;
  return `•••${phone.slice(-4)}`;
}

/** A lowercased, trimmed email, or null. Suppression matching needs one spelling here too. */
export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (value === '' || value.length > 200) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : null;
}
