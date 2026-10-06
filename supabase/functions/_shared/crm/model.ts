/**
 * ARC-340 — the universal CRM core: what a contact, a lead and a business profile are, who
 * may change one, and which side is the authority for it.
 *
 * **Portal-safe.** No database, no network, no Deno API; the imports below are themselves
 * portal-safe. A screen can check a form with the same functions the service uses, and
 * `0023_crm_core.sql` checks the same things a third time where it cannot be skipped. The
 * vocabularies here are drift-tested against that migration's check constraints.
 *
 * One model for all three routes (`routes/model.ts`). On ARC Native these rows are the CRM.
 * On Hybrid and Connected they are ARC's normalised working copy of records that live in the
 * client's own system, each tied to its counterpart by an external mapping, under a
 * source-of-truth policy per kind of record. `writeDecision` is that policy applied: a write
 * from the side that does not own the field is refused — never merged, and never "latest wins".
 *
 * Three things this model deliberately does not carry:
 *   - consent or opt-out. Whether an address may be messaged is `suppressions` and the
 *     engine's rules, read when sending. `contactSafety` reports it; nothing stores a copy.
 *   - the business's name or timezone. Those are the tenant's, already.
 *   - a credential, in any field (`secretProblem`).
 */

import { looksSecret } from '../connections/redact.ts';
import { normaliseEmail, normalisePhone } from '../phone.ts';
import { parseRouteKey, type RouteKey } from '../routes/model.ts';

/* ── vocabularies (mirrored by 0023's check constraints) ── */

export const ACTOR_TYPES = ['operator', 'client_user', 'system', 'external'] as const;
export type ActorType = typeof ACTOR_TYPES[number];

export const LEAD_SOURCES = [
  'missed_call', 'inbound_call', 'inbound_sms', 'inbound_email', 'web_form',
  'manual', 'import', 'webhook', 'referral', 'external_system', 'other',
] as const;
export type LeadSource = typeof LEAD_SOURCES[number];

export const ACTIVITY_TYPES = [
  'contact_created', 'contact_updated', 'contact_archived', 'contact_restored',
  'contact_merged', 'contact_owner_changed',
  'lead_created', 'lead_updated', 'lead_stage_changed', 'lead_owner_changed',
  'lead_archived', 'lead_restored',
  'note_added', 'note_archived',
  'task_created', 'task_updated', 'task_completed', 'task_cancelled', 'task_reopened',
  'mapping_added', 'mapping_removed',
] as const;

/* 0023's six, and — since ARC-380 (0027) — an appointment. */
export const OBJECT_TYPES = ['contact', 'lead', 'task', 'note', 'location', 'service', 'appointment'] as const;
export type ObjectType = typeof OBJECT_TYPES[number];

export const AUTHORITIES = ['arc', 'external', 'hybrid'] as const;
export type Authority = typeof AUTHORITIES[number];

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
/** ARC-360 (0025): who a lead in an open stage is waiting on. a closed stage waits on nobody. */
export const STAGE_WAITS = ['us', 'customer'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const VALUE_SOURCES = ['customer_provided', 'operator_entered', 'external_system', 'price_book'] as const;
export const TASK_KINDS = ['follow_up', 'call', 'visit', 'other'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const CONTACT_CHANNELS = ['phone', 'sms', 'email'] as const;
export const AREA_KINDS = ['postal_code', 'city', 'county', 'region', 'radius_miles'] as const;
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * The fields of each record that a client's own system could be the authority for. Anything
 * else on the row — who owns it in ARC, whether it is archived, which engine lead it points
 * at — is ARC's working state on every route and is never handed over.
 */
export const POLICY_FIELDS: Readonly<Record<ObjectType, readonly string[]>> = Object.freeze({
  contact: ['display_name', 'first_name', 'last_name', 'phone', 'email', 'preferred_channel',
    'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country'],
  lead: ['title', 'summary', 'service_id', 'service_category_id', 'stage_id', 'priority',
    'estimated_value_cents', 'closed_reason'],
  task: ['title', 'detail', 'due_at', 'status', 'assigned_user_id', 'kind'],
  note: ['body'],
  location: ['name', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'phone'],
  service: ['name', 'description', 'default_duration_minutes', 'category_id'],
  /* whose calendar it is: the time, and whether the appointment stands. who has it in ARC
     (`assigned_user_id`) and how it stands against their calendar are ARC's working state. */
  appointment: ['starts_at', 'ends_at', 'status', 'title', 'service_id', 'location_id',
    'address_line1', 'city', 'region', 'postal_code', 'customer_note'],
});

/* ── who is acting ──────────────────────────────────────── */

export type CrmActor =
  | { kind: 'operator'; userId: string }
  | { kind: 'client_user'; userId: string; tenantId: string; role: 'owner' | 'staff' }
  /** ARC's own intake: a call, a form, an import. nobody typed it. */
  | { kind: 'system' }
  /** a sync from the client's system, through one connector. */
  | { kind: 'external'; connectorKey: string };

export const CRM_PERMISSIONS = ['read', 'record', 'sensitive', 'business', 'policy', 'mapping'] as const;
export type CrmPermission = typeof CRM_PERMISSIONS[number];

export type Decision = { ok: true } | { ok: false; code: string; message: string };

/**
 * What an actor may do for one tenant.
 *
 *   read       see the tenant's records
 *   record     create and edit contacts, leads, notes and tasks
 *   sensitive  merge, archive, restore, or hand a record to another owner
 *   business   the business profile, locations, services and pipelines
 *   policy     the route and who is the authority for what — an operator's decision
 *   mapping    tie a record to its counterpart in an external system
 *
 * A client user never reaches another tenant: this is checked before anything is read.
 */
export function can(actor: CrmActor | null, permission: CrmPermission, tenantId: string): Decision {
  if (!actor) return { ok: false, code: 'unauthorized', message: 'not signed in' };
  if (actor.kind === 'operator') return { ok: true };
  if (actor.kind === 'client_user') {
    if (actor.tenantId !== tenantId) return { ok: false, code: 'forbidden', message: 'this record belongs to another client' };
    if (permission === 'read' || permission === 'record') return { ok: true };
    if ((permission === 'sensitive' || permission === 'business') && actor.role === 'owner') return { ok: true };
    return {
      ok: false,
      code: 'forbidden',
      message: permission === 'policy' || permission === 'mapping'
        ? 'this is set up by ARC'
        : 'only the account owner can do this',
    };
  }
  /* system and external never read on anybody's behalf and never decide policy. */
  if (permission === 'record' || permission === 'mapping') return { ok: true };
  return { ok: false, code: 'forbidden', message: `${actor.kind} writes may not do this` };
}

export function actorStamp(actor: CrmActor): { type: ActorType; id: string | null } {
  return { type: actor.kind, id: actor.kind === 'operator' || actor.kind === 'client_user' ? actor.userId : null };
}

/* ── the authority for a record ─────────────────────────── */

export interface SourcePolicy {
  objectType: ObjectType;
  authority: Authority;
  connectorKey: string | null;
  /** hybrid only. a field not named is ARC's. */
  fieldOwners: Record<string, 'arc' | 'external'>;
}

/** no row is ARC: a record ARC made is ARC's until an operator says otherwise. */
export function effectivePolicy(row: Record<string, unknown> | null | undefined, objectType: ObjectType): SourcePolicy {
  if (!row) return { objectType, authority: 'arc', connectorKey: null, fieldOwners: {} };
  return {
    objectType,
    authority: row.authority as Authority,
    connectorKey: (row.connector_key as string | null) ?? null,
    fieldOwners: { ...((row.field_owners as Record<string, 'arc' | 'external'>) ?? {}) },
  };
}

/** which side owns one field under a policy. */
export function fieldOwner(policy: SourcePolicy, field: string): 'arc' | 'external' {
  if (!POLICY_FIELDS[policy.objectType].includes(field)) return 'arc';
  if (policy.authority === 'arc') return 'arc';
  if (policy.authority === 'external') return 'external';
  return policy.fieldOwners[field] ?? 'arc';
}

/**
 * May this actor write these fields of this kind of record?
 *
 * The owning side writes; the other side is refused, with the fields named. There is one
 * exception, and it is not an edit: ARC's own intake (`system`) may always *create* a
 * record — a missed call happened on ARC's number whoever owns the customer list, and the
 * arrival is ARC's evidence. It may not then change a field the other side owns.
 */
export function writeDecision(
  policy: SourcePolicy,
  actor: CrmActor,
  op: 'create' | 'update',
  fields: readonly string[],
): Decision {
  const side: 'arc' | 'external' = actor.kind === 'external' ? 'external' : 'arc';
  if (side === 'external') {
    if (policy.authority === 'arc') {
      return { ok: false, code: 'arc_authority', message: `ARC is the authority for this client's ${policy.objectType} records — an external system cannot write them` };
    }
    if (policy.connectorKey && actor.kind === 'external' && actor.connectorKey !== policy.connectorKey) {
      return { ok: false, code: 'arc_authority', message: `${policy.connectorKey} is the system these records come from, not ${actor.connectorKey}` };
    }
  }
  if (op === 'create' && actor.kind === 'system') return { ok: true };
  const blocked = fields.filter((f) => POLICY_FIELDS[policy.objectType].includes(f) && fieldOwner(policy, f) !== side);
  if (blocked.length === 0 && !(op === 'create' && side === 'arc' && policy.authority === 'external')) return { ok: true };
  if (side === 'arc') {
    const where = policy.connectorKey ?? 'the connected system';
    return {
      ok: false,
      code: 'external_authority',
      message: blocked.length > 0
        ? `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} kept in ${where} for this client — change ${blocked.length === 1 ? 'it' : 'them'} there`
        : `this client's ${policy.objectType} records are created in ${where}`,
    };
  }
  return { ok: false, code: 'arc_authority', message: `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} kept in ARC for this client` };
}

/* ── parsing ────────────────────────────────────────────── */

export interface FieldError { field: string; message: string }
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

type Raw = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{1,40}$/;

/* 0023's crm_text_is_clean, plus the shapes ARC-130 already knows (`looksSecret`). */
const NAMED_SECRET = /(auth_?token|access_?token|refresh_?token|api[_-]?key|client_?secret|secret|password|private_?key)"?\s*[:=]\s*"?[^\s"]{8,}/i;

/** why a value may not be stored in a CRM field, or null. */
export function secretProblem(value: unknown): string | null {
  if (typeof value === 'string') {
    return looksSecret(value) || NAMED_SECRET.test(value)
      ? 'looks like a credential — those are never kept on a customer record'
      : null;
  }
  if (value && typeof value === 'object') {
    return secretProblem(JSON.stringify(value));
  }
  return null;
}

const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : {});
const has = (raw: Raw, key: string) => Object.prototype.hasOwnProperty.call(raw, key);

/** a small field-by-field reader: every problem is collected, none stops the rest. */
class Reader {
  readonly out: Raw = {};
  readonly errors: FieldError[] = [];
  private readonly raw: Raw;
  private readonly partial: boolean;
  /* fields assigned by hand: node strips types and cannot run a parameter property. */
  constructor(raw: Raw, partial: boolean) {
    this.raw = raw;
    this.partial = partial;
  }

  private present(key: string): boolean {
    return has(this.raw, key) && this.raw[key] !== undefined;
  }

  fail(field: string, message: string) { this.errors.push({ field, message }); }

  /** an optional string. '' and null both clear it. */
  text(key: string, max: number, opts: { required?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required && !this.partial) this.fail(key, 'is required');
      return;
    }
    const v = this.raw[key];
    if (v === null || v === '') {
      if (opts.required) this.fail(key, 'is required');
      else this.out[key] = null;
      return;
    }
    if (typeof v !== 'string') return this.fail(key, 'must be text');
    const value = v.trim();
    if (value === '') return opts.required ? this.fail(key, 'is required') : void (this.out[key] = null);
    if (value.length > max) return this.fail(key, `is longer than ${max} characters`);
    const secret = secretProblem(value);
    if (secret) return this.fail(key, secret);
    this.out[key] = value;
  }

  oneOf(key: string, allowed: readonly string[], opts: { required?: boolean; nullable?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required && !this.partial) this.fail(key, 'is required');
      return;
    }
    const v = this.raw[key];
    if ((v === null || v === '') && opts.nullable) return void (this.out[key] = null);
    if (typeof v !== 'string' || !allowed.includes(v)) return this.fail(key, `must be one of: ${allowed.join(', ')}`);
    this.out[key] = v;
  }

  uuid(key: string, opts: { required?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required && !this.partial) this.fail(key, 'is required');
      return;
    }
    const v = this.raw[key];
    if (v === null || v === '') return opts.required ? this.fail(key, 'is required') : void (this.out[key] = null);
    if (typeof v !== 'string' || !UUID.test(v)) return this.fail(key, 'is not an id');
    this.out[key] = v.toLowerCase();
  }

  key(key: string, opts: { required?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required && !this.partial) this.fail(key, 'is required');
      return;
    }
    const v = this.raw[key];
    if (typeof v !== 'string' || !KEY.test(v)) return this.fail(key, 'is lowercase letters, digits and underscores, starting with a letter');
    this.out[key] = v;
  }

  phone(key: string) {
    if (!this.present(key)) return;
    const v = this.raw[key];
    if (v === null || v === '') return void (this.out[key] = null);
    const phone = normalisePhone(v);
    if (!phone) return this.fail(key, 'is not a phone number we can dial — include the area code');
    this.out[key] = phone;
  }

  email(key: string) {
    if (!this.present(key)) return;
    const v = this.raw[key];
    if (v === null || v === '') return void (this.out[key] = null);
    const email = normaliseEmail(v);
    if (!email) return this.fail(key, 'is not an email address');
    this.out[key] = email;
  }

  bool(key: string) {
    if (!this.present(key)) return;
    if (typeof this.raw[key] !== 'boolean') return this.fail(key, 'must be true or false');
    this.out[key] = this.raw[key];
  }

  int(key: string, min: number, max: number) {
    if (!this.present(key)) return;
    const v = this.raw[key];
    if (v === null || v === '') return void (this.out[key] = null);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return this.fail(key, `must be a whole number from ${min} to ${max}`);
    this.out[key] = v;
  }

  time(key: string) {
    if (!this.present(key)) return;
    const v = this.raw[key];
    if (v === null || v === '') return void (this.out[key] = null);
    const ms = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isNaN(ms)) return this.fail(key, 'is not a date and time');
    this.out[key] = new Date(ms).toISOString();
  }

  /** `archived: true|false` on the wire is `archived_at` on the row. */
  archived() {
    if (!this.present('archived')) return;
    if (typeof this.raw.archived !== 'boolean') return this.fail('archived', 'must be true or false');
    this.out.archived_at = this.raw.archived ? new Date().toISOString() : null;
  }

  unknown(known: readonly string[]) {
    for (const key of Object.keys(this.raw)) {
      if (!known.includes(key)) this.fail(key, 'is not a field of this record');
    }
  }

  done<T>(): Parsed<T> {
    return this.errors.length > 0 ? { ok: false, errors: this.errors } : { ok: true, value: this.out as T };
  }
}

function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/* contacts */

const CONTACT_KEYS = ['display_name', 'first_name', 'last_name', 'phone', 'email', 'preferred_channel',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'location_id', 'owner_user_id'];

/**
 * A contact from anything a form, an import line or an operator supplies. The phone comes
 * out E.164 and the email lowercased — the one spelling suppression matching uses — or the
 * field is refused. A new contact needs something to be found by: a name, a phone or an email.
 */
export function parseContactInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, opts.partial === true);
  r.unknown(CONTACT_KEYS);
  r.text('display_name', 200);
  r.text('first_name', 100);
  r.text('last_name', 100);
  r.phone('phone');
  r.email('email');
  r.oneOf('preferred_channel', CONTACT_CHANNELS, { nullable: true });
  r.text('address_line1', 200);
  r.text('address_line2', 200);
  r.text('city', 120);
  r.text('region', 120);
  r.text('postal_code', 20);
  if (has(source, 'country') && source.country !== null && source.country !== '') {
    if (typeof source.country !== 'string' || !/^[A-Za-z]{2}$/.test(source.country.trim())) r.fail('country', 'is a two-letter country code');
    else r.out.country = source.country.trim().toUpperCase();
  } else if (has(source, 'country')) r.out.country = null;
  r.uuid('location_id');
  r.uuid('owner_user_id');

  if (!opts.partial) {
    const o = r.out;
    const name = (o.display_name as string | null) ?? ([o.first_name, o.last_name].filter(Boolean).join(' ') || null);
    const display = name ?? (o.phone as string | null) ?? (o.email as string | null) ?? null;
    if (!display) r.fail('display_name', 'a contact needs a name, a phone number or an email address');
    else o.display_name = display;
  } else if (has(source, 'display_name') && r.out.display_name === null) {
    r.fail('display_name', 'cannot be cleared');
  }
  return r.done();
}

/* leads */

const LEAD_KEYS = ['contact_id', 'title', 'summary', 'source', 'source_event_id', 'service_id', 'service_category_id',
  'pipeline_id', 'stage_id', 'stage_key', 'owner_user_id', 'priority', 'estimated_value_cents',
  'estimated_value_source', 'closed_reason', 'recovery_lead_id'];

export function parseLeadInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const source = asObject(raw);
  const partial = opts.partial === true;
  const r = new Reader(source, partial);
  r.unknown(LEAD_KEYS);
  if (partial) {
    for (const fixed of ['contact_id', 'source', 'source_event_id', 'recovery_lead_id']) {
      if (has(source, fixed)) r.fail(fixed, 'is set when the lead is created and does not change');
    }
  } else {
    r.uuid('contact_id', { required: true });
    r.oneOf('source', LEAD_SOURCES, { required: true });
    r.uuid('source_event_id');
    r.uuid('recovery_lead_id');
  }
  r.text('title', 200, { required: true });
  r.text('summary', 2000);
  r.uuid('service_id');
  r.uuid('service_category_id');
  r.uuid('pipeline_id');
  r.uuid('stage_id');
  r.key('stage_key');
  if (has(source, 'stage_id') && has(source, 'stage_key')) r.fail('stage_key', 'name the stage by id or by key, not both');
  r.uuid('owner_user_id');
  r.oneOf('priority', PRIORITIES);
  r.text('closed_reason', 300);

  /* a value never arrives without where it came from, and ARC never invents one. */
  const hasValue = has(source, 'estimated_value_cents');
  const hasSource = has(source, 'estimated_value_source');
  if (hasValue || hasSource) {
    const value = source.estimated_value_cents;
    const from = source.estimated_value_source;
    if ((value === null || value === undefined) && (from === null || from === undefined)) {
      r.out.estimated_value_cents = null;
      r.out.estimated_value_source = null;
    } else if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      r.fail('estimated_value_cents', 'is a whole number of cents, zero or more');
    } else if (typeof from !== 'string' || !(VALUE_SOURCES as readonly string[]).includes(from)) {
      r.fail('estimated_value_source', `a value needs where it came from: ${VALUE_SOURCES.join(', ')}`);
    } else {
      r.out.estimated_value_cents = value;
      r.out.estimated_value_source = from;
    }
  }
  return r.done();
}

/* notes and tasks */

export function parseNoteInput(raw: unknown): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['contact_id', 'lead_id', 'body']);
  r.uuid('contact_id');
  r.uuid('lead_id');
  r.text('body', 5000, { required: true });
  if (!r.out.contact_id && !r.out.lead_id) r.fail('contact_id', 'a note belongs to a contact or a lead');
  return r.done();
}

export function parseTaskInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const source = asObject(raw);
  const partial = opts.partial === true;
  const r = new Reader(source, partial);
  r.unknown(['contact_id', 'lead_id', 'kind', 'title', 'detail', 'due_at', 'status', 'assigned_user_id']);
  if (partial) {
    for (const fixed of ['contact_id', 'lead_id']) {
      if (has(source, fixed)) r.fail(fixed, 'is set when the task is created and does not change');
    }
  } else {
    r.uuid('contact_id');
    r.uuid('lead_id');
    if (!r.out.contact_id && !r.out.lead_id) r.fail('contact_id', 'a task belongs to a contact or a lead');
  }
  r.oneOf('kind', TASK_KINDS);
  r.text('title', 200, { required: true });
  r.text('detail', 2000);
  r.time('due_at');
  r.oneOf('status', TASK_STATUSES);
  r.uuid('assigned_user_id');
  return r.done();
}

/* the business */

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `{ mon: [{ open: '08:00', close: '17:00' }] }` — a day left out is closed. */
export function parseBusinessHours(raw: unknown): Parsed<Record<string, { open: string; close: string }[]>> {
  const errors: FieldError[] = [];
  const out: Record<string, { open: string; close: string }[]> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'business_hours', message: 'is an object keyed by day (mon … sun)' }] };
  }
  for (const [day, value] of Object.entries(raw as Raw)) {
    const field = `business_hours.${day}`;
    if (!(DAYS as readonly string[]).includes(day)) { errors.push({ field, message: 'is not a day (mon … sun)' }); continue; }
    if (!Array.isArray(value) || value.length > 4) { errors.push({ field, message: 'is a list of up to four open periods' }); continue; }
    const periods: { open: string; close: string }[] = [];
    for (const period of value) {
      const p = asObject(period);
      if (typeof p.open !== 'string' || typeof p.close !== 'string' || !HHMM.test(p.open) || !HHMM.test(p.close) || Object.keys(p).length !== 2) {
        errors.push({ field, message: 'each period is { open: "08:00", close: "17:00" }' });
      } else if (p.open >= p.close) {
        errors.push({ field, message: `opens at ${p.open} but closes at ${p.close}` });
      } else {
        periods.push({ open: p.open, close: p.close });
      }
    }
    periods.sort((a, b) => a.open.localeCompare(b.open));
    for (let i = 1; i < periods.length; i += 1) {
      if (periods[i].open < periods[i - 1].close) errors.push({ field, message: 'has periods that overlap' });
    }
    if (periods.length > 0) out[day] = periods;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * The profile's own fields. Not the business's name or timezone (the tenant's), and not the
 * route (`policy` permission, set on its own).
 */
export function parseProfileInput(raw: unknown): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, true);
  r.unknown(['public_phone', 'public_email', 'website_url', 'business_hours']);
  r.phone('public_phone');
  r.email('public_email');
  if (has(source, 'website_url')) {
    const v = source.website_url;
    if (v === null || v === '') r.out.website_url = null;
    else if (typeof v !== 'string' || !/^https:\/\/[^\s?#]+$/.test(v.trim()) || v.trim().length > 200) {
      r.fail('website_url', 'is an https address with no query string');
    } else r.out.website_url = v.trim();
  }
  if (has(source, 'business_hours')) {
    const hours = parseBusinessHours(source.business_hours);
    if (hours.ok) r.out.business_hours = hours.value;
    else r.errors.push(...hours.errors);
  }
  return r.done();
}

export function parseLocationInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, opts.partial === true);
  r.unknown(['name', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'timezone', 'phone', 'is_primary', 'archived']);
  r.text('name', 120, { required: true });
  r.text('address_line1', 200);
  r.text('address_line2', 200);
  r.text('city', 120);
  r.text('region', 120);
  r.text('postal_code', 20);
  if (has(source, 'country')) {
    if (typeof source.country !== 'string' || !/^[A-Za-z]{2}$/.test(source.country.trim())) r.fail('country', 'is a two-letter country code');
    else r.out.country = source.country.trim().toUpperCase();
  }
  r.text('timezone', 64);
  if (typeof r.out.timezone === 'string' && !isTimezone(r.out.timezone)) r.fail('timezone', `"${r.out.timezone}" is not a timezone`);
  r.phone('phone');
  r.bool('is_primary');
  r.archived();
  return r.done();
}

export function parseServiceAreaInput(raw: unknown): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['kind', 'value', 'label', 'location_id', 'archived']);
  r.oneOf('kind', AREA_KINDS, { required: true });
  r.text('value', 120, { required: true });
  r.text('label', 120);
  r.uuid('location_id');
  r.archived();
  if (r.out.kind === 'radius_miles') {
    if (!r.out.location_id) r.fail('location_id', 'a radius is measured from a location');
    if (typeof r.out.value === 'string' && !/^[0-9]{1,3}$/.test(r.out.value)) r.fail('value', 'is a whole number of miles');
  }
  return r.done();
}

export function parseServiceCategoryInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const r = new Reader(asObject(raw), opts.partial === true);
  r.unknown(['key', 'name', 'archived']);
  if (!opts.partial) r.key('key', { required: true });
  else if (has(asObject(raw), 'key')) r.fail('key', 'does not change once set');
  r.text('name', 120, { required: true });
  r.archived();
  return r.done();
}

export function parseServiceInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<Raw> {
  const r = new Reader(asObject(raw), opts.partial === true);
  r.unknown(['key', 'name', 'description', 'category_id', 'default_duration_minutes', 'is_bookable', 'archived']);
  if (!opts.partial) r.key('key', { required: true });
  else if (has(asObject(raw), 'key')) r.fail('key', 'does not change once set');
  r.text('name', 120, { required: true });
  r.text('description', 1000);
  r.uuid('category_id');
  r.int('default_duration_minutes', 5, 1440);
  r.bool('is_bookable');
  r.archived();
  return r.done();
}

export interface PipelineInput {
  key: string;
  name: string;
  is_default: boolean;
  stages: { key: string; name: string; kind: string; waits_on: string; marks_qualified: boolean }[];
}

/** a pipeline arrives whole: at least one open stage, no two stages with one key. */
export function parsePipelineInput(raw: unknown): Parsed<PipelineInput> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['key', 'name', 'is_default', 'stages']);
  r.key('key', { required: true });
  r.text('name', 120, { required: true });
  r.bool('is_default');
  const stages: PipelineInput['stages'] = [];
  const list = Array.isArray(source.stages) ? source.stages : null;
  if (!list || list.length === 0 || list.length > 20) r.fail('stages', 'a pipeline has 1 to 20 stages');
  else {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const s = new Reader(asObject(item), false);
      s.unknown(['key', 'name', 'kind', 'waits_on', 'marks_qualified']);
      s.key('key', { required: true });
      s.text('name', 120, { required: true });
      s.oneOf('kind', STAGE_KINDS);
      s.oneOf('waits_on', STAGE_WAITS);
      s.bool('marks_qualified');
      for (const e of s.errors) r.fail(`stages[${i}].${e.field}`, e.message);
      const key = s.out.key as string | undefined;
      if (key && seen.has(key)) r.fail(`stages[${i}].key`, `"${key}" is used by another stage`);
      if (key) seen.add(key);
      stages.push({
        key: key ?? '',
        name: (s.out.name as string) ?? '',
        kind: (s.out.kind as string) ?? 'open',
        waits_on: (s.out.kind ?? 'open') === 'open' ? (s.out.waits_on as string) ?? 'us' : 'us',
        marks_qualified: s.out.marks_qualified === true,
      });
    });
    if (!stages.some((s) => s.kind === 'open')) r.fail('stages', 'a pipeline needs at least one open stage');
  }
  if (r.errors.length > 0) return { ok: false, errors: r.errors };
  return { ok: true, value: { key: r.out.key as string, name: r.out.name as string, is_default: r.out.is_default === true, stages } };
}

export interface StageEdit {
  id?: string;
  key?: string;
  name: string;
  kind?: string;
  waits_on: string;
  marks_qualified: boolean;
  retired: boolean;
}

/**
 * ARC-360: a pipeline's whole ordered stage list, as the screen edits it. A stage with an id
 * is that stage — renamed, moved, retired or brought back; its key and its kind never change
 * (0025 refuses it too). A stage without an id is new and needs a key. Leaving a stage out
 * is not how one is removed: it is retired, and 0025 says so if one is missing.
 */
export function parseStagesInput(raw: unknown): Parsed<{ pipeline_id: string; stages: StageEdit[] }> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['pipeline_id', 'stages']);
  r.uuid('pipeline_id', { required: true });
  const stages: StageEdit[] = [];
  const list = Array.isArray(source.stages) ? source.stages : null;
  if (!list || list.length === 0 || list.length > 20) r.fail('stages', 'a pipeline has 1 to 20 stages');
  else {
    const keys = new Set<string>();
    const ids = new Set<string>();
    list.forEach((item, i) => {
      const raw = asObject(item);
      const s = new Reader(raw, false);
      s.unknown(['id', 'key', 'name', 'kind', 'waits_on', 'marks_qualified', 'retired']);
      s.uuid('id');
      if (s.out.id) {
        if (has(raw, 'kind')) s.fail('kind', 'a stage keeps its kind — add a new stage instead');
        if (has(raw, 'key')) s.fail('key', 'a stage keeps its key');
      } else {
        s.key('key', { required: true });
        s.oneOf('kind', STAGE_KINDS);
      }
      s.text('name', 120, { required: true });
      s.oneOf('waits_on', STAGE_WAITS);
      s.bool('marks_qualified');
      s.bool('retired');
      for (const e of s.errors) r.fail(`stages[${i}].${e.field}`, e.message);
      const id = s.out.id as string | undefined;
      const key = s.out.key as string | undefined;
      if (id && ids.has(id)) r.fail(`stages[${i}].id`, 'this stage is listed twice');
      if (key && keys.has(key)) r.fail(`stages[${i}].key`, `"${key}" is used by another new stage`);
      if (id) ids.add(id);
      if (key) keys.add(key);
      stages.push({
        ...(id ? { id } : { key, kind: (s.out.kind as string) ?? 'open' }),
        name: (s.out.name as string) ?? '',
        waits_on: (s.out.waits_on as string) ?? 'us',
        marks_qualified: s.out.marks_qualified === true,
        retired: s.out.retired === true,
      });
    });
    if (!stages.some((s) => !s.retired && (s.id || s.kind === 'open'))) {
      r.fail('stages', 'a pipeline keeps at least one stage that is not retired');
    }
  }
  if (r.errors.length > 0) return { ok: false, errors: r.errors };
  return { ok: true, value: { pipeline_id: r.out.pipeline_id as string, stages } };
}

/* policy, mappings, source */

export interface PolicyInput {
  object_type: ObjectType;
  authority: Authority;
  connector_key: string | null;
  field_owners: Record<string, 'arc' | 'external'>;
  note: string | null;
}

/**
 * A source-of-truth declaration. `connectorKnown` is the registry's answer (the service
 * passes `getConnector`); a policy cannot name a system ARC has no connector for.
 */
export function parsePolicyInput(
  raw: unknown,
  context: { route: RouteKey | null; connectorKnown: (key: string) => boolean },
): Parsed<PolicyInput> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['object_type', 'authority', 'connector_key', 'field_owners', 'note']);
  r.oneOf('object_type', OBJECT_TYPES, { required: true });
  r.oneOf('authority', AUTHORITIES, { required: true });
  r.text('note', 500);
  const objectType = r.out.object_type as ObjectType | undefined;
  const authority = r.out.authority as Authority | undefined;
  const connector = typeof source.connector_key === 'string' ? source.connector_key.trim() : '';
  const owners: Record<string, 'arc' | 'external'> = {};

  if (authority === 'arc') {
    if (connector) r.fail('connector_key', 'ARC as the authority names no external system');
    if (source.field_owners && Object.keys(asObject(source.field_owners)).length > 0) r.fail('field_owners', 'only a hybrid policy splits fields');
  } else if (authority) {
    if (!connector) r.fail('connector_key', 'name the system that is the authority');
    else if (!context.connectorKnown(connector)) r.fail('connector_key', `"${connector}" is not a connector ARC has`);
    if (context.route === 'native') r.fail('authority', 'this client is on ARC Native, where ARC holds every record');
    const given = asObject(source.field_owners);
    if (authority === 'external' && Object.keys(given).length > 0) r.fail('field_owners', 'only a hybrid policy splits fields');
    if (authority === 'hybrid' && objectType) {
      for (const [field, owner] of Object.entries(given)) {
        if (!POLICY_FIELDS[objectType].includes(field)) r.fail(`field_owners.${field}`, `is not a ${objectType} field that can be handed to another system`);
        else if (owner !== 'arc' && owner !== 'external') r.fail(`field_owners.${field}`, 'is owned by "arc" or "external"');
        else owners[field] = owner;
      }
      if (!Object.values(owners).includes('external')) r.fail('field_owners', 'a hybrid policy names at least one field the other system owns — otherwise the authority is ARC');
    }
  }
  if (r.errors.length > 0) return { ok: false, errors: r.errors };
  return {
    ok: true,
    value: {
      object_type: objectType as ObjectType,
      authority: authority as Authority,
      connector_key: authority === 'arc' ? null : connector,
      field_owners: owners,
      note: (r.out.note as string | null) ?? null,
    },
  };
}

export function parseMappingInput(raw: unknown, connectorKnown: (key: string) => boolean): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['object_type', 'object_id', 'connector_key', 'external_id']);
  r.oneOf('object_type', OBJECT_TYPES, { required: true });
  r.uuid('object_id', { required: true });
  r.text('connector_key', 41, { required: true });
  r.text('external_id', 200, { required: true });
  if (typeof r.out.connector_key === 'string' && !connectorKnown(r.out.connector_key)) {
    r.fail('connector_key', `"${r.out.connector_key}" is not a connector ARC has`);
  }
  return r.done();
}

export function parseSourceEventInput(raw: unknown): Parsed<Raw> {
  const source = asObject(raw);
  const r = new Reader(source, false);
  r.unknown(['source', 'detail', 'external_ref', 'idempotency_key', 'contact_id', 'lead_id', 'event_id', 'received_at']);
  r.oneOf('source', LEAD_SOURCES, { required: true });
  r.text('external_ref', 200);
  r.text('idempotency_key', 200);
  if (typeof r.out.idempotency_key === 'string' && r.out.idempotency_key.length < 8) r.fail('idempotency_key', 'is 8 to 200 characters');
  r.uuid('contact_id');
  r.uuid('lead_id');
  r.uuid('event_id');
  r.time('received_at');
  if (has(source, 'detail')) {
    const detail = source.detail;
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) r.fail('detail', 'is an object');
    else if (JSON.stringify(detail).length > 4000) r.fail('detail', 'is too large');
    else {
      const secret = secretProblem(detail);
      if (secret) r.fail('detail', secret);
      else r.out.detail = detail;
    }
  }
  return r.done();
}

export { parseRouteKey };
export type { RouteKey };

/* ── safety, by reference ───────────────────────────────── */

export interface ContactSafety {
  channel: 'sms' | 'email';
  address: string;
  suppressed: boolean;
  reason: string | null;
  since: string | null;
}

/**
 * Whether each of a contact's addresses is on the suppression list — read from the list,
 * never from the contact. A row that has expired no longer suppresses.
 */
export function contactSafety(
  contact: { phone?: string | null; email?: string | null },
  suppressions: readonly Raw[],
  now: Date = new Date(),
): ContactSafety[] {
  const live = suppressions.filter((s) => !s.expires_at || Date.parse(String(s.expires_at)) > now.getTime());
  const out: ContactSafety[] = [];
  const add = (channel: 'sms' | 'email', address: string | null | undefined) => {
    if (!address) return;
    const hit = live.find((s) => s.channel === channel && s.address === address);
    out.push({
      channel,
      address,
      suppressed: Boolean(hit),
      reason: hit ? String(hit.reason) : null,
      since: hit ? String(hit.created_at) : null,
    });
  };
  add('sms', contact.phone);
  add('email', contact.email);
  return out;
}
