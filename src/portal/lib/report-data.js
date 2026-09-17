import { getSupabase } from './supabase';
import { readEvents, toEvent } from './event-row';

/* the read behind a report.
 *
 * the roster holds sixty-one days, derived and then dropped, so a report for "last
 * month" or the last ninety days cannot be built from what the console already has.
 * this reads one tenant's events for exactly the window a period asks for — the
 * period plus the equal span before it, which the comparison needs — and hands the
 * raw rows to report.js.
 *
 * paged for the reason dashboard.js pages: postgrest caps a response at 1000 rows and
 * reports success, so an unpaged read quietly truncates and every figure comes out
 * low with nothing looking wrong. past the ceiling it refuses rather than printing a
 * report built on part of the log.
 */

const PAGE_SIZE = 1000;
const MAX_EVENTS = 150_000;

function toAlert(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    checkType: row.check_type,
    severity: row.severity,
    message: row.message,
    firedAt: row.fired_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

export async function fetchReportWindow(tenantId, since, until) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('supabase is not configured');

  const sinceIso = since.toUTC().toISO();
  const untilIso = until.toUTC().toISO();
  const events = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    if (from >= MAX_EVENTS) {
      throw new Error(
        `more than ${MAX_EVENTS.toLocaleString('en-US')} events in this window — pick a shorter period.`,
      );
    }

    const { data, error } = await readEvents((columns) =>
      supabase
        .from('events')
        .select(columns)
        .eq('tenant_id', tenantId)
        .gte('occurred_at', sinceIso)
        .lt('occurred_at', untilIso)
        .order('occurred_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
    );

    if (error) throw new Error(`event read: ${error.message}`);

    const rows = data ?? [];
    events.push(...rows.map(toEvent));
    if (rows.length < PAGE_SIZE) break;
  }

  /* an incident that opened before the window and was still running inside it
     belongs on the report, so this reads back further than the events do and
     report.js keeps whatever overlaps. a failed read is not fatal: incidents are
     context, and a report that will not generate because a history table errored
     has failed at the thing it was for. the failure is returned, not swallowed. */
  const { data: alertRows, error: alertError } = await supabase
    .from('alerts')
    .select('id, tenant_id, check_type, severity, message, fired_at, acknowledged_at, resolved_at')
    .eq('tenant_id', tenantId)
    .lt('fired_at', untilIso)
    .gte('fired_at', since.minus({ days: 30 }).toUTC().toISO())
    .order('fired_at', { ascending: false })
    .limit(500);

  return {
    events,
    alerts: (alertRows ?? []).map(toAlert),
    alertError: alertError?.message ?? null,
    since,
    until,
  };
}
