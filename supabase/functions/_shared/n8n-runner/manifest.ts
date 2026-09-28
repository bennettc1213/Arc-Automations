/**
 * ARC-230 — the workflow manifest: which shared n8n workflow versions exist, what each
 * one may do, and the checksum of exactly what was reviewed (ADR ARC-010 §21).
 *
 * The manifest (`n8n/manifest.json`) is source-controlled and is the only way a workflow
 * version becomes known to ARC: an operator registers an entry from it (0019), approves
 * it, records where it is deployed in each environment, and assigns it to a module
 * version's action type. Nothing is ever edited in n8n and adopted after the fact — the
 * sync check (`sync.ts`) reports any deployed workflow whose content is not the reviewed
 * one.
 *
 * What an entry never holds: an n8n workflow id, a webhook URL, a tenant, a credential.
 * Those are environment facts (the deployment lookup) or do not belong anywhere near a
 * workflow (§20, §21, §29).
 *
 * The checksum is over the workflow's *meaning*: its name, nodes (type, version,
 * parameters, error-workflow wiring) and connections, canonically serialised — not over
 * ids, positions, timestamps, pin data or the instance it was exported from, which change
 * on every export and would make every sync a false alarm.
 */

import { canonicalJson } from '../canonical-json.ts';
import { getCapability } from '../registry/capabilities.ts';
import { getModuleVersion } from '../registry/modules.ts';
import { actionType, EFFECT_CLASSES, type EffectClass, findSecretShaped, isPlainObject } from '../scheduler/model.ts';
import { BRIDGE_CONTRACT_VERSION, RUNNER_KEY, WORKFLOW_VERSION } from './contract.ts';
import { sha256Hex } from './signing.ts';

export const MANIFEST_VERSION = 1;
export const WORKFLOW_ROLES = ['action', 'error_handler'] as const;
export type WorkflowRole = typeof WORKFLOW_ROLES[number];
export const CHECKSUM = /^sha256:[0-9a-f]{64}$/;

export interface WorkflowRef {
  runner_key: string;
  workflow_version: string;
}

export interface ManifestEntry extends WorkflowRef {
  role: WorkflowRole;
  display_name: string;
  /** the module this workflow serves; null for an error handler shared by all. */
  module_key: string | null;
  /** the module versions it was reviewed against. */
  module_versions: number[];
  /** the scheduler action types it executes. empty for an error handler. */
  action_types: string[];
  runner_kind: string;
  /** relative to the manifest. */
  export_path: string;
  checksum: string;
  input_contract_version: number;
  output_contract_version: number;
  /** the most it can do outside ARC — never less than the action types it serves. */
  effect_class: EffectClass;
  required_capabilities: string[];
  /** whether ARC may retry a failure it reports as retryable. */
  auto_retry: boolean;
  /** whether a timeout leaves its outcome unknown. true for anything that sends or mutates. */
  timeout_ambiguous: boolean;
  error_handler: WorkflowRef | null;
  owner?: string;
}

export interface Manifest {
  manifest_version: number;
  workflows: ManifestEntry[];
}

const ENTRY_FIELDS = new Set([
  'runner_key', 'workflow_version', 'role', 'display_name', 'module_key', 'module_versions', 'action_types', 'runner_kind',
  'export_path', 'checksum', 'input_contract_version', 'output_contract_version', 'effect_class', 'required_capabilities',
  'auto_retry', 'timeout_ambiguous', 'error_handler', 'owner',
]);
const OPTIONAL_FIELDS = new Set(['owner']);

export const refOf = (w: WorkflowRef) => `${w.runner_key}@${w.workflow_version}`;
const effectRank = (c: EffectClass) => EFFECT_CLASSES.indexOf(c);

/** Every problem with one entry, on its own terms. */
function entryProblems(e: Record<string, unknown>, at: string): string[] {
  const p: string[] = [];
  const unknown = Object.keys(e).filter((k) => !ENTRY_FIELDS.has(k));
  if (unknown.length) p.push(`${at}: unknown fields ${unknown.join(', ')}`);
  const missing = [...ENTRY_FIELDS].filter((k) => !OPTIONAL_FIELDS.has(k) && !(k in e));
  if (missing.length) return [...p, `${at}: missing ${missing.join(', ')}`];

  if (typeof e.runner_key !== 'string' || !RUNNER_KEY.test(e.runner_key)) p.push(`${at}: runner_key is an ARC runner key`);
  if (typeof e.workflow_version !== 'string' || !WORKFLOW_VERSION.test(e.workflow_version)) p.push(`${at}: workflow_version is a version`);
  if (!(WORKFLOW_ROLES as readonly string[]).includes(e.role as string)) p.push(`${at}: role is action or error_handler`);
  if (typeof e.display_name !== 'string' || !e.display_name.trim() || e.display_name.length > 120) p.push(`${at}: display_name is 1–120 characters`);
  if (e.runner_kind !== 'n8n') p.push(`${at}: runner_kind is n8n — the manifest governs n8n workflows`);
  if (typeof e.export_path !== 'string' || !/^workflows\/[A-Za-z0-9._@-]+\.json$/.test(e.export_path)) p.push(`${at}: export_path is workflows/<file>.json`);
  if (typeof e.checksum !== 'string' || !CHECKSUM.test(e.checksum)) p.push(`${at}: checksum is sha256:<hex>`);
  if (e.input_contract_version !== BRIDGE_CONTRACT_VERSION || e.output_contract_version !== BRIDGE_CONTRACT_VERSION) {
    p.push(`${at}: input and output contract versions are ${BRIDGE_CONTRACT_VERSION}, the bridge's`);
  }
  if (!(EFFECT_CLASSES as readonly string[]).includes(e.effect_class as string)) p.push(`${at}: effect_class is ${EFFECT_CLASSES.join(', ')}`);
  if (typeof e.auto_retry !== 'boolean' || typeof e.timeout_ambiguous !== 'boolean') p.push(`${at}: auto_retry and timeout_ambiguous are booleans`);
  if (e.effect_class === 'external_effect' && e.timeout_ambiguous !== true) {
    p.push(`${at}: a workflow that sends or mutates cannot claim a timeout leaves nothing unknown`);
  }
  if (!Array.isArray(e.required_capabilities) || !e.required_capabilities.every((c) => typeof c === 'string' && getCapability(c))) {
    p.push(`${at}: required_capabilities are registered capability keys`);
  }
  if ('owner' in e && (typeof e.owner !== 'string' || e.owner.length > 120)) p.push(`${at}: owner is a name`);

  if (e.role === 'error_handler') {
    if (e.module_key !== null || (Array.isArray(e.module_versions) && e.module_versions.length)
        || (Array.isArray(e.action_types) && e.action_types.length) || e.error_handler !== null) {
      p.push(`${at}: an error handler serves no module or action type and has no handler of its own`);
    }
    return p;
  }

  /* an action workflow */
  const moduleKey = e.module_key;
  if (typeof moduleKey !== 'string') {
    p.push(`${at}: module_key names a registry module`);
  } else if (!Array.isArray(e.module_versions) || !e.module_versions.length
      || !e.module_versions.every((v) => Number.isInteger(v) && getModuleVersion(moduleKey, v as number))) {
    p.push(`${at}: module_versions are registered versions of ${moduleKey}`);
  }
  if (!Array.isArray(e.action_types) || !e.action_types.length) {
    p.push(`${at}: an action workflow executes at least one action type`);
  } else {
    for (const key of e.action_types) {
      const def = actionType(key);
      if (!def || def.dispatcher !== 'scheduler') {
        p.push(`${at}: ${String(key)} is not a scheduler action type`);
      } else if (effectRank(e.effect_class as EffectClass) < effectRank(def.effectClass)) {
        p.push(`${at}: ${key} is ${def.effectClass}, so the workflow cannot declare itself ${String(e.effect_class)}`);
      }
    }
  }
  const handler = e.error_handler as Record<string, unknown> | null;
  if (!isPlainObject(handler) || typeof handler.runner_key !== 'string' || typeof handler.workflow_version !== 'string') {
    p.push(`${at}: an action workflow names its error handler`);
  }
  return p;
}

export type ManifestCheck = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

/** The manifest, strictly, with every problem listed rather than the first. */
export function parseManifest(value: unknown): ManifestCheck {
  if (!isPlainObject(value)) return { ok: false, problems: ['the manifest is not an object'] };
  const problems: string[] = [];
  const extra = Object.keys(value).filter((k) => k !== 'manifest_version' && k !== 'workflows');
  if (extra.length) problems.push(`unknown fields ${extra.join(', ')}`);
  if (value.manifest_version !== MANIFEST_VERSION) problems.push(`manifest_version is ${MANIFEST_VERSION}`);
  if (!Array.isArray(value.workflows)) return { ok: false, problems: [...problems, 'workflows is a list'] };

  const seen = new Map<string, Record<string, unknown>>();
  value.workflows.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`workflows[${i}] is not an object`);
      return;
    }
    const at = `workflows[${i}] ${String(raw.runner_key)}@${String(raw.workflow_version)}`;
    problems.push(...entryProblems(raw, at));
    const ref = `${String(raw.runner_key)}@${String(raw.workflow_version)}`;
    if (seen.has(ref)) problems.push(`${at}: listed twice — a version is published once`);
    seen.set(ref, raw);
  });

  /* across entries: handlers exist and are handlers; one key never changes role. */
  const roles = new Map<string, unknown>();
  for (const [ref, e] of seen) {
    const key = String(e.runner_key);
    if (roles.has(key) && roles.get(key) !== e.role) problems.push(`${key}: one runner key is always the same role`);
    roles.set(key, e.role);
    const handler = e.error_handler as Record<string, unknown> | null;
    if (e.role === 'action' && isPlainObject(handler)) {
      const target = seen.get(`${String(handler.runner_key)}@${String(handler.workflow_version)}`);
      if (!target) problems.push(`${ref}: its error handler ${String(handler.runner_key)}@${String(handler.workflow_version)} is not in the manifest`);
      else if (target.role !== 'error_handler') problems.push(`${ref}: ${String(handler.runner_key)} is not an error handler`);
    }
  }
  const secret = findSecretShaped(value, '$manifest');
  if (secret) problems.push(`${secret} looks like a credential — a manifest never holds one`);

  return problems.length ? { ok: false, problems } : { ok: true, manifest: value as unknown as Manifest };
}

/* ── the checksum ─────────────────────────────────────────── */

/** Node fields that describe behaviour. Everything else — id, position, credentials, notes — is not the reviewed content. */
const NODE_FIELDS = ['name', 'type', 'typeVersion', 'parameters', 'disabled', 'onError', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce'];
/** `errorWorkflow` is left out: it is an environment's n8n id. The sync check follows it instead. */
const SETTING_FIELDS = ['executionOrder', 'timezone', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'callerPolicy'];

/**
 * The part of an n8n workflow export that is its behaviour, in a stable form. The same
 * workflow exported from two environments — different ids, instance, timestamps, layout
 * — fingerprints the same; any change to what it does does not.
 */
export function workflowContent(exported: unknown): Record<string, unknown> | null {
  if (!isPlainObject(exported) || !Array.isArray(exported.nodes) || !isPlainObject(exported.connections)) return null;
  const pick = (source: Record<string, unknown>, fields: string[]) =>
    Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));
  const nodes = (exported.nodes as unknown[])
    .filter(isPlainObject)
    .map((n) => pick(n, NODE_FIELDS))
    .sort((x, y) => String(x.name).localeCompare(String(y.name)));
  const settings = isPlainObject(exported.settings) ? pick(exported.settings, SETTING_FIELDS) : {};
  return { name: exported.name ?? null, nodes, connections: exported.connections, settings };
}

/** `sha256:<hex>` of a workflow's behaviour, or null for something that is not a workflow. */
export async function workflowChecksum(exported: unknown): Promise<string | null> {
  const content = workflowContent(exported);
  return content ? `sha256:${await sha256Hex(canonicalJson(content))}` : null;
}
