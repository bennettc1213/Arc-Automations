/* assembles the one object every portal surface renders from.
 *
 * the demo and the signed-in dashboard both come through here, which is the whole point:
 * the demo has to show the real product rather than a mock of it. the moment it is a mock
 * it stops being evidence and becomes a brochure.
 *
 * everything is computed once, here, rather than per page. a page that recomputed its own
 * version of "leads in the last 30 days" is a page that will eventually disagree with the
 * number printed above it.
 */

import { DateTime } from 'luxon';
import {
  computeLeadsPerDay,
  computeMetrics,
  computeResponseBuckets,
  computeStatus,
  isEarlyData,
} from './metrics.js';
import {
  buildIncidents,
  buildThreads,
  computeAutomations,
  computeDeltas,
  computeHourly,
  computeMonthly,
  computeReliability,
  computeRouting,
  computeSources,
} from './derive.js';

/* threads kept in the payload. the leads table pages through these; the overview rail
   shows the first handful. deliberately bounded — the old repo shipped 3.26MB to render a
   dozen visible rows, and the fix was never to render fewer rows, it was to stop shipping
   the entire log to draw them. */
const THREAD_LIMIT = 150;

export function buildDashboardData(tenant, events, now = DateTime.now(), alerts = []) {
  const zone = tenant.timezone;

  /* how much history is actually in hand, measured rather than declared. the signed-in path
     fetches sixty-one days and the demo generates ninety, and a page that printed either
     number as a constant would be wrong on the other one. */
  const earliest = events.reduce(
    (min, event) => (min === null || event.occurredAt < min ? event.occurredAt : min),
    null,
  );

  /* built unbounded first: sources, hour-of-day and routing are counts over the whole
     window, and computing them from a truncated list would quietly under-report every one
     of them. only the payload is capped. */
  const allThreads = buildThreads(events, null);

  return {
    tenant,
    generatedFor: now.toISO(),
    coverageDays: earliest
      ? Math.max(0, Math.round(now.diff(DateTime.fromISO(earliest, { zone: 'utc' }), 'days').days))
      : 0,
    status: computeStatus(events),
    metrics: computeMetrics(events, zone, now),
    deltas: computeDeltas(events, tenant, zone, now),
    leadsPerDay: computeLeadsPerDay(events, zone, now),
    responseBuckets: computeResponseBuckets(events, now),
    sources: computeSources(allThreads, now),
    hourly: computeHourly(allThreads, zone, now),
    routing: computeRouting(allThreads, now),
    automations: computeAutomations(events, now),
    reliability: computeReliability(events, zone, now),
    incidents: buildIncidents(alerts, now),
    monthly: computeMonthly(events, zone, now),
    threads: allThreads.slice(0, THREAD_LIMIT),
    /* the true count behind the capped list, so the leads table can say "150 of 412"
       rather than implying the client only ever had 150 leads. */
    threadTotal: allThreads.length,
    isEarlyData: isEarlyData(tenant, now),
  };
}
