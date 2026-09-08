/* derives every displayed number from the raw event log.
   one definition per metric, deliberately, so "leads this month" cannot come to mean two
   different things in two places. the credibility rule governs all of it: only numbers we
   can prove. nothing here models, extrapolates, or attributes revenue.

   this module holds the primitives. second-order derivations (threads, sources,
   automations, reliability, month rollups) live in derive.js, and dashboard-data.js
   assembles both into the shape the ui consumes — three modules pointing one direction, so
   nothing in here has to know what a page looks like. */

import { DateTime } from 'luxon';
// explicit extension: this module is also imported by the node build script, and node esm
// does not resolve extensionless paths the way vite does.
import { CLIENT_VISIBLE_EVENT_TYPES } from './types.js';

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

export function utc(iso) {
  return DateTime.fromISO(iso, { zone: 'utc' });
}

/* canaries traverse the same live pipeline and emit real-shaped rows, so they must never
   inflate a client-facing count. */
export function realLeads(events) {
  return events.filter((e) => e.eventType === 'lead_received' && !e.isCanary);
}

export function isClientVisible(event) {
  return !event.isCanary && CLIENT_VISIBLE_EVENT_TYPES.includes(event.eventType);
}

/* the threads whose acknowledgement text actually left the building. computed over the
   whole log rather than a window, because a call at 23:58 answered at 00:01 must not be
   turned into an unanswered call by a window boundary. */
export function answeredThreadIds(events) {
  return new Set(
    events
      .filter((e) => e.eventType === 'sms_sent' && e.status === 'success' && !e.isCanary)
      .map((e) => e.correlationId)
      .filter(Boolean),
  );
}

/* every windowed figure in the portal comes through here, so a month rollup, a
   period-over-period delta and the headline row cannot come to disagree about what
   "median response" means. `from` is inclusive, `to` exclusive. */
export function statsForRange(events, timezone, from, to) {
  const inRange = (iso) => {
    const at = utc(iso);
    return at >= from && at < to;
  };

  const leads = realLeads(events).filter((e) => inRange(e.occurredAt)).length;

  /* response time comes only from sends that succeeded. a failed send is not a fast
     response. median, not mean: one four-hour carrier delay destroys a mean, and a
     response-time figure a contractor can challenge takes every other number down with it. */
  const latencies = events
    .filter(
      (e) =>
        e.eventType === 'sms_sent' &&
        !e.isCanary &&
        e.status === 'success' &&
        e.latencyMs !== null &&
        inRange(e.occurredAt),
    )
    .map((e) => e.latencyMs)
    .sort((a, b) => a - b);

  /* "answered", never "recovered": recovered implies the job came back, which cannot be
     proven without booking data the automation does not have. */
  const answered = answeredThreadIds(events);
  const missedCallsAnswered = events.filter(
    (e) =>
      e.eventType === 'call_missed' &&
      !e.isCanary &&
      e.correlationId &&
      answered.has(e.correlationId) &&
      inRange(e.occurredAt),
  ).length;

  const checks = events.filter((e) => e.eventType === 'canary_check' && inRange(e.occurredAt));
  const checksPassed = checks.filter((c) => c.status === 'success').length;

  return {
    leads,
    sends: latencies.length,
    medianResponseMs: percentile(latencies, 0.5),
    p90ResponseMs: percentile(latencies, 0.9),
    missedCallsAnswered,
    checks: checks.length,
    checksFailed: checks.length - checksPassed,
    uptimePct: checks.length === 0 ? null : (checksPassed / checks.length) * 100,
  };
}

export function computeMetrics(events, timezone, now) {
  /* `to` sits a hair past now rather than on it, so an event stamped this exact
     millisecond is not dropped by the half-open range. */
  const end = now.plus({ seconds: 1 });
  const last30 = statsForRange(events, timezone, now.minus({ days: 30 }), end);
  const thisMonth = statsForRange(events, timezone, now.startOf('month'), end);

  return {
    leadsThisMonth: thisMonth.leads,
    leadsLast30Days: last30.leads,
    medianResponseMs: last30.medianResponseMs,
    p90ResponseMs: last30.p90ResponseMs,
    missedCallsAnswered: last30.missedCallsAnswered,
    uptimePct: last30.uptimePct,
    sends: last30.sends,
  };
}

export function computeLeadsPerDay(events, timezone, now, days = 30) {
  const counts = new Map();
  for (let i = days - 1; i >= 0; i--) {
    counts.set(now.minus({ days: i }).setZone(timezone).toFormat('yyyy-MM-dd'), 0);
  }

  for (const event of realLeads(events)) {
    const key = utc(event.occurredAt).setZone(timezone).toFormat('yyyy-MM-dd');
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }

  return [...counts.entries()].map(([date, leads]) => ({
    date,
    leads,
    label: DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: timezone }).toFormat('LLL d'),
  }));
}

const BUCKETS = [
  { label: '0–10s', maxMs: 10_000 },
  { label: '10–30s', maxMs: 30_000 },
  { label: '30–60s', maxMs: 60_000 },
  { label: '60s+', maxMs: Infinity },
];

export function computeResponseBuckets(events, now, days = 30) {
  const cutoff = now.minus({ days });
  const result = BUCKETS.map((b) => ({ label: b.label, count: 0 }));

  for (const event of events) {
    if (
      event.eventType !== 'sms_sent' ||
      event.isCanary ||
      event.status !== 'success' ||
      event.latencyMs === null ||
      utc(event.occurredAt) < cutoff
    ) {
      continue;
    }
    const index = BUCKETS.findIndex((b) => event.latencyMs < b.maxMs);
    result[index === -1 ? BUCKETS.length - 1 : index].count++;
  }

  return result;
}

/* status is driven by the canary because it is the only check that proves the live
   pipeline works end to end right now. */
export function computeStatus(events) {
  const checks = events
    .filter((e) => e.eventType === 'canary_check')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  if (checks.length === 0) {
    return { status: 'operational', lastCheckedAt: null, detail: null };
  }

  const latest = checks[0];
  const recent = checks.slice(0, 3);

  if (latest.status === 'failure') {
    return {
      status: 'failed',
      lastCheckedAt: latest.occurredAt,
      detail:
        latest.payload?.reason ??
        'the last end-to-end check did not complete. we have been alerted and are on it.',
    };
  }

  if (recent.some((c) => c.status === 'failure')) {
    return {
      status: 'degraded',
      lastCheckedAt: latest.occurredAt,
      detail: 'a recent check failed and the following one passed. we are watching it.',
    };
  }

  return { status: 'operational', lastCheckedAt: latest.occurredAt, detail: null };
}

/* a dashboard holding six hours of history looks broken rather than new. */
export function isEarlyData(tenant, now) {
  return now.diff(utc(tenant.createdAt), 'days').days < 7;
}

/* bounds what the feed renders. metrics are computed over the full window, but the feed
   shows a handful of threads and holding the entire log in feed state is wasted memory. */
export function selectFeedEvents(events, threadLimit) {
  const visible = events
    .filter(isClientVisible)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const keptThreads = new Set();
  const selected = [];

  for (const event of visible) {
    const key = event.correlationId ?? event.id;
    if (!keptThreads.has(key)) {
      if (keptThreads.size >= threadLimit) continue;
      keptThreads.add(key);
    }
    selected.push(event);
  }

  return selected;
}
