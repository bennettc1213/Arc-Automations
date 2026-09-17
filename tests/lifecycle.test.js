/* the rules the product promises, tested as rules.
 *
 * these are not unit tests of arithmetic. every one of them corresponds to a sentence the
 * portal prints for a client — "the sequence stops when a customer replies", "a registration
 * is only confirmed with evidence behind it" — and the point is that the sentence cannot
 * quietly stop being true while the page carries on printing it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEstimates,
  buildInstalls,
  buildLeadCapture,
  buildMemberships,
  buildReviews,
  hasRegistrationEvidence,
} from '../src/portal/lib/lifecycle.js';
import { buildThreads } from '../src/portal/lib/derive.js';
import { NOW, TENANT, ago, ev, estimate, install, job, lead, membership } from './helpers.js';

const estimatesOf = (events) => buildEstimates(events, NOW);
const reviewsOf = (events) => buildReviews(events, NOW);
const installsOf = (events) => buildInstalls(events, NOW);
const membershipsOf = (events) => buildMemberships(events, NOW);
const leadsOf = (events) => buildLeadCapture(events, buildThreads(events, null), TENANT, NOW);

describe('estimate recovery — attribution', () => {
  test('an approval that followed a follow-up we sent is counted as recovered', () => {
    const { records, metrics } = estimatesOf(
      estimate({
        followupDaysAgo: [17],
        reply: 'interested',
        replyDaysAgo: 15,
        decision: 'approved',
        decisionDaysAgo: 14,
        decisionAmountCents: 480_000,
      }),
    );

    assert.equal(records[0].attributed, true);
    assert.equal(records[0].recoveredRevenueCents, 480_000);
    assert.equal(metrics.recoveredRevenueCents, 480_000);
    assert.equal(metrics.recoveredCount, 1);
  });

  test('an approval with no follow-up behind it is approved but NOT recovered', () => {
    const { records, metrics } = estimatesOf(
      estimate({ decision: 'approved', decisionDaysAgo: 14 }),
    );

    assert.equal(records[0].decision.decision, 'approved');
    assert.equal(records[0].attributed, false);
    assert.equal(records[0].recoveredRevenueCents, null);
    assert.equal(metrics.approved, 1);
    assert.equal(metrics.recoveredCount, 0);
    assert.equal(metrics.recoveredRevenueCents, null, 'no attributable revenue means no total');
    assert.match(records[0].attribution, /not attributable/);
  });

  test('an approval that landed BEFORE the follow-up went out is not recovered', () => {
    const { records } = estimatesOf(
      estimate({ createdDaysAgo: 30, decision: 'approved', decisionDaysAgo: 25, followupDaysAgo: [20] }),
    );
    assert.equal(records[0].attributed, false);
  });

  test('a follow-up that failed to send does not count as contact for attribution', () => {
    const events = estimate({ decision: 'approved', decisionDaysAgo: 5 });
    events.push(
      ev({
        entityType: 'estimate',
        entityId: 'est-1',
        eventType: 'estimate_followup_sent',
        occurredAt: ago(10),
        status: 'failure',
        payload: { stage: 'first', channel: 'sms' },
      }),
    );
    const { records } = estimatesOf(events);
    assert.equal(records[0].sentCount, 0);
    assert.equal(records[0].attributed, false);
  });

  test('gross profit is only totalled over approvals that carried a margin', () => {
    const { metrics } = estimatesOf([
      ...estimate({
        id: 'a',
        followupDaysAgo: [17],
        decision: 'approved',
        decisionDaysAgo: 14,
        decisionAmountCents: 100_000,
        grossMarginPct: 40,
      }),
      ...estimate({
        id: 'b',
        followupDaysAgo: [17],
        decision: 'approved',
        decisionDaysAgo: 14,
        decisionAmountCents: 200_000,
      }),
    ]);

    assert.equal(metrics.recoveredCount, 2);
    assert.equal(metrics.recoveredRevenueCents, 300_000);
    assert.equal(metrics.recoveredGrossProfitCents, 40_000, 'only the job with a margin');
    assert.deepEqual(metrics.grossProfitCoverage, { withMargin: 1, total: 2 });
  });

  test('no margin anywhere means no gross profit figure at all, not zero', () => {
    const { metrics } = estimatesOf(
      estimate({ followupDaysAgo: [17], decision: 'approved', decisionDaysAgo: 14 }),
    );
    assert.equal(metrics.recoveredGrossProfitCents, null);
  });
});

describe('estimate recovery — stop on reply', () => {
  test('a follow-up sent after the customer replied is counted as a breach', () => {
    const { records, metrics } = estimatesOf(
      estimate({ createdDaysAgo: 30, followupDaysAgo: [27, 20], reply: 'question', replyDaysAgo: 25 }),
    );
    assert.equal(records[0].stopViolations, 1);
    assert.equal(metrics.stopViolations, 1);
  });

  test('follow-ups that all preceded the reply are not a breach', () => {
    const { metrics } = estimatesOf(
      estimate({ createdDaysAgo: 30, followupDaysAgo: [27, 26], reply: 'question', replyDaysAgo: 25 }),
    );
    assert.equal(metrics.stopViolations, 0);
  });

  test('interested, question and objection replies escalate to a person', () => {
    for (const classification of ['interested', 'question', 'objection']) {
      const { records } = estimatesOf(
        estimate({ followupDaysAgo: [17], reply: classification, replyDaysAgo: 15 }),
      );
      assert.equal(records[0].needsHuman, classification, `${classification} must escalate`);
    }
  });

  test('a decision closes the escalation', () => {
    const { records } = estimatesOf(
      estimate({
        followupDaysAgo: [17],
        reply: 'interested',
        replyDaysAgo: 15,
        decision: 'approved',
        decisionDaysAgo: 14,
      }),
    );
    assert.equal(records[0].needsHuman, null);
  });

  test('an opt-out reply suppresses the estimate', () => {
    const { records, metrics } = estimatesOf(
      estimate({ followupDaysAgo: [17], reply: 'opt_out', replyDaysAgo: 15 }),
    );
    assert.equal(records[0].suppression.reason, 'opted_out');
    assert.equal(records[0].eligible, false);
    assert.equal(metrics.optOutPct, 100);
  });
});

describe('estimate recovery — eligibility', () => {
  test('an estimate already approved in the crm never enters the sequence', () => {
    const { records } = estimatesOf(estimate({ crmStatus: 'approved' }));
    assert.equal(records[0].suppression.reason, 'already_approved');
    assert.equal(records[0].eligible, false);
  });

  test('a disputed job is excluded', () => {
    const { records } = estimatesOf(estimate({ crmStatus: 'disputed' }));
    assert.equal(records[0].suppression.reason, 'disputed');
  });

  test('a duplicate is excluded', () => {
    const { records } = estimatesOf(estimate({ payload: { duplicate_of: 'EST-9' } }));
    assert.equal(records[0].suppression.reason, 'duplicate');
  });

  test('no consent on any channel excludes it', () => {
    const { records } = estimatesOf(
      estimate({ payload: { consent: { sms: false, email: false } } }),
    );
    assert.equal(records[0].suppression.reason, 'no_consent');
  });

  test('a person on the client team can pause or close one by hand', () => {
    for (const reason of ['paused_by_staff', 'closed_by_staff']) {
      const { records } = estimatesOf(estimate({ suppressReason: reason }));
      assert.equal(records[0].suppression.reason, reason);
      assert.equal(records[0].suppression.by, 'office manager');
      assert.equal(records[0].eligible, false);
    }
  });

  test('an exclusion reason we do not recognise is surfaced rather than honoured silently', () => {
    const { records, metrics } = estimatesOf(estimate({ suppressReason: 'because_i_said_so' }));
    assert.equal(records[0].suppression.known, false);
    assert.equal(metrics.unknownSuppressions, 1);
  });

  test('open eligible value only counts estimates still awaiting a decision', () => {
    const { metrics } = estimatesOf([
      ...estimate({ id: 'open', amountCents: 300_000 }),
      ...estimate({ id: 'done', amountCents: 900_000, decision: 'approved', decisionDaysAgo: 3 }),
      ...estimate({ id: 'held', amountCents: 700_000, crmStatus: 'disputed' }),
    ]);
    assert.equal(metrics.eligibleOpen, 1);
    assert.equal(metrics.eligibleValueCents, 300_000);
  });
});

describe('reviews — no gating', () => {
  test('withholding a request on expected sentiment is counted as a breach', () => {
    const { records, metrics } = reviewsOf(job({ skip: 'low_rating' }));
    assert.equal(records[0].sentimentGated, true);
    assert.equal(metrics.gatingBreaches, 1);
    assert.equal(records[0].needsHuman, 'request withheld on sentiment');
  });

  test('every sentiment-flavoured reason is caught, not just the one we thought of', () => {
    for (const reason of ['unhappy', 'negative_sentiment', 'bad_review_risk', 'detractor']) {
      const { metrics } = reviewsOf(job({ skip: reason }));
      assert.equal(metrics.gatingBreaches, 1, `${reason} must be caught`);
    }
  });

  test('a mechanical reason is a legitimate suppression and is not a breach', () => {
    for (const reason of ['opted_out', 'no_consent', 'wrong_contact', 'duplicate']) {
      const { records, metrics } = reviewsOf(job({ skip: reason }));
      assert.equal(metrics.gatingBreaches, 0, `${reason} is legitimate`);
      assert.equal(records[0].sentimentGated, false);
      assert.ok(records[0].skipLabel, 'the reason is still shown on the row');
    }
  });

  test('a gated job still counts as eligible, so coverage reflects the one that was missed', () => {
    const { metrics } = reviewsOf([
      ...job({ id: 'a' }),
      ...job({ id: 'b', daysAgo: 6, skip: 'low_rating' }),
    ]);
    assert.equal(metrics.eligibleJobs, 2);
    assert.equal(metrics.requestsSent, 1);
    assert.equal(metrics.requestCoveragePct, 50);
  });

  test('a low rating opens service recovery and is not just a review', () => {
    const { records } = reviewsOf(job({ rating: 1, recovery: true }));
    assert.equal(records[0].needsHuman, 'service recovery');
    assert.equal(records[0].sensitive, true);
  });

  test('a sensitive response published by an automation is a breach', () => {
    const { records, metrics } = reviewsOf(job({ rating: 2, responseActor: 'automation' }));
    assert.equal(records[0].autoPublishedSensitive, true);
    assert.equal(metrics.autoPublishedSensitive, 1);
  });

  test('a sensitive response published by a person is not', () => {
    const { metrics } = reviewsOf(job({ rating: 2, responseActor: 'human' }));
    assert.equal(metrics.autoPublishedSensitive, 0);
  });

  test('average rating is over reviews actually received, and is null with none', () => {
    const empty = reviewsOf(job({ id: 'none' }));
    assert.equal(empty.metrics.averageRating, null);

    const some = reviewsOf([
      ...job({ id: 'a', rating: 5 }),
      ...job({ id: 'b', daysAgo: 6, rating: 3 }),
    ]);
    assert.equal(some.metrics.averageRating, 4);
  });
});

describe('install & warranty — evidence', () => {
  test('a registration reported verified with no evidence stays at submitted', () => {
    const { records, metrics } = installsOf(install({ verified: true }));
    assert.equal(records[0].state, 'submitted');
    assert.equal(records[0].verifiedAt, null);
    assert.equal(records[0].evidenceMissing, true);
    assert.equal(metrics.registrationsVerified, 0);
    assert.equal(metrics.evidenceMissing, 1);
  });

  test('a confirmation number alone is not enough', () => {
    const { records } = installsOf(install({ verified: true, confirmation: 'ABC-1' }));
    assert.equal(records[0].state, 'submitted');
    assert.equal(records[0].evidenceMissing, true);
  });

  test('a certificate alone is not enough', () => {
    const { records } = installsOf(install({ verified: true, certificate: 'cert.pdf' }));
    assert.equal(records[0].state, 'submitted');
  });

  test('confirmation number AND certificate together confirm it', () => {
    const { records, metrics } = installsOf(
      install({ verified: true, confirmation: 'ABC-1', certificate: 'cert.pdf' }),
    );
    assert.equal(records[0].state, 'verified');
    assert.equal(records[0].confirmationNumber, 'ABC-1');
    assert.equal(metrics.registrationsVerified, 1);
    assert.equal(metrics.evidenceMissing, 0);
  });

  test('hasRegistrationEvidence rejects blank and whitespace-only values', () => {
    assert.equal(hasRegistrationEvidence({ confirmation_number: '  ', certificate_url: 'x.pdf' }), false);
    assert.equal(hasRegistrationEvidence({ confirmation_number: 'A', certificate_url: '' }), false);
    assert.equal(hasRegistrationEvidence({ confirmation_number: 'A', proof_ref: 'r' }), true);
  });

  test('a missing serial blocks the job at "data needed"', () => {
    const { records, metrics } = installsOf(install({ serial: null }));
    assert.equal(records[0].state, 'data needed');
    assert.deepEqual(records[0].missingData, ['serial number']);
    assert.equal(metrics.missingData, 1);
    assert.equal(records[0].needsHuman, 'missing equipment data');
  });

  test('a blocked registration reports its reason and stays blocked', () => {
    const { records, metrics } = installsOf(install({ blocked: true }));
    assert.equal(records[0].state, 'blocked');
    assert.equal(records[0].blockedReason, 'serial plate unreadable');
    assert.equal(metrics.blocked, 1);
  });

  test('a deadline inside the warning window escalates before it is missed', () => {
    const { records, metrics } = installsOf(install({ deadlineInDays: 5 }));
    assert.equal(records[0].state, 'deadline approaching');
    assert.equal(metrics.deadlinesApproaching, 1);
  });

  test('equipment that needs no registration is not chased', () => {
    const { records } = installsOf(install({ required: false, serial: null }));
    assert.equal(records[0].state, 'not required');
    assert.equal(records[0].needsHuman, null);
  });

  test('closeout is only complete with the packet, the proof and the maintenance visit', () => {
    const partial = installsOf(
      install({ verified: true, confirmation: 'A', certificate: 'c.pdf' }),
    );
    assert.equal(partial.records[0].closeoutComplete, false, 'no packet sent');

    const full = installsOf(
      install({ verified: true, confirmation: 'A', certificate: 'c.pdf', packetSent: true }),
    );
    assert.equal(full.records[0].closeoutComplete, false, 'no maintenance recorded either');
  });
});

describe('memberships — native first', () => {
  test('a card the provider is still retrying is not an exception', () => {
    const { records, metrics } = membershipsOf(
      membership({ paymentFailed: true, providerRetryState: 'scheduled' }),
    );
    assert.equal(records[0].payment.providerExhausted, false);
    assert.equal(records[0].exception, false);
    assert.equal(metrics.exceptions, 0);
    assert.equal(metrics.failedPayments, 1);
  });

  test('a card the provider has given up on is the exception this module exists for', () => {
    const { records, metrics } = membershipsOf(
      membership({ paymentFailed: true, providerRetryState: 'exhausted' }),
    );
    assert.equal(records[0].payment.providerExhausted, true);
    assert.equal(metrics.exceptions, 1);
    assert.equal(records[0].needsHuman, 'failed payment — provider gave up');
  });

  test('a recovery by the provider is counted and left alone', () => {
    const { metrics } = membershipsOf(
      membership({ paymentFailed: true, recovered: true, recoveredBy: 'provider' }),
    );
    assert.equal(metrics.recoveredByProvider, 1);
    assert.equal(metrics.failedPayments, 0);
    assert.equal(metrics.retainedRevenueCents, 18_900);
  });

  test('retained revenue is null when no recovery carried an amount', () => {
    const { metrics } = membershipsOf(
      membership({ paymentFailed: true, recovered: true, recoveredAmountCents: null }),
    );
    assert.equal(metrics.retainedRevenueCents, null);
    assert.deepEqual(metrics.retainedCoverage, { withAmount: 0, total: 1 });
  });

  test('an overdue included visit is an exception', () => {
    const { records, metrics } = membershipsOf(membership({ visitDueInDays: -10 }));
    assert.equal(records[0].visit.overdue, true);
    assert.equal(metrics.overdueVisits, 1);
  });

  test('a booked visit is neither due nor overdue', () => {
    const { metrics } = membershipsOf(membership({ visitDueInDays: -10, visitBooked: true }));
    assert.equal(metrics.overdueVisits, 0);
    assert.equal(metrics.upcomingVisits, 0);
  });

  test('a cancellation request stops renewal chasing and asks for a person', () => {
    const { records, metrics } = membershipsOf(membership({ cancelled: true }));
    assert.equal(records[0].needsHuman, 'cancellation request');
    assert.equal(records[0].status, 'cancellation requested');
    assert.equal(records[0].active, false, 'a cancelling member is not counted as retained');
    assert.equal(metrics.cancellations, 1);
    assert.equal(metrics.renewalsDue, 0, 'and is not chased for renewal');
  });
});

describe('lead capture — safety', () => {
  test('a safety flag with a handoff recorded is not a breach', () => {
    const { metrics } = leadsOf(lead({ safetyFlags: ['gas'], handoff: true }));
    assert.equal(metrics.safetyBreaches, 0);
    assert.equal(metrics.escalations, 1);
  });

  test('a safety flag with NO handoff is a breach', () => {
    const { leads, metrics } = leadsOf(lead({ safetyFlags: ['electrical'], handoff: false }));
    assert.equal(leads[0].safetyBreach, true);
    assert.equal(metrics.safetyBreaches, 1);
    assert.match(leads[0].nextAction, /stop automation/);
  });

  test('every category on the safety list triggers the rule', () => {
    for (const flag of [
      'electrical', 'gas', 'fire', 'smoke', 'flood_safety',
      'medical', 'distressed', 'complaint', 'ambiguous_scope', 'human_only',
    ]) {
      const { leads } = leadsOf(lead({ safetyFlags: [flag], handoff: false }));
      assert.equal(leads[0].requiresHuman, true, `${flag} must require a person`);
      assert.equal(leads[0].safetyBreach, true);
    }
  });

  test('an emergency urgency requires a person even with no explicit flag', () => {
    const { leads } = leadsOf(lead({ urgency: 'emergency', handoff: false }));
    assert.equal(leads[0].requiresHuman, true);
    assert.equal(leads[0].safetyBreach, true);
  });

  test('a flag we do not recognise is ignored rather than trusted', () => {
    const { leads } = leadsOf(lead({ safetyFlags: ['vibes'], handoff: false }));
    assert.deepEqual(leads[0].safetyFlags, []);
    assert.equal(leads[0].requiresHuman, false);
  });
});

describe('lead capture — response and routing', () => {
  test('within-SLA is measured against the tenant target', () => {
    const fast = leadsOf(lead({ latencyMs: 8_000 }));
    assert.equal(fast.leads[0].withinSla, true);
    assert.equal(fast.metrics.withinSlaPct, 100);

    const slow = leadsOf(lead({ latencyMs: 9 * 60 * 1000 }));
    assert.equal(slow.leads[0].withinSla, false);
    assert.equal(slow.metrics.withinSlaPct, 0);
  });

  test('a tenant with its own target overrides the default', () => {
    const events = lead({ latencyMs: 90_000 });
    const threads = buildThreads(events, null);
    const strict = buildLeadCapture(events, threads, { ...TENANT, responseSlaSeconds: 60 }, NOW);
    assert.equal(strict.leads[0].withinSla, false);
    assert.equal(strict.metrics.slaMs, 60_000);
  });

  test('a routed lead nobody acknowledged is flagged after the grace period', () => {
    const { leads, metrics } = leadsOf(lead({ daysAgo: 1, acknowledged: false }));
    assert.equal(leads[0].unacknowledged, true);
    assert.equal(metrics.unacknowledged, 1);
  });

  test('an acknowledged lead is not flagged', () => {
    const { metrics } = leadsOf(lead({ daysAgo: 1, acknowledged: true }));
    assert.equal(metrics.unacknowledged, 0);
  });

  test('a reply counts as acknowledgement', () => {
    const { metrics } = leadsOf(lead({ daysAgo: 1, acknowledged: false, replied: true }));
    assert.equal(metrics.unacknowledged, 0);
  });

  test('an ancient unacknowledged lead is history, not a task', () => {
    const { metrics } = leadsOf(lead({ daysAgo: 40, acknowledged: false }));
    assert.equal(metrics.unacknowledged, 0);
  });

  test('qualification absent is reported as unknown, never as zero qualified', () => {
    const none = leadsOf(lead({ qualified: null }));
    assert.equal(none.metrics.qualificationSeen, false);
    assert.equal(none.metrics.qualified, 0, 'the raw count is still zero…');

    const some = leadsOf(lead({ qualified: true }));
    assert.equal(some.metrics.qualificationSeen, true, '…but the page is told whether to print it');
    assert.equal(some.metrics.qualified, 1);
  });
});

describe('idempotency', () => {
  test('a duplicate event does not double-count a follow-up', () => {
    const events = estimate({ createdDaysAgo: 20, followupDaysAgo: [17] });
    const once = estimatesOf(events);
    assert.equal(once.records[0].sentCount, 1);

    /* the same row delivered twice — a webhook retry that got past the unique index, or a
       replayed batch. the count of messages sent to a customer must not move. */
    const twice = estimatesOf([...events, ...events.map((e) => ({ ...e, id: `${e.id}-replay` }))]);
    assert.equal(twice.records.length, 1);
    assert.equal(twice.records[0].sentCount, 1);
    assert.equal(twice.records[0].followupCount, 1);
  });

  test('deduplication falls back to the row id when there is no event key', () => {
    const events = estimate({ followupDaysAgo: [17] }).map((e) => ({ ...e, eventKey: null }));
    const doubled = estimatesOf([...events, ...events]);
    assert.equal(doubled.records[0].sentCount, 1);
  });
});
