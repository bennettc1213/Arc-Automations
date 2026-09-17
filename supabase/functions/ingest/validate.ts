/**
 * The validation seam.
 *
 * n8n posts here rather than writing to the database directly, and this is the reason why:
 * one versioned place that rejects a malformed payload at the door. Schema drift upstream —
 * a renamed form field, a changed webhook shape — is the documented way this pipeline dies
 * quietly, so a bad payload must produce a loud 400 rather than a row full of nulls that
 * reads as a healthy event.
 */

export const EVENT_TYPES = [
  // lead capture
  'lead_received',
  'call_missed',
  'sms_sent',
  'routed',
  'reply_received',
  'lead_qualified',
  'handoff_requested',
  // estimate recovery
  'estimate_created',
  'estimate_followup_sent',
  'estimate_reply_received',
  'estimate_decision',
  'estimate_suppressed',
  // reviews & service recovery
  'job_completed',
  'review_request_sent',
  'review_received',
  'review_response_published',
  'service_recovery_opened',
  'service_recovery_resolved',
  // memberships
  'membership_recorded',
  'membership_payment_failed',
  'membership_payment_recovered',
  'membership_visit_due',
  'membership_visit_booked',
  'membership_cancellation_requested',
  // install & warranty
  'install_completed',
  'install_closeout_updated',
  'warranty_registration_submitted',
  'warranty_registration_verified',
  'warranty_registration_blocked',
  // cross-cutting human tasks
  'task_opened',
  'task_resolved',
  // verification
  'canary_expectation',
  'canary_check',
  'watermark_check',
  'schema_assert',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/* The lifecycle metadata (migration 0009). Every field is optional: the lead pipeline has
   posted here for two years without any of them and must keep working unchanged. What they
   buy is a contract at the door rather than a convention inside a jsonb blob — a workflow
   sending `source_system: "jobbr"` finds out here, once, instead of producing rows that
   quietly never match anything. */
export const ENTITY_TYPES = [
  'lead',
  'estimate',
  'job',
  'review',
  'membership',
  'install',
  'task',
] as const;

export const SOURCE_SYSTEMS = [
  'gohighlevel',
  'jobber',
  'housecall_pro',
  'servicetitan',
  'twilio',
  'n8n',
  'manual',
  'other',
] as const;

export const ACTORS = ['automation', 'human', 'system'] as const;

export const ERROR_CLASSES = [
  'auth',
  'delivery',
  'schema',
  'rate_limit',
  'timeout',
  'upstream',
  'config',
  'unknown',
] as const;

export interface IncomingEvent {
  event_type: EventType;
  occurred_at: string;
  status: 'success' | 'failure';
  correlation_id: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  latency_ms: number | null;
  is_canary: boolean;
  payload: Record<string, unknown>;
  event_key: string | null;
  entity_type: string | null;
  entity_id: string | null;
  source_system: string | null;
  external_id: string | null;
  actor: string | null;
  error_class: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounds the payload so one runaway n8n node cannot fill the table. */
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_STRING_LEN = 512;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(value: unknown, field: string, errors: string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return null;
  }
  if (value.length > MAX_STRING_LEN) {
    errors.push(`${field} exceeds ${MAX_STRING_LEN} characters`);
    return null;
  }
  return value;
}

export type ValidationResult =
  | { ok: true; event: IncomingEvent }
  | { ok: false; errors: string[] };

export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const eventType = input.event_type;
  if (typeof eventType !== 'string') {
    errors.push('event_type is required');
  } else if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
    errors.push(
      `event_type "${eventType}" is not recognised. Known types: ${EVENT_TYPES.join(', ')}`,
    );
  }

  /* occurred_at is required, never defaulted to now(). A retry replaying an hour-old event
     must land on its real timestamp or the timeline lies. */
  const occurredAtRaw = input.occurred_at;
  let occurredAt = '';
  if (typeof occurredAtRaw !== 'string') {
    errors.push('occurred_at is required and must be an ISO 8601 string');
  } else {
    const parsed = new Date(occurredAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      errors.push(`occurred_at "${occurredAtRaw}" is not a valid date`);
    } else {
      occurredAt = parsed.toISOString();
    }
  }

  const statusRaw = input.status ?? 'success';
  if (statusRaw !== 'success' && statusRaw !== 'failure') {
    errors.push('status must be "success" or "failure"');
  }

  const correlationId = optionalString(input.correlation_id, 'correlation_id', errors);
  if (correlationId !== null && !UUID_RE.test(correlationId)) {
    errors.push('correlation_id must be a UUID');
  }

  const workflowId = optionalString(input.workflow_id, 'workflow_id', errors);
  const executionId = optionalString(input.execution_id, 'execution_id', errors);
  const eventKey = optionalString(input.event_key, 'event_key', errors);

  let latencyMs: number | null = null;
  if (input.latency_ms !== undefined && input.latency_ms !== null) {
    if (
      typeof input.latency_ms !== 'number' ||
      !Number.isFinite(input.latency_ms) ||
      input.latency_ms < 0
    ) {
      errors.push('latency_ms must be a non-negative number');
    } else {
      latencyMs = Math.round(input.latency_ms);
    }
  }

  const isCanaryRaw = input.is_canary ?? false;
  if (typeof isCanaryRaw !== 'boolean') {
    errors.push('is_canary must be a boolean');
  }

  let payload: Record<string, unknown> = {};
  if (input.payload !== undefined && input.payload !== null) {
    if (!isPlainObject(input.payload)) {
      errors.push('payload must be a JSON object');
    } else if (JSON.stringify(input.payload).length > MAX_PAYLOAD_BYTES) {
      errors.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    } else {
      payload = input.payload;
    }
  }

  /* the lifecycle metadata. `entity_id` is free-form on purpose — it carries whatever
     identifies the record in the client's own system, and forcing a uuid on it would mean
     every adapter inventing a mapping table to satisfy us. */
  const entityId = optionalString(input.entity_id, 'entity_id', errors);
  const externalId = optionalString(input.external_id, 'external_id', errors);

  const oneOf = (
    value: unknown,
    allowed: readonly string[],
    field: string,
  ): string | null => {
    const parsed = optionalString(value, field, errors);
    if (parsed !== null && !allowed.includes(parsed)) {
      errors.push(`${field} "${parsed}" is not recognised. Known values: ${allowed.join(', ')}`);
      return null;
    }
    return parsed;
  };

  const entityType = oneOf(input.entity_type, ENTITY_TYPES, 'entity_type');
  const sourceSystem = oneOf(input.source_system, SOURCE_SYSTEMS, 'source_system');
  const actor = oneOf(input.actor, ACTORS, 'actor');
  const errorClass = oneOf(input.error_class, ERROR_CLASSES, 'error_class');

  /* an event carrying an entity type but no id cannot be folded into a record, and would
     land as a row that no page will ever show. that is the silent-wrongness failure mode
     this whole boundary exists to make loud. */
  if (entityType !== null && entityId === null) {
    errors.push('entity_type was given without entity_id — the record could not be identified');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    event: {
      event_type: eventType as EventType,
      occurred_at: occurredAt,
      status: statusRaw as 'success' | 'failure',
      correlation_id: correlationId,
      workflow_id: workflowId,
      execution_id: executionId,
      latency_ms: latencyMs,
      is_canary: isCanaryRaw as boolean,
      payload,
      event_key: eventKey,
      entity_type: entityType,
      entity_id: entityId,
      source_system: sourceSystem,
      external_id: externalId,
      /* an event with no stated actor came from a workflow. a human action has to say so,
         because the reviews module treats "approved by a person" as a claim that needs
         evidence rather than a default. */
      actor: actor ?? (eventType === 'task_resolved' ? null : 'automation'),
      error_class: errorClass ?? (statusRaw === 'failure' ? 'unknown' : null),
    },
  };
}

/** Accepts one event or a batch. Batches keep n8n from making a call per row. */
export const MAX_BATCH = 200;

export function validateBody(
  body: unknown,
): { ok: true; events: IncomingEvent[] } | { ok: false; errors: string[] } {
  const items = isPlainObject(body) && Array.isArray(body.events) ? body.events : [body];

  if (items.length === 0) return { ok: false, errors: ['no events in request'] };
  if (items.length > MAX_BATCH) {
    return { ok: false, errors: [`batch exceeds ${MAX_BATCH} events`] };
  }

  const events: IncomingEvent[] = [];
  const errors: string[] = [];

  items.forEach((item, i) => {
    const result = validateEvent(item);
    if (result.ok) events.push(result.event);
    else errors.push(...result.errors.map((e) => `events[${i}]: ${e}`));
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, events };
}
