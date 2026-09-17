import { DateTime } from 'luxon';
import { getSupabase } from './supabase';
import { buildDashboardData } from './dashboard-data';
import { EVENT_COLUMNS, EVENT_COLUMNS_BASE, toEvent } from './event-row';

/* days of history fetched. sixty-one rather than thirty-one so the portal can compare the
   last thirty days against the thirty before them — a lead count with no "up or down from
   last month" attached is the first thing a client asks about out loud. the extra day is
   slack for the boundary. */
const WINDOW_DAYS = 61;

/* postgrest caps a single response at 1000 rows regardless of the limit asked for, and
   returns success rather than an error. a naive select silently returns a truncated
   window and every metric computed from it comes out low, with nothing looking wrong.
   that is the exact failure this product exists to catch, so reads are paged. */
const PAGE_SIZE = 1000;

/* a tenant emitting more than this across the window needs aggregation in sql rather than
   a bigger fetch, and should not silently hang here. */
const MAX_EVENTS = 80_000;

/* the lifecycle columns (0009) and the tenant's module list are migration-gated. a
   deployment running the new bundle against the old schema must degrade to the pipeline it
   already had rather than showing an error page: postgrest answers an unknown column with
   a 42703, and that is a recoverable condition, not a broken dashboard. */
function isMissingColumn(error) {
  return (
    error?.code === '42703' ||
    /column .* does not exist|could not find the .* column/i.test(error?.message ?? '')
  );
}

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

function toTenant(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at,
    /* which lifecycle modules this client actually bought. absent on a pre-0009 schema,
       which reads as "nothing declared" — every module their event log proves still
       shows, and the rest stay out of the nav. */
    modules: Array.isArray(row.modules) ? row.modules : [],
    responseSlaSeconds: row.response_sla_seconds ?? null,
  };
}

const TENANT_COLUMNS = 'id, name, slug, timezone, status, created_at, modules, response_sla_seconds';
const TENANT_COLUMNS_BASE = 'id, name, slug, timezone, status, created_at';

async function fetchEventWindow(fetchPage, label) {
  const events = [];
  let columns = EVENT_COLUMNS;

  for (let from = 0; from < MAX_EVENTS; from += PAGE_SIZE) {
    let { data, error } = await fetchPage(columns, from, from + PAGE_SIZE - 1);

    /* only worth retrying on the first page: if the column set were wrong it would have
       failed there, and a mid-fetch failure is a real error. */
    if (error && from === 0 && columns === EVENT_COLUMNS && isMissingColumn(error)) {
      console.warn(
        'event read: lifecycle columns are missing — apply migration 0009. falling back to the base column set.',
      );
      columns = EVENT_COLUMNS_BASE;
      ({ data, error } = await fetchPage(columns, from, from + PAGE_SIZE - 1));
    }

    if (error) throw new Error(`${label}: ${error.message}`);

    const rows = data ?? [];
    events.push(...rows.map(toEvent));
    if (rows.length < PAGE_SIZE) break;
  }

  return events;
}

/* dashboard for the signed-in user's tenant. null when not signed in or attached to no
   tenant — the caller renders a different state for each. */
export async function getDashboardForUser() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('supabase is not configured');

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { signedIn: false, data: null, email: null };

  // rls restricts this to tenants the user is a member of.
  let { data: tenantRows, error: tenantError } = await supabase
    .from('tenants')
    .select(TENANT_COLUMNS)
    .limit(1);

  if (tenantError && isMissingColumn(tenantError)) {
    ({ data: tenantRows, error: tenantError } = await supabase
      .from('tenants')
      .select(TENANT_COLUMNS_BASE)
      .limit(1));
  }

  if (tenantError) throw new Error(`tenant read: ${tenantError.message}`);
  if (!tenantRows?.length) return { signedIn: true, data: null, email: user.email ?? null };

  const tenant = toTenant(tenantRows[0]);
  const since = DateTime.now().minus({ days: WINDOW_DAYS }).toUTC().toISO();

  // rls already scopes this to the caller's tenant, so no tenant filter is needed here.
  const events = await fetchEventWindow(
    (columns, from, to) =>
      supabase
        .from('events')
        .select(columns)
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: false })
        .range(from, to),
    'event read',
  );

  /* alerts are the only mutable table in the schema and the only place the human timeline
     of an incident lives — detected, acknowledged, resolved. a failed read here must not
     take the whole dashboard down with it: the incident list is context, the numbers are
     the product, and a client whose portal will not load because a history panel errored
     has been failed twice. */
  const { data: alertRows, error: alertError } = await supabase
    .from('alerts')
    .select('id, tenant_id, check_type, severity, message, fired_at, acknowledged_at, resolved_at')
    .gte('fired_at', since)
    .order('fired_at', { ascending: false })
    .limit(200);

  if (alertError) console.warn(`alert read failed, continuing without: ${alertError.message}`);

  return {
    signedIn: true,
    email: user.email ?? null,
    data: buildDashboardData(
      tenant,
      events,
      DateTime.now().setZone(tenant.timezone),
      (alertRows ?? []).map(toAlert),
    ),
  };
}
