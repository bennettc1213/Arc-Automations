/**
 * ARC-380 — the booking service: every read and write of a client's booking rules, appointment
 * types, booking pages and appointments goes through here.
 *
 *   the workspace    `getBookingOverview`, `getRecordBooking`, `getAvailability`,
 *                    `bookAppointment`, `changeAppointment`, `reconcileAppointment`
 *   the setup        `saveSettings`, `saveAppointmentType`, `saveBookingPage`, `setPageStatus`
 *   a stranger       `publicBookingPage`, `publicSlots`, `submitBooking`      nobody signed in
 *   their own link   `manageView`, `manageChange`                             the booking's customer
 *   their calendar   `reportExternalAppointment`                              a connector, as `external`
 *
 * Each function is the same steps, in this order: may this actor do this for this tenant
 * (ARC-340's `can`), is the input well formed (`model.ts`), is this side the authority for
 * what would change (`writeDecision`, over the `appointment` policy), and then one SQL
 * function — `crm_book_appointment`, `crm_appointment_change`, `crm_appointment_external_report`
 * or `crm_appointment_reconcile` (0027) — which checks all of it again under a lock and writes
 * the appointment, its history and the lead's timeline together.
 *
 * What is offered as free is computed here from a read; what is actually free is decided by
 * 0027's guard. So a time two people chose at once is a booking and a refusal, and the page
 * that lost says "that time has just been taken".
 *
 * Nothing here sends a message, starts a run or writes `events`. A confirmed appointment is a
 * calendar entry; it is not counted anywhere as a result.
 */

import { actorStamp, can, type CrmActor, type CrmPermission, effectivePolicy, type FieldError, secretProblem, writeDecision } from '../crm/model.ts';
import { type CrmErrorCode, type CrmOutcome, type CrmStore, CrmStoreError, type Row, type RowQuery } from '../crm/service.ts';
import { peopleFor, type Person } from '../crm/workspace.ts';
import { parseAttribution } from '../intake/model.ts';
import { randomKey, sha256Hex } from '../intake/service.ts';
import {
  addDays,
  type AppointmentChange,
  appointmentAuthority,
  availableSlots,
  type BookableType,
  BOOKING_KEY,
  BOOKING_LIMITS,
  bookingMode,
  type BookingRules,
  customerChangeDecision,
  type Decision,
  HELD_STATUSES,
  type HeldTime,
  isOffered,
  localDate,
  MANAGE_TOKEN,
  PAGE_STATUSES,
  type PageDefinition,
  parseAppointmentTypeInput,
  parseChange,
  parseExternalReport,
  parseInstant,
  parsePageDefinition,
  parsePageInput,
  parseSettingsInput,
  parseStaffBooking,
  parseSubmission,
  serviceAreaDecision,
  type Slot,
  spamVerdict,
  timeOf,
  unavailableReason,
} from './model.ts';

/* ── the store ──────────────────────────────────────────── */

export const BOOKING_TABLES = [
  'crm_booking_settings', 'crm_appointment_types', 'crm_booking_pages',
  'crm_appointments', 'crm_appointment_links', 'crm_appointment_events',
] as const;
export type BookingTable = typeof BOOKING_TABLES[number];

export interface BookingQuery extends RowQuery {
  /** rows whose column is later than this instant. */
  after?: [column: string, iso: string];
  /** rows whose column is earlier than this instant. */
  before?: [column: string, iso: string];
}

export interface BookResult {
  outcome: 'booked' | 'replayed';
  appointment: Row;
  contact_id: string;
  lead_id: string | null;
}

export interface ReportResult {
  outcome: 'created' | 'applied' | 'unchanged' | 'stale' | 'conflict';
  appointment: Row;
}

/** Tenant-scoped like ARC-340's store, except the two lookups a public request starts from. */
export interface BookingStore {
  rows(table: BookingTable, tenantId: string, query?: BookingQuery): Promise<Row[]>;
  row(table: BookingTable, tenantId: string, id: string): Promise<Row | null>;
  insert(table: BookingTable, row: Row): Promise<Row>;
  update(table: BookingTable, tenantId: string, id: string, patch: Row): Promise<Row | null>;
  /** the one settings row a client has: made on the first save, changed after. */
  saveSettings(tenantId: string, patch: Row): Promise<Row>;
  /** 0027's crm_booking_rules: the settings or their defaults, the hours, the timezone, whose calendar it is. */
  rules(tenantId: string): Promise<BookingRules | null>;
  /** the page a public key names, whoever's it is. the key is all a browser has. */
  pageByPublicKey(publicKey: string): Promise<Row | null>;
  /** the link a customer's token hashes to, whoever's it is. */
  linkByTokenHash(hash: string): Promise<Row | null>;
  book(tenantId: string, booking: Row): Promise<BookResult>;
  change(tenantId: string, appointmentId: string, change: Row, actorType: string, actorId: string | null): Promise<Row>;
  externalReport(tenantId: string, report: Row): Promise<ReportResult>;
  reconcile(tenantId: string, appointmentId: string, resolution: string, actorType: string, actorId: string | null): Promise<Row>;
}

export interface BookingDeps {
  crm: CrmStore;
  booking: BookingStore;
  now?: () => Date;
}

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const asObject = (raw: unknown): Row => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {});
const DAY = 86_400_000;

type Refusal = { ok: false; code: CrmErrorCode; message: string; fieldErrors?: FieldError[] };
const refuse = (code: CrmErrorCode, message: string): Refusal => ({ ok: false, code, message });
const invalid = (errors: FieldError[]): Refusal => ({
  ok: false, code: 'invalid', message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: errors,
});

/** the permission, the tenant, and a store refusal turned into an outcome. */
async function act<T>(
  deps: BookingDeps,
  actor: CrmActor | null,
  permission: CrmPermission,
  tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor, tenant: Row) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  const allowed = can(actor, permission, tenantId);
  if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
  try {
    const tenant = await deps.crm.getTenant(tenantId);
    if (!tenant) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor, tenant);
  } catch (error) {
    if (error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

const iso = (value: unknown): string => new Date(timeOf(value)).toISOString();

/** an appointment as the screens read it: the row, with every time in one spelling. */
function shown(row: Row): Row {
  const out: Row = { ...row };
  for (const key of ['starts_at', 'ends_at', 'busy_from', 'busy_until', 'confirmed_at', 'closed_at', 'last_synced_at', 'created_at', 'updated_at']) {
    if (out[key] !== null && out[key] !== undefined) out[key] = iso(out[key]);
  }
  return out;
}

const asBookable = (type: Row): BookableType & { service_id: string | null } => ({
  id: type.id, key: type.key, name: type.name, description: type.description ?? null, duration_minutes: type.duration_minutes,
  buffer_before_minutes: type.buffer_before_minutes ?? null, buffer_after_minutes: type.buffer_after_minutes ?? null,
  requires_approval: type.requires_approval === true, service_id: type.service_id ?? null,
});

/** an appointment's own length and buffers, as a type — what a move of it has to fit. */
const asItsOwnType = (appointment: Row) => ({
  duration_minutes: Math.round((timeOf(appointment.ends_at) - timeOf(appointment.starts_at)) / 60_000),
  buffer_before_minutes: Math.round((timeOf(appointment.starts_at) - timeOf(appointment.busy_from)) / 60_000),
  buffer_after_minutes: Math.round((timeOf(appointment.busy_until) - timeOf(appointment.ends_at)) / 60_000),
});

async function rulesFor(deps: BookingDeps, tenantId: string): Promise<BookingRules> {
  const rules = await deps.booking.rules(tenantId);
  if (!rules) throw new CrmStoreError('not_found', 'this client does not exist');
  return rules;
}

/** the appointments holding a time anywhere near `[from, to]`. */
async function heldBetween(deps: BookingDeps, tenantId: string, from: number, to: number): Promise<HeldTime[]> {
  const rows = await deps.booking.rows('crm_appointments', tenantId, {
    in: ['status', [...HELD_STATUSES]],
    after: ['busy_until', new Date(from - DAY).toISOString()],
    before: ['busy_from', new Date(to + DAY).toISOString()],
    limit: 2000,
  });
  return rows.map((r) => ({ id: r.id, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), busy_from: iso(r.busy_from), busy_until: iso(r.busy_until) }));
}

async function policyFor(deps: BookingDeps, tenantId: string) {
  const rows = await deps.crm.rows('crm_source_policies', tenantId, { eq: { object_type: 'appointment' } });
  return effectivePolicy(rows[0], 'appointment');
}

export interface BookingViewer {
  kind: 'operator' | 'client_user';
  user_id: string;
  may: { book: boolean; setup: boolean; reconcile: boolean };
}

function viewerOf(actor: CrmActor, tenantId: string): BookingViewer {
  const allowed = (p: CrmPermission) => can(actor, p, tenantId).ok;
  return {
    kind: actor.kind === 'operator' ? 'operator' : 'client_user',
    user_id: actor.kind === 'operator' || actor.kind === 'client_user' ? actor.userId : '',
    may: { book: allowed('record'), setup: allowed('business'), reconcile: allowed('sensitive') },
  };
}

async function contactsFor(deps: BookingDeps, tenantId: string, appointments: Row[]): Promise<Row[]> {
  const ids = [...new Set(appointments.map((a) => a.contact_id).filter(Boolean))];
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    out.push(...await deps.crm.rows('crm_contacts', tenantId, { in: ['id', ids.slice(i, i + 100)] }));
  }
  return out.map((c) => ({ id: c.id, display_name: c.display_name, phone: c.phone ?? null, email: c.email ?? null }));
}

/* ── the workspace: reads ───────────────────────────────── */

export interface BookingOverview {
  tenant: { id: string; name: string; timezone: string };
  rules: BookingRules;
  /** `slots`: ARC offers times. `request`: their calendar owns the time, and ARC offers none. */
  mode: 'slots' | 'request';
  /** why nothing can be offered at all, or null. */
  unavailable: ReturnType<typeof unavailableReason>;
  types: Row[];
  pages: Row[];
  /** the last week and everything ahead that is on the calendar, in time order. */
  appointments: Row[];
  contacts: Row[];
  people: Person[];
  services: Row[];
  viewer: BookingViewer;
  truncated: boolean;
  read_at: string;
}

const OVERVIEW_LIMIT = 500;

export function getBookingOverview(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<BookingOverview>> {
  return act(deps, actor, 'read', tenantId, async (id, who, tenant) => {
    const now = deps.now?.() ?? new Date();
    const [rules, types, pages, appointments, services] = await Promise.all([
      rulesFor(deps, id),
      deps.booking.rows('crm_appointment_types', id, { order: ['created_at', 'asc'] }),
      deps.booking.rows('crm_booking_pages', id, { order: ['created_at', 'desc'] }),
      deps.booking.rows('crm_appointments', id, {
        after: ['starts_at', new Date(now.getTime() - 7 * DAY).toISOString()], order: ['starts_at', 'asc'], limit: OVERVIEW_LIMIT,
      }),
      deps.crm.rows('business_services', id, { isNull: ['archived_at'], order: ['key', 'asc'] }),
    ]);
    const live = types.filter((t) => !t.archived_at);
    return {
      ok: true,
      result: {
        tenant: { id, name: tenant.name, timezone: tenant.timezone },
        rules,
        mode: bookingMode(rules.authority),
        unavailable: unavailableReason(rules, live),
        types,
        pages,
        appointments: appointments.map(shown),
        contacts: await contactsFor(deps, id, appointments),
        people: await peopleFor(deps, id, who, appointments.map((a) => a.assigned_user_id).filter(Boolean)),
        services: services.map((s) => ({ id: s.id, key: s.key, name: s.name, default_duration_minutes: s.default_duration_minutes ?? null })),
        viewer: viewerOf(who, id),
        truncated: appointments.length >= OVERVIEW_LIMIT,
        read_at: now.toISOString(),
      },
    };
  });
}

export interface RecordBooking {
  rules: BookingRules;
  mode: 'slots' | 'request';
  unavailable: ReturnType<typeof unavailableReason>;
  /** the types a person can book: the live ones, public or not. */
  types: Row[];
  /** this lead's or this customer's appointments, newest first. */
  appointments: Row[];
  /** what happened to each, in order: who, when, from which door. */
  events: Row[];
  people: Person[];
  viewer: BookingViewer;
  read_at: string;
}

/** One lead's or one customer's appointments, with what is needed to book another. */
export function getRecordBooking(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, by: { lead_id?: unknown; contact_id?: unknown }): Promise<CrmOutcome<RecordBooking>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const filter = isId(by.lead_id) ? { lead_id: by.lead_id } : isId(by.contact_id) ? { contact_id: by.contact_id } : null;
    if (!filter) return invalid([{ field: 'lead_id', message: 'name the lead or the customer' }]);
    const [rules, types, appointments] = await Promise.all([
      rulesFor(deps, id),
      deps.booking.rows('crm_appointment_types', id, { isNull: ['archived_at'], order: ['created_at', 'asc'] }),
      deps.booking.rows('crm_appointments', id, { eq: filter, order: ['starts_at', 'desc'], limit: 50 }),
    ]);
    const ids = appointments.map((a) => a.id as string);
    const events = ids.length > 0
      ? await deps.booking.rows('crm_appointment_events', id, { in: ['appointment_id', ids], order: ['occurred_at', 'asc'], limit: 500 })
      : [];
    const named = [...appointments.map((a) => a.assigned_user_id), ...events.map((e) => e.actor_id)].filter(Boolean);
    return {
      ok: true,
      result: {
        rules,
        mode: bookingMode(rules.authority),
        unavailable: unavailableReason(rules, types),
        types,
        appointments: appointments.map(shown),
        events: events.map((e) => ({ ...e, occurred_at: iso(e.occurred_at) })),
        people: await peopleFor(deps, id, who, named),
        viewer: viewerOf(who, id),
        read_at: (deps.now?.() ?? new Date()).toISOString(),
      },
    };
  });
}

export interface Availability {
  mode: 'slots' | 'request';
  timezone: string;
  from: string;
  days: number;
  slots: Slot[];
  unavailable: ReturnType<typeof unavailableReason>;
}

interface AvailabilityAsk { appointment_type_id?: unknown; appointment_id?: unknown; from?: unknown; days?: unknown }

async function availabilityFor(deps: BookingDeps, tenantId: string, rules: BookingRules, type: Pick<BookableType, 'duration_minutes' | 'buffer_before_minutes' | 'buffer_after_minutes'>, ask: { from?: unknown; days?: unknown }, excludeId: string | null, skipStart: string | null = null): Promise<Availability> {
  const now = deps.now?.() ?? new Date();
  const today = localDate(now, rules.timezone);
  const from = typeof ask.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ask.from) && ask.from >= today ? ask.from : today;
  const days = typeof ask.days === 'number' && Number.isInteger(ask.days) ? Math.max(1, Math.min(ask.days, BOOKING_LIMITS.daysPerRead)) : 7;
  const mode = bookingMode(rules.authority);
  const unavailable = unavailableReason(rules, [type]);
  if (mode === 'request' || unavailable) return { mode, timezone: rules.timezone, from, days, slots: [], unavailable };
  const start = Date.parse(`${from}T00:00:00Z`);
  const held = await heldBetween(deps, tenantId, start - DAY, start + (days + 1) * DAY);
  const slots = availableSlots({ rules, type, held, now, from, days, excludeId });
  return { mode, timezone: rules.timezone, from, days, slots: skipStart ? slots.filter((slot) => slot.starts_at !== skipStart) : slots, unavailable: null };
}

/** The times a person in the workspace can choose from: for a type, or for moving one appointment. */
export function getAvailability(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, ask: AvailabilityAsk): Promise<CrmOutcome<Availability>> {
  return act(deps, actor, 'read', tenantId, async (id) => {
    const rules = await rulesFor(deps, id);
    if (isId(ask.appointment_id)) {
      const appointment = await deps.booking.row('crm_appointments', id, ask.appointment_id);
      if (!appointment) return refuse('not_found', 'no such appointment for this client');
      /* its own time does not block it, and is not offered back to it as somewhere to move. */
      return { ok: true, result: await availabilityFor(deps, id, rules, asItsOwnType(appointment), ask, appointment.id, iso(appointment.starts_at)) };
    }
    if (!isId(ask.appointment_type_id)) return invalid([{ field: 'appointment_type_id', message: 'choose what the appointment is for' }]);
    const type = await deps.booking.row('crm_appointment_types', id, ask.appointment_type_id);
    if (!type || type.archived_at) return refuse('not_found', 'that kind of appointment is not offered');
    return { ok: true, result: await availabilityFor(deps, id, rules, asBookable(type), ask, null) };
  });
}

/* ── the workspace: writes ──────────────────────────────── */

/** A person books a time for a customer they have on file, from the lead or the calendar. */
export function bookAppointment(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<BookResult>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseStaffBooking(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const booking = parsed.value;
    const allowed = writeDecision(await policyFor(deps, id), who, 'create', ['starts_at', 'ends_at', 'status']);
    if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);

    let contactId = booking.contact_id;
    if (booking.lead_id) {
      const lead = await deps.crm.row('crm_leads', id, booking.lead_id);
      if (!lead) return refuse('not_found', 'no such lead for this client');
      if (contactId && lead.contact_id !== contactId) return invalid([{ field: 'lead_id', message: "is not this customer's lead" }]);
      contactId = lead.contact_id;
    }
    const { type, id: actorId } = actorStamp(who);
    const result = await deps.booking.book(id, {
      actor_type: type,
      actor_id: actorId,
      appointment_type_id: booking.appointment_type_id,
      starts_at: booking.starts_at,
      contact_id: contactId,
      lead_id: booking.lead_id,
      address_line1: booking.address_line1,
      city: booking.city,
      region: booking.region,
      postal_code: booking.postal_code,
      customer_note: booking.customer_note,
      assigned_user_id: booking.assigned_user_id,
      enforce_rules: !booking.outside_rules,
    });
    return { ok: true, result: { ...result, appointment: shown(result.appointment) } };
  });
}

const STATUS_ACTIONS = ['confirm', 'decline', 'cancel', 'complete', 'no_show'];

/** Confirm, decline, cancel, close, move or hand over one appointment. */
export function changeAppointment(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, appointmentId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    if (!isId(appointmentId)) return refuse('not_found', 'no such appointment for this client');
    const parsed = parseChange(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const change: AppointmentChange = parsed.value;
    const fields = change.action === 'reschedule' ? ['starts_at', 'ends_at'] : STATUS_ACTIONS.includes(change.action) ? ['status'] : [];
    const allowed = writeDecision(await policyFor(deps, id), who, 'update', fields);
    if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
    const { type, id: actorId } = actorStamp(who);
    const row = await deps.booking.change(id, appointmentId, {
      action: change.action,
      starts_at: change.starts_at,
      reason: change.reason,
      assigned_user_id: change.assigned_user_id,
      changed_via: 'workspace',
      enforce_rules: !change.outside_rules,
    }, type, actorId);
    return { ok: true, result: shown(row) };
  });
}

/** The account owner or an operator settles a disagreement with their calendar. */
export function reconcileAppointment(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, appointmentId: unknown, resolution: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'sensitive', tenantId, async (id, who) => {
    if (!isId(appointmentId)) return refuse('not_found', 'no such appointment for this client');
    if (resolution !== 'keep_ours' && resolution !== 'accept_theirs') return invalid([{ field: 'resolution', message: 'is keep_ours or accept_theirs' }]);
    const { type, id: actorId } = actorStamp(who);
    return { ok: true, result: shown(await deps.booking.reconcile(id, appointmentId, resolution, type, actorId)) };
  });
}

/* ── the setup ──────────────────────────────────────────── */

export function saveSettings(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<BookingRules>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const parsed = parseSettingsInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const { type, id: actorId } = actorStamp(who);
    await deps.booking.saveSettings(id, { ...parsed.value, updated_by_type: type, updated_by: actorId });
    return { ok: true, result: await rulesFor(deps, id) };
  });
}

export function saveAppointmentType(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown, typeId?: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const creating = typeId === undefined || typeId === null;
    const parsed = parseAppointmentTypeInput(input, { partial: !creating });
    if (!parsed.ok) return invalid(parsed.errors);
    const { type, id: actorId } = actorStamp(who);
    const stamp = { updated_by_type: type, updated_by: actorId };
    if (creating) return { ok: true, result: await deps.booking.insert('crm_appointment_types', { tenant_id: id, ...parsed.value, ...stamp }) };
    if (!isId(typeId)) return refuse('not_found', 'no such appointment type for this client');
    const row = await deps.booking.update('crm_appointment_types', id, typeId, { ...parsed.value, ...stamp });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such appointment type for this client');
  });
}

/** Create a booking page (a draft, with a new link) or change one. Publishing is `setPageStatus`. */
export function saveBookingPage(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown, pageId?: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const creating = pageId === undefined || pageId === null;
    const parsed = parsePageInput(input, { partial: !creating });
    if (!parsed.ok) return invalid(parsed.errors);
    const { type, id: actorId } = actorStamp(who);
    const stamp = { updated_by_type: type, updated_by: actorId };
    if (creating) {
      return { ok: true, result: await deps.booking.insert('crm_booking_pages', { tenant_id: id, public_key: `arcb_${randomKey(32)}`, ...parsed.value, ...stamp }) };
    }
    if (!isId(pageId)) return refuse('not_found', 'no such booking page for this client');
    if (Object.keys(parsed.value).length === 0) return invalid([{ field: 'page', message: 'nothing to change' }]);
    const row = await deps.booking.update('crm_booking_pages', id, pageId, { ...parsed.value, ...stamp });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such booking page for this client');
  });
}

/** draft → published → archived, and back to draft. Only a published page takes bookings. */
export function setPageStatus(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, pageId: unknown, status: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    if (!isId(pageId)) return refuse('not_found', 'no such booking page for this client');
    if (typeof status !== 'string' || !(PAGE_STATUSES as readonly string[]).includes(status)) {
      return invalid([{ field: 'status', message: `is one of: ${PAGE_STATUSES.join(', ')}` }]);
    }
    const { type, id: actorId } = actorStamp(who);
    const row = await deps.booking.update('crm_booking_pages', id, pageId, { status, updated_by_type: type, updated_by: actorId });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such booking page for this client');
  });
}

/* ── their calendar ─────────────────────────────────────── */

/**
 * What an external calendar says about one entry. The actor is the connector (`external`),
 * and the connector named is the actor's — a payload cannot claim to be another system.
 * A report that disagrees with a field ARC owns comes back `conflict` and changes nothing
 * but the appointment's sync state: a person settles it.
 */
export function reportExternalAppointment(deps: BookingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<ReportResult>> {
  return act(deps, actor, 'mapping', tenantId, async (id, who) => {
    if (who.kind !== 'external') return refuse('forbidden', 'only a connected calendar reports its own entries');
    const parsed = parseExternalReport(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const result = await deps.booking.externalReport(id, { ...parsed.value, connector_key: who.connectorKey });
    return { ok: true, result: { outcome: result.outcome, appointment: shown(result.appointment) } };
  });
}

/* ── the public side: the page ──────────────────────────── */

export interface PublicPageView {
  version: number;
  business: string;
  timezone: string;
  title: string;
  intro: string | null;
  success_message: string;
  address: PageDefinition['address'];
  note: boolean;
  consent: PageDefinition['consent'];
  /** `slots`: choose from the times offered. `request`: ask for a time; the business answers. */
  mode: 'slots' | 'request';
  types: { key: string; name: string; description: string | null; duration_minutes: number; requires_approval: boolean }[];
  /** the business's own calendar date today, and how far ahead bookings are open. */
  today: string;
  last_day: string;
}

interface LoadedPage { row: Row; definition: PageDefinition; tenant: Row; rules: BookingRules; types: (BookableType & { service_id: string | null })[] }

/**
 * The page a key names, with what it can offer — or null, for a key that was never issued, a
 * draft and an archived page alike (`anyStatus` is for a customer's own link, which must keep
 * working after the page that made the booking is retired).
 */
async function loadPage(deps: BookingDeps, publicKey: unknown, opts: { anyStatus?: boolean } = {}): Promise<LoadedPage | null> {
  if (typeof publicKey !== 'string' || !BOOKING_KEY.test(publicKey)) return null;
  const row = await deps.booking.pageByPublicKey(publicKey);
  if (!row || (!opts.anyStatus && row.status !== 'published')) return null;
  const parsed = parsePageDefinition(row.definition);
  const tenant = await deps.crm.getTenant(row.tenant_id);
  if (!parsed.ok || !tenant || tenant.status === 'archived') return null;
  const rules = await deps.booking.rules(row.tenant_id);
  if (!rules) return null;
  const all = await deps.booking.rows('crm_appointment_types', row.tenant_id, { isNull: ['archived_at'], order: ['created_at', 'asc'] });
  const keys = parsed.value.type_keys;
  const types = all.filter((t) => t.is_public === true && (!keys || keys.includes(t.key))).map(asBookable);
  return { row, definition: parsed.value, tenant, rules, types };
}

export async function publicBookingPage(deps: BookingDeps, publicKey: unknown): Promise<PublicPageView | null> {
  const page = await loadPage(deps, publicKey);
  if (!page) return null;
  const today = localDate(deps.now?.() ?? new Date(), page.rules.timezone);
  return {
    version: page.row.version,
    business: page.tenant.name,
    timezone: page.rules.timezone,
    title: page.definition.title,
    intro: page.definition.intro,
    success_message: page.definition.success_message,
    address: page.definition.address,
    note: page.definition.note,
    consent: page.definition.consent,
    mode: bookingMode(page.rules.authority),
    types: page.types.map((t) => ({ key: t.key, name: t.name, description: t.description, duration_minutes: t.duration_minutes, requires_approval: t.requires_approval })),
    today,
    last_day: addDays(today, page.rules.max_days_ahead),
  };
}

async function linkedAppointment(deps: BookingDeps, token: unknown, tenantId: string): Promise<Row | null> {
  if (typeof token !== 'string' || !MANAGE_TOKEN.test(token)) return null;
  const link = await deps.booking.linkByTokenHash(await sha256Hex(token));
  if (!link || link.tenant_id !== tenantId) return null;
  return await deps.booking.row('crm_appointments', tenantId, link.appointment_id);
}

/**
 * The times a page can offer for one of its types — or, with a customer's own token, the
 * times their appointment could move to. Empty, never an error, when nothing can be offered.
 */
export async function publicSlots(deps: BookingDeps, publicKey: unknown, ask: { type?: unknown; from?: unknown; days?: unknown; token?: unknown }): Promise<Availability | null> {
  const moving = ask.token !== undefined && ask.token !== null && ask.token !== '';
  const page = await loadPage(deps, publicKey, { anyStatus: moving });
  if (!page) return null;
  const days = typeof ask.days === 'string' ? Number(ask.days) : ask.days;
  if (moving) {
    const appointment = await linkedAppointment(deps, ask.token, page.row.tenant_id);
    if (!appointment) return null;
    return await availabilityFor(deps, page.row.tenant_id, page.rules, asItsOwnType(appointment), { from: ask.from, days }, appointment.id, iso(appointment.starts_at));
  }
  const type = page.types.find((t) => t.key === ask.type) ?? (page.types.length === 1 && !ask.type ? page.types[0] : null);
  if (!type) return null;
  return await availabilityFor(deps, page.row.tenant_id, page.rules, type, { from: ask.from, days }, null);
}

/* ── the public side: a booking ─────────────────────────── */

export interface PublicBooking {
  /** `requested`: the business will confirm it. `confirmed`: it is in the calendar. */
  status: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  /** the customer's own link to move or cancel. shown once, here. */
  manage_token: string;
}

export type PublicBookingOutcome =
  | { ok: true; discarded: 'honeypot' | 'dwell' | null; outcome: BookResult['outcome'] | null; tenantId: string; booking: PublicBooking }
  | { ok: false; code: 'not_found' | 'invalid' | 'rate_limited' | 'slot_unavailable' | 'outside_service_area'; message: string; fieldErrors?: FieldError[] };

const SUBMISSION_ID = /^[A-Za-z0-9-]{16,64}$/;
const GONE = 'that time is no longer available — please choose another';

/**
 * One booking from a hosted page: `{ values, attribution, submission_id, company_website,
 * rendered_at }`. The two silent checks come first and answer exactly as a real booking does.
 *
 * What a stranger is told is what they need and nothing else: the time they now have, whether
 * it is confirmed or waiting on the business, and their own link. Not the lead, not the
 * customer record, not whether they were already on file.
 */
export async function submitBooking(deps: BookingDeps, publicKey: unknown, body: unknown): Promise<PublicBookingOutcome> {
  const page = await loadPage(deps, publicKey);
  if (!page) return { ok: false, code: 'not_found', message: 'unknown booking page' };
  const tenantId: string = page.row.tenant_id;
  const input = asObject(body);
  const now = deps.now?.() ?? new Date();
  const mode = bookingMode(page.rules.authority);
  const token = `arcm_${randomKey(40)}`;

  const spam = spamVerdict(input, now.getTime());
  if (spam) {
    const values = asObject(input.values);
    const type = page.types.find((t) => t.key === values.type) ?? page.types[0];
    const startsAt = parseInstant(values.starts_at) ?? now.toISOString();
    return {
      ok: true, discarded: spam, outcome: null, tenantId,
      booking: {
        status: mode === 'request' || type?.requires_approval !== false ? 'requested' : 'confirmed',
        title: type?.name ?? page.definition.title,
        starts_at: startsAt,
        ends_at: new Date(Date.parse(startsAt) + (type?.duration_minutes ?? 60) * 60_000).toISOString(),
        timezone: page.rules.timezone,
        /* a link that was never stored: it opens "not found", as any unknown link does. */
        manage_token: token,
      },
    };
  }

  const parsed = parseSubmission(page.definition, input.values, { types: page.types });
  if (!parsed.ok) return { ok: false, code: 'invalid', message: 'some details need another look', fieldErrors: parsed.errors };
  const { type, startsAt, contact, address, note, consent } = parsed.value;
  const serviceId = page.types.find((t) => t.id === type.id)?.service_id ?? null;
  const at = Date.parse(startsAt);

  /* the page makes an id when it renders, so a double click or a retried request is one
     booking. without one, the same person asking for the same time is. */
  const submissionId = typeof input.submission_id === 'string' && SUBMISSION_ID.test(input.submission_id)
    ? input.submission_id
    : (await sha256Hex(JSON.stringify([contact.phone ?? null, contact.email ?? null, type.key, startsAt]))).slice(0, 32);
  const idempotencyKey = `page:${page.row.id}:${submissionId}`;
  /* a retry of a booking that was made: its own time is held — by itself. 0027 answers it. */
  const retry = (await deps.booking.rows('crm_appointments', tenantId, { eq: { idempotency_key: idempotencyKey }, limit: 1 })).length > 0;

  if (retry) {
    /* nothing to check: nothing new will be written. */
  } else if (mode === 'slots') {
    /* offered a moment ago is not the same as offered now. the database decides for certain;
       this says the ordinary "somebody got there first" before a transaction is opened. */
    const held = await heldBetween(deps, tenantId, at, at);
    if (!isOffered({ rules: page.rules, type, held, now }, startsAt)) return { ok: false, code: 'slot_unavailable', message: GONE };
  } else if (at <= now.getTime() || at > now.getTime() + page.rules.max_days_ahead * DAY) {
    return { ok: false, code: 'slot_unavailable', message: 'choose a time in the future, within the dates this page is open for' };
  }

  if (!retry && page.rules.enforce_service_area && page.definition.address !== 'off') {
    const areas = await deps.crm.rows('business_service_areas', tenantId, { isNull: ['archived_at'] });
    if (serviceAreaDecision(areas, address) === 'outside') {
      return { ok: false, code: 'outside_service_area', message: 'that address is outside the area we cover — please call us and we will see what we can do' };
    }
  }

  let detail: Row = {
    booking_page: { name: page.row.name, version: page.row.version },
    appointment: { type: type.key, starts_at: startsAt },
    claimed: parseAttribution(input.attribution),
  };
  if (secretProblem(detail)) detail = { booking_page: detail.booking_page, appointment: detail.appointment, claimed: {} };

  try {
    const result = await deps.booking.book(tenantId, {
      actor_type: 'system',
      idempotency_key: idempotencyKey,
      booking_page_id: page.row.id,
      appointment_type_id: type.id,
      starts_at: startsAt,
      contact,
      lead: { title: type.name, summary: note, service_id: serviceId },
      consent,
      detail,
      dedupe_minutes: page.row.dedupe_minutes,
      address_line1: address.address_line1,
      city: address.city,
      region: address.region,
      postal_code: address.postal_code,
      customer_note: note,
      manage_token_hash: await sha256Hex(token),
    });
    const a = result.appointment;
    return {
      ok: true, discarded: null, outcome: result.outcome, tenantId,
      booking: { status: a.status, title: a.title, starts_at: iso(a.starts_at), ends_at: iso(a.ends_at), timezone: a.timezone, manage_token: token },
    };
  } catch (error) {
    if (error instanceof CrmStoreError) {
      if (error.code === 'slot_taken' || error.code === 'slot_unavailable') return { ok: false, code: 'slot_unavailable', message: GONE };
      if (error.code === 'rate_limited') return { ok: false, code: 'rate_limited', message: 'this page is busy — please try again later, or call us' };
      if (error.code === 'not_found') return { ok: false, code: 'not_found', message: 'unknown booking page' };
    }
    throw error;
  }
}

/* ── the public side: the customer's own link ───────────── */

export interface ManageView {
  business: string;
  timezone: string;
  mode: 'slots' | 'request';
  appointment: { status: string; title: string; starts_at: string; ends_at: string; address_line1: string | null; city: string | null; requires_approval: boolean };
  /** what this link may do right now, and the reason when it may not. */
  can: { cancel: Decision; reschedule: Decision };
}

async function manageContext(deps: BookingDeps, publicKey: unknown, token: unknown): Promise<{ page: LoadedPage; appointment: Row } | null> {
  const page = await loadPage(deps, publicKey, { anyStatus: true });
  if (!page) return null;
  const appointment = await linkedAppointment(deps, token, page.row.tenant_id);
  return appointment ? { page, appointment } : null;
}

function manageViewOf(deps: BookingDeps, page: LoadedPage, appointment: Row): ManageView {
  const now = deps.now?.() ?? new Date();
  const a = shown(appointment);
  return {
    business: page.tenant.name,
    timezone: a.timezone,
    mode: bookingMode(page.rules.authority),
    appointment: {
      status: a.status, title: a.title, starts_at: a.starts_at, ends_at: a.ends_at,
      address_line1: a.address_line1 ?? null, city: a.city ?? null, requires_approval: a.requires_approval === true,
    },
    can: {
      cancel: customerChangeDecision(page.rules, a, 'cancel', now),
      reschedule: customerChangeDecision(page.rules, a, 'reschedule', now),
    },
  };
}

/** The appointment a customer's link is for, or null — for a wrong, mistyped or made-up link alike. */
export async function manageView(deps: BookingDeps, publicKey: unknown, token: unknown): Promise<ManageView | null> {
  const found = await manageContext(deps, publicKey, token);
  return found ? manageViewOf(deps, found.page, found.appointment) : null;
}

export type ManageOutcome =
  | { ok: true; view: ManageView; tenantId: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'too_late' | 'slot_unavailable' | 'conflict'; message: string };

/** A customer moves or cancels their own appointment: `{ action: cancel | reschedule, starts_at?, reason? }`. */
export async function manageChange(deps: BookingDeps, publicKey: unknown, token: unknown, body: unknown): Promise<ManageOutcome> {
  const found = await manageContext(deps, publicKey, token);
  if (!found) return { ok: false, code: 'not_found', message: 'unknown link' };
  const { page, appointment } = found;
  const tenantId: string = page.row.tenant_id;
  const input = asObject(body);
  const now = deps.now?.() ?? new Date();
  if (input.action !== 'cancel' && input.action !== 'reschedule') return { ok: false, code: 'invalid', message: 'choose to move or to cancel the appointment' };
  const parsed = parseChange({ action: input.action, starts_at: input.starts_at, reason: input.reason });
  if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; ') };

  const decision = customerChangeDecision(page.rules, shown(appointment), input.action, now);
  if (!decision.ok) return { ok: false, code: decision.code === 'conflict' ? 'conflict' : 'too_late', message: decision.message };

  if (parsed.value.action === 'reschedule') {
    const at = Date.parse(parsed.value.starts_at!);
    const held = await heldBetween(deps, tenantId, at, at);
    if (!isOffered({ rules: page.rules, type: asItsOwnType(appointment), held, now, excludeId: appointment.id }, parsed.value.starts_at!)) {
      return { ok: false, code: 'slot_unavailable', message: GONE };
    }
  }

  try {
    const row = await deps.booking.change(tenantId, appointment.id, {
      action: parsed.value.action, starts_at: parsed.value.starts_at, reason: parsed.value.reason, changed_via: 'manage_link',
    }, 'system', null);
    return { ok: true, view: manageViewOf(deps, page, row), tenantId };
  } catch (error) {
    if (error instanceof CrmStoreError) {
      if (error.code === 'slot_taken' || error.code === 'slot_unavailable') return { ok: false, code: 'slot_unavailable', message: GONE };
      if (error.code === 'too_late' || error.code === 'external_authority' || error.code === 'needs_reconciliation') {
        return { ok: false, code: 'too_late', message: 'this cannot be changed online — please call us' };
      }
      if (error.code === 'conflict' || error.code === 'invalid_transition') return { ok: false, code: 'conflict', message: error.message };
      if (error.code === 'not_found') return { ok: false, code: 'not_found', message: 'unknown link' };
    }
    throw error;
  }
}
