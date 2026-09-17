/* the raw run log, across every module, safe to put on a screen.
 *
 * the activity page is the one somebody opens when a customer says nobody called them back,
 * so it has to be flat, complete and boring — a log that summarises cannot be used as
 * evidence. but it is also the surface most likely to be screenshotted into a group chat or
 * shoulder-read in a van, and an event payload is written by a workflow author who was
 * thinking about making the automation work rather than about what ends up on a screen.
 *
 * so every payload goes through `safeMeta` before it is rendered. two categories never make
 * it out: anything that looks like a credential, and the customer contact details that the
 * record tables already carry in their own right. what is left is the diagnostic metadata
 * the log exists for — stages, classifications, counts, reasons, ids.
 *
 * this is a denylist, which is the weaker of the two designs. an allowlist would be safer
 * and would also silently drop the field a new workflow needs in order to be debuggable, so
 * the trade is deliberate: the patterns below cover both categories generously, values are
 * truncated, and nothing nested is walked.
 */

import { CLIENT_FACING_EVENT_TYPES, MODULE_LABEL, VERIFICATION_EVENT_TYPES, moduleForEvent } from './types.js';
import { eventLabel } from './format.js';

/* credentials. these must never reach a browser under any circumstances — not masked, not
   truncated, not behind a disclosure. */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|auth|bearer|signature|credential|private[-_]?key|access[-_]?key|session)/i;

/* customer contact details. not a leak in the same sense — the client owns them and the
   record tables show them — but a run log does not need them to be a run log, and the
   fewer surfaces carry them the fewer there are to get wrong. */
const CONTACT_KEY = /^(phone|phone_number|mobile|email|to|from|address|street|caller|customer|contact|name|body|text|message|review_text|draft_response|note|notes)$/i;

const MAX_VALUE_LEN = 80;
const MAX_KEYS = 6;

export function safeMeta(payload = {}) {
  const out = [];

  for (const [key, value] of Object.entries(payload)) {
    if (out.length >= MAX_KEYS) break;
    if (SECRET_KEY.test(key) || CONTACT_KEY.test(key)) continue;
    if (value === null || value === undefined || value === '') continue;

    /* objects and arrays are summarised rather than walked. a nested structure is where a
       credential hides from a top-level key check, and a run log does not need to render
       one to be useful. */
    if (typeof value === 'object') {
      out.push([key, Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}` : '…']);
      continue;
    }

    const text = String(value);
    out.push([key, text.length > MAX_VALUE_LEN ? `${text.slice(0, MAX_VALUE_LEN)}…` : text]);
  }

  return out;
}

export const ACTIVITY_GROUPS = [
  { key: 'all', label: 'everything' },
  { key: 'lead_capture', label: MODULE_LABEL.lead_capture },
  { key: 'estimates', label: MODULE_LABEL.estimates },
  { key: 'reviews', label: MODULE_LABEL.reviews },
  { key: 'memberships', label: MODULE_LABEL.memberships },
  { key: 'installs', label: MODULE_LABEL.installs },
  { key: 'failures', label: 'failures' },
  { key: 'human', label: 'human actions' },
  { key: 'verification', label: 'system checks' },
];

/* the shape a row in the activity table reads from. every field §11 of the event contract
   asks to be preserved is here except `tenant_id`, which is deliberately not shipped to the
   browser: every row the client can see is already theirs by rls, and printing the id only
   invites somebody to try another one. */
function toRow(event) {
  const module = moduleForEvent(event);
  const isVerification = VERIFICATION_EVENT_TYPES.includes(event.eventType);

  return {
    id: event.id,
    at: event.occurredAt,
    recordedAt: event.recordedAt ?? null,
    module,
    moduleLabel: MODULE_LABEL[module] ?? module,
    type: event.eventType,
    label: isVerification
      ? event.eventType.replace(/_/g, ' ')
      : eventLabel(event.eventType, event.payload ?? {}),
    status: event.status,
    failed: event.status === 'failure',
    isVerification,
    entityType: event.entityType ?? event.payload?.entity_type ?? null,
    entityId: event.entityId ?? event.payload?.entity_id ?? null,
    sourceSystem: event.sourceSystem ?? null,
    externalId: event.externalId ?? null,
    workflowId: event.workflowId ?? null,
    executionId: event.executionId ?? null,
    correlationId: event.correlationId ?? null,
    idempotencyKey: event.eventKey ?? null,
    latencyMs: event.latencyMs ?? null,
    actor: event.actor ?? (isVerification ? 'system' : 'automation'),
    errorClass: event.errorClass ?? event.payload?.error_class ?? null,
    meta: safeMeta(event.payload ?? {}),
  };
}

export function buildActivity(events, limit = 400) {
  const client = [];
  const verification = [];

  for (const event of events) {
    if (CLIENT_FACING_EVENT_TYPES.includes(event.eventType) && !event.isCanary) {
      client.push(event);
    } else if (VERIFICATION_EVENT_TYPES.includes(event.eventType)) {
      verification.push(event);
    }
  }

  const newestFirst = (a, b) => b.occurredAt.localeCompare(a.occurredAt);
  client.sort(newestFirst);
  verification.sort(newestFirst);

  /* the two streams are capped separately. merged and capped once, a chatty hourly canary
     would push a week of business events off the end of the list, and the business events
     are what the page is for. */
  return {
    rows: client.slice(0, limit).map(toRow),
    verification: verification.slice(0, Math.round(limit / 4)).map(toRow),
    total: client.length,
    verificationTotal: verification.length,
  };
}

export function matchesGroup(row, group) {
  if (group === 'all') return !row.isVerification;
  if (group === 'failures') return row.failed;
  if (group === 'human') return row.actor === 'human';
  if (group === 'verification') return row.isVerification;
  return row.module === group && !row.isVerification;
}
