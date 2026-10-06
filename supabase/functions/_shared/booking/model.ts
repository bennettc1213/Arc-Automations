/**
 * ARC-380 — scheduling, availability and booking: what an appointment is, which times can be
 * offered, what a booking page may ask, and what may happen to an appointment afterwards.
 *
 * **Portal-safe.** No database, no network, no Deno API; the imports below are themselves
 * portal-safe. The hosted page (`PublicBooking.jsx`) checks a booking with `parseSubmission`
 * before it posts, the workspace draws its buttons from `nextActions`, and the function runs
 * the same code again, because a browser is never the last check. `0027_crm_booking.sql`
 * mirrors the vocabularies and the transitions here and is drift-tested against them.
 *
 * Three things decide whether a time can be booked, and each has one home:
 *
 *   the rules      `availableSlots` — opening hours in the business's own timezone, the
 *                  notice a booking needs, how far ahead the calendar is open, closed days.
 *                  0027's `crm_booking_check_time` checks the same rules where it cannot be
 *                  skipped.
 *   the calendar   who already holds the time. Offered from a read of the held appointments,
 *                  and decided for certain only by 0027's guard, under a lock.
 *   whose it is    ARC-340's source-of-truth policy for `appointment`. Where the client's own
 *                  calendar owns the time, ARC offers none: `bookingMode` says `request`, and
 *                  what a customer chooses is a preferred time for that calendar to answer.
 *
 * Deliberately not here: routes, crews, technician schedules, time tracking, estimates,
 * invoices. `capacity` is a number and `assigned_user_id` is a name.
 */

import { type FieldError, type Parsed, parseBusinessHours, secretProblem, type SourcePolicy, fieldOwner } from '../crm/model.ts';
import { instantFor, localMoment, WEEKDAY_KEYS } from '../engine/hours.ts';
import { cleanText, type ConsentInput, FORM_CONSENT_CHANNELS, type FormConsent, type FormConsentChannel } from '../intake/model.ts';
import { normaliseEmail, normalisePhone } from '../phone.ts';

type Raw = Record<string, unknown>;

/* ── vocabularies (mirrored by 0027's check constraints) ── */

export const APPOINTMENT_STATUSES = ['requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show'] as const;
export type AppointmentStatus = typeof APPOINTMENT_STATUSES[number];
/** the two that hold their time. everything else has let it go. */
export const HELD_STATUSES: readonly AppointmentStatus[] = ['requested', 'confirmed'];

export const APPOINTMENT_SOURCES = ['booking_page', 'staff', 'external_system'] as const;
export const SYNC_STATES = ['local', 'pending', 'synced', 'conflict'] as const;
export type SyncState = typeof SYNC_STATES[number];
export const CHANGE_DOORS = ['booking_page', 'manage_link', 'workspace', 'sync'] as const;
export const APPOINTMENT_EVENT_TYPES = [
  'requested', 'confirmed', 'declined', 'rescheduled', 'cancelled', 'completed', 'no_show',
  'assigned', 'sync_applied', 'sync_conflict', 'reconciled',
] as const;
/** what 0027 adds to the timeline's vocabulary (0023's `ACTIVITY_TYPES`). */
export const BOOKING_ACTIVITY_TYPES = [
  'appointment_requested', 'appointment_confirmed', 'appointment_declined', 'appointment_rescheduled',
  'appointment_cancelled', 'appointment_completed', 'appointment_no_show',
] as const;
export const PAGE_STATUSES = ['draft', 'published', 'archived'] as const;
export const HOURS_SOURCES = ['business_hours', 'custom'] as const;
export const SLOT_STEPS = [15, 30, 60] as const;
export const ADDRESS_MODES = ['off', 'optional', 'required'] as const;
export type AddressMode = typeof ADDRESS_MODES[number];

export const BOOKING_KEY = /^arcb_[a-z0-9]{32}$/;
export const MANAGE_TOKEN = /^arcm_[a-z0-9]{40}$/;

export const BOOKING_LIMITS = Object.freeze({
  /* how many days one availability read covers. the page asks for a week at a time. */
  daysPerRead: 14,
  closedDates: 60,
  typesPerPage: 12,
  dedupeMinutesMax: 43200,
  hourlyCapMax: 1000,
  /* a booking nobody could have made this fast. */
  minDwellMs: 1200,
});

/**
 * The changes of status a person can make. Their calendar, where it is the authority, may
 * report any status; so may a reconciliation. `confirmed → requested` happens only together
 * with a new time — a customer moved an appointment that needs approval.
 */
export const APPOINTMENT_TRANSITIONS: readonly (readonly [AppointmentStatus, AppointmentStatus])[] = Object.freeze([
  ['requested', 'confirmed'], ['requested', 'declined'], ['requested', 'cancelled'],
  ['confirmed', 'cancelled'], ['confirmed', 'completed'], ['confirmed', 'no_show'],
  ['confirmed', 'requested'],
]);

export const APPOINTMENT_ACTIONS = ['confirm', 'decline', 'cancel', 'complete', 'no_show', 'reschedule', 'assign'] as const;
export type AppointmentAction = typeof APPOINTMENT_ACTIONS[number];
const ACTION_STATUS: Readonly<Partial<Record<AppointmentAction, AppointmentStatus>>> = Object.freeze({
  confirm: 'confirmed', decline: 'declined', cancel: 'cancelled', complete: 'completed', no_show: 'no_show',
});

/* ── the rules a booking follows ────────────────────────── */

export type Hours = Record<string, { open: string; close: string }[]>;

export interface BookingAuthority {
  authority: 'arc' | 'external' | 'hybrid';
  connector_key: string | null;
  time_owner: 'arc' | 'external';
  status_owner: 'arc' | 'external';
}

/** 0027's `crm_booking_rules`, as it arrives: the settings, the hours they point at, and whose calendar it is. */
export interface BookingRules {
  timezone: string;
  hours_source: typeof HOURS_SOURCES[number];
  hours: Hours;
  closed_dates: string[];
  slot_step_minutes: number;
  min_lead_minutes: number;
  max_days_ahead: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  capacity: number;
  customer_may_cancel: boolean;
  customer_may_reschedule: boolean;
  customer_change_cutoff_minutes: number;
  enforce_service_area: boolean;
  authority: BookingAuthority;
}

/** what a client with no settings row gets. 0027's defaults, drift-tested on real SQL. */
export const DEFAULT_SETTINGS = Object.freeze({
  hours_source: 'business_hours',
  closed_dates: [] as string[],
  slot_step_minutes: 30,
  min_lead_minutes: 120,
  max_days_ahead: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  capacity: 1,
  customer_may_cancel: true,
  customer_may_reschedule: true,
  customer_change_cutoff_minutes: 240,
  enforce_service_area: false,
});

/** the policy ARC-340 holds for appointments, as the two answers booking needs. */
export function appointmentAuthority(policy: SourcePolicy | null | undefined): BookingAuthority {
  if (!policy) return { authority: 'arc', connector_key: null, time_owner: 'arc', status_owner: 'arc' };
  return {
    authority: policy.authority,
    connector_key: policy.connectorKey,
    time_owner: fieldOwner(policy, 'starts_at'),
    status_owner: fieldOwner(policy, 'status'),
  };
}

/**
 * `slots`: ARC keeps the calendar, and offers the times that are free.
 * `request`: their calendar owns the time. ARC offers nothing as free — it takes a preferred
 * time and waits for that calendar's answer.
 */
export function bookingMode(authority: BookingAuthority): 'slots' | 'request' {
  return authority.time_owner === 'external' ? 'request' : 'slots';
}

/* ── parsing helpers ────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : {});
const isObject = (raw: unknown): raw is Raw => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
const has = (raw: Raw, key: string) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;

function unknownKeys(raw: Raw, known: readonly string[], errors: FieldError[], prefix = '') {
  for (const key of Object.keys(raw)) if (!known.includes(key)) errors.push({ field: `${prefix}${key}`, message: 'is not a field of this record' });
}

function int(raw: Raw, key: string, min: number, max: number, errors: FieldError[], out: Raw, opts: { nullable?: boolean } = {}) {
  if (!has(raw, key)) return;
  const v = raw[key];
  if ((v === null || v === '') && opts.nullable) return void (out[key] = null);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return void errors.push({ field: key, message: `is a whole number from ${min} to ${max}` });
  out[key] = v;
}

function bool(raw: Raw, key: string, errors: FieldError[], out: Raw) {
  if (!has(raw, key)) return;
  if (typeof raw[key] !== 'boolean') return void errors.push({ field: key, message: 'must be true or false' });
  out[key] = raw[key];
}

/** a line of wording: required or not, capped, plain text, never a credential. */
function wording(raw: Raw, key: string, max: number, errors: FieldError[], opts: { required?: boolean; field?: string } = {}): string | null {
  const field = opts.field ?? key;
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (opts.required) errors.push({ field, message: 'is required' });
    return null;
  }
  const text = cleanText(value, { multiline: max > 200 });
  if (text === null) {
    errors.push({ field, message: opts.required ? 'is required' : 'must be text' });
    return null;
  }
  if (text.length > max) errors.push({ field, message: `is longer than ${max} characters` });
  else if (secretProblem(text)) errors.push({ field, message: 'looks like a credential — those are never kept here' });
  return text;
}

/** an instant, from anything `Date.parse` reads with an offset. a bare local time is refused: whose local? */
export function parseInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/(Z|[+-][0-9]{2}:?[0-9]{2})$/.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/* ── settings ───────────────────────────────────────────── */

const SETTINGS_KEYS = [
  'hours_source', 'custom_hours', 'closed_dates', 'slot_step_minutes', 'min_lead_minutes', 'max_days_ahead',
  'buffer_before_minutes', 'buffer_after_minutes', 'capacity', 'customer_may_cancel', 'customer_may_reschedule',
  'customer_change_cutoff_minutes', 'enforce_service_area',
];

/** a change to a client's booking rules. only what was sent is changed. */
export function parseSettingsInput(raw: unknown): Parsed<Raw> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  const out: Raw = {};
  unknownKeys(source, SETTINGS_KEYS, errors);
  if (has(source, 'hours_source')) {
    if (!(HOURS_SOURCES as readonly unknown[]).includes(source.hours_source)) errors.push({ field: 'hours_source', message: `is one of: ${HOURS_SOURCES.join(', ')}` });
    else out.hours_source = source.hours_source;
  }
  if (has(source, 'custom_hours')) {
    const hours = parseBusinessHours(source.custom_hours);
    if (hours.ok) out.custom_hours = hours.value;
    else errors.push(...hours.errors.map((e) => ({ field: e.field.replace(/^business_hours/, 'custom_hours'), message: e.message })));
  }
  if (has(source, 'closed_dates')) {
    const list = source.closed_dates;
    if (!Array.isArray(list) || list.length > BOOKING_LIMITS.closedDates || !list.every(realDate)) {
      errors.push({ field: 'closed_dates', message: `is up to ${BOOKING_LIMITS.closedDates} dates written YYYY-MM-DD` });
    } else out.closed_dates = [...new Set(list as string[])].sort();
  }
  if (has(source, 'slot_step_minutes')) {
    if (!(SLOT_STEPS as readonly unknown[]).includes(source.slot_step_minutes)) errors.push({ field: 'slot_step_minutes', message: `is one of: ${SLOT_STEPS.join(', ')}` });
    else out.slot_step_minutes = source.slot_step_minutes;
  }
  int(source, 'min_lead_minutes', 0, 43200, errors, out);
  int(source, 'max_days_ahead', 1, 365, errors, out);
  int(source, 'buffer_before_minutes', 0, 240, errors, out);
  int(source, 'buffer_after_minutes', 0, 240, errors, out);
  int(source, 'capacity', 1, 20, errors, out);
  int(source, 'customer_change_cutoff_minutes', 0, 43200, errors, out);
  bool(source, 'customer_may_cancel', errors, out);
  bool(source, 'customer_may_reschedule', errors, out);
  bool(source, 'enforce_service_area', errors, out);
  if (errors.length === 0 && Object.keys(out).length === 0) errors.push({ field: 'settings', message: 'nothing to change' });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/* ── appointment types ──────────────────────────────────── */

const TYPE_KEYS = ['key', 'name', 'description', 'service_id', 'duration_minutes', 'buffer_before_minutes', 'buffer_after_minutes', 'requires_approval', 'is_public', 'archived'];

/** what can be booked. a new one needs a key, a name and a length; the key never changes. */
export function parseAppointmentTypeInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  const out: Raw = {};
  unknownKeys(source, TYPE_KEYS, errors);
  if (opts.partial) {
    if (has(source, 'key')) errors.push({ field: 'key', message: 'never changes once the type is made' });
  } else if (typeof source.key !== 'string' || !KEY.test(source.key)) {
    errors.push({ field: 'key', message: 'is lowercase letters, digits and underscores, starting with a letter' });
  } else out.key = source.key;
  if (has(source, 'name') || !opts.partial) {
    const name = wording(source, 'name', 120, errors, { required: true });
    if (name) out.name = name;
  }
  if (has(source, 'description')) out.description = wording(source, 'description', 500, errors);
  if (has(source, 'service_id')) {
    const v = source.service_id;
    if (v === null || v === '') out.service_id = null;
    else if (typeof v !== 'string' || !UUID.test(v)) errors.push({ field: 'service_id', message: 'is not an id' });
    else out.service_id = v.toLowerCase();
  }
  if (!opts.partial && !has(source, 'duration_minutes')) errors.push({ field: 'duration_minutes', message: 'is required' });
  int(source, 'duration_minutes', 5, 480, errors, out);
  int(source, 'buffer_before_minutes', 0, 240, errors, out, { nullable: true });
  int(source, 'buffer_after_minutes', 0, 240, errors, out, { nullable: true });
  bool(source, 'requires_approval', errors, out);
  bool(source, 'is_public', errors, out);
  if (has(source, 'archived')) {
    if (typeof source.archived !== 'boolean') errors.push({ field: 'archived', message: 'must be true or false' });
    else out.archived_at = source.archived ? new Date().toISOString() : null;
  }
  if (errors.length === 0 && opts.partial && Object.keys(out).length === 0) errors.push({ field: 'type', message: 'nothing to change' });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/* ── the hosted page ────────────────────────────────────── */

export interface PageDefinition {
  title: string;
  intro: string | null;
  success_message: string;
  /** whether the page asks where the visit is. */
  address: AddressMode;
  /** whether the page offers a box for anything the business should know. */
  note: boolean;
  /** the types this page offers, by key. null is every public type the client has. */
  type_keys: string[] | null;
  consent: Partial<Record<FormConsentChannel, FormConsent>>;
}

const DEFAULT_SUCCESS = 'Thanks — your booking has been received.';

/**
 * A booking page's definition, whole. Like a form (ARC-350) it is data and not a program: a
 * closed list of keys, plain wording, and nowhere to put a condition, a script or markup.
 */
export function parsePageDefinition(raw: unknown): Parsed<PageDefinition> {
  const errors: FieldError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'definition', message: 'is an object' }] };
  unknownKeys(raw, ['title', 'intro', 'success_message', 'address', 'note', 'type_keys', 'consent'], errors);

  const title = wording(raw, 'title', 120, errors, { required: true }) ?? '';
  const intro = wording(raw, 'intro', 500, errors);
  const success = wording(raw, 'success_message', 300, errors) ?? DEFAULT_SUCCESS;

  let address: AddressMode = 'optional';
  if (has(raw, 'address')) {
    if (!(ADDRESS_MODES as readonly unknown[]).includes(raw.address)) errors.push({ field: 'address', message: `is one of: ${ADDRESS_MODES.join(', ')}` });
    else address = raw.address as AddressMode;
  }
  if (has(raw, 'note') && typeof raw.note !== 'boolean') errors.push({ field: 'note', message: 'must be true or false' });

  let typeKeys: string[] | null = null;
  if (has(raw, 'type_keys') && raw.type_keys !== null) {
    const list = raw.type_keys;
    if (!Array.isArray(list) || list.length === 0 || list.length > BOOKING_LIMITS.typesPerPage || !list.every((k) => typeof k === 'string' && KEY.test(k))) {
      errors.push({ field: 'type_keys', message: `is 1 to ${BOOKING_LIMITS.typesPerPage} appointment type keys, or left out for all of them` });
    } else typeKeys = [...new Set(list as string[])];
  }

  const consent: PageDefinition['consent'] = {};
  if (raw.consent !== undefined && raw.consent !== null) {
    if (!isObject(raw.consent)) errors.push({ field: 'consent', message: 'is an object' });
    else {
      unknownKeys(raw.consent, FORM_CONSENT_CHANNELS, errors, 'consent.');
      for (const channel of FORM_CONSENT_CHANNELS) {
        const entry = raw.consent[channel];
        if (entry === undefined || entry === null) continue;
        const at = `consent.${channel}`;
        if (!isObject(entry)) { errors.push({ field: at, message: 'is an object' }); continue; }
        unknownKeys(entry, ['mode', 'text'], errors, `${at}.`);
        if (entry.mode !== 'optional' && entry.mode !== 'required') errors.push({ field: `${at}.mode`, message: 'is optional or required' });
        const text = wording(entry, 'text', 500, errors, { required: true, field: `${at}.text` });
        if (text && (entry.mode === 'optional' || entry.mode === 'required')) consent[channel] = { mode: entry.mode, text };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const value: PageDefinition = { title, intro, success_message: success, address, note: raw.note !== false, type_keys: typeKeys, consent };
  /* 0027 checks the stored document as one piece of text; so does this. */
  if (secretProblem(value)) return { ok: false, errors: [{ field: 'definition', message: 'reads like it contains a credential — reword it' }] };
  return { ok: true, value };
}

export function defaultPageDefinition(title: string): PageDefinition {
  return {
    title,
    intro: null,
    success_message: DEFAULT_SUCCESS,
    address: 'optional',
    note: true,
    type_keys: null,
    consent: { sms: { mode: 'optional', text: 'Text me about this booking. Message and data rates may apply. Reply STOP to opt out.' } },
  };
}

export interface PageInput { name?: string; definition?: PageDefinition; dedupe_minutes?: number; hourly_cap?: number }

/** what an operator or the account owner saves: a name, the definition and two limits. */
export function parsePageInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<PageInput> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  const out: Raw = {};
  unknownKeys(source, ['name', 'definition', 'dedupe_minutes', 'hourly_cap'], errors);
  if (has(source, 'name') || !opts.partial) {
    const name = wording(source, 'name', 120, errors, { required: true });
    if (name) out.name = name;
  }
  if (has(source, 'definition') || !opts.partial) {
    const definition = parsePageDefinition(source.definition);
    if (definition.ok) out.definition = definition.value;
    else errors.push(...definition.errors.map((e) => ({ field: e.field === 'definition' ? e.field : `definition.${e.field}`, message: e.message })));
  }
  int(source, 'dedupe_minutes', 0, BOOKING_LIMITS.dedupeMinutesMax, errors, out);
  int(source, 'hourly_cap', 1, BOOKING_LIMITS.hourlyCapMax, errors, out);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out as PageInput };
}

/** the shareable link. the key is public by construction; it is not the client's id. */
export function bookingUrl(siteUrl: string, publicKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/book/${publicKey}`;
}

/** a frame around the hosted page and nothing else: no script, no key but the link's own. */
export function bookingEmbedSnippet(siteUrl: string, publicKey: string, title: string): string {
  const safe = title.replace(/[<>"&]/g, '');
  return `<iframe src="${bookingUrl(siteUrl, publicKey)}?embed=1" title="${safe}" loading="lazy" style="width:100%;min-height:760px;border:0"></iframe>`;
}

/**
 * The customer's own link to move or cancel. The token rides in the fragment, which a browser
 * does not send to a server or put in a referrer — so it is in no access log.
 */
export function manageUrl(siteUrl: string, publicKey: string, token: string): string {
  return `${bookingUrl(siteUrl, publicKey)}/manage#${token}`;
}

/* ── a booking a stranger makes ─────────────────────────── */

export interface BookableType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number | null;
  buffer_after_minutes: number | null;
  requires_approval: boolean;
}

export interface BookingParts {
  type: BookableType;
  startsAt: string;
  contact: Raw;
  address: { address_line1: string | null; city: string | null; region: string | null; postal_code: string | null };
  note: string | null;
  consent: ConsentInput[];
}

/**
 * One booking checked against the page it was made on: `{ type, starts_at, name, phone, email,
 * address, city, region, postal_code, note, consent_sms, consent_email }`. A key the page does
 * not ask for is ignored rather than stored — the page decides what a booking is, not the request.
 */
export function parseSubmission(definition: PageDefinition, values: unknown, context: { types: readonly BookableType[] }): Parsed<BookingParts> {
  const input = asObject(values);
  const errors: FieldError[] = [];

  const type = context.types.find((t) => t.key === input.type) ?? (context.types.length === 1 && input.type === undefined ? context.types[0] : null);
  if (!type) errors.push({ field: 'type', message: 'choose what the appointment is for' });
  const startsAt = parseInstant(input.starts_at);
  if (!startsAt) errors.push({ field: 'starts_at', message: 'choose a time' });

  const text = (key: string, max: number, required: boolean, multiline = false): string | null => {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
      if (required) errors.push({ field: key, message: 'is required' });
      return null;
    }
    const clean = cleanText(value, { multiline });
    if (clean === null) {
      if (required) errors.push({ field: key, message: 'is required' });
      return null;
    }
    if (clean.length > max) {
      errors.push({ field: key, message: `is longer than ${max} characters` });
      return null;
    }
    /* a pasted password must not cost the customer their booking, and must not be kept. */
    return secretProblem(clean) ? '[removed: this looked like a password or a key]' : clean;
  };

  const name = text('name', 120, true);
  let phone: string | null = null;
  let email: string | null = null;
  if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
    phone = normalisePhone(input.phone);
    if (!phone) errors.push({ field: 'phone', message: 'is not a phone number we can call — include the area code' });
  }
  if (input.email !== undefined && input.email !== null && input.email !== '') {
    email = normaliseEmail(input.email);
    if (!email) errors.push({ field: 'email', message: 'does not look like an email address' });
  }
  if (!phone && !email && !errors.some((e) => e.field === 'phone' || e.field === 'email')) {
    errors.push({ field: 'phone', message: 'give us a phone number or an email address so we can reach you' });
  }

  const asked = definition.address !== 'off';
  const address = {
    address_line1: asked ? text('address', 200, definition.address === 'required') : null,
    city: asked ? text('city', 120, false) : null,
    region: asked ? text('region', 120, false) : null,
    postal_code: asked ? text('postal_code', 20, definition.address === 'required') : null,
  };
  const note = definition.note ? text('note', 1000, false, true) : null;

  /* consent is recorded only for an address that was given, and is never assumed. */
  const consent: ConsentInput[] = [];
  for (const channel of FORM_CONSENT_CHANNELS) {
    const ask = definition.consent[channel];
    const where = channel === 'sms' ? phone : email;
    if (!ask || !where) continue;
    const granted = input[`consent_${channel}`] === true;
    if (ask.mode === 'required' && !granted) errors.push({ field: `consent_${channel}`, message: 'please tick this box so we can confirm your booking' });
    consent.push({ channel, address: where, granted, disclosure: ask.text });
  }

  if (errors.length > 0 || !type || !startsAt) return { ok: false, errors };

  const contact: Raw = {};
  const put = (key: string, value: string | null) => { if (value) contact[key] = value; };
  put('display_name', name);
  put('phone', phone);
  put('email', email);
  put('address_line1', address.address_line1);
  put('city', address.city);
  put('region', address.region);
  put('postal_code', address.postal_code);
  return { ok: true, value: { type, startsAt, contact, address, note, consent } };
}

/** the two checks a person passes without noticing and a script usually does not (as ARC-350's). */
export function spamVerdict(body: Raw, now: number): 'honeypot' | 'dwell' | null {
  if (typeof body.company_website === 'string' && body.company_website.trim() !== '') return 'honeypot';
  const renderedAt = typeof body.rendered_at === 'number' ? body.rendered_at : 0;
  if (renderedAt > 0 && now - renderedAt < BOOKING_LIMITS.minDwellMs) return 'dwell';
  return null;
}

/* ── a booking a person makes, and a change to one ──────── */

export interface StaffBooking {
  appointment_type_id: string;
  starts_at: string;
  contact_id: string | null;
  lead_id: string | null;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  customer_note: string | null;
  assigned_user_id: string | null;
  /** book it even though it is outside the hours or the notice. a person's decision, said out loud. */
  outside_rules: boolean;
}

export function parseStaffBooking(raw: unknown): Parsed<StaffBooking> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  unknownKeys(source, ['appointment_type_id', 'starts_at', 'contact_id', 'lead_id', 'address_line1', 'city', 'region', 'postal_code', 'customer_note', 'assigned_user_id', 'outside_rules'], errors);
  const id = (key: string, required: boolean): string | null => {
    const v = source[key];
    if (v === undefined || v === null || v === '') {
      if (required) errors.push({ field: key, message: 'is required' });
      return null;
    }
    if (typeof v !== 'string' || !UUID.test(v)) {
      errors.push({ field: key, message: 'is not an id' });
      return null;
    }
    return v.toLowerCase();
  };
  const typeId = id('appointment_type_id', true);
  const contactId = id('contact_id', false);
  const leadId = id('lead_id', false);
  if (!contactId && !leadId && !errors.some((e) => e.field === 'contact_id' || e.field === 'lead_id')) {
    errors.push({ field: 'contact_id', message: 'choose the customer or the lead this appointment is for' });
  }
  const startsAt = parseInstant(source.starts_at);
  if (!startsAt) errors.push({ field: 'starts_at', message: 'is a date and time with its offset' });
  if (has(source, 'outside_rules') && typeof source.outside_rules !== 'boolean') errors.push({ field: 'outside_rules', message: 'must be true or false' });
  const value: StaffBooking = {
    appointment_type_id: typeId ?? '',
    starts_at: startsAt ?? '',
    contact_id: contactId,
    lead_id: leadId,
    address_line1: wording(source, 'address_line1', 200, errors),
    city: wording(source, 'city', 120, errors),
    region: wording(source, 'region', 120, errors),
    postal_code: wording(source, 'postal_code', 20, errors),
    customer_note: wording(source, 'customer_note', 1000, errors),
    assigned_user_id: id('assigned_user_id', false),
    outside_rules: source.outside_rules === true,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export interface AppointmentChange {
  action: AppointmentAction;
  starts_at: string | null;
  reason: string | null;
  assigned_user_id: string | null;
  outside_rules: boolean;
}

export function parseChange(raw: unknown): Parsed<AppointmentChange> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  unknownKeys(source, ['action', 'starts_at', 'reason', 'assigned_user_id', 'outside_rules'], errors);
  const action = source.action as AppointmentAction;
  if (!(APPOINTMENT_ACTIONS as readonly unknown[]).includes(action)) errors.push({ field: 'action', message: `is one of: ${APPOINTMENT_ACTIONS.join(', ')}` });
  let startsAt: string | null = null;
  if (action === 'reschedule') {
    startsAt = parseInstant(source.starts_at);
    if (!startsAt) errors.push({ field: 'starts_at', message: 'is the new date and time, with its offset' });
  }
  let assignee: string | null = null;
  if (action === 'assign' && source.assigned_user_id !== null && source.assigned_user_id !== '' && source.assigned_user_id !== undefined) {
    if (typeof source.assigned_user_id !== 'string' || !UUID.test(source.assigned_user_id)) errors.push({ field: 'assigned_user_id', message: 'is not an id' });
    else assignee = source.assigned_user_id.toLowerCase();
  }
  const reason = wording(source, 'reason', 300, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { action, starts_at: startsAt, reason, assigned_user_id: assignee, outside_rules: source.outside_rules === true } };
}

/* ── what their calendar reports ────────────────────────── */

export interface ExternalReport {
  external_id: string;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  observed_at: string | null;
  appointment_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  title: string | null;
}

/**
 * The contract an external calendar's connector reports an entry through. The connector is
 * the actor's, never a field of the report — a payload cannot say which system it came from.
 */
export function parseExternalReport(raw: unknown): Parsed<ExternalReport> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  unknownKeys(source, ['external_id', 'status', 'starts_at', 'ends_at', 'observed_at', 'appointment_id', 'contact_id', 'lead_id', 'title'], errors);
  const externalId = wording(source, 'external_id', 200, errors, { required: true }) ?? '';
  if (!(APPOINTMENT_STATUSES as readonly unknown[]).includes(source.status)) errors.push({ field: 'status', message: `is one of: ${APPOINTMENT_STATUSES.join(', ')}` });
  const startsAt = parseInstant(source.starts_at);
  const endsAt = parseInstant(source.ends_at);
  if (!startsAt) errors.push({ field: 'starts_at', message: 'is a date and time with its offset' });
  if (!endsAt) errors.push({ field: 'ends_at', message: 'is a date and time with its offset' });
  if (startsAt && endsAt) {
    const length = Date.parse(endsAt) - Date.parse(startsAt);
    if (length <= 0 || length > 86_400_000) errors.push({ field: 'ends_at', message: 'is after the start, and within a day of it' });
  }
  let observed: string | null = null;
  if (has(source, 'observed_at') && source.observed_at !== null) {
    observed = parseInstant(source.observed_at);
    if (!observed) errors.push({ field: 'observed_at', message: 'is a date and time with its offset' });
  }
  const id = (key: string): string | null => {
    const v = source[key];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !UUID.test(v)) {
      errors.push({ field: key, message: 'is not an id' });
      return null;
    }
    return v.toLowerCase();
  };
  const value: ExternalReport = {
    external_id: externalId,
    status: source.status as AppointmentStatus,
    starts_at: startsAt ?? '',
    ends_at: endsAt ?? '',
    observed_at: observed,
    appointment_id: id('appointment_id'),
    contact_id: id('contact_id'),
    lead_id: id('lead_id'),
    title: wording(source, 'title', 200, errors),
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/* ── availability ───────────────────────────────────────── */

export interface Slot { starts_at: string; ends_at: string }

/** an appointment that holds its time: the time itself, and the time with its buffers. */
export interface HeldTime { id?: string; starts_at: string; ends_at: string; busy_from: string; busy_until: string }

export interface AvailabilityInput {
  rules: Pick<BookingRules, 'timezone' | 'hours' | 'closed_dates' | 'slot_step_minutes' | 'min_lead_minutes' | 'max_days_ahead' | 'buffer_before_minutes' | 'buffer_after_minutes' | 'capacity'>;
  type: Pick<BookableType, 'duration_minutes' | 'buffer_before_minutes' | 'buffer_after_minutes'>;
  held: readonly HeldTime[];
  now: Date;
  /** the first day to offer, as the business's own calendar date. */
  from: string;
  days: number;
  /** an appointment being moved does not block its own new time. */
  excludeId?: string | null;
}

const MINUTE = 60_000;

/** a timestamp as milliseconds, whether the driver handed over a string or a Date. */
export function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** the calendar date `days` after `date`, by the calendar and not by 24-hour steps. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** 'mon' … 'sun' for a calendar date. a date has a weekday whatever the timezone. */
export function weekdayOf(date: string): string {
  return WEEKDAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** today, as the business's own calendar date. */
export function localDate(at: Date, timezone: string): string {
  return localMoment(at, timezone).date;
}

/**
 * How many held appointments a new one at `[startsAt, endsAt]` would run into. Each one's
 * buffer is kept clear of the other's actual time — so the gap between two is the larger of
 * the two buffers, never their sum. 0027's guard counts the same way.
 */
export function overlapCount(held: readonly HeldTime[], startsAt: number, endsAt: number, before: number, after: number, excludeId?: string | null): number {
  const busyFrom = startsAt - before * MINUTE;
  const busyUntil = endsAt + after * MINUTE;
  let count = 0;
  for (const h of held) {
    if (excludeId && h.id === excludeId) continue;
    const theirBufferHitsUs = timeOf(h.busy_from) < endsAt && timeOf(h.busy_until) > startsAt;
    const ourBufferHitsThem = timeOf(h.starts_at) < busyUntil && timeOf(h.ends_at) > busyFrom;
    if (theirBufferHitsUs || ourBufferHitsThem) count += 1;
  }
  return count;
}

/**
 * The times that can be offered: inside an open period of an open day in the business's own
 * timezone, far enough ahead, not too far ahead, and not held by `capacity` other appointments.
 *
 * A wall-clock time that does not exist (the hour a spring-forward skips) is not offered; one
 * that happens twice is offered once, as its first occurrence.
 */
export function availableSlots(input: AvailabilityInput): Slot[] {
  const { rules, type, held, now } = input;
  const days = Math.max(1, Math.min(input.days, BOOKING_LIMITS.daysPerRead));
  const before = type.buffer_before_minutes ?? rules.buffer_before_minutes;
  const after = type.buffer_after_minutes ?? rules.buffer_after_minutes;
  const earliest = now.getTime() + rules.min_lead_minutes * MINUTE;
  const latest = now.getTime() + rules.max_days_ahead * 86_400_000;
  const closed = new Set(rules.closed_dates);
  const out: Slot[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(input.from, offset);
    if (closed.has(date)) continue;
    for (const period of rules.hours[weekdayOf(date)] ?? []) {
      const close = minutesOf(period.close);
      for (let at = minutesOf(period.open); at + type.duration_minutes <= close; at += rules.slot_step_minutes) {
        const start = instantFor(date, hhmm(at), rules.timezone);
        if (!start) continue;
        const seen = localMoment(start, rules.timezone);
        if (seen.date !== date || seen.time !== hhmm(at)) continue;
        const startsAt = start.getTime();
        const endsAt = startsAt + type.duration_minutes * MINUTE;
        if (startsAt < earliest || startsAt > latest) continue;
        if (overlapCount(held, startsAt, endsAt, before, after, input.excludeId) >= rules.capacity) continue;
        out.push({ starts_at: start.toISOString(), ends_at: new Date(endsAt).toISOString() });
      }
    }
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** is this exact start one of the times `availableSlots` would offer. */
export function isOffered(input: Omit<AvailabilityInput, 'from' | 'days'>, startsAt: string): boolean {
  const from = localDate(new Date(startsAt), input.rules.timezone);
  return availableSlots({ ...input, from, days: 1 }).some((slot) => slot.starts_at === startsAt);
}

/** why nothing can be offered at all, or null. the reason a page gives instead of an empty calendar. */
export function unavailableReason(rules: Pick<BookingRules, 'hours' | 'authority'>, types: readonly unknown[]): 'their_calendar' | 'no_hours' | 'no_types' | null {
  if (bookingMode(rules.authority) === 'request') return 'their_calendar';
  if (types.length === 0) return 'no_types';
  if (!Object.values(rules.hours ?? {}).some((periods) => periods.length > 0)) return 'no_hours';
  return null;
}

/* ── the service area ───────────────────────────────────── */

export type AreaDecision = 'inside' | 'outside' | 'unknown';

/**
 * Whether an address is in the business's service areas (0023). `inside` on a match by ZIP,
 * city or state. `unknown` — never `outside` — when there are no areas, when the address does
 * not say enough, or when the only areas are ones text cannot check (a county, a radius): ARC
 * does not turn a customer away on a guess.
 */
export function serviceAreaDecision(areas: readonly Raw[], address: { postal_code?: string | null; city?: string | null; region?: string | null }): AreaDecision {
  const live = areas.filter((a) => !a.archived_at);
  if (live.length === 0) return 'unknown';
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const zip = norm(address.postal_code).slice(0, 5);
  const city = norm(address.city);
  const region = norm(address.region);
  let comparable = false;
  for (const area of live) {
    const value = norm(area.value);
    if (area.kind === 'postal_code' && zip) { comparable = true; if (value.slice(0, 5) === zip) return 'inside'; }
    if (area.kind === 'city' && city) { comparable = true; if (value === city) return 'inside'; }
    if (area.kind === 'region' && region) { comparable = true; if (value === region) return 'inside'; }
  }
  const uncheckable = live.some((a) => a.kind === 'county' || a.kind === 'radius_miles');
  return comparable && !uncheckable ? 'outside' : 'unknown';
}

/* ── what may happen to an appointment ──────────────────── */

export type Decision = { ok: true } | { ok: false; code: string; message: string };

/**
 * What a customer may do from their own link. 0027's `crm_appointment_change` enforces the
 * same rules under the appointment's lock; this is so the page can say it before they try.
 */
export function customerChangeDecision(
  rules: Pick<BookingRules, 'customer_may_cancel' | 'customer_may_reschedule' | 'customer_change_cutoff_minutes' | 'authority'>,
  appointment: { status: string; starts_at: string; sync_state?: string },
  action: 'cancel' | 'reschedule',
  now: Date,
): Decision {
  if (!(HELD_STATUSES as readonly string[]).includes(appointment.status)) {
    return { ok: false, code: 'conflict', message: `this appointment is already ${appointment.status.replace(/_/g, ' ')}` };
  }
  const theirs = action === 'reschedule' ? rules.authority.time_owner === 'external' : rules.authority.status_owner === 'external';
  if (theirs || appointment.sync_state === 'conflict') return { ok: false, code: 'too_late', message: 'this cannot be changed online — please call us' };
  if (!(action === 'cancel' ? rules.customer_may_cancel : rules.customer_may_reschedule)) {
    return { ok: false, code: 'too_late', message: 'this cannot be changed online — please call us' };
  }
  if (timeOf(appointment.starts_at) - now.getTime() < rules.customer_change_cutoff_minutes * MINUTE) {
    return { ok: false, code: 'too_late', message: 'it is too close to the appointment to change it online — please call us' };
  }
  return { ok: true };
}

/**
 * The changes a person in the workspace can make to an appointment right now, in the order
 * the screen offers them. Read off `APPOINTMENT_TRANSITIONS`, whose calendar it is, and the
 * clock — the screen draws exactly these buttons, and the server refuses anything else.
 */
export function nextActions(
  appointment: { status: string; starts_at: string; sync_state?: string },
  authority: BookingAuthority,
  now: Date,
): AppointmentAction[] {
  if (appointment.sync_state === 'conflict') return ['assign'];
  const started = timeOf(appointment.starts_at) <= now.getTime();
  const out: AppointmentAction[] = [];
  if (authority.status_owner === 'arc') {
    for (const action of ['confirm', 'decline', 'complete', 'no_show', 'cancel'] as const) {
      const to = ACTION_STATUS[action]!;
      if (!APPOINTMENT_TRANSITIONS.some(([a, b]) => a === appointment.status && b === to)) continue;
      if ((action === 'complete' || action === 'no_show') && !started) continue;
      out.push(action);
    }
  }
  if (authority.time_owner === 'arc' && (HELD_STATUSES as readonly string[]).includes(appointment.status)) out.push('reschedule');
  if ((HELD_STATUSES as readonly string[]).includes(appointment.status)) out.push('assign');
  return out;
}

/* ── the calendar, as days ──────────────────────────────── */

/** appointments grouped by the business's own calendar day, each day in time order. */
export function agendaDays<T extends { starts_at: string }>(appointments: readonly T[], timezone: string): { date: string; appointments: T[] }[] {
  const days = new Map<string, T[]>();
  for (const a of [...appointments].sort((x, y) => timeOf(x.starts_at) - timeOf(y.starts_at))) {
    const date = localDate(new Date(timeOf(a.starts_at)), timezone);
    days.set(date, [...(days.get(date) ?? []), a]);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, appointments: list }));
}
