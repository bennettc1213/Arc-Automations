#!/usr/bin/env node
/**
 * The four Lead Recovery workflows the SaaS brief asks for, as drafts (2026-10-13).
 *
 *   node scripts/n8n-drafts.mjs            check: every file in n8n/drafts/ is exactly what
 *                                          this script builds. Exits 1 on any difference.
 *   node scripts/n8n-drafts.mjs --write    rebuild them.
 *
 * A draft is ARC-240's reviewed frame — the one in tests/fixtures/n8n, node for node —
 * around a module step. They are built from that fixture so the frame cannot drift from
 * the one the frame check and the simulator already hold.
 *
 * What a draft is not: registered. None is in n8n/manifest.json, and none can be: an action
 * workflow may only serve a module version that permits n8n, and Lead Recovery v1 runs
 * directly and prohibits it (ADR ARC-010 §11, tests/n8n-workflows.test.js). So a draft
 * cannot be approved, deployed, assigned or dispatched to.
 *
 * What a draft's step does: nothing outside the execution. A shared workflow holds no
 * credential and decides nothing — it asks ARC's connector gateway to perform the one
 * operation its job authorises (ADR §15 step 9, §20). The bridge has no route for that
 * request yet, so each step checks the work is its own kind and reports it as `skipped`.
 * Never as done: nothing was done. See n8n/drafts/README.md for what has to exist first.
 *
 * It contacts no n8n instance and no ARC.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const REFERENCE = new URL('../tests/fixtures/n8n/arc-reference-action@1.0.0.json', import.meta.url);
const DRAFTS_DIR = new URL('../n8n/drafts/', import.meta.url);
const STEP = 'Perform action';

export const DRAFT_VERSION = '0.1.0';

/**
 * One per job in the brief's list. `action_types` are the scheduler's own (0017): a module
 * version that runs through n8n queues these, and the Lead Recovery engine's nine types stay
 * the direct path's. `work` is the kind of work item the step accepts and nothing else.
 */
export const DRAFTS = Object.freeze([
  {
    runner_key: 'arc-lead-inquiry-v1', path: 'arc-lead-inquiry', display_name: 'Lead Recovery: a newly accepted inquiry',
    action_types: ['send_message'], effect_class: 'external_effect', work: 'new_inquiry',
    does: 'the first text to someone who filled in the website form',
  },
  {
    runner_key: 'arc-lead-reply-v1', path: 'arc-lead-reply', display_name: 'Lead Recovery: an inbound reply',
    action_types: ['evaluate_reply'], effect_class: 'external_read', work: 'inbound_reply',
    does: 'reading a reply and moving the qualification on: a question, a route or a person',
  },
  {
    runner_key: 'arc-missed-call-v1', path: 'arc-missed-call', display_name: 'Lead Recovery: a confirmed missed call',
    action_types: ['send_message'], effect_class: 'external_effect', work: 'missed_call',
    does: 'the first text to a caller nobody answered',
  },
  {
    runner_key: 'arc-lead-followup-v1', path: 'arc-lead-followup', display_name: 'Lead Recovery: due follow-up work',
    action_types: ['schedule_follow_up'], effect_class: 'none', work: 'due_followup',
    does: 'the one check-in to a customer who has not replied',
  },
]);

export const draftFile = (draft) => `${draft.runner_key}@${DRAFT_VERSION}.json`;

function stepCode(draft) {
  return [
    `// The module step: ${draft.does}.`,
    '// ARC performs every effect itself (ADR ARC-010 §20). A shared workflow holds no credential',
    '// and decides nothing: its step is to ask ARC\'s connector gateway for the one operation this',
    '// job authorises. The bridge takes no such request from a workflow yet, so this draft checks',
    '// the work is its own kind and reports it as skipped. Never as done: nothing was done.',
    `const SUPPORTED = ${JSON.stringify(draft.action_types)};`,
    `const WORK = ${JSON.stringify(draft.work)};`,
    'const answer = $(\'Send envelope request\').first().json;',
    'if (!answer || answer.contract_version !== 1 || !answer.envelope) throw new Error(\'arc:validation_failed\');',
    'const envelope = answer.envelope;',
    'if (!SUPPORTED.includes(envelope.action_type)) throw new Error(\'arc:unsupported_capability\');',
    'if (!envelope.payload || envelope.payload.work !== WORK) throw new Error(\'arc:validation_failed\');',
    'return [{ json: {',
    '  envelope,',
    '  status: \'skipped\',',
    '  provider_refs: [],',
    '  safe_output_meta: { work: WORK, performed: false, reason: \'connector_gateway_not_built\' },',
    '} }];',
    '',
  ].join('\n');
}

/** The draft's export: the reference frame with its name, webhook path, step and identity set. */
export function buildDraft(draft, reference = JSON.parse(readFileSync(REFERENCE, 'utf8'))) {
  const exported = structuredClone(reference);
  exported.name = `${draft.runner_key}@${DRAFT_VERSION}`;
  for (const node of exported.nodes) {
    if (node.name === 'ARC dispatch') node.parameters.path = draft.path;
    if (node.name === STEP) node.parameters.jsCode = stepCode(draft);
    if (node.name === 'Prepare callback') {
      const before = node.parameters.jsCode;
      node.parameters.jsCode = before.replace(
        /const WORKFLOW = \{[^}]*\};/,
        `const WORKFLOW = { runner_key: '${draft.runner_key}', workflow_version: '${DRAFT_VERSION}' };`,
      );
      if (node.parameters.jsCode === before) throw new Error('the reference frame no longer names its workflow where this script expects it');
    }
  }
  return exported;
}

export const serialise = (exported) => `${JSON.stringify(exported, null, 2)}\n`;

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('n8n-drafts.mjs')) {
  const write = process.argv.includes('--write');
  const problems = [];
  for (const draft of DRAFTS) {
    const text = serialise(buildDraft(draft));
    const target = new URL(draftFile(draft), DRAFTS_DIR);
    if (write) writeFileSync(target, text);
    else {
      let stored = null;
      try { stored = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch { /* reported below */ }
      if (stored !== text) problems.push(`${draftFile(draft)} is not what this script builds — run it with --write`);
    }
  }
  if (problems.length) {
    console.error(problems.map((p) => `✖ ${p}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`n8n/drafts: ${DRAFTS.length} draft workflow(s) ${write ? 'written' : 'match what this script builds'}.`);
  }
}
