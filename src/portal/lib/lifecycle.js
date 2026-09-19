/* the revenue lifecycle, folded out of the event log.
 *
 * this is derive.js's sibling: same rules, different stage of the business. a flat log is
 * what the database holds; what happened is "a $6,400 mitigation quote sat for nine days,
 * we texted twice, she replied asking about scheduling, and nobody has answered her". the
 * fold is what turns the log back into that sentence.
 *
 * three rules govern every function here, and they are the reason the file is this long:
 *
 * 1. records are folded by entity id, never by correlation id. correlation threads one
 *    lead's pipeline; an estimate, a review or a membership is a record in the client's crm
 *    with its own identity and a life measured in weeks.
 *
 * 2. nothing is inferred from a message being sent. "recovered" requires the original
 *    estimate, a follow-up that actually left, a decision that came back after it, and the
 *    value on that decision. a delivered text is not a recovered job and this file will not
 *    add one to the other.
 *
 * 3. a rule the product promises is checked here rather than assumed. stop-on-reply,
 *    review gating, safety handoff and registration evidence are each computed as a
 *    violation count from the log, so the portal can show that the rule held instead of
 *    claiming it.
 */

import { percentile, utc } from './metrics.js';
import {
  ESTIMATE_EVENT_TYPES,
  INSTALL_EVENT_TYPES,
  MEMBERSHIP_EVENT_TYPES,
  REVIEW_EVENT_TYPES,
} from './types.js';

/* ── the fold ──────────────────────────────────────────────
   every module reads its records through here. one grouping, so a record cannot mean two
   different sets of rows on two pages. */

function entityKey(event) {
  return event.entityId ?? event.payload?.entity_id ?? event.correlationId ?? event.id;
}

export function foldByEntity(events, types) {
  const wanted = new Set(types);
  const byKey = new Map();
  const seen = new Set();

  for (const event of events) {
    if (event.isCanary) continue;
    if (!wanted.has(event.eventType)) continue;

    /* deduplicated here as well as at the database's unique index on
       (tenant_id, event_key). the index is the real defence and this is the second one,
       because the cost of it being wrong is asymmetric: a duplicated `estimate_created` is
       harmless (the fold takes the first), but a duplicated `estimate_followup_sent` would
       inflate the count of messages actually sent to a customer — and that number is one of
       the four links the word "recovered" depends on. */
    const dedupe = event.eventKey ?? event.id;
    if (dedupe !== null && dedupe !== undefined) {
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
    }

    const key = entityKey(event);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  }

  /* oldest-first inside a record: a history reads in the order it happened. */
  for (const list of byKey.values()) {
    list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  return byKey;
}

const first = (steps, type) => steps.find((e) => e.eventType === type) ?? null;
const last = (steps, type) => {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].eventType === type) return steps[i];
  return null;
};
const all = (steps, type) => steps.filter((e) => e.eventType === type);

function inWindow(iso, from, to) {
  if (!iso) return false;
  const at = utc(iso);
  return at >= from && at < to;
}

function daysBetween(iso, now) {
  return iso ? Math.max(0, Math.floor(now.diff(utc(iso), 'days').days)) : null;
}

function median(values) {
  return percentile(values.slice().sort((a, b) => a - b), 0.5);
}

/* money arrives as integer cents from every adapter and stays that way until it is
   formatted. a float dollar amount that has been through two systems is a number nobody
   can reconcile against an invoice. */
function cents(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

const sum = (values) => values.reduce((total, n) => total + n, 0);

/* ══ lead capture ═════════════════════════════════════════
   the existing lead threads, with the qualifier's verdict and any human handoff folded
   onto them. the threads themselves are untouched — the leads page reads the same objects
   it always has. */

/* the categories that may never be closed by an automation. this list is the product
   promise made executable: if any of these is on a lead, the sequence stops and a person
   is put in front of it, and a lead that was routed without one is counted as a breach
   rather than quietly forgotten. */
export const SAFETY_FLAGS = [
  'electrical',
  'gas',
  'fire',
  'smoke',
  'flood_safety',
  'medical',
  'distressed',
  'complaint',
  'ambiguous_scope',
  'human_only',
];

export const SAFETY_FLAG_LABEL = {
  electrical: 'electrical hazard',
  gas: 'gas concern',
  fire: 'fire',
  smoke: 'smoke',
  flood_safety: 'flooding — safety concern',
  medical: 'medical distress',
  distressed: 'distressed customer',
  complaint: 'complaint',
  ambiguous_scope: 'scope unclear',
  human_only: 'client rule — human only',
};

/* five minutes. the industry's own speed-to-lead benchmark, and a figure a contractor has
   usually heard before — which matters more than picking a tighter one, because a target
   nobody recognises reads as one we chose because we could hit it. overridable per tenant. */
const DEFAULT_SLA_MS = 5 * 60 * 1000;

export function responseSlaMs(tenant) {
  const seconds = tenant?.responseSlaSeconds;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : DEFAULT_SLA_MS;
}

/* routed, and then nothing. two hours is long enough that a tech genuinely working is not
   flagged, and short enough that a lead nobody picked up is still worth chasing. */
const ACK_GRACE_HOURS = 2;

/* and an upper bound, because a queue is a list of things somebody can still do something
   about. a lead routed six weeks ago that nobody acknowledged is history — it belongs in
   the record and in the count of how often this happens, not in today's work. without this
   bound every unacknowledged lead ever accumulates in the queue until it is the only thing
   in it. */
const ACK_STALE_DAYS = 7;

export function buildLeadCapture(events, threads, tenant, now, days = 30) {
  const from = now.minus({ days });
  const to = now.plus({ seconds: 1 });
  const slaMs = responseSlaMs(tenant);

  const qualifications = new Map();
  const handoffs = new Map();

  for (const event of events) {
    if (event.isCanary || !event.correlationId) continue;
    if (event.eventType === 'lead_qualified') qualifications.set(event.correlationId, event);
    if (event.eventType === 'handoff_requested') handoffs.set(event.correlationId, event);
  }

  const routedAck = new Map();
  for (const event of events) {
    if (event.eventType !== 'routed' || event.isCanary || !event.correlationId) continue;
    routedAck.set(event.correlationId, event);
  }

  /* ── the execution layer's own events (0010) ──
     lead recovery is the first module arc *runs* rather than watches, and these are the
     four facts only the thing running it can state: the provider confirmed delivery or
     refused it, the lead turned into work, the contact opted out, the sequence ended.
     folded on by correlation id exactly as qualification and handoff already are, so the
     leads table gains columns rather than the portal gaining a second lead list. */
  const delivered = new Map();
  const deliveryFailed = new Map();
  const booked = new Map();
  const suppressed = new Map();
  const runEnded = new Map();

  for (const event of events) {
    if (event.isCanary || !event.correlationId) continue;
    const id = event.correlationId;
    switch (event.eventType) {
      case 'message_delivered':
        if (!delivered.has(id)) delivered.set(id, event);
        break;
      case 'message_failed':
        /* the last one: a thread that failed, retried and failed again is described by its
           most recent attempt, not its first. */
        deliveryFailed.set(id, event);
        break;
      case 'lead_booked':
        booked.set(id, event);
        break;
      case 'lead_suppressed':
        suppressed.set(id, event);
        break;
      case 'automation_completed':
      case 'automation_failed':
        runEnded.set(id, event);
        break;
      default:
        break;
    }
  }

  /* is the execution layer running for this client at all? the same question
     `qualificationSeen` asks of the qualifier, and for the same reason: a client whose
     leads arrive through an observing adapter has no bookings and no suppressions because
     nothing is recording them, which is not the same fact as zero. */
  const executionSeen =
    delivered.size > 0 || deliveryFailed.size > 0 || booked.size > 0 || suppressed.size > 0 || runEnded.size > 0;

  const leads = threads.map((thread) => {
    const q = qualifications.get(thread.id)?.payload ?? null;
    const handoffEvent = handoffs.get(thread.id) ?? null;
    const routedEvent = routedAck.get(thread.id) ?? null;

    const safetyFlags = Array.isArray(q?.safety_flags)
      ? q.safety_flags.filter((flag) => SAFETY_FLAGS.includes(flag))
      : [];
    const requiresHuman = safetyFlags.length > 0 || q?.urgency === 'emergency';

    const acknowledgedAt = routedEvent?.payload?.acknowledged_at ?? null;
    const routedAt = routedEvent ? utc(routedEvent.occurredAt) : null;
    const unacknowledged = Boolean(
      routedEvent &&
        !acknowledgedAt &&
        !thread.replied &&
        routedAt < now.minus({ hours: ACK_GRACE_HOURS }) &&
        routedAt > now.minus({ days: ACK_STALE_DAYS }),
    );

    return {
      ...thread,
      qualification: q
        ? {
            outcome: q.outcome ?? null,
            jobType: q.job_type ?? null,
            zip: q.zip ?? null,
            inServiceArea: typeof q.in_service_area === 'boolean' ? q.in_service_area : null,
            propertyType: q.property_type ?? null,
            customerStatus: q.customer_status ?? null,
            urgency: q.urgency ?? null,
            scope: q.scope ?? null,
            capacityOk: typeof q.capacity_ok === 'boolean' ? q.capacity_ok : null,
            preferredTime: q.preferred_time ?? null,
            consent: q.consent ?? null,
            sourceAttribution: q.source_attribution ?? null,
          }
        : null,
      qualified: q?.outcome === 'qualified',
      safetyFlags,
      requiresHuman,
      handoff: handoffEvent
        ? {
            at: handoffEvent.occurredAt,
            reason: handoffEvent.payload?.reason ?? null,
            assignedTo: handoffEvent.payload?.assigned_to ?? null,
            resolvedAt: handoffEvent.payload?.resolved_at ?? null,
          }
        : null,
      routingDestination: thread.tech ?? routedEvent?.payload?.queue ?? null,
      acknowledgedAt,
      unacknowledged,

      /* delivery is a separate claim from sending, so it reads as three states rather than
         a boolean: confirmed, refused, or nobody has told us. */
      deliveredAt: delivered.get(thread.id)?.occurredAt ?? null,
      deliveryFailed: deliveryFailed.has(thread.id),
      deliveryError: deliveryFailed.get(thread.id)?.payload?.provider_code
        ?? deliveryFailed.get(thread.id)?.payload?.reason
        ?? null,
      booked: booked.has(thread.id),
      bookedAt: booked.get(thread.id)?.occurredAt ?? null,
      bookedValueCents: cents(booked.get(thread.id)?.payload?.value_cents ?? null),
      suppressed: suppressed.has(thread.id),
      suppressionReason: suppressed.get(thread.id)?.payload?.reason ?? null,
      automationFailed: runEnded.get(thread.id)?.eventType === 'automation_failed',
      stopReason: runEnded.get(thread.id)?.payload?.stop_reason ?? null,
      /* the breach that matters: something on the safety list came in and the pipeline
         handled it without ever involving a person. */
      safetyBreach: requiresHuman && !handoffEvent,
      withinSla: thread.latencyMs === null ? null : thread.latencyMs <= slaMs,
      nextAction: requiresHuman && !handoffEvent
        ? 'stop automation — a person must take this'
        : handoffEvent && !handoffEvent.payload?.resolved_at
          ? 'waiting on a person'
          : unacknowledged
            ? 'nobody has picked this up'
            : thread.failed || deliveryFailed.has(thread.id)
              ? 'the text did not reach them'
              : runEnded.get(thread.id)?.eventType === 'automation_failed'
                ? 'the sequence stopped on an error'
                : null,
    };
  });

  const windowed = leads.filter((lead) => inWindow(lead.startedAt, from, to));
  const answered = windowed.filter((lead) => lead.latencyMs !== null);
  const sla = answered.filter((lead) => lead.withinSla);

  const failedSends = events.filter(
    (e) =>
      !e.isCanary &&
      e.status === 'failure' &&
      (e.eventType === 'sms_sent' || e.eventType === 'routed') &&
      inWindow(e.occurredAt, from, to),
  ).length;

  return {
    leads,
    metrics: {
      opportunities: windowed.length,
      medianResponseMs: median(answered.map((lead) => lead.latencyMs)),
      withinSlaPct: answered.length === 0 ? null : (sla.length / answered.length) * 100,
      slaMs,
      answered: answered.length,
      qualified: windowed.filter((lead) => lead.qualified).length,
      /* qualification is a separate integration from capture. when it is not running, the
         portal must say so rather than report every lead as unqualified. */
      qualificationSeen: windowed.some((lead) => lead.qualification !== null),
      missedCallsRecovered: windowed.filter(
        (lead) => lead.source === 'missed_call' && lead.latencyMs !== null,
      ).length,
      escalations: windowed.filter((lead) => lead.handoff !== null).length,
      unacknowledged: leads.filter((lead) => lead.unacknowledged).length,
      failedSends,
      safetyBreaches: windowed.filter((lead) => lead.safetyBreach).length,

      /* ── the execution layer's figures (0010) ── */
      replied: windowed.filter((lead) => lead.replied).length,
      /* `executionSeen` gates every figure below it. without it the leads page would print
         "0 booked" for a client whose leads arrive through an observing adapter that has no
         way to know — which is the exact zero-for-unknown substitution `modules.js` exists
         to prevent, one level further down. */
      executionSeen,
      booked: windowed.filter((lead) => lead.booked).length,
      bookedValueCents: sum(
        windowed.filter((lead) => lead.booked).map((lead) => lead.bookedValueCents ?? 0),
      ),
      /* delivery confirmations, counted separately from sends: "we handed 40 texts to the
         carrier" and "38 arrived" are different sentences and the gap is the interesting
         one. */
      delivered: windowed.filter((lead) => lead.deliveredAt !== null).length,
      deliveryFailures: windowed.filter((lead) => lead.deliveryFailed).length,
      /* not windowed. a suppression is a standing fact about a contact, not an event that
         happened in the last thirty days, and expiring it out of the count would suggest
         somebody had become contactable again. */
      suppressedContacts: leads.filter((lead) => lead.suppressed).length,
      automationFailures: windowed.filter((lead) => lead.automationFailed).length,
    },
  };
}

/* ══ estimate recovery ════════════════════════════════════ */

export const REPLY_CLASSES = [
  'interested',
  'question',
  'objection',
  'declined',
  'deferred',
  'wrong_contact',
  'opt_out',
];

/* replies that must reach a person rather than the next scheduled message. */
const ESCALATING_REPLIES = new Set(['interested', 'question', 'objection']);

/* every reason an estimate may be held back from the sequence. an estimate excluded for a
   reason not on this list is a bug in whatever excluded it, and is surfaced as one. */
export const SUPPRESSION_REASONS = {
  already_approved: 'already approved',
  declined: 'declined, no follow-up requested',
  duplicate: 'duplicate of another estimate',
  disputed: 'job is in dispute',
  sensitive: 'sensitive — handled by a person',
  no_consent: 'no messaging consent on file',
  opted_out: 'customer opted out',
  cannot_fulfil: 'cannot be fulfilled right now',
  client_rule: 'excluded by your own rule',
  paused_by_staff: 'paused by your team',
  closed_by_staff: 'closed by your team',
};

const CRM_EXCLUDED_STATUS = new Set(['approved', 'won', 'disputed', 'cancelled', 'void']);

export function buildEstimates(events, now, days = 30) {
  const from = now.minus({ days });
  const to = now.plus({ seconds: 1 });
  const byEntity = foldByEntity(events, ESTIMATE_EVENT_TYPES);
  const records = [];

  for (const [id, steps] of byEntity) {
    const created = first(steps, 'estimate_created');
    /* a follow-up or a decision with no estimate behind it is a partial sync, not a
       record. counting it would put a row with no amount in a table whose whole job is
       the amount. */
    if (!created) continue;

    const p = created.payload ?? {};
    const followupEvents = all(steps, 'estimate_followup_sent');
    const replyEvent = first(steps, 'estimate_reply_received');
    const decisionEvent = last(steps, 'estimate_decision');
    const suppressEvent = last(steps, 'estimate_suppressed');

    const followups = followupEvents.map((e) => ({
      at: e.occurredAt,
      stage: e.payload?.stage ?? null,
      channel: e.payload?.channel ?? null,
      failed: e.status === 'failure',
      errorClass: e.errorClass ?? e.payload?.error_class ?? null,
    }));
    const sentFollowups = followups.filter((f) => !f.failed);

    const reply = replyEvent
      ? {
          at: replyEvent.occurredAt,
          classification: REPLY_CLASSES.includes(replyEvent.payload?.classification)
            ? replyEvent.payload.classification
            : 'question',
          body: replyEvent.payload?.body ?? null,
        }
      : null;

    const decision = decisionEvent
      ? {
          at: decisionEvent.occurredAt,
          decision: decisionEvent.payload?.decision ?? null,
          amountCents: cents(decisionEvent.payload?.amount_cents),
          grossMarginPct:
            typeof decisionEvent.payload?.gross_margin_pct === 'number'
              ? decisionEvent.payload.gross_margin_pct
              : null,
          grossProfitCents: cents(decisionEvent.payload?.gross_profit_cents),
        }
      : null;

    /* suppression comes from three places and they must not disagree: an explicit
       suppression event, a crm status that excludes it on its face, and an opt-out reply.
       resolved in that order, because an event a person caused outranks a status a sync
       observed. */
    const crmStatus = p.crm_status ?? null;
    let suppression = null;
    if (suppressEvent) {
      const reason = suppressEvent.payload?.reason ?? 'client_rule';
      suppression = {
        at: suppressEvent.occurredAt,
        reason,
        label: SUPPRESSION_REASONS[reason] ?? reason.replace(/_/g, ' '),
        known: Object.hasOwn(SUPPRESSION_REASONS, reason),
        by: suppressEvent.actor === 'human' ? (suppressEvent.payload?.by ?? 'your team') : null,
      };
    } else if (reply?.classification === 'opt_out') {
      suppression = {
        at: reply.at,
        reason: 'opted_out',
        label: SUPPRESSION_REASONS.opted_out,
        known: true,
        by: null,
      };
    } else if (p.duplicate_of) {
      suppression = {
        at: created.occurredAt,
        reason: 'duplicate',
        label: SUPPRESSION_REASONS.duplicate,
        known: true,
        by: null,
      };
    } else if (crmStatus && CRM_EXCLUDED_STATUS.has(crmStatus)) {
      const reason =
        crmStatus === 'disputed' ? 'disputed' : crmStatus === 'approved' || crmStatus === 'won'
          ? 'already_approved'
          : 'cannot_fulfil';
      suppression = {
        at: created.occurredAt,
        reason,
        label: SUPPRESSION_REASONS[reason],
        known: true,
        by: null,
      };
    } else if (p.consent && p.consent.sms === false && p.consent.email === false) {
      suppression = {
        at: created.occurredAt,
        reason: 'no_consent',
        label: SUPPRESSION_REASONS.no_consent,
        known: true,
        by: null,
      };
    }

    /* the stop rule, checked rather than trusted: once the customer has replied, no
       scheduled follow-up may leave. a violation here is the sequence talking over
       somebody who already answered. */
    const stopViolations = reply
      ? followups.filter((f) => f.at > reply.at && !f.failed).length
      : 0;

    /* attribution. all four links required, in order, or the estimate is simply approved
       and we make no claim about why. */
    const firstSentAt = sentFollowups.length ? sentFollowups[0].at : null;
    const approved = decision?.decision === 'approved';
    const attributed = Boolean(
      approved &&
        firstSentAt &&
        decision.at > firstSentAt &&
        decision.amountCents !== null &&
        cents(p.amount_cents) !== null,
    );

    let grossProfitCents = null;
    if (attributed) {
      if (decision.grossProfitCents !== null) grossProfitCents = decision.grossProfitCents;
      else if (decision.grossMarginPct !== null) {
        grossProfitCents = Math.round(decision.amountCents * (decision.grossMarginPct / 100));
      }
    }

    const stage = suppression
      ? 'suppressed'
      : decision
        ? 'decided'
        : reply
          ? 'replied'
          : followups.length
            ? 'contacted'
            : 'open';

    const needsHuman =
      !suppression && reply && ESCALATING_REPLIES.has(reply.classification) && !decision
        ? reply.classification
        : null;

    records.push({
      id,
      externalId: created.externalId ?? p.external_id ?? null,
      sourceSystem: created.sourceSystem ?? null,
      customer: p.customer ?? null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      workType: p.work_type ?? null,
      amountCents: cents(p.amount_cents),
      estimateDate: p.estimate_date ?? created.occurredAt,
      createdAt: created.occurredAt,
      ageDays: daysBetween(p.estimate_date ?? created.occurredAt, now),
      crmStatus,
      assignedTo: p.assigned_to ?? null,
      followups,
      followupCount: followups.length,
      sentCount: sentFollowups.length,
      lastFollowupAt: followups.length ? followups[followups.length - 1].at : null,
      followupStage: followups.length ? followups[followups.length - 1].stage : null,
      /* the genuinely most recent thing that happened on this record, whatever it was. it
         used to be the reply, which meant a column headed "latest signal" showed a reply
         from a week before a decision that superseded it. */
      lastSignalAt: [
        decision?.at,
        reply?.at,
        followups.length ? followups[followups.length - 1].at : null,
      ]
        .filter(Boolean)
        .sort()
        .pop() ?? null,
      reply,
      decision,
      suppression,
      stage,
      eligible: !suppression && !decision,
      stopViolations,
      attributed,
      /* the words the portal is allowed to use about this row, and the only place the
         distinction between "approved" and "recovered" is made. */
      attribution: attributed
        ? 'recovered'
        : approved
          ? 'approved — not attributable to follow-up'
          : decision
            ? 'decided'
            : 'pending',
      recoveredRevenueCents: attributed ? decision.amountCents : null,
      recoveredGrossProfitCents: grossProfitCents,
      needsHuman,
      nextAction: needsHuman
        ? `reply to this customer — ${needsHuman}`
        : suppression
          ? null
          : decision
            ? null
            : followups.length === 0
              ? 'first follow-up has not gone out'
              : 'in sequence',
    });
  }

  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  /* two kinds of figure, windowed differently on purpose.
   *
   * a FLOW is a thing that happened — an estimate raised, a decision received, revenue
   * recovered — and is counted inside the window, by the date it happened.
   *
   * a STATE is a thing that is true right now — an estimate still open, one currently held
   * back — and is counted over every record in hand, because an estimate raised two months
   * ago that nobody has answered is still open today.
   *
   * mixing the two is how a funnel ends up reporting more approvals than estimates: the
   * approvals were being counted over all time and the estimates over thirty days, and the
   * shape of the resulting picture was simply wrong. */
  const openEligible = records.filter((r) => r.eligible); // state
  const inWindowRecords = records.filter((r) => inWindow(r.createdAt, from, to)); // flow
  const contacted = records.filter((r) =>
    r.followups.some((f) => !f.failed && inWindow(f.at, from, to)),
  );
  const replied = records.filter((r) => r.reply && inWindow(r.reply.at, from, to));
  const decided = records.filter((r) => r.decision && inWindow(r.decision.at, from, to));
  const attributedRecords = decided.filter((r) => r.attributed);
  const withMargin = attributedRecords.filter((r) => r.recoveredGrossProfitCents !== null);
  const allFollowups = records
    .flatMap((r) => r.followups)
    .filter((f) => inWindow(f.at, from, to));
  const optOuts = records.filter(
    (r) => r.suppression?.reason === 'opted_out' && inWindow(r.suppression.at, from, to),
  );

  return {
    records,
    metrics: {
      eligibleOpen: openEligible.length,
      eligibleValueCents: sum(openEligible.map((r) => r.amountCents ?? 0)),
      created: inWindowRecords.length,
      contacted: contacted.length,
      replies: replied.length,
      decisions: decided.length,
      approved: decided.filter((r) => r.decision.decision === 'approved').length,
      declined: decided.filter((r) => r.decision.decision === 'declined').length,
      deferred: decided.filter((r) => r.decision.decision === 'deferred').length,
      recoveredCount: attributedRecords.length,
      recoveredRevenueCents: attributedRecords.length
        ? sum(attributedRecords.map((r) => r.recoveredRevenueCents))
        : null,
      /* gross profit prints only over the jobs that carried a margin input, and says how
         many that was. a total silently covering half the jobs is worse than no total. */
      recoveredGrossProfitCents: withMargin.length
        ? sum(withMargin.map((r) => r.recoveredGrossProfitCents))
        : null,
      grossProfitCoverage: { withMargin: withMargin.length, total: attributedRecords.length },
      optOutPct: contacted.length === 0 ? null : (optOuts.length / contacted.length) * 100,
      followupFailurePct:
        allFollowups.length === 0
          ? null
          : (allFollowups.filter((f) => f.failed).length / allFollowups.length) * 100,
      stopViolations: sum(records.map((r) => r.stopViolations)),
      suppressed: records.filter((r) => r.suppression).length,
      unknownSuppressions: records.filter((r) => r.suppression && !r.suppression.known).length,
    },
  };
}

/* ══ reviews & service recovery ═══════════════════════════ */

/* the reasons a review request may NOT be withheld. asking only the customers expected to
   say something nice is review gating — against every platform's terms, and the fastest way
   to lose a profile entirely. a skip citing any of these is counted as a breach and shown
   as one rather than being silently honoured. */
export const SENTIMENT_SKIP_REASONS = new Set([
  'low_rating',
  'unhappy',
  'negative_sentiment',
  'bad_review_risk',
  'detractor',
  'sentiment',
  'unhappy_customer',
  'poor_survey',
]);

export const VALID_SKIP_REASONS = {
  opted_out: 'customer opted out',
  no_consent: 'no messaging consent on file',
  duplicate: 'already asked for this job',
  wrong_contact: 'contact details were wrong',
  no_contact: 'no contact details on file',
  client_rule: 'excluded by your own rule',
};

/* a rating at or below this is treated as a service problem first and a review second. */
const SENSITIVE_RATING = 3;

export function buildReviews(events, now, days = 30) {
  const from = now.minus({ days });
  const to = now.plus({ seconds: 1 });
  const byEntity = foldByEntity(events, REVIEW_EVENT_TYPES);
  const records = [];

  for (const [id, steps] of byEntity) {
    const completed = first(steps, 'job_completed');
    if (!completed) continue;

    const p = completed.payload ?? {};
    const requestEvent = last(steps, 'review_request_sent');
    const reviewEvent = last(steps, 'review_received');
    const responseEvent = last(steps, 'review_response_published');
    const recoveryOpen = first(steps, 'service_recovery_opened');
    const recoveryClose = last(steps, 'service_recovery_resolved');

    const skipReason = p.review_request_skipped ?? null;
    const sentimentGated = Boolean(skipReason && SENTIMENT_SKIP_REASONS.has(skipReason));

    const request = requestEvent
      ? {
          at: requestEvent.occurredAt,
          channel: requestEvent.payload?.channel ?? null,
          delivered: requestEvent.status !== 'failure',
          errorClass: requestEvent.errorClass ?? requestEvent.payload?.error_class ?? null,
        }
      : null;

    const rating =
      typeof reviewEvent?.payload?.rating === 'number' ? reviewEvent.payload.rating : null;

    const review = reviewEvent
      ? {
          at: reviewEvent.occurredAt,
          rating,
          platform: reviewEvent.payload?.platform ?? null,
          text: reviewEvent.payload?.text ?? null,
          draftResponse: reviewEvent.payload?.draft_response ?? null,
        }
      : null;

    const lowRated = Boolean(review && rating !== null && rating <= SENSITIVE_RATING);
    const recoveryOpenNow = Boolean(recoveryOpen && !recoveryClose);
    const sensitive = lowRated || recoveryOpenNow;

    const response = responseEvent
      ? {
          at: responseEvent.occurredAt,
          actor: responseEvent.actor ?? responseEvent.payload?.actor ?? 'automation',
          by: responseEvent.payload?.by ?? null,
        }
      : null;

    const recovery = recoveryOpen
      ? {
          openedAt: recoveryOpen.occurredAt,
          reason: recoveryOpen.payload?.reason ?? null,
          priority: recoveryOpen.payload?.priority ?? 'high',
          assignedTo: recoveryOpen.payload?.assigned_to ?? null,
          resolvedAt: recoveryClose?.occurredAt ?? null,
          resolution: recoveryClose?.payload?.resolution ?? null,
        }
      : null;

    const responseState = response
      ? 'published'
      : review?.draftResponse
        ? 'draft awaiting approval'
        : review
          ? 'no response yet'
          : null;

    records.push({
      id,
      externalId: completed.externalId ?? p.external_id ?? null,
      sourceSystem: completed.sourceSystem ?? null,
      customer: p.customer ?? null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      workType: p.work_type ?? null,
      tech: p.tech ?? null,
      completedAt: p.completed_at ?? completed.occurredAt,
      request,
      skipReason,
      skipLabel: skipReason
        ? (VALID_SKIP_REASONS[skipReason] ?? skipReason.replace(/_/g, ' '))
        : null,
      /* the breach: a request withheld because of how the customer was expected to feel. */
      sentimentGated,
      review,
      rating,
      response,
      responseState,
      sensitive,
      /* a defensive or sensitive reply must be approved by a person. one published by an
         automation is a breach of that, and is counted. */
      autoPublishedSensitive: Boolean(sensitive && response && response.actor !== 'human'),
      recovery,
      state: recovery && !recovery.resolvedAt
        ? 'service recovery open'
        : review
          ? `${rating ?? '—'}★ review`
          : request
            ? request.delivered
              ? 'request sent'
              : 'request failed'
            : skipReason
              ? 'request not sent'
              : 'awaiting request',
      needsHuman:
        recovery && !recovery.resolvedAt
          ? 'service recovery'
          : review && review.draftResponse && !response
            ? 'response awaiting approval'
            : sentimentGated
              ? 'request withheld on sentiment'
              : null,
      nextAction:
        recovery && !recovery.resolvedAt
          ? 'call this customer back'
          : review && !response
            ? review.draftResponse
              ? 'approve or edit the drafted response'
              : 'respond to this review'
            : null,
    });
  }

  records.sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  const windowed = records.filter((r) => inWindow(r.completedAt, from, to));
  const eligible = windowed.filter((r) => !r.skipReason || r.sentimentGated);
  const sent = windowed.filter((r) => r.request);
  const delivered = sent.filter((r) => r.request.delivered);
  const reviewed = records.filter((r) => r.review && inWindow(r.review.at, from, to));
  const ratings = reviewed.map((r) => r.rating).filter((n) => typeof n === 'number');
  const recoveries = records.filter((r) => r.recovery);

  return {
    records,
    metrics: {
      eligibleJobs: eligible.length,
      completedJobs: windowed.length,
      requestsSent: sent.length,
      delivered: delivered.length,
      requestCoveragePct: eligible.length === 0 ? null : (sent.length / eligible.length) * 100,
      reviewsReceived: reviewed.length,
      averageRating: ratings.length === 0 ? null : sum(ratings) / ratings.length,
      awaitingResponse: records.filter((r) => r.review && !r.response).length,
      recoveryOpened: recoveries.filter((r) => inWindow(r.recovery.openedAt, from, to)).length,
      recoveryResolved: recoveries.filter(
        (r) => r.recovery.resolvedAt && inWindow(r.recovery.resolvedAt, from, to),
      ).length,
      recoveryOpen: recoveries.filter((r) => !r.recovery.resolvedAt).length,
      gatingBreaches: records.filter((r) => r.sentimentGated).length,
      autoPublishedSensitive: records.filter((r) => r.autoPublishedSensitive).length,
    },
  };
}

/* ══ memberships ══════════════════════════════════════════
   the billing provider retries its own failed charges and the crm books its own visits.
   arc's job is the gap between them: a charge the provider gave up on, a visit that came
   due and was never booked, a cancellation nobody answered. so the metrics here are
   deliberately about exceptions rather than about the book of business. */

const RENEWAL_HORIZON_DAYS = 30;

export function buildMemberships(events, now, days = 30) {
  const from = now.minus({ days });
  const to = now.plus({ seconds: 1 });
  const byEntity = foldByEntity(events, MEMBERSHIP_EVENT_TYPES);
  const records = [];

  for (const [id, steps] of byEntity) {
    /* the snapshot is a periodic sync, so the newest one is the truth about the plan. */
    const recorded = last(steps, 'membership_recorded');
    if (!recorded) continue;

    const p = recorded.payload ?? {};
    const failedEvent = last(steps, 'membership_payment_failed');
    const recoveredEvent = last(steps, 'membership_payment_recovered');
    const dueEvent = last(steps, 'membership_visit_due');
    const bookedEvent = last(steps, 'membership_visit_booked');
    const cancelEvent = last(steps, 'membership_cancellation_requested');

    const paymentFailedAt = failedEvent?.occurredAt ?? null;
    const paymentRecoveredAt = recoveredEvent?.occurredAt ?? null;
    const paymentOpen = Boolean(
      paymentFailedAt && (!paymentRecoveredAt || paymentRecoveredAt < paymentFailedAt),
    );

    const providerRetryState = failedEvent?.payload?.provider_retry_state ?? null;
    /* the provider has stopped trying, so nothing else will happen unless a person acts.
       this is the exact row this module exists to find. */
    const providerExhausted =
      paymentOpen && (providerRetryState === 'exhausted' || providerRetryState === 'none');

    const visitDueAt = dueEvent?.payload?.due_date ?? dueEvent?.occurredAt ?? null;
    const visitBookedAt = bookedEvent?.occurredAt ?? null;
    const visitOpen = Boolean(visitDueAt && (!visitBookedAt || visitBookedAt < dueEvent.occurredAt));
    const visitOverdue = Boolean(visitOpen && visitDueAt && utc(visitDueAt) < now);

    const renewalDate = p.renewal_date ?? null;
    const renewalInDays = renewalDate
      ? Math.round(utc(renewalDate).diff(now, 'days').days)
      : null;

    const cancellation = cancelEvent
      ? {
          at: cancelEvent.occurredAt,
          reason: cancelEvent.payload?.reason ?? null,
          resolvedAt: cancelEvent.payload?.resolved_at ?? null,
        }
      : null;

    const status = cancellation ? 'cancellation requested' : (p.status ?? 'active');

    records.push({
      id,
      externalId: recorded.externalId ?? p.external_id ?? null,
      sourceSystem: recorded.sourceSystem ?? null,
      customer: p.customer ?? null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      plan: p.plan ?? null,
      priceCents: cents(p.price_cents),
      renewalDate,
      renewalInDays,
      status,
      active: status === 'active',
      payment: {
        state: paymentOpen ? 'failed' : paymentRecoveredAt ? 'recovered' : 'ok',
        failedAt: paymentFailedAt,
        amountCents: cents(failedEvent?.payload?.amount_cents),
        attempts: failedEvent?.payload?.attempt ?? null,
        providerRetryState,
        providerExhausted,
        recoveredAt: paymentRecoveredAt,
        recoveredBy: recoveredEvent?.payload?.recovered_by ?? null,
        recoveredAmountCents: cents(recoveredEvent?.payload?.amount_cents),
      },
      visit: {
        dueAt: visitDueAt,
        type: dueEvent?.payload?.visit_type ?? null,
        bookedAt: visitBookedAt,
        appointmentAt: bookedEvent?.payload?.appointment_at ?? null,
        open: visitOpen,
        overdue: visitOverdue,
      },
      cancellation,
      lastCommunicationAt: steps[steps.length - 1].occurredAt,
      assignedTo: p.assigned_to ?? null,
      /* an exception is a thing neither the provider nor the crm is going to resolve. */
      exception: providerExhausted || visitOverdue || Boolean(cancellation && !cancellation.resolvedAt),
      needsHuman: cancellation && !cancellation.resolvedAt
        ? 'cancellation request'
        : providerExhausted
          ? 'failed payment — provider gave up'
          : visitOverdue
            ? 'included visit overdue'
            : null,
      nextAction: cancellation && !cancellation.resolvedAt
        ? 'call before the renewal date'
        : providerExhausted
          ? 'take payment another way'
          : paymentOpen
            ? `provider is retrying${providerRetryState ? ` — ${providerRetryState}` : ''}`
            : visitOpen
              ? 'book the included visit'
              : null,
    });
  }

  records.sort((a, b) => (a.renewalDate ?? '').localeCompare(b.renewalDate ?? ''));

  const active = records.filter((r) => r.active);
  const recoveredInWindow = records.filter(
    (r) => r.payment.recoveredAt && inWindow(r.payment.recoveredAt, from, to),
  );
  const byProvider = recoveredInWindow.filter((r) => r.payment.recoveredBy === 'provider');
  const retained = recoveredInWindow.filter((r) => r.payment.recoveredAmountCents !== null);

  return {
    records,
    metrics: {
      active: active.length,
      renewalsDue: active.filter(
        (r) => r.renewalInDays !== null && r.renewalInDays >= 0 && r.renewalInDays <= RENEWAL_HORIZON_DAYS,
      ).length,
      renewalHorizonDays: RENEWAL_HORIZON_DAYS,
      upcomingVisits: records.filter((r) => r.visit.open && !r.visit.overdue).length,
      overdueVisits: records.filter((r) => r.visit.overdue).length,
      failedPayments: records.filter((r) => r.payment.state === 'failed').length,
      recoveredByProvider: byProvider.length,
      exceptions: records.filter((r) => r.exception).length,
      cancellations: records.filter((r) => r.cancellation && !r.cancellation.resolvedAt).length,
      /* only the amounts a recovery event actually carried. a plan price multiplied by a
         recovered count would be a model, and a model has no place in this column. */
      retainedRevenueCents: retained.length
        ? sum(retained.map((r) => r.payment.recoveredAmountCents))
        : null,
      retainedCoverage: { withAmount: retained.length, total: recoveredInWindow.length },
    },
  };
}

/* ══ install & warranty ═══════════════════════════════════ */

/* a registration is complete when the manufacturer has confirmed it, and "confirmed"
   means a confirmation number and a document — not a workflow that finished without
   erroring. this is the one state in the module that cannot be reached by assertion. */
export function hasRegistrationEvidence(payload = {}) {
  const confirmation = payload.confirmation_number;
  const proof = payload.certificate_url ?? payload.proof_ref;
  return Boolean(
    typeof confirmation === 'string' && confirmation.trim() !== '' &&
      typeof proof === 'string' && proof.trim() !== '',
  );
}

export const INSTALL_STATES = [
  'not required',
  'data needed',
  'ready to register',
  'submitted',
  'deadline approaching',
  'blocked',
  'verified',
];

const DEADLINE_WARN_DAYS = 14;

export function buildInstalls(events, now, days = 30) {
  const from = now.minus({ days });
  const to = now.plus({ seconds: 1 });
  const byEntity = foldByEntity(events, INSTALL_EVENT_TYPES);
  const records = [];

  for (const [id, steps] of byEntity) {
    const completed = first(steps, 'install_completed');
    if (!completed) continue;

    const p = completed.payload ?? {};
    /* closeout is edited repeatedly as the crew fills it in, so every update is merged
       oldest-first and the newest value of each field wins. */
    const closeout = all(steps, 'install_closeout_updated').reduce(
      (acc, e) => ({ ...acc, ...(e.payload ?? {}) }),
      {},
    );
    const submitted = last(steps, 'warranty_registration_submitted');
    const verified = last(steps, 'warranty_registration_verified');
    const blocked = last(steps, 'warranty_registration_blocked');

    const required = closeout.registration_required !== false;
    const deadline = closeout.registration_deadline ?? null;
    const deadlineInDays = deadline ? Math.round(utc(deadline).diff(now, 'days').days) : null;

    const serial = closeout.serial_number ?? null;
    const model = closeout.model_number ?? null;
    const manufacturer = closeout.manufacturer ?? null;
    const missing = [];
    if (!serial) missing.push('serial number');
    if (!model) missing.push('model number');
    if (!manufacturer) missing.push('manufacturer');

    const evidence = verified ? hasRegistrationEvidence(verified.payload) : false;
    /* a verification event that arrived without its evidence does not advance the record.
       it is reported as still submitted, with the gap named. */
    const evidenceMissing = Boolean(verified && !evidence);

    const blockedOpen = Boolean(
      blocked && (!verified || blocked.occurredAt > verified.occurredAt) && !evidence,
    );

    let state;
    if (!required) state = 'not required';
    else if (evidence) state = 'verified';
    else if (blockedOpen) state = 'blocked';
    else if (submitted || evidenceMissing) state = 'submitted';
    else if (missing.length) state = 'data needed';
    else if (deadlineInDays !== null && deadlineInDays <= DEADLINE_WARN_DAYS) {
      state = 'deadline approaching';
    } else state = 'ready to register';

    const packetDelivered = Boolean(closeout.packet_sent);
    const maintenanceAt = closeout.maintenance_scheduled_at ?? null;

    records.push({
      id,
      externalId: completed.externalId ?? p.external_id ?? null,
      sourceSystem: completed.sourceSystem ?? null,
      customer: p.customer ?? null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      job: p.job ?? null,
      installedAt: p.installed_at ?? completed.occurredAt,
      address: p.address ?? null,
      jurisdiction: p.jurisdiction ?? null,
      tech: p.tech ?? closeout.responsible ?? null,
      manufacturer,
      category: closeout.category ?? null,
      modelNumber: model,
      serialNumber: serial,
      photos: Array.isArray(closeout.photos) ? closeout.photos.length : 0,
      registrationRequired: required,
      registrationDeadline: deadline,
      deadlineInDays,
      deadlineApproaching: Boolean(
        required && !evidence && deadlineInDays !== null && deadlineInDays <= DEADLINE_WARN_DAYS,
      ),
      deadlineWarnDays: DEADLINE_WARN_DAYS,
      submittedAt: submitted?.occurredAt ?? null,
      verifiedAt: evidence ? verified.occurredAt : null,
      confirmationNumber: evidence ? verified.payload.confirmation_number : null,
      certificateRef: evidence
        ? (verified.payload.certificate_url ?? verified.payload.proof_ref)
        : null,
      evidenceMissing,
      blockedReason: blockedOpen ? (blocked.payload?.reason ?? 'blocked') : null,
      missingData: missing,
      packetDelivered,
      maintenanceScheduledAt: maintenanceAt,
      state,
      /* closeout is the whole job, not just the registration: the customer has their
         packet, the maintenance visit exists, and the warranty is proven. */
      closeoutComplete: Boolean(
        packetDelivered && (!required || evidence) && (maintenanceAt || closeout.maintenance_not_required),
      ),
      needsHuman: blockedOpen
        ? 'registration blocked'
        : missing.length && required
          ? 'missing equipment data'
          : evidenceMissing
            ? 'registration has no confirmation on file'
            : required && !evidence && deadlineInDays !== null && deadlineInDays <= DEADLINE_WARN_DAYS
              ? 'registration deadline approaching'
              : null,
      nextAction: blockedOpen
        ? (blocked.payload?.reason ?? 'unblock the registration')
        : missing.length && required
          ? `capture the ${missing.join(' and ')}`
          : evidenceMissing
            ? 'attach the confirmation number and certificate'
            : state === 'ready to register' || state === 'deadline approaching'
              ? 'submit the registration'
              : !packetDelivered && evidence
                ? 'send the customer their packet'
                : null,
    });
  }

  records.sort((a, b) => b.installedAt.localeCompare(a.installedAt));

  const windowed = records.filter((r) => inWindow(r.installedAt, from, to));

  return {
    records,
    metrics: {
      installsCompleted: windowed.length,
      closeoutsCompleted: windowed.filter((r) => r.closeoutComplete).length,
      registrationsVerified: records.filter(
        (r) => r.verifiedAt && inWindow(r.verifiedAt, from, to),
      ).length,
      missingData: records.filter((r) => r.registrationRequired && r.missingData.length > 0).length,
      blocked: records.filter((r) => r.blockedReason).length,
      deadlinesApproaching: records.filter((r) => r.deadlineApproaching).length,
      packetsDelivered: windowed.filter((r) => r.packetDelivered).length,
      maintenanceCreated: windowed.filter((r) => r.maintenanceScheduledAt).length,
      evidenceMissing: records.filter((r) => r.evidenceMissing).length,
    },
  };
}

/* ══ the lifecycle funnel ═════════════════════════════════
   captured → qualified → estimated → approved → installed → retained.
 *
 * every stage carries its own availability, because the stages come from five separate
 * integrations. a client with lead capture and nothing else must see four stages that say
 * "not connected" — not four stages that say zero, which would read as a business that
 * quoted nothing and sold nothing. */

export function computeLifecycle(parts, availability, now, days = 30) {
  const { leadCapture, estimates, memberships, installs } = parts;

  const stage = (key, module, label, value, note, to) => {
    const state = availability?.[module]?.state ?? 'unavailable';
    return {
      key,
      module,
      label,
      /* the distinction the whole page turns on: null is "we cannot say", 0 is "none". */
      value: state === 'live' ? value : null,
      state,
      available: state === 'live',
      note: state === 'live' ? note : availability?.[module]?.awaiting ?? null,
      to,
    };
  };

  const qualification = leadCapture.metrics.qualificationSeen
    ? stage(
        'qualified',
        'lead_capture',
        'qualified',
        leadCapture.metrics.qualified,
        'passed job type, service area and capacity',
        'leads?view=qualified',
      )
    : {
        key: 'qualified',
        module: 'lead_capture',
        label: 'qualified',
        value: null,
        state: 'awaiting',
        available: false,
        note: 'qualification is not running yet — leads are captured and routed without it',
        to: 'leads',
      };

  return [
    stage(
      'captured',
      'lead_capture',
      'captured',
      leadCapture.metrics.opportunities,
      'calls and forms that came in',
      'leads',
    ),
    qualification,
    stage(
      'estimated',
      'estimates',
      'estimated',
      estimates.metrics.created,
      'quotes raised in the window',
      'estimates',
    ),
    stage(
      'approved',
      'estimates',
      'approved',
      estimates.metrics.approved,
      'customers who said yes',
      'estimates?view=approved',
    ),
    stage(
      'installed',
      'installs',
      'installed',
      installs.metrics.installsCompleted,
      'installations completed',
      'installs',
    ),
    stage(
      'retained',
      'memberships',
      'retained',
      memberships.metrics.active,
      'active service agreements',
      'memberships',
    ),
  ];
}
