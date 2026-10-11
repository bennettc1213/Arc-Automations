/* ARC-SAAS-040: the owner-facing history of one lead's actions.
 * Billing is still derived by ledger.js. This is the evidence underneath its verdict:
 * actual events, in time order, with no message bodies or contact details copied over.
 */
import { eventLabel } from './format.js';

export const LEAD_PROOF_EVENT_TYPES = new Set([
  'lead_received', 'call_missed', 'sms_sent', 'message_delivered', 'message_failed',
  'reply_received', 'lead_qualified', 'routed', 'handoff_requested',
  'owner_alerted', 'handoff_accepted', 'followup_stopped', 'lead_suppressed',
  'lead_booked', 'lead_outcome_requested', 'lead_outcome_recorded',
  'lead_dispute_settled', 'automation_completed', 'automation_failed',
]);

function proofLabel(event) {
  // A routing destination can be a phone number, and a handoff reason can contain
  // customer words. The proof line states the action without copying either one.
  if (event.eventType === 'routed') return 'lead routed to the business';
  if (event.eventType === 'handoff_requested') {
    return event.payload?.safety === true ? 'safety concern flagged and handed to a person' : 'handed to a person';
  }
  if (event.eventType === 'message_failed') return 'text could not be delivered';
  if (event.eventType === 'automation_completed') return 'sequence finished';
  return eventLabel(event.eventType, event.payload ?? {});
}

export function buildLeadProof(events) {
  const byLead = new Map();
  const seen = new Set();
  for (const event of events) {
    if (!event.correlationId || event.isCanary || !LEAD_PROOF_EVENT_TYPES.has(event.eventType)) continue;
    const identity = event.eventKey ?? event.id;
    if (identity && seen.has(`${event.correlationId}:${identity}`)) continue;
    if (identity) seen.add(`${event.correlationId}:${identity}`);
    const rows = byLead.get(event.correlationId) ?? [];
    rows.push({
      id: event.id ?? identity ?? null,
      at: event.occurredAt,
      type: event.eventType,
      label: proofLabel(event),
      status: event.status ?? 'success',
    });
    byLead.set(event.correlationId, rows);
  }
  for (const rows of byLead.values()) {
    rows.sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));
  }
  return byLead;
}
