/**
 * ARC-MK-220 — the owner's own answer to "did the job happen?", and the asking.
 *
 * The portal's first client write. Two actions, both appending evidence to `events` through
 * the engine's own writers (`recordOutcome`, `requestOutcome`) and touching nothing else:
 *
 *   - `answerOutcome`  one tap from the needs-you screen, for one booked visit;
 *   - `markAsked`      the question was put in front of a signed-in member of the client.
 *
 * and a third since ARC-GO-310, which is the one that changes a lead: `recordVisit`, the
 * owner saying when the visit they agreed is. It is the engine's own `markBooked`.
 *
 * What this file adds to those writers is everything a browser must not be trusted with:
 *
 *   - **who.** The actor is the verified sign-in, and their membership of the tenant was read
 *     from `tenant_members` by the calling function. A body cannot claim a tenant, a role or
 *     `answered_by`. An operator does not answer here — the console's own action records what
 *     an owner told them, and says so.
 *   - **which lead.** By the tenant and the lead's reference together, so another client's
 *     reference finds nothing — the same answer as one that does not exist.
 *   - **whether it can be answered.** There must be a booked visit; "it happened" needs the
 *     visit time to have passed; an answer an operator has already settled is closed.
 *   - **which answer it replaces.** The caller names the answer it read. If that is no longer
 *     the standing one, somebody else answered first: nothing is written over it.
 *
 * Asking opens the dispute window, so it is refused until there are terms on record to open
 * it under, the visit has passed and nobody has answered. It is written once per lead.
 *
 * Nothing here decides whether a job counts. That is still read off the log by the ledger's
 * rule (`src/portal/lib/ledger.js`).
 */

import { markBooked, recordOutcome, requestOutcome, type EngineDeps } from '../engine/runtime.ts';
import { parseOwnerAnswer, termsFromPayload } from './model.ts';

/** one row of evidence, as the log holds it. */
export interface EvidenceRow {
  id: string | null;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown> | null;
}

export interface LedgerDeps {
  engine: EngineDeps;
  /** the ledger's rows for one lead of one tenant, canaries left out. */
  evidence(tenantId: string, correlationId: string): Promise<EvidenceRow[]>;
  /** whether this tenant has whole pilot terms on record. */
  hasTerms(tenantId: string): Promise<boolean>;
}

export type LedgerActor =
  | { kind: 'client_user'; userId: string; tenantId: string; role?: string }
  | { kind: string; [key: string]: unknown };

type Refusal = 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'too_early' | 'settled' | 'conflict';

export type LedgerOutcome<T> = { ok: true; result: T } | { ok: false; code: Refusal; message: string };

export const LEDGER_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  invalid: 422,
  not_found: 404,
  too_early: 409,
  settled: 409,
  conflict: 409,
});

/** the most questions one page load may mark as asked. */
export const MAX_ASKED_PER_CALL = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_TYPES = ['lead_booked', 'lead_outcome_requested', 'lead_outcome_recorded', 'lead_dispute_settled'];

const refuse = (code: Refusal, message: string) => ({ ok: false as const, code, message });

function member(actor: LedgerActor | null, tenantId: unknown): { userId: string; tenantId: string } | { refusal: ReturnType<typeof refuse> } {
  if (!actor) return { refusal: refuse('unauthorized', 'not signed in') };
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return { refusal: refuse('invalid', 'tenant_id is required') };
  if (actor.kind !== 'client_user' || actor.tenantId !== tenantId || typeof actor.userId !== 'string') {
    return { refusal: refuse('forbidden', 'this account does not belong to that client') };
  }
  return { userId: actor.userId, tenantId };
}

/** a lead's reference as the portal holds it: the id its events share. */
const isReference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/**
 * Where one lead's question stands, read off its rows: the visit that stands (the latest
 * booking), whether it was asked, the standing answer and whether an operator settled it.
 */
export function standing(rows: EvidenceRow[], now: Date) {
  const sorted = rows.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const booking = sorted.filter((row) => row.eventType === 'lead_booked').at(-1) ?? null;
  const appointmentAt = typeof booking?.payload?.appointment_at === 'string' ? booking.payload.appointment_at : null;
  const visitMs = appointmentAt ? Date.parse(appointmentAt) : NaN;
  const answerRow = sorted.filter((row) => row.eventType === 'lead_outcome_recorded').at(-1) ?? null;
  const answer = answerRow
    ? {
        id: answerRow.id,
        outcome: (answerRow.payload?.outcome as string) ?? null,
        reason: (answerRow.payload?.reason as string | null) ?? null,
        replaces: (answerRow.payload?.replaces as string) ?? 'first',
        at: answerRow.occurredAt,
      }
    : null;
  const settled = Boolean(
    answer &&
      sorted.some(
        (row) =>
          row.eventType === 'lead_dispute_settled' &&
          (row.payload?.dispute_id ? row.payload.dispute_id === answer.id : row.occurredAt >= answer.at),
      ),
  );
  return {
    booked: Boolean(booking),
    appointmentAt,
    visitPassed: !Number.isNaN(visitMs) && visitMs <= now.getTime(),
    asked: sorted.some((row) => row.eventType === 'lead_outcome_requested'),
    answer,
    settled,
  };
}

export interface AnswerResult {
  outcome: string;
  reason: string | null;
  /** false when this exact answer was already on record: a double tap. */
  written: boolean;
}

export async function answerOutcome(
  deps: LedgerDeps,
  actor: LedgerActor | null,
  args: { tenantId: unknown; lead: unknown; input: unknown },
): Promise<LedgerOutcome<AnswerResult>> {
  const who = member(actor, args.tenantId);
  if ('refusal' in who) return who.refusal;
  if (!isReference(args.lead)) return refuse('invalid', 'lead is required');

  const parsed = parseOwnerAnswer(args.input);
  if (!parsed.ok) return refuse('invalid', parsed.errors.join('; '));
  const { outcome, reason, replaces } = parsed.value;

  const lead = await deps.engine.store.getLeadByCorrelation(who.tenantId, args.lead);
  if (!lead || lead.isCanary) return refuse('not_found', 'there is no such job on this account');

  const now = deps.engine.now();
  const before = standing(await deps.evidence(who.tenantId, lead.correlationId), now);
  if (!before.booked || lead.bookingOutcome !== 'booked') return refuse('invalid', 'this lead has no booked visit to answer for');
  if (outcome !== 'not_counted' && !before.visitPassed) {
    return refuse('too_early', 'the visit time has not passed yet, so there is nothing to confirm');
  }

  const same = (answer: typeof before.answer) => Boolean(answer && answer.outcome === outcome && (answer.reason ?? null) === reason);
  const standingId = before.answer?.id ?? 'first';
  if (replaces !== standingId) {
    /* the page read an older state. the same answer again is a double tap; anything else
       would be written over what somebody else already said. */
    if (same(before.answer) && before.answer?.replaces === replaces) return { ok: true, result: { outcome, reason, written: false } };
    return refuse('conflict', 'this question was already answered. reload to see what was said.');
  }
  if (before.settled) return refuse('settled', 'we have already looked at this one and settled it. reach us if it is wrong.');

  const wrote = await recordOutcome(deps.engine, {
    tenantId: who.tenantId,
    leadId: lead.id,
    input: { outcome, reason, answered_by: 'owner', replaces },
    actorId: who.userId,
  });
  if (!wrote.ok) return refuse('invalid', wrote.outcome);
  if (wrote.written) return { ok: true, result: { outcome, reason, written: true } };

  /* the key was taken between the read and the write: two people, one question. */
  const after = standing(await deps.evidence(who.tenantId, lead.correlationId), now);
  if (same(after.answer)) return { ok: true, result: { outcome, reason, written: false } };
  return refuse('conflict', 'this question was already answered. reload to see what was said.');
}

export interface VisitResult {
  /** the visit time as recorded, an instant. */
  appointmentAt: string;
}

/** how far ahead a visit may be put down. past that it is a typing mistake. */
export const MAX_VISIT_DAYS_AHEAD = 365;
/** and how far back: a visit already made can be put down late, but not from last season. */
export const MAX_VISIT_DAYS_BEHIND = 60;

/**
 * The owner agreed a visit with the customer and says when it is (ARC-GO-310).
 *
 * The ledger's fifth link, and until this existed no screen could write it, so no job could
 * ever count. It goes through the engine's own `markBooked` — the same call an operator's
 * console makes — so a booking is one thing whoever records it: the automation stops, and
 * one `lead_booked` row carries the time. A changed time is a second row and the first
 * stays on the record. Nothing here says the visit happened; that is still the question
 * asked afterwards.
 *
 * Refused: a time that is not a date, one more than two months back or more than a year
 * ahead, a lead the customer opted out of, and a visit somebody has already answered about.
 */
export async function recordVisit(
  deps: LedgerDeps,
  actor: LedgerActor | null,
  args: { tenantId: unknown; lead: unknown; appointmentAt: unknown },
): Promise<LedgerOutcome<VisitResult>> {
  const who = member(actor, args.tenantId);
  if ('refusal' in who) return who.refusal;
  if (!isReference(args.lead)) return refuse('invalid', 'lead is required');
  if (typeof args.appointmentAt !== 'string' || args.appointmentAt.length > 40) return refuse('invalid', 'the visit time is required');

  const at = new Date(args.appointmentAt);
  if (Number.isNaN(at.getTime())) return refuse('invalid', 'the visit time is not a date');

  const lead = await deps.engine.store.getLeadByCorrelation(who.tenantId, args.lead);
  if (!lead || lead.isCanary) return refuse('not_found', 'there is no such lead on this account');
  if (lead.status === 'suppressed') return refuse('invalid', 'this customer asked not to be contacted, so there is no visit to record');

  const now = deps.engine.now();
  if (at.getTime() < now.getTime() - MAX_VISIT_DAYS_BEHIND * 86_400_000) return refuse('invalid', 'that time is too long ago to be this visit');
  if (at.getTime() > now.getTime() + MAX_VISIT_DAYS_AHEAD * 86_400_000) return refuse('invalid', 'that time is more than a year away');

  const before = standing(await deps.evidence(who.tenantId, lead.correlationId), now);
  if (before.answer) return refuse('conflict', 'this visit has already been answered about, so its time cannot be changed here.');

  const wrote = await markBooked(deps.engine, {
    tenantId: who.tenantId,
    leadId: lead.id,
    outcome: 'booked',
    appointmentAt: at.toISOString(),
    actor: who.userId,
  });
  if (!wrote.ok) return refuse('invalid', wrote.outcome);
  return { ok: true, result: { appointmentAt: at.toISOString() } };
}

export interface AskedResult {
  /** how many questions were newly recorded as asked. */
  asked: number;
}

/**
 * The needs-you screen showed these questions to a signed-in member. Each is recorded once,
 * and only where there is really a question: terms on record, a visit that has passed, no
 * answer yet. Anything else is skipped without a word — a page cannot open a window early.
 */
export async function markAsked(
  deps: LedgerDeps,
  actor: LedgerActor | null,
  args: { tenantId: unknown; leads: unknown },
): Promise<LedgerOutcome<AskedResult>> {
  const who = member(actor, args.tenantId);
  if ('refusal' in who) return who.refusal;
  if (!Array.isArray(args.leads) || args.leads.length > MAX_ASKED_PER_CALL || !args.leads.every(isReference)) {
    return refuse('invalid', `leads must be a list of at most ${MAX_ASKED_PER_CALL} references`);
  }
  if (!(await deps.hasTerms(who.tenantId))) return { ok: true, result: { asked: 0 } };

  const now = deps.engine.now();
  let asked = 0;
  for (const reference of new Set(args.leads as string[])) {
    const lead = await deps.engine.store.getLeadByCorrelation(who.tenantId, reference);
    if (!lead || lead.isCanary || lead.bookingOutcome !== 'booked') continue;
    const state = standing(await deps.evidence(who.tenantId, lead.correlationId), now);
    if (!state.booked || !state.visitPassed || state.asked || state.answer) continue;
    const wrote = await requestOutcome(deps.engine, { tenantId: who.tenantId, leadId: lead.id, via: 'portal', shownTo: who.userId });
    if (wrote.ok && wrote.written) asked += 1;
  }
  return { ok: true, result: { asked } };
}

/* ── the Supabase reads ───────────────────────────────────── */

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

export function supabaseLedgerReads(db: Db): Pick<LedgerDeps, 'evidence' | 'hasTerms'> {
  return {
    async evidence(tenantId, correlationId) {
      const { data, error } = await db
        .from('events')
        .select('id, event_type, occurred_at, payload')
        .eq('tenant_id', tenantId)
        .eq('correlation_id', correlationId)
        .eq('is_canary', false)
        .in('event_type', EVIDENCE_TYPES)
        .order('occurred_at', { ascending: true })
        .limit(200);
      if (error) throw new Error(`could not read the ledger: ${error.message}`);
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: (row.id as string) ?? null,
        eventType: row.event_type as string,
        occurredAt: new Date(row.occurred_at as string).toISOString(),
        payload: (row.payload as Record<string, unknown>) ?? null,
      }));
    },
    async hasTerms(tenantId) {
      const { data, error } = await db
        .from('events')
        .select('payload')
        .eq('tenant_id', tenantId)
        .eq('event_type', 'pilot_terms_recorded')
        .eq('is_canary', false)
        .order('occurred_at', { ascending: false })
        .limit(20);
      if (error) throw new Error(`could not read the terms: ${error.message}`);
      return (data ?? []).some((row: { payload: unknown }) => termsFromPayload(row.payload) !== null);
    },
  };
}
