#!/usr/bin/env node
/**
 * ARC-240 — check the shared n8n workflows against their manifest, without n8n.
 *
 *   node scripts/n8n-manifest.mjs            check: parse the manifest, validate every export,
 *                                            and compare each checksum. Exits 1 on any problem.
 *   node scripts/n8n-manifest.mjs --write    recompute the checksums into n8n/manifest.json
 *                                            after editing a workflow. It changes nothing
 *                                            else — review, register and approve as usual.
 *
 * The same checks `npm test` runs (tests/n8n-workflows.test.js); this is the quick loop
 * while editing an export. It contacts no n8n instance and no ARC.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { parseManifest, workflowChecksum } from '../supabase/functions/_shared/n8n-runner/manifest.ts';
import { workflowExportProblems } from '../supabase/functions/_shared/n8n-runner/exports.ts';

const MANIFEST = new URL('../n8n/manifest.json', import.meta.url);
const write = process.argv.includes('--write');

const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const problems = [];
for (const [i, entry] of (Array.isArray(raw.workflows) ? raw.workflows : []).entries()) {
  const ref = `${entry.runner_key}@${entry.workflow_version}`;
  let exported;
  try {
    exported = JSON.parse(readFileSync(new URL(`../n8n/${entry.export_path}`, import.meta.url), 'utf8'));
  } catch (error) {
    problems.push(`${ref}: ${entry.export_path} could not be read as JSON (${error.message})`);
    continue;
  }
  for (const p of workflowExportProblems(exported, entry)) problems.push(`${ref}: ${p}`);
  const checksum = await workflowChecksum(exported);
  if (write) raw.workflows[i].checksum = checksum;
  else if (checksum !== entry.checksum) problems.push(`${ref}: the export checks out as ${checksum}, the manifest says ${entry.checksum}`);
}
const parsed = parseManifest(raw);
if (!parsed.ok) problems.push(...parsed.problems);

if (write && !problems.length) {
  writeFileSync(MANIFEST, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`n8n/manifest.json: ${raw.workflows.length} checksum(s) written.`);
}
if (problems.length) {
  console.error(problems.map((p) => `✖ ${p}`).join('\n'));
  process.exitCode = 1;
} else if (!write) {
  console.log(`n8n/manifest.json: ${raw.workflows.length} workflow(s), every export valid and matching its checksum.`);
}
