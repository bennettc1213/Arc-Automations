/* a client report, for any window, derived by the same code as the dashboard.
 *
 * the dashboard answers "how is it going right now" over a fixed thirty days. a
 * report answers "how did it go" over whatever span somebody is about to put in
 * front of a client: the last fifteen days, august, the quarter since go-live. so
 * this module takes a period instead of a `now`, and then does nothing new —
 * every figure is statsForRange, buildThreads and the derive.js readouts, run over
 * that period. a report that computed "median reply" its own way would print a
 * different number from the portal the client signs in to, and the first person to
 * notice would be the client.
 *
 * the same credibility rule governs every sentence it writes: only numbers we can
 * prove. no revenue, no conversion, "answered" never "recovered", median never
 * mean, and no comparison against an earlier window the data does not fully cover.
 *
 * pure and node-safe (explicit extensions, no supabase), so it can be exercised
 * against generated data outside the browser. fetching lives in report-data.js;
 * drawing lives in report-pdf.js.
 */

import { DateTime } from 'luxon';
import { computeResponseBuckets, realLeads, statsForRange, utc } from './metrics.js';
import {
  buildIncidents,
  buildThreads,
  comparison,
  computeAutomations,
  computeHourly,
  computeRouting,
  computeSources,
  windowCovered,
} from './derive.js';
import { billingState, billingTotals, formatMoney, integrationFor } from './integrations.js';
import {
  UPTIME_MEANING,
  formatCount,
  formatDuration,
  formatPct,
  formatSpan,
  formatUptime,
} from './format.js';

/* ── periods ─────────────────────────────────────────────── */

export const REPORT_PERIODS = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '15d', label: '15 days', days: 15 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '60d', label: '60 days', days: 60 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'mtd', label: 'this month' },
  { key: 'last-month', label: 'last month' },
  { key: 'custom', label: 'custom' },
];

/* past a year the fetch is large enough to want a sql rollup, and a report that
   long is an annual review, which is a conversation rather than a download. */
export const MAX_REPORT_DAYS = 366;

/* a longer span than this draws its volume chart by week. ninety-odd bars is the
   most that stay legible across a letter page. */
const DAILY_BAR_LIMIT = 92;

const lower = (text) => text.toLowerCase();

function rangeLabel(from, to, zone) {
  const first = from.setZone(zone);
  const last = to.minus({ milliseconds: 1 }).setZone(zone);
  if (first.hasSame(last, 'day')) return lower(first.toFormat('LLL d, yyyy'));
  if (first.hasSame(last, 'year')) {
    return lower(`${first.toFormat('LLL d')} – ${last.toFormat('LLL d, yyyy')}`);
  }
  return lower(`${first.toFormat('LLL d, yyyy')} – ${last.toFormat('LLL d, yyyy')}`);
}

/**
 * turns what was picked in the dialog into the four instants a report is built on:
 * the period, and the equal span before it that a comparison is measured against.
 *
 * rolling presets end a second past `now`, exactly as computeMetrics does, so "last
 * 30 days" here is the same half-open window as the "leads · 30d" column on the
 * roster, and the two print the same number. `from` is inclusive, `to` exclusive.
 *
 * a comparison window is always the same length as the period. a custom range that
 * runs into today is shortened to now, and its comparison is shortened with it —
 * nine days of september against thirty of august is a collapse every month, and it
 * is not a fact about the business.
 */
export function resolvePeriod(selection, timezone, now = DateTime.now()) {
  const zone = timezone;
  const local = now.setZone(zone);
  const end = now.plus({ seconds: 1 });
  const preset = REPORT_PERIODS.find((entry) => entry.key === selection?.key) ?? REPORT_PERIODS[2];

  const finish = (period) => {
    const span = period.to.diff(period.from, 'days').days;
    return {
      key: preset.key,
      ...period,
      zone,
      days: Math.max(1, Math.round(span)),
      exactDays: span,
      range: rangeLabel(period.from, period.to, zone),
      /* reads a day past the end, when the end is in the past: a call missed at 23:58
         on the last day and answered at 00:01 was answered, and a fetch that stopped
         at midnight would say it was not. */
      fetchSince: period.previousFrom,
      fetchUntil: DateTime.min(period.to.plus({ days: 1 }), end),
      error: null,
    };
  };

  if (preset.days) {
    const from = now.minus({ days: preset.days });
    return finish({
      title: `last ${preset.days} days`,
      from,
      to: end,
      previousFrom: now.minus({ days: preset.days * 2 }),
      previousTo: from,
      rolling: true,
      compareLabel: `vs the ${preset.days} days before`,
    });
  }

  if (preset.key === 'mtd') {
    const from = local.startOf('month');
    const previousFrom = from.minus({ months: 1 });
    return finish({
      title: lower(`${from.toFormat('LLLL yyyy')} to date`),
      from,
      to: end,
      previousFrom,
      /* the same elapsed span of the month before, clamped for the 31st that has no
         counterpart in a shorter month. the dashboard's month-to-date delta is built
         the same way. */
      previousTo: DateTime.min(previousFrom.plus(now.diff(from)), from),
      rolling: true,
      compareLabel: 'vs the same point last month',
    });
  }

  if (preset.key === 'last-month') {
    const to = local.startOf('month');
    const from = to.minus({ months: 1 });
    const previousFrom = from.minus({ months: 1 });
    return finish({
      title: lower(from.toFormat('LLLL yyyy')),
      from,
      to,
      previousFrom,
      previousTo: from,
      rolling: false,
      compareLabel: lower(`vs ${previousFrom.toFormat('LLLL')}`),
    });
  }

  const first = DateTime.fromISO(selection?.from ?? '', { zone });
  const last = DateTime.fromISO(selection?.to ?? '', { zone });
  const fail = (error) => ({ key: 'custom', error });

  if (!first.isValid || !last.isValid) return fail('pick a start date and an end date');

  const from = first.startOf('day');
  const through = last.startOf('day').plus({ days: 1 });

  if (through <= from) return fail('the end date is before the start date');
  if (from >= now) return fail('the start date has not happened yet');

  const calendarDays = Math.round(through.diff(from, 'days').days);
  if (calendarDays > MAX_REPORT_DAYS) return fail(`a report covers at most ${MAX_REPORT_DAYS} days`);

  const capped = through > end;
  const to = capped ? end : through;
  const previousFrom = capped ? from.minus(to.diff(from)) : from.minus({ days: calendarDays });

  return finish({
    title: calendarDays === 1 ? 'one day' : `${calendarDays} days`,
    from,
    to,
    previousFrom,
    previousTo: from,
    rolling: capped,
    compareLabel: capped ? 'vs the same span before' : `vs the ${calendarDays} days before`,
  });
}

/* ── what goes in it ─────────────────────────────────────── */

/* the cover, the headline figures and the summary are always in a report — a pdf
   without them is an appendix. everything else can be left out. */
export const REPORT_SECTIONS = [
  { key: 'volume', label: 'lead volume', hint: 'leads per day across the period' },
  { key: 'speed', label: 'response speed', hint: 'how fast the first text went out' },
  { key: 'sources', label: 'where leads came from', hint: 'form, missed call, google' },
  { key: 'timing', label: 'when leads arrived', hint: 'hour of day, and after hours' },
  { key: 'routing', label: 'who the work went to', hint: 'leads routed per tech' },
  { key: 'automations', label: 'automations', hint: 'runs, failures, last run' },
  { key: 'reliability', label: 'reliability & incidents', hint: 'the end-to-end check, day by day' },
  { key: 'services', label: 'services & subscriptions', hint: 'what they run on, and if it is paid' },
  { key: 'leads', label: 'lead log', hint: 'every lead, with names and numbers', off: true },
  { key: 'method', label: 'how to read this report', hint: 'what each figure means, and does not' },
];

export const REPORT_AUDIENCES = [
  {
    key: 'client',
    label: 'for the client',
    hint: 'arc-paid costs read "covered", and nothing internal is printed',
  },
  {
    key: 'internal',
    label: 'internal',
    hint: 'every cost, account and quiet connection, for arc only',
  },
];

export function defaultSections() {
  return REPORT_SECTIONS.filter((section) => !section.off).map((section) => section.key);
}

/* ── derivations ─────────────────────────────────────────── */

/* one bar per day, or per week past DAILY_BAR_LIMIT days. the first and last bars
   are flagged partial when the period starts or ends mid-day, so a short bar at the
   edge of the chart is labelled as a short day rather than read as a slow one. */
function volumeSeries(events, zone, from, to) {
  const firstDay = from.setZone(zone).startOf('day');
  const lastDay = to.minus({ milliseconds: 1 }).setZone(zone).startOf('day');

  const days = [];
  const byKey = new Map();
  for (let day = firstDay; day <= lastDay; day = day.plus({ days: 1 })) {
    const row = { key: day.toISODate(), start: day, leads: 0, checks: 0, failures: 0 };
    days.push(row);
    byKey.set(row.key, row);
  }

  const inRange = (event) => {
    const at = utc(event.occurredAt);
    return at >= from && at < to;
  };

  for (const lead of realLeads(events)) {
    if (!inRange(lead)) continue;
    const row = byKey.get(utc(lead.occurredAt).setZone(zone).toISODate());
    if (row) row.leads += 1;
  }

  for (const event of events) {
    if (event.eventType !== 'canary_check' || !inRange(event)) continue;
    const row = byKey.get(utc(event.occurredAt).setZone(zone).toISODate());
    if (!row) continue;
    row.checks += 1;
    if (event.status === 'failure') row.failures += 1;
  }

  const partialStart = from > firstDay;
  const partialEnd = to < lastDay.plus({ days: 1 });

  const daily = days.map((row, index) => ({
    key: row.key,
    label: lower(row.start.toFormat('LLL d')),
    leads: row.leads,
    checks: row.checks,
    failures: row.failures,
    partial: (index === 0 && partialStart) || (index === days.length - 1 && partialEnd),
  }));

  if (daily.length <= DAILY_BAR_LIMIT) return { bucket: 'day', rows: daily, daily };

  const weeks = [];
  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7);
    weeks.push({
      key: chunk[0].key,
      label: chunk[0].label,
      leads: chunk.reduce((sum, row) => sum + row.leads, 0),
      checks: chunk.reduce((sum, row) => sum + row.checks, 0),
      failures: chunk.reduce((sum, row) => sum + row.failures, 0),
      partial: chunk.length < 7 || chunk.some((row) => row.partial),
    });
  }
  return { bucket: 'week', rows: weeks, daily };
}

const CYCLE_SUFFIX = { monthly: '/mo', annual: '/yr', usage: ' est/mo' };

function costLabel(connection) {
  if (connection.costCents == null) return '—';
  return `${formatMoney(connection.costCents)}${CYCLE_SUFFIX[connection.billingCycle] ?? ''}`;
}

/**
 * what the client's automation runs on, and whether each account is paid for.
 *
 * `connection.liveness` is optional and supplied by the caller: it comes from the
 * roster's workflow rollup, which is about now rather than the period, and this
 * module does not reach into ops.js to recompute it.
 *
 * for the client, an account arc pays for reads "covered by arc" with no amount and
 * no billing state — arc's cost is not their business, and a past-due card on an
 * account arc owns is arc's problem to fix rather than theirs to worry about.
 */
function servicesFor(connections, audience, zone, now) {
  const client = audience === 'client';

  const visible = connections.filter((connection) => !client || connection.status !== 'retired');

  const rows = visible
    .map((connection) => {
      const integration = integrationFor(connection);
      const covered = client && connection.paidBy === 'arc';
      const state = billingState(connection, zone, now);
      const billing = { ...state, label: lower(state.label) };
      return {
        id: connection.id,
        service: integration?.name ?? connection.label,
        label: connection.label,
        category: integration?.category ?? connection.kind,
        declared: connection.status,
        liveness: client ? null : (connection.liveness ?? null),
        account: client ? null : (connection.accountRef ?? null),
        billing: covered ? { tone: 'ok', label: 'covered by arc', rank: 3 } : billing,
        paidBy: connection.paidBy ?? null,
        cost: covered ? 'included' : costLabel(connection),
        renews:
          covered || !connection.renewsAt
            ? null
            : lower(DateTime.fromISO(connection.renewsAt, { zone }).toFormat('LLL d, yyyy')),
        tracked: (connection.billingStatus ?? 'none') !== 'none',
      };
    })
    .sort((a, b) => (a.billing.rank ?? 9) - (b.billing.rank ?? 9));

  const totals = billingTotals(visible);

  return {
    rows,
    tracked: totals.tracked,
    /* the client is shown what they pay. arc sees the whole bill and who carries it. */
    monthlyCents: client ? totals.client : totals.monthly,
    arcCents: client ? null : totals.arc,
    clientCents: totals.client,
    estimated: totals.hasUsage,
  };
}

const TONE_ORDER = { alert: 0, watch: 1 };

/**
 * the summary, written as sentences.
 *
 * each one is a figure from the report restated in words, never a figure of its
 * own. the tone is what the pdf draws next to it: alert is something to act on,
 * watch is something to look at, good is a result worth saying out loud, info is
 * context. alerts and watches float to the top; the rest keep reading order.
 */
function findingsFor(report, context) {
  const { totals, deltas, period, hourly, failures, incidents, automations, services, audience } =
    report;
  const internal = audience === 'internal';
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  const plural = (n, word, many = `${word}s`) => `${formatCount(n)} ${n === 1 ? word : many}`;

  /* volume */
  if (totals.leads === 0) {
    if (context.eventsInPeriod === 0 && internal) {
      add(
        'watch',
        'nothing was recorded for this client in this period — not a lead, not a check. worth confirming the pipeline is still sending.',
      );
    } else {
      add('info', 'no leads came through in this period.');
    }
  } else {
    const delta = deltas.leads;
    const change =
      delta.pct === null
        ? ''
        : delta.pct === 0
          ? `, level with ${period.compareLabel.replace(/^vs /, '')}`
          : `, ${delta.pct > 0 ? 'up' : 'down'} ${formatPct(Math.abs(delta.pct))} ${period.compareLabel}`;
    add('info', `${plural(totals.leads, 'lead')} came in${change}.`);
  }

  /* speed */
  if (totals.sends > 0) {
    const underMinute = report.responseBuckets
      .filter((bucket) => bucket.label !== '60s+')
      .reduce((sum, bucket) => sum + bucket.count, 0);
    const minuteShare = (underMinute / totals.sends) * 100;
    add(
      totals.medianResponseMs <= 60_000 ? 'good' : 'watch',
      `half of all first replies went out within ${formatDuration(totals.medianResponseMs)}, and 9 in 10 within ${formatDuration(totals.p90ResponseMs)} — ${formatPct(minuteShare, 0)} inside a minute.`,
    );
  }

  if (totals.missedCallsAnswered > 0) {
    add('good', `${plural(totals.missedCallsAnswered, 'missed call')} got a text back.`);
  }

  if (hourly.total > 0 && hourly.afterHours > 0) {
    add(
      'info',
      `${plural(hourly.afterHours, 'lead')} (${formatPct(hourly.afterHoursPct, 0)}) arrived after hours, between 18:00 and 07:00.`,
    );
  }

  if (totals.leadThreads > 0 && totals.replied > 0) {
    add(
      'info',
      `customers wrote back in ${formatCount(totals.replied)} of ${plural(totals.leadThreads, 'lead')}.`,
    );
  }

  /* failures */
  if (failures.count > 0) {
    const top = failures.reasons[0];
    add(
      'watch',
      `${plural(failures.count, 'text')} failed to send${top ? ` — most often “${top.reason}”` : ''}.`,
    );
  } else if (totals.sends > 0) {
    add('good', 'no text failed to send.');
  }

  /* reliability */
  if (totals.checks > 0) {
    const passed = totals.checks - totals.checksFailed;
    add(
      totals.checksFailed === 0 ? 'good' : 'info',
      `the end-to-end check ran ${formatCount(totals.checks)} times and passed ${formatCount(passed)} — ${formatUptime(totals.uptimePct)}.`,
    );
  } else {
    add(
      internal ? 'watch' : 'info',
      'no end-to-end checks were recorded in this period, so no pass rate is stated.',
    );
  }

  if (incidents.length > 0) {
    const open = incidents.filter((incident) => incident.open).length;
    const longest = Math.max(...incidents.map((incident) => incident.durationMs));
    const state =
      open > 0 ? `, ${formatCount(open)} still open` : incidents.length === 1 ? ', resolved' : ', all resolved';
    add(
      open > 0 ? 'alert' : 'info',
      `${plural(incidents.length, 'incident')}${state}; the longest lasted ${formatSpan(longest)}.`,
    );
  }

  /* automations */
  for (const automation of automations) {
    if (automation.kind !== 'client') continue;
    if (automation.failures > 0) {
      add(
        'watch',
        `${automation.name}: ${formatCount(automation.failures)} of ${plural(automation.runs, 'run')} failed.`,
      );
    }
    /* "quiet" is only a fact about a period that ends now. a report on july saying
       an automation had not run since july 29th says nothing about today. */
    if (internal && period.rolling && automation.lastRunAt) {
      const hours = context.now.diff(utc(automation.lastRunAt), 'hours').hours;
      if (hours > 48) {
        add(
          'watch',
          `${automation.name} last ran ${lower(utc(automation.lastRunAt).setZone(report.tenant.timezone).toFormat('LLL d'))} — ${Math.round(hours / 24)} days ago.`,
        );
      }
    }
  }

  /* services */
  let flagged = 0;
  for (const row of services.rows) {
    if (row.billing.tone === 'fail') {
      flagged += 1;
      add('alert', `${row.service}: ${row.billing.label}.`);
    } else if (row.billing.tone === 'warn') {
      flagged += 1;
      add('watch', `${row.service}: ${row.billing.label}.`);
    }
    if (row.liveness && row.declared === 'connected' && row.liveness.state === 'stale') {
      add('watch', `${row.label} is marked connected but has gone ${row.liveness.label}.`);
    }
  }

  const paying = services.rows.filter((row) => row.tracked && row.cost !== 'included');
  if (services.tracked > 0 && flagged === 0 && paying.length > 0) {
    add(
      'good',
      `every tracked subscription is paid up — ${plural(paying.length, 'service')}, ${formatMoney(services.monthlyCents)}/mo${services.estimated ? ' est' : ''}${internal ? '' : ' paid by you'}.`,
    );
  } else if (internal && services.tracked === 0 && services.rows.length > 0) {
    add(
      'info',
      'no subscription is tracked for this client yet — record costs and renewal dates on their page.',
    );
  }

  if (internal && !report.tenant.loginEmail) {
    add('watch', 'no sign-in address is on file, so this client cannot open their portal.');
  }

  return out
    .map((finding, index) => ({ ...finding, index }))
    .sort((a, b) => (TONE_ORDER[a.tone] ?? 2) - (TONE_ORDER[b.tone] ?? 2) || a.index - b.index)
    .map(({ tone, text }) => ({ tone, text }));
}

/* one line for the cover, built only out of figures that exist. */
function headlineFor(totals) {
  if (totals.leads === 0 && totals.medianResponseMs === null && totals.uptimePct === null) {
    return 'no leads came in during this period.';
  }
  const parts = [];
  parts.push(totals.leads === 0 ? 'no leads' : `${formatCount(totals.leads)} ${totals.leads === 1 ? 'lead' : 'leads'}`);
  if (totals.medianResponseMs !== null) {
    parts.push(`first replies in a median ${formatDuration(totals.medianResponseMs)}`);
  }
  if (totals.uptimePct !== null) parts.push(`${formatUptime(totals.uptimePct)} of checks passed`);
  return `${parts.join(', ')}.`;
}

export const REPORT_METHOD = [
  'every figure here is counted from the event log — a lead arriving, a text going out, a check passing. nothing is estimated, modelled or rounded up.',
  '“median reply” is the middle text: half went out faster, half slower. the middle, not the average, because one slow carrier delay drags an average somewhere no customer actually waited.',
  `the end-to-end check is a synthetic lead sent through the live pipeline, which has to come out the far end. its pass rate means ${UPTIME_MEANING}. test leads never count toward any other number.`,
  'a comparison with an earlier period is only printed when the data covers all of that period. a percentage against a half-empty window is worse than none.',
  'there is no revenue or booked-job figure in this report. the pipeline sees that a lead arrived and was answered, not whether the job was won.',
  'subscription details are recorded by arc, not read from each provider. a renewal date that has passed means the charge should be confirmed, not that the service lapsed.',
];

/**
 * the whole report, as data.
 *
 * `events` must cover period.fetchSince → period.fetchUntil (report-data.js reads
 * exactly that); anything outside it is ignored by the ranged derivations, and only
 * widens what the coverage check can see.
 */
export function buildReport({
  tenant,
  events,
  alerts = [],
  connections = [],
  period,
  audience = 'client',
  now = DateTime.now(),
}) {
  const zone = tenant.timezone;
  const { from, to } = period;

  const inPeriod = (iso) => {
    const at = utc(iso);
    return at >= from && at < to;
  };
  const periodEvents = events.filter((event) => inPeriod(event.occurredAt));

  const current = statsForRange(events, zone, from, to);
  const previous = statsForRange(events, zone, period.previousFrom, period.previousTo);
  const comparable = windowCovered(events, tenant, period.previousFrom);
  const compare = comparison(current, previous, comparable);

  /* threads are built over everything fetched, so a reply that landed after the
     period closed still belongs to the lead that started inside it. */
  const threads = buildThreads(events, null).filter((thread) => inPeriod(thread.startedAt));
  const leadThreads = threads.filter((thread) =>
    thread.steps.some((step) => step.type === 'lead_received'),
  );

  /* the derive.js readouts take "the last n days before now". handed threads that
     are already inside the period and a cutoff safely before its start, they count
     exactly the period and nothing else. */
  const reach = period.days + 2;
  const sources = computeSources(threads, to, reach);
  const hourly = computeHourly(threads, zone, to, reach);
  const routing = computeRouting(threads, to, reach);
  const responseBuckets = computeResponseBuckets(periodEvents, to, reach);
  const automations = computeAutomations(periodEvents, to, reach).filter(
    (automation) => audience === 'internal' || automation.kind === 'client',
  );

  const failedThreads = threads.filter((thread) => thread.failed);
  const reasons = new Map();
  for (const thread of failedThreads) {
    const reason = thread.failureReason ?? 'no reason recorded';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  /* an incident belongs to the period if any part of it happened inside it, so one
     that opened the night before the first and closed the next morning is on it. */
  const incidents = buildIncidents(
    alerts.filter(
      (alert) => utc(alert.firedAt) < to && (!alert.resolvedAt || utc(alert.resolvedAt) >= from),
    ),
    now,
  );

  const totals = {
    ...current,
    leadThreads: leadThreads.length,
    replied: leadThreads.filter((thread) => thread.replied).length,
    routed: threads.filter((thread) => thread.tech).length,
  };

  const report = {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      company: tenant.company ?? null,
      clientId: tenant.clientId ?? null,
      slug: tenant.slug ?? null,
      timezone: zone,
      contactName: tenant.contactName ?? null,
      loginEmail: tenant.loginEmail ?? null,
    },
    audience,
    period: {
      key: period.key,
      title: period.title,
      range: period.range,
      days: period.days,
      rolling: period.rolling,
      compareLabel: period.compareLabel,
      fromIso: from.toISO(),
      toIso: to.toISO(),
    },
    generatedAt: now.toISO(),
    generatedLabel: lower(now.setZone(zone).toFormat('LLL d, yyyy · HH:mm')),
    totals,
    comparable,
    deltas: {
      leads: compare('leads'),
      sends: compare('sends'),
      medianResponseMs: compare('medianResponseMs', true),
      missedCallsAnswered: compare('missedCallsAnswered'),
      uptimePct: compare('uptimePct'),
    },
    volume: volumeSeries(events, zone, from, to),
    responseBuckets,
    sources,
    hourly,
    routing,
    automations,
    incidents,
    failures: {
      count: failedThreads.length,
      reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    services: servicesFor(connections, audience, zone, now),
    /* oldest first: a log is read in the order it happened. */
    leadLog: leadThreads
      .slice()
      .reverse()
      .map((thread) => ({
        id: thread.id,
        at: lower(utc(thread.startedAt).setZone(zone).toFormat('LLL d · HH:mm')),
        name: thread.name,
        phone: thread.phone,
        source: thread.sourceLabel,
        lossType: thread.lossType,
        latencyMs: thread.latencyMs,
        tech: thread.tech,
        state: thread.state,
      })),
    eventsRead: events.length,
    method: REPORT_METHOD,
  };

  report.headline = headlineFor(totals);
  report.findings = findingsFor(report, { now, eventsInPeriod: periodEvents.length });

  return report;
}

export function reportFilename(report) {
  const stem = (report.tenant.slug || report.tenant.name || 'client')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const day = (iso, shift = 0) =>
    DateTime.fromISO(iso).setZone(report.tenant.timezone).minus({ milliseconds: shift }).toISODate();
  return `arc-report-${stem}-${day(report.period.fromIso)}-to-${day(report.period.toIso, 1)}${
    report.audience === 'internal' ? '-internal' : ''
  }.pdf`;
}
