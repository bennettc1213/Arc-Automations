/* shared fixtures for the portal's test suite.
 *
 * everything here builds events in the shape `toEvent()` produces, because that is the shape
 * every derivation in the product actually receives. a fixture in the database's snake_case
 * shape would pass tests against code that never sees it.
 */

import { DateTime } from 'luxon';

export const NOW = DateTime.fromISO('2026-09-17T12:00:00.000Z', { zone: 'utc' });

export const TENANT = {
  id: 'tenant-a',
  name: 'Test Restoration',
  slug: 'test',
  timezone: 'America/New_York',
  status: 'active',
  createdAt: NOW.minus({ days: 400 }).toISO(),
  modules: ['lead_capture', 'estimates', 'reviews', 'memberships', 'installs'],
};

let counter = 0;

export function ev(overrides = {}) {
  counter += 1;
  return {
    id: `ev-${counter}`,
    tenantId: TENANT.id,
    eventType: 'lead_received',
    workflowId: 'wf_test',
    executionId: `exec-${counter}`,
    correlationId: null,
    status: 'success',
    payload: {},
    latencyMs: null,
    isCanary: false,
    occurredAt: NOW.minus({ days: 1 }).toISO(),
    recordedAt: NOW.minus({ days: 1 }).toISO(),
    eventKey: `key-${counter}`,
    entityType: null,
    entityId: null,
    sourceSystem: null,
    externalId: null,
    actor: 'automation',
    errorClass: null,
    ...overrides,
  };
}

/* days-ago helper. every fixture is written relative to a frozen NOW so a test cannot start
   failing at midnight or on the first of a month. */
export function ago(days, hours = 0) {
  return NOW.minus({ days, hours }).toISO();
}

export function ahead(days) {
  return NOW.plus({ days }).toISO();
}

/* one estimate's worth of events, with the pieces each test needs to vary. */
export function estimate({
  id = 'est-1',
  amountCents = 500_000,
  createdDaysAgo = 20,
  followupDaysAgo = [],
  reply = null,
  replyDaysAgo = null,
  decision = null,
  decisionDaysAgo = null,
  decisionAmountCents = null,
  grossMarginPct = null,
  suppressReason = null,
  crmStatus = 'sent',
  payload = {},
} = {}) {
  const base = { entityType: 'estimate', entityId: id, sourceSystem: 'jobber' };
  const events = [
    ev({
      ...base,
      eventType: 'estimate_created',
      occurredAt: ago(createdDaysAgo),
      payload: {
        customer: 'sam tester',
        work_type: 'water mitigation',
        amount_cents: amountCents,
        estimate_date: ago(createdDaysAgo),
        crm_status: crmStatus,
        ...payload,
      },
    }),
  ];

  for (const days of followupDaysAgo) {
    events.push(
      ev({
        ...base,
        eventType: 'estimate_followup_sent',
        occurredAt: ago(days),
        payload: { stage: `day ${createdDaysAgo - days}`, channel: 'sms' },
      }),
    );
  }

  if (reply) {
    events.push(
      ev({
        ...base,
        eventType: 'estimate_reply_received',
        occurredAt: ago(replyDaysAgo),
        payload: { classification: reply, body: 'a reply' },
      }),
    );
  }

  if (decision) {
    events.push(
      ev({
        ...base,
        eventType: 'estimate_decision',
        occurredAt: ago(decisionDaysAgo),
        payload: {
          decision,
          amount_cents: decisionAmountCents ?? amountCents,
          ...(grossMarginPct === null ? {} : { gross_margin_pct: grossMarginPct }),
        },
      }),
    );
  }

  if (suppressReason) {
    events.push(
      ev({
        ...base,
        eventType: 'estimate_suppressed',
        occurredAt: ago(createdDaysAgo - 1),
        actor: 'human',
        payload: { reason: suppressReason, by: 'office manager' },
      }),
    );
  }

  return events;
}

/* a lead thread, optionally with a qualifier verdict and a handoff. */
export function lead({
  id = '11111111-1111-4111-8111-111111111111',
  daysAgo = 1,
  latencyMs = 6000,
  safetyFlags = null,
  urgency = 'same day',
  handoff = false,
  handoffResolved = false,
  qualified = true,
  routed = true,
  acknowledged = true,
  replied = false,
} = {}) {
  const at = NOW.minus({ days: daysAgo });
  const events = [
    ev({
      eventType: 'lead_received',
      correlationId: id,
      occurredAt: at.toISO(),
      payload: { source: 'web_form', caller: 'pat tester', phone: '+16145550100', loss_type: 'water' },
    }),
    ev({
      eventType: 'sms_sent',
      correlationId: id,
      occurredAt: at.plus({ milliseconds: latencyMs }).toISO(),
      latencyMs,
      payload: { to: '+16145550100' },
    }),
  ];

  if (routed) {
    events.push(
      ev({
        eventType: 'routed',
        correlationId: id,
        occurredAt: at.plus({ minutes: 1 }).toISO(),
        payload: {
          tech: 'dana reyes',
          ...(acknowledged ? { acknowledged_at: at.plus({ minutes: 3 }).toISO() } : {}),
        },
      }),
    );
  }

  if (replied) {
    events.push(
      ev({
        eventType: 'reply_received',
        correlationId: id,
        occurredAt: at.plus({ minutes: 20 }).toISO(),
        payload: {},
      }),
    );
  }

  if (qualified !== null) {
    events.push(
      ev({
        eventType: 'lead_qualified',
        correlationId: id,
        entityType: 'lead',
        entityId: id,
        occurredAt: at.plus({ seconds: 10 }).toISO(),
        payload: {
          outcome: qualified ? 'qualified' : 'out_of_area',
          job_type: 'water — burst supply line',
          urgency,
          in_service_area: qualified,
          consent: { sms: true },
          ...(safetyFlags ? { safety_flags: safetyFlags } : {}),
        },
      }),
    );
  }

  if (handoff) {
    events.push(
      ev({
        eventType: 'handoff_requested',
        correlationId: id,
        entityType: 'lead',
        entityId: id,
        occurredAt: at.plus({ seconds: 40 }).toISO(),
        payload: {
          reason: 'safety',
          assigned_to: 'marcus',
          ...(handoffResolved ? { resolved_at: at.plus({ minutes: 10 }).toISO() } : {}),
        },
      }),
    );
  }

  return events;
}

export function job({
  id = 'job-1',
  daysAgo = 5,
  skip = null,
  requested = true,
  delivered = true,
  rating = null,
  responseActor = null,
  recovery = false,
  recoveryResolved = false,
} = {}) {
  const base = { entityType: 'job', entityId: id, sourceSystem: 'jobber' };
  const events = [
    ev({
      ...base,
      eventType: 'job_completed',
      occurredAt: ago(daysAgo),
      payload: {
        customer: 'jo tester',
        work_type: 'drying',
        tech: 'dana reyes',
        completed_at: ago(daysAgo),
        ...(skip ? { review_request_skipped: skip } : {}),
      },
    }),
  ];

  if (requested && !skip) {
    events.push(
      ev({
        ...base,
        eventType: 'review_request_sent',
        occurredAt: ago(daysAgo - 1),
        status: delivered ? 'success' : 'failure',
        payload: { channel: 'sms' },
      }),
    );
  }

  if (rating !== null) {
    events.push(
      ev({
        ...base,
        eventType: 'review_received',
        occurredAt: ago(daysAgo - 2),
        payload: { rating, platform: 'google', text: 'some text' },
      }),
    );
  }

  if (responseActor) {
    events.push(
      ev({
        ...base,
        eventType: 'review_response_published',
        occurredAt: ago(daysAgo - 3),
        actor: responseActor,
        payload: { by: 'owner' },
      }),
    );
  }

  if (recovery) {
    events.push(
      ev({
        ...base,
        eventType: 'service_recovery_opened',
        occurredAt: ago(daysAgo - 2),
        payload: { reason: 'unhappy', priority: 'high' },
      }),
    );
    if (recoveryResolved) {
      events.push(
        ev({
          ...base,
          eventType: 'service_recovery_resolved',
          occurredAt: ago(daysAgo - 3),
          actor: 'human',
          payload: { resolution: 'called back' },
        }),
      );
    }
  }

  return events;
}

export function install({
  id = 'ins-1',
  daysAgo = 10,
  serial = 'SN123456',
  model = 'MD-1',
  manufacturer = 'Rheem',
  deadlineInDays = 40,
  submitted = false,
  verified = false,
  confirmation = null,
  certificate = null,
  blocked = false,
  required = true,
  packetSent = false,
} = {}) {
  const base = { entityType: 'install', entityId: id, sourceSystem: 'jobber' };
  const events = [
    ev({
      ...base,
      eventType: 'install_completed',
      occurredAt: ago(daysAgo),
      payload: { customer: 'alex tester', job: 'water heater', installed_at: ago(daysAgo) },
    }),
    ev({
      ...base,
      eventType: 'install_closeout_updated',
      occurredAt: ago(daysAgo, 1),
      payload: {
        manufacturer,
        category: 'water heater',
        ...(model ? { model_number: model } : {}),
        ...(serial ? { serial_number: serial } : {}),
        registration_required: required,
        registration_deadline: ahead(deadlineInDays),
        ...(packetSent ? { packet_sent: true } : {}),
      },
    }),
  ];

  if (submitted) {
    events.push(
      ev({ ...base, eventType: 'warranty_registration_submitted', occurredAt: ago(daysAgo - 1) }),
    );
  }

  if (blocked) {
    events.push(
      ev({
        ...base,
        eventType: 'warranty_registration_blocked',
        occurredAt: ago(daysAgo - 1),
        status: 'failure',
        payload: { reason: 'serial plate unreadable' },
      }),
    );
  }

  if (verified) {
    events.push(
      ev({
        ...base,
        eventType: 'warranty_registration_verified',
        occurredAt: ago(daysAgo - 2),
        payload: {
          ...(confirmation ? { confirmation_number: confirmation } : {}),
          ...(certificate ? { certificate_url: certificate } : {}),
        },
      }),
    );
  }

  return events;
}

export function membership({
  id = 'mem-1',
  plan = 'priority response — residential',
  renewalInDays = 20,
  status = 'active',
  paymentFailed = false,
  providerRetryState = 'scheduled',
  recovered = false,
  recoveredBy = 'provider',
  recoveredAmountCents = 18900,
  visitDueInDays = null,
  visitBooked = false,
  cancelled = false,
} = {}) {
  const base = { entityType: 'membership', entityId: id, sourceSystem: 'housecall_pro' };
  const events = [
    ev({
      ...base,
      eventType: 'membership_recorded',
      occurredAt: ago(30),
      payload: {
        customer: 'chris tester',
        plan,
        price_cents: 18900,
        renewal_date: ahead(renewalInDays),
        status,
      },
    }),
  ];

  if (paymentFailed) {
    events.push(
      ev({
        ...base,
        eventType: 'membership_payment_failed',
        occurredAt: ago(6),
        status: 'failure',
        payload: { attempt: 3, amount_cents: 18900, provider_retry_state: providerRetryState },
      }),
    );
    if (recovered) {
      events.push(
        ev({
          ...base,
          eventType: 'membership_payment_recovered',
          occurredAt: ago(4),
          payload: { recovered_by: recoveredBy, amount_cents: recoveredAmountCents },
        }),
      );
    }
  }

  if (visitDueInDays !== null) {
    events.push(
      ev({
        ...base,
        eventType: 'membership_visit_due',
        occurredAt: ago(10),
        payload: { due_date: ahead(visitDueInDays), visit_type: 'annual inspection' },
      }),
    );
    if (visitBooked) {
      events.push(
        ev({
          ...base,
          eventType: 'membership_visit_booked',
          occurredAt: ago(5),
          payload: { appointment_at: ahead(3) },
        }),
      );
    }
  }

  if (cancelled) {
    events.push(
      ev({
        ...base,
        eventType: 'membership_cancellation_requested',
        occurredAt: ago(3),
        payload: { reason: 'moving' },
      }),
    );
  }

  return events;
}

export function canary({ daysAgo = 0, hours = 1, status = 'success', module = null } = {}) {
  return ev({
    eventType: 'canary_check',
    isCanary: true,
    status,
    occurredAt: NOW.minus({ days: daysAgo, hours }).toISO(),
    payload: module ? { module } : {},
  });
}
