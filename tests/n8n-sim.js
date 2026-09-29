/* ARC-240 — a small, strict stand-in for n8n, so the shared workflows' own exports run
 * locally: their real graph, their real Code nodes, their real expressions.
 *
 * It models only the node types the shared frame uses, as n8n documents them, and throws on
 * anything else — a workflow that needs more than this is one these tests cannot vouch for.
 * It does its own hashing and signing with node:crypto rather than ARC's code, so a mismatch
 * between what ARC verifies and what a JWT node produces shows up here instead of cancelling
 * out. It is not n8n: whether a real instance behaves the same is the hosted gate (ARC-OPS-520).
 *
 * What it does, as n8n would:
 *   - an import sets the environment node's bridge URL (the repository holds a placeholder);
 *   - a Webhook with JWT auth refuses a token that does not verify, or has expired;
 *   - "Respond to Webhook" answers the caller, and the execution carries on afterwards;
 *   - a node that throws fails the execution, and the workflow's error workflow then runs
 *     from its Error Trigger with the failed execution's id, workflow and error — nothing else.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { environmentNodeUrl } from '../supabase/functions/_shared/n8n-runner/manifest.ts';

export const loadExport = (url) => JSON.parse(readFileSync(url, 'utf8'));
export const REFERENCE_ACTION = new URL('./fixtures/n8n/arc-reference-action@1.0.0.json', import.meta.url);
export const ERROR_HANDLER = new URL('../n8n/workflows/arc-runner-error-handler-v1@1.0.0.json', import.meta.url);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** HS256, as jsonwebtoken (n8n's JWT node) produces it. */
function signJwt(claims, secret) {
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

/** What n8n's Webhook JWT auth does: the signature, HS256, and `exp`. */
function jwtVerifies(token, secret, nowSeconds) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return false;
  try {
    if (JSON.parse(Buffer.from(h, 'base64url').toString()).alg !== 'HS256') return false;
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    return typeof claims.exp !== 'number' || claims.exp > nowSeconds;
  } catch {
    return false;
  }
}

class NodeError extends Error {
  constructor(message, { name = 'NodeOperationError', httpCode = undefined } = {}) {
    super(message);
    this.name = name;
    if (httpCode !== undefined) this.httpCode = httpCode;
  }
}

/**
 * @param credentials  secrets by n8n credential name ('ARC dispatch', 'ARC bridge signing').
 * @param bridgeUrl    this environment's runner-bridge URL, set into the environment node on import.
 * @param http         async (url, { method, headers, body }) => { status, text } — ARC, as the
 *                     workflow reaches it. Throwing is a network failure.
 * @param firstExecutionId  where this instance's execution ids start. An n8n instance never
 *                     reuses one, so tests sharing a database give each instance its own range.
 */
export function createN8n({ credentials, bridgeUrl, http, firstExecutionId = 100 }) {
  const workflows = new Map();  // n8n id → { export, errorWorkflow }
  const pending = [];           // continuations after a Respond node, in order
  const executions = [];
  let nextExecution = firstExecutionId;

  const secretFor = (node) => {
    const name = node.credentials?.jwtAuth?.name;
    if (!name || !(name in credentials)) throw new Error(`the simulator has no credential named ${String(name)}`);
    return credentials[name];
  };

  function deploy(exported, n8nId, { errorWorkflow = null } = {}) {
    const copy = structuredClone(exported);
    for (const node of copy.nodes) {
      if (environmentNodeUrl(node) !== null) node.parameters.assignments.assignments[0].value = bridgeUrl;
    }
    copy.id = n8nId;
    copy.settings = { ...copy.settings, ...(errorWorkflow ? { errorWorkflow } : {}) };
    workflows.set(n8nId, copy);
    return copy;
  }

  /* ── expressions ── */
  function context(state, item) {
    const $ = (name) => {
      if (!state.outputs.has(name)) throw new Error(`the expression reads ${name}, which has not run`);
      const items = state.outputs.get(name);
      return { first: () => items[0], all: () => items, item: items[0] };
    };
    return { $json: item?.json ?? {}, $, $execution: { id: state.id }, $input: { first: () => state.input[0], all: () => state.input } };
  }
  function evaluate(value, ctx) {
    if (Array.isArray(value)) return value.map((v) => evaluate(v, ctx));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, evaluate(v, ctx)]));
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const template = value.slice(1);
    const run = (expr) => new Function('$json', '$', '$execution', '$input', `return (${expr});`)(ctx.$json, ctx.$, ctx.$execution, ctx.$input);
    const whole = /^\{\{([\s\S]+?)\}\}$/.exec(template);
    if (whole && !template.slice(2, -2).includes('}}')) return run(whole[1]);
    return template.replace(/\{\{([\s\S]+?)\}\}/g, (_, expr) => String(run(expr)));
  }

  /* ── nodes ── */
  async function runNode(node, state) {
    const p = node.parameters ?? {};
    const input = state.input;
    switch (node.type) {
      case 'n8n-nodes-base.webhook':
      case 'n8n-nodes-base.errorTrigger':
        return state.trigger;
      case 'n8n-nodes-base.respondToWebhook': {
        if (p.respondWith !== 'json') throw new Error('the simulator answers JSON only');
        const raw = evaluate(p.responseBody, context(state, input[0]));
        state.respond({ status: p.options?.responseCode ?? 200, body: typeof raw === 'string' ? JSON.parse(raw) : raw });
        return input;
      }
      case 'n8n-nodes-base.set': {
        const url = environmentNodeUrl(node);
        if (url === null) throw new Error('the simulator models only the environment Set node');
        return [{ json: { arc_bridge_url: url } }];
      }
      case 'n8n-nodes-base.code': {
        const AsyncFunction = (async () => {}).constructor;
        const ctx = context(state, input[0]);
        let out;
        try {
          out = await new AsyncFunction('$input', '$', '$execution', p.jsCode)(ctx.$input, ctx.$, ctx.$execution);
        } catch (error) {
          throw new NodeError(`${error.message} [line 1]`);
        }
        if (!Array.isArray(out) || !out.every((x) => x && typeof x === 'object' && 'json' in x)) throw new Error(`${node.name} must return items`);
        return out;
      }
      case 'n8n-nodes-base.crypto': {
        if (p.action !== 'hash' || p.type !== 'SHA256' || p.encoding !== 'hex') throw new Error('the simulator hashes SHA-256 hex only');
        return input.map((item) => ({
          json: { ...item.json, [p.dataPropertyName]: createHash('sha256').update(String(evaluate(p.value, context(state, item))), 'utf8').digest('hex') },
        }));
      }
      case 'n8n-nodes-base.jwt': {
        if (p.operation !== 'sign' || p.useJson !== true) throw new Error('the simulator signs JSON claims only');
        return input.map((item) => {
          const raw = evaluate(p.claimsJson, context(state, item));
          return { json: { token: signJwt(typeof raw === 'string' ? JSON.parse(raw) : raw, secretFor(node)) } };
        });
      }
      case 'n8n-nodes-base.httpRequest': {
        if (p.contentType !== 'raw' || p.sendBody !== true) throw new Error('the simulator sends raw bodies only');
        const out = [];
        for (const item of input) {
          const ctx = context(state, item);
          const headers = Object.fromEntries((p.headerParameters?.parameters ?? []).map((h) => [h.name.toLowerCase(), String(evaluate(h.value, ctx))]));
          let response;
          try {
            response = await http(String(evaluate(p.url, ctx)), { method: p.method, headers, body: String(evaluate(p.body, ctx)) });
          } catch (error) {
            throw new NodeError(error.message, { name: 'NodeApiError' });
          }
          if (response.status < 200 || response.status > 299) {
            throw new NodeError(`Request failed with status code ${response.status}`, { name: 'NodeApiError', httpCode: String(response.status) });
          }
          out.push({ json: response.text ? JSON.parse(response.text) : {} });
        }
        return out;
      }
      case 'n8n-nodes-base.stopAndError':
        throw new NodeError(String(evaluate(p.errorMessage, context(state, input[0]))));
      default:
        throw new Error(`the simulator does not model ${node.type}`);
    }
  }

  /** Run from `start`, one node after another, until the end or a Respond node (then pause). */
  async function advance(workflow, state, startName) {
    const byName = new Map(workflow.nodes.map((n) => [n.name, n]));
    let name = startName;
    while (name) {
      const node = byName.get(name);
      let output;
      try {
        output = await runNode(node, state);
      } catch (error) {
        return fail(workflow, state, node, error);
      }
      state.outputs.set(name, output);
      state.lastNode = name;
      state.input = output;
      const next = workflow.connections[name]?.main?.[0] ?? [];
      if (next.length > 1) throw new Error('the simulator runs straight-line workflows only');
      name = output.length ? next[0]?.node : undefined;
      if (node.type === 'n8n-nodes-base.respondToWebhook' && name) {
        const resume = name;
        pending.push(() => advance(workflow, state, resume));
        return null;
      }
    }
    return finish(state, { status: 'success' });
  }

  function finish(state, result) {
    const record = { id: state.id, workflowId: state.workflowId, outputs: state.outputs, ...result };
    executions.push(record);
    return record;
  }

  async function fail(workflow, state, node, error) {
    const record = finish(state, {
      status: 'error',
      error: { message: error.message, name: error.name ?? 'Error', httpCode: error.httpCode, node: { name: node.name, type: node.type } },
      lastNode: node.name,
    });
    const handlerId = workflow.settings?.errorWorkflow;
    if (handlerId && workflows.has(handlerId)) {
      await start(handlerId, [{
        json: {
          execution: {
            id: state.id, url: `https://n8n.invalid/workflow/${state.workflowId}/executions/${state.id}`, retryOf: null,
            error: { message: error.message, name: error.name ?? 'Error', stack: 'hidden', ...(error.httpCode ? { httpCode: error.httpCode } : {}), node: { name: node.name, type: node.type } },
            lastNodeExecuted: node.name, mode: 'webhook',
          },
          workflow: { id: state.workflowId, name: workflow.name },
        },
      }]);
    }
    if (state.respond && !state.responded) state.respond({ status: 500, body: { message: 'Error in workflow' } });
    return record;
  }

  async function start(n8nId, trigger, respond = null) {
    const workflow = workflows.get(n8nId);
    const first = workflow.nodes.find((n) => ['n8n-nodes-base.webhook', 'n8n-nodes-base.errorTrigger'].includes(n.type));
    const state = {
      id: String(nextExecution++), workflowId: n8nId, trigger, input: trigger, outputs: new Map(), lastNode: null, responded: false,
      respond: respond ? (answer) => { state.responded = true; respond(answer); } : null,
    };
    return await advance(workflow, state, first.name);
  }

  /** ARC's dispatch arriving at a webhook URL. Answers when the workflow responds (or fails before it). */
  async function webhook(url, { headers, body }) {
    const path = new URL(url).pathname.replace(/^\/webhook\//, '');
    const entry = [...workflows.entries()].find(([, w]) => w.nodes.some((n) => n.type === 'n8n-nodes-base.webhook' && n.parameters.path === path));
    if (!entry) return { status: 404, body: { message: 'webhook not registered' } };
    const [n8nId, workflow] = entry;
    const hook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    const token = String(headers.authorization ?? headers.Authorization ?? '').replace(/^Bearer /, '');
    if (!jwtVerifies(token, secretFor(hook), Math.floor(Date.now() / 1000))) return { status: 403, body: { message: 'Authorization data is wrong!' } };
    let answer = null;
    const trigger = [{ json: { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), params: {}, query: {}, body: JSON.parse(body), webhookUrl: url, executionMode: 'production' } }];
    await start(n8nId, trigger, (a) => { answer = a; });
    return answer ?? { status: 500, body: { message: 'Workflow did not respond' } };
  }

  /** Run everything a Respond node left to carry on — as n8n does, after the caller has its answer. */
  async function drain() {
    while (pending.length) await pending.shift()();
  }

  return { deploy, webhook, drain, executions, start };
}
