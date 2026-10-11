/**
 * Whether a live client has gone quiet (ARC-GO-330).
 *
 * The portal has always been able to say "nothing has come through for 60 hours": health.js
 * works it out from the event log on every read. What it could not do is say so when nobody
 * has a page open. For a business that forwards its unanswered calls to ARC, the likeliest
 * failure is the forwarding being switched off at the phone company: no call reaches ARC,
 * nothing fails, nothing is logged, and every screen stays calm. So something has to look.
 *
 * This file is the rule, and only the rule. It takes plain facts and stores nothing, so the
 * check, its tests and the console's own words are the same definition:
 *
 *   - **an arrival** is something that came in from outside: a call, a form, a customer's
 *     reply. A text ARC sent does not count. A follow-up going out says nothing about the
 *     line.
 *   - **the clock** starts at the last arrival, or at the moment the module last went live
 *     if that is later. A client switched on yesterday is not two days quiet.
 *   - **how long is too long** is the registry's `quietAfterHours`, the number the portal's
 *     own health already uses.
 *
 * Quiet is not broken. A slow week reads the same as a dead line from here, which is why the
 * alert says both, raises once, and is closed by a person. It changes nothing about whether
 * the module may act: a call that does arrive is answered exactly as before.
 *
 * Portal-safe: imports the registry and nothing else.
 */

import { getModule } from '../registry/modules.ts';

/** `alerts.check_type` (0001): expected volume did not arrive in the window. */
export const QUIET_CHECK_TYPE = 'watermark';
export const QUIET_SEVERITY = 'warning';

/** What "something reached ARC" means, for each module ARC runs. A module not listed is not watched. */
export const ARRIVAL_EVENT_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lead_recovery: Object.freeze(['call_missed', 'lead_received', 'call_answered', 'reply_received']),
});

/** Hours without an arrival before a live module is called quiet, or null when it is not watched. */
export function quietAfterHours(moduleKey: string): number | null {
  if (!ARRIVAL_EVENT_TYPES[moduleKey]) return null;
  const hours = getModule(moduleKey)?.portal.quietAfterHours;
  return typeof hours === 'number' && hours > 0 ? hours : null;
}

/**
 *   arriving        something came in inside the window
 *   not_yet         live for less than the window, and nothing has come in yet
 *   quiet           arrivals stopped
 *   never_arrived   live for longer than the window and nothing has come in since it went live
 */
export type QuietKind = 'arriving' | 'not_yet' | 'quiet' | 'never_arrived';

export interface QuietVerdict {
  kind: QuietKind;
  quiet: boolean;
  /** where the clock started: the last arrival, or when the module went live. */
  since: string | null;
  hours: number;
}

export function quietVerdict(input: {
  now: Date;
  /** when the module last went live. */
  activeSince: string | null;
  lastArrivalAt: string | null;
  quietAfterHours: number;
}): QuietVerdict {
  const live = Date.parse(input.activeSince ?? '');
  const arrived = Date.parse(input.lastArrivalAt ?? '');
  /* a module nobody can date is not accused of anything. */
  if (Number.isNaN(live)) return { kind: 'not_yet', quiet: false, since: null, hours: 0 };

  const sinceLive = !Number.isNaN(arrived) && arrived >= live;
  const start = sinceLive ? arrived : live;
  const hours = Math.max(0, (input.now.getTime() - start) / 3_600_000);
  const quiet = hours > input.quietAfterHours;
  const kind: QuietKind = quiet ? (sinceLive ? 'quiet' : 'never_arrived') : sinceLive ? 'arriving' : 'not_yet';
  return { kind, quiet, since: new Date(start).toISOString(), hours };
}

function when(iso: string, timezone?: string | null): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone }).format(new Date(iso));
  try {
    return format(timezone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/**
 * The alert's words. The client reads them verbatim on their own reliability page, so they
 * are written for the owner: what was seen, the two things it can mean, and that somebody
 * is looking. Null when there is nothing to say.
 */
export function quietMessage(verdict: QuietVerdict, options: { timezone?: string | null } = {}): string | null {
  if (!verdict.quiet || !verdict.since) return null;
  const date = when(verdict.since, options.timezone);
  return verdict.kind === 'never_arrived'
    ? `Automatic check: missed-call text-back has been on since ${date} and no call or form has reached ARC from your line since. Call forwarding may not be set up, so we are checking.`
    : `Automatic check: no call or form has reached ARC from your line since ${date}. That can be a slow stretch. It can also mean call forwarding has stopped, so we are checking.`;
}
