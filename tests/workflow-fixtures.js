/* ARC-230 — shared workflows for the database suites: manifest entries, n8n-shaped
 * exports with real checksums, and one call that registers, approves, deploys and assigns.
 *
 * `permitN8n` is the one liberty these suites take. The only module that can hold a run
 * today is Lead Recovery v1, and its registry row says — correctly, ADR ARC-010 §11 —
 * that it runs directly and may never use n8n. To exercise the bridge at all, a suite
 * relaxes that row in its own throwaway database; `workflow-manifest-db` proves first
 * that the real posture is refused.
 */

import assert from 'node:assert/strict';

import { workflowChecksum } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { assignWorkflow, registerDeployment, registerManifest, setWorkflowStatus } from '../supabase/functions/_shared/n8n-runner/workflows.ts';

export async function permitN8n(db, { moduleKey = 'lead_recovery', version = 1, posture = 'optional', mode = 'hybrid' } = {}) {
  await db.query('alter table public.registry_module_versions disable trigger registry_module_versions_immutable');
  try {
    await db.query('update public.registry_module_versions set n8n_posture = $3, execution_mode = $4 where module_key = $1 and version = $2',
      [moduleKey, version, posture, mode]);
  } finally {
    await db.query('alter table public.registry_module_versions enable trigger registry_module_versions_immutable');
  }
}

/** An n8n export: what the editor's "download" gives, ids and layout included. */
export function exportOf(name, { nodes = null, errorWorkflow = undefined, id = 'wf-local', extra = {} } = {}) {
  return {
    id, name, active: true, versionId: crypto.randomUUID(), createdAt: '2026-09-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
    meta: { instanceId: 'instance-abc' },
    nodes: nodes ?? [
      { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: name, authentication: 'jwtAuth' } },
      { id: 'n2', name: 'Fetch envelope', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [200, 0], parameters: { method: 'POST' } },
    ],
    connections: { Webhook: { main: [[{ node: 'Fetch envelope', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1', ...(errorWorkflow ? { errorWorkflow } : {}) },
    ...extra,
  };
}

export const HANDLER = { runner_key: 'arc-runner-error-handler-v1', workflow_version: '1.0.0' };

export async function handlerEntry(overrides = {}) {
  return {
    ...HANDLER, role: 'error_handler', display_name: 'Runner error handler', module_key: null, module_versions: [], action_types: [],
    runner_kind: 'n8n', export_path: 'workflows/arc-runner-error-handler-v1@1.0.0.json',
    checksum: await workflowChecksum(exportOf('arc-runner-error-handler-v1')), input_contract_version: 1, output_contract_version: 1,
    effect_class: 'none', required_capabilities: [], auto_retry: false, timeout_ambiguous: false, error_handler: null, ...overrides,
  };
}

export async function actionEntry(runnerKey, actionTypes, overrides = {}) {
  const version = overrides.workflow_version ?? '1.0.0';
  return {
    runner_key: runnerKey, workflow_version: version, role: 'action', display_name: runnerKey, module_key: 'lead_recovery',
    module_versions: [1], action_types: actionTypes, runner_kind: 'n8n', export_path: `workflows/${runnerKey}@${version}.json`,
    checksum: await workflowChecksum(exportOf(`${runnerKey}@${version}`)), input_contract_version: 1, output_contract_version: 1,
    effect_class: 'external_effect', required_capabilities: [], auto_retry: true, timeout_ambiguous: true, error_handler: { ...HANDLER },
    ...overrides,
  };
}

const must = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message}`); return r.value; };

/**
 * Register a manifest, approve every entry, deploy each to `environment`, and assign the
 * action entries to Lead Recovery v1. Returns the assignment ids by action type and the
 * n8n ids by runner key.
 */
export async function wireWorkflows(store, operator, entries, { environment = 'test', webhookBase = 'https://n8n.invalid/webhook' } = {}) {
  must(await registerManifest(store, { manifest_version: 1, workflows: entries }, operator), 'register');
  const n8nIds = {};
  const assignments = {};
  for (const e of entries) {
    must(await setWorkflowStatus(store, { actorId: operator, runnerKey: e.runner_key, workflowVersion: e.workflow_version, status: 'approved' }), 'approve');
    const n8nWorkflowId = `wf-${e.runner_key}-${e.workflow_version}`.replace(/[^A-Za-z0-9_-]/g, '-');
    n8nIds[`${e.runner_key}@${e.workflow_version}`] = n8nWorkflowId;
    must(await registerDeployment(store, {
      actorId: operator, runnerKey: e.runner_key, workflowVersion: e.workflow_version, environment, n8nWorkflowId,
      webhookUrl: e.role === 'action' ? `${webhookBase}/${e.runner_key}` : null,
    }), 'deploy');
  }
  for (const e of entries.filter((x) => x.role === 'action')) {
    for (const actionType of e.action_types) {
      assignments[actionType] = must(await assignWorkflow(store, {
        actorId: operator, moduleKey: 'lead_recovery', moduleVersion: 1, actionType, runnerKey: e.runner_key, workflowVersion: e.workflow_version,
      }), `assign ${actionType}`);
    }
  }
  return { assignments, n8nIds };
}
