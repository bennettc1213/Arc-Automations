/* what a client actually has, and how to say so when they do not have it.
 *
 * the rule this file exists to enforce: a module that is not wired up must never render as
 * a page full of zeros. zero is a fact about a working pipeline — "nobody called yesterday"
 * — and printing it for a pipeline that was never connected is the most expensive kind of
 * quiet wrongness this portal can produce, because it is indistinguishable from the truth
 * until somebody asks.
 *
 * so availability is a three-way answer, decided from two independent sources:
 *
 *   declared   the tenant's `modules` list, set by an operator when the work is sold.
 *   observed   at least one real event of that module's types in the fetched window.
 *
 *   declared + observed    → live          render the numbers
 *   declared + none        → awaiting      render the page, say it is not connected yet
 *   none     + observed    → live          observation always wins; never hide real data
 *   none     + none        → unavailable   the page does not exist for this client
 *
 * observation beating declaration is deliberate. a missing declaration is an operator
 * oversight, and an oversight must not be able to hide a client's own data from them.
 */

import { MODULE_EVENT_TYPES, MODULES, moduleForEvent } from './types.js';
import {
  canonicalModuleKey,
  isSelectable,
  modulesInPortalOrder,
} from '../../../supabase/functions/_shared/registry/modules.ts';
import { utc } from './metrics.js';

/* per-module presentation, derived from the module registry rather than declared here.
 *
 * This used to be a hand-written object, and it was one of the two module vocabularies
 * the repository audit found: the portal knew `lead_capture` / `estimates` / `reviews` /
 * `memberships` / `installs` while the execution engine knew only `lead_recovery`, and
 * nothing reconciled them. The registry is now the single source
 * (`supabase/functions/_shared/registry/modules.ts`) and this is a projection of it.
 *
 * Still keyed by the **event-module key** (`lead_capture`, not `lead_recovery`), because
 * that is what `tenants.modules` stores, what `moduleForEvent` derives, and what every
 * historical event row already says. The canonical key is reachable through
 * `canonicalModuleKey()` when a caller needs it; nothing stored is renamed.
 *
 * `quietAfterHours` is the one number here that is a judgement rather than a count: how
 * long a module may go silent before the portal says so. These differ by an order of
 * magnitude between modules and a single flat threshold would be wrong for all of them —
 * lead capture going quiet for two days is an outage, warranty registration going quiet
 * for two days is a tuesday.
 */
export const MODULE_META = Object.freeze(Object.fromEntries(
  modulesInPortalOrder().map((module) => [
    module.eventModuleKey,
    Object.freeze({
      key: module.eventModuleKey,
      canonicalKey: module.key,
      routeKey: module.portal.routeKey,
      label: module.portal.label,
      nav: module.portal.navLabel,
      icon: module.portal.icon,
      blurb: module.portal.blurb,
      entity: module.portal.entity,
      quietAfterHours: module.portal.quietAfterHours,
      awaiting: module.portal.awaiting,
      /* whether ARC runs this module, as opposed to reporting on events somebody else
         posts. false for the four observation-only modules, and the reason the portal
         must never offer to switch one of them on. */
      selectable: isSelectable(module.key),
    }),
  ]),
));

/* the tenant column is text[] and arrives from postgrest as an array, but a tenant row
   written before the column existed reads as null. treated as "nothing declared" rather
   than as an error, because a client whose operator has not filled this in yet still gets
   every module their event log proves. */
export function declaredModules(tenant) {
  const raw = tenant?.modules;
  if (!Array.isArray(raw)) return [];
  return raw.filter((key) => MODULES.includes(key));
}

/* lead capture is the product's floor. every client has it — it is what they bought first
   and it is what the ingest pipeline is for — so it is never "unavailable", only quiet. */
const ALWAYS_ON = ['lead_capture'];

export function computeModuleAvailability(tenant, events, now) {
  const declared = new Set([...declaredModules(tenant), ...ALWAYS_ON]);

  const observed = new Map();
  for (const event of events) {
    if (event.isCanary) continue;
    const key = moduleForEvent(event);
    if (!MODULE_EVENT_TYPES[key]) continue;
    /* a task or a verification row resolves to a module, but neither one is evidence that
       the module's own pipeline ran. "observed" has to mean the business events. */
    if (!MODULE_EVENT_TYPES[key].includes(event.eventType)) continue;

    const row = observed.get(key) ?? { count: 0, firstAt: null, lastAt: null, lastOkAt: null };
    row.count++;
    if (row.firstAt === null || event.occurredAt < row.firstAt) row.firstAt = event.occurredAt;
    if (row.lastAt === null || event.occurredAt > row.lastAt) row.lastAt = event.occurredAt;
    if (event.status !== 'failure' && (row.lastOkAt === null || event.occurredAt > row.lastOkAt)) {
      row.lastOkAt = event.occurredAt;
    }
    observed.set(key, row);
  }

  const result = {};
  for (const key of MODULES) {
    const meta = MODULE_META[key];
    const seen = observed.get(key) ?? null;
    const isDeclared = declared.has(key);
    const state = seen ? 'live' : isDeclared ? 'awaiting' : 'unavailable';

    result[key] = {
      ...meta,
      state,
      declared: isDeclared,
      observed: Boolean(seen),
      events: seen?.count ?? 0,
      firstEventAt: seen?.firstAt ?? null,
      lastEventAt: seen?.lastAt ?? null,
      lastSuccessAt: seen?.lastOkAt ?? null,
      /* measured against the module's own tolerance, not a shared one. */
      quietHours:
        seen?.lastOkAt && now ? Math.max(0, now.diff(utc(seen.lastOkAt), 'hours').hours) : null,
      isQuiet:
        seen?.lastOkAt && now
          ? now.diff(utc(seen.lastOkAt), 'hours').hours > meta.quietAfterHours
          : false,
      available: state !== 'unavailable',
      live: state === 'live',
    };
  }

  return result;
}

/* the single question every metric on a module page has to pass before it prints a number.
   a figure whose module is not live is not zero — it is unknown, and the ui renders the
   reason instead. */
export function isLive(availability, key) {
  return availability?.[key]?.state === 'live';
}

export const MODULE_ORDER = MODULES;

/* the compatibility boundary, re-exported so portal code has one import site for it.
   a route param, a `tenants.modules` value and an event's derived bucket are all
   accepted spellings; everything downstream of this call works in canonical keys. */
export { canonicalModuleKey };
