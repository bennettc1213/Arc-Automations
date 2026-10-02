/**
 * The operator surface of ARC-340: a client's business profile and CRM records.
 *
 * Behind the `ops` function's admin check like everything in this directory. The actor is
 * the verified token's user, never a field in the body, and 0023 checks it against
 * `arc_admins` again on every write. Every action takes `tenant_id`; nothing here reads
 * across clients.
 *
 * The business
 *   crm-overview              profile, locations, service areas, services, pipelines, and
 *                             who is the authority for each kind of record
 *   crm-profile-save          { profile: { public_phone, public_email, website_url, business_hours } }
 *   crm-route-set             { route: native | hybrid | connected | null }
 *   crm-policy-set            { policy: { object_type, authority, connector_key, field_owners, note } }
 *   crm-location-save         { location: {...}, id? }      (`archived: true` retires one)
 *   crm-service-area-save     { service_area: {...}, id? }
 *   crm-service-category-save { category: {...}, id? }
 *   crm-service-save          { service: {...}, id? }
 *   crm-pipeline-create       { pipeline: { key, name, is_default, stages: [...] } }
 *
 * Contacts
 *   crm-contact-list          { archived?, limit? }
 *   crm-contact-get           { contact_id }   the contact, its leads, notes, tasks, mappings,
 *                             timeline, and whether each address is on the suppression list
 *   crm-contact-find          { phone?, email? }   as typed; normalised before matching
 *   crm-contact-create        { contact: {...} }
 *   crm-contact-resolve       { contact: {...} }   the one existing match, or a new contact;
 *                             409 `ambiguous_contact` with the candidates when several match
 *   crm-contact-update        { contact_id, contact: {...} }
 *   crm-contact-archive       { contact_id, reason? }      audited
 *   crm-contact-restore       { contact_id }               audited
 *   crm-contact-merge         { keep_id, merge_id }        audited; one transaction
 *
 * Leads
 *   crm-lead-list             { pipeline_id?, stage_id?, status?, contact_id?, archived?, limit? }
 *   crm-lead-get              { lead_id }
 *   crm-lead-create           { lead: { contact_id, title, source, ... } }
 *   crm-lead-update           { lead_id, lead: {...} }     `stage_key` or `stage_id` moves it
 *   crm-lead-archive / crm-lead-restore   { lead_id }      audited
 *
 * Notes, tasks, sources, mappings
 *   crm-note-add              { note: { contact_id | lead_id, body } }
 *   crm-note-archive          { note_id }                  audited
 *   crm-task-create           { task: {...} }
 *   crm-task-update           { task_id, task: {...} }
 *   crm-source-record         { source_event: { source, detail, idempotency_key, ... } }
 *   crm-mapping-add           { mapping: { object_type, object_id, connector_key, external_id } }
 *   crm-mapping-remove        { mapping_id }
 *   crm-mapping-find          { object_type, connector_key, external_id }
 *
 * 422 with `field_errors` lists every problem with an input at once.
 */

import type { CrmActor } from '../_shared/crm/model.ts';
import * as crm from '../_shared/crm/service.ts';
import { CRM_ERROR_STATUS, type CrmOutcome, type CrmStore } from '../_shared/crm/service.ts';

export interface CrmActionContext {
  crm: CrmStore;
  body: Record<string, unknown>;
  actorId: string | null;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

type Handler = (store: CrmStore, actor: CrmActor, body: Record<string, unknown>) => Promise<CrmOutcome<unknown>>;

/** [what the result is called in the response, status on success, the call] */
const HANDLERS: Readonly<Record<string, [key: string, status: number, run: Handler]>> = Object.freeze({
  'crm-overview': ['business', 200, (s, a, b) => crm.getBusinessOverview(s, a, b.tenant_id)],
  'crm-profile-save': ['profile', 200, (s, a, b) => crm.saveBusinessProfile(s, a, b.tenant_id, b.profile)],
  'crm-route-set': ['profile', 200, (s, a, b) => crm.setRoute(s, a, b.tenant_id, b.route ?? null)],
  'crm-policy-set': ['policy', 200, (s, a, b) => crm.setSourcePolicy(s, a, b.tenant_id, b.policy)],
  'crm-location-save': ['location', 200, (s, a, b) => crm.saveLocation(s, a, b.tenant_id, b.location, b.id)],
  'crm-service-area-save': ['service_area', 200, (s, a, b) => crm.saveServiceArea(s, a, b.tenant_id, b.service_area, b.id)],
  'crm-service-category-save': ['category', 200, (s, a, b) => crm.saveServiceCategory(s, a, b.tenant_id, b.category, b.id)],
  'crm-service-save': ['service', 200, (s, a, b) => crm.saveService(s, a, b.tenant_id, b.service, b.id)],
  'crm-pipeline-create': ['created', 201, (s, a, b) => crm.createPipeline(s, a, b.tenant_id, b.pipeline)],

  'crm-contact-list': ['contacts', 200, (s, a, b) => crm.listContacts(s, a, b.tenant_id, { archived: b.archived, limit: b.limit })],
  'crm-contact-get': ['detail', 200, (s, a, b) => crm.getContact(s, a, b.tenant_id, b.contact_id)],
  'crm-contact-find': ['contacts', 200, (s, a, b) => crm.findContacts(s, a, b.tenant_id, { phone: b.phone, email: b.email })],
  'crm-contact-create': ['contact', 201, (s, a, b) => crm.createContact(s, a, b.tenant_id, b.contact)],
  'crm-contact-resolve': ['resolved', 200, (s, a, b) => crm.resolveContact(s, a, b.tenant_id, b.contact)],
  'crm-contact-update': ['contact', 200, (s, a, b) => crm.updateContact(s, a, b.tenant_id, b.contact_id, b.contact)],
  'crm-contact-archive': ['contact', 200, (s, a, b) => crm.setContactArchived(s, a, b.tenant_id, b.contact_id, true, b.reason)],
  'crm-contact-restore': ['contact', 200, (s, a, b) => crm.setContactArchived(s, a, b.tenant_id, b.contact_id, false)],
  'crm-contact-merge': ['merged', 200, (s, a, b) => crm.mergeContacts(s, a, b.tenant_id, { keepId: b.keep_id, mergeId: b.merge_id })],

  'crm-lead-list': ['leads', 200, (s, a, b) => crm.listLeads(s, a, b.tenant_id, b)],
  'crm-lead-get': ['detail', 200, (s, a, b) => crm.getLead(s, a, b.tenant_id, b.lead_id)],
  'crm-lead-create': ['lead', 201, (s, a, b) => crm.createLead(s, a, b.tenant_id, b.lead)],
  'crm-lead-update': ['lead', 200, (s, a, b) => crm.updateLead(s, a, b.tenant_id, b.lead_id, b.lead)],
  'crm-lead-archive': ['lead', 200, (s, a, b) => crm.setLeadArchived(s, a, b.tenant_id, b.lead_id, true)],
  'crm-lead-restore': ['lead', 200, (s, a, b) => crm.setLeadArchived(s, a, b.tenant_id, b.lead_id, false)],

  'crm-note-add': ['note', 201, (s, a, b) => crm.addNote(s, a, b.tenant_id, b.note)],
  'crm-note-archive': ['note', 200, (s, a, b) => crm.archiveNote(s, a, b.tenant_id, b.note_id)],
  'crm-task-create': ['task', 201, (s, a, b) => crm.createTask(s, a, b.tenant_id, b.task)],
  'crm-task-update': ['task', 200, (s, a, b) => crm.updateTask(s, a, b.tenant_id, b.task_id, b.task)],
  'crm-source-record': ['recorded', 200, (s, a, b) => crm.recordSourceEvent(s, a, b.tenant_id, b.source_event)],
  'crm-mapping-add': ['mapping', 201, (s, a, b) => crm.addMapping(s, a, b.tenant_id, b.mapping)],
  'crm-mapping-remove': ['mapping', 200, (s, a, b) => crm.removeMapping(s, a, b.tenant_id, b.mapping_id)],
  'crm-mapping-find': ['found', 200, (s, a, b) => crm.findByExternalId(s, a, b.tenant_id, b)],
});

export const CRM_ACTIONS = Object.keys(HANDLERS);

export async function handleCrmAction(action: string, context: CrmActionContext): Promise<ActionResponse> {
  if (!context.actorId) return { status: 401, body: { error: 'not signed in', code: 'unauthorized' } };
  const handler = HANDLERS[action];
  if (!handler) return { status: 422, body: { error: `"${action}" is not a CRM action`, code: 'invalid' } };
  const [key, status, run] = handler;
  const outcome = await run(context.crm, { kind: 'operator', userId: context.actorId }, context.body);
  if (!outcome.ok) {
    return {
      status: CRM_ERROR_STATUS[outcome.code] ?? 409,
      body: {
        error: outcome.message,
        code: outcome.code,
        ...(outcome.fieldErrors ? { field_errors: outcome.fieldErrors } : {}),
        ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
      },
    };
  }
  return { status, body: { ok: true, [key]: outcome.result } };
}
