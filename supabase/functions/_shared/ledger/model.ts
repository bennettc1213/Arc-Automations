/**
 * ARC-MK-210 — the proof ledger's vocabulary: what a person may say about a booked visit,
 * and the pilot terms a fee is worked out under.
 *
 * Portal-safe: it imports nothing, so the rule in the browser (`src/portal/lib/ledger.js`),
 * the engine that writes the evidence and the tests all read the same lists. It stores
 * nothing and decides nothing about a lead — whether a job counts is read off `events` by
 * the ledger rule, never typed here.
 *
 * Three things live here:
 *
 *   - the answers to "did the job happen?" and the seven reasons a job may be disputed.
 *     the reasons are the ones the homepage prints (`site.price.disputeReasons`), drift-tested;
 *   - `parseOutcomeInput` / `parseSettlementInput` / `parseTermsInput`, the one validation each
 *     write goes through;
 *   - the idempotency keys. an answer names the answer it replaces, so a double tap collides
 *     and a changed mind is a new row — and two people answering the same question at once
 *     write one row, not two.
 */

/** the answers to "did the job happen?". `quoted` is a visit that happened with the sale still open. */
export const LEDGER_OUTCOMES = ['happened', 'quoted', 'not_counted'] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/** why a job should not count. the order and the words are the homepage's. */
export const DISPUTE_REASONS = Object.freeze([
  { key: 'spam', label: 'spam' },
  { key: 'wrong_number', label: 'wrong number' },
  { key: 'out_of_area', label: 'out of your area' },
  { key: 'customer_cancelled', label: 'customer cancelled' },
  { key: 'did_not_happen', label: 'job did not happen' },
  { key: 'owner_first', label: 'you got there first' },
  { key: 'duplicate', label: 'duplicate' },
] as const);

export const DISPUTE_REASON_KEYS: readonly string[] = DISPUTE_REASONS.map((reason) => reason.key);

export function disputeReasonLabel(key: unknown): string {
  return DISPUTE_REASONS.find((reason) => reason.key === key)?.label ?? 'no reason given';
}

/**
 * ARC-MK-220 — the six things an owner can tap, in the owner's words.
 *
 * They are the three outcomes and the seven reasons above, grouped the way a person answers
 * on a phone: nothing new is stored. An answer with one reason implies it; one with several
 * asks which. `counts` is what the page tells the owner before the tap, and is only words —
 * whether the job counts is still read off the log by the ledger's rule.
 */
export const OWNER_ANSWERS = Object.freeze([
  { key: 'happened', label: 'sold, or the job happened', outcome: 'happened', reasons: [], counts: true },
  { key: 'quoted', label: 'quoted, not sold yet', outcome: 'quoted', reasons: [], counts: true },
  { key: 'did_not_happen', label: 'did not happen', outcome: 'not_counted', reasons: ['did_not_happen'], counts: false },
  { key: 'not_real', label: 'not a real job', outcome: 'not_counted', reasons: ['spam', 'wrong_number', 'out_of_area'], counts: false },
  { key: 'customer_cancelled', label: 'customer cancelled', outcome: 'not_counted', reasons: ['customer_cancelled'], counts: false },
  { key: 'already_handled', label: 'duplicate, or already handled', outcome: 'not_counted', reasons: ['duplicate', 'owner_first'], counts: false },
] as const);

export const OWNER_ANSWER_KEYS: readonly string[] = OWNER_ANSWERS.map((answer) => answer.key);

/** the tap an outcome and reason on record came from. null when it is not one of the six. */
export function ownerAnswerFor(outcome: unknown, reason: unknown) {
  return (
    OWNER_ANSWERS.find(
      (answer) => answer.outcome === outcome && (answer.reasons.length === 0 || (answer.reasons as readonly string[]).includes(String(reason))),
    ) ?? null
  );
}

/** who recorded an answer. an operator records one only because the owner told them. */
export const ANSWERED_BY = ['owner', 'operator'] as const;

export const SETTLEMENT_DECISIONS = ['accepted', 'rejected'] as const;

/** the longest a dispute window may be. the pilot terms speak of days, not months. */
export const MAX_DISPUTE_WINDOW_DAYS = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** the id of the row this one replaces, or `first`. anything else is refused. */
function parseReplaces(value: unknown, errors: string[]): string {
  if (value === undefined || value === null || value === '' || value === 'first') return 'first';
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  errors.push('replaces must be the id of the row being replaced, or left out for the first one');
  return 'first';
}

export interface OutcomeInput {
  outcome: LedgerOutcome;
  reason: string | null;
  answeredBy: (typeof ANSWERED_BY)[number];
  replaces: string;
}

/**
 * One answer. `not_counted` needs one of the seven reasons; the other two take none — a
 * reason on "it happened" would be a sentence nobody asked for and nothing reads.
 */
export function parseOutcomeInput(input: unknown): Parsed<OutcomeInput> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['an answer is required'] };

  const outcome = input.outcome;
  if (typeof outcome !== 'string' || !(LEDGER_OUTCOMES as readonly string[]).includes(outcome)) {
    errors.push(`outcome must be one of ${LEDGER_OUTCOMES.join(', ')}`);
  }

  let reason: string | null = null;
  if (outcome === 'not_counted') {
    if (typeof input.reason !== 'string' || !DISPUTE_REASON_KEYS.includes(input.reason)) {
      errors.push(`a job that should not count needs a reason: ${DISPUTE_REASON_KEYS.join(', ')}`);
    } else reason = input.reason;
  } else if (input.reason !== undefined && input.reason !== null && input.reason !== '') {
    errors.push('a reason is only given when the job should not count');
  }

  const answeredBy = input.answered_by ?? input.answeredBy ?? 'operator';
  if (typeof answeredBy !== 'string' || !(ANSWERED_BY as readonly string[]).includes(answeredBy)) {
    errors.push(`answered_by must be one of ${ANSWERED_BY.join(', ')}`);
  }

  const replaces = parseReplaces(input.replaces, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { outcome: outcome as LedgerOutcome, reason, answeredBy: answeredBy as 'owner', replaces } };
}

/**
 * One tap from the owner's own screen: `{ answer, reason?, replaces? }`.
 *
 * It comes out as the same `OutcomeInput` an operator's entry does, with `answeredBy` fixed
 * at `owner` — a body cannot claim to be anyone, and cannot name an outcome that is not one
 * of the six.
 */
export function parseOwnerAnswer(input: unknown): Parsed<OutcomeInput> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['an answer is required'] };

  const choice = OWNER_ANSWERS.find((answer) => answer.key === input.answer);
  if (!choice) return { ok: false, errors: [`answer must be one of ${OWNER_ANSWER_KEYS.join(', ')}`] };

  const reasons = choice.reasons as readonly string[];
  let reason: string | null = null;
  if (reasons.length === 1) reason = reasons[0];
  else if (reasons.length > 1) {
    if (typeof input.reason !== 'string' || !reasons.includes(input.reason)) errors.push(`this answer needs one of: ${reasons.join(', ')}`);
    else reason = input.reason;
  }
  if (reasons.length <= 1 && input.reason !== undefined && input.reason !== null && input.reason !== '' && input.reason !== reason) {
    errors.push('that reason does not belong to this answer');
  }

  const replaces = parseReplaces(input.replaces, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { outcome: choice.outcome, reason, answeredBy: 'owner', replaces } };
}

/** how the owner was asked. today only the portal asks; a text is a later step. */
export const ASKED_VIA = ['portal'] as const;

export interface SettlementInput {
  decision: (typeof SETTLEMENT_DECISIONS)[number];
  note: string | null;
  /** the id of the answer being settled. a settlement is of one answer, not of a lead. */
  disputeId: string;
}

export function parseSettlementInput(input: unknown): Parsed<SettlementInput> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['a decision is required'] };

  const decision = input.decision;
  if (typeof decision !== 'string' || !(SETTLEMENT_DECISIONS as readonly string[]).includes(decision)) {
    errors.push(`decision must be one of ${SETTLEMENT_DECISIONS.join(', ')}`);
  }
  const disputeId = input.dispute_id ?? input.disputeId;
  if (typeof disputeId !== 'string' || !UUID.test(disputeId)) errors.push('dispute_id must be the id of the answer being settled');

  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim().slice(0, 300) : null;
  /* a rejected dispute bills a job the owner said should not count. it never goes
     unexplained. */
  if (decision === 'rejected' && !note) errors.push('a rejected dispute needs a note saying what the record shows');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { decision: decision as 'accepted', note, disputeId: (disputeId as string).toLowerCase() } };
}

/** the terms a fee is worked out under. money is integer cents, as everywhere else. */
export interface PilotTerms {
  baseCents: number;
  perJobCents: number;
  /** the most a month can cost. null is "no cap agreed". */
  capCents: number | null;
  disputeWindowDays: number;
}

const cents = (value: unknown, field: string, errors: string[]): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_00) {
    errors.push(`${field} must be a whole number of cents, zero or more`);
    return 0;
  }
  return value;
};

export function parseTermsInput(input: unknown): Parsed<PilotTerms & { replaces: string }> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['the terms are required'] };

  const baseCents = cents(input.base_cents, 'base_cents', errors);
  const perJobCents = cents(input.per_job_cents, 'per_job_cents', errors);
  const capCents = input.cap_cents === null || input.cap_cents === undefined ? null : cents(input.cap_cents, 'cap_cents', errors);
  if (capCents !== null && capCents < baseCents) errors.push('cap_cents cannot be less than the monthly base');

  const days = input.dispute_window_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DISPUTE_WINDOW_DAYS) {
    errors.push(`dispute_window_days must be a whole number from 1 to ${MAX_DISPUTE_WINDOW_DAYS}`);
  }

  const replaces = parseReplaces(input.replaces, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { baseCents, perJobCents, capCents, disputeWindowDays: days as number, replaces } };
}

/** the terms as an event carries them, read back. null when the payload is not whole. */
export function termsFromPayload(payload: unknown): PilotTerms | null {
  const parsed = parseTermsInput(payload);
  if (!parsed.ok) return null;
  const { replaces: _replaces, ...terms } = parsed.value;
  return terms;
}

/* ── idempotency ──────────────────────────────────────────── */

export const outcomeEventKey = (correlationId: string, replaces: string) => `ledger:outcome:${correlationId}:${replaces}`;
/** one asking per lead: the window opens once, however many times the question is shown. */
export const askedEventKey = (correlationId: string) => `ledger:asked:${correlationId}`;
export const settlementEventKey =(correlationId: string, disputeId: string) => `ledger:settled:${correlationId}:${disputeId}`;
export const termsEventKey = (replaces: string) => `ledger:terms:${replaces}`;
/** keyed on the visit time, so a rescheduled visit is a new row and the same one is not. */
export const bookingEventKey = (correlationId: string, appointmentAt: string | null) =>
  `lr:booking:${correlationId}:booked:${appointmentAt ?? 'no-time'}`;
export const callAnsweredEventKey = (callSid: string) => `lr:call_answered:${callSid}`;
