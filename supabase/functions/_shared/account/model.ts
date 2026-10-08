/**
 * ARC-MK-200 — what ARC is allowed to do for one client, as the owner reads it.
 *
 * The owner portal's Account screen answers one question: "what is ARC allowed to do?".
 * The answer already exists — it is the client's published Lead Recovery configuration and
 * its do-not-contact list — but until now only an operator could read either. This is the
 * projection a signed-in client is given: the hours, the service area, what happens outside
 * hours, who is told when a lead needs a person, and who must never be texted.
 *
 * Portal-safe: it imports nothing, so the page, the demo's written example and the edge
 * function all build and read the same shape. Three rules:
 *
 *   - it is a projection, never the document. templates, safety keywords, forwarding,
 *     compliance references and anything about Twilio are left out by construction — the
 *     view is built field by field, so a new configuration field is not shown until somebody
 *     adds it here on purpose.
 *   - an address never leaves whole. a staff number and a customer's number are both reduced
 *     to a hint (the last four digits, or a masked mailbox) before the view exists.
 *   - it reads; it changes nothing. there is no write beside it.
 */

export const ACCOUNT_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const WEEKDAY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
});

/** what each out-of-hours setting does, in an owner's words. drift-tested against the validator's list. */
export const AFTER_HOURS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  same_response: 'arc texts back straight away, day or night, with the same text.',
  after_hours_response: 'arc texts back straight away, with a text that says when you will call.',
  queue_until_open: 'arc waits, and texts back when you open.',
  do_not_send: 'arc sends nothing outside your hours.',
});

/** why an address is on the stop list. drift-tested against 0010's check constraint. */
export const STOP_REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  opt_out: 'they replied stop',
  wrong_contact: 'wrong number',
  compliance: 'blocked for compliance',
  staff_suppressed: 'your team blocked it',
  bounced: 'messages could not be delivered',
  other: 'other',
});

/** how many stop-list rows the view carries. the total is always the true count. */
export const STOP_LIST_SHOWN = 50;

export interface StopListRow {
  channel: string;
  address: string;
  reason: string;
  created_at: string | null;
  expires_at?: string | null;
}

export interface AccountSettingsView {
  available: true;
  timezone: string | null;
  hours: { day: string; ranges: { open: string; close: string }[] }[];
  after_hours: { behaviour: string; callback_window: string | null };
  service_area: { zips: string[]; cities: string[]; note: string | null };
  alerts: { name: string | null; channel: string; address_hint: string }[];
  stop_list: { total: number; entries: { channel: string; address_hint: string; reason: string; added_at: string | null }[] };
  /** the published versions this was read from, so a support conversation can name them. */
  versions: { tenant: number | null; module: number | null };
}

export interface AccountSettingsUnavailable {
  available: false;
  reason: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** the last four digits of a number, or a masked mailbox. never the address. */
export function addressHint(channel: unknown, address: unknown): string {
  const value = typeof address === 'string' ? address.trim() : '';
  if (value === '') return 'not set';
  if (channel === 'email' || value.includes('@')) {
    const at = value.indexOf('@');
    if (at < 1) return 'an email address';
    const domain = value.slice(at + 1);
    return `${value.slice(0, 1)}•••@${domain.slice(0, 2)}•••`;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length < 4 ? 'a phone number' : `number ending ${digits.slice(-4)}`;
}

/**
 * Build the view from a validated effective configuration and the stop-list rows.
 * `stopTotal` is the true count when `stopRows` is only the newest page of it.
 */
export function accountSettingsView(
  config: Record<string, unknown>,
  stopRows: readonly StopListRow[],
  meta: { tenantVersion?: number | null; moduleVersion?: number | null; stopTotal?: number | null } = {},
): AccountSettingsView {
  const hoursRaw = isObject(config.business_hours) ? config.business_hours : {};
  const area = isObject(config.service_area) ? config.service_area : {};
  const after = isObject(config.after_hours) ? config.after_hours : {};
  const alerts = Array.isArray(config.staff_alerts) ? config.staff_alerts.filter(isObject) : [];

  return {
    available: true,
    timezone: text(config.timezone),
    hours: ACCOUNT_WEEKDAYS.map((day) => ({
      day,
      ranges: (Array.isArray(hoursRaw[day]) ? (hoursRaw[day] as unknown[]) : [])
        .filter(isObject)
        .map((range) => ({ open: String(range.open ?? ''), close: String(range.close ?? '') }))
        .filter((range) => range.open !== '' && range.close !== ''),
    })),
    after_hours: {
      behaviour: text(after.behaviour) ?? 'same_response',
      callback_window: text(after.callback_window),
    },
    service_area: { zips: texts(area.zips), cities: texts(area.cities), note: text(area.note) },
    alerts: alerts.map((entry) => ({
      name: text(entry.name),
      channel: text(entry.channel) ?? 'sms',
      address_hint: addressHint(entry.channel, entry.address),
    })),
    stop_list: {
      total: typeof meta.stopTotal === 'number' ? meta.stopTotal : stopRows.length,
      entries: stopRows.slice(0, STOP_LIST_SHOWN).map((row) => ({
        channel: row.channel,
        address_hint: addressHint(row.channel, row.address),
        reason: row.reason,
        added_at: row.created_at ?? null,
      })),
    },
    versions: { tenant: meta.tenantVersion ?? null, module: meta.moduleVersion ?? null },
  };
}

/** "8:00 am – 5:00 pm" from the configuration's 24-hour "08:00" / "17:00". */
export function clockWords(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const hour = Number(match[1]);
  const suffix = hour % 24 < 12 ? 'am' : 'pm';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${suffix}`;
}

/** one line per weekday: the day and its hours, or "closed". */
export function hoursLines(view: Pick<AccountSettingsView, 'hours'>): { day: string; words: string; open: boolean }[] {
  return view.hours.map(({ day, ranges }) => ({
    day: WEEKDAY_WORDS[day] ?? day,
    open: ranges.length > 0,
    words: ranges.length === 0 ? 'closed' : ranges.map((r) => `${clockWords(r.open)} – ${clockWords(r.close)}`).join(', '),
  }));
}
