/**
 * ARC-240 — what a shared workflow's source-controlled export must be, checked locally,
 * without n8n (ADR ARC-010 §18–§24, §29).
 *
 * A shared workflow is a frame around one module step. The frame is the same in every
 * workflow and is what this checks:
 *
 *   action         ARC's dispatch arrives at a Webhook that n8n verifies natively (JWT, the
 *                  `ARC dispatch` credential) → the execution id is answered at once →
 *                  the envelope is fetched from ARC → the module step → the callback.
 *   error_handler  n8n's Error Trigger → one failure report to ARC.
 *
 * Every call to ARC is an HTTP Request to the bridge URL held in the one environment node,
 * signed by n8n's JWT node with the `ARC bridge signing` credential over a hash of the exact
 * body. Nothing else is reachable from a shared workflow: no other node makes a network call,
 * no credential but those two exists in it, and no Code node can read the environment, load
 * a module or fetch. What a shared workflow may never hold — a tenant id, a credential, a
 * tenant's configuration, an environment's n8n id — is refused wherever it appears.
 *
 * The export is reviewed as it is stored: environment identities stripped (§21), the bridge
 * URL a placeholder, execution data not retained in n8n (§18: n8n's execution history is not
 * where evidence lives — ARC's rows are).
 */

import { findSecretShaped, isPlainObject } from '../scheduler/model.ts';
import { BRIDGE_URL_EXPRESSION, BRIDGE_URL_PLACEHOLDER, environmentNodeUrl, ENVIRONMENT_NODE, type ManifestEntry } from './manifest.ts';

/** The only credentials a shared workflow names — both n8n JWT credentials, both ARC's, never a tenant's. */
export const WORKFLOW_CREDENTIALS = Object.freeze({ dispatch: 'ARC dispatch', signing: 'ARC bridge signing' });

/** Node types reviewed for shared workflows. Anything else needs a review, then a place here. */
export const REVIEWED_NODE_TYPES = Object.freeze([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  'n8n-nodes-base.crypto',
  'n8n-nodes-base.jwt',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.stopAndError',
]);

export const BRIDGE_ROUTES = Object.freeze(['envelope', 'callback', 'failure'] as const);

/**
 * How a bridge call presents the JWT node's token — the one reviewed use of "Bearer" in a
 * shared workflow. It names the token the previous node produced; it can never be one.
 */
export const BRIDGE_AUTHORIZATION = '=Bearer {{ $json.token }}';

/** Whether a bridge call sends exactly the reviewed two headers. */
function bridgeHeaders(params: Record<string, unknown>): boolean {
  const list = params.sendHeaders === true && isPlainObject(params.headerParameters) ? params.headerParameters.parameters : null;
  if (!Array.isArray(list) || list.length !== 2) return false;
  const byName = new Map(list.filter(isPlainObject).map((h) => [String(h.name).toLowerCase(), h.value]));
  return byName.get('authorization') === BRIDGE_AUTHORIZATION && byName.get('content-type') === 'application/json';
}

/** A node's parameters as the secret scan sees them: the reviewed Authorization expression is not a credential. */
function scannedParameters(node: Record<string, unknown>): unknown {
  if (node.type !== 'n8n-nodes-base.httpRequest' || !isPlainObject(node.parameters)) return node.parameters ?? {};
  const params = node.parameters;
  const headers = isPlainObject(params.headerParameters) && Array.isArray(params.headerParameters.parameters) ? params.headerParameters.parameters : null;
  if (!headers) return params;
  return {
    ...params,
    headerParameters: {
      ...params.headerParameters,
      parameters: headers.map((h) => (isPlainObject(h) && h.value === BRIDGE_AUTHORIZATION ? { ...h, value: '(the JWT node\'s token)' } : h)),
    },
  };
}

/** The frame's node names. The error handler reads the callback stage's by name, so they are fixed. */
export const FRAME_NODES = Object.freeze({
  dispatch: 'ARC dispatch',
  accept: 'Accept',
  errorTrigger: 'Workflow failed',
  environment: ENVIRONMENT_NODE.name,
  send: { envelope: 'Send envelope request', callback: 'Send callback', failure: 'Send failure report' },
  callbackStage: ['Prepare callback', 'Hash callback', 'Sign callback', 'Send callback'],
});

/** Settings a shared workflow must have: execution data is ARC's to keep, not n8n's. */
export const REQUIRED_SETTINGS = Object.freeze({
  executionOrder: 'v1',
  saveDataSuccessExecution: 'none',
  saveDataErrorExecution: 'none',
  saveManualExecutions: false,
});

const TYPE = (short: string) => `n8n-nodes-base.${short}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ENVIRONMENT_READS = /\$env\b|\$vars\b|process\s*\.\s*env|\$secrets\b/;
const CODE_FORBIDDEN: [RegExp, string][] = [
  [/\brequire\s*\(/, 'loads a module'],
  [/\bimport\s*\(/, 'loads a module'],
  [/\bfetch\s*\(/, 'makes a network call'],
  [/this\s*\.\s*helpers\b|\$helpers\b/, 'makes a network call through n8n\'s helpers'],
  [/\$getWorkflowStaticData\b/, 'keeps state in n8n'],
];

/** Every string inside a value, with where it is. Set assignments' own ids are n8n's bookkeeping. */
function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' && /assignments\[\d+\]$/.test(path)) continue;
      strings(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** The route a bridge-calling HTTP Request node posts to, or null if it is not one. */
export function bridgeRoute(node: Record<string, unknown>): typeof BRIDGE_ROUTES[number] | null {
  const url = isPlainObject(node.parameters) ? node.parameters.url : null;
  const match = typeof url === 'string' ? /^=\{\{ (.+?) \}\}\/([a-z]+)$/.exec(url) : null;
  if (!match || match[1] !== BRIDGE_URL_EXPRESSION) return null;
  return (BRIDGE_ROUTES as readonly string[]).includes(match[2]) ? match[2] as typeof BRIDGE_ROUTES[number] : null;
}

/**
 * Every problem with one workflow export against its manifest entry. The checksum is
 * checked separately (`workflowChecksum`), because it is the same check the sync makes
 * against n8n.
 */
export function workflowExportProblems(exported: unknown, entry: Pick<ManifestEntry, 'runner_key' | 'workflow_version' | 'role'>): string[] {
  const p: string[] = [];
  if (!isPlainObject(exported) || !Array.isArray(exported.nodes) || !isPlainObject(exported.connections)) {
    return ['not an n8n workflow export: it needs nodes and connections'];
  }
  const ref = `${entry.runner_key}@${entry.workflow_version}`;
  if (exported.name !== ref) p.push(`its name is ${String(exported.name)}, not ${ref} — the manifest entry it is reviewed as`);

  /* no environment's identity (§21: strip environment ids and credentials before versioning). */
  if ('id' in exported) p.push('it carries an n8n workflow id — that is an environment\'s, and lives only in the deployment lookup');
  if (isPlainObject(exported.meta) && 'instanceId' in exported.meta) p.push('it carries the n8n instance it was exported from');
  if (isPlainObject(exported.pinData) && Object.keys(exported.pinData).length) p.push('it carries pinned data — test data never ships');
  if (exported.staticData !== undefined && exported.staticData !== null) p.push('it carries static data — a shared workflow keeps no state in n8n');

  const settings = isPlainObject(exported.settings) ? exported.settings : {};
  if ('errorWorkflow' in settings) p.push('it names an error workflow id — the manifest names its handler; an import links the environment\'s');
  for (const [k, v] of Object.entries(REQUIRED_SETTINGS)) {
    if (settings[k] !== v) p.push(`settings.${k} is ${JSON.stringify(v)}`);
  }

  const nodes = (exported.nodes as unknown[]).filter(isPlainObject);
  if (nodes.length !== (exported.nodes as unknown[]).length) p.push('every node is an object');
  const names = new Set<string>();
  for (const n of nodes) {
    const at = `node ${String(n.name)}`;
    if (typeof n.name !== 'string' || !n.name.trim()) p.push('every node has a name');
    else if (names.has(n.name)) p.push(`${at}: two nodes share a name`);
    else names.add(n.name);
    if (!REVIEWED_NODE_TYPES.includes(String(n.type))) p.push(`${at}: ${String(n.type)} is not a node type reviewed for shared workflows`);

    /* credentials: by name, ARC's two only, never an environment's id. */
    if (n.credentials !== undefined) {
      if (!isPlainObject(n.credentials)) p.push(`${at}: credentials are named`);
      else {
        for (const [kind, c] of Object.entries(n.credentials)) {
          if (kind !== 'jwtAuth') p.push(`${at}: a ${kind} credential — a shared workflow holds no credential but ARC's JWT ones`);
          if (!isPlainObject(c) || !Object.values(WORKFLOW_CREDENTIALS).includes(c.name as string)) p.push(`${at}: its credential is not one of ${Object.values(WORKFLOW_CREDENTIALS).join(', ')}`);
          if (isPlainObject(c) && 'id' in c) p.push(`${at}: its credential carries an environment's id`);
        }
      }
    }

    /* nothing read from the environment, no tenant id, nothing credential-shaped. */
    for (const [path, s] of strings(n.parameters, 'parameters')) {
      if (ENVIRONMENT_READS.test(s)) p.push(`${at}: ${path} reads n8n's environment or variables — ARC hands a workflow what it needs`);
      if (UUID.test(s)) p.push(`${at}: ${path} holds an id — a shared workflow names no tenant, job or record`);
    }
    const secret = findSecretShaped(scannedParameters(n), `${at}.parameters`);
    if (secret) p.push(`${secret} looks like a credential`);

    if (n.type === TYPE('code')) {
      const code = isPlainObject(n.parameters) ? n.parameters.jsCode : null;
      if (typeof code !== 'string') p.push(`${at}: a Code node is JavaScript`);
      else for (const [pattern, what] of CODE_FORBIDDEN) if (pattern.test(code)) p.push(`${at}: its code ${what}`);
      if (isPlainObject(n.parameters) && n.parameters.language !== undefined && n.parameters.language !== 'javaScript') p.push(`${at}: a Code node is JavaScript`);
    }
    if (n.type === TYPE('httpRequest')) {
      const route = bridgeRoute(n);
      const params = isPlainObject(n.parameters) ? n.parameters : {};
      if (!route) p.push(`${at}: an HTTP Request goes to ARC's bridge only — ${BRIDGE_URL_EXPRESSION}/<route>`);
      if (params.method !== 'POST') p.push(`${at}: the bridge is POSTed to`);
      if (params.authentication !== undefined && params.authentication !== 'none') p.push(`${at}: it authenticates with a credential — the bridge takes the JWT node's token`);
      if (!bridgeHeaders(params)) p.push(`${at}: it sends exactly Authorization: ${BRIDGE_AUTHORIZATION} and Content-Type: application/json`);
      if (params.sendBody !== true || params.contentType !== 'raw' || typeof params.body !== 'string' || !params.body.startsWith('={{ $(')) {
        p.push(`${at}: it sends the exact body its hash was taken over, raw, from the node that prepared it`);
      }
    }
    if (n.type === TYPE('jwt')) {
      const params = isPlainObject(n.parameters) ? n.parameters : {};
      const cred = isPlainObject(n.credentials) && isPlainObject(n.credentials.jwtAuth) ? n.credentials.jwtAuth.name : null;
      if (params.operation !== 'sign' || cred !== WORKFLOW_CREDENTIALS.signing) p.push(`${at}: a JWT node signs with ${WORKFLOW_CREDENTIALS.signing}`);
    }
  }

  /* the environment node: exactly one, of the recognised shape, holding the placeholder. */
  const envNodes = nodes.filter((n) => n.name === ENVIRONMENT_NODE.name);
  if (envNodes.length !== 1) p.push(`it has one ${ENVIRONMENT_NODE.name} node`);
  else if (environmentNodeUrl(envNodes[0]) === null) p.push(`${ENVIRONMENT_NODE.name} is a Set node holding only ${ENVIRONMENT_NODE.field}, an https bridge URL`);
  else if (environmentNodeUrl(envNodes[0]) !== BRIDGE_URL_PLACEHOLDER) p.push(`${ENVIRONMENT_NODE.name} holds ${BRIDGE_URL_PLACEHOLDER} in the repository — an import sets the environment's`);

  /* the frame, by role. */
  const ofType = (short: string) => nodes.filter((n) => n.type === TYPE(short));
  const routes = ofType('httpRequest').map(bridgeRoute);
  const sends = (route: typeof BRIDGE_ROUTES[number]) => nodes.find((n) => n.name === FRAME_NODES.send[route] && bridgeRoute(n) === route);
  if (entry.role === 'action') {
    const hooks = ofType('webhook');
    const hook = hooks[0];
    const hp = hook && isPlainObject(hook.parameters) ? hook.parameters : {};
    const hookCred = hook && isPlainObject(hook.credentials) && isPlainObject(hook.credentials.jwtAuth) ? hook.credentials.jwtAuth.name : null;
    if (hooks.length !== 1 || hook.name !== FRAME_NODES.dispatch) p.push(`an action workflow starts at one Webhook, ${FRAME_NODES.dispatch}`);
    else if (hp.httpMethod !== 'POST' || hp.authentication !== 'jwtAuth' || hookCred !== WORKFLOW_CREDENTIALS.dispatch || hp.responseMode !== 'responseNode') {
      p.push(`${FRAME_NODES.dispatch} takes POST, verifies ARC's JWT with ${WORKFLOW_CREDENTIALS.dispatch}, and answers from a Respond node`);
    }
    if (!nodes.some((n) => n.name === FRAME_NODES.accept && n.type === TYPE('respondToWebhook'))) p.push(`an action workflow answers ARC at once, from ${FRAME_NODES.accept}`);
    if (!sends('envelope')) p.push(`an action workflow fetches its envelope from ARC, in ${FRAME_NODES.send.envelope}`);
    if (!sends('callback')) p.push(`an action workflow reports to ARC, in ${FRAME_NODES.send.callback}`);
    for (const name of FRAME_NODES.callbackStage) if (!names.has(name)) p.push(`the callback stage has ${name} — the error handler reads a failure there as after the effect`);
    if (routes.includes('failure') || ofType('errorTrigger').length) p.push('an action workflow does not report failures itself — its error handler does');
  } else {
    if (ofType('errorTrigger').length !== 1 || !nodes.some((n) => n.name === FRAME_NODES.errorTrigger && n.type === TYPE('errorTrigger'))) {
      p.push(`an error handler starts at one Error Trigger, ${FRAME_NODES.errorTrigger}`);
    }
    if (ofType('webhook').length) p.push('an error handler takes no dispatch');
    if (!sends('failure')) p.push(`an error handler reports to ARC, in ${FRAME_NODES.send.failure}`);
    if (routes.some((r) => r !== 'failure')) p.push('an error handler only reports failures');
  }

  /* connections name real nodes. */
  for (const [from, outs] of Object.entries(exported.connections)) {
    if (!names.has(from)) p.push(`connections: ${from} is not a node`);
    const main = isPlainObject(outs) && Array.isArray(outs.main) ? outs.main : [];
    for (const branch of main) {
      for (const link of Array.isArray(branch) ? branch : []) {
        if (!isPlainObject(link) || !names.has(link.node as string)) p.push(`connections: ${from} leads to a node that does not exist`);
      }
    }
  }
  return p;
}
