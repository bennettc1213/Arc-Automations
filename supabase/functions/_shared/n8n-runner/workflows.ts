/**
 * ARC-230 — the operator decisions over shared workflows, and the adapter to 0019.
 *
 *   register   put a manifest's entries into ARC as drafts (error handlers first). The
 *              same entry again is a no-op; the same version with other content is refused.
 *   review     approve, deprecate or disable a version. Only forward.
 *   deploy     record where a version runs in one environment — the only place an n8n id
 *              is kept. Production is refused until the licensing gate closes (ADR §26).
 *   assign     bind one action type of one module version to an approved version. The
 *              previous binding is retired, never rewritten, so every past dispatch keeps
 *              the attribution it was recorded with.
 *
 * Every decision names the operator; 0019 checks it again. Results are values, never
 * exceptions, for everything the database refuses on purpose.
 */

import { BridgeError, parseBridgeError } from './store.ts';
import { type Manifest, type ManifestEntry, parseManifest, refOf } from './manifest.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

export type WorkflowResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const ok = <T>(value: T): WorkflowResult<T> => ({ ok: true, value });
const refuse = <T = never>(code: string, message: string): WorkflowResult<T> => ({ ok: false, code, message });

export const WORKFLOW_STATUSES = ['draft', 'approved', 'deprecated', 'disabled'] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];
export const DEPLOYMENT_ENVIRONMENTS = ['staging', 'development', 'test'] as const;

export interface RegisteredVersion {
  id: string;
  runnerKey: string;
  workflowVersion: string;
  role: 'action' | 'error_handler';
  moduleKey: string | null;
  moduleVersions: number[];
  actionTypes: string[];
  checksum: string;
  inputContractVersion: number;
  outputContractVersion: number;
  effectClass: string;
  autoRetry: boolean;
  errorHandlerKey: string | null;
  errorHandlerVersion: string | null;
  status: WorkflowStatus;
}

export interface Deployment {
  id: string;
  runnerKey: string;
  workflowVersion: string;
  environment: string;
  n8nWorkflowId: string;
  webhookUrl: string | null;
}

export interface Assignment {
  id: string;
  moduleKey: string;
  moduleVersion: number;
  actionType: string;
  runnerKey: string;
  workflowVersion: string;
  status: 'active' | 'retired';
}

export interface WorkflowStore {
  registerVersion(actorId: string, entry: ManifestEntry): Promise<{ id: string; created: boolean }>;
  setStatus(actorId: string, runnerKey: string, workflowVersion: string, status: WorkflowStatus, reason: string | null): Promise<string>;
  registerDeployment(actorId: string, d: Omit<Deployment, 'id'>): Promise<string>;
  assign(actorId: string, a: { moduleKey: string; moduleVersion: number; actionType: string; runnerKey: string; workflowVersion: string; reason: string | null }): Promise<string>;
  retireAssignment(actorId: string, assignmentId: string, reason: string | null): Promise<string>;
  listVersions(): Promise<RegisteredVersion[]>;
  listDeployments(environment: string): Promise<Deployment[]>;
  listAssignments(): Promise<Assignment[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function attempt<T>(fn: () => Promise<T>): Promise<WorkflowResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof BridgeError) return refuse(error.code, error.message);
    throw error;
  }
}

/* ── decisions ────────────────────────────────────────────── */

/** Register every entry of a manifest that parses. Error handlers first, since actions name them. */
export async function registerManifest(
  store: WorkflowStore,
  manifestJson: unknown,
  actorId: string,
): Promise<WorkflowResult<{ ref: string; id: string; created: boolean }[]>> {
  if (!UUID.test(actorId)) return refuse('forbidden', 'registration is an operator decision');
  const parsed = parseManifest(manifestJson);
  if (!parsed.ok) return refuse('invalid_manifest', parsed.problems.join('; '));
  const ordered = [...(parsed.manifest as Manifest).workflows].sort((a, b) => (a.role === b.role ? 0 : a.role === 'error_handler' ? -1 : 1));
  const out: { ref: string; id: string; created: boolean }[] = [];
  for (const entry of ordered) {
    const registered = await attempt(() => store.registerVersion(actorId, entry));
    if (!registered.ok) return refuse(registered.code, `${refOf(entry)}: ${registered.message}`);
    out.push({ ref: refOf(entry), ...registered.value });
  }
  return ok(out);
}

export async function setWorkflowStatus(
  store: WorkflowStore,
  input: { actorId: string; runnerKey: string; workflowVersion: string; status: WorkflowStatus; reason?: string | null },
): Promise<WorkflowResult<string>> {
  if (!UUID.test(input.actorId)) return refuse('forbidden', 'a review is an operator decision');
  if (!(WORKFLOW_STATUSES as readonly string[]).includes(input.status)) return refuse('invalid_request', `status is ${WORKFLOW_STATUSES.join(', ')}`);
  return await attempt(() => store.setStatus(input.actorId, input.runnerKey, input.workflowVersion, input.status, input.reason ?? null));
}

export async function registerDeployment(
  store: WorkflowStore,
  input: Omit<Deployment, 'id'> & { actorId: string },
): Promise<WorkflowResult<string>> {
  if (!UUID.test(input.actorId)) return refuse('forbidden', 'a deployment is an operator decision');
  if (input.environment === 'production') {
    return refuse('n8n_production_gated', 'n8n is not deployed to production until the licensing gate (ADR ARC-010 §26) is closed by a recorded decision');
  }
  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(input.environment)) return refuse('invalid_request', `environment is ${DEPLOYMENT_ENVIRONMENTS.join(', ')}`);
  const { actorId, ...d } = input;
  return await attempt(() => store.registerDeployment(actorId, d));
}

export async function assignWorkflow(
  store: WorkflowStore,
  input: { actorId: string; moduleKey: string; moduleVersion: number; actionType: string; runnerKey: string; workflowVersion: string; reason?: string | null },
): Promise<WorkflowResult<string>> {
  if (!UUID.test(input.actorId)) return refuse('forbidden', 'an assignment is an operator decision');
  if (!Number.isInteger(input.moduleVersion) || input.moduleVersion < 1) return refuse('invalid_request', 'moduleVersion is a registry version');
  const { actorId, ...a } = input;
  return await attempt(() => store.assign(actorId, { ...a, reason: a.reason ?? null }));
}

export async function retireAssignment(store: WorkflowStore, input: { actorId: string; assignmentId: string; reason: string }): Promise<WorkflowResult<string>> {
  if (!UUID.test(input.actorId)) return refuse('forbidden', 'retiring an assignment is an operator decision');
  if (!UUID.test(input.assignmentId)) return refuse('invalid_request', 'assignmentId is a uuid');
  return await attempt(() => store.retireAssignment(input.actorId, input.assignmentId, input.reason));
}

/* ── the adapter ──────────────────────────────────────────── */

function raise(what: string, error: { message?: string } | null): never {
  const parsed = parseBridgeError(error?.message);
  if (parsed) throw parsed;
  throw new Error(`${what}: ${error?.message ?? 'unknown database error'}`);
}

// deno-lint-ignore no-explicit-any
const first = (data: any) => (Array.isArray(data) ? data[0] ?? null : data ?? null);
// deno-lint-ignore no-explicit-any
const scalarOf = (data: any) => { const v = first(data); return v && typeof v === 'object' ? Object.values(v)[0] : v; };

export function supabaseWorkflowStore(db: Db): WorkflowStore {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) raise(fn, error);
    return data;
  };
  return {
    async registerVersion(actorId, entry) {
      const row = first(await rpc('register_runner_workflow_version', { p_actor: actorId, p_entry: entry }));
      return { id: row.id, created: row.created === true };
    },
    async setStatus(actorId, runnerKey, workflowVersion, status, reason) {
      return String(scalarOf(await rpc('set_runner_workflow_status', {
        p_actor: actorId, p_runner_key: runnerKey, p_workflow_version: workflowVersion, p_status: status, p_reason: reason,
      })));
    },
    async registerDeployment(actorId, d) {
      return String(scalarOf(await rpc('register_runner_workflow_deployment', {
        p_actor: actorId, p_runner_key: d.runnerKey, p_workflow_version: d.workflowVersion, p_environment: d.environment,
        p_n8n_workflow_id: d.n8nWorkflowId, p_webhook_url: d.webhookUrl,
      })));
    },
    async assign(actorId, a) {
      return String(scalarOf(await rpc('assign_runner_workflow', {
        p_actor: actorId, p_module_key: a.moduleKey, p_module_version: a.moduleVersion, p_action_type: a.actionType,
        p_runner_key: a.runnerKey, p_workflow_version: a.workflowVersion, p_reason: a.reason,
      })));
    },
    async retireAssignment(actorId, assignmentId, reason) {
      return String(scalarOf(await rpc('retire_runner_workflow_assignment', { p_actor: actorId, p_assignment: assignmentId, p_reason: reason })));
    },
    async listVersions() {
      const { data, error } = await db.from('runner_workflow_versions').select('*');
      if (error) raise('workflow versions', error);
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any): RegisteredVersion => ({
        id: r.id, runnerKey: r.runner_key, workflowVersion: r.workflow_version, role: r.role, moduleKey: r.module_key ?? null,
        moduleVersions: (r.module_versions ?? []).map(Number), actionTypes: r.action_types ?? [], checksum: r.checksum,
        inputContractVersion: Number(r.input_contract_version), outputContractVersion: Number(r.output_contract_version),
        effectClass: r.effect_class, autoRetry: r.auto_retry === true, errorHandlerKey: r.error_handler_key ?? null,
        errorHandlerVersion: r.error_handler_version ?? null, status: r.status,
      }));
    },
    async listDeployments(environment) {
      const { data, error } = await db.from('runner_workflow_deployments').select('*').eq('environment', environment).is('retired_at', null);
      if (error) raise('workflow deployments', error);
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any): Deployment => ({
        id: r.id, runnerKey: r.runner_key, workflowVersion: r.workflow_version, environment: r.environment,
        n8nWorkflowId: r.n8n_workflow_id, webhookUrl: r.webhook_url ?? null,
      }));
    },
    async listAssignments() {
      const { data, error } = await db.from('runner_workflow_assignments').select('*').eq('status', 'active');
      if (error) raise('workflow assignments', error);
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any): Assignment => ({
        id: r.id, moduleKey: r.module_key, moduleVersion: Number(r.module_version), actionType: r.action_type,
        runnerKey: r.runner_key, workflowVersion: r.workflow_version, status: r.status,
      }));
    },
  };
}
