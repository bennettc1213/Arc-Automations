/**
 * The operator surface of ARC-350: a client's forms, API endpoints, imports and typed-in leads.
 *
 * Behind the `ops` function's admin check like everything in this directory. The actor is
 * the verified token's user, never a field in the body, and 0024 checks it against
 * `arc_admins` again on every write. Every action takes `tenant_id`.
 *
 *   intake-overview          forms, endpoints (never a token or its hash), recent imports,
 *                            and the latest arrivals through any door
 *
 * Forms
 *   intake-form-save         { form: { name, definition, dedupe_minutes?, hourly_cap? }, id? }
 *                            a new form is a draft with a new link
 *   intake-form-status       { id, status: draft | published | archived }      audited
 *
 * API endpoints
 *   intake-endpoint-create   { endpoint: { name } }   → { endpoint, token }; the token is in
 *                            this response and nowhere afterwards                audited
 *   intake-endpoint-revoke   { id }                                             audited
 *
 * Leads
 *   intake-lead-create       { lead: { contact_id | contact: {...}, lead: { title, summary,
 *                            service, priority }, allow_duplicate? } }
 *                            → { outcome: created | duplicate, lead_id, contact_id };
 *                            409 `ambiguous_contact` with the candidates when several
 *                            customers share the phone or email
 *
 * Imports
 *   intake-import-inspect    { csv }   headings, a suggested mapping, the first rows. writes nothing
 *   intake-import-preview    { file_name, csv, mapping, dedupe_minutes? }   stores the rows and
 *                            says what each would become
 *   intake-import-get        { import_id }
 *   intake-import-commit     { import_id }   the next batch; call again while `remaining` > 0
 *   intake-import-cancel     { import_id }
 *
 * 422 with `field_errors` lists every problem with an input at once.
 */

import type { CrmActor } from '../_shared/crm/model.ts';
import { CRM_ERROR_STATUS, type CrmOutcome } from '../_shared/crm/service.ts';
import * as intake from '../_shared/intake/service.ts';
import type { IntakeDeps } from '../_shared/intake/service.ts';

export interface IntakeActionContext {
  deps: IntakeDeps;
  body: Record<string, unknown>;
  actorId: string | null;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

type Handler = (deps: IntakeDeps, actor: CrmActor, body: Record<string, unknown>) => Promise<CrmOutcome<unknown>>;

/** [what the result is called in the response, status on success, the call] */
const HANDLERS: Readonly<Record<string, [key: string, status: number, run: Handler]>> = Object.freeze({
  'intake-overview': ['intake', 200, (d, a, b) => intake.getIntakeOverview(d, a, b.tenant_id)],
  'intake-form-save': ['form', 200, (d, a, b) => intake.saveForm(d, a, b.tenant_id, b.form, b.id)],
  'intake-form-status': ['form', 200, (d, a, b) => intake.setFormStatus(d, a, b.tenant_id, b.id, b.status)],
  'intake-endpoint-create': ['created', 201, (d, a, b) => intake.createEndpoint(d, a, b.tenant_id, b.endpoint)],
  'intake-endpoint-revoke': ['endpoint', 200, (d, a, b) => intake.revokeEndpoint(d, a, b.tenant_id, b.id)],
  'intake-lead-create': ['arrival', 201, (d, a, b) => intake.createManualLead(d, a, b.tenant_id, b.lead)],
  'intake-import-inspect': ['inspection', 200, (d, a, b) => intake.inspectCsv(d, a, b.tenant_id, b)],
  'intake-import-preview': ['preview', 201, (d, a, b) => intake.previewImport(d, a, b.tenant_id, b)],
  'intake-import-get': ['preview', 200, (d, a, b) => intake.getImport(d, a, b.tenant_id, b.import_id)],
  'intake-import-commit': ['progress', 200, (d, a, b) => intake.commitImport(d, a, b.tenant_id, b.import_id)],
  'intake-import-cancel': ['import', 200, (d, a, b) => intake.cancelImport(d, a, b.tenant_id, b.import_id)],
});

export const INTAKE_ACTIONS = Object.keys(HANDLERS);

export async function handleIntakeAction(action: string, context: IntakeActionContext): Promise<ActionResponse> {
  if (!context.actorId) return { status: 401, body: { error: 'not signed in', code: 'unauthorized' } };
  const handler = HANDLERS[action];
  if (!handler) return { status: 422, body: { error: `"${action}" is not an intake action`, code: 'invalid' } };
  const [key, status, run] = handler;
  const outcome = await run(context.deps, { kind: 'operator', userId: context.actorId }, context.body);
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
