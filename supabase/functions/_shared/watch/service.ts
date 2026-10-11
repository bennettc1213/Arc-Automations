/**
 * The check that looks when nobody has a page open (ARC-GO-330).
 *
 * Once an hour the dispatcher's second schedule asks one question of every client module
 * that is live: has anything arrived lately? `model.ts` answers it. This file reads the
 * facts, and when the answer is "quiet" it raises one alert in `alerts`, the table the
 * console's alerts page and the client's reliability page already read.
 *
 * What it does not do, on purpose:
 *
 *   - it writes no event. Quiet is already derived from the log by the portal; a row saying
 *     so would be a second copy of a fact the log holds.
 *   - it raises once. 0001 allows one open alert per client and kind, and a person resolves
 *     it. Arrivals starting again do not close it: an incident nobody looked at must not
 *     vanish.
 *   - it touches no lifecycle, no health overlay and no queue. A quiet client's next call is
 *     handled exactly as before.
 *   - it pages nobody. The alert waits on the console's alerts page.
 *
 * One client's failed read is that client's line in the report, never the end of the run.
 */

import {
  ARRIVAL_EVENT_TYPES,
  QUIET_CHECK_TYPE,
  QUIET_SEVERITY,
  quietAfterHours,
  quietMessage,
  quietVerdict,
  type QuietKind,
} from './model.ts';

export interface WatchedModule {
  tenantId: string;
  moduleKey: string;
  /** when the module last went live. */
  activeSince: string | null;
  timezone: string | null;
}

export interface WatchReads {
  /** every module that is live right now, for clients that have not left. */
  liveModules(): Promise<WatchedModule[]>;
  /** the newest real arrival of these types for this client, or null. never a canary's. */
  lastArrival(tenantId: string, eventTypes: readonly string[]): Promise<string | null>;
  /** raise it once: false when an alert of this kind is already open for the client. */
  raise(alert: { tenantId: string; checkType: string; severity: string; message: string }): Promise<boolean>;
}

export interface QuietResult {
  tenantId: string;
  moduleKey: string;
  kind: QuietKind | 'unwatched' | 'unread';
  hours: number | null;
  raised: boolean;
}

export interface QuietReport {
  checked: number;
  quiet: number;
  raised: number;
  /** clients whose facts could not be read this time. nothing was decided about them. */
  unread: number;
  results: QuietResult[];
}

export async function runQuietCheck(deps: { reads: WatchReads; now: () => Date }): Promise<QuietReport> {
  const modules = await deps.reads.liveModules();
  const results: QuietResult[] = [];

  for (const watched of modules) {
    const base = { tenantId: watched.tenantId, moduleKey: watched.moduleKey };
    const window = quietAfterHours(watched.moduleKey);
    if (window === null) {
      results.push({ ...base, kind: 'unwatched', hours: null, raised: false });
      continue;
    }
    try {
      const lastArrivalAt = await deps.reads.lastArrival(watched.tenantId, ARRIVAL_EVENT_TYPES[watched.moduleKey]);
      const verdict = quietVerdict({ now: deps.now(), activeSince: watched.activeSince, lastArrivalAt, quietAfterHours: window });
      const message = quietMessage(verdict, { timezone: watched.timezone });
      const raised = message
        ? await deps.reads.raise({ tenantId: watched.tenantId, checkType: QUIET_CHECK_TYPE, severity: QUIET_SEVERITY, message })
        : false;
      results.push({ ...base, kind: verdict.kind, hours: Math.round(verdict.hours), raised });
    } catch {
      results.push({ ...base, kind: 'unread', hours: null, raised: false });
    }
  }

  return {
    checked: results.filter((row) => row.kind !== 'unwatched' && row.kind !== 'unread').length,
    quiet: results.filter((row) => row.kind === 'quiet' || row.kind === 'never_arrived').length,
    raised: results.filter((row) => row.raised).length,
    unread: results.filter((row) => row.kind === 'unread').length,
    results,
  };
}

/* ── the Supabase reads ───────────────────────────────────── */

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

/** A client that has left is not watched: nothing is expected to arrive. */
const WATCHED_TENANT_STATUSES = ['onboarding', 'active'];

export function supabaseWatchReads(db: Db): WatchReads {
  return {
    async liveModules() {
      const { data: live, error } = await db.from('tenant_modules').select('tenant_id, module_key, updated_at').eq('state', 'active');
      if (error) throw new Error(`could not read the live modules: ${error.message}`);
      const rows = (live ?? []) as { tenant_id: string; module_key: string; updated_at: string }[];
      if (rows.length === 0) return [];

      const { data: tenants, error: tenantError } = await db
        .from('tenants')
        .select('id, status, timezone')
        .in('id', [...new Set(rows.map((row) => row.tenant_id))]);
      if (tenantError) throw new Error(`could not read the clients: ${tenantError.message}`);
      const byId = new Map(((tenants ?? []) as { id: string; status: string; timezone: string | null }[]).map((row) => [row.id, row]));

      const watched: WatchedModule[] = [];
      for (const row of rows) {
        const tenant = byId.get(row.tenant_id);
        if (!tenant || !WATCHED_TENANT_STATUSES.includes(tenant.status)) continue;
        /* the lifecycle's own history says when it last went live. `updated_at` moves for
           other reasons, so it is only the fallback. */
        const { data: wentLive, error: historyError } = await db
          .from('tenant_module_transitions')
          .select('occurred_at')
          .eq('tenant_id', row.tenant_id)
          .eq('module_key', row.module_key)
          .eq('to_state', 'active')
          .order('occurred_at', { ascending: false })
          .limit(1);
        if (historyError) throw new Error(`could not read the lifecycle history: ${historyError.message}`);
        const at = (wentLive ?? [])[0]?.occurred_at ?? row.updated_at ?? null;
        watched.push({
          tenantId: row.tenant_id,
          moduleKey: row.module_key,
          activeSince: at ? new Date(at).toISOString() : null,
          timezone: tenant.timezone ?? null,
        });
      }
      return watched;
    },

    async lastArrival(tenantId, eventTypes) {
      const { data, error } = await db
        .from('events')
        .select('occurred_at')
        .eq('tenant_id', tenantId)
        .eq('is_canary', false)
        .eq('status', 'success')
        .in('event_type', [...eventTypes])
        .order('occurred_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(`could not read the last arrival: ${error.message}`);
      const at = (data ?? [])[0]?.occurred_at ?? null;
      return at ? new Date(at).toISOString() : null;
    },

    async raise(alert) {
      const { data: open, error: openError } = await db
        .from('alerts')
        .select('id')
        .eq('tenant_id', alert.tenantId)
        .eq('check_type', alert.checkType)
        .is('resolved_at', null)
        .limit(1);
      if (openError) throw new Error(`could not read the open alerts: ${openError.message}`);
      if ((open ?? []).length > 0) return false;

      const { error } = await db
        .from('alerts')
        .insert({ tenant_id: alert.tenantId, check_type: alert.checkType, severity: alert.severity, message: alert.message })
        .select('id');
      /* two runs at once: 0001's unique index lets one through. the other raised nothing. */
      if (error?.code === '23505') return false;
      if (error) throw new Error(`could not raise the alert: ${error.message}`);
      return true;
    },
  };
}
