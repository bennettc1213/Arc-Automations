/* the shared vocabulary. every other portal module builds on these.
 *
 * the portal started as one pipeline — a lead arrives, a text goes back — and the five
 * business event types below were the whole of it. it now covers five stages of a contractor's
 * revenue lifecycle, so the vocabulary is grouped by module rather than kept as one flat list.
 *
 * the grouping is the only place a module is defined. `moduleForEvent` derives an event's
 * module from its type rather than reading a column, deliberately: a stored module would be a
 * second source of truth that could disagree with the event type it sits next to, and the one
 * rule this codebase is built around is that a fact has one definition.
 */

/* ── lead capture ──────────────────────────────────────────
   the original pipeline, unchanged, plus the two events that qualification and human
   handoff produce. */
export const LEAD_CAPTURE_EVENT_TYPES = [
  'lead_received',
  'call_missed',
  'sms_sent',
  'routed',
  'reply_received',
  /* the qualifier's verdict: job type, service area, urgency, safety flags, consent. */
  'lead_qualified',
  /* automation stopped and a person was put in front of it. safety cases, angry
     customers, anything the client configured as human-only. */
  'handoff_requested',

  /* ── the execution layer (migration 0010) ──
     the five events above can all be written by something that *watched* a pipeline. these
     six can only be written by the thing that ran it, which is why they arrived with ARC
     Lead Recovery and not before.

     kept to the minimum that makes a new claim. anything derivable from the events above
     was not added: "the customer replied" is `reply_received`, "it was routed" is `routed`,
     and a second event saying the same thing in different words would be a second source
     of truth for one fact. */

  /* `sms_sent` has only ever meant "handed to the provider". whether it arrived is a
     separate fact that turns up later, by callback, and conflating the two is how a
     dashboard reports a hundred texts sent on a day the carrier rejected every one. */
  'message_delivered',
  'message_failed',

  /* the lead turned into work. the only conversion claim this product makes, and it is
     only ever written because a person or the client's own system said so — never inferred
     from an enthusiastic reply. */
  'lead_booked',

  /* this contact must not be messaged again, and why. the evidence behind the suppression
     row, so an honoured opt-out is provable rather than merely configured. */
  'lead_suppressed',

  /* the run reached a terminal state: cleanly, or having exhausted its retries. the second
     one is what turns a dead sequence into a row in the needs-a-person queue instead of a
     lead that quietly stopped. */
  'automation_completed',
  'automation_failed',
];

/* ── estimate recovery ─────────────────────────────────────
   an estimate is a record in the client's crm. arc observes it, follows up on it, and
   records what the customer decided. every one of those is a separate event because the
   claim "we recovered this" needs all four links to be provable independently. */
export const ESTIMATE_EVENT_TYPES = [
  'estimate_created',
  'estimate_followup_sent',
  'estimate_reply_received',
  'estimate_decision',
  /* excluded from the sequence, with the reason attached. */
  'estimate_suppressed',
];

/* ── reviews & service recovery ────────────────────────────── */
export const REVIEW_EVENT_TYPES = [
  'job_completed',
  'review_request_sent',
  'review_received',
  'review_response_published',
  'service_recovery_opened',
  'service_recovery_resolved',
];

/* ── memberships ───────────────────────────────────────────
   the billing provider and the crm own renewals and retries. arc records what it observed
   so the exceptions neither of them followed through on can be found. */
export const MEMBERSHIP_EVENT_TYPES = [
  'membership_recorded',
  'membership_payment_failed',
  'membership_payment_recovered',
  'membership_visit_due',
  'membership_visit_booked',
  'membership_cancellation_requested',
];

/* ── install & warranty ────────────────────────────────────── */
export const INSTALL_EVENT_TYPES = [
  'install_completed',
  'install_closeout_updated',
  'warranty_registration_submitted',
  'warranty_registration_verified',
  'warranty_registration_blocked',
];

/* ── cross-cutting ─────────────────────────────────────────
   a task an automation raised that no module rule would have inferred. everything else in
   the needs-attention queue is derived from the state of a record; these are the escape
   hatch for a workflow that knows something the log does not show. */
export const TASK_EVENT_TYPES = ['task_opened', 'task_resolved'];

/* ── verification ──────────────────────────────────────────
   never shown in a client-facing feed. these are how a module earns the word "healthy". */
export const VERIFICATION_EVENT_TYPES = [
  'canary_expectation',
  'canary_check',
  'watermark_check',
  'schema_assert',
];

export const MODULE_EVENT_TYPES = {
  lead_capture: LEAD_CAPTURE_EVENT_TYPES,
  estimates: ESTIMATE_EVENT_TYPES,
  reviews: REVIEW_EVENT_TYPES,
  memberships: MEMBERSHIP_EVENT_TYPES,
  installs: INSTALL_EVENT_TYPES,
};

export const MODULES = Object.keys(MODULE_EVENT_TYPES);

export const EVENT_TYPES = [
  ...LEAD_CAPTURE_EVENT_TYPES,
  ...ESTIMATE_EVENT_TYPES,
  ...REVIEW_EVENT_TYPES,
  ...MEMBERSHIP_EVENT_TYPES,
  ...INSTALL_EVENT_TYPES,
  ...TASK_EVENT_TYPES,
  ...VERIFICATION_EVENT_TYPES,
];

/* the five events the lead pipeline threads together.
 *
 * deliberately NOT widened to the whole business vocabulary when the modules arrived.
 * `isClientVisible` gates `buildThreads`, and `buildThreads` groups by correlation id into
 * the rows of the leads table — so adding estimate or review events here would put a
 * half-drawn "lead" in the leads table for every estimate the crm has ever held. the
 * modules thread their own records by entity id instead. */
export const CLIENT_VISIBLE_EVENT_TYPES = [
  'lead_received',
  'call_missed',
  'sms_sent',
  'routed',
  'reply_received',
];

/* everything a client is allowed to see, across every module — the activity feed's filter
   set. the verification types are the complement of this and never appear in it. */
export const CLIENT_FACING_EVENT_TYPES = [
  ...LEAD_CAPTURE_EVENT_TYPES,
  ...ESTIMATE_EVENT_TYPES,
  ...REVIEW_EVENT_TYPES,
  ...MEMBERSHIP_EVENT_TYPES,
  ...INSTALL_EVENT_TYPES,
  ...TASK_EVENT_TYPES,
];

const MODULE_BY_EVENT = new Map();
for (const [module, types] of Object.entries(MODULE_EVENT_TYPES)) {
  for (const type of types) MODULE_BY_EVENT.set(type, module);
}
for (const type of TASK_EVENT_TYPES) MODULE_BY_EVENT.set(type, 'tasks');
for (const type of VERIFICATION_EVENT_TYPES) MODULE_BY_EVENT.set(type, 'verification');

/* a task or a verification event can name the module it belongs to, because both are about
   something else: a canary traverses one pipeline, a task is raised against one record. an
   unscoped canary is lead capture's, which is the pipeline the hourly canary has always
   traversed — said out loud here rather than left as a coincidence of history. */
export function moduleForEvent(event) {
  const type = typeof event === 'string' ? event : event?.eventType;
  const declared = typeof event === 'object' ? event?.payload?.module : null;
  const derived = MODULE_BY_EVENT.get(type) ?? 'other';

  if (derived === 'verification') {
    return declared && MODULE_EVENT_TYPES[declared] ? declared : 'lead_capture';
  }
  if (derived === 'tasks' && declared && MODULE_EVENT_TYPES[declared]) return declared;
  return derived;
}

export function isVerificationEvent(event) {
  const type = typeof event === 'string' ? event : event?.eventType;
  return VERIFICATION_EVENT_TYPES.includes(type);
}

export const MODULE_LABEL = {
  lead_capture: 'lead capture',
  estimates: 'estimate recovery',
  reviews: 'reviews & recovery',
  memberships: 'memberships',
  installs: 'install & warranty',
  verification: 'system verification',
  tasks: 'human actions',
  other: 'other',
};

/* ── the integration boundary ──────────────────────────────
   the systems an adapter may name as the origin of a record. the ui never branches on
   these — it reads normalised records — but an operator chasing a bad row needs to know
   which system it came out of, and a value not on this list is a typo rather than a new
   vendor. */
export const SOURCE_SYSTEMS = [
  'gohighlevel',
  'jobber',
  'housecall_pro',
  'servicetitan',
  'twilio',
  'n8n',
  'manual',
  'other',
];

/* how a delivery failed, in the five words an operator would use. kept small on purpose:
   a free-text error string is unsearchable and a hundred-value enum is unmaintained. */
export const ERROR_CLASSES = [
  'auth',
  'delivery',
  'schema',
  'rate_limit',
  'timeout',
  'upstream',
  'config',
  'unknown',
];

export const ENTITY_TYPES = ['lead', 'estimate', 'job', 'review', 'membership', 'install', 'task'];

export const ACTORS = ['automation', 'human', 'system'];
