/* second-order derivations: the shapes the portal's pages read.
 *
 * everything here is computed from the same raw event log the headline metrics come from,
 * so the leads table, the automations page and the reliability page can never tell a
 * different story from the number at the top of the overview. nothing is stored
 * pre-aggregated and nothing is estimated — if a figure cannot be derived from events that
 * actually happened, this file does not produce it.
 */

import { DateTime } from 'luxon';
import { isClientVisible, percentile, statsForRange, utc } from './metrics.js';

export const SOURCE_LABEL = {
  missed_call: 'missed call',
  web_form: 'web form',
  gbp_message: 'google message',
};

/* the catalogue is descriptions only. every number attached to a workflow on the
   automations page is counted from its events, so an automation that stopped running shows
   as stopped rather than as whatever the catalogue claims it does. */
export const WORKFLOW_CATALOGUE = {
  wf_speed_to_lead_v3: {
    name: 'speed to lead',
    kind: 'client',
    blurb:
      'a web form or google business message arrives, and a text goes back with their name on it before they open a second tab.',
  },
  wf_missed_call_textback_v2: {
    name: 'missed-call text-back',
    kind: 'client',
    blurb:
      'a call rings out unanswered, and the caller gets a text back instead of dialling the next company on the list.',
  },
  wf_oncall_routing_v1: {
    name: 'on-call routing',
    kind: 'client',
    blurb:
      'the lead is pushed to whoever is on call right now, loss type attached, so nobody has to be watching an inbox.',
  },
  wf_reply_capture_v1: {
    name: 'reply capture',
    kind: 'client',
    blurb:
      'when the customer texts back, the reply lands in the feed rather than on a phone nobody is holding.',
  },
  wf_canary_emit: {
    name: 'canary — emit',
    kind: 'monitoring',
    blurb:
      'every hour a synthetic lead is pushed through the live pipeline, tagged so it can never reach a customer or a count.',
  },
  wf_canary_verify: {
    name: 'canary — verify',
    kind: 'monitoring',
    blurb:
      'a separate run checks the canary actually came out the far end. a workflow that verifies its own output proves nothing.',
  },
};

function catalogueEntry(workflowId) {
  return (
    WORKFLOW_CATALOGUE[workflowId] ?? {
      name: String(workflowId ?? 'unattributed').replace(/^wf_/, '').replace(/_/g, ' '),
      kind: 'client',
      blurb: null,
    }
  );
}

/* ── threads ──────────────────────────────────────────────
   a flat event log is what the database holds, but it is not what happened. what happened
   is "a call came in at 2:14am and got a text back in eight seconds". threading by
   correlation id is what turns the log back into that sentence, and every surface that
   shows lead-level information reads these rather than re-grouping the log itself. */

const STEP_ORDER = ['call_missed', 'lead_received', 'sms_sent', 'routed', 'reply_received'];

export function buildThreads(events, limit = 150) {
  const byKey = new Map();

  for (const event of events) {
    if (!isClientVisible(event)) continue;
    const key = event.correlationId ?? event.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  }

  const threads = [...byKey.entries()].map(([id, list]) => {
    /* oldest-first inside a thread: a pipeline reads in the order it ran, even though the
       list of threads is newest-first. ties are broken by pipeline position, because two
       events written in the same millisecond still happened in a known order. */
    const steps = list.slice().sort((a, b) => {
      const byTime = a.occurredAt.localeCompare(b.occurredAt);
      return byTime !== 0
        ? byTime
        : STEP_ORDER.indexOf(a.eventType) - STEP_ORDER.indexOf(b.eventType);
    });

    const lead = steps.find((e) => e.eventType === 'lead_received');
    const call = steps.find((e) => e.eventType === 'call_missed');
    const sms = steps.find((e) => e.eventType === 'sms_sent');
    const routed = steps.find((e) => e.eventType === 'routed');
    const reply = steps.find((e) => e.eventType === 'reply_received');

    const payload = { ...(call?.payload ?? {}), ...(lead?.payload ?? {}) };
    const source = payload.source ?? (call ? 'missed_call' : null);
    const failed = sms?.status === 'failure';

    return {
      id,
      startedAt: steps[0].occurredAt,
      source,
      sourceLabel: SOURCE_LABEL[source] ?? 'lead',
      name: payload.caller ?? null,
      phone: payload.phone ?? payload.from ?? null,
      lossType: payload.loss_type ?? routed?.payload?.loss_type ?? null,
      latencyMs: sms && !failed ? sms.latencyMs : null,
      failed,
      failureReason: failed ? (sms.payload?.error ?? null) : null,
      tech: routed?.payload?.tech ?? null,
      replied: Boolean(reply),
      repliedAt: reply?.occurredAt ?? null,
      /* the state a person would use out loud. ordered by what supersedes what: a reply is
         the strongest signal the thread worked, a failed send the strongest that it did not. */
      state: failed ? 'send failed' : reply ? 'replied' : routed ? 'routed' : sms ? 'answered' : 'received',
      /* only the three fields a rendered step needs. the row id and the workflow id are
         dropped on purpose: two hundred threads carrying five extra uuid-length strings
         each is forty kilobytes on the wire to draw nothing. */
      steps: steps.map((s) => ({ type: s.eventType, at: s.occurredAt, status: s.status })),
    };
  });

  threads.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return limit ? threads.slice(0, limit) : threads;
}

/* ── where leads come from ────────────────────────────── */

export function computeSources(threads, now, days = 30) {
  const cutoff = now.minus({ days });
  const counts = new Map();

  for (const thread of threads) {
    if (utc(thread.startedAt) < cutoff) continue;
    const key = thread.source ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: SOURCE_LABEL[key] ?? 'other',
      count,
      pct: total === 0 ? 0 : (count / total) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

/* ── when leads come in ───────────────────────────────────
   the strongest argument this product makes to a service business, so it gets its own
   readout: the share of leads that arrive when nobody is at a desk. a burst pipe at 2am is
   the job that pays and the one their competitor sleeps through. */

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 18;

export function computeHourly(threads, timezone, now, days = 30) {
  const cutoff = now.minus({ days });
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  let afterHours = 0;
  let total = 0;

  for (const thread of threads) {
    const at = utc(thread.startedAt);
    if (at < cutoff) continue;
    const hour = at.setZone(timezone).hour;
    hours[hour].count++;
    total++;
    if (hour < DAY_START_HOUR || hour >= DAY_END_HOUR) afterHours++;
  }

  return {
    hours,
    total,
    afterHours,
    afterHoursPct: total === 0 ? null : (afterHours / total) * 100,
    windowLabel: `${DAY_END_HOUR}:00–${String(DAY_START_HOUR).padStart(2, '0')}:00`,
  };
}

/* ── who the work goes to ─────────────────────────────── */

export function computeRouting(threads, now, days = 30) {
  const cutoff = now.minus({ days });
  const byTech = new Map();

  for (const thread of threads) {
    if (!thread.tech || utc(thread.startedAt) < cutoff) continue;
    if (!byTech.has(thread.tech)) byTech.set(thread.tech, { tech: thread.tech, count: 0, replied: 0 });
    const row = byTech.get(thread.tech);
    row.count++;
    if (thread.replied) row.replied++;
  }

  const total = [...byTech.values()].reduce((sum, r) => sum + r.count, 0);

  return [...byTech.values()]
    .map((row) => ({ ...row, pct: total === 0 ? 0 : (row.count / total) * 100 }))
    .sort((a, b) => b.count - a.count);
}

/* ── automations ──────────────────────────────────────────
   one row per workflow that actually emitted something in the window. a run is an
   execution, not an event: a workflow that writes four rows per lead has not run four
   times. `lastRunAt` is what makes a stopped automation visible — a 100% success rate
   whose last run was nine days ago is a broken integration, not a healthy one. */

export function computeAutomations(events, now, days = 30) {
  const cutoff = now.minus({ days });
  const byWorkflow = new Map();

  for (const event of events) {
    const id = event.workflowId ?? 'unattributed';
    if (!byWorkflow.has(id)) {
      byWorkflow.set(id, {
        id,
        executions: new Map(),
        lastRunAt: null,
        lastFailureAt: null,
        latencies: [],
        eventsInWindow: 0,
      });
    }

    const row = byWorkflow.get(id);
    if (!row.lastRunAt || event.occurredAt > row.lastRunAt) row.lastRunAt = event.occurredAt;
    if (event.status === 'failure' && (!row.lastFailureAt || event.occurredAt > row.lastFailureAt)) {
      row.lastFailureAt = event.occurredAt;
    }
    if (utc(event.occurredAt) < cutoff) continue;

    row.eventsInWindow++;
    const key = event.executionId ?? event.id;
    if (!row.executions.has(key)) row.executions.set(key, { failed: false });
    if (event.status === 'failure') row.executions.get(key).failed = true;
    if (event.status === 'success' && event.latencyMs !== null) row.latencies.push(event.latencyMs);
  }

  return [...byWorkflow.values()]
    .map((row) => {
      const runs = row.executions.size;
      const failures = [...row.executions.values()].filter((e) => e.failed).length;
      const entry = catalogueEntry(row.id);
      const quiet = row.lastRunAt ? utc(row.lastRunAt) < now.minus({ hours: 26 }) : true;
      /* state is about right now, not about the window. an incident that was caught and
         fixed three weeks ago still shows in the failure count — it should, it happened —
         but painting the row red today would say the automation is broken today, and a
         status light that stays red after the fix is a status light people stop reading. */
      const failingNow = row.lastFailureAt
        ? utc(row.lastFailureAt) >= now.minus({ hours: 24 })
        : false;

      return {
        id: row.id,
        name: entry.name,
        kind: entry.kind,
        blurb: entry.blurb,
        runs,
        failures,
        successPct: runs === 0 ? null : ((runs - failures) / runs) * 100,
        medianLatencyMs: percentile(row.latencies.slice().sort((a, b) => a - b), 0.5),
        eventsInWindow: row.eventsInWindow,
        lastRunAt: row.lastRunAt,
        lastFailureAt: row.lastFailureAt ?? null,
        /* "quiet" is deliberately not "broken". a low-volume client can genuinely go two
           days without a missed call, so a workflow that has not fired since yesterday is
           reported as quiet with its last run time attached and left for a person to read.
           calling that a failure trains people to ignore the failure colour. */
        state: failingNow ? 'failing' : runs === 0 ? 'idle' : quiet ? 'quiet' : 'healthy',
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'client' ? -1 : 1;
      return b.runs - a.runs;
    });
}

/* ── reliability ──────────────────────────────────────────
   the canary log, day by day. a green strip with two red days in it is the honest picture
   and the persuasive one: ninety days of unbroken green reads as fabricated, and a failure
   that was detected, alerted on and fixed IS the product working. */

export function computeReliability(events, timezone, now, days = 30) {
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = now.minus({ days: i }).setZone(timezone).toFormat('yyyy-MM-dd');
    byDay.set(date, { date, checks: 0, failures: 0 });
  }

  const cutoff = now.minus({ days });
  let latest = null;

  for (const event of events) {
    if (event.eventType !== 'canary_check') continue;
    if (!latest || event.occurredAt > latest.occurredAt) latest = event;
    if (utc(event.occurredAt) < cutoff) continue;

    const date = utc(event.occurredAt).setZone(timezone).toFormat('yyyy-MM-dd');
    const row = byDay.get(date);
    if (!row) continue;
    row.checks++;
    if (event.status === 'failure') row.failures++;
  }

  const daily = [...byDay.values()].map((row) => ({
    ...row,
    label: DateTime.fromFormat(row.date, 'yyyy-MM-dd', { zone: timezone }).toFormat('LLL d'),
    state: row.checks === 0 ? 'none' : row.failures > 0 ? 'failed' : 'ok',
  }));

  const checks = daily.reduce((sum, d) => sum + d.checks, 0);
  const failures = daily.reduce((sum, d) => sum + d.failures, 0);

  return {
    daily,
    checks,
    failures,
    uptimePct: checks === 0 ? null : ((checks - failures) / checks) * 100,
    lastCheckAt: latest?.occurredAt ?? null,
    intervalLabel: 'hourly',
  };
}

/* alerts are the only mutable table in the schema, and the only place a human timeline
   (detected → acknowledged → resolved) exists. rendered as-is; nothing is inferred. */
export function buildIncidents(alerts = [], now) {
  return alerts
    .slice()
    .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
    .map((alert) => {
      const fired = utc(alert.firedAt);
      const resolved = alert.resolvedAt ? utc(alert.resolvedAt) : null;
      return {
        id: alert.id,
        checkType: alert.checkType,
        severity: alert.severity,
        message: alert.message,
        firedAt: alert.firedAt,
        acknowledgedAt: alert.acknowledgedAt ?? null,
        resolvedAt: alert.resolvedAt ?? null,
        open: !resolved,
        detectMs: alert.acknowledgedAt ? utc(alert.acknowledgedAt).diff(fired).milliseconds : null,
        durationMs: (resolved ?? now).diff(fired).milliseconds,
      };
    });
}

/* ── period comparison ────────────────────────────────────
   a delta is only shown when the window behind it is genuinely covered. a client in their
   fifth week has no previous thirty days, and inventing a comparison against a partly
   empty period is the exact species of quiet wrongness this portal exists to rule out. */

function pctChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  if (current === null || current === undefined) return null;
  return ((current - previous) / previous) * 100;
}

function comparison(current, previous, comparable) {
  return (key, lowerIsBetter = false) => {
    const pct = comparable ? pctChange(current[key], previous[key]) : null;
    return {
      current: current[key],
      previous: comparable ? previous[key] : null,
      pct,
      /* direction is the arrow, `good` is the colour. they are separate because a
         response time going down is an arrow pointing down and a result worth being
         pleased about, and conflating the two is how a dashboard ends up painting an
         improvement red. */
      direction: pct === null || pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down',
      good: pct === null || pct === 0 ? null : lowerIsBetter ? pct < 0 : pct > 0,
    };
  };
}

export function computeDeltas(events, tenant, timezone, now, days = 30) {
  const end = now.plus({ seconds: 1 });
  const currentFrom = now.minus({ days });
  const previousFrom = now.minus({ days: days * 2 });

  /* two conditions, both required, for any comparison: the tenant has to have existed for
     the whole earlier period, and the fetched window has to actually reach back into it. */
  const earliestIso = events.reduce(
    (min, e) => (min === null || e.occurredAt < min ? e.occurredAt : min),
    null,
  );
  const covers = (from) =>
    Boolean(
      utc(tenant.createdAt) <= from && earliestIso !== null && utc(earliestIso) <= from.plus({ days: 1 }),
    );

  const rollingComparable = covers(previousFrom);
  const rolling = comparison(
    statsForRange(events, timezone, currentFrom, end),
    statsForRange(events, timezone, previousFrom, currentFrom),
    rollingComparable,
  );

  /* the signed-in dashboard headlines the calendar month, so it needs a comparison the
     month can actually carry. a partial september against the whole of august is a fifty
     percent collapse every single month, which is not a fact about the business — so this
     compares month-to-date against the same elapsed span of the previous month.
     clamped at the month boundary for the case a 31st has no counterpart in february. */
  const monthStart = now.setZone(timezone).startOf('month');
  const previousMonthStart = monthStart.minus({ months: 1 });
  const previousMonthEnd = DateTime.min(previousMonthStart.plus(now.diff(monthStart)), monthStart);

  const monthComparable = covers(previousMonthStart);
  const month = comparison(
    statsForRange(events, timezone, monthStart, end),
    statsForRange(events, timezone, previousMonthStart, previousMonthEnd),
    monthComparable,
  );

  return {
    comparable: rollingComparable,
    periodLabel: `vs previous ${days} days`,
    leads: rolling('leads'),
    missedCallsAnswered: rolling('missedCallsAnswered'),
    medianResponseMs: rolling('medianResponseMs', true),
    uptimePct: rolling('uptimePct'),
    monthToDate: {
      comparable: monthComparable,
      periodLabel: 'vs same point last month',
      leads: month('leads'),
      missedCallsAnswered: month('missedCallsAnswered'),
      medianResponseMs: month('medianResponseMs', true),
    },
  };
}

/* ── month rollups ────────────────────────────────────────
   months only partly covered by the fetched window are marked partial rather than hidden.
   hiding them makes the table look like the months did not happen; labelling them lets a
   client read the number and know exactly how much of the month is behind it. */

export function computeMonthly(events, timezone, now, months = 6) {
  const earliestIso = events.reduce(
    (min, e) => (min === null || e.occurredAt < min ? e.occurredAt : min),
    null,
  );
  if (!earliestIso) return [];
  const earliest = utc(earliestIso);

  const rows = [];

  for (let i = 0; i < months; i++) {
    const start = now.setZone(timezone).startOf('month').minus({ months: i });
    const end = start.plus({ months: 1 });
    if (end <= earliest) break;

    const stats = statsForRange(events, timezone, start, end > now ? now.plus({ seconds: 1 }) : end);
    if (stats.leads === 0 && stats.checks === 0) continue;

    rows.push({
      key: start.toFormat('yyyy-MM'),
      label: start.toFormat('LLLL yyyy'),
      leads: stats.leads,
      missedCallsAnswered: stats.missedCallsAnswered,
      medianResponseMs: stats.medianResponseMs,
      uptimePct: stats.uptimePct,
      sends: stats.sends,
      /* partial in either direction: the month is still running, or the fetched window
         starts after the first of it. */
      partial: end > now || start < earliest,
      inProgress: end > now,
    });
  }

  return rows;
}
