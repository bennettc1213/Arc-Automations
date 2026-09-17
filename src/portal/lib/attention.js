/* the one queue: everything across every module that needs a person, in the order a person
 * should do it.
 *
 * built from the state of the records rather than from a table of tasks. a stored task list
 * is a second source of truth that starts drifting the moment a customer replies and nothing
 * closes the row — and the failure mode of a stale queue is worse than no queue, because it
 * is a list of things somebody has already stopped reading.
 *
 * so: every module hands back records that know their own `needsHuman`, and this file turns
 * those into one sorted list. a record that stops needing a person stops being in the queue
 * on the next render, with no write anywhere.
 *
 * `task_opened` / `task_resolved` exist alongside that for the cases no rule could infer —
 * a workflow that knows something the log does not show. those are folded in here too, and
 * deduped against the derived items so one problem is one row.
 */

import { utc } from './metrics.js';
import { MODULE_LABEL, moduleForEvent } from './types.js';
import { SAFETY_FLAG_LABEL } from './lifecycle.js';

export const PRIORITIES = ['urgent', 'high', 'normal'];
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 };

export const PRIORITY_TONE = { urgent: 'fail', high: 'warn', normal: 'neutral' };

/* the warranty deadline is the only due date in the product that is genuinely fixed by
   somebody else, so it is the only one that escalates on its own as it approaches. */
const DEADLINE_URGENT_DAYS = 7;

/* a lead is perishable in a way nothing else in this product is. an estimate from six weeks
 * ago is still a live quote, a warranty deadline six weeks out is still a deadline — but a
 * customer who called six weeks ago and was never called back has hired somebody else, and
 * putting them at the top of today's queue is not an action, it is a reproach.
 *
 * so lead-capture items age out of the QUEUE at two weeks. they do not age out of the
 * metrics: `safetyBreaches` still counts every one in the window, because that figure is a
 * compliance record rather than a to-do list, and the whole point of it is that it cannot
 * be cleared by time passing.
 */
const LEAD_QUEUE_DAYS = 14;

function item(fields) {
  return {
    priority: 'normal',
    assignedTo: null,
    dueAt: null,
    state: null,
    detail: null,
    ...fields,
    moduleLabel: MODULE_LABEL[fields.module] ?? fields.module,
    key: `${fields.module}:${fields.entityId}:${fields.reasonKey}`,
  };
}

/* ── per-module extraction ───────────────────────────────── */

function fromLeads(leads, now) {
  const out = [];
  const freshEnough = (iso) => iso && utc(iso) > now.minus({ days: LEAD_QUEUE_DAYS });

  for (const lead of leads) {
    if (!freshEnough(lead.startedAt)) continue;

    if (lead.safetyBreach) {
      out.push(
        item({
          module: 'lead_capture',
          entityType: 'lead',
          entityId: lead.id,
          customer: lead.name ?? lead.phone ?? 'unknown caller',
          reasonKey: 'safety',
          reason: 'safety escalation',
          detail:
            lead.safetyFlags.map((f) => SAFETY_FLAG_LABEL[f] ?? f).join(', ') ||
            'emergency urgency',
          priority: 'urgent',
          openedAt: lead.startedAt,
          dueAt: lead.startedAt,
          state: 'automation stopped',
          to: `leads?record=${encodeURIComponent(lead.id)}`,
        }),
      );
      continue;
    }

    if (lead.handoff && !lead.handoff.resolvedAt) {
      out.push(
        item({
          module: 'lead_capture',
          entityType: 'lead',
          entityId: lead.id,
          customer: lead.name ?? lead.phone ?? 'unknown caller',
          reasonKey: 'handoff',
          reason: 'handed to a person',
          detail: lead.handoff.reason,
          priority: 'urgent',
          openedAt: lead.handoff.at,
          dueAt: lead.handoff.at,
          assignedTo: lead.handoff.assignedTo,
          state: 'waiting on a person',
          to: `leads?record=${encodeURIComponent(lead.id)}`,
        }),
      );
      continue;
    }

    if (lead.unacknowledged) {
      out.push(
        item({
          module: 'lead_capture',
          entityType: 'lead',
          entityId: lead.id,
          customer: lead.name ?? lead.phone ?? 'unknown caller',
          reasonKey: 'unacknowledged',
          reason: 'routed, nobody picked it up',
          detail: lead.routingDestination ? `sent to ${lead.routingDestination}` : null,
          priority: 'high',
          openedAt: lead.startedAt,
          assignedTo: lead.routingDestination,
          state: 'routed',
          to: `leads?record=${encodeURIComponent(lead.id)}`,
        }),
      );
    }
  }

  return out;
}

function fromEstimates(records) {
  const out = [];

  for (const record of records) {
    if (!record.needsHuman) continue;
    const urgent = record.needsHuman === 'objection';
    out.push(
      item({
        module: 'estimates',
        entityType: 'estimate',
        entityId: record.id,
        customer: record.customer ?? 'unnamed customer',
        reasonKey: `reply_${record.needsHuman}`,
        reason:
          record.needsHuman === 'interested'
            ? 'interested — waiting on you'
            : record.needsHuman === 'objection'
              ? 'customer objection'
              : 'customer asked a question',
        detail: record.reply?.body ?? null,
        priority: urgent ? 'urgent' : 'high',
        openedAt: record.reply.at,
        dueAt: record.reply.at,
        assignedTo: record.assignedTo,
        state: 'sequence stopped on reply',
        to: `estimates?record=${encodeURIComponent(record.id)}`,
      }),
    );
  }

  return out;
}

function fromReviews(records) {
  const out = [];

  for (const record of records) {
    if (!record.needsHuman) continue;

    const isRecovery = record.needsHuman === 'service recovery';
    out.push(
      item({
        module: 'reviews',
        entityType: isRecovery ? 'job' : 'review',
        entityId: record.id,
        customer: record.customer ?? 'unnamed customer',
        reasonKey: isRecovery
          ? 'recovery'
          : record.needsHuman === 'request withheld on sentiment'
            ? 'gating'
            : 'response',
        reason: isRecovery
          ? 'negative service experience'
          : record.needsHuman === 'request withheld on sentiment'
            ? 'review request withheld on sentiment'
            : 'response awaiting approval',
        detail: isRecovery
          ? (record.recovery?.reason ?? record.review?.text ?? null)
          : (record.review?.text ?? null),
        priority: isRecovery ? 'urgent' : record.sentimentGated ? 'high' : 'normal',
        openedAt: record.recovery?.openedAt ?? record.review?.at ?? record.completedAt,
        dueAt: record.recovery?.openedAt ?? null,
        assignedTo: record.recovery?.assignedTo ?? null,
        state: record.state,
        to: `reviews?record=${encodeURIComponent(record.id)}`,
      }),
    );
  }

  return out;
}

function fromMemberships(records) {
  const out = [];

  for (const record of records) {
    if (!record.needsHuman) continue;
    const cancelling = record.needsHuman === 'cancellation request';

    out.push(
      item({
        module: 'memberships',
        entityType: 'membership',
        entityId: record.id,
        customer: record.customer ?? 'unnamed member',
        reasonKey: cancelling
          ? 'cancellation'
          : record.needsHuman === 'included visit overdue'
            ? 'visit'
            : 'payment',
        reason: record.needsHuman,
        detail: cancelling
          ? (record.cancellation?.reason ?? null)
          : record.payment.state === 'failed'
            ? `${record.payment.attempts ?? 1} attempt${record.payment.attempts === 1 ? '' : 's'} · provider ${record.payment.providerRetryState ?? 'unknown'}`
            : record.visit.type,
        priority: 'high',
        openedAt: cancelling
          ? record.cancellation.at
          : (record.payment.failedAt ?? record.visit.dueAt ?? record.lastCommunicationAt),
        dueAt: cancelling ? record.renewalDate : record.visit.dueAt,
        assignedTo: record.assignedTo,
        state: record.status,
        to: `memberships?record=${encodeURIComponent(record.id)}`,
      }),
    );
  }

  return out;
}

function fromInstalls(records) {
  const out = [];

  for (const record of records) {
    if (!record.needsHuman) continue;
    const deadlineUrgent =
      record.deadlineInDays !== null && record.deadlineInDays <= DEADLINE_URGENT_DAYS;

    out.push(
      item({
        module: 'installs',
        entityType: 'install',
        entityId: record.id,
        customer: record.customer ?? 'unnamed customer',
        reasonKey: record.blockedReason
          ? 'blocked'
          : record.missingData.length
            ? 'missing_data'
            : record.evidenceMissing
              ? 'no_evidence'
              : 'deadline',
        reason: record.needsHuman,
        detail:
          record.blockedReason ??
          (record.missingData.length ? `missing ${record.missingData.join(', ')}` : null) ??
          (record.registrationDeadline
            ? `manufacturer deadline in ${record.deadlineInDays} days`
            : null),
        priority: record.blockedReason || deadlineUrgent ? 'high' : 'normal',
        openedAt: record.installedAt,
        dueAt: record.registrationDeadline,
        assignedTo: record.tech,
        state: record.state,
        to: `installs?record=${encodeURIComponent(record.id)}`,
      }),
    );
  }

  return out;
}

/* an automation that is failing is a task in its own right, and the most urgent kind: every
   other row in this queue assumes the pipeline that produced it is still running. */
function fromHealth(health) {
  return Object.values(health)
    .filter((module) => module.state === 'failing')
    .map((module) =>
      item({
        module: module.key,
        entityType: 'task',
        entityId: `health:${module.key}`,
        customer: module.label,
        reasonKey: 'automation_failure',
        reason: 'automation failure',
        detail: module.summary,
        priority: 'urgent',
        openedAt: module.lastCheckAt ?? module.lastSuccessAt,
        state: module.word,
        to: `activity?module=${module.key}`,
      }),
    );
}

/* explicit tasks: what a workflow raised that no rule above would have found. */
function fromTaskEvents(events) {
  const open = new Map();

  for (const event of events) {
    if (event.eventType !== 'task_opened' && event.eventType !== 'task_resolved') continue;
    const id = event.entityId ?? event.payload?.entity_id ?? event.correlationId ?? event.id;
    if (event.eventType === 'task_resolved') {
      open.delete(id);
      continue;
    }

    const p = event.payload ?? {};
    open.set(
      id,
      item({
        module: moduleForEvent(event),
        entityType: event.entityType ?? p.entity_type ?? 'task',
        entityId: id,
        customer: p.customer ?? p.subject ?? 'unnamed',
        reasonKey: p.reason_key ?? 'raised',
        reason: p.reason ?? 'needs a person',
        detail: p.detail ?? null,
        priority: PRIORITIES.includes(p.priority) ? p.priority : 'normal',
        openedAt: event.occurredAt,
        dueAt: p.due_at ?? null,
        assignedTo: p.assigned_to ?? null,
        state: p.state ?? 'open',
        to: p.link ?? 'activity',
      }),
    );
  }

  return [...open.values()];
}

/* ── assembly ────────────────────────────────────────────── */

export function buildAttentionQueue(parts, health, events, availability, now, limit = 0) {
  const { leadCapture, estimates, reviews, memberships, installs } = parts;
  const live = (key) => availability?.[key]?.state === 'live';

  const raw = [
    ...(live('lead_capture') ? fromLeads(leadCapture.leads, now) : []),
    ...(live('estimates') ? fromEstimates(estimates.records) : []),
    ...(live('reviews') ? fromReviews(reviews.records) : []),
    ...(live('memberships') ? fromMemberships(memberships.records) : []),
    ...(live('installs') ? fromInstalls(installs.records) : []),
    ...fromHealth(health),
    ...fromTaskEvents(events),
  ];

  /* one problem, one row. a derived item and an explicit task about the same record are the
     same problem said twice, and the first one wins because it carries the record's live
     state rather than whatever was true when the task was written. */
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    items.push({
      ...entry,
      overdue: Boolean(entry.dueAt && utc(entry.dueAt) < now),
      ageHours: entry.openedAt ? Math.max(0, now.diff(utc(entry.openedAt), 'hours').hours) : null,
    });
  }

  /* urgency first, then what is already late, then oldest. deliberately not newest-first:
     the thing that has been waiting longest is the thing most likely to have been
     forgotten, and a queue sorted newest-first buries it a little further every day. */
  items.sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    return String(a.openedAt ?? '').localeCompare(String(b.openedAt ?? ''));
  });

  /* counts are taken over the whole queue and the list is capped after, so the rail badge
     and the panel header report what is actually waiting rather than what fitted in the
     payload. a truncated count is the one number here that would be worth nothing. */
  const counts = { urgent: 0, high: 0, normal: 0 };
  for (const entry of items) counts[entry.priority]++;

  const byModule = items.reduce((acc, entry) => {
    acc[entry.module] = (acc[entry.module] ?? 0) + 1;
    return acc;
  }, {});

  return {
    items: limit ? items.slice(0, limit) : items,
    counts,
    total: items.length,
    shown: limit ? Math.min(limit, items.length) : items.length,
    urgent: counts.urgent,
    byModule,
  };
}
