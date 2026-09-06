/* derives every displayed number from the raw event log.
   one definition per metric, deliberately, so "leads this month" cannot come to mean two
   different things in two places. the credibility rule governs all of it: only numbers we
   can prove. nothing here models, extrapolates, or attributes revenue. */

import { DateTime } from 'luxon';
// explicit extension: this module is also imported by the node build script, and node esm
// does not resolve extensionless paths the way vite does.
import { CLIENT_VISIBLE_EVENT_TYPES } from './types.js';

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

/* canaries traverse the same live pipeline and emit real-shaped rows, so they must never
   inflate a client-facing count. */
function realLeads(events) {
  return events.filter((e) => e.eventType === 'lead_received' && !e.isCanary);
}

export function computeMetrics(events, timezone, now) {
  const monthStart = now.startOf('month');
  const thirtyDaysAgo = now.minus({ days: 30 });

  const leads = realLeads(events);

  const leadsThisMonth = leads.filter(
    (e) => DateTime.fromISO(e.occurredAt, { zone: 'utc' }).setZone(timezone) >= monthStart,
  ).length;

  const leadsLast30Days = leads.filter(
    (e) => DateTime.fromISO(e.occurredAt, { zone: 'utc' }) >= thirtyDaysAgo,
  ).length;

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
        DateTime.fromISO(e.occurredAt, { zone: 'utc' }) >= thirtyDaysAgo,
    )
    .map((e) => e.latencyMs)
    .sort((a, b) => a - b);

  /* "answered", never "recovered": recovered implies the job came back, which cannot be
     proven without booking data the automation does not have. */
  const successfulSmsThreads = new Set(
    events
      .filter((e) => e.eventType === 'sms_sent' && e.status === 'success' && !e.isCanary)
      .map((e) => e.correlationId)
      .filter(Boolean),
  );
  const missedCallsAnswered = events.filter(
    (e) =>
      e.eventType === 'call_missed' &&
      !e.isCanary &&
      e.correlationId &&
      successfulSmsThreads.has(e.correlationId) &&
      DateTime.fromISO(e.occurredAt, { zone: 'utc' }) >= thirtyDaysAgo,
  ).length;

  const canaryChecks = events.filter(
    (e) =>
      e.eventType === 'canary_check' &&
      DateTime.fromISO(e.occurredAt, { zone: 'utc' }) >= thirtyDaysAgo,
  );
  const uptimePct =
    canaryChecks.length === 0
      ? null
      : (canaryChecks.filter((c) => c.status === 'success').length / canaryChecks.length) * 100;

  return {
    leadsThisMonth,
    leadsLast30Days,
    medianResponseMs: percentile(latencies, 0.5),
    p90ResponseMs: percentile(latencies, 0.9),
    missedCallsAnswered,
    uptimePct,
  };
}

export function computeLeadsPerDay(events, timezone, now, days = 30) {
  const counts = new Map();
  for (let i = days - 1; i >= 0; i--) {
    counts.set(now.minus({ days: i }).setZone(timezone).toFormat('yyyy-MM-dd'), 0);
  }

  for (const event of realLeads(events)) {
    const key = DateTime.fromISO(event.occurredAt, { zone: 'utc' })
      .setZone(timezone)
      .toFormat('yyyy-MM-dd');
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
      DateTime.fromISO(event.occurredAt, { zone: 'utc' }) < cutoff
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
  return now.diff(DateTime.fromISO(tenant.createdAt, { zone: 'utc' }), 'days').days < 7;
}

/* bounds what the feed renders. metrics are computed over the full window, but the feed
   shows a handful of threads and holding the entire log in feed state is wasted memory. */
export function selectFeedEvents(events, threadLimit) {
  const visible = events
    .filter((e) => !e.isCanary && CLIENT_VISIBLE_EVENT_TYPES.includes(e.eventType))
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

export function buildDashboardData(tenant, events, now = DateTime.now(), feedThreadLimit = 10) {
  return {
    tenant,
    status: computeStatus(events),
    metrics: computeMetrics(events, tenant.timezone, now),
    leadsPerDay: computeLeadsPerDay(events, tenant.timezone, now),
    responseBuckets: computeResponseBuckets(events, now),
    feed: selectFeedEvents(events, feedThreadLimit),
    isEarlyData: isEarlyData(tenant, now),
  };
}
