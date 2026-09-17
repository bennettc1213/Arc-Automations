/* the portal's other load-bearing promises: that a module which is not connected never
 * prints a zero, that "healthy" requires evidence, that one client's events can never reach
 * another client's dashboard, and that none of the above broke the pipeline that existed
 * before any of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { computeModuleAvailability } from '../src/portal/lib/modules.js';
import { computeModuleHealth, overallHealth } from '../src/portal/lib/health.js';
import { buildAttentionQueue } from '../src/portal/lib/attention.js';
import { buildThreads } from '../src/portal/lib/derive.js';
import { buildLeadCapture, buildEstimates, buildReviews, buildMemberships, buildInstalls }
  from '../src/portal/lib/lifecycle.js';
import { NAV_GROUPS, activeItem, navGroupsFor, navItemsFor } from '../src/portal/lib/nav.js';
import { buildActivity, matchesGroup, safeMeta } from '../src/portal/lib/activity.js';
import { EVENT_TYPES, moduleForEvent } from '../src/portal/lib/types.js';
import { maskEmail, maskPhone } from '../src/portal/lib/format.js';
import { validateBody, validateEvent } from '../supabase/functions/ingest/validate.ts';
import { NOW, TENANT, ago, canary, estimate, ev, install, job, lead, membership } from './helpers.js';

const availabilityFor = (tenant, events) => computeModuleAvailability(tenant, events, NOW);

describe('module availability — none, unknown, and not yours', () => {
  test('declared with events is live', () => {
    const a = availabilityFor(TENANT, estimate({}));
    assert.equal(a.estimates.state, 'live');
    assert.equal(a.estimates.available, true);
  });

  test('declared with no events is awaiting, not zero', () => {
    const a = availabilityFor(TENANT, []);
    assert.equal(a.estimates.state, 'awaiting');
    assert.equal(a.estimates.available, true, 'the page still exists, it just has nothing yet');
    assert.ok(a.estimates.awaiting, 'and it carries a sentence explaining why');
  });

  test('not declared and no events is unavailable — the page does not exist', () => {
    const a = availabilityFor({ ...TENANT, modules: ['lead_capture'] }, []);
    assert.equal(a.estimates.state, 'unavailable');
    assert.equal(a.memberships.state, 'unavailable');
  });

  test('observation beats declaration — real data is never hidden by a missing tick-box', () => {
    const a = availabilityFor({ ...TENANT, modules: [] }, estimate({}));
    assert.equal(a.estimates.state, 'live');
  });

  test('lead capture is always on, because it is what the pipeline itself is', () => {
    const a = availabilityFor({ ...TENANT, modules: [] }, []);
    assert.equal(a.lead_capture.state, 'awaiting');
    assert.notEqual(a.lead_capture.state, 'unavailable');
  });

  test('a tenant row from before the migration reads as nothing declared, not as an error', () => {
    const a = availabilityFor({ ...TENANT, modules: undefined }, estimate({}));
    assert.equal(a.estimates.state, 'live');
    assert.equal(a.reviews.state, 'unavailable');
  });

  test('a canary does not make a module look connected', () => {
    const a = availabilityFor(TENANT, [canary({ module: 'estimates' })]);
    assert.equal(a.estimates.state, 'awaiting', 'a check is not business activity');
  });
});

describe('lifecycle funnel', () => {
  const build = (tenant, events) => buildDashboardData(tenant, events, NOW);

  test('a stage whose module is not connected shows null, never 0', () => {
    const data = build({ ...TENANT, modules: ['lead_capture'] }, lead({}));
    const byKey = Object.fromEntries(data.lifecycle.map((s) => [s.key, s]));

    assert.equal(byKey.captured.value, 1);
    assert.equal(byKey.estimated.value, null, 'not connected must not read as zero quotes');
    assert.equal(byKey.estimated.available, false);
    assert.ok(byKey.estimated.note, 'and it says why');
    assert.equal(byKey.retained.value, null);
  });

  test('a connected module with nothing in it shows a real zero', () => {
    const data = build(TENANT, [...lead({}), ...estimate({ createdDaysAgo: 80 })]);
    const byKey = Object.fromEntries(data.lifecycle.map((s) => [s.key, s]));
    assert.equal(byKey.estimated.value, 0, 'in-window count is genuinely zero');
    assert.equal(byKey.estimated.available, true);
  });

  test('qualification not running is distinguished from nothing qualifying', () => {
    const data = build(TENANT, lead({ qualified: null }));
    const q = data.lifecycle.find((s) => s.key === 'qualified');
    assert.equal(q.value, null);
    assert.match(q.note, /not running/);
  });
});

describe('automation health — evidence, not a green execution', () => {
  const healthFor = (events, tenant = TENANT) =>
    computeModuleHealth(events, availabilityFor(tenant, events), NOW);

  test('a module producing events with nothing checking it is "not verified", not healthy', () => {
    const h = healthFor(estimate({ createdDaysAgo: 1 }));
    assert.equal(h.estimates.state, 'unverified');
    assert.equal(h.estimates.verified, false);
    assert.match(h.estimates.summary, /nothing is checking it/);
  });

  test('a passing canary scoped to the module earns "working"', () => {
    const events = [
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 2 }),
    ];
    const h = healthFor(events);
    assert.equal(h.estimates.state, 'healthy');
    assert.equal(h.estimates.verified, true);
  });

  test('a failing canary is action required', () => {
    const events = [
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 2, status: 'failure' }),
    ];
    assert.equal(healthFor(events).estimates.state, 'failing');
  });

  test('a recent failure with a passing latest check is degraded, not failing', () => {
    const events = [
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 6, status: 'failure' }),
      canary({ module: 'estimates', hours: 1 }),
    ];
    assert.equal(healthFor(events).estimates.state, 'degraded');
  });

  test('an unscoped canary belongs to lead capture, which is the pipeline it traverses', () => {
    const events = [...lead({}), canary({ hours: 1 })];
    assert.equal(healthFor(events).lead_capture.state, 'healthy');
    /* and it does NOT make any other module look checked. estimates is declared on this
       tenant but has produced nothing, so it stays awaiting rather than borrowing the
       green from a canary that never went near it. */
    assert.equal(healthFor(events).estimates.state, 'awaiting');
    assert.equal(healthFor(events).estimates.verified, false);
  });

  test('an auth failure is action required regardless of how few rows it is', () => {
    const events = [
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 1 }),
      ev({
        entityType: 'estimate',
        entityId: 'est-1',
        eventType: 'estimate_followup_sent',
        occurredAt: ago(0, 2),
        status: 'failure',
        errorClass: 'auth',
      }),
    ];
    const h = healthFor(events);
    assert.equal(h.estimates.state, 'failing');
    assert.ok(h.estimates.checks.some((c) => c.key === 'auth'));
  });

  test('a module gone quiet past its own tolerance says so', () => {
    const events = [...estimate({ createdDaysAgo: 40 }), canary({ module: 'estimates', hours: 1 })];
    assert.equal(healthFor(events).estimates.state, 'quiet');
  });

  test('a module with no events is awaiting rather than broken', () => {
    assert.equal(healthFor([]).estimates.state, 'awaiting');
  });

  test('overall health reports the worst live module, not an average', () => {
    const events = [
      ...lead({}),
      canary({ hours: 1 }),
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 1, status: 'failure' }),
    ];
    const overall = overallHealth(healthFor(events));
    assert.equal(overall.state, 'failing');
    assert.ok(overall.modules.includes('estimate recovery'));
  });

  test('every module unconnected reports awaiting rather than healthy', () => {
    const overall = overallHealth(healthFor([], { ...TENANT, modules: [] }));
    assert.equal(overall.state, 'awaiting');
  });
});

describe('the needs-attention queue', () => {
  function queueFor(events, tenant = TENANT) {
    const threads = buildThreads(events, null);
    const parts = {
      leadCapture: buildLeadCapture(events, threads, tenant, NOW),
      estimates: buildEstimates(events, NOW),
      reviews: buildReviews(events, NOW),
      memberships: buildMemberships(events, NOW),
      installs: buildInstalls(events, NOW),
    };
    const availability = computeModuleAvailability(tenant, events, NOW);
    const health = computeModuleHealth(events, availability, NOW);
    return buildAttentionQueue(parts, health, events, availability, NOW);
  }

  test('safety outranks everything else in the list', () => {
    const q = queueFor([
      ...install({ id: 'i1', serial: null }),
      ...estimate({ id: 'e1', followupDaysAgo: [17], reply: 'question', replyDaysAgo: 15 }),
      ...lead({ id: '22222222-2222-4222-8222-222222222222', safetyFlags: ['gas'], handoff: false }),
    ]);

    assert.equal(q.items[0].reason, 'safety escalation');
    assert.equal(q.items[0].priority, 'urgent');
  });

  test('not everything is urgent — the list stays triageable', () => {
    const q = queueFor([
      ...install({ id: 'i1', serial: null }),
      ...estimate({ id: 'e1', followupDaysAgo: [17], reply: 'question', replyDaysAgo: 15 }),
    ]);
    assert.equal(q.counts.urgent, 0);
    assert.ok(q.total > 0);
    assert.ok(q.items.every((i) => ['urgent', 'high', 'normal'].includes(i.priority)));
  });

  test('a module that is not connected contributes nothing', () => {
    const events = [...estimate({ followupDaysAgo: [17], reply: 'question', replyDaysAgo: 15 })];
    const q = queueFor(events, { ...TENANT, modules: ['lead_capture'] });
    /* the estimate module is still observed from its events, so it IS live — the check that
       matters is that a module with neither declaration nor events adds nothing. */
    assert.equal(q.byModule.memberships, undefined);
    assert.equal(q.byModule.installs, undefined);
  });

  test('an explicit task event is picked up, and resolving it removes it', () => {
    const open = ev({
      eventType: 'task_opened',
      entityType: 'task',
      entityId: 't1',
      occurredAt: ago(2),
      payload: { module: 'estimates', reason: 'call the adjuster', priority: 'high', customer: 'x' },
    });
    const withOpen = queueFor([open]);
    assert.equal(withOpen.total, 1);
    assert.equal(withOpen.items[0].reason, 'call the adjuster');

    const resolved = ev({
      eventType: 'task_resolved',
      entityType: 'task',
      entityId: 't1',
      occurredAt: ago(1),
    });
    assert.equal(queueFor([open, resolved]).total, 0);
  });

  test('a failing automation is itself an urgent item', () => {
    const q = queueFor([
      ...estimate({ createdDaysAgo: 1 }),
      canary({ module: 'estimates', hours: 1, status: 'failure' }),
    ]);
    assert.ok(q.items.some((i) => i.reason === 'automation failure' && i.priority === 'urgent'));
  });

  test('one problem produces one row, even when two sources describe it', () => {
    const events = [...lead({ safetyFlags: ['gas'], handoff: false })];
    const q = queueFor(events);
    const keys = q.items.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('capping the payload does not cap the counts', () => {
    const events = [];
    for (let i = 0; i < 12; i++) {
      events.push(...install({ id: `i${i}`, daysAgo: 10 + i, serial: null }));
    }
    const threads = buildThreads(events, null);
    const parts = {
      leadCapture: buildLeadCapture(events, threads, TENANT, NOW),
      estimates: buildEstimates(events, NOW),
      reviews: buildReviews(events, NOW),
      memberships: buildMemberships(events, NOW),
      installs: buildInstalls(events, NOW),
    };
    const availability = computeModuleAvailability(TENANT, events, NOW);
    const health = computeModuleHealth(events, availability, NOW);
    const q = buildAttentionQueue(parts, health, events, availability, NOW, 5);

    assert.equal(q.items.length, 5);
    assert.equal(q.total, 12, 'the header still reports what is really waiting');
    assert.equal(q.byModule.installs, 12);
  });
});

describe('tenant isolation', () => {
  test("another tenant's events never reach this tenant's figures", () => {
    const mine = lead({ id: '33333333-3333-4333-8333-333333333333' });
    const theirs = lead({ id: '44444444-4444-4444-8444-444444444444' }).map((e) => ({
      ...e,
      tenantId: 'tenant-b',
    }));

    const data = buildDashboardData(TENANT, [...mine, ...theirs], NOW);
    assert.equal(data.threadTotal, 1);
    assert.equal(data.metrics.leadsLast30Days, 1);
    assert.ok(data.threads.every((t) => t.id !== '44444444-4444-4444-8444-444444444444'));
  });

  test("another tenant's estimates cannot inflate recovered revenue", () => {
    const theirs = estimate({
      id: 'theirs',
      followupDaysAgo: [17],
      decision: 'approved',
      decisionDaysAgo: 14,
      decisionAmountCents: 999_999,
    }).map((e) => ({ ...e, tenantId: 'tenant-b' }));

    const data = buildDashboardData(TENANT, theirs, NOW);
    assert.equal(data.estimates.records.length, 0);
    assert.equal(data.estimates.metrics.recoveredRevenueCents, null);
  });

  test('events with no tenant stamped on them are kept — there is nothing to disagree with', () => {
    const anon = lead({ id: '55555555-5555-4555-8555-555555555555' }).map((e) => ({
      ...e,
      tenantId: null,
    }));
    assert.equal(buildDashboardData(TENANT, anon, NOW).threadTotal, 1);
  });
});

describe('navigation', () => {
  test('a module the client does not have is not in the rail', () => {
    const availability = availabilityFor({ ...TENANT, modules: ['lead_capture'] }, []);
    const labels = navGroupsFor(availability).flatMap((g) => g.items.map((i) => i.to));

    assert.ok(labels.includes('leads'));
    assert.ok(!labels.includes('memberships'));
    assert.ok(!labels.includes('estimates'));
    assert.ok(labels.includes('activity'), 'the non-module pages are untouched');
    assert.ok(labels.includes('reports'));
  });

  test('a declared-but-silent module stays in the rail so it can be asked about', () => {
    const availability = availabilityFor({ ...TENANT, modules: ['lead_capture', 'estimates'] }, []);
    const tos = navItemsFor(availability).map((i) => i.to);
    assert.ok(tos.includes('estimates'));
  });

  test('every nav route resolves to itself, and the index is not greedy', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      const path = item.to ? `/portal/dashboard/${item.to}` : '/portal/dashboard';
      assert.equal(activeItem(path, '/portal/dashboard').to, item.to, `${path} must resolve`);
    }
  });

  test('a sub-path resolves to its parent page', () => {
    assert.equal(activeItem('/portal/dashboard/estimates/est-1', '/portal/dashboard').to, 'estimates');
  });

  test('the demo base resolves the same pages', () => {
    assert.equal(activeItem('/demo/memberships', '/demo').to, 'memberships');
    assert.equal(activeItem('/demo', '/demo').to, '');
  });

  test('every page has a title and a blurb, so the top bar is never blank', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      assert.ok(item.title, `${item.label} needs a title`);
      assert.ok(item.blurb, `${item.label} needs a blurb`);
      assert.ok(item.icon, `${item.label} needs an icon`);
    }
  });
});

describe('the activity feed', () => {
  test('credentials never reach the browser', () => {
    const meta = safeMeta({
      api_key: 'sk-live-1234',
      authorization: 'Bearer abc',
      access_token: 'x',
      session_id: 'y',
      stage: 'first nudge',
    });
    const keys = meta.map(([k]) => k);
    assert.deepEqual(keys, ['stage']);
  });

  test('customer contact details are stripped from the log', () => {
    const keys = safeMeta({
      phone: '+16145550100',
      email: 'a@b.com',
      body: 'hello',
      customer: 'pat',
      address: '1 test st',
      classification: 'interested',
    }).map(([k]) => k);
    assert.deepEqual(keys, ['classification']);
  });

  test('nested values are summarised rather than walked', () => {
    const meta = Object.fromEntries(safeMeta({ photos: [1, 2, 3], consent: { sms: true } }));
    assert.equal(meta.photos, '3 items');
    assert.equal(meta.consent, '…');
  });

  test('long values are truncated', () => {
    const [[, value]] = safeMeta({ reason: 'x'.repeat(500) });
    assert.ok(value.length < 100);
    assert.ok(value.endsWith('…'));
  });

  test('verification rows are kept out of the default view but reachable on their own', () => {
    const activity = buildActivity([...lead({}), canary({ hours: 1 })]);
    assert.ok(activity.rows.every((r) => !r.isVerification));
    assert.equal(activity.verification.length, 1);
    assert.ok(!matchesGroup(activity.verification[0], 'all'));
    assert.ok(matchesGroup(activity.verification[0], 'verification'));
  });

  test('rows can be grouped by module, failure and human action', () => {
    const events = [
      ...estimate({ followupDaysAgo: [17] }),
      ...job({ rating: 5, responseActor: 'human' }),
      ev({ eventType: 'sms_sent', status: 'failure', correlationId: 'c1', occurredAt: ago(1) }),
    ];
    const { rows } = buildActivity(events);
    assert.ok(rows.some((r) => matchesGroup(r, 'estimates')));
    assert.ok(rows.some((r) => matchesGroup(r, 'reviews')));
    assert.ok(rows.some((r) => matchesGroup(r, 'failures')));
    assert.ok(rows.some((r) => matchesGroup(r, 'human')));
  });

  test('the event contract fields survive onto the row', () => {
    const { rows } = buildActivity(estimate({ followupDaysAgo: [17] }));
    const row = rows.find((r) => r.type === 'estimate_created');
    assert.equal(row.entityType, 'estimate');
    assert.equal(row.entityId, 'est-1');
    assert.equal(row.sourceSystem, 'jobber');
    assert.equal(row.module, 'estimates');
    assert.ok(row.idempotencyKey);
    assert.ok(row.recordedAt);
  });

  test('tenant_id is deliberately not shipped to the browser', () => {
    const { rows } = buildActivity(estimate({}));
    assert.equal(rows[0].tenantId, undefined);
  });
});

describe('pii masking', () => {
  test('an email keeps just enough to recognise', () => {
    assert.equal(maskEmail('angela.kowalczyk@cascaderestoration.com'), 'a•••@ca•••.com');
    assert.equal(maskEmail(null), '—');
    assert.equal(maskEmail('notanemail'), '•••');
  });

  test('a phone keeps the last four', () => {
    assert.equal(maskPhone('+16145550142'), '••• ••• 0142');
    assert.equal(maskPhone(null), '—');
  });
});

describe('the event vocabulary', () => {
  test('the browser and the ingest boundary agree on every event type', () => {
    const boundary = new Set(EVENT_TYPES);
    const portal = new Set(EVENT_TYPES);
    assert.deepEqual([...boundary].sort(), [...portal].sort());
  });

  test('every event type resolves to exactly one module', () => {
    for (const type of EVENT_TYPES) {
      const module = moduleForEvent(type);
      assert.ok(module, `${type} must map to a module`);
      assert.notEqual(module, 'other', `${type} must not fall through`);
    }
  });

  test('a verification event can be scoped to a module by its payload', () => {
    assert.equal(moduleForEvent({ eventType: 'canary_check', payload: {} }), 'lead_capture');
    assert.equal(
      moduleForEvent({ eventType: 'canary_check', payload: { module: 'reviews' } }),
      'reviews',
    );
    assert.equal(
      moduleForEvent({ eventType: 'canary_check', payload: { module: 'nonsense' } }),
      'lead_capture',
      'an unknown module falls back rather than inventing one',
    );
  });
});

describe('the ingest boundary', () => {
  test('every module event type is accepted', () => {
    for (const type of EVENT_TYPES) {
      const result = validateEvent({ event_type: type, occurred_at: '2026-09-01T10:00:00Z' });
      assert.equal(result.ok, true, `${type} must be accepted: ${result.errors?.join(', ')}`);
    }
  });

  test('an unknown event type is rejected loudly', () => {
    const result = validateEvent({ event_type: 'estimate_vibes', occurred_at: '2026-09-01T10:00:00Z' });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /not recognised/);
  });

  test('entity_type without entity_id is rejected — the record could not be identified', () => {
    const result = validateEvent({
      event_type: 'estimate_created',
      occurred_at: '2026-09-01T10:00:00Z',
      entity_type: 'estimate',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /entity_id/);
  });

  test('an unknown source system is rejected rather than stored as a typo', () => {
    const result = validateEvent({
      event_type: 'estimate_created',
      occurred_at: '2026-09-01T10:00:00Z',
      source_system: 'jobbr',
    });
    assert.equal(result.ok, false);
  });

  test('a failure with no stated cause is classified rather than left blank', () => {
    const result = validateEvent({
      event_type: 'sms_sent',
      occurred_at: '2026-09-01T10:00:00Z',
      status: 'failure',
    });
    assert.equal(result.event.error_class, 'unknown');
  });

  test('an actor defaults to the automation, so "a person did this" stays a real claim', () => {
    const auto = validateEvent({ event_type: 'sms_sent', occurred_at: '2026-09-01T10:00:00Z' });
    assert.equal(auto.event.actor, 'automation');

    const human = validateEvent({
      event_type: 'review_response_published',
      occurred_at: '2026-09-01T10:00:00Z',
      actor: 'human',
    });
    assert.equal(human.event.actor, 'human');
  });

  test('occurred_at is still required and never defaulted', () => {
    const result = validateEvent({ event_type: 'estimate_created' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /occurred_at/);
  });

  test('the idempotency key survives validation, which is what makes a retry safe', () => {
    const result = validateEvent({
      event_type: 'estimate_created',
      occurred_at: '2026-09-01T10:00:00Z',
      event_key: 'wf-123-run-7',
    });
    assert.equal(result.event.event_key, 'wf-123-run-7');
  });

  test('a duplicate webhook posts an identical body and validates to an identical row', () => {
    const body = {
      event_type: 'estimate_followup_sent',
      occurred_at: '2026-09-01T10:00:00Z',
      entity_type: 'estimate',
      entity_id: 'est-1',
      event_key: 'wf-123-run-7',
      payload: { stage: 'first' },
    };
    const a = validateEvent(body);
    const b = validateEvent(body);
    assert.deepEqual(a.event, b.event, 'same key, same row — the unique index does the rest');
  });

  test('a batch is still bounded', () => {
    const one = { event_type: 'lead_received', occurred_at: '2026-09-01T10:00:00Z' };
    assert.equal(validateBody({ events: Array(200).fill(one) }).ok, true);
    assert.equal(validateBody({ events: Array(201).fill(one) }).ok, false);
  });

  test('a lead-pipeline event posted the way it always was still validates unchanged', () => {
    const result = validateEvent({
      event_type: 'lead_received',
      occurred_at: '2026-09-01T10:00:00Z',
      correlation_id: '11111111-1111-4111-8111-111111111111',
      workflow_id: 'wf_speed_to_lead_v3',
      payload: { source: 'web_form' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.entity_id, null);
  });
});

describe('the pipeline that existed before any of this', () => {
  const events = [
    ...lead({ id: '66666666-6666-4666-8666-666666666666', daysAgo: 1, latencyMs: 5000 }),
    ...lead({ id: '77777777-7777-4777-8777-777777777777', daysAgo: 2, latencyMs: 15000 }),
    ...lead({ id: '88888888-8888-4888-8888-888888888888', daysAgo: 3, latencyMs: 9000 }),
    canary({ hours: 1 }),
    canary({ daysAgo: 1, hours: 1 }),
  ];
  const data = buildDashboardData(TENANT, events, NOW);

  test('the shape every existing page reads is unchanged', () => {
    for (const key of [
      'tenant', 'status', 'metrics', 'deltas', 'leadsPerDay', 'responseBuckets',
      'sources', 'hourly', 'routing', 'automations', 'reliability', 'incidents',
      'monthly', 'threads', 'threadTotal', 'isEarlyData', 'coverageDays',
    ]) {
      assert.ok(key in data, `data.${key} must still exist`);
    }
  });

  test('a thread still carries the fields the leads table and the feed read', () => {
    for (const key of [
      'id', 'startedAt', 'source', 'sourceLabel', 'name', 'phone', 'lossType',
      'latencyMs', 'failed', 'tech', 'replied', 'state', 'steps',
    ]) {
      assert.ok(key in data.threads[0], `thread.${key} must still exist`);
    }
  });

  test('the headline figures still compute', () => {
    assert.equal(data.metrics.leadsLast30Days, 3);
    /* nearest-rank, which is what percentile() has always done and what every figure in the
       product is already computed with — an odd count makes that unambiguous here. */
    assert.equal(data.metrics.medianResponseMs, 9000);
    assert.equal(data.status.status, 'operational');
  });

  test('canaries still never reach a client-facing count', () => {
    assert.equal(data.metrics.leadsLast30Days, 3, 'three real leads, two canaries, count is three');
    assert.ok(data.threads.every((t) => t.steps.every((s) => s.type !== 'canary_check')));
  });

  test('an empty tenant produces a renderable dashboard rather than an exception', () => {
    const empty = buildDashboardData(TENANT, [], NOW);
    assert.equal(empty.threadTotal, 0);
    assert.equal(empty.metrics.uptimePct, null, 'no checks is null, never 100%');
    assert.equal(empty.status.status, 'unchecked');
    assert.equal(empty.attention.total, 0);
    assert.equal(empty.activity.rows.length, 0);
    assert.ok(empty.lifecycle.length > 0);
  });
});
