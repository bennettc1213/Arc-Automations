import { DateTime } from 'luxon';
import { getSupabase } from './supabase';
import { buildDashboardData } from './metrics';
import { EVENT_COLUMNS, toEvent } from './event-row';

/* days of history fetched. covers the 30 day window with a day of slack. */
const WINDOW_DAYS = 31;

/* postgrest caps a single response at 1000 rows regardless of the limit asked for, and
   returns success rather than an error. a naive select silently returns a truncated
   window and every metric computed from it comes out low, with nothing looking wrong.
   that is the exact failure this product exists to catch, so reads are paged. */
const PAGE_SIZE = 1000;

/* a tenant emitting more than this in 31 days needs aggregation in sql rather than a
   bigger fetch, and should not silently hang here. */
const MAX_EVENTS = 40_000;

function toTenant(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function fetchEventWindow(fetchPage, label) {
  const events = [];

  for (let from = 0; from < MAX_EVENTS; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
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
  const { data: tenantRows, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug, timezone, status, created_at')
    .limit(1);

  if (tenantError) throw new Error(`tenant read: ${tenantError.message}`);
  if (!tenantRows?.length) return { signedIn: true, data: null, email: user.email ?? null };

  const tenant = toTenant(tenantRows[0]);
  const since = DateTime.now().minus({ days: WINDOW_DAYS }).toUTC().toISO();

  // rls already scopes this to the caller's tenant, so no tenant filter is needed here.
  const events = await fetchEventWindow(
    (from, to) =>
      supabase
        .from('events')
        .select(EVENT_COLUMNS)
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: false })
        .range(from, to),
    'event read',
  );

  return {
    signedIn: true,
    email: user.email ?? null,
    data: buildDashboardData(tenant, events, DateTime.now().setZone(tenant.timezone)),
  };
}
