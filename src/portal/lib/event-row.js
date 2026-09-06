/* database row shape and its mapping to the app's event shape.
   its own module because both paths need it: the paged read and the realtime
   subscription, which receives raw postgres rows. if these two mapped differently, a
   live-inserted event would render differently from the same event after a refresh. */

export const EVENT_COLUMNS =
  'id, tenant_id, event_type, workflow_id, execution_id, correlation_id, status, payload, latency_ms, is_canary, occurred_at, event_key';

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
    eventKey: row.event_key,
  };
}
