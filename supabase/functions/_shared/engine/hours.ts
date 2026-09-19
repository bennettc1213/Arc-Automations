/**
 * What time it is where the customer is.
 *
 * Business hours are the one place in this module where getting the timezone wrong is
 * silent rather than loud: a shop in Denver whose hours are evaluated in UTC is "closed"
 * from 10am and "open" at midnight, and nothing throws — it just sends the wrong message
 * to every caller, all day. So the zone is required configuration (validated as a real
 * IANA name) and every decision here is made in it.
 *
 * `Intl` rather than a date library, because edge functions should not carry 70KB of
 * timezone tables to answer one question, and `Intl.DateTimeFormat` already has the
 * current IANA database underneath it. The browser and Deno both have it; Luxon stays in
 * the portal where the bundle is already paying for it.
 */

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface LocalMoment {
  /** 'mon' … 'sun' */
  weekday: string;
  /** 'HH:MM', 24-hour, so it compares as a string against the config's own format. */
  time: string;
  /** 'YYYY-MM-DD', for matching holidays. */
  date: string;
  minutes: number;
}

/**
 * The instant, expressed in the tenant's zone.
 *
 * `en-CA` for the date because it formats as YYYY-MM-DD, which is both what the config
 * stores holidays as and what sorts correctly as a string.
 */
export function localMoment(at: Date, timezone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  /* Intl can return '24' for midnight in hour12:false. it is the same instant as 00. */
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');

  return {
    weekday: get('weekday').slice(0, 3).toLowerCase(),
    time: `${hour}:${minute}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

export interface OpenState {
  open: boolean;
  /** why it is closed, in a phrase that can go in an operator's notes. */
  reason: 'open' | 'holiday' | 'outside_hours' | 'closed_today';
  local: LocalMoment;
}

/**
 * Open right now?
 *
 * A holiday closes the whole day and outranks the weekday's hours, because that is what a
 * holiday is. A weekday with no periods reads `closed_today` rather than `outside_hours`,
 * so an operator looking at why nothing sent on a Sunday gets the real answer.
 */
export function isOpenAt(
  at: Date,
  config: {
    timezone: string;
    business_hours: Record<string, { open: string; close: string }[]>;
    holidays?: string[];
  },
): OpenState {
  const local = localMoment(at, config.timezone);

  if ((config.holidays ?? []).includes(local.date)) {
    return { open: false, reason: 'holiday', local };
  }

  const ranges = config.business_hours?.[local.weekday] ?? [];
  if (ranges.length === 0) return { open: false, reason: 'closed_today', local };

  const open = ranges.some((range) => local.time >= range.open && local.time < range.close);
  return { open, reason: open ? 'open' : 'outside_hours', local };
}

/**
 * The next moment the shop is open, as an instant.
 *
 * Used by the `queue_until_open` behaviour: the message is scheduled for opening time
 * rather than sent at 2am. Walks forward a day at a time to a hard ceiling of fourteen —
 * a config whose every weekday is empty would otherwise loop, and fourteen days of closure
 * is a misconfiguration the caller should hear about rather than wait through.
 */
export function nextOpenAt(
  at: Date,
  config: {
    timezone: string;
    business_hours: Record<string, { open: string; close: string }[]>;
    holidays?: string[];
  },
): Date | null {
  const state = isOpenAt(at, config);
  if (state.open) return at;

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const probe = new Date(at.getTime() + dayOffset * 86_400_000);
    const local = localMoment(probe, config.timezone);
    if ((config.holidays ?? []).includes(local.date)) continue;

    const ranges = [...(config.business_hours?.[local.weekday] ?? [])].sort((a, b) =>
      a.open.localeCompare(b.open),
    );
    for (const range of ranges) {
      /* today's already-passed periods do not count. */
      if (dayOffset === 0 && local.time >= range.open) continue;
      const opening = instantFor(local.date, range.open, config.timezone);
      if (opening && opening.getTime() > at.getTime()) return opening;
    }
  }

  return null;
}

/**
 * A local date and wall-clock time, resolved back to an instant.
 *
 * Done by search rather than by arithmetic: guess UTC, read back what that instant looks
 * like in the zone, and correct by the difference. Two rounds converge for every offset
 * including the half-hour and three-quarter-hour ones, and the read-back is what makes it
 * right across a DST boundary — the offset is asked of the zone at the candidate instant
 * rather than assumed from the date.
 *
 * A wall-clock time that does not exist (the hour a spring-forward skips) lands on the
 * instant just after the jump, which is the first moment the shop could actually be open.
 */
function instantFor(date: string, time: string, timezone: string): Date | null {
  const guess = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;

  let candidate = guess;
  for (let round = 0; round < 2; round += 1) {
    const local = localMoment(candidate, timezone);
    const wanted = Date.parse(`${date}T${time}:00Z`);
    const seen = Date.parse(`${local.date}T${local.time}:00Z`);
    if (Number.isNaN(wanted) || Number.isNaN(seen)) return null;
    const drift = wanted - seen;
    if (drift === 0) break;
    candidate = new Date(candidate.getTime() + drift);
  }

  return candidate;
}
