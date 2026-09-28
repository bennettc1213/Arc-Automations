/**
 * ARC-230 — is what runs what was reviewed? (ADR ARC-010 §21: "verify deployed ==
 * expected version; alert on drift".)
 *
 * One pure comparison of four things: the source-controlled manifest, what ARC has
 * registered (0019), where each version is deployed in one environment, and what that
 * environment's n8n actually holds. It reads n8n only through `N8nWorkflowSource`, which a
 * test fakes and a staging check would back with n8n's API — never a tenant credential,
 * never the only record of anything. It changes nothing: a finding is for a person, who
 * fixes it by publishing, redeploying, reassigning or disabling — never by editing a live
 * workflow.
 */

import { BRIDGE_CONTRACT_VERSION } from './contract.ts';
import { type Manifest, refOf, workflowChecksum } from './manifest.ts';
import type { Assignment, Deployment, RegisteredVersion } from './workflows.ts';

/** What n8n holds for one workflow id: its export, or null if it has none. */
export interface N8nWorkflowSource {
  getWorkflow(n8nWorkflowId: string): Promise<unknown | null>;
}

export const SYNC_FINDINGS = [
  'not_registered',             // in the manifest, not in ARC
  'registered_content_differs', // ARC holds the same version with a different checksum
  'unknown_to_manifest',        // ARC holds a version the manifest does not list
  'not_deployed',               // approved in ARC, no deployment in this environment
  'missing_in_n8n',             // deployed in ARC's lookup, absent from n8n
  'checksum_drift',             // n8n's content is not the reviewed content
  'error_handler_unlinked',     // n8n's errorWorkflow is not this version's deployed handler
  'contract_mismatch',          // speaks a bridge contract ARC does not
  'assignment_not_runnable',    // an active assignment to a draft or disabled version
  'assignment_wrong_action',    // an active assignment to a version that does not execute it
  'assignment_not_deployed',    // an active assignment to a version absent from this environment
] as const;
export type SyncFindingCode = typeof SYNC_FINDINGS[number];

export interface SyncFinding {
  code: SyncFindingCode;
  ref: string;
  detail: string;
}

export async function checkWorkflowSync(input: {
  manifest: Manifest;
  versions: RegisteredVersion[];
  deployments: Deployment[];
  assignments: Assignment[];
  environment: string;
  n8n: N8nWorkflowSource;
}): Promise<SyncFinding[]> {
  const findings: SyncFinding[] = [];
  const add = (code: SyncFindingCode, ref: string, detail: string) => findings.push({ code, ref, detail });

  const registered = new Map(input.versions.map((v) => [`${v.runnerKey}@${v.workflowVersion}`, v]));
  const listed = new Map(input.manifest.workflows.map((e) => [refOf(e), e]));
  const deployed = new Map(input.deployments.filter((d) => d.environment === input.environment).map((d) => [`${d.runnerKey}@${d.workflowVersion}`, d]));

  /* the manifest against ARC */
  for (const [ref, entry] of listed) {
    const v = registered.get(ref);
    if (!v) add('not_registered', ref, 'listed in the manifest but not registered in ARC');
    else if (v.checksum !== entry.checksum) add('registered_content_differs', ref, 'ARC holds this version with other content — publish a new version instead');
  }
  for (const [ref, v] of registered) {
    if (!listed.has(ref) && v.status !== 'disabled') add('unknown_to_manifest', ref, 'registered in ARC but no longer in the manifest');
    if (v.inputContractVersion !== BRIDGE_CONTRACT_VERSION || v.outputContractVersion !== BRIDGE_CONTRACT_VERSION) {
      add('contract_mismatch', ref, `speaks contract ${v.inputContractVersion}/${v.outputContractVersion}, the bridge speaks ${BRIDGE_CONTRACT_VERSION}`);
    }
  }

  /* ARC's lookup against n8n */
  for (const [ref, v] of registered) {
    if (v.status !== 'approved' && v.status !== 'deprecated') continue;
    const d = deployed.get(ref);
    if (!d) {
      add('not_deployed', ref, `approved but not deployed in ${input.environment}`);
      continue;
    }
    const exported = await input.n8n.getWorkflow(d.n8nWorkflowId);
    if (!exported) {
      add('missing_in_n8n', ref, `n8n in ${input.environment} has no workflow ${d.n8nWorkflowId}`);
      continue;
    }
    const actual = await workflowChecksum(exported);
    if (actual !== v.checksum) add('checksum_drift', ref, `n8n's content (${actual ?? 'unreadable'}) is not the reviewed ${v.checksum}`);
    if (v.role === 'action' && v.errorHandlerKey) {
      const handler = deployed.get(`${v.errorHandlerKey}@${v.errorHandlerVersion}`);
      const linked = (exported as { settings?: { errorWorkflow?: unknown } }).settings?.errorWorkflow;
      if (!handler || linked !== handler.n8nWorkflowId) {
        add('error_handler_unlinked', ref, `its error workflow is ${String(linked ?? 'unset')}, not the deployed ${v.errorHandlerKey}@${v.errorHandlerVersion}`);
      }
    }
  }

  /* assignments against what exists here */
  for (const a of input.assignments.filter((x) => x.status === 'active')) {
    const ref = `${a.runnerKey}@${a.workflowVersion}`;
    const v = registered.get(ref);
    const at = `${a.moduleKey}@${a.moduleVersion}/${a.actionType} → ${ref}`;
    if (!v || (v.status !== 'approved' && v.status !== 'deprecated')) {
      add('assignment_not_runnable', at, `the assigned version is ${v?.status ?? 'unregistered'}`);
      continue;
    }
    if (!v.actionTypes.includes(a.actionType)) add('assignment_wrong_action', at, `${ref} does not execute ${a.actionType}`);
    if (!deployed.has(ref)) add('assignment_not_deployed', at, `${ref} is not deployed in ${input.environment}`);
  }

  return findings.sort((x, y) => x.code.localeCompare(y.code) || x.ref.localeCompare(y.ref));
}
