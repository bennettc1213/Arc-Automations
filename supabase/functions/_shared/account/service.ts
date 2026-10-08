/**
 * ARC-MK-200 — reading a client's own settings, for the owner portal's Account screen.
 *
 * One read, no write. The configuration comes through `resolveEffectiveConfig` — the same
 * call the engine makes — so the screen shows the versions that are actually in force, never
 * a draft and never the frozen legacy column. The do-not-contact list is `suppressions`,
 * read by reference: this is not a second list.
 *
 * Who may ask: a signed-in member of the tenant, whose membership the calling function read
 * from `tenant_members`, or an operator. Anyone else is refused before anything is read.
 *
 * A client with nothing published is not an error — it is an answer. The view comes back
 * `available: false` with the reason, and the page prints a dash and that reason.
 */

import type { ConfigStore } from '../config/store.ts';
import { resolveEffectiveConfig } from '../config/engine.ts';
import {
  accountSettingsView,
  STOP_LIST_SHOWN,
  type AccountSettingsUnavailable,
  type AccountSettingsView,
  type StopListRow,
} from './model.ts';

export const ACCOUNT_MODULE_KEY = 'lead_recovery';

export type AccountActor =
  | { kind: 'operator'; userId: string }
  | { kind: 'client_user'; userId: string; tenantId: string; role?: string }
  | { kind: string; [key: string]: unknown };

export interface AccountDeps {
  config: ConfigStore;
  /** the newest rows of the tenant's do-not-contact list, and the true count. */
  stopList(tenantId: string, limit: number): Promise<{ rows: StopListRow[]; total: number }>;
}

export type AccountOutcome =
  | { ok: true; result: AccountSettingsView | AccountSettingsUnavailable }
  | { ok: false; code: 'unauthorized' | 'forbidden' | 'invalid'; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACCOUNT_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({ unauthorized: 401, forbidden: 403, invalid: 422 });

export async function readAccountSettings(deps: AccountDeps, actor: AccountActor | null, tenantId: unknown): Promise<AccountOutcome> {
  if (!actor) return { ok: false, code: 'unauthorized', message: 'not signed in' };
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return { ok: false, code: 'invalid', message: 'tenant_id is required' };
  const allowed = actor.kind === 'operator' || (actor.kind === 'client_user' && actor.tenantId === tenantId);
  if (!allowed) return { ok: false, code: 'forbidden', message: 'this account does not belong to that client' };

  const resolved = await resolveEffectiveConfig(deps.config, tenantId, ACCOUNT_MODULE_KEY);
  if (!resolved.ok) {
    return {
      ok: true,
      result: { available: false, reason: 'your settings have not been entered yet. we set them up with you before anything is switched on.' },
    };
  }

  const stop = await deps.stopList(tenantId, STOP_LIST_SHOWN);
  return {
    ok: true,
    result: accountSettingsView(resolved.config, stop.rows, {
      tenantVersion: resolved.tenantVersion.version,
      moduleVersion: resolved.moduleVersion.version,
      stopTotal: stop.total,
    }),
  };
}

/** the Supabase read behind `stopList`. unexpired rows only: an expired block no longer stops anything. */
export function supabaseStopList(db: { from(table: string): any }, now: () => Date = () => new Date()) {
  return async (tenantId: string, limit: number): Promise<{ rows: StopListRow[]; total: number }> => {
    const { data, error, count } = await db
      .from('suppressions')
      .select('channel, address, reason, created_at, expires_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .or(`expires_at.is.null,expires_at.gt.${now().toISOString()}`)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`stop list read: ${error.message}`);
    const rows = (data ?? []) as StopListRow[];
    return { rows, total: typeof count === 'number' ? count : rows.length };
  };
}
