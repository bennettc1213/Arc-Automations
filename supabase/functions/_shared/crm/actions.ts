/**
 * ARC-360 — the CRM workspace's actions, one table for both doors into it.
 *
 *   the `crm` function    a client's own team, signed in; the actor is a `client_user` whose
 *                         membership of the tenant was read from `tenant_members`
 *   the `ops` function    an operator; the actor is the verified token's user
 *
 * Both run the same call for the same action name, so the console and a client's dashboard
 * cannot disagree about what a button does. Who may do what is ARC-340's `can` and
 * 0023/0025's actor checks — never this table.
 *
 *   crm-workspace          everything the inbox, list, board and tasks views draw
 *   crm-lead-view          { lead_id }    one lead: contact, source, consent, tasks, notes, timeline
 *   crm-contact-view       { contact_id } one customer and every lead of theirs
 *   crm-lead-update        { lead_id, lead: {...} }    `stage_key` / `stage_id` moves it
 *   crm-lead-bulk          { lead_ids: [...], change: { stage_key | owner_user_id | priority, closed_reason? } }
 *   crm-lead-archive / crm-lead-restore   { lead_id }   the account owner or an operator
 *   crm-lead-quick-add     { lead: {...} }   ARC-350's typed-in lead, through `crm_intake_arrival`
 *   crm-contact-update     { contact_id, contact: {...} }
 *   crm-note-add           { note: { lead_id | contact_id, body } }
 *   crm-note-archive       { note_id }
 *   crm-task-create        { task: {...} }
 *   crm-task-update        { task_id, task: {...} }   completing one is `{ status: 'done' }`
 *   crm-stages-save        { pipeline_id, stages: [...] }   the account owner or an operator
 *
 * 422 with `field_errors` lists every problem with an input at once.
 */

import type { CrmActor } from './model.ts';
import * as crm from './service.ts';
import { CRM_ERROR_STATUS, type CrmOutcome } from './service.ts';
import * as intake from '../intake/service.ts';
import type { IntakeDeps } from '../intake/service.ts';
import * as workspace from './workspace.ts';

type Handler = (deps: IntakeDeps, actor: CrmActor, body: Record<string, unknown>) => Promise<CrmOutcome<unknown>>;

/** [what the result is called in the response, status on success, the call] */
const HANDLERS: Readonly<Record<string, [key: string, status: number, run: Handler]>> = Object.freeze({
  'crm-workspace': ['workspace', 200, (d, a, b) => workspace.getWorkspace(d, a, b.tenant_id)],
  'crm-lead-view': ['view', 200, (d, a, b) => workspace.getLeadView(d, a, b.tenant_id, b.lead_id)],
  'crm-contact-view': ['view', 200, (d, a, b) => workspace.getContactView(d, a, b.tenant_id, b.contact_id)],
  'crm-lead-update': ['lead', 200, (d, a, b) => crm.updateLead(d.crm, a, b.tenant_id, b.lead_id, b.lead)],
  'crm-lead-bulk': ['bulk', 200, (d, a, b) => workspace.bulkUpdateLeads(d, a, b.tenant_id, { lead_ids: b.lead_ids, change: b.change })],
  'crm-lead-archive': ['lead', 200, (d, a, b) => crm.setLeadArchived(d.crm, a, b.tenant_id, b.lead_id, true)],
  'crm-lead-restore': ['lead', 200, (d, a, b) => crm.setLeadArchived(d.crm, a, b.tenant_id, b.lead_id, false)],
  'crm-lead-quick-add': ['arrival', 201, (d, a, b) => intake.createManualLead(d, a, b.tenant_id, b.lead)],
  'crm-contact-update': ['contact', 200, (d, a, b) => crm.updateContact(d.crm, a, b.tenant_id, b.contact_id, b.contact)],
  'crm-note-add': ['note', 201, (d, a, b) => crm.addNote(d.crm, a, b.tenant_id, b.note)],
  'crm-note-archive': ['note', 200, (d, a, b) => crm.archiveNote(d.crm, a, b.tenant_id, b.note_id)],
  'crm-task-create': ['task', 201, (d, a, b) => crm.createTask(d.crm, a, b.tenant_id, b.task)],
  'crm-task-update': ['task', 200, (d, a, b) => crm.updateTask(d.crm, a, b.tenant_id, b.task_id, b.task)],
  'crm-stages-save': ['saved', 200, (d, a, b) => workspace.saveStages(d, a, b.tenant_id, { pipeline_id: b.pipeline_id, stages: b.stages })],
});

export const WORKSPACE_ACTIONS = Object.keys(HANDLERS);

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

export async function handleWorkspaceAction(
  action: string,
  context: { deps: IntakeDeps; actor: CrmActor | null; body: Record<string, unknown> },
): Promise<ActionResponse> {
  if (!context.actor) return { status: 401, body: { error: 'not signed in', code: 'unauthorized' } };
  const handler = HANDLERS[action];
  if (!handler) return { status: 422, body: { error: `"${action}" is not a workspace action`, code: 'invalid' } };
  const [key, status, run] = handler;
  const outcome = await run(context.deps, context.actor, context.body);
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

/**
 * The actor a signed-in user is for one tenant: a member's role, read from `tenant_members`
 * by the caller (the `crm` function), or null — never a field the request supplied.
 */
export function clientActor(userId: string | null, tenantId: unknown, membership: { role?: string } | null): CrmActor | null {
  if (!userId || typeof tenantId !== 'string' || !membership) return null;
  const role = membership.role === 'owner' ? 'owner' : 'staff';
  return { kind: 'client_user', userId, tenantId, role };
}
