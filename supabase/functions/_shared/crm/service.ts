/**
 * ARC-340 — the CRM service: every read and write of a contact, a lead, a task, a note, the
 * business profile, an external mapping or a source-of-truth policy goes through here.
 *
 * Each function is the same four steps, in this order:
 *
 *   1. `can`            may this actor do this for this tenant at all (`model.ts`)
 *   2. parse            every problem with the input at once, by field
 *   3. `writeDecision`  is this side the authority for the fields being written
 *   4. the store        one statement, or one SQL function when several rows must move
 *                       together (`crm_merge_contacts`, `crm_create_pipeline`)
 *
 * The database then checks the actor and the shape again and writes the timeline itself
 * (0023's triggers), so a caller that skipped this file still cannot write a change that
 * went unrecorded, reach another tenant's row, or store a credential.
 *
 * Rows travel as the database's own columns (snake_case), as every `ops` response does.
 * Nothing here is a figure: no page counts these tables, and nothing here reads `events`.
 */

import { getConnector } from '../registry/connectors.ts';
import {
  actorStamp,
  can,
  contactSafety,
  type ContactSafety,
  type CrmActor,
  type CrmPermission,
  effectivePolicy,
  type FieldError,
  type ObjectType,
  OBJECT_TYPES,
  type Parsed,
  parseContactInput,
  parseLeadInput,
  parseLocationInput,
  parseMappingInput,
  parseNoteInput,
  parsePipelineInput,
  parsePolicyInput,
  parseProfileInput,
  parseRouteKey,
  parseServiceAreaInput,
  parseServiceCategoryInput,
  parseServiceInput,
  parseSourceEventInput,
  parseTaskInput,
  type PipelineInput,
  type RouteKey,
  type SourcePolicy,
  writeDecision,
} from './model.ts';
import { normaliseEmail, normalisePhone } from '../phone.ts';

/* ── the store ──────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export const CRM_TABLES = [
  'business_profiles', 'business_locations', 'business_service_areas', 'business_service_categories',
  'business_services', 'crm_contacts', 'crm_pipelines', 'crm_pipeline_stages', 'crm_source_events',
  'crm_leads', 'crm_notes', 'crm_tasks', 'crm_activities', 'crm_external_mappings', 'crm_source_policies',
] as const;
export type CrmTable = typeof CRM_TABLES[number];

export interface RowQuery {
  eq?: Record<string, unknown>;
  isNull?: string[];
  notNull?: string[];
  in?: [column: string, values: string[]];
  order?: [column: string, direction: 'asc' | 'desc'];
  limit?: number;
}

/** Every read is scoped to a tenant by the store's signature — there is no unscoped read. */
export interface CrmStore {
  getTenant(tenantId: string): Promise<Row | null>;
  rows(table: CrmTable, tenantId: string, query?: RowQuery): Promise<Row[]>;
  row(table: CrmTable, tenantId: string, id: string): Promise<Row | null>;
  insert(table: CrmTable, row: Row): Promise<Row>;
  update(table: CrmTable, tenantId: string, id: string, patch: Row): Promise<Row | null>;
  upsert(table: CrmTable, row: Row, conflict: string): Promise<Row>;
  ensureDefaultPipeline(tenantId: string): Promise<string>;
  createPipeline(tenantId: string, pipeline: PipelineInput): Promise<{ pipeline: Row; stages: Row[] }>;
  mergeContacts(request: { tenantId: string; winnerId: string; loserId: string; actorType: string; actorId: string | null }): Promise<Row>;
  suppressions(tenantId: string, addresses: string[]): Promise<Row[]>;
  /* ARC-360's workspace (`workspace.ts`). optional: a store without them reads as "nobody
     named" and "no Lead Recovery state", and cannot change stages. */
  /** the client's members, and any other user named in `alsoNamed`, with their sign-in address. role is owner | staff | operator | former. */
  people?(tenantId: string, alsoNamed: string[]): Promise<{ user_id: string; email: string | null; role: string }[]>;
  /** Lead Recovery's own rows (0010 `leads`) for these ids: id, status, safety_flags. */
  recoveryStates?(tenantId: string, ids: string[]): Promise<Row[]>;
  /** 0025's crm_save_stages: the whole ordered list, in one transaction. */
  saveStages?(tenantId: string, pipelineId: string, stages: unknown[], actorType: string, actorId: string): Promise<Row>;
}

export const CRM_ERROR_STATUS = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 422,
  invalid_owner: 422,
  invalid_stage: 422,
  contact_unavailable: 409,
  merged: 409,
  immutable: 409,
  ambiguous_contact: 409,
  mapping_conflict: 409,
  key_taken: 409,
  conflict: 409,
  route_conflict: 409,
  external_authority: 409,
  arc_authority: 409,
  /* ARC-350: a public form's hourly ceiling (0024). */
  rate_limited: 429,
  /* ARC-370: why a message may not be sent (0026's crm_message_gate, and the route). */
  do_not_contact: 409,
  consent_declined: 409,
  automation_active: 409,
  safety_review: 409,
  no_address: 422,
  no_channel: 409,
  module_not_ready: 409,
  /* ARC-380: why a time may not be booked or an appointment changed (0027). */
  slot_taken: 409,
  slot_unavailable: 409,
  invalid_transition: 409,
  needs_reconciliation: 409,
  too_late: 409,
  outside_service_area: 422,
} as const);
export type CrmErrorCode = keyof typeof CRM_ERROR_STATUS;

/** A refusal the database made on purpose, as opposed to a failure. */
export class CrmStoreError extends Error {
  readonly code: CrmErrorCode;
  constructor(code: CrmErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type CrmOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: CrmErrorCode; message: string; fieldErrors?: FieldError[]; candidates?: Row[] };

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const refuse = (code: CrmErrorCode, message: string): { ok: false; code: CrmErrorCode; message: string } => ({ ok: false, code, message });

function invalid(errors: FieldError[]): { ok: false; code: CrmErrorCode; message: string; fieldErrors: FieldError[] } {
  return { ok: false, code: 'invalid', message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: errors };
}

/** the permission, the tenant, and a store refusal turned into an outcome. */
async function act<T>(
  store: CrmStore,
  actor: CrmActor | null,
  permission: CrmPermission,
  tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  const allowed = can(actor, permission, tenantId);
  if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
  try {
    if (!(await store.getTenant(tenantId))) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor);
  } catch (error) {
    if (error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

const stamped = (actor: CrmActor) => {
  const { type, id } = actorStamp(actor);
  return { updated_by_type: type, updated_by: id };
};

async function policyFor(store: CrmStore, tenantId: string, objectType: ObjectType): Promise<SourcePolicy> {
  const rows = await store.rows('crm_source_policies', tenantId, { eq: { object_type: objectType } });
  return effectivePolicy(rows[0], objectType);
}

/** step 3: refuse a write from the side that does not own the fields. */
async function authority(
  store: CrmStore, tenantId: string, actor: CrmActor, objectType: ObjectType, op: 'create' | 'update', fields: string[],
): Promise<{ ok: false; code: CrmErrorCode; message: string } | null> {
  const decision = writeDecision(await policyFor(store, tenantId, objectType), actor, op, fields);
  return decision.ok ? null : refuse(decision.code as CrmErrorCode, decision.message);
}

/* ── the business ───────────────────────────────────────── */

export interface BusinessOverview {
  tenant: { id: string; name: string; timezone: string };
  profile: Row | null;
  locations: Row[];
  service_areas: Row[];
  service_categories: Row[];
  services: Row[];
  pipelines: (Row & { stages: Row[] })[];
  /** one per kind of record, with ARC as the answer where no row says otherwise. */
  source_policies: SourcePolicy[];
}

export function getBusinessOverview(store: CrmStore, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<BusinessOverview>> {
  return act(store, actor, 'read', tenantId, async (id) => {
    const [tenant, profile, locations, areas, categories, services, pipelines, stages, policies] = await Promise.all([
      store.getTenant(id),
      store.rows('business_profiles', id),
      store.rows('business_locations', id, { order: ['created_at', 'asc'] }),
      store.rows('business_service_areas', id, { order: ['created_at', 'asc'] }),
      store.rows('business_service_categories', id, { order: ['key', 'asc'] }),
      store.rows('business_services', id, { order: ['key', 'asc'] }),
      store.rows('crm_pipelines', id, { order: ['created_at', 'asc'] }),
      store.rows('crm_pipeline_stages', id, { order: ['position', 'asc'] }),
      store.rows('crm_source_policies', id),
    ]);
    return {
      ok: true,
      result: {
        /* the name and the timezone are the tenant's. the profile does not hold a second one. */
        tenant: { id, name: tenant!.name, timezone: tenant!.timezone },
        profile: profile[0] ?? null,
        locations,
        service_areas: areas,
        service_categories: categories,
        services,
        pipelines: pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) })),
        source_policies: OBJECT_TYPES.map((type) => effectivePolicy(policies.find((p) => p.object_type === type), type)),
      },
    };
  });
}

export function saveBusinessProfile(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'business', tenantId, async (id, who) => {
    const parsed = parseProfileInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    return { ok: true, result: await store.upsert('business_profiles', { tenant_id: id, ...parsed.value, ...stamped(who) }, 'tenant_id') };
  });
}

/** Record the route (ARC-330) this client is on. An operator's call; null clears it. */
export function setRoute(store: CrmStore, actor: CrmActor | null, tenantId: unknown, route: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'policy', tenantId, async (id, who) => {
    const key: RouteKey | null = route === null ? null : parseRouteKey(route);
    if (route !== null && !key) return invalid([{ field: 'route', message: 'is native, hybrid or connected' }]);
    return { ok: true, result: await store.upsert('business_profiles', { tenant_id: id, route: key, ...stamped(who) }, 'tenant_id') };
  });
}

export function setSourcePolicy(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<SourcePolicy>> {
  return act(store, actor, 'policy', tenantId, async (id, who) => {
    const profile = (await store.rows('business_profiles', id))[0];
    const parsed = parsePolicyInput(input, {
      route: (profile?.route as RouteKey | null) ?? null,
      connectorKnown: (key) => getConnector(key) !== null,
    });
    if (!parsed.ok) return invalid(parsed.errors);
    const row = await store.upsert('crm_source_policies', { tenant_id: id, ...parsed.value, updated_by: actorStamp(who).id }, 'tenant_id,object_type');
    return { ok: true, result: effectivePolicy(row, parsed.value.object_type) };
  });
}

type BusinessTable = 'business_locations' | 'business_service_areas' | 'business_service_categories' | 'business_services';

function saveBusinessRow(
  table: BusinessTable,
  parse: (raw: unknown, opts: { partial?: boolean }) => Parsed<Row>,
) {
  return (store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown, rowId?: unknown): Promise<CrmOutcome<Row>> =>
    act(store, actor, 'business', tenantId, async (id) => {
      const parsed = parse(input, { partial: rowId !== undefined && rowId !== null });
      if (!parsed.ok) return invalid(parsed.errors);
      if (rowId === undefined || rowId === null) return { ok: true, result: await store.insert(table, { tenant_id: id, ...parsed.value }) };
      if (!isId(rowId)) return refuse('not_found', 'no such record for this client');
      const row = await store.update(table, id, rowId, parsed.value);
      return row ? { ok: true, result: row } : refuse('not_found', 'no such record for this client');
    });
}

export const saveLocation = saveBusinessRow('business_locations', parseLocationInput);
export const saveServiceArea = saveBusinessRow('business_service_areas', (raw) => parseServiceAreaInput(raw));
export const saveServiceCategory = saveBusinessRow('business_service_categories', parseServiceCategoryInput);
export const saveService = saveBusinessRow('business_services', parseServiceInput);

export function createPipeline(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<{ pipeline: Row; stages: Row[] }>> {
  return act(store, actor, 'business', tenantId, async (id) => {
    const parsed = parsePipelineInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    return { ok: true, result: await store.createPipeline(id, parsed.value) };
  });
}

/* ── contacts ───────────────────────────────────────────── */

/**
 * Contacts reachable at this phone or this email, as typed — "(614) 555-0137" finds
 * "+16145550137". A merged contact is never a match; the one it was merged into is.
 */
export function findContacts(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, by: { phone?: unknown; email?: unknown },
): Promise<CrmOutcome<(Row & { matched_on: string[] })[]>> {
  return act(store, actor, actor?.kind === 'system' || actor?.kind === 'external' ? 'record' : 'read', tenantId, async (id) => {
    return { ok: true, result: await matches(store, id, normalisePhone(by.phone), normaliseEmail(by.email)) };
  });
}

async function matches(store: CrmStore, tenantId: string, phone: string | null, email: string | null) {
  const [byPhone, byEmail] = await Promise.all([
    phone ? store.rows('crm_contacts', tenantId, { eq: { phone }, isNull: ['merged_into_id'], order: ['created_at', 'asc'] }) : [],
    email ? store.rows('crm_contacts', tenantId, { eq: { email }, isNull: ['merged_into_id'], order: ['created_at', 'asc'] }) : [],
  ]);
  const found = new Map<string, Row & { matched_on: string[] }>();
  for (const row of byPhone) found.set(row.id, { ...row, matched_on: ['phone'] });
  for (const row of byEmail) {
    const existing = found.get(row.id);
    if (existing) existing.matched_on.push('email');
    else found.set(row.id, { ...row, matched_on: ['email'] });
  }
  return [...found.values()];
}

export function createContact(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseContactInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const fields = Object.keys(parsed.value).filter((k) => parsed.value[k] !== null);
    return await authority(store, id, who, 'contact', 'create', fields)
      ?? { ok: true, result: await store.insert('crm_contacts', { tenant_id: id, ...parsed.value, ...stamped(who) }) };
  });
}

/**
 * The contact an arrival belongs to: the one live contact with this phone or email, or a
 * new one. More than one match is never guessed at — the candidates come back and a
 * person (or a merge) decides.
 */
export function resolveContact(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<CrmOutcome<{ contact: Row; matched: boolean }>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseContactInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const live = (await matches(store, id, parsed.value.phone ?? null, parsed.value.email ?? null)).filter((c) => !c.archived_at);
    if (live.length === 1) return { ok: true, result: { contact: live[0], matched: true } };
    if (live.length > 1) {
      return { ok: false, code: 'ambiguous_contact', message: `${live.length} contacts share this phone or email — choose one, or merge them`, candidates: live };
    }
    const fields = Object.keys(parsed.value).filter((k) => parsed.value[k] !== null);
    const refused = await authority(store, id, who, 'contact', 'create', fields);
    if (refused) return refused;
    return { ok: true, result: { contact: await store.insert('crm_contacts', { tenant_id: id, ...parsed.value, ...stamped(who) }), matched: false } };
  });
}

export function updateContact(store: CrmStore, actor: CrmActor | null, tenantId: unknown, contactId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseContactInput(input, { partial: true });
    if (!parsed.ok) return invalid(parsed.errors);
    if (!isId(contactId)) return refuse('not_found', 'no such contact for this client');
    const fields = Object.keys(parsed.value);
    if (fields.length === 0) return invalid([{ field: 'contact', message: 'nothing to change' }]);
    /* handing a customer to somebody else is not an ordinary edit. */
    if (fields.includes('owner_user_id')) {
      const sensitive = can(who, 'sensitive', id);
      if (!sensitive.ok) return refuse('forbidden', sensitive.message);
    }
    const refused = await authority(store, id, who, 'contact', 'update', fields);
    if (refused) return refused;
    const row = await store.update('crm_contacts', id, contactId, { ...parsed.value, ...stamped(who) });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such contact for this client');
  });
}

/** Archiving is how a contact is "deleted": the row and its history stay. */
export function setContactArchived(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, contactId: unknown, archived: boolean, reason?: unknown,
): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'sensitive', tenantId, async (id, who) => {
    if (!isId(contactId)) return refuse('not_found', 'no such contact for this client');
    const parsed = parseArchiveReason(reason);
    if (!parsed.ok) return invalid(parsed.errors);
    const row = await store.update('crm_contacts', id, contactId, {
      archived_at: archived ? new Date().toISOString() : null,
      archived_reason: archived ? parsed.value : null,
      ...stamped(who),
    });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such contact for this client');
  });
}

function parseArchiveReason(reason: unknown): Parsed<string | null> {
  if (reason === undefined || reason === null || reason === '') return { ok: true, value: null };
  const note = parseNoteInput({ contact_id: '00000000-0000-4000-8000-000000000000', body: reason });
  if (!note.ok) return { ok: false, errors: note.errors.map((e) => ({ field: 'reason', message: e.message })) };
  const text = String(note.value.body);
  return text.length > 300 ? { ok: false, errors: [{ field: 'reason', message: 'is longer than 300 characters' }] } : { ok: true, value: text };
}

/** "These two are one person." One transaction and one audit row — 0023's crm_merge_contacts. */
export function mergeContacts(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: { keepId: unknown; mergeId: unknown },
): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'sensitive', tenantId, async (id, who) => {
    if (!isId(input.keepId) || !isId(input.mergeId)) return invalid([{ field: 'merge_id', message: 'name the contact to keep and the contact to merge into it' }]);
    const { type, id: actorId } = actorStamp(who);
    return { ok: true, result: await store.mergeContacts({ tenantId: id, winnerId: input.keepId, loserId: input.mergeId, actorType: type, actorId }) };
  });
}

export interface ContactDetail {
  contact: Row;
  /** from the suppression list, never from the contact. */
  safety: ContactSafety[];
  leads: Row[];
  notes: Row[];
  tasks: Row[];
  mappings: Row[];
  timeline: Row[];
}

export function getContact(store: CrmStore, actor: CrmActor | null, tenantId: unknown, contactId: unknown): Promise<CrmOutcome<ContactDetail>> {
  return act(store, actor, 'read', tenantId, async (id) => {
    if (!isId(contactId)) return refuse('not_found', 'no such contact for this client');
    const contact = await store.row('crm_contacts', id, contactId);
    if (!contact) return refuse('not_found', 'no such contact for this client');
    /* what was merged into this contact kept its own timeline; reading the survivor reads both. */
    const mergedIn = (await store.rows('crm_contacts', id, { eq: { merged_into_id: contactId } })).map((c) => c.id as string);
    const [leads, notes, tasks, mappings, timeline, suppressions] = await Promise.all([
      store.rows('crm_leads', id, { eq: { contact_id: contactId }, order: ['created_at', 'desc'] }),
      store.rows('crm_notes', id, { eq: { contact_id: contactId }, isNull: ['archived_at'], order: ['created_at', 'desc'] }),
      store.rows('crm_tasks', id, { eq: { contact_id: contactId }, order: ['created_at', 'desc'] }),
      store.rows('crm_external_mappings', id, { eq: { object_type: 'contact', object_id: contactId }, isNull: ['removed_at'] }),
      store.rows('crm_activities', id, { in: ['contact_id', [contactId, ...mergedIn]], order: ['occurred_at', 'desc'], limit: 200 }),
      store.suppressions(id, [contact.phone, contact.email].filter(Boolean)),
    ]);
    return { ok: true, result: { contact, safety: contactSafety(contact, suppressions), leads, notes, tasks, mappings, timeline } };
  });
}

export function listContacts(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, query: { archived?: unknown; limit?: unknown } = {},
): Promise<CrmOutcome<Row[]>> {
  return act(store, actor, 'read', tenantId, async (id) => ({
    ok: true,
    result: await store.rows('crm_contacts', id, {
      isNull: query.archived === true ? ['merged_into_id'] : ['merged_into_id', 'archived_at'],
      order: ['created_at', 'desc'],
      limit: pageSize(query.limit),
    }),
  }));
}

const pageSize = (limit: unknown) => (typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50);

/* ── leads ──────────────────────────────────────────────── */

async function resolveStage(
  store: CrmStore, tenantId: string, value: Row, current?: Row,
): Promise<{ ok: true; pipelineId: string; stageId: string } | { ok: false; code: CrmErrorCode; message: string }> {
  const pipelineId: string = value.pipeline_id ?? current?.pipeline_id ?? await store.ensureDefaultPipeline(tenantId);
  const stages = (await store.rows('crm_pipeline_stages', tenantId, { eq: { pipeline_id: pipelineId }, order: ['position', 'asc'] }))
    .filter((s) => !s.archived_at);
  if (stages.length === 0) return refuse('invalid_stage', 'that pipeline does not exist for this client');
  let stage: Row | undefined;
  if (value.stage_id) stage = stages.find((s) => s.id === value.stage_id);
  else if (value.stage_key) stage = stages.find((s) => s.key === value.stage_key);
  else if (current && pipelineId === current.pipeline_id) return { ok: true, pipelineId, stageId: current.stage_id };
  else stage = stages.find((s) => s.kind === 'open');
  if (!stage) return refuse('invalid_stage', 'that stage is not part of this pipeline');
  return { ok: true, pipelineId, stageId: stage.id };
}

export function createLead(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseLeadInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const { stage_key: _key, ...fields } = parsed.value;
    const refused = await authority(store, id, who, 'lead', 'create', Object.keys(fields).filter((k) => fields[k] !== null));
    if (refused) return refused;
    const stage = await resolveStage(store, id, parsed.value);
    if (!stage.ok) return stage;
    return {
      ok: true,
      result: await store.insert('crm_leads', { tenant_id: id, ...fields, pipeline_id: stage.pipelineId, stage_id: stage.stageId, ...stamped(who) }),
    };
  });
}

/** Any change to a lead, moving it between stages included: `stage_key` or `stage_id`. */
export function updateLead(store: CrmStore, actor: CrmActor | null, tenantId: unknown, leadId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseLeadInput(input, { partial: true });
    if (!parsed.ok) return invalid(parsed.errors);
    if (!isId(leadId)) return refuse('not_found', 'no such lead for this client');
    const current = await store.row('crm_leads', id, leadId);
    if (!current) return refuse('not_found', 'no such lead for this client');
    const { stage_key: _key, ...fields } = parsed.value;
    const moving = 'stage_id' in parsed.value || 'stage_key' in parsed.value || 'pipeline_id' in parsed.value;
    if (moving) {
      const stage = await resolveStage(store, id, parsed.value, current);
      if (!stage.ok) return stage;
      fields.pipeline_id = stage.pipelineId;
      fields.stage_id = stage.stageId;
    }
    if (Object.keys(fields).length === 0) return invalid([{ field: 'lead', message: 'nothing to change' }]);
    if ('owner_user_id' in fields) {
      const sensitive = can(who, 'sensitive', id);
      if (!sensitive.ok) return refuse('forbidden', sensitive.message);
    }
    const refused = await authority(store, id, who, 'lead', 'update', Object.keys(fields));
    if (refused) return refused;
    const row = await store.update('crm_leads', id, leadId, { ...fields, ...stamped(who) });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such lead for this client');
  });
}

export function setLeadArchived(store: CrmStore, actor: CrmActor | null, tenantId: unknown, leadId: unknown, archived: boolean): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'sensitive', tenantId, async (id, who) => {
    if (!isId(leadId)) return refuse('not_found', 'no such lead for this client');
    const row = await store.update('crm_leads', id, leadId, { archived_at: archived ? new Date().toISOString() : null, ...stamped(who) });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such lead for this client');
  });
}

export interface LeadDetail {
  lead: Row;
  contact: Row | null;
  stage: Row | null;
  notes: Row[];
  tasks: Row[];
  mappings: Row[];
  timeline: Row[];
}

export function getLead(store: CrmStore, actor: CrmActor | null, tenantId: unknown, leadId: unknown): Promise<CrmOutcome<LeadDetail>> {
  return act(store, actor, 'read', tenantId, async (id) => {
    if (!isId(leadId)) return refuse('not_found', 'no such lead for this client');
    const lead = await store.row('crm_leads', id, leadId);
    if (!lead) return refuse('not_found', 'no such lead for this client');
    const [contact, stage, notes, tasks, mappings, timeline] = await Promise.all([
      store.row('crm_contacts', id, lead.contact_id),
      store.row('crm_pipeline_stages', id, lead.stage_id),
      store.rows('crm_notes', id, { eq: { lead_id: leadId }, isNull: ['archived_at'], order: ['created_at', 'desc'] }),
      store.rows('crm_tasks', id, { eq: { lead_id: leadId }, order: ['created_at', 'desc'] }),
      store.rows('crm_external_mappings', id, { eq: { object_type: 'lead', object_id: leadId }, isNull: ['removed_at'] }),
      store.rows('crm_activities', id, { eq: { lead_id: leadId }, order: ['occurred_at', 'desc'], limit: 200 }),
    ]);
    return { ok: true, result: { lead, contact, stage, notes, tasks, mappings, timeline } };
  });
}

export function listLeads(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown,
  query: { pipeline_id?: unknown; stage_id?: unknown; status?: unknown; contact_id?: unknown; archived?: unknown; limit?: unknown } = {},
): Promise<CrmOutcome<Row[]>> {
  return act(store, actor, 'read', tenantId, async (id) => {
    const eq: Record<string, unknown> = {};
    for (const key of ['pipeline_id', 'stage_id', 'contact_id'] as const) {
      if (query[key] === undefined) continue;
      if (!isId(query[key])) return invalid([{ field: key, message: 'is not an id' }]);
      eq[key] = query[key];
    }
    if (query.status !== undefined) {
      if (!['open', 'won', 'lost'].includes(query.status as string)) return invalid([{ field: 'status', message: 'is open, won or lost' }]);
      eq.status = query.status;
    }
    return {
      ok: true,
      result: await store.rows('crm_leads', id, {
        eq,
        isNull: query.archived === true ? [] : ['archived_at'],
        order: ['created_at', 'desc'],
        limit: pageSize(query.limit),
      }),
    };
  });
}

/* ── notes and tasks ────────────────────────────────────── */

export function addNote(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseNoteInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const refused = await authority(store, id, who, 'note', 'create', ['body']);
    if (refused) return refused;
    const { type, id: actorId } = actorStamp(who);
    return { ok: true, result: await store.insert('crm_notes', { tenant_id: id, ...parsed.value, author_type: type, author_id: actorId }) };
  });
}

/** A note is never edited. Removing one archives it, and says who did. */
export function archiveNote(store: CrmStore, actor: CrmActor | null, tenantId: unknown, noteId: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'sensitive', tenantId, async (id, who) => {
    if (!isId(noteId)) return refuse('not_found', 'no such note for this client');
    const { type, id: actorId } = actorStamp(who);
    const row = await store.update('crm_notes', id, noteId, { archived_at: new Date().toISOString(), archived_by_type: type, archived_by: actorId });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such note for this client');
  });
}

export function createTask(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseTaskInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const refused = await authority(store, id, who, 'task', 'create', Object.keys(parsed.value).filter((k) => parsed.value[k] !== null));
    if (refused) return refused;
    return { ok: true, result: await store.insert('crm_tasks', { tenant_id: id, ...parsed.value, ...stamped(who) }) };
  });
}

/** Any change to a task: completing it is `{ status: 'done' }`. */
export function updateTask(store: CrmStore, actor: CrmActor | null, tenantId: unknown, taskId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseTaskInput(input, { partial: true });
    if (!parsed.ok) return invalid(parsed.errors);
    if (!isId(taskId)) return refuse('not_found', 'no such task for this client');
    const fields = Object.keys(parsed.value);
    if (fields.length === 0) return invalid([{ field: 'task', message: 'nothing to change' }]);
    const refused = await authority(store, id, who, 'task', 'update', fields);
    if (refused) return refused;
    const row = await store.update('crm_tasks', id, taskId, { ...parsed.value, ...stamped(who) });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such task for this client');
  });
}

/* ── where a lead came from ─────────────────────────────── */

/**
 * One arrival: a call, a form post, an import line. Kept whether or not it becomes a lead.
 * A repeat of the idempotency key is the same arrival — the first row comes back, `replayed`.
 */
export function recordSourceEvent(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<CrmOutcome<{ source_event: Row; replayed: boolean }>> {
  return act(store, actor, 'record', tenantId, async (id) => {
    const parsed = parseSourceEventInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const key = parsed.value.idempotency_key as string | undefined;
    if (key) {
      const existing = await store.rows('crm_source_events', id, { eq: { idempotency_key: key } });
      if (existing[0]) return { ok: true, result: { source_event: existing[0], replayed: true } };
    }
    try {
      return { ok: true, result: { source_event: await store.insert('crm_source_events', { tenant_id: id, ...parsed.value }), replayed: false } };
    } catch (error) {
      /* two deliveries of one webhook in the same instant: the index decided, and the loser reads the winner. */
      if (key && error instanceof CrmStoreError && error.code === 'conflict') {
        const existing = await store.rows('crm_source_events', id, { eq: { idempotency_key: key } });
        if (existing[0]) return { ok: true, result: { source_event: existing[0], replayed: true } };
      }
      throw error;
    }
  });
}

/** Tie an arrival to the contact and lead it became. Each is set once. */
export function linkSourceEvent(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown, sourceEventId: unknown, link: { contact_id?: unknown; lead_id?: unknown },
): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'record', tenantId, async (id) => {
    if (!isId(sourceEventId)) return refuse('not_found', 'no such source record for this client');
    const patch: Row = {};
    for (const key of ['contact_id', 'lead_id'] as const) {
      if (link[key] === undefined) continue;
      if (!isId(link[key])) return invalid([{ field: key, message: 'is not an id' }]);
      patch[key] = link[key];
    }
    if (Object.keys(patch).length === 0) return invalid([{ field: 'contact_id', message: 'name the contact or the lead' }]);
    const row = await store.update('crm_source_events', id, sourceEventId, patch);
    return row ? { ok: true, result: row } : refuse('not_found', 'no such source record for this client');
  });
}

/* ── external mappings ──────────────────────────────────── */

export function addMapping(store: CrmStore, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'mapping', tenantId, async (id, who) => {
    const parsed = parseMappingInput(input, (key) => getConnector(key) !== null);
    if (!parsed.ok) return invalid(parsed.errors);
    const { type, id: actorId } = actorStamp(who);
    return { ok: true, result: await store.insert('crm_external_mappings', { tenant_id: id, ...parsed.value, created_by_type: type, created_by: actorId }) };
  });
}

export function removeMapping(store: CrmStore, actor: CrmActor | null, tenantId: unknown, mappingId: unknown): Promise<CrmOutcome<Row>> {
  return act(store, actor, 'mapping', tenantId, async (id, who) => {
    if (!isId(mappingId)) return refuse('not_found', 'no such mapping for this client');
    const { type, id: actorId } = actorStamp(who);
    const row = await store.update('crm_external_mappings', id, mappingId, { removed_at: new Date().toISOString(), removed_by_type: type, removed_by: actorId });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such mapping for this client');
  });
}

const MAPPED_TABLE: Readonly<Record<ObjectType, CrmTable>> = Object.freeze({
  contact: 'crm_contacts',
  lead: 'crm_leads',
  task: 'crm_tasks',
  note: 'crm_notes',
  location: 'business_locations',
  service: 'business_services',
});

/** The ARC record that is this record in their system, or null. */
export function findByExternalId(
  store: CrmStore, actor: CrmActor | null, tenantId: unknown,
  by: { object_type?: unknown; connector_key?: unknown; external_id?: unknown },
): Promise<CrmOutcome<{ mapping: Row; record: Row | null } | null>> {
  return act(store, actor, actor?.kind === 'system' || actor?.kind === 'external' ? 'mapping' : 'read', tenantId, async (id) => {
    const type = by.object_type as ObjectType;
    if (!OBJECT_TYPES.includes(type) || typeof by.connector_key !== 'string' || typeof by.external_id !== 'string') {
      return invalid([{ field: 'external_id', message: 'name the object type, the connector and the external id' }]);
    }
    const [mapping] = await store.rows('crm_external_mappings', id, {
      eq: { object_type: type, connector_key: by.connector_key, external_id: by.external_id.trim() },
      isNull: ['removed_at'],
    });
    if (!mapping) return { ok: true, result: null };
    return { ok: true, result: { mapping, record: await store.row(MAPPED_TABLE[type], id, mapping.object_id) } };
  });
}
