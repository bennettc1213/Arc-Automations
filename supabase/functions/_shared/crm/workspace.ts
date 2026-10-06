/**
 * ARC-360 — the CRM workspace's reads and the few writes ARC-340's service did not have.
 *
 * Every write a person makes from the workspace is still one of ARC-340's own calls
 * (`updateLead`, `addNote`, `createTask`, …) or ARC-350's `createManualLead` for a quick-add —
 * this file adds no second way to change a record. What it adds:
 *
 *   getWorkspace     everything the inbox, list, board and task views draw, in one round trip
 *   getLeadView      one lead with its contact, source, consent evidence, tasks, notes, timeline
 *   bulkUpdateLeads  one change to several leads — each through `updateLead`, each in the
 *                    timeline on its own, with what was refused said per lead
 *   saveStages       a pipeline's stages renamed, reordered, added or retired (0025)
 *
 * The same functions serve an operator through `ops` and a client user through the `crm`
 * function; ARC-340's `can` and 0023/0025's actor checks decide what each may do. Nothing here
 * is a figure: no page counts these rows, and nothing here reads `events`.
 */

import { can, contactSafety, type CrmActor, type CrmPermission, effectivePolicy, OBJECT_TYPES, parseStagesInput, type SourcePolicy } from './model.ts';
import * as crm from './service.ts';
import { type CrmErrorCode, type CrmOutcome, CrmStoreError, type Row } from './service.ts';
import type { IntakeDeps } from '../intake/service.ts';

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const asObject = (raw: unknown): Row => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {});
const refuse = (code: CrmErrorCode, message: string) => ({ ok: false as const, code, message });

async function act<T>(
  deps: IntakeDeps, actor: CrmActor | null, permission: CrmPermission, tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  const allowed = can(actor, permission, tenantId);
  if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
  try {
    if (!(await deps.crm.getTenant(tenantId))) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor);
  } catch (error) {
    if (error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

/** a long id list, read a hundred at a time — a URL holds only so many. */
async function chunked(ids: string[], read: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Row[] = [];
  for (let i = 0; i < unique.length; i += 100) out.push(...await read(unique.slice(i, i + 100)));
  return out;
}

/** how many leads one read returns, open and closed. the screen says so when it is reached. */
export const WORKSPACE_LIMITS = Object.freeze({ open: 500, closed: 200, doneTasks: 50, bulk: 100 });

/* ── who is looking, and who can be named ───────────────── */

export interface Person {
  user_id: string;
  /** what the screen prints for this person. */
  label: string;
  /** owner | staff for a member of this client; 'arc' for an operator; 'former' for somebody since unlinked. */
  role: 'owner' | 'staff' | 'arc' | 'former';
  /** may a lead or a task be handed to this person from this screen. */
  assignable: boolean;
}

export interface Viewer {
  kind: 'operator' | 'client_user';
  user_id: string;
  role: 'owner' | 'staff' | 'operator';
  may: { record: boolean; sensitive: boolean; business: boolean };
}

function viewerOf(actor: CrmActor, tenantId: string): Viewer {
  const allowed = (p: CrmPermission) => can(actor, p, tenantId).ok;
  const userId = actor.kind === 'operator' || actor.kind === 'client_user' ? actor.userId : '';
  return {
    kind: actor.kind === 'operator' ? 'operator' : 'client_user',
    user_id: userId,
    role: actor.kind === 'client_user' ? actor.role : 'operator',
    may: { record: allowed('record'), sensitive: allowed('sensitive'), business: allowed('business') },
  };
}

/**
 * The people a record can name. A client sees their own team by sign-in address and an
 * operator only as "ARC"; an operator sees everybody by address. Nobody outside this client
 * and ARC is ever listed.
 */
export async function peopleFor(deps: Pick<IntakeDeps, 'crm'>, tenantId: string, actor: CrmActor, alsoNamed: string[]): Promise<Person[]> {
  const rows = deps.crm.people ? await deps.crm.people(tenantId, alsoNamed) : [];
  const viewerId = actor.kind === 'operator' || actor.kind === 'client_user' ? actor.userId : null;
  const out: Person[] = rows.map((row) => {
    const member = row.role === 'owner' || row.role === 'staff';
    const self = row.user_id === viewerId;
    let label: string;
    if (member) label = row.email ?? (row.role === 'owner' ? 'account owner' : 'team member');
    else if (row.role === 'operator') label = actor.kind === 'operator' ? `${row.email ?? 'operator'} (ARC)` : 'ARC team';
    else label = 'a former team member';
    return {
      user_id: row.user_id,
      label: self ? `${label} — you` : label,
      role: member ? row.role as 'owner' | 'staff' : row.role === 'operator' ? 'arc' : 'former',
      assignable: member || self,
    };
  });
  /* an operator can always take a lead themselves, even before anybody else is named. */
  if (actor.kind === 'operator' && !out.some((p) => p.user_id === actor.userId)) {
    out.push({ user_id: actor.userId, label: 'you (ARC)', role: 'arc', assignable: true });
  }
  const rank = { owner: 0, staff: 0, arc: 1, former: 2 };
  return out.sort((a, b) => rank[a.role] - rank[b.role] || a.label.localeCompare(b.label));
}

/* ── the workspace ──────────────────────────────────────── */

export interface Workspace {
  tenant: { id: string; name: string; timezone: string };
  viewer: Viewer;
  route: string | null;
  /** who is the authority for each kind of record (ARC-340). the screen locks what it does not own. */
  policies: Record<string, SourcePolicy>;
  pipelines: (Row & { stages: Row[] })[];
  leads: Row[];
  contacts: Row[];
  tasks: Row[];
  /** contact id → the live suppression rows for its addresses. by reference, never copied onto a contact. */
  blocks: Record<string, Row[]>;
  /** recovery lead id → Lead Recovery's own status and safety flags. */
  recovery: Record<string, Row>;
  people: Person[];
  services: Row[];
  /** true when a list reached its limit and older rows were not read. */
  truncated: { open: boolean; closed: boolean };
  read_at: string;
}

export function getWorkspace(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<Workspace>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const store = deps.crm;
    const now = deps.now?.() ?? new Date();
    const tenant = await store.getTenant(id);
    /* a client with no pipeline yet gets the default one to look at — the same one their first
       lead would make. a deboarded client's records are only read, never set up. */
    if (tenant!.status !== 'archived') await store.ensureDefaultPipeline(id);
    const [profile, policies, pipelines, stages, open, closed, openTasks, doneTasks, services] = await Promise.all([
      store.rows('business_profiles', id),
      store.rows('crm_source_policies', id),
      store.rows('crm_pipelines', id, { isNull: ['archived_at'], order: ['created_at', 'asc'] }),
      store.rows('crm_pipeline_stages', id, { order: ['position', 'asc'] }),
      store.rows('crm_leads', id, { eq: { status: 'open' }, isNull: ['archived_at'], order: ['created_at', 'desc'], limit: WORKSPACE_LIMITS.open }),
      store.rows('crm_leads', id, { notNull: ['closed_at'], isNull: ['archived_at'], order: ['closed_at', 'desc'], limit: WORKSPACE_LIMITS.closed }),
      store.rows('crm_tasks', id, { eq: { status: 'open' }, order: ['created_at', 'asc'], limit: 1000 }),
      store.rows('crm_tasks', id, { eq: { status: 'done' }, order: ['completed_at', 'desc'], limit: WORKSPACE_LIMITS.doneTasks }),
      store.rows('business_services', id, { isNull: ['archived_at'], order: ['key', 'asc'] }),
    ]);
    const leads = [...open, ...closed];
    const tasks = [...openTasks, ...doneTasks];
    const contacts = await chunked(
      [...leads.map((l) => l.contact_id), ...tasks.map((t) => t.contact_id)],
      (ids) => store.rows('crm_contacts', id, { in: ['id', ids] }),
    );

    /* do-not-contact, read from the list for the addresses of open leads' contacts. */
    const openContacts = new Set(open.map((l) => l.contact_id));
    const addresses = new Map<string, string[]>();
    for (const c of contacts) {
      if (!openContacts.has(c.id)) continue;
      for (const address of [c.phone, c.email].filter(Boolean)) addresses.set(address, [...(addresses.get(address) ?? []), c.id]);
    }
    const suppressions = await chunked([...addresses.keys()], (chunk) => store.suppressions(id, chunk));
    const blocks: Record<string, Row[]> = {};
    for (const s of suppressions) {
      if (s.expires_at && Date.parse(s.expires_at) <= now.getTime()) continue;
      const matches = contacts.filter((c) => (s.channel === 'sms' && c.phone === s.address) || (s.channel === 'email' && c.email === s.address));
      for (const c of matches) {
        blocks[c.id] = [...(blocks[c.id] ?? []), { channel: s.channel, reason: s.reason, created_at: s.created_at, expires_at: s.expires_at ?? null }];
      }
    }

    const recoveryRows = store.recoveryStates
      ? await chunked(leads.map((l) => l.recovery_lead_id).filter(Boolean), (chunk) => store.recoveryStates!(id, chunk))
      : [];
    const recovery = Object.fromEntries(recoveryRows.map((r) => [r.id, { status: r.status, safety_flags: r.safety_flags ?? [] }]));

    const named = [...leads.map((l) => l.owner_user_id), ...tasks.map((t) => t.assigned_user_id)].filter(Boolean);
    return {
      ok: true,
      result: {
        tenant: { id, name: tenant!.name, timezone: tenant!.timezone },
        viewer: viewerOf(who, id),
        route: profile[0]?.route ?? null,
        policies: Object.fromEntries(OBJECT_TYPES.map((type) => [type, effectivePolicy(policies.find((p) => p.object_type === type), type)])),
        pipelines: pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) })),
        leads,
        contacts,
        tasks,
        blocks,
        recovery,
        people: await peopleFor(deps, id, who, named),
        services: services.map((s) => ({ id: s.id, key: s.key, name: s.name })),
        truncated: { open: open.length >= WORKSPACE_LIMITS.open, closed: closed.length >= WORKSPACE_LIMITS.closed },
        read_at: now.toISOString(),
      },
    };
  });
}

/* ── one lead ───────────────────────────────────────────── */

export interface LeadSource {
  event: Row | null;
  /** the door it came in by, by name: a form, an endpoint, a file, the desk. */
  door: { kind: 'form' | 'api' | 'import' | 'manual' | 'other'; name: string | null };
  /** what the visitor's browser said about where they came from — recorded, never checked. */
  claimed: Row;
  /** what a form showed and what was ticked. evidence, not permission to send. */
  consent: Row[];
}

export interface LeadView extends crm.LeadDetail {
  source: LeadSource;
  safety: ReturnType<typeof contactSafety>;
  recovery: Row | null;
  people: Person[];
  pipeline: (Row & { stages: Row[] }) | null;
  policies: Record<string, SourcePolicy>;
  viewer: Viewer;
}

async function sourceOf(deps: IntakeDeps, tenantId: string, lead: Row): Promise<LeadSource> {
  const [event] = lead.source_event_id
    ? [await deps.crm.row('crm_source_events', tenantId, lead.source_event_id)]
    : await deps.crm.rows('crm_source_events', tenantId, { eq: { lead_id: lead.id }, order: ['received_at', 'asc'], limit: 1 });
  if (!event) return { event: null, door: { kind: lead.source === 'manual' ? 'manual' : 'other', name: null }, claimed: {}, consent: [] };
  let door: LeadSource['door'] = { kind: 'other', name: null };
  if (event.form_id) door = { kind: 'form', name: (await deps.intake.row('crm_intake_forms', tenantId, event.form_id))?.name ?? null };
  /* an endpoint's name only. its token hash is never read into a response. */
  else if (event.endpoint_id) door = { kind: 'api', name: (await deps.intake.row('crm_intake_endpoints', tenantId, event.endpoint_id))?.name ?? null };
  else if (event.import_id) door = { kind: 'import', name: event.detail?.import?.file_name ?? (await deps.intake.row('crm_imports', tenantId, event.import_id))?.file_name ?? null };
  else if (event.source === 'manual') door = { kind: 'manual', name: null };
  const consent = (await deps.intake.rows('crm_consent_records', tenantId, { eq: { source_event_id: event.id }, order: ['captured_at', 'asc'] }))
    .map((c) => ({ channel: c.channel, address: c.address, granted: c.granted, disclosure: c.disclosure, captured_at: c.captured_at }));
  return {
    event: { id: event.id, source: event.source, received_at: event.received_at, external_ref: event.external_ref ?? null },
    door,
    claimed: asObject(event.detail?.claimed),
    consent,
  };
}

export function getLeadView(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, leadId: unknown): Promise<CrmOutcome<LeadView>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const detail = await crm.getLead(deps.crm, who, id, leadId);
    if (!detail.ok) return detail;
    const { lead, contact } = detail.result;
    const [source, suppressions, recoveryRows, pipeline, stages, policies] = await Promise.all([
      sourceOf(deps, id, lead),
      contact ? deps.crm.suppressions(id, [contact.phone, contact.email].filter(Boolean)) : Promise.resolve([]),
      lead.recovery_lead_id && deps.crm.recoveryStates ? deps.crm.recoveryStates(id, [lead.recovery_lead_id]) : Promise.resolve([]),
      deps.crm.row('crm_pipelines', id, lead.pipeline_id),
      deps.crm.rows('crm_pipeline_stages', id, { eq: { pipeline_id: lead.pipeline_id }, order: ['position', 'asc'] }),
      deps.crm.rows('crm_source_policies', id),
    ]);
    const named = [lead.owner_user_id, ...detail.result.tasks.map((t) => t.assigned_user_id), ...detail.result.timeline.map((t) => t.actor_id)].filter(Boolean);
    const recovery = recoveryRows[0] ? { status: recoveryRows[0].status, safety_flags: recoveryRows[0].safety_flags ?? [] } : null;
    return {
      ok: true,
      result: {
        ...detail.result,
        source,
        safety: contact ? contactSafety(contact, suppressions, deps.now?.() ?? new Date()) : [],
        recovery,
        people: await peopleFor(deps, id, who, named),
        pipeline: pipeline ? { ...pipeline, stages } : null,
        policies: Object.fromEntries(OBJECT_TYPES.map((type) => [type, effectivePolicy(policies.find((p) => p.object_type === type), type)])),
        viewer: viewerOf(who, id),
      },
    };
  });
}

/** One contact, as ARC-340 reads it, with the people its records name. */
export function getContactView(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, contactId: unknown): Promise<CrmOutcome<crm.ContactDetail & { people: Person[]; viewer: Viewer; policies: Record<string, SourcePolicy> }>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const detail = await crm.getContact(deps.crm, who, id, contactId);
    if (!detail.ok) return detail;
    const policies = await deps.crm.rows('crm_source_policies', id);
    const named = [detail.result.contact.owner_user_id, ...detail.result.leads.map((l) => l.owner_user_id), ...detail.result.timeline.map((t) => t.actor_id)].filter(Boolean);
    return {
      ok: true,
      result: {
        ...detail.result,
        people: await peopleFor(deps, id, who, named),
        viewer: viewerOf(who, id),
        policies: Object.fromEntries(OBJECT_TYPES.map((type) => [type, effectivePolicy(policies.find((p) => p.object_type === type), type)])),
      },
    };
  });
}

/* ── several leads at once ──────────────────────────────── */

const BULK_FIELDS = ['stage_key', 'stage_id', 'owner_user_id', 'priority', 'closed_reason'];

export interface BulkResult {
  updated: string[];
  refused: { lead_id: string; code: string; message: string }[];
}

/**
 * One change to up to a hundred leads. Not a batch write: each lead goes through `updateLead`
 * on its own — permission, authority, stage rules and the timeline — so a bulk move is exactly
 * the moves a person could have made one at a time, and what was refused is said per lead.
 */
export function bulkUpdateLeads(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<BulkResult>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    const raw = asObject(input);
    const ids = Array.isArray(raw.lead_ids) ? [...new Set(raw.lead_ids)] : [];
    if (ids.length === 0 || ids.length > WORKSPACE_LIMITS.bulk || !ids.every(isId)) {
      return { ok: false, code: 'invalid', message: `lead_ids: choose 1 to ${WORKSPACE_LIMITS.bulk} leads`, fieldErrors: [{ field: 'lead_ids', message: `choose 1 to ${WORKSPACE_LIMITS.bulk} leads` }] };
    }
    const change = asObject(raw.change);
    const unknown = Object.keys(change).filter((k) => !BULK_FIELDS.includes(k));
    if (unknown.length > 0 || Object.keys(change).length === 0) {
      return { ok: false, code: 'invalid', message: `change: a bulk change moves stage, sets an owner or a priority`, fieldErrors: [{ field: 'change', message: `is one of ${BULK_FIELDS.join(', ')}` }] };
    }
    const result: BulkResult = { updated: [], refused: [] };
    for (const leadId of ids as string[]) {
      const outcome = await crm.updateLead(deps.crm, who, id, leadId, change);
      if (outcome.ok) result.updated.push(leadId);
      else result.refused.push({ lead_id: leadId, code: outcome.code, message: outcome.message });
    }
    return { ok: true, result };
  });
}

/* ── a pipeline's stages ────────────────────────────────── */

export function saveStages(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const parsed = parseStagesInput(input);
    if (!parsed.ok) {
      return { ok: false, code: 'invalid', message: parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: parsed.errors };
    }
    if (!deps.crm.saveStages) return refuse('invalid', 'this deployment cannot change stages yet');
    if (who.kind !== 'operator' && who.kind !== 'client_user') return refuse('forbidden', 'a pipeline is changed by a person');
    return { ok: true, result: await deps.crm.saveStages(id, parsed.value.pipeline_id, parsed.value.stages, who.kind, who.userId) };
  });
}
