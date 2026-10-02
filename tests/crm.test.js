/* ARC-340 — the CRM model: who may do what, which side owns a field, and what an input must be.
 *
 * No database: this is `_shared/crm/model.ts` alone, the part a screen can import. The same
 * rules against real SQL are in tests/crm-db.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  can, contactSafety, CRM_PERMISSIONS, effectivePolicy, fieldOwner, OBJECT_TYPES, parseBusinessHours,
  parseContactInput, parseLeadInput, parseNoteInput, parsePipelineInput, parsePolicyInput,
  parseSourceEventInput, parseTaskInput, POLICY_FIELDS, secretProblem, writeDecision,
} from '../supabase/functions/_shared/crm/model.ts';
import { ROUTE_KEYS } from '../supabase/functions/_shared/routes/model.ts';

const T = '11111111-0000-4000-8000-000000000001';
const U = '22222222-0000-4000-8000-000000000002';
const operator = { kind: 'operator', userId: U };
const owner = { kind: 'client_user', userId: U, tenantId: T, role: 'owner' };
const staff = { kind: 'client_user', userId: U, tenantId: T, role: 'staff' };
const system = { kind: 'system' };
const sync = { kind: 'external', connectorKey: 'jobber' };

const allowed = (actor, tenant = T) => CRM_PERMISSIONS.filter((p) => can(actor, p, tenant).ok);
const fields = (parsed) => parsed.errors.map((e) => e.field).sort();

describe('who may do what', () => {
  test('each kind of actor has exactly its permissions', () => {
    assert.deepEqual(allowed(operator), [...CRM_PERMISSIONS]);
    assert.deepEqual(allowed(owner), ['read', 'record', 'sensitive', 'business']);
    assert.deepEqual(allowed(staff), ['read', 'record']);
    assert.deepEqual(allowed(system), ['record', 'mapping']);
    assert.deepEqual(allowed(sync), ['record', 'mapping']);
    assert.equal(can(null, 'read', T).code, 'unauthorized');
  });

  test('a client user has no permission at all in another tenant', () => {
    assert.deepEqual(allowed(owner, '33333333-0000-4000-8000-000000000003'), []);
    assert.equal(can(owner, 'read', '33333333-0000-4000-8000-000000000003').code, 'forbidden');
  });
});

describe('which side owns a field', () => {
  const arc = effectivePolicy(null, 'contact');
  const external = effectivePolicy({ authority: 'external', connector_key: 'jobber', field_owners: {} }, 'contact');
  const hybrid = effectivePolicy({ authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'external' } }, 'contact');

  test('no policy row means ARC', () => {
    assert.equal(arc.authority, 'arc');
    assert.equal(fieldOwner(arc, 'phone'), 'arc');
  });

  test('ARC\'s own working state is never handed over, whatever the policy', () => {
    for (const type of OBJECT_TYPES) {
      const policy = effectivePolicy({ authority: 'external', connector_key: 'jobber', field_owners: {} }, type);
      for (const field of ['owner_user_id', 'archived_at', 'recovery_lead_id', 'merged_into_id', 'updated_by']) {
        assert.equal(POLICY_FIELDS[type].includes(field), false, `${type}.${field}`);
        assert.equal(fieldOwner(policy, field), 'arc');
      }
    }
  });

  test('the owning side writes and the other is refused — there is no both', () => {
    assert.equal(writeDecision(arc, operator, 'update', ['phone']).ok, true);
    assert.equal(writeDecision(arc, sync, 'update', ['phone']).code, 'arc_authority');
    assert.equal(writeDecision(external, operator, 'update', ['phone']).code, 'external_authority');
    assert.equal(writeDecision(external, sync, 'update', ['phone']).ok, true);
    assert.equal(writeDecision(hybrid, operator, 'update', ['email']).ok, true);
    assert.equal(writeDecision(hybrid, operator, 'update', ['email', 'phone']).code, 'external_authority');
    assert.equal(writeDecision(hybrid, sync, 'update', ['phone']).ok, true);
    assert.equal(writeDecision(hybrid, sync, 'update', ['email']).code, 'arc_authority');
    /* every actor falls on exactly one side for every policy field. */
    for (const policy of [arc, external, hybrid]) {
      for (const field of POLICY_FIELDS.contact) {
        const sides = [writeDecision(policy, operator, 'update', [field]).ok, writeDecision(policy, sync, 'update', [field]).ok];
        assert.equal(sides.filter(Boolean).length, 1, `${policy.authority}.${field}`);
      }
    }
  });

  test('a sync writes only through the connector the policy names', () => {
    assert.equal(writeDecision(external, { kind: 'external', connectorKey: 'housecall_pro' }, 'update', ['phone']).code, 'arc_authority');
  });

  test('ARC\'s intake may record an arrival on any route, and may not then edit a field it does not own', () => {
    assert.equal(writeDecision(external, system, 'create', ['display_name', 'phone']).ok, true);
    assert.equal(writeDecision(external, system, 'update', ['phone']).code, 'external_authority');
    assert.equal(writeDecision(external, operator, 'create', ['display_name']).code, 'external_authority');
    assert.equal(writeDecision(external, operator, 'create', []).code, 'external_authority');
    assert.equal(writeDecision(external, operator, 'update', ['owner_user_id']).ok, true);
  });
});

describe('what an input must be', () => {
  test('a contact: one spelling of phone and email, something to be found by, and every problem at once', () => {
    const good = parseContactInput({ first_name: ' Dana ', last_name: 'Reyes', phone: '(614) 555-0137', email: 'Dana@Example.com', country: 'us' });
    assert.equal(good.ok, true);
    assert.deepEqual(good.value, { first_name: 'Dana', last_name: 'Reyes', phone: '+16145550137', email: 'dana@example.com', country: 'US', display_name: 'Dana Reyes' });
    assert.equal(parseContactInput({ phone: '6145550137' }).value.display_name, '+16145550137');
    assert.deepEqual(fields(parseContactInput({})), ['display_name']);
    assert.deepEqual(fields(parseContactInput({ phone: '555', email: 'x', preferred_channel: 'fax', consent_sms: true, owner_user_id: 'me' })),
      ['consent_sms', 'display_name', 'email', 'owner_user_id', 'phone', 'preferred_channel']);
    /* an edit names only what changes, can clear a field, and cannot clear the name. */
    assert.deepEqual(parseContactInput({ phone: '' }, { partial: true }).value, { phone: null });
    assert.deepEqual(fields(parseContactInput({ display_name: '' }, { partial: true })), ['display_name']);
  });

  test('a lead: a value needs its source, the stage is named one way, and its origin does not change', () => {
    const base = { contact_id: T, source: 'web_form', title: 'No heat upstairs' };
    assert.equal(parseLeadInput(base).ok, true);
    assert.deepEqual(fields(parseLeadInput({})), ['contact_id', 'source', 'title']);
    assert.deepEqual(fields(parseLeadInput({ ...base, estimated_value_cents: 5000 })), ['estimated_value_source']);
    assert.deepEqual(fields(parseLeadInput({ ...base, estimated_value_cents: 49.5, estimated_value_source: 'customer_provided' })), ['estimated_value_cents']);
    assert.deepEqual(fields(parseLeadInput({ ...base, estimated_value_cents: 5000, estimated_value_source: 'our_guess' })), ['estimated_value_source']);
    assert.deepEqual(fields(parseLeadInput({ ...base, stage_id: T, stage_key: 'new' })), ['stage_key']);
    assert.deepEqual(fields(parseLeadInput({ ...base, status: 'won' })), ['status'], 'a status is the stage\'s, never typed');
    assert.deepEqual(fields(parseLeadInput({ contact_id: T, source: 'manual' }, { partial: true })), ['contact_id', 'source']);
    assert.deepEqual(parseLeadInput({ estimated_value_cents: null, estimated_value_source: null }, { partial: true }).value,
      { estimated_value_cents: null, estimated_value_source: null });
  });

  test('notes and tasks belong to a contact or a lead', () => {
    assert.deepEqual(fields(parseNoteInput({ body: 'hello' })), ['contact_id']);
    assert.deepEqual(fields(parseNoteInput({ contact_id: T })), ['body']);
    assert.deepEqual(fields(parseTaskInput({ title: 'Call' })), ['contact_id']);
    assert.deepEqual(fields(parseTaskInput({ lead_id: T, title: 'Call', due_at: 'tomorrow-ish', status: 'maybe' })), ['due_at', 'status']);
    assert.equal(parseTaskInput({ status: 'done' }, { partial: true }).ok, true);
  });

  test('business hours: real days, real times, open before close, no overlap', () => {
    assert.deepEqual(parseBusinessHours({ tue: [{ open: '13:00', close: '17:00' }, { open: '08:00', close: '12:00' }], wed: [] }).value,
      { tue: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }] });
    for (const bad of [
      { tue: [{ open: '8', close: '17:00' }] },
      { tue: [{ open: '17:00', close: '08:00' }] },
      { tue: [{ open: '08:00', close: '12:00' }, { open: '11:59', close: '13:00' }] },
      { tuesday: [] },
      { tue: [{ open: '08:00', close: '17:00', note: 'x' }] },
      [],
    ]) {
      assert.equal(parseBusinessHours(bad).ok, false, JSON.stringify(bad));
    }
  });

  test('a pipeline arrives whole: an open stage, and no two stages with one key', () => {
    assert.equal(parsePipelineInput({ key: 'sales', name: 'Sales', stages: [{ key: 'new', name: 'New' }, { key: 'won', name: 'Won', kind: 'won' }] }).ok, true);
    assert.deepEqual(fields(parsePipelineInput({ key: 'sales', name: 'Sales', stages: [{ key: 'won', name: 'Won', kind: 'won' }] })), ['stages']);
    assert.deepEqual(fields(parsePipelineInput({ key: 'sales', name: 'Sales', stages: [{ key: 'new', name: 'A' }, { key: 'new', name: 'B' }] })), ['stages[1].key']);
    assert.deepEqual(fields(parsePipelineInput({ key: 'Sales!', name: '', stages: [] })), ['key', 'name', 'stages']);
  });

  test('a policy: a connector ARC has, a split only when hybrid, only fields that can be handed over, never against ARC Native', () => {
    const known = (key) => key === 'jobber';
    const parse = (raw, route = null) => parsePolicyInput(raw, { route, connectorKnown: known });
    assert.deepEqual(parse({ object_type: 'contact', authority: 'arc' }).value,
      { object_type: 'contact', authority: 'arc', connector_key: null, field_owners: {}, note: null });
    assert.equal(parse({ object_type: 'lead', authority: 'external', connector_key: 'jobber' }).ok, true);
    assert.equal(parse({ object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'external', email: 'arc' } }).ok, true);
    assert.deepEqual(fields(parse({ object_type: 'contact', authority: 'external', connector_key: 'made_up' })), ['connector_key']);
    assert.deepEqual(fields(parse({ object_type: 'contact', authority: 'external', connector_key: 'jobber', field_owners: { phone: 'external' } })), ['field_owners']);
    assert.deepEqual(fields(parse({ object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { archived_at: 'external' } })), ['field_owners', 'field_owners.archived_at']);
    for (const route of ROUTE_KEYS) {
      const outcome = parse({ object_type: 'contact', authority: 'external', connector_key: 'jobber' }, route);
      assert.equal(outcome.ok, route !== 'native', route);
    }
  });

  test('a source record: a known source, a bounded detail object', () => {
    assert.equal(parseSourceEventInput({ source: 'web_form', detail: { form: 'contact' }, idempotency_key: 'abcdefgh' }).ok, true);
    assert.deepEqual(fields(parseSourceEventInput({ source: 'smoke_signal', detail: [], idempotency_key: 'short' })), ['detail', 'idempotency_key', 'source']);
    assert.deepEqual(fields(parseSourceEventInput({ source: 'import', detail: { blob: 'x'.repeat(5000) } })), ['detail']);
  });
});

describe('what is never stored', () => {
  /* built from parts: a credential-shaped literal in a public repository trips push protection. */
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBhcnQ'].join('.');
  const samples = [jwt, `Bearer ${'a1b2c3d4'}${'e5f6g7h8'}`, `${'pass'}word=${'hunter2hunter2'}`, `${'sk'}_${'live'}_${'abcdefgh12345678'}`];

  test('a credential-shaped value is refused in every text field, wherever it hides', () => {
    for (const value of samples) {
      assert.ok(secretProblem(value), value.slice(0, 12));
      assert.equal(parseContactInput({ display_name: `Pat ${value}` }).ok, false);
      assert.equal(parseNoteInput({ contact_id: T, body: `login: ${value}` }).ok, false);
      assert.equal(parseLeadInput({ contact_id: T, source: 'manual', title: 'x', summary: value }).ok, false);
      assert.equal(parseSourceEventInput({ source: 'webhook', detail: { nested: { deep: value } } }).ok, false);
    }
    assert.equal(parseSourceEventInput({ source: 'webhook', detail: { [`${'api'}_key`]: 'abcdefgh12345678' } }).ok, false);
  });

  test('ordinary sentences that mention a password or a token are not credentials', () => {
    for (const fine of ['Forgot the password to the thermostat app.', 'Customer left a token of thanks.', 'Secret menu: none.']) {
      assert.equal(secretProblem(fine), null, fine);
    }
  });

  test('the model\'s credential shapes are the migration\'s', () => {
    const sql = readFileSync(new URL('../supabase/migrations/0023_crm_core.sql', import.meta.url), 'utf8');
    const model = readFileSync(new URL('../supabase/functions/_shared/crm/model.ts', import.meta.url), 'utf8');
    const names = '(auth_?token|access_?token|refresh_?token|api[_-]?key|client_?secret|secret|password|private_?key)"?\\s*[:=]\\s*"?[^\\s"]{8,}';
    assert.ok(sql.includes(names), 'crm_text_is_clean names the same fields');
    assert.ok(model.includes(names), 'NAMED_SECRET names the same fields');
  });

  test('a contact carries no consent: safety is read from the suppression list, and an expired row no longer suppresses', () => {
    const contact = { phone: '+16145550137', email: 'dana@example.com' };
    const now = new Date('2026-10-02T12:00:00Z');
    const rows = [
      { channel: 'sms', address: '+16145550137', reason: 'opt_out', created_at: '2026-09-01T00:00:00Z', expires_at: null },
      { channel: 'email', address: 'dana@example.com', reason: 'bounced', created_at: '2026-09-01T00:00:00Z', expires_at: '2026-09-15T00:00:00Z' },
      { channel: 'sms', address: '+16145550999', reason: 'opt_out', created_at: '2026-09-01T00:00:00Z', expires_at: null },
    ];
    assert.deepEqual(contactSafety(contact, rows, now).map((s) => [s.channel, s.suppressed, s.reason]),
      [['sms', true, 'opt_out'], ['email', false, null]]);
    assert.deepEqual(contactSafety({ phone: null, email: null }, rows, now), []);
  });
});
