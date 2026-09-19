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
  /* the demo runs every module, because the demo is the sales asset for all of them. a real
     tenant's list is set by an operator and is usually shorter. */
  modules: ['lead_capture', 'estimates', 'reviews', 'memberships', 'installs'],
  /* stamped on the generated tenant and checked by pages/Demo.jsx. the demo data is only
     ever imported by that one route, so this is belt and braces rather than the mechanism —
     but "generated data reached a real client's dashboard" is the one bug in this repo that
     would be worth more than everything else it prevents. */
  isDemo: true,
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
    recordedAt: base.occurredAt.toUTC().toISO(),
    eventKey: `demo_${rng.uuid()}`,
    /* the lifecycle columns (migration 0009). the modules fold their records by entity id,
       so an estimate's five events share one. */
    entityType: base.entityType ?? null,
    entityId: base.entityId ?? null,
    sourceSystem: base.sourceSystem ?? null,
    externalId: base.externalId ?? null,
    actor: base.actor ?? 'automation',
    errorClass: base.errorClass ?? null,
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

/* ══ the lifecycle modules ════════════════════════════════
 *
 * everything below generates the same shape of evidence the live pipeline does, for a
 * restoration contractor that also sells maintenance agreements and replaces the equipment
 * a loss destroyed. the numbers are chosen to be a plausible ninety days for a shop of this
 * size, not to be flattering: about a third of estimates never get a decision, a couple of
 * members cancel, and one review request was withheld for a reason it should not have been.
 *
 * that last one is deliberate and is the most important row in the demo. it is a
 * misconfiguration the portal caught, named and put in the queue — which is the product
 * working, in exactly the way the two baked-in incidents above are.
 */

const WORK_TYPES = [
  'water mitigation & structural drying',
  'contents pack-out and storage',
  'drywall and paint rebuild',
  'flooring replacement — LVP',
  'mold remediation — crawlspace',
  'smoke and odour treatment',
  'roof tarp and deck repair',
  'sewage cleanup and sanitising',
  'cabinet and countertop rebuild',
];

const OBJECTIONS = [
  'insurance is only covering part of this, can you look at the scope again',
  'that is a lot more than the other quote we got',
  'we need to wait until the adjuster has been out',
];

const QUESTIONS = [
  'how soon could you start if we said yes today',
  'does that price include the contents storage',
  'is the drying equipment rental in that number or separate',
];

const INTERESTED = [
  'yes lets go ahead, what do you need from us',
  'we want to move forward. can someone call me this week',
  'ok. send the paperwork over',
];

const PLANS = [
  'priority response — residential',
  'priority response — commercial',
  'annual drainage & sump maintenance',
];

const EQUIPMENT = [
  { manufacturer: 'Rheem', category: 'water heater — 50gal gas', prefix: 'RH' },
  { manufacturer: 'Bradford White', category: 'water heater — 40gal electric', prefix: 'BW' },
  { manufacturer: 'Zoeller', category: 'sump pump — 1/2hp', prefix: 'ZL' },
  { manufacturer: 'Liberty Pumps', category: 'sewage ejector', prefix: 'LB' },
  { manufacturer: 'Santa Fe', category: 'crawlspace dehumidifier', prefix: 'SF' },
  { manufacturer: 'Aprilaire', category: 'whole-home air scrubber', prefix: 'AP' },
];

const REVIEW_TEXTS = [
  { rating: 5, text: 'Called at 11pm with water coming through the ceiling. Someone answered, and a crew was here before 1am. Cannot fault them.' },
  { rating: 5, text: 'Dana and her team were careful with our things and explained every step. The house was dry in four days.' },
  { rating: 5, text: 'Fast, tidy, and they dealt with the insurance paperwork directly which saved us a week.' },
  { rating: 4, text: 'Good work overall. Took a couple of calls to pin down the final invoice but the drying was done properly.' },
  { rating: 5, text: 'Second time we have used them. Same crew, same standard.' },
  { rating: 4, text: 'Did what they said they would. Would have liked a bit more warning about the equipment noise.' },
  { rating: 2, text: 'The work was fine but nobody told us they were coming back on the Saturday and we had to rearrange our day.' },
  { rating: 1, text: 'Three days without an update and the dehumidifiers were left running in an empty room. Had to chase twice.' },
];

function customerName(rng) {
  return `${rng.pick(FORM_FIRST_NAMES)} ${rng.pick(FORM_LAST_NAMES)}`;
}

function businessHour(rng, day) {
  return day.startOf('day').plus({ hours: rng.int(8, 17), minutes: rng.int(0, 59), seconds: rng.int(0, 59) });
}

/* ── estimate recovery ───────────────────────────────────── */

function generateEstimates(rng, now, historyDays) {
  const events = [];
  const COUNT = 64;

  for (let i = 0; i < COUNT; i++) {
    const daysAgo = rng.int(2, historyDays - 3);
    const createdAt = businessHour(rng, now.minus({ days: daysAgo }));
    if (createdAt > now) continue;

    const id = rng.uuid();
    const customer = customerName(rng);
    const phone = `+1614${rng.int(2000000, 9999999)}`;
    const workType = rng.pick(WORK_TYPES);
    /* restoration quotes are bimodal: a mitigation-only job is a few thousand, a mitigation
       plus rebuild is five figures. a single uniform range would produce a book of
       identical-looking mid-size quotes, which is not what an estimate list looks like. */
    const amountCents = rng.chance(0.62)
      ? rng.int(180_000, 890_000)
      : rng.int(900_000, 3_400_000);

    const common = {
      entityType: 'estimate',
      entityId: id,
      sourceSystem: 'jobber',
      externalId: `EST-${rng.int(10000, 99999)}`,
      workflowId: 'wf_estimate_recovery_v2',
    };

    /* eight of the book is held back, each for a reason the portal recognises. two of those
       are a person on the client's team pausing or closing one by hand. */
    const suppressRoll = rng.next();
    let suppressed = null;
    if (suppressRoll < 0.05) suppressed = 'already_approved';
    else if (suppressRoll < 0.08) suppressed = 'duplicate';
    else if (suppressRoll < 0.10) suppressed = 'no_consent';
    else if (suppressRoll < 0.12) suppressed = 'paused_by_staff';
    else if (suppressRoll < 0.13) suppressed = 'closed_by_staff';

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'estimate_created',
        occurredAt: createdAt,
        payload: {
          entity_id: id,
          customer,
          phone,
          work_type: workType,
          amount_cents: amountCents,
          estimate_date: createdAt.toISODate(),
          crm_status: suppressed === 'already_approved' ? 'approved' : rng.pick(['sent', 'viewed', 'pending']),
          assigned_to: rng.pick(TECHS),
          consent: suppressed === 'no_consent' ? { sms: false, email: false } : { sms: true, email: true },
          ...(suppressed === 'duplicate' ? { duplicate_of: `EST-${rng.int(10000, 99999)}` } : {}),
        },
      }),
    );

    if (suppressed === 'paused_by_staff' || suppressed === 'closed_by_staff') {
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'estimate_suppressed',
          occurredAt: createdAt.plus({ days: rng.int(1, 4) }),
          actor: 'human',
          payload: { entity_id: id, reason: suppressed, by: rng.pick(TECHS) },
        }),
      );
      continue;
    }
    if (suppressed) continue;

    /* about one in seven closes on its own within a couple of days — the customer had
       already decided. these never receive a follow-up, so they are approved and NOT
       attributable, which is the distinction the money column on that page turns on. a
       demo in which every approval is attributed to us would be making exactly the claim
       the attribution chain exists to stop us making. */
    if (rng.chance(0.14)) {
      const fastAt = createdAt.plus({ days: rng.int(1, 2), hours: rng.int(2, 9) });
      if (fastAt <= now) {
        events.push(
          makeEvent(rng, {
            ...common,
            eventType: 'estimate_decision',
            occurredAt: fastAt,
            payload: { entity_id: id, decision: 'approved', amount_cents: amountCents },
          }),
        );
        continue;
      }
    }

    /* the sequence: three touches at widening intervals, and it stops the moment the
       customer answers. the stop is enforced here the same way the live workflow enforces
       it, so the portal's stop-rule check has something real to verify. */
    const stages = [
      { stage: 'first nudge', afterDays: 3 },
      { stage: 'second nudge', afterDays: 8 },
      { stage: 'final', afterDays: 16 },
    ];

    const replyRoll = rng.next();
    const willReply = replyRoll < 0.38;
    const replyAfterDays = willReply ? rng.int(3, 17) : null;
    const replyAt = willReply ? createdAt.plus({ days: replyAfterDays, hours: rng.int(1, 9) }) : null;

    let sentAny = null;
    for (const { stage, afterDays } of stages) {
      const sendAt = createdAt.plus({ days: afterDays, hours: rng.int(0, 6) });
      if (sendAt > now) break;
      if (replyAt && sendAt > replyAt) break;

      /* about one send in thirty is rejected by the carrier. a follow-up failure rate of
         exactly zero over sixty estimates is not what a real messaging integration looks
         like, and the page has a metric for it. */
      const failed = rng.chance(0.03);
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'estimate_followup_sent',
          occurredAt: sendAt,
          status: failed ? 'failure' : 'success',
          errorClass: failed ? 'delivery' : null,
          payload: {
            entity_id: id,
            stage,
            channel: 'sms',
            ...(failed ? { error: 'twilio: 30007 message filtered by carrier' } : {}),
          },
        }),
      );
      if (!failed && !sentAny) sentAny = sendAt;
    }

    let classification = null;
    if (replyAt && replyAt <= now) {
      const roll = rng.next();
      classification =
        roll < 0.40 ? 'interested'
        : roll < 0.63 ? 'question'
        : roll < 0.78 ? 'objection'
        : roll < 0.88 ? 'declined'
        : roll < 0.96 ? 'deferred'
        : 'opt_out';

      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'estimate_reply_received',
          occurredAt: replyAt,
          payload: {
            entity_id: id,
            classification,
            body:
              classification === 'interested' ? rng.pick(INTERESTED)
              : classification === 'question' ? rng.pick(QUESTIONS)
              : classification === 'objection' ? rng.pick(OBJECTIONS)
              : classification === 'declined' ? 'we went with someone else, thanks'
              : classification === 'deferred' ? 'holding off until the spring, can you check back'
              : 'stop',
          },
        }),
      );
    }

    /* a decision lands for the ones that were going to close. an approval that follows a
       follow-up we actually sent is what the attribution chain needs all four links of. */
    const decides =
      classification === 'interested' ? rng.chance(0.78)
      : classification === 'question' ? rng.chance(0.52)
      : classification === 'objection' ? rng.chance(0.34)
      : classification === 'declined' ? true
      : classification === 'deferred' ? false
      : classification === 'opt_out' ? false
      : rng.chance(0.18);

    if (!decides) continue;

    const decidedAt = (replyAt ?? sentAny ?? createdAt).plus({ days: rng.int(1, 6), hours: rng.int(1, 8) });
    if (decidedAt > now) continue;

    const decision =
      classification === 'declined' ? 'declined'
      : classification === 'objection' ? (rng.chance(0.55) ? 'approved' : 'declined')
      : rng.chance(0.88) ? 'approved' : 'deferred';

    /* the approved figure comes from the crm rather than from the quote, so a renegotiated
       job counts at what it actually sold for. */
    const finalCents =
      decision === 'approved'
        ? Math.round(amountCents * (rng.chance(0.74) ? 1 : rng.int(82, 97) / 100))
        : amountCents;

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'estimate_decision',
        occurredAt: decidedAt,
        payload: {
          entity_id: id,
          decision,
          amount_cents: finalCents,
          /* about a third of approvals arrive with no margin figure attached. this is the
             normal state of a crm integration and it is why the gross-profit card prints
             its coverage instead of a bare total. */
          ...(decision === 'approved' && rng.chance(0.68)
            ? { gross_margin_pct: rng.int(34, 52) }
            : {}),
        },
      }),
    );
  }

  return events;
}

/* ── reviews & service recovery ──────────────────────────── */

function generateReviews(rng, now, historyDays) {
  const events = [];
  const COUNT = 58;
  /* exactly one request in the book was withheld because somebody expected a bad rating.
     it is the misconfiguration the compliance check exists to catch. */
  const gatedIndex = rng.int(6, COUNT - 6);

  for (let i = 0; i < COUNT; i++) {
    const daysAgo = rng.int(1, historyDays - 2);
    const completedAt = businessHour(rng, now.minus({ days: daysAgo }));
    if (completedAt > now) continue;

    const id = rng.uuid();
    const customer = customerName(rng);
    const workType = rng.pick(WORK_TYPES);
    const tech = rng.pick(TECHS);
    const common = {
      entityType: 'job',
      entityId: id,
      sourceSystem: 'jobber',
      externalId: `JOB-${rng.int(10000, 99999)}`,
      workflowId: 'wf_review_request_v1',
    };

    const gated = i === gatedIndex;
    const skipRoll = rng.next();
    const skipped = gated
      ? 'low_rating'
      : skipRoll < 0.04 ? 'opted_out'
      : skipRoll < 0.07 ? 'wrong_contact'
      : skipRoll < 0.09 ? 'no_consent'
      : null;

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'job_completed',
        occurredAt: completedAt,
        payload: {
          entity_id: id,
          customer,
          phone: `+1614${rng.int(2000000, 9999999)}`,
          email: `${customer.split(' ')[0]}.${customer.split(' ')[1]}@example.com`,
          work_type: workType,
          tech,
          completed_at: completedAt.toISO(),
          ...(skipped ? { review_request_skipped: skipped } : {}),
        },
      }),
    );

    if (skipped) continue;

    const requestAt = completedAt.plus({ hours: rng.int(3, 26) });
    if (requestAt > now) continue;

    const delivered = !rng.chance(0.04);
    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'review_request_sent',
        occurredAt: requestAt,
        status: delivered ? 'success' : 'failure',
        errorClass: delivered ? null : 'delivery',
        payload: { entity_id: id, channel: 'sms' },
      }),
    );
    if (!delivered) continue;

    if (!rng.chance(0.42)) continue;

    const sample = rng.pick(REVIEW_TEXTS);
    const reviewAt = requestAt.plus({ days: rng.int(0, 5), hours: rng.int(1, 20) });
    if (reviewAt > now) continue;

    const sensitive = sample.rating <= 3;
    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'review_received',
        occurredAt: reviewAt,
        workflowId: 'wf_review_watch_v1',
        payload: {
          entity_id: id,
          rating: sample.rating,
          platform: rng.chance(0.82) ? 'google' : 'facebook',
          text: sample.text,
          draft_response: sensitive
            ? `${customer.split(' ')[0]}, you are right and I am sorry — a job is not finished until you know what is happening on it. I have the schedule and the equipment log for your address in front of me and I would like to walk through it with you and put the Saturday right. — Marcus, Halstead Restoration`
            : `Thank you — I will pass this on to ${tech.split(' ')[0]} and the crew. The ${workType.split(' —')[0]} on a job like yours is the part that decides whether the repair holds, so it means a lot that it showed.`,
        },
      }),
    );

    if (sensitive) {
      const openedAt = reviewAt.plus({ minutes: rng.int(6, 90) });
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'service_recovery_opened',
          occurredAt: openedAt,
          workflowId: 'wf_service_recovery_v1',
          payload: {
            entity_id: id,
            reason: sample.rating === 1 ? 'no updates for three days, equipment left running' : 'unannounced return visit',
            priority: 'high',
            assigned_to: 'marcus whitfield',
          },
        }),
      );

      /* the recent ones are still open, so the page shows both halves of the loop rather
         than only the happy end of it. anything older than three weeks is closed: a
         recovery case left open for two months is not a live task, it is a record nobody
         maintained, and it would sit at the top of the queue forever. */
      const stale = openedAt < now.minus({ days: 21 });
      if ((stale || rng.chance(0.45)) && openedAt.plus({ days: 2 }) < now) {
        events.push(
          makeEvent(rng, {
            ...common,
            eventType: 'service_recovery_resolved',
            occurredAt: openedAt.plus({ days: rng.int(1, 3), hours: rng.int(1, 8) }),
            actor: 'human',
            workflowId: 'wf_service_recovery_v1',
            payload: {
              entity_id: id,
              resolution: 'owner called, returned to collect equipment same day, invoice adjusted',
            },
          }),
        );
      }
    } else if (rng.chance(0.55)) {
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'review_response_published',
          occurredAt: reviewAt.plus({ hours: rng.int(2, 40) }),
          actor: 'human',
          workflowId: 'wf_review_watch_v1',
          payload: { entity_id: id, by: rng.pick(TECHS) },
        }),
      );
    }
  }

  return events;
}

/* ── memberships ─────────────────────────────────────────── */

function generateMemberships(rng, now, historyDays) {
  const events = [];
  const COUNT = 118;

  for (let i = 0; i < COUNT; i++) {
    const id = rng.uuid();
    const customer = customerName(rng);
    const plan = rng.pick(PLANS);
    const common = {
      entityType: 'membership',
      entityId: id,
      sourceSystem: 'housecall_pro',
      externalId: `MEM-${rng.int(1000, 9999)}`,
      workflowId: 'wf_membership_watch_v1',
    };

    /* the sync row is written when a membership is first seen or changes, spread across the
       window rather than all stamped today — a hundred and eighteen identical rows on one
       day would bury a week of business events in the activity feed. */
    const seenAt = businessHour(rng, now.minus({ days: rng.int(1, historyDays) }));
    const renewalDate = now.plus({ days: rng.int(-4, 330) }).toISODate();

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'membership_recorded',
        occurredAt: seenAt,
        payload: {
          entity_id: id,
          customer,
          phone: `+1614${rng.int(2000000, 9999999)}`,
          plan,
          price_cents: plan.includes('commercial') ? rng.int(48000, 96000) : rng.int(14900, 28900),
          renewal_date: renewalDate,
          status: 'active',
          assigned_to: rng.pick(TECHS),
        },
      }),
    );

    /* a failed card on about one in twenty. the provider recovers most of them on its own
       retries — those are counted and left alone. the two it gives up on are the rows this
       module exists to surface. */
    if (rng.chance(0.055)) {
      const failedAt = businessHour(rng, now.minus({ days: rng.int(1, 40) }));
      const exhausted = rng.chance(0.38);
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'membership_payment_failed',
          occurredAt: failedAt,
          status: 'failure',
          errorClass: 'upstream',
          payload: {
            entity_id: id,
            attempt: exhausted ? 4 : rng.int(1, 2),
            amount_cents: plan.includes('commercial') ? 62000 : 18900,
            provider_retry_state: exhausted ? 'exhausted' : 'scheduled',
          },
        }),
      );

      if (!exhausted && rng.chance(0.82)) {
        events.push(
          makeEvent(rng, {
            ...common,
            eventType: 'membership_payment_recovered',
            occurredAt: failedAt.plus({ days: rng.int(1, 5) }),
            payload: {
              entity_id: id,
              recovered_by: 'provider',
              amount_cents: plan.includes('commercial') ? 62000 : 18900,
            },
          }),
        );
      }
    }

    /* an included visit comes due twice a year. most get booked; a handful do not, and
       those are the ones nobody would otherwise notice until the member did. */
    if (rng.chance(0.22)) {
      const dueAt = now.minus({ days: rng.int(-45, 30) });
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'membership_visit_due',
          occurredAt: businessHour(rng, now.minus({ days: rng.int(1, 30) })),
          payload: {
            entity_id: id,
            due_date: dueAt.toISODate(),
            visit_type: plan.includes('drainage') ? 'sump and drain check' : 'annual system inspection',
          },
        }),
      );

      if (rng.chance(0.72)) {
        events.push(
          makeEvent(rng, {
            ...common,
            eventType: 'membership_visit_booked',
            occurredAt: businessHour(rng, now.minus({ days: rng.int(0, 14) })),
            payload: { entity_id: id, appointment_at: now.plus({ days: rng.int(2, 24) }).toISO() },
          }),
        );
      }
    }

    if (rng.chance(0.017)) {
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'membership_cancellation_requested',
          occurredAt: businessHour(rng, now.minus({ days: rng.int(1, 18) })),
          payload: {
            entity_id: id,
            reason: rng.pick(['moving out of the area', 'cutting costs this year', 'no longer own the property']),
          },
        }),
      );
    }
  }

  return events;
}

/* ── install & warranty ──────────────────────────────────── */

function generateInstalls(rng, now, historyDays) {
  const events = [];
  const COUNT = 26;

  for (let i = 0; i < COUNT; i++) {
    const daysAgo = rng.int(1, historyDays - 2);
    const installedAt = businessHour(rng, now.minus({ days: daysAgo }));
    if (installedAt > now) continue;

    const id = rng.uuid();
    const kit = rng.pick(EQUIPMENT);
    const customer = customerName(rng);
    const common = {
      entityType: 'install',
      entityId: id,
      sourceSystem: 'jobber',
      externalId: `INS-${rng.int(10000, 99999)}`,
      workflowId: 'wf_install_closeout_v1',
    };

    /* manufacturers give between sixty and ninety days from the install date. the deadline
       is what makes this module urgent rather than administrative. */
    const deadline = installedAt.plus({ days: rng.pick([60, 90]) });
    const tech = rng.pick(TECHS);

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'install_completed',
        occurredAt: installedAt,
        payload: {
          entity_id: id,
          customer,
          phone: `+1614${rng.int(2000000, 9999999)}`,
          job: `${kit.category} replacement`,
          installed_at: installedAt.toISO(),
          address: `${rng.int(100, 9800)} ${rng.pick(['Kenmore', 'Arlington', 'Weber', 'Sinclair', 'Fairwood', 'Broadleigh'])} ${rng.pick(['Rd', 'Ave', 'Ln'])}, Columbus OH`,
          jurisdiction: 'Franklin County, OH',
          tech,
        },
      }),
    );

    /* the serial is the thing that gets missed, because it is a photograph of a plate in a
       crawlspace taken at the end of a long day. about one in six never arrives. */
    const hasSerial = !rng.chance(0.17);
    const closeoutAt = installedAt.plus({ hours: rng.int(1, 30) });

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'install_closeout_updated',
        occurredAt: closeoutAt,
        payload: {
          entity_id: id,
          manufacturer: kit.manufacturer,
          category: kit.category,
          model_number: `${kit.prefix}-${rng.int(1000, 9999)}${rng.pick(['A', 'B', 'X'])}`,
          ...(hasSerial
            ? { serial_number: `${kit.prefix}${rng.int(10000000, 99999999)}` }
            : {}),
          photos: Array.from({ length: rng.int(2, 5) }, (_, n) => `photo_${n + 1}`),
          registration_required: true,
          registration_deadline: deadline.toISODate(),
          responsible: tech,
        },
      }),
    );

    if (!hasSerial) continue;

    /* a jurisdiction we cannot file into, or a portal that rejected the submission. it stays
       visible with its reason rather than quietly ageing out. */
    if (rng.chance(0.09)) {
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'warranty_registration_blocked',
          occurredAt: closeoutAt.plus({ days: rng.int(1, 4) }),
          status: 'failure',
          errorClass: 'upstream',
          payload: {
            entity_id: id,
            reason: rng.pick([
              'manufacturer portal rejected the serial — plate photo is unreadable, needs recapturing on site',
              'this model registers through the distributor, not the manufacturer — waiting on their account',
            ]),
          },
        }),
      );
      continue;
    }

    const submitAt = closeoutAt.plus({ days: rng.int(1, 9) });
    if (submitAt > now) continue;

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'warranty_registration_submitted',
        occurredAt: submitAt,
        payload: { entity_id: id },
      }),
    );

    const verifyAt = submitAt.plus({ days: rng.int(1, 6) });
    if (verifyAt > now) continue;
    if (rng.chance(0.12)) continue; // still waiting on the manufacturer

    /* one registration comes back claiming success with no confirmation number attached.
       the portal holds it at "submitted" rather than believing it, which is the single
       behaviour this module exists to guarantee. */
    const withEvidence = !rng.chance(0.06);
    const packetSent = !rng.chance(0.18);

    events.push(
      makeEvent(rng, {
        ...common,
        eventType: 'warranty_registration_verified',
        occurredAt: verifyAt,
        payload: {
          entity_id: id,
          ...(withEvidence
            ? {
                confirmation_number: `${kit.prefix}-WR-${rng.int(100000, 999999)}`,
                certificate_url: `warranty/${id.slice(0, 8)}.pdf`,
              }
            : {}),
        },
      }),
    );

    if (withEvidence) {
      events.push(
        makeEvent(rng, {
          ...common,
          eventType: 'install_closeout_updated',
          occurredAt: verifyAt.plus({ hours: rng.int(1, 20) }),
          payload: {
            entity_id: id,
            ...(packetSent ? { packet_sent: true } : {}),
            ...(rng.chance(0.74)
              ? { maintenance_scheduled_at: verifyAt.plus({ months: 12 }).toISODate() }
              : { maintenance_not_required: true }),
          },
        }),
      );
    }
  }

  return events;
}

/* ── qualification & human handoff ───────────────────────── */

/* run as a second pass over the already-generated lead threads rather than inside
 * `generateLeadThread`, for one reason: the seed is a fixed sales asset. drawing inside the
 * thread generator would shift every subsequent draw and change lead counts, response times
 * and incident timing on pages that existed before this module did. a second pass reads the
 * threads back and adds to them without touching the stream that produced them.
 *
 * the qualifier went live partway through the window, which is both true of how these get
 * rolled out and the case the portal has to handle: the older leads have no verdict, and
 * "not qualified" and "never asked" must not be the same number.
 */
const QUALIFIER_LIVE_DAYS_AGO = 52;

function generateQualification(rng, events, now) {
  const added = [];
  const leads = events.filter((e) => e.eventType === 'lead_received' && !e.isCanary);
  const routedByThread = new Map();
  for (const event of events) {
    if (event.eventType === 'routed' && event.correlationId) {
      routedByThread.set(event.correlationId, event);
    }
  }

  const liveFrom = now.minus({ days: QUALIFIER_LIVE_DAYS_AGO });

  for (const lead of leads) {
    const at = DateTime.fromISO(lead.occurredAt, { zone: 'utc' });
    const routed = routedByThread.get(lead.correlationId);

    /* the tech acknowledges on their phone within a few minutes, almost always. the ones
       that go unacknowledged are the point of the metric, so there are a few. */
    if (routed && !rng.chance(0.07)) {
      routed.payload = {
        ...routed.payload,
        acknowledged_at: DateTime.fromISO(routed.occurredAt, { zone: 'utc' })
          .plus({ seconds: rng.int(40, 900) })
          .toISO(),
      };
    }

    if (at < liveFrom) continue;

    const lossType = lead.payload?.loss_type ?? '';
    /* the safety flag is read off the loss the caller described, the way the qualifier
       reads it off what they typed or said. */
    const flags = [];
    if (lossType.startsWith('fire')) flags.push('fire', 'smoke');
    if (lossType.startsWith('sewage')) flags.push('flood_safety');
    if (rng.chance(0.03)) flags.push('distressed');
    if (rng.chance(0.015)) flags.push('electrical');

    const emergency = flags.length > 0 || rng.chance(0.21);
    const inArea = !rng.chance(0.06);
    const capacity = !rng.chance(0.05);
    const outcome = !inArea ? 'out_of_area' : !capacity ? 'no_capacity' : 'qualified';

    added.push(
      makeEvent(rng, {
        eventType: 'lead_qualified',
        occurredAt: at.plus({ seconds: rng.int(3, 40) }),
        correlationId: lead.correlationId,
        entityType: 'lead',
        entityId: lead.correlationId,
        workflowId: 'wf_lead_qualifier_v1',
        payload: {
          outcome,
          job_type: lossType || 'general enquiry',
          zip: `432${rng.int(10, 35)}`,
          in_service_area: inArea,
          property_type: rng.pick(['single family', 'multi-family', 'commercial', 'rental']),
          customer_status: rng.chance(0.19) ? 'existing customer' : 'new customer',
          urgency: emergency ? 'emergency' : rng.pick(['same day', 'this week', 'scheduling']),
          scope: rng.pick([
            'one room, visible standing water',
            'basement, approx 600 sq ft',
            'kitchen and adjoining hallway',
            'whole lower floor',
            'crawlspace only',
          ]),
          capacity_ok: capacity,
          preferred_time: rng.pick(['as soon as possible', 'this afternoon', 'tomorrow morning', 'weekday mornings']),
          consent: { sms: true, email: rng.chance(0.74) },
          source_attribution: lead.payload?.source ?? null,
          ...(flags.length ? { safety_flags: flags } : {}),
        },
      }),
    );

    /* every lead carrying a safety flag or an emergency urgency gets a person put in front
       of it. the condition here must match `requiresHuman` in lib/lifecycle.js exactly —
       an earlier version only handed off the ones that also qualified, which manufactured
       a breach for every out-of-area emergency and put a promise the product actually
       keeps on the demo as broken. */
    if (flags.length > 0 || emergency) {
      added.push(
        makeEvent(rng, {
          eventType: 'handoff_requested',
          occurredAt: at.plus({ seconds: rng.int(41, 95) }),
          correlationId: lead.correlationId,
          entityType: 'lead',
          entityId: lead.correlationId,
          workflowId: 'wf_lead_qualifier_v1',
          payload: {
            reason: flags.length
              ? `${flags[0].replace(/_/g, ' ')} — automation stopped, on-call notified directly`
              : 'emergency urgency — on-call notified directly',
            assigned_to: rng.pick(TECHS),
            /* the older ones have been dealt with; the last day or two are still open, which
               is what puts them in the queue. */
            ...(at < now.minus({ hours: 30 })
              ? { resolved_at: at.plus({ minutes: rng.int(4, 50) }).toISO() }
              : {}),
          },
        }),
      );
    }
  }

  return added;
}

/* ── the execution layer ─────────────────────────────────── */

/* what ARC Lead Recovery writes that an observing adapter never could: the provider's
 * delivery receipt, the booking, the opt-out and the end of the run.
 *
 * a fourth pass over the already-generated threads, for the same reason `generateQualification`
 * is a second one — the seed is a fixed sales asset, and drawing inside the thread generator
 * would shift every later draw and move lead counts, response times and incident timing on
 * pages that existed before this module did. this runs last of all, so it cannot move
 * anything.
 *
 * the split between sent, delivered and failed is the point of the whole pass: a demo in
 * which every text arrives would demonstrate the wrong thing, because the gap between "we
 * handed it to the carrier" and "it arrived" is precisely what this module exists to make
 * visible. so a small share of threads carry a carrier rejection with a real Twilio code on
 * them, and one thread's sequence ends on an error rather than on an outcome.
 */
function generateExecutionLayer(rng, events, now) {
  const added = [];

  /* the successful sends, oldest first, so the outcomes read as a book rather than a
     scatter. */
  const sends = events
    .filter((e) => e.eventType === 'sms_sent' && !e.isCanary && e.status === 'success' && e.correlationId)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const repliedThreads = new Set(
    events.filter((e) => e.eventType === 'reply_received' && !e.isCanary).map((e) => e.correlationId),
  );
  const handedOff = new Set(
    events.filter((e) => e.eventType === 'handoff_requested' && !e.isCanary).map((e) => e.correlationId),
  );

  for (const send of sends) {
    const at = DateTime.fromISO(send.occurredAt, { zone: 'utc' });
    const id = send.correlationId;
    const base = {
      correlationId: id,
      entityType: 'lead',
      entityId: id,
      sourceSystem: 'twilio',
      workflowId: 'arc_lead_recovery',
    };

    /* the carrier's answer, seconds later. a 4% rejection rate is the real-world shape for
       a registered campaign texting consumer handsets — landlines, disconnected numbers and
       the occasional block. */
    const rejected = rng.chance(0.04);
    if (rejected) {
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'message_failed',
          occurredAt: at.plus({ seconds: rng.int(4, 40) }),
          status: 'failure',
          errorClass: 'delivery',
          payload: {
            provider_message_id: `SM${rng.uuid().replace(/-/g, '')}`,
            provider_code: rng.pick(['30003', '30006', '21614']),
          },
        }),
      );
      /* a text nobody received is a lead nobody is talking to, so the engine hands it to a
         person and the run ends on the failure rather than on an outcome. */
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'automation_failed',
          occurredAt: at.plus({ seconds: rng.int(41, 70) }),
          status: 'failure',
          errorClass: 'delivery',
          payload: { stop_reason: 'failed', detail: 'the text could not be delivered', final_state: 'failed' },
        }),
      );
      continue;
    }

    added.push(
      makeEvent(rng, {
        ...base,
        eventType: 'message_delivered',
        occurredAt: at.plus({ seconds: rng.int(2, 22) }),
        payload: { provider_message_id: `SM${rng.uuid().replace(/-/g, '')}` },
      }),
    );

    /* a small number of people say stop, and the sequence honours it. that this appears in
       the demo at all is deliberate: an opt-out rate of zero would read as a product that
       does not implement one. */
    if (rng.chance(0.022)) {
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'lead_suppressed',
          occurredAt: at.plus({ minutes: rng.int(2, 180) }),
          actor: 'human',
          payload: { reason: 'opt_out', channel: 'sms', cancelled_actions: rng.int(1, 2) },
        }),
      );
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'automation_completed',
          occurredAt: at.plus({ minutes: rng.int(181, 200) }),
          payload: { stop_reason: 'opted_out', detail: 'customer replied opt_out', final_state: 'suppressed' },
        }),
      );
      continue;
    }

    /* booked, and only for a lead that actually answered. the number is recorded because
       somebody in the office recorded it — never inferred from the tone of a reply. */
    const replied = repliedThreads.has(id);
    if (replied && rng.chance(0.46)) {
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'lead_booked',
          occurredAt: at.plus({ hours: rng.int(1, 30) }),
          actor: 'human',
          payload: {
            outcome: 'booked',
            value_cents: rng.int(28000, 940000),
            recorded_by: rng.pick(TECHS),
          },
        }),
      );
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'automation_completed',
          occurredAt: at.plus({ hours: rng.int(31, 36) }),
          payload: { stop_reason: 'booked', detail: 'the lead turned into work', final_state: 'booked' },
        }),
      );
      continue;
    }

    /* everything else closes itself after the quiet period — except the ones a person is
       still holding, which must stay open or the queue would empty itself. */
    if (!handedOff.has(id) && at < now.minus({ hours: 80 })) {
      added.push(
        makeEvent(rng, {
          ...base,
          eventType: 'automation_completed',
          occurredAt: at.plus({ hours: 72, minutes: rng.int(1, 50) }),
          payload: {
            stop_reason: 'closed',
            detail: 'closed after the quiet period with no further contact',
            final_state: 'closed',
          },
        }),
      );
    }
  }

  return added;
}

/* ── per-module verification ─────────────────────────────── */

/* the hourly canary traverses the lead pipeline and is generated above. the other four
   modules get their own daily evidence, because a module with no check against it reads
   `not verified` in the portal — correctly — and a demo in which four of five modules are
   unverified would be demonstrating the wrong thing about a product that is sold on
   verification. */
function generateModuleChecks(rng, now, zone, historyDays) {
  const events = [];
  const checks = [
    { module: 'estimates', eventType: 'canary_check', workflowId: 'wf_canary_estimates', hour: 6 },
    { module: 'reviews', eventType: 'canary_check', workflowId: 'wf_canary_reviews', hour: 6 },
    { module: 'memberships', eventType: 'watermark_check', workflowId: 'wf_watermark_memberships', hour: 5 },
    { module: 'installs', eventType: 'schema_assert', workflowId: 'wf_schema_installs', hour: 5 },
  ];

  for (let dayOffset = historyDays; dayOffset >= 0; dayOffset--) {
    const day = now.minus({ days: dayOffset }).startOf('day');
    for (const check of checks) {
      const when = day.plus({ hours: check.hour, minutes: rng.int(0, 40) });
      if (when > now) continue;
      const incident = activeIncident(when, now, zone);
      /* the form-schema incident broke the shape of an incoming payload, so the schema
         assert is the check that catches it — the same way it would in production. */
      const failed = incident?.kind === 'form_schema' && check.eventType === 'schema_assert';

      events.push(
        makeEvent(rng, {
          eventType: check.eventType,
          occurredAt: when,
          isCanary: check.eventType === 'canary_check',
          status: failed ? 'failure' : 'success',
          workflowId: check.workflowId,
          actor: 'system',
          latencyMs: failed ? null : rng.int(900, 6400),
          payload: {
            module: check.module,
            ...(failed ? { reason: incident.message } : { observed: true }),
          },
        }),
      );
    }
  }

  return events;
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

  /* the lifecycle modules are generated after the lead pipeline and the hourly canary, so
     every draw those two make comes off the stream in the same order it always has. the
     seed is a fixed sales asset: adding modules must not change a single figure on the
     pages that existed before them. */
  events.push(...generateQualification(rng, events, now));
  events.push(...generateEstimates(rng, now, DEMO_HISTORY_DAYS));
  events.push(...generateReviews(rng, now, DEMO_HISTORY_DAYS));
  events.push(...generateMemberships(rng, now, DEMO_HISTORY_DAYS));
  events.push(...generateInstalls(rng, now, DEMO_HISTORY_DAYS));
  events.push(...generateModuleChecks(rng, now, zone, DEMO_HISTORY_DAYS));
  /* last of all. it reads the finished threads back and adds the execution layer's own
     evidence to them, so not one draw above it moves. */
  events.push(...generateExecutionLayer(rng, events, now));

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
