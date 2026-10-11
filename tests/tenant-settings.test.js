/* ARC-SAAS-020 — the nineteen settings, held to the code.
 *
 * docs/architecture/ARC_TENANT_SETTINGS.md says where each setting the SaaS prompt asks for
 * lives: a field an operator edits, something the engine fixes for every client, or nothing
 * at all. A table like that goes stale the first time a field is added or renamed, so this
 * file is the same table as data, checked three ways:
 *
 *   - every path it names exists in the validator's own default document;
 *   - every field the effective configuration has is placed in it, so a new one cannot
 *     arrive without somebody deciding which setting it is;
 *   - each "fixed" row is checked against the constant that fixes it.
 *
 * It decides nothing and nothing imports it. The follow-up's own behaviour is tested where
 * the engine is: tests/lead-recovery-readiness.test.js and tests/lead-recovery-gate.test.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALERT_CHANNELS,
  DEFAULT_FOLLOWUP_AFTER_MINUTES,
  MAX_FOLLOWUP_AFTER_MINUTES,
  MIN_FOLLOWUP_AFTER_MINUTES,
  defaultConfig,
  validateLeadRecoveryConfig,
} from '../supabase/functions/_shared/lead-recovery-config.ts';
import { assessSafety } from '../supabase/functions/_shared/engine/rules.ts';
import { MODULES } from '../supabase/functions/_shared/registry/modules.ts';
import { LEAD_RECOVERY_SCHEMA, editableFields, ownFields } from '../supabase/functions/_shared/registry/schemas.ts';
import { leadRecoveryConfig } from './config-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(path.join(ROOT, 'docs/architecture/ARC_TENANT_SETTINGS.md'), 'utf8');

/* `reads` is the document's own column. `paths` are into the effective configuration. */
const NINETEEN = [
  { n: 1, setting: 'Business name', reads: 'Stored', paths: ['company_name'] },
  { n: 2, setting: 'Trade / niche', reads: 'Not stored', paths: [] },
  { n: 3, setting: 'Service area', reads: 'Stored', paths: ['service_area'] },
  { n: 4, setting: 'Business hours', reads: 'Stored', paths: ['business_hours', 'holidays', 'timezone'] },
  { n: 5, setting: 'Emergency hours', reads: 'Fixed', paths: [] },
  { n: 6, setting: 'Emergency keywords', reads: 'Stored', paths: ['safety.emergency_keywords'] },
  { n: 7, setting: 'Services offered', reads: 'Stored', paths: ['services'] },
  { n: 8, setting: 'Services not offered', reads: 'Stored, differently', paths: ['services', 'safety.always_handoff_services', 'safety.handoff_on_ambiguous_scope'] },
  { n: 9, setting: 'Owner alert phone', reads: 'Stored', paths: ['staff_alerts'] },
  { n: 10, setting: 'Backup contact', reads: 'Stored', paths: ['staff_alerts'] },
  { n: 11, setting: 'Preferred handoff method', reads: 'Fixed', paths: [] },
  { n: 12, setting: 'Booking link or instructions', reads: 'Stored', paths: ['booking_url', 'templates.reply_ack', 'templates.reply_ack_booking'] },
  { n: 13, setting: 'First response template', reads: 'Stored', paths: ['templates.first_response', 'templates.after_hours_response'] },
  { n: 14, setting: 'Qualification questions', reads: 'Stored, as wording', paths: ['templates.first_response'] },
  { n: 15, setting: 'Follow-up limits', reads: 'Stored', paths: ['followup', 'templates.followup'] },
  { n: 16, setting: 'Quiet hours', reads: 'Stored', paths: ['after_hours', 'business_hours'] },
  { n: 17, setting: 'Opt-out and stop list', reads: 'Stored and fixed', paths: ['compliance.opt_out_language'] },
  { n: 18, setting: 'Twilio number and forwarding status', reads: 'Stored, and derived', paths: ['twilio', 'forwarding', 'compliance'] },
  { n: 19, setting: 'n8n workflow status', reads: 'Does not apply', paths: [] },
];

/* fields the configuration has that the prompt's nineteen do not ask for. */
const BEYOND_THE_NINETEEN = ['ai'];

const at = (doc, dotted) => dotted.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);
const rootOf = (dotted) => dotted.split('.')[0];

describe('the nineteen settings the SaaS prompt asks for', () => {
  test('there are nineteen, and the document lists each one as this file has it', () => {
    assert.equal(NINETEEN.length, 19);
    for (const row of NINETEEN) {
      const line = DOC.split('\n').find((text) => text.startsWith(`| ${row.n} | `));
      assert.ok(line, `row ${row.n} is missing from the document`);
      const cells = line.split('|').map((cell) => cell.trim());
      assert.equal(cells[2], row.setting, `row ${row.n}`);
      assert.equal(cells[3], row.reads, `row ${row.n}`);
      for (const dotted of row.paths) assert.ok(cells[4].includes(`\`${dotted}\``), `row ${row.n} does not name ${dotted}`);
      assert.equal((cells[4].match(/`/g) ?? []).length / 2, row.paths.length, `row ${row.n} names a path this file does not`);
    }
  });

  test('every path named exists in the validator\'s own default document', () => {
    const defaults = defaultConfig();
    for (const row of NINETEEN) {
      for (const dotted of row.paths) assert.notEqual(at(defaults, dotted), undefined, `${row.setting}: ${dotted}`);
    }
  });

  test('every field the configuration has is placed, so a new one cannot arrive unnoticed', () => {
    const placed = new Set([...NINETEEN.flatMap((row) => row.paths.map(rootOf)), ...BEYOND_THE_NINETEEN]);
    assert.deepEqual(Object.keys(defaultConfig()).filter((key) => !placed.has(key)), []);
    assert.deepEqual([...placed].filter((key) => !(key in defaultConfig())), []);
    for (const key of BEYOND_THE_NINETEEN) assert.ok(DOC.includes(`\`${key}\``), `${key} is not mentioned in the document`);
  });

  test('a stored setting is a registered field an operator can edit, and no client can', () => {
    const operator = editableFields(LEAD_RECOVERY_SCHEMA.key, 'operator').map((field) => field.key);
    for (const key of new Set(NINETEEN.flatMap((row) => row.paths.map(rootOf)))) assert.ok(operator.includes(key), key);
    assert.deepEqual(editableFields(LEAD_RECOVERY_SCHEMA.key, 'client'), []);
    assert.ok(ownFields(LEAD_RECOVERY_SCHEMA.key).some((field) => field.key === 'followup'));
  });
});

describe('what the engine fixes for every client', () => {
  test('the handoff method is a text, and an email recipient is refused rather than stored', () => {
    assert.deepEqual([...ALERT_CHANNELS], ['sms']);
    const result = validateLeadRecoveryConfig({ ...leadRecoveryConfig(), staff_alerts: [{ name: 'office', channel: 'email', address: 'office@halstead.example' }] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /email alerts are not built yet/);
  });

  test('a backup contact is a second row, and there is room for one', () => {
    const result = validateLeadRecoveryConfig({
      ...leadRecoveryConfig(),
      staff_alerts: [{ name: 'Dana', channel: 'sms', address: '+16145550188' }, { name: 'Sam', channel: 'sms', address: '+16145550189' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.config.staff_alerts.length, 2);
  });

  test('there is no decline list: a service that must reach a person is named, and a client\'s own emergency word only adds', () => {
    assert.equal(validateLeadRecoveryConfig({ ...leadRecoveryConfig(), services_not_offered: ['duct cleaning'] }).ok, false);
    const verdict = assessSafety('can you look at the boiler, it is making a banging noise', { emergencyKeywords: ['banging'], alwaysHandoffServices: ['boiler'] });
    assert.equal(verdict.requiresHuman, true);
    assert.deepEqual(verdict.flags.sort(), ['distressed', 'human_only']);
  });

  test('no trade, no emergency window and no question list can be stored', () => {
    for (const key of ['trade', 'niche', 'emergency_hours', 'qualification_questions', 'quiet_hours', 'n8n']) {
      const result = validateLeadRecoveryConfig({ ...leadRecoveryConfig(), [key]: 'anything' });
      assert.equal(result.ok, false, key);
      assert.match(result.errors.join(' '), new RegExp(`${key} is not a setting this module has`));
    }
  });

  test('Lead Recovery has no workflow to report on: it runs directly and may never be handed to n8n', () => {
    const runtime = MODULES.find((module) => module.key === 'lead_recovery').versions.at(-1).runtime;
    assert.deepEqual([runtime.executionMode, runtime.n8n, runtime.workflowKey], ['direct', 'prohibited', null]);
  });

  test('the follow-up\'s limits are the ones the document states', () => {
    assert.deepEqual(defaultConfig().followup, { enabled: true, after_minutes: DEFAULT_FOLLOWUP_AFTER_MINUTES });
    assert.deepEqual([DEFAULT_FOLLOWUP_AFTER_MINUTES, MIN_FOLLOWUP_AFTER_MINUTES, MAX_FOLLOWUP_AFTER_MINUTES], [60, 15, 1440]);
    assert.ok(DOC.includes('"followup": { "enabled": true, "after_minutes": 60 }'));
    assert.match(DOC, /from 15 to 1440/);
  });
});
