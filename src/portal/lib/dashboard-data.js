/* assembles the one object every portal surface renders from.
 *
 * the demo and the signed-in dashboard both come through here, which is the whole point:
 * the demo has to show the real product rather than a mock of it. the moment it is a mock
 * it stops being evidence and becomes a brochure.
 *
 * everything is computed once, here, rather than per page. a page that recomputed its own
 * version of "leads in the last 30 days" is a page that will eventually disagree with the
 * number printed above it.
 *
 * the lifecycle modules added a second half to this file, and they follow the same rule:
 * one fold, one metrics object per module, assembled here and passed down unchanged. the
 * one thing they add that the original chain did not need is `availability` — computed
 * first, and consulted by everything after it, because a module that is not connected must
 * produce "we cannot say" rather than zero.
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
import { computeModuleAvailability } from './modules.js';
import {
  buildEstimates,
  buildInstalls,
  buildLeadCapture,
  buildMemberships,
  buildReviews,
  computeLifecycle,
} from './lifecycle.js';
import { computeModuleHealth, overallHealth } from './health.js';
import { buildAttentionQueue } from './attention.js';
import { buildActivity } from './activity.js';

/* threads kept in the payload. the leads table pages through these; the overview rail
   shows the first handful. deliberately bounded — the old repo shipped 3.26MB to render a
   dozen visible rows, and the fix was never to render fewer rows, it was to stop shipping
   the entire log to draw them. */
const THREAD_LIMIT = 150;

/* the module record tables are capped for the same reason, one cap per module rather than
   one shared one: an estimate book and an install book are different sizes and a single
   number would be wrong for both. */
const RECORD_LIMIT = 150;

/* the run log and the queue are capped for the same reason as the record tables, and are
   the two that grow fastest: every module writes into both. the activity page reveals 240
   rows and the queue shows eight before it expands, so these are bounded above what either
   surface will draw and well below "ship the log to render a table". */
const ACTIVITY_LIMIT = 200;
const QUEUE_LIMIT = 60;

function capped(module) {
  return {
    ...module,
    records: module.records.slice(0, RECORD_LIMIT),
    recordTotal: module.records.length,
  };
}

export function buildDashboardData(tenant, events = [], now = DateTime.now(), alerts = []) {
  const zone = tenant.timezone;

  /* tenant isolation is enforced by row level security in postgres, which is the only place
     it can actually be enforced — this function runs in a browser and cannot be trusted by
     anything. this filter is the second line: every read path is already rls-scoped, so it
     should never remove a row, and if a future caller ever assembles events from more than
     one source it fails closed rather than quietly blending two clients' numbers into one
     dashboard. rows with no tenant stamped on them (the generated demo before it is given
     one, a unit test) are kept, since there is nothing to disagree with. */
  const scoped = tenant?.id
    ? events.filter((event) => !event.tenantId || event.tenantId === tenant.id)
    : events;
  const foreign = events.length - scoped.length;
  if (foreign > 0) {
    console.warn(
      `dashboard: dropped ${foreign} event(s) belonging to another tenant before deriving anything`,
    );
  }
  events = scoped;

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

  /* first, because everything below it has to know whether it is allowed to print a
     number at all. */
  const availability = computeModuleAvailability(tenant, events, now);

  const leadCapture = buildLeadCapture(events, allThreads, tenant, now);
  const estimates = buildEstimates(events, now);
  const reviews = buildReviews(events, now);
  const memberships = buildMemberships(events, now);
  const installs = buildInstalls(events, now);
  const parts = { leadCapture, estimates, reviews, memberships, installs };

  const health = computeModuleHealth(events, availability, now);

  return {
    tenant,
    generatedFor: now.toISO(),
    coverageDays: earliest
      ? Math.max(0, Math.round(now.diff(DateTime.fromISO(earliest, { zone: 'utc' }), 'days').days))
      : 0,
    /* the freshest thing in the window, so every page can print how current it is rather
       than implying it is live. */
    freshestEventAt: events.reduce(
      (max, event) => (max === null || event.occurredAt > max ? event.occurredAt : max),
      null,
    ),
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
    /* the enriched threads ARE the lead list — there is not a second one.
       `buildLeadCapture` returns the same thread objects with the qualifier's verdict and
       any handoff folded onto them, so shipping both would serialise every lead twice and
       leave two arrays free to disagree about what a lead is. */
    threads: leadCapture.leads.slice(0, THREAD_LIMIT),
    /* the true count behind the capped list, so the leads table can say "150 of 412"
       rather than implying the client only ever had 150 leads. */
    threadTotal: leadCapture.leads.length,
    isEarlyData: isEarlyData(tenant, now),

    /* ── the lifecycle modules ── */
    availability,
    health,
    overallHealth: overallHealth(health),
    lifecycle: computeLifecycle(parts, availability, now),
    attention: buildAttentionQueue(parts, health, events, availability, now, QUEUE_LIMIT),
    activity: buildActivity(events, ACTIVITY_LIMIT),
    /* metrics only. the rows live in `threads` above. */
    leadCapture: { metrics: leadCapture.metrics, recordTotal: leadCapture.leads.length },
    estimates: capped(estimates),
    reviews: capped(reviews),
    memberships: capped(memberships),
    installs: capped(installs),
  };
}
