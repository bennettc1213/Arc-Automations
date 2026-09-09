/* deterministic demo data for the public sales demo.
 *
 * determinism matters for a practical reason: the demo is a sales asset, and numbers that
 * change on every regeneration cannot be screenshotted for outreach or referred to on a
 * call. same seed, same ninety days.
 *
 * realism rules honoured here: no round numbers, no placeholder names, weekday-weighted
 * volume, overnight emergency clustering, and two genuine incidents that were caught and
 * resolved. ninety days of unbroken green reads as fabricated — and demonstrates the wrong
 * thing. a failure that was detected, alerted and fixed IS the product working.
 */

import { DateTime } from 'luxon';

export const DEMO_TENANT = {
  id: '8f1c2d34-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Halstead Restoration',
  slug: 'halstead',
  timezone: 'America/New_York',
  status: 'active',
};

export const DEMO_HISTORY_DAYS = 90;

const TECHS = ['dana reyes', 'marcus whitfield', 'trey boland', 'priya raghunathan', 'sam okonkwo'];

const FORM_FIRST_NAMES = [
  'angela', 'rob', 'denise', 'curtis', 'maribel', 'doug', 'yvonne', 'nate',
  'sheila', 'vince', 'latoya', 'greg', 'bettina', 'omar', 'kelli', 'duane',
  'rosalind', 'chad', 'nadia', 'wes',
];

const FORM_LAST_NAMES = [
  'kowalczyk', 'brennan', 'ferraro', 'osei', 'lindqvist', 'delacruz', 'hobbs',
  'nakamura', 'vasquez', 'ealy', 'trombley', 'rasmussen', 'achebe', 'serrano',
];

const LOSS_TYPES = [
  'water — burst supply line',
  'water — basement seepage',
  'water — water heater failure',
  'fire — kitchen, smoke damage',
  'mold — crawlspace',
  'sewage — backup, main line',
  'water — roof leak, ceiling',
  'water — dishwasher overflow',
];

/* mulberry32: small, fast, seedable. */
function makePrng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = makePrng(seed);
  const hex = (n) =>
    Math.floor(next() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    // uuid-shaped and deterministic. not rfc-random, which is the point.
    uuid: () =>
      `${hex(8)}-${hex(4)}-4${hex(3)}-${((8 + Math.floor(next() * 4)) & 0xf).toString(16)}${hex(3)}-${hex(8)}${hex(4)}`,
  };
}

/* both drawn from real failure modes: a lapsed messaging registration, and an upstream
   payload shape change after someone edited the client's website. */
export const DEMO_INCIDENTS = [
  {
    daysAgo: 56,
    startHour: 1,
    durationHours: 3,
    kind: 'sms_delivery',
    checkType: 'canary',
    message: 'canary: sms send failed 3 consecutive checks. twilio a2p campaign registration lapsed.',
    resolutionNote: 'a2p campaign re-registered, delivery confirmed by canary.',
  },
  {
    daysAgo: 23,
    startHour: 9,
    durationHours: 4,
    kind: 'form_schema',
    checkType: 'schema',
    message:
      'schema assert: web form payload missing required field "phone". field renamed to "phone_number" upstream.',
    resolutionNote: 'webhook mapping updated to accept the renamed field.',
  },
];

function incidentStart(incident, now, zone) {
  return now
    .setZone(zone)
    .minus({ days: incident.daysAgo })
    .startOf('day')
    .plus({ hours: incident.startHour });
}

function isIncidentActive(at, incident, now, zone) {
  const start = incidentStart(incident, now, zone);
  return at >= start && at < start.plus({ hours: incident.durationHours });
}

function activeIncident(at, now, zone) {
  return DEMO_INCIDENTS.find((i) => isIncidentActive(at, i, now, zone)) ?? null;
}

/* the demo is a sales asset, and a sales asset that opens with a red minus sign argues
   against itself. a flat generator does not solve that: over thirty days against the
   thirty before it, ordinary variance lands negative about half the time, and it rebuilds
   nightly, so "about half the time" means a prospect eventually opens it on a bad day.
   so the volume carries a deliberate, gentle upward drift across the ninety days.
   this is not a hockey stick and must not become one — a restoration contractor knows
   what their own volume looks like, and a demo showing 4x growth in a quarter reads as
   fabricated faster than a declining one reads as failing. the lift below works out to
   roughly a fifth more volume in the trailing month than the month before it, which is
   what wiring up intake actually does to a shop that was letting calls ring out. */
const TREND_LIFT = 0.26;

/* what share of a day's leads came in as a missed call rather than a form fill.
   this is applied as a share of each day's volume, NOT as a per-lead coin flip, and the
   difference matters more than it looks. at ~250 leads a month a coin flip has a standard
   deviation of about eight calls, which manufactures ten-percent month-over-month swings
   in "missed calls answered" — the headline figure on the overview — that say nothing
   about the business. a shop's channel mix is genuinely stable; the noise was an artefact
   of how it was modelled, not a fact being modelled. */
const MISSED_CALL_SHARE = 0.44;

function trendFactor(dayOffset, historyDays) {
  const recency = 1 - dayOffset / historyDays; // 0 = oldest day, 1 = today
  return 1 - TREND_LIFT / 2 + TREND_LIFT * recency;
}

/* weekdays carry more form traffic; weekends still produce emergencies, which is the
   nature of the category — and for restoration specifically the weekend is not quiet, it
   is when a pipe bursts in an empty building. the weekend floor is 3 rather than 2 for a
   concrete reason: at 2/day, roughly half of which are missed calls, the missed-call
   text-back workflow genuinely goes 26+ hours without firing on a saturday and the
   automations page badges it `quiet`. that badge is correct behaviour reporting a
   generator that was understating weekend emergencies. */
function leadsForDay(day, rng, trend = 1) {
  const isWeekend = day.weekday === 6 || day.weekday === 7;
  const base = isWeekend ? rng.int(4, 8) : rng.int(5, 10);
  // same draw order as before the trend existed, so the stream stays comparable
  const spike = rng.chance(0.06) ? rng.int(4, 9) : 0;
  return Math.max(1, Math.round((base + spike) * trend));
}

/* bimodal: a business-hours bulge for form fills, plus a genuine overnight tail, because a
   burst pipe at 2am is the job that pays and the one their competitor sleeps through. */
function hourForLead(rng) {
  if (rng.chance(0.26)) return rng.int(0, 6);
  if (rng.chance(0.15)) return rng.int(19, 23);
  return rng.int(7, 18);
}

function responseLatencyMs(rng) {
  const roll = rng.next();
  if (roll < 0.72) return rng.int(4200, 14000);
  if (roll < 0.93) return rng.int(14000, 32000);
  return rng.int(32000, 96000); // tail: retry, carrier delay
}

function makeEvent(rng, base) {
  return {
    id: rng.uuid(),
    tenantId: DEMO_TENANT.id,
    eventType: base.eventType,
    workflowId: base.workflowId ?? 'wf_speed_to_lead_v3',
    /* one execution id per workflow run, shared by every row that run wrote. the
       automations page counts runs by distinct execution, so a workflow that writes three
       rows per lead must not be reported as having run three times. */
    executionId: base.executionId ?? `exec_${rng.int(100000, 999999)}`,
    correlationId: base.correlationId ?? null,
    status: base.status ?? 'success',
    payload: base.payload ?? {},
    latencyMs: base.latencyMs ?? null,
    isCanary: base.isCanary ?? false,
    occurredAt: base.occurredAt.toUTC().toISO(),
    eventKey: `demo_${rng.uuid()}`,
  };
}

function generateLeadThread(rng, at, now, zone, fromMissedCall) {
  const events = [];
  const correlationId = rng.uuid();
  const incident = activeIncident(at, now, zone);

  const source = fromMissedCall ? 'missed_call' : rng.chance(0.85) ? 'web_form' : 'gbp_message';

  /* during the form-schema incident, web form submissions never arrive. this is the
     absence failure mode: nothing errors, leads simply stop. */
  if (incident?.kind === 'form_schema' && source === 'web_form') return [];

  const caller = `${rng.pick(FORM_FIRST_NAMES)} ${rng.pick(FORM_LAST_NAMES)}`;
  const phone = `+1614${rng.int(2000000, 9999999)}`;
  const lossType = rng.pick(LOSS_TYPES);

  /* a lead is handled by two or three separate workflows, and each one gets a single
     execution id shared by every row it wrote. this is what the automations page counts:
     "speed to lead ran 214 times" has to mean 214 runs, not 214 database rows. */
  const intakeWorkflow = fromMissedCall ? 'wf_missed_call_textback_v2' : 'wf_speed_to_lead_v3';
  const intakeExec = `exec_${rng.int(100000, 999999)}`;
  const routingExec = `exec_${rng.int(100000, 999999)}`;
  const replyExec = `exec_${rng.int(100000, 999999)}`;

  if (fromMissedCall) {
    events.push(
      makeEvent(rng, {
        eventType: 'call_missed',
        occurredAt: at,
        correlationId,
        workflowId: intakeWorkflow,
        executionId: intakeExec,
        payload: { from: phone, caller, ring_seconds: rng.int(18, 34) },
      }),
    );
  }

  events.push(
    makeEvent(rng, {
      eventType: 'lead_received',
      occurredAt: at.plus({ seconds: fromMissedCall ? 1 : 0 }),
      correlationId,
      workflowId: intakeWorkflow,
      executionId: intakeExec,
      payload: { source, caller, phone, loss_type: lossType },
    }),
  );

  const smsFailed = incident?.kind === 'sms_delivery';
  const latencyMs = responseLatencyMs(rng);
  events.push(
    makeEvent(rng, {
      eventType: 'sms_sent',
      occurredAt: at.plus({ milliseconds: latencyMs }),
      correlationId,
      workflowId: intakeWorkflow,
      executionId: intakeExec,
      status: smsFailed ? 'failure' : 'success',
      latencyMs: smsFailed ? null : latencyMs,
      payload: smsFailed
        ? { to: phone, error: 'twilio: 63038 campaign not registered' }
        : { to: phone, body: 'thanks for reaching halstead restoration — a tech is being notified now.' },
    }),
  );

  if (smsFailed) return events;

  events.push(
    makeEvent(rng, {
      eventType: 'routed',
      occurredAt: at.plus({ milliseconds: latencyMs + rng.int(3000, 22000) }),
      correlationId,
      workflowId: 'wf_oncall_routing_v1',
      executionId: routingExec,
      payload: { tech: rng.pick(TECHS), loss_type: lossType },
    }),
  );

  /* somebody who rang and got a text back is mid-problem and answers; somebody who
     filled in a form for a quote often does not. the split is not decoration — it is what
     keeps reply capture firing every day at weekend volumes instead of going 26 hours
     quiet on a sunday morning. */
  if (rng.chance(fromMissedCall ? 0.58 : 0.34)) {
    events.push(
      makeEvent(rng, {
        eventType: 'reply_received',
        occurredAt: at.plus({ minutes: rng.int(1, 47) }),
        correlationId,
        workflowId: 'wf_reply_capture_v1',
        executionId: replyExec,
        payload: {
          from: phone,
          body: rng.pick(['yes please call me', 'how soon can someone come out?', 'ok', 'calling now']),
        },
      }),
    );
  }

  return events;
}

/* hourly canary: expectation written first, verified independently after. a canary that
   checks its own output proves nothing. */
function generateCanaryPair(rng, at, now, zone) {
  const incident = activeIncident(at, now, zone);
  const correlationId = rng.uuid();
  const passed = !incident;

  return [
    makeEvent(rng, {
      eventType: 'canary_expectation',
      occurredAt: at,
      correlationId,
      isCanary: true,
      workflowId: 'wf_canary_emit',
      payload: { expect_sms: true, expect_routed: true, tag: '__canary' },
    }),
    makeEvent(rng, {
      eventType: 'canary_check',
      occurredAt: at.plus({ seconds: rng.int(20, 55) }),
      correlationId,
      isCanary: true,
      status: passed ? 'success' : 'failure',
      workflowId: 'wf_canary_verify',
      latencyMs: passed ? rng.int(4000, 12000) : null,
      payload: passed
        ? { sms_observed: true, routed_observed: true }
        : {
            sms_observed: incident?.kind !== 'sms_delivery',
            routed_observed: false,
            reason: incident?.message,
          },
    }),
  ];
}

/* `at` is injectable so the generator can be exercised against an arbitrary date. it
   defaults to now, which is what the build script and every real run use. */
export function generateDemoData(seed = 20260828, at = DateTime.now()) {
  const rng = makeRng(seed);
  const zone = DEMO_TENANT.timezone;
  const now = at.setZone(zone);
  const events = [];

  for (let dayOffset = DEMO_HISTORY_DAYS; dayOffset >= 0; dayOffset--) {
    const day = now.minus({ days: dayOffset }).startOf('day');
    const count = leadsForDay(day, rng, trendFactor(dayOffset, DEMO_HISTORY_DAYS));

    const missedCalls = Math.round(count * MISSED_CALL_SHARE);

    for (let i = 0; i < count; i++) {
      const when = day.plus({
        hours: hourForLead(rng),
        minutes: rng.int(0, 59),
        seconds: rng.int(0, 59),
      });
      if (when > now) continue;
      // each lead still draws its own hour, so the split carries no time-of-day pattern
      events.push(...generateLeadThread(rng, when, now, zone, i < missedCalls));
    }
  }

  for (let hourOffset = DEMO_HISTORY_DAYS * 24; hourOffset >= 0; hourOffset--) {
    const when = now.minus({ hours: hourOffset }).startOf('hour').plus({ minutes: 7 });
    if (when > now) continue;
    events.push(...generateCanaryPair(rng, when, now, zone));
  }

  const alerts = DEMO_INCIDENTS.map((incident) => {
    const start = incidentStart(incident, now, zone);
    const detectedAt = start.plus({ minutes: rng.int(4, 18) });
    return {
      id: rng.uuid(),
      tenantId: DEMO_TENANT.id,
      checkType: incident.checkType,
      severity: 'critical',
      message: incident.message,
      firedAt: detectedAt.toUTC().toISO(),
      acknowledgedAt: detectedAt.plus({ minutes: rng.int(2, 11) }).toUTC().toISO(),
      resolvedAt: start
        .plus({ hours: incident.durationHours })
        .plus({ minutes: rng.int(1, 14) })
        .toUTC()
        .toISO(),
    };
  });

  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return {
    tenant: { ...DEMO_TENANT, createdAt: now.minus({ days: 91 }).toUTC().toISO() },
    events,
    alerts,
  };
}
