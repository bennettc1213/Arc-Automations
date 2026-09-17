/* database row shape and its mapping to the app's event shape.
   its own module because both paths need it: the paged read and the realtime
   subscription, which receives raw postgres rows. if these two mapped differently, a
   live-inserted event would render differently from the same event after a refresh.

   the second group of columns arrived with the lifecycle modules (migration 0009) and is
   nullable throughout: every row written before it existed reads as nulls, and every
   derivation falls back to the payload or the correlation id for exactly that reason. an
   event's *module* is deliberately not among them — it is derived from `event_type`, so it
   cannot drift from the type sitting next to it. */

/* the column set before migration 0009. kept as its own export so a bundle deployed ahead
   of the migration degrades to the pipeline it already had instead of erroring — see the
   fallback in dashboard.js. */
export const EVENT_COLUMNS_BASE =
  'id, tenant_id, event_type, workflow_id, execution_id, correlation_id, status, payload, latency_ms, is_canary, occurred_at, created_at, event_key';

export const EVENT_COLUMNS = `${EVENT_COLUMNS_BASE}, entity_type, entity_id, source_system, external_id, actor, error_class`;

export function toEvent(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    status: row.status,
    payload: row.payload ?? {},
    latencyMs: row.latency_ms,
    isCanary: row.is_canary,
    occurredAt: row.occurred_at,
    /* when we recorded it, as against when it happened. the gap between the two is how a
       replayed backlog is told apart from a live one. */
    recordedAt: row.created_at ?? null,
    eventKey: row.event_key,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    sourceSystem: row.source_system ?? null,
    externalId: row.external_id ?? null,
    actor: row.actor ?? null,
    errorClass: row.error_class ?? null,
  };
}
