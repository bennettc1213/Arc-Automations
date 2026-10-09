/* ARC-MK-210 — the proof ledger: what evidence makes a job count.
 *
 * one rule, read by everything that says "counts": the jobs screen, the month's figures, the
 * fee, the export and the demo's seven examples. it lives here so none of them can disagree.
 *
 * a recovered job needs every link, in order:
 *
 *   1. a call or a form arrived                      `call_missed` / `lead_received`
 *   2. nobody answered it live                       a `call_missed` is only written when the
 *                                                    forward rang out
 *   3. arc's text went out                           `sms_sent`, success
 *   4. the customer replied, or booked it themselves `reply_received` / a `lead_booked` whose
 *                                                    `payload.booked_by` is `customer`
 *   5. a visit was booked for a time, and it passed  `lead_booked.payload.appointment_at`
 *   6. the owner said it happened — or was asked,    `lead_outcome_recorded` /
 *      and the dispute window passed                 `lead_outcome_requested` + the terms
 *
 * the first missing link is the status and its reason. a later link with an earlier one
 * missing is `unverified`: shown, never counted, never billed.
 *
 * three things kept apart:
 *
 *   - `ledgerStatus(facts)` is the rule. it takes plain facts and knows nothing about events,
 *     clocks or screens, so the demo's written examples and a client's real leads go through
 *     the very same lines.
 *   - `factsFromLead` reads those facts off a lead as `buildLeadCapture` folded it from the
 *     event log. nothing here reads an operational table.
 *   - `buildLedger` runs it over every lead, and works out the month and the fee.
 *
 * the fee is arithmetic over the result and the terms an operator recorded
 * (`pilot_terms_recorded`): base + per job × jobs that became billable this month, held at
 * the cap. no terms, no fee — null with the reason, never a zero. there is no invoice and no
 * payment anywhere in this file.
 *
 * ARC-MK-220 added nothing to the rule. each verdict now also carries when its answer was
 * given, by whom, how an operator settled it and when silence would start to count — what
 * the owner's answer screen and the console's ledger panel show — and `disputePattern` words
 * how often an owner disputes a good lead.
 */

import { DateTime } from 'luxon';
import { DISPUTE_REASONS, disputeReasonLabel, termsFromPayload } from '../../../supabase/functions/_shared/ledger/model.ts';

export { DISPUTE_REASONS };

/** a dispute reason in the homepage's words. */
export const disputeReasonWords = disputeReasonLabel;

/* the nine statuses, each with the words an owner reads. `billed` is the only thing a fee
   reads: two statuses bill, and they print the same word because to the owner they are the
   same thing — a job that counts. */
export const LEDGER_STATUS = {
  answered: { label: 'you answered it', tone: 'neutral', billed: false },
  unverified: { label: 'cannot be proven', tone: 'neutral', billed: false },
  not_billable: { label: 'does not count', tone: 'neutral', billed: false },
  handed_off: { label: 'handed to you', tone: 'warn', billed: false },
  booked: { label: 'not counted yet', tone: 'idle', billed: false },
  needs_owner: { label: 'waiting on you', tone: 'warn', billed: false },
  disputed: { label: 'disputed', tone: 'warn', billed: false },
  confirmed: { label: 'counts', tone: 'ok', billed: true },
  billable: { label: 'counts', tone: 'ok', billed: true },
};

export const LEDGER_STATUSES = Object.keys(LEDGER_STATUS);

const verdict = (status, reason, extra = {}) => ({ status, ...LEDGER_STATUS[status], reason, billableAt: null, lateDispute: false, ...extra });

const RULED_OUT = {
  wrong_number: 'it was never a customer. shown so you can see it was caught, never billed.',
  opted_out: 'the customer asked for no more texts. arc stopped, and this is never billed.',
  out_of_area: 'the job was outside your area. shown, never billed.',
  duplicate: 'this customer already had a visit booked from an earlier call. it is one job, billed once at most.',
};

/**
 * the rule. `facts` states only what happened:
 *
 *   answered     true when a person at the company picked up. null: it was not a call.
 *   texted       arc's text left.            textFailed   arc tried and it did not send.
 *   replied      the customer wrote back.    booked       a visit was booked.
 *   customerBooked  the customer made the booking themselves (stands in for a reply).
 *   outOfOrder   'reply_before_text' | 'booking_before_text' | null
 *   ruledOut     'wrong_number' | 'opted_out' | 'out_of_area' | 'duplicate' | null
 *   handoff      arc stopped and gave it to a person.
 *   visit        'ahead' | 'passed' | null   (null: booked with no time on record)
 *   answer       { outcome, reason, beforeVisit, late, at } — the latest answer, or null
 *   settlement   'accepted' | 'rejected' | null, for that answer
 *   asked        arc asked whether the job happened.
 *   windowClosed the dispute window has passed since the asking.
 *   billableAt   { confirmed, silence, settled } — when each way of counting took effect
 */
export function ledgerStatus(facts) {
  const at = facts.billableAt ?? {};

  if (facts.answered === true) {
    return verdict('answered', 'you answered it yourself. that job was never missed, so it is yours.');
  }

  if (!facts.texted) {
    if (facts.replied || facts.booked) {
      return verdict(
        'unverified',
        'there is a reply or a booking here, but no text from arc on record. arc cannot prove it brought this back, so it is never billed.',
      );
    }
    return verdict(
      'not_billable',
      facts.textFailed
        ? 'arc tried to text this customer and it did not send, so arc did not bring it back.'
        : 'arc never texted this customer, so arc did not bring it back.',
    );
  }

  if (facts.handoff) {
    return verdict(
      'handed_off',
      'anything that sounds unsafe goes straight to a person. arc stopped texting, so this is never billed.',
    );
  }
  if (facts.ruledOut === 'wrong_number' || facts.ruledOut === 'duplicate') return verdict('not_billable', RULED_OUT[facts.ruledOut]);

  if (facts.outOfOrder === 'reply_before_text') {
    return verdict('unverified', 'the customer wrote before arc texted, so arc cannot prove it brought this one back.');
  }
  if (facts.outOfOrder === 'booking_before_text') {
    return verdict('unverified', 'the visit was booked before arc texted, so arc cannot prove it brought this one back.');
  }

  /* the customer answered arc's text: they wrote back, or they booked the visit themselves.
     a booking a person typed in is not the customer answering. */
  const answeredBack = facts.replied || facts.customerBooked === true;

  if (!facts.booked) {
    if (facts.ruledOut) return verdict('not_billable', RULED_OUT[facts.ruledOut]);
    return verdict(
      'not_billable',
      answeredBack ? 'nothing was booked. shown, never billed.' : 'the customer never answered. shown, never billed.',
    );
  }
  if (!answeredBack) {
    return verdict(
      'unverified',
      'a visit was booked, but the customer never answered arc’s text. arc cannot prove it brought this back, so it is never billed.',
    );
  }

  const answer = facts.answer ?? null;
  const said = answer ? disputeReasonLabel(answer.reason) : null;

  /* ruled out before there was a visit to bill: nothing to dispute, so nothing to settle. */
  if (answer?.outcome === 'not_counted' && answer.beforeVisit) {
    return verdict(
      'not_billable',
      answer.reason === 'customer_cancelled'
        ? 'the customer cancelled before the visit. no visit, no job, no fee.'
        : `this was ruled out before the visit: ${said}. no visit, no job, no fee.`,
    );
  }

  if (!facts.visit) {
    return verdict('unverified', 'it was booked, but no visit time is on record. without one there is no visit to confirm.');
  }
  if (facts.visit !== 'passed') {
    return verdict('booked', 'the visit has not happened yet. a booking alone is never billed.');
  }

  if (answer?.outcome === 'happened') {
    return verdict('confirmed', 'every step is on record, and you said the job happened.', { billableAt: at.confirmed ?? null });
  }
  if (answer?.outcome === 'quoted') {
    return verdict('confirmed', 'every step is on record, and you said the visit happened. the quote is still open.', {
      billableAt: at.confirmed ?? null,
    });
  }

  if (answer?.outcome === 'not_counted') {
    if (facts.settlement === 'accepted') {
      return verdict('not_billable', `you said this one should not count: ${said}. we agreed, so it is not billed.`);
    }
    if (facts.settlement === 'rejected') {
      return verdict('billable', `you said this one should not count: ${said}. we looked, and the record shows the job, so it counts.`, {
        billableAt: at.settled ?? null,
      });
    }
    if (answer.late) {
      return verdict(
        'billable',
        'the time to dispute this had passed when your answer came in. it still counts, and we are looking at what you said.',
        { billableAt: at.silence ?? null, lateDispute: true },
      );
    }
    return verdict('disputed', `you said this one should not count: ${said}. it is not billed while we look at it.`);
  }

  if (facts.asked && facts.windowClosed) {
    return verdict('billable', 'every step is on record. we asked whether the job happened, and the time to dispute it has passed.', {
      billableAt: at.silence ?? null,
    });
  }
  return verdict('needs_owner', 'the visit time has passed. one question is waiting for you: did the job happen?');
}

/* ── from the event log ───────────────────────────────────── */

const ms = (iso) => (iso ? Date.parse(iso) : null);
const isoOf = (millis) => (millis === null || millis === undefined || Number.isNaN(millis) ? null : new Date(millis).toISOString());
const DAY_MS = 24 * 60 * 60 * 1000;

/** the terms in force: the latest whole `pilot_terms_recorded`. null when none is on record. */
export function termsFromEvents(events = []) {
  let latest = null;
  for (const event of events) {
    if (event.eventType !== 'pilot_terms_recorded' || event.isCanary) continue;
    const terms = termsFromPayload(event.payload);
    if (!terms) continue;
    if (!latest || event.occurredAt >= latest.recordedAt) latest = { ...terms, id: event.id ?? null, recordedAt: event.occurredAt };
  }
  return latest;
}

/**
 * one lead's facts, read off what `buildLeadCapture` folded from the log.
 *
 *   now        epoch milliseconds
 *   terms      the pilot terms, or null — only the dispute window is read here
 *   duplicate  true when an earlier lead from the same number already had a visit booked
 */
export function factsFromLead(lead, { now, terms = null, duplicate = false } = {}) {
  const sent = (lead.steps ?? []).find((step) => step.type === 'sms_sent' && step.status !== 'failure');
  const textAt = ms(sent?.at);
  /* a text the carrier refused did not go out, whatever arc handed over — unless the
     customer wrote back, which is the one proof of arrival stronger than a receipt. */
  const refused = Boolean(lead.deliveryFailed) && !lead.replied;
  const texted = Boolean(sent) && !refused;
  const replyAt = ms(lead.repliedAt);
  const bookedAt = ms(lead.bookedAt);
  const visitAt = ms(lead.appointmentAt);

  let outOfOrder = null;
  if (texted && lead.replied && replyAt !== null && replyAt < textAt) outOfOrder = 'reply_before_text';
  else if (texted && lead.booked && bookedAt !== null && bookedAt < textAt) outOfOrder = 'booking_before_text';

  let ruledOut = null;
  if (lead.suppressionReason === 'wrong_contact') ruledOut = 'wrong_number';
  else if (duplicate) ruledOut = 'duplicate';
  else if (lead.suppressed) ruledOut = 'opted_out';
  else if (lead.qualification?.inServiceArea === false) ruledOut = 'out_of_area';

  /* the window opens when the owner could first have answered: the visit has passed and
     arc has asked. it never opens on a question nobody was shown. */
  const askedAt = ms(lead.outcomeRequestedAt);
  const days = terms?.disputeWindowDays ?? null;
  const windowEnd = visitAt !== null && askedAt !== null && days ? Math.max(visitAt, askedAt) + days * DAY_MS : null;

  const last = (lead.outcomes ?? []).at(-1) ?? null;
  const answerAt = ms(last?.at);
  const answer = last
    ? {
        id: last.id ?? null,
        outcome: last.outcome,
        reason: last.reason ?? null,
        at: last.at,
        by: last.answeredBy ?? null,
        beforeVisit: visitAt === null || answerAt < visitAt,
        late: windowEnd !== null && answerAt > windowEnd,
      }
    : null;

  /* a settlement is of one answer. one written about an earlier answer says nothing about
     the answer that stands now. */
  const settled = answer
    ? (lead.settlements ?? []).filter((row) => (row.disputeId ? row.disputeId === answer.id : ms(row.at) >= answerAt)).at(-1) ?? null
    : null;

  return {
    answered: lead.source === 'missed_call' ? false : null,
    texted,
    textFailed: !texted && (Boolean(lead.failed) || refused),
    replied: Boolean(lead.replied),
    booked: Boolean(lead.booked),
    customerBooked: lead.bookedBy === 'customer',
    outOfOrder,
    ruledOut,
    handoff: Boolean(lead.handoff),
    visit: !lead.booked || visitAt === null ? null : visitAt <= now ? 'passed' : 'ahead',
    answer,
    settlement: settled?.decision === 'accepted' || settled?.decision === 'rejected' ? settled.decision : null,
    asked: askedAt !== null,
    windowClosed: windowEnd !== null && now > windowEnd,
    billableAt: {
      confirmed: isoOf(answer && visitAt !== null ? Math.max(answerAt, visitAt) : null),
      silence: isoOf(windowEnd),
      settled: settled?.at ?? null,
    },
    appointmentAt: lead.appointmentAt ?? null,
  };
}

/* the same number, calling again before the visit it already has. one job, not two.
   time-based on purpose: read off when things happened, so a lead's status does not flip
   back once the first visit is over. */
function duplicateLeadIds(leads) {
  const byPhone = new Map();
  for (const lead of leads) {
    if (!lead.phone) continue;
    byPhone.set(lead.phone, [...(byPhone.get(lead.phone) ?? []), lead]);
  }
  const duplicates = new Set();
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    ordered.forEach((lead, index) => {
      const again = ordered
        .slice(0, index)
        .some((earlier) => earlier.booked && earlier.appointmentAt && ms(lead.startedAt) < ms(earlier.appointmentAt));
      if (again) duplicates.add(lead.id);
    });
  }
  return duplicates;
}

/** base + per job × jobs, held at the cap. null when there are no terms to multiply. */
export function feeOwedCents(terms, billedJobs) {
  if (!terms || typeof terms.baseCents !== 'number' || typeof terms.perJobCents !== 'number') return null;
  const owed = terms.baseCents + terms.perJobCents * billedJobs;
  return terms.capCents === null || terms.capCents === undefined ? owed : Math.min(terms.capCents, owed);
}

/**
 * every lead's verdict, the month and the fee.
 *
 *   byLead   Map of lead id → the verdict, with the answer and the visit time it read
 *   totals   how many leads sit in each status right now, over every lead in hand
 *   month    the calendar month in the business's own timezone. a job belongs to the month
 *            it became billable in, and never moves.
 */
export function buildLedger(leads = [], events = [], { now = DateTime.now(), timezone = 'UTC' } = {}) {
  const nowMs = now.toMillis();
  const terms = termsFromEvents(events);
  const duplicates = duplicateLeadIds(leads);

  const byLead = new Map();
  const totals = Object.fromEntries(LEDGER_STATUSES.map((status) => [status, 0]));

  const monthStart = now.setZone(timezone).startOf('month');
  const monthEnd = monthStart.plus({ months: 1 });
  let billedThisMonth = 0;
  let lateDisputes = 0;
  let ownerSaidNo = 0;
  const disputes = { answered: 0, open: 0, accepted: 0, rejected: 0, late: 0 };

  for (const lead of leads) {
    const facts = factsFromLead(lead, { now: nowMs, terms, duplicate: duplicates.has(lead.id) });
    const result = ledgerStatus(facts);
    byLead.set(lead.id, {
      status: result.status,
      label: result.label,
      tone: result.tone,
      billed: result.billed,
      reason: result.reason,
      billableAt: result.billableAt,
      lateDispute: result.lateDispute,
      appointmentAt: facts.appointmentAt,
      visit: facts.visit,
      answer: facts.answer
        ? {
            id: facts.answer.id,
            outcome: facts.answer.outcome,
            reason: facts.answer.reason,
            beforeVisit: facts.answer.beforeVisit,
            at: facts.answer.at,
            by: facts.answer.by,
          }
        : null,
      /* an operator's decision on that answer, or null while it is open. */
      settlement: facts.settlement,
      asked: facts.asked,
      /* when silence starts to count: only once the owner was asked under terms on record. */
      windowEndsAt: facts.asked ? facts.billableAt.silence : null,
    });
    totals[result.status] += 1;
    if (result.lateDispute) lateDisputes += 1;
    if (facts.answer?.outcome === 'not_counted') ownerSaidNo += 1;

    /* the answers that were about a job the record shows whole — every earlier link held,
       and the visit time had passed. a "should not count" among these is a dispute of a
       good lead; one about a lead that never counted anyway is not. */
    const saidNo = facts.answer?.outcome === 'not_counted' && !facts.answer.beforeVisit;
    if (result.status === 'confirmed') disputes.answered += 1;
    else if (result.status === 'disputed') {
      disputes.answered += 1;
      disputes.open += 1;
    } else if (saidNo && facts.visit === 'passed' && result.status === 'billable') {
      disputes.answered += 1;
      if (facts.settlement === 'rejected') disputes.rejected += 1;
      else disputes.late += 1;
    } else if (saidNo && facts.visit === 'passed' && result.status === 'not_billable' && facts.settlement === 'accepted') {
      disputes.answered += 1;
      disputes.accepted += 1;
    }

    if (result.billed && result.billableAt) {
      const at = DateTime.fromISO(result.billableAt, { zone: 'utc' });
      if (at >= monthStart && at < monthEnd) billedThisMonth += 1;
    }
  }

  /* the phone line's own count. null until the first one is seen: a line whose answered
     calls are not being recorded has not answered zero calls. */
  let callsAnswered = null;
  for (const event of events) {
    if (event.eventType !== 'call_answered' || event.isCanary) continue;
    callsAnswered = (callsAnswered ?? 0) + 1;
  }

  const billedNow = totals.confirmed + totals.billable;
  return {
    byLead,
    terms,
    totals: { ...totals, total: leads.length, billed: billedNow, notBilled: leads.length - billedNow },
    month: {
      key: monthStart.toFormat('yyyy-MM'),
      label: monthStart.toFormat('LLLL yyyy').toLowerCase(),
      billed: billedThisMonth,
      feeCents: feeOwedCents(terms, billedThisMonth),
      capped: Boolean(terms && terms.capCents !== null && terms.baseCents + terms.perJobCents * billedThisMonth > terms.capCents),
    },
    callsAnswered,
    /* for an operator: how often this owner says a job should not count, and how many of
       those came in after the window. a pattern here is a conversation, not a rule. */
    ownerSaidNo,
    lateDisputes,
    /* ARC-MK-220: of the good leads this owner answered about, how many they disputed and
       how each ended. `said_no` is all four endings together. */
    disputes: { ...disputes, saidNo: disputes.open + disputes.accepted + disputes.rejected + disputes.late },
  };
}

/**
 * whether an owner's disputes are worth a conversation. not a rule and never a verdict: it
 * changes no status and bills nothing. it only says, to an operator, that most of the good
 * leads this owner answered about were disputed — which is either a problem with the leads
 * or a problem with the answers, and a person has to find out which.
 */
export const DISPUTE_PATTERN_MIN = 3;

export function disputePattern(disputes) {
  if (!disputes || disputes.answered === 0) return { flagged: false, share: null, reason: 'no owner answers on record yet' };
  const share = disputes.saidNo / disputes.answered;
  const flagged = disputes.saidNo >= DISPUTE_PATTERN_MIN && share >= 0.5;
  return {
    flagged,
    share,
    reason: flagged
      ? `${disputes.saidNo} of the ${disputes.answered} good leads this owner answered about were disputed. worth a conversation.`
      : `${disputes.saidNo} of ${disputes.answered} good leads answered about were disputed.`,
  };
}
