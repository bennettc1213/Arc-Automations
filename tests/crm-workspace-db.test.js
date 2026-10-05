/* ARC-360 — the CRM workspace, against real Postgres.
 *
 * Two parts, as for 0023 and 0024:
 *
 *   1. The text of 0025, always: the revisions table has RLS and a read policy and no write
 *      policy, nothing is granted to a browser role, and its vocabulary is the model's.
 *   2. The migration APPLIED, when PGlite is available: the real workspace service and the
 *      real action table (the one both `ops` and the client's `crm` function run) over the
 *      real store — so what a client user sends is what 0023/0025 receive.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { supabaseTenantStore } from '../supabase/functions/_shared/tenants/supabase-tenant-store.ts';
import { supabaseCrmStore } from '../supabase/functions/_shared/crm/supabase-crm-store.ts';
import { supabaseIntakeStore } from '../supabase/functions/_shared/intake/supabase-intake-store.ts';
import * as crm from '../supabase/functions/_shared/crm/service.ts';
import * as intake from '../supabase/functions/_shared/intake/service.ts';
import * as workspace from '../supabase/functions/_shared/crm/workspace.ts';
import { STAGE_WAITS } from '../supabase/functions/_shared/crm/model.ts';
import { inboxStates, inQueue, lockedFields, queueCounts } from '../supabase/functions/_shared/crm/inbox.ts';
import { clientActor, handleWorkspaceAction, WORKSPACE_ACTIONS } from '../supabase/functions/_shared/crm/actions.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { CRM_ACTIONS } from '../supabase/functions/ops/crm.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0025_crm_workspace.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0025 as written', () => {
  test('the revisions table has RLS and a read policy for members and operators, and no write policy', () => {
    assert.match(CODE, /alter table public\.crm_pipeline_revisions enable row level security/);
    assert.match(CODE, /for select to authenticated using \(public\.is_tenant_member\(tenant_id\) or public\.is_arc_admin\(\)\)/);
    assert.doesNotMatch(CODE, /create policy [^;]*for (insert|update|delete|all)\b/i);
    assert.match(CODE, /revoke insert, update, delete, truncate on public\.crm_pipeline_revisions from anon, authenticated/);
  });

  test('no function here is executable by a browser role, and none is security definer', () => {
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
    for (const fn of new Set([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]))) {
      assert.match(CODE, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), `${fn} is revoked`);
    }
    assert.doesNotMatch(CODE, /security definer/i);
  });

  test('what a stage waits on is the model\'s vocabulary', () => {
    const list = /waits_on text not null default 'us'\s+check \(waits_on in \(([^)]*)\)\)/.exec(CODE);
    assert.ok(list, 'waits_on has a check list');
    assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...STAGE_WAITS]);
  });

  test('forward-only: it adds a column and re-creates functions and its own triggers; it drops no table', () => {
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), drops.join(', '));
    assert.doesNotMatch(CODE, /\btruncate table\b|\balter table public\.(tenants|leads|events|suppressions|crm_leads|crm_contacts)\b/i);
  });

  test('the client door and the console door are one table, and every workspace action that shares a CRM action\'s name means the same call', () => {
    for (const name of ['crm-workspace', 'crm-lead-view', 'crm-lead-update', 'crm-lead-bulk', 'crm-task-update', 'crm-stages-save', 'crm-lead-quick-add']) {
      assert.ok(WORKSPACE_ACTIONS.includes(name), name);
    }
    const shared = WORKSPACE_ACTIONS.filter((n) => CRM_ACTIONS.includes(n));
    assert.deepEqual(shared.sort(), ['crm-contact-update', 'crm-lead-archive', 'crm-lead-restore', 'crm-lead-update', 'crm-note-add', 'crm-note-archive', 'crm-task-create', 'crm-task-update']);
    const fn = readFileSync(new URL('../supabase/functions/crm/index.ts', import.meta.url), 'utf8');
    assert.match(fn, /from\('tenant_members'\)/, 'the client function reads the role itself');
    assert.doesNotMatch(fn, /body\.role|body\.actor|body\.user_id/, 'and never takes it from the body');
  });

  test('a client actor is built only from a membership row', () => {
    assert.equal(clientActor('u', 't', null), null);
    assert.equal(clientActor(null, 't', { role: 'owner' }), null);
    assert.deepEqual(clientActor('u', 't', { role: 'owner' }), { kind: 'client_user', userId: 'u', tenantId: 't', role: 'owner' });
    assert.equal(clientActor('u', 't', { role: 'admin' }).role, 'staff', 'an unknown role is the lesser one');
  });
});

/* ══ 2. the database ══════════════════════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const uuid = (prefix) => {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

describe('the CRM workspace on real SQL', { skip }, () => {
  let db;
  let deps;
  let operator;
  let op;
  let acme;
  let other;
  let clock;

  async function newUser() {
    const id = uuid('eeeeeeee');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  }
  async function newTenant(slug) {
    const client = restClient(db);
    const res = await handleTenantAction('tenant-create', {
      store: supabaseStore(client),
      tenants: supabaseTenantStore(client),
      body: { tenant: { name: `Co ${slug}`, slug, timezone: 'America/Denver', status: 'onboarding' }, modules: [], idempotency_key: `ws-test-${slug}` },
      actorId: operator,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.tenant.id;
    const owner = await newUser();
    const staff = await newUser();
    await db.query(`insert into tenant_members (user_id, tenant_id, role) values ($1, $3, 'owner'), ($2, $3, 'staff')`, [owner, staff, id]);
    return {
      id, owner, staff,
      ownerActor: { kind: 'client_user', userId: owner, tenantId: id, role: 'owner' },
      staffActor: { kind: 'client_user', userId: staff, tenantId: id, role: 'staff' },
    };
  }
  const ok = (outcome) => {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome.result;
  };
  const count = async (table, where = 'true', params = []) =>
    Number((await db.query(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0].n);
  /** a lead typed in through ARC-350's door, as the workspace's quick-add does. */
  async function typedLead(tenant, actor, name, phone, extra = {}) {
    const arrival = ok(await intake.createManualLead(deps, actor, tenant.id, { contact: { display_name: name, phone }, lead: { title: `${name}'s job`, ...extra } }));
    assert.equal(arrival.outcome, 'created');
    return arrival;
  }
  /** what a client user's request through the `crm` function does, minus HTTP. */
  const asClient = (actor, action, body) => handleWorkspaceAction(action, { deps, actor, body: { tenant_id: actor.tenantId, ...body } });

  before(async () => {
    db = await freshDatabase();
    operator = await newUser();
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    op = { kind: 'operator', userId: operator };
    clock = new Date('2026-10-02T15:00:00Z');
    const client = restClient(db);
    deps = { crm: supabaseCrmStore(client), intake: supabaseIntakeStore(client), now: () => clock };
    acme = await newTenant('ws-acme');
    other = await newTenant('ws-other');
  });

  test('the default pipeline\'s "estimate sent" stage waits on the customer; every other stage on us', async () => {
    await typedLead(acme, acme.staffActor, 'First Lead', '+16145550301');
    const ws = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    const stages = ws.pipelines.find((p) => p.is_default).stages;
    assert.deepEqual(stages.map((s) => [s.key, s.waits_on]), [
      ['new', 'us'], ['contacted', 'us'], ['qualified', 'us'], ['estimate_sent', 'customer'], ['won', 'us'], ['lost', 'us'],
    ]);
  });

  test('the inbox holds this client\'s leads only, and another client\'s user is refused before anything is read', async () => {
    await typedLead(other, other.ownerActor, 'Other Customer', '+16145550302');
    const ws = ok(await workspace.getWorkspace(deps, acme.ownerActor, acme.id));
    assert.ok(ws.leads.length > 0);
    assert.ok(ws.leads.every((l) => l.tenant_id === acme.id));
    assert.ok(ws.contacts.every((c) => c.tenant_id === acme.id));
    assert.ok(!JSON.stringify(ws).includes('Other Customer'));
    for (const action of ['crm-workspace', 'crm-lead-view', 'crm-lead-bulk']) {
      const res = await handleWorkspaceAction(action, { deps, actor: other.ownerActor, body: { tenant_id: acme.id, lead_id: ws.leads[0].id, lead_ids: [ws.leads[0].id], change: { priority: 'high' } } });
      assert.equal(res.status, 403, action);
    }
    /* the other client naming acme's lead inside its own tenant: it does not exist there. */
    const view = await asClient(other.ownerActor, 'crm-lead-view', { lead_id: ws.leads[0].id });
    assert.equal(view.status, 404);
    assert.equal((await handleWorkspaceAction('crm-workspace', { deps, actor: null, body: { tenant_id: acme.id } })).status, 401);
  });

  test('the workspace says who is looking and what they may do; a client sees their team and ARC only as "ARC"', async () => {
    const staff = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    assert.deepEqual(staff.viewer, { kind: 'client_user', user_id: acme.staff, role: 'staff', may: { record: true, sensitive: false, business: false } });
    const owner = ok(await workspace.getWorkspace(deps, acme.ownerActor, acme.id));
    assert.deepEqual(owner.viewer.may, { record: true, sensitive: true, business: true });
    assert.deepEqual(owner.people.filter((p) => p.role !== 'arc').map((p) => p.user_id).sort(), [acme.owner, acme.staff].sort());
    assert.ok(!owner.people.some((p) => p.user_id === other.owner), 'nobody from another client');

    /* an operator owns a lead: the client sees "ARC team", never the operator's address. */
    const [lead] = owner.leads;
    ok(await crm.updateLead(deps.crm, op, acme.id, lead.id, { owner_user_id: operator }));
    const after = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    const arc = after.people.find((p) => p.user_id === operator);
    assert.equal(arc.label, 'ARC team');
    assert.equal(arc.assignable, false);
    assert.ok(!JSON.stringify(after.people).includes(`${operator}@example.test`));
    const asOperator = ok(await workspace.getWorkspace(deps, op, acme.id));
    assert.equal(asOperator.viewer.kind, 'operator');
    assert.ok(asOperator.people.find((p) => p.user_id === operator).assignable);
  });

  test('moving a lead through the client door persists, names the client user in the timeline, and closes nothing it should not', async () => {
    const { lead_id } = await typedLead(acme, acme.staffActor, 'Mover Person', '+16145550303');
    const moved = await asClient(acme.staffActor, 'crm-lead-update', { lead_id, lead: { stage_key: 'contacted' } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.lead.status, 'open');
    const view = ok(await workspace.getLeadView(deps, acme.staffActor, acme.id, lead_id));
    const change = view.timeline.find((t) => t.activity_type === 'lead_stage_changed');
    assert.deepEqual([change.actor_type, change.actor_id, change.detail.from, change.detail.to], ['client_user', acme.staff, 'new', 'contacted']);

    const won = await asClient(acme.staffActor, 'crm-lead-update', { lead_id, lead: { stage_key: 'won' } });
    assert.equal(won.body.lead.status, 'won');
    /* a won stage is a CRM state somebody set — it writes no evidence. */
    assert.equal(await count('events', 'tenant_id = $1', [acme.id]), 0);
    const lost = await asClient(acme.staffActor, 'crm-lead-update', { lead_id, lead: { stage_key: 'lost' } });
    assert.equal(lost.status, 422);
    assert.match(lost.body.error, /needs a reason/);
  });

  test('owner assignment: the account owner or an operator hands a lead over; staff cannot, and nobody outside the client can be named', async () => {
    const { lead_id } = await typedLead(acme, acme.staffActor, 'Owner Test', '+16145550304');
    const byStaff = await asClient(acme.staffActor, 'crm-lead-update', { lead_id, lead: { owner_user_id: acme.staff } });
    assert.equal(byStaff.status, 403);
    const byOwner = await asClient(acme.ownerActor, 'crm-lead-update', { lead_id, lead: { owner_user_id: acme.staff } });
    assert.equal(byOwner.status, 200);
    assert.equal(byOwner.body.lead.owner_user_id, acme.staff);
    const stranger = await asClient(acme.ownerActor, 'crm-lead-update', { lead_id, lead: { owner_user_id: other.owner } });
    assert.equal(stranger.status, 422);
    assert.equal(stranger.body.code, 'invalid_owner');
    assert.equal(await count('crm_activities', `lead_id = $1 and activity_type = 'lead_owner_changed' and actor_id = $2`, [lead_id, acme.owner]), 1);
  });

  test('a bulk change is each lead\'s own update: permission and stage rules per lead, refusals named per lead', async () => {
    const a = await typedLead(acme, acme.staffActor, 'Bulk A', '+16145550305');
    const b = await typedLead(acme, acme.staffActor, 'Bulk B', '+16145550306');
    const theirs = await typedLead(other, other.ownerActor, 'Bulk Theirs', '+16145550307');

    const moved = await asClient(acme.staffActor, 'crm-lead-bulk', { lead_ids: [a.lead_id, b.lead_id, theirs.lead_id], change: { stage_key: 'qualified' } });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.bulk.updated.sort(), [a.lead_id, b.lead_id].sort());
    assert.deepEqual(moved.body.bulk.refused.map((r) => [r.lead_id, r.code]), [[theirs.lead_id, 'not_found']]);
    assert.equal(await count('crm_activities', `lead_id = any($1::uuid[]) and activity_type = 'lead_stage_changed'`, [[a.lead_id, b.lead_id]]), 2, 'one timeline entry per lead');
    assert.equal((await db.query('select stage_id from crm_leads where id = $1', [theirs.lead_id])).rows[0].stage_id !== null, true);

    const owners = await asClient(acme.staffActor, 'crm-lead-bulk', { lead_ids: [a.lead_id, b.lead_id], change: { owner_user_id: acme.staff } });
    assert.equal(owners.body.bulk.updated.length, 0);
    assert.ok(owners.body.bulk.refused.every((r) => r.code === 'forbidden'));

    const lost = await asClient(acme.ownerActor, 'crm-lead-bulk', { lead_ids: [a.lead_id], change: { stage_key: 'lost' } });
    assert.equal(lost.body.bulk.refused[0].code, 'invalid', 'lost still needs a reason');
    for (const bad of [{ lead_ids: [], change: { priority: 'high' } }, { lead_ids: [a.lead_id], change: { title: 'x' } }, { lead_ids: ['nope'], change: { priority: 'high' } }]) {
      assert.equal((await asClient(acme.ownerActor, 'crm-lead-bulk', bad)).status, 422, JSON.stringify(bad));
    }
  });

  test('tasks: created, overdue by the clock, completed with who and when, reopened — and the inbox reads all of it', async () => {
    const { lead_id } = await typedLead(acme, acme.staffActor, 'Task Person', '+16145550308');
    let ws = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    let state = inboxStates(ws, clock).find((s) => s.lead.id === lead_id);
    assert.equal(state.untouched, true);
    assert.equal(state.attention, true);
    assert.equal(state.next_task, null);

    const created = await asClient(acme.staffActor, 'crm-task-create', { task: { lead_id, title: 'Call back', kind: 'call', due_at: '2026-10-02T14:00:00Z' } });
    assert.equal(created.status, 201);
    ws = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    state = inboxStates(ws, clock).find((s) => s.lead.id === lead_id);
    assert.equal(state.next_task.id, created.body.task.id);
    assert.equal(state.overdue, true);
    assert.ok(inQueue(state, 'overdue', acme.staff));

    const done = await asClient(acme.staffActor, 'crm-task-update', { task_id: created.body.task.id, task: { status: 'done' } });
    assert.equal(done.body.task.completed_by, acme.staff);
    assert.ok(done.body.task.completed_at);
    ws = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    state = inboxStates(ws, clock).find((s) => s.lead.id === lead_id);
    assert.equal(state.overdue, false);
    assert.ok(ws.tasks.some((t) => t.id === created.body.task.id && t.status === 'done'), 'a finished task is still listed');
    const reopened = await asClient(acme.staffActor, 'crm-task-update', { task_id: created.body.task.id, task: { status: 'open' } });
    assert.equal(reopened.body.task.completed_at, null);
    const types = ok(await workspace.getLeadView(deps, acme.staffActor, acme.id, lead_id)).timeline.map((t) => t.activity_type);
    for (const type of ['task_created', 'task_completed', 'task_reopened']) assert.ok(types.includes(type), type);
  });

  test('notes are written and archived through the workspace, and the timeline shows both with who did it', async () => {
    const { lead_id } = await typedLead(acme, acme.staffActor, 'Note Person', '+16145550309');
    const note = await asClient(acme.staffActor, 'crm-note-add', { note: { lead_id, body: 'Prefers mornings.' } });
    assert.equal(note.status, 201);
    assert.equal((await asClient(acme.staffActor, 'crm-note-archive', { note_id: note.body.note.id })).status, 403, 'archiving is the owner\'s');
    assert.equal((await asClient(acme.ownerActor, 'crm-note-archive', { note_id: note.body.note.id })).status, 200);
    const view = ok(await workspace.getLeadView(deps, acme.ownerActor, acme.id, lead_id));
    assert.equal(view.notes.length, 0, 'an archived note leaves the list');
    const added = view.timeline.find((t) => t.activity_type === 'note_added');
    const archived = view.timeline.find((t) => t.activity_type === 'note_archived');
    assert.equal(added.actor_id, acme.staff);
    assert.equal(archived.actor_id, acme.owner);
    assert.ok(view.people.some((p) => p.user_id === acme.staff));
  });

  test('quick-add goes through ARC-350\'s intake: a source record, the same duplicate rule, and the same validation', async () => {
    const before = await count('crm_source_events', 'tenant_id = $1', [acme.id]);
    const first = await asClient(acme.staffActor, 'crm-lead-quick-add', { lead: { contact: { display_name: 'Quick Add', phone: '(614) 555-0310' }, lead: { title: 'Leaking pipe' } } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.arrival.outcome, 'created');
    assert.equal(await count('crm_source_events', 'tenant_id = $1', [acme.id]), before + 1);
    const again = await asClient(acme.staffActor, 'crm-lead-quick-add', { lead: { contact: { display_name: 'Quick Add', phone: '614-555-0310' }, lead: { title: 'Leaking pipe' } } });
    assert.equal(again.body.arrival.outcome, 'duplicate');
    assert.equal(again.body.arrival.lead_id, first.body.arrival.lead_id);
    const bad = await asClient(acme.staffActor, 'crm-lead-quick-add', { lead: { contact: { phone: 'not a phone' }, lead: { title: '' } } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.field_errors.length >= 1);

    const view = ok(await workspace.getLeadView(deps, acme.staffActor, acme.id, first.body.arrival.lead_id));
    assert.equal(view.source.door.kind, 'manual');
    assert.equal(view.source.event.source, 'manual');
  });

  test('a lead from an API endpoint names the endpoint and shows the consent evidence — and never a token or its hash', async () => {
    const made = ok(await intake.createEndpoint(deps, op, acme.id, { name: 'Website builder' }));
    const hash = (await db.query('select token_hash from crm_intake_endpoints where id = $1', [made.endpoint.id])).rows[0].token_hash;
    const arrival = ok(await intake.receiveWebhook(deps, made.token, {
      event_id: 'ws-evt-000001',
      contact: { name: 'Api Customer', phone: '614 555 0311' },
      lead: { summary: 'Quote request' },
      consent: { sms: { granted: true, disclosure: 'Text me about my quote.' } },
    }));
    assert.equal(arrival.outcome, 'created');
    const ws = ok(await workspace.getWorkspace(deps, acme.ownerActor, acme.id));
    const lead = ws.leads.find((l) => ws.contacts.find((c) => c.id === l.contact_id)?.display_name === 'Api Customer');
    assert.ok(lead, 'the webhook lead is in the inbox');
    const view = ok(await workspace.getLeadView(deps, acme.ownerActor, acme.id, lead.id));
    assert.deepEqual(view.source.door, { kind: 'api', name: 'Website builder' });
    assert.equal(view.source.consent[0].granted, true);
    assert.equal(view.source.consent[0].disclosure, 'Text me about my quote.');
    const text = JSON.stringify(view) + JSON.stringify(ws);
    assert.ok(!text.includes(made.token), 'no token');
    assert.ok(!text.includes(hash), 'no token hash');
    assert.doesNotMatch(text, /token_hash/);
  });

  test('blocked: an opted-out address and a lead Lead Recovery handed to a person are in the blocked queue, with why', async () => {
    const { lead_id, contact_id } = await typedLead(acme, acme.staffActor, 'Opted Out', '+16145550312');
    await db.query(`insert into suppressions (tenant_id, channel, address, reason, source) values ($1, 'sms', '+16145550312', 'opt_out', 'customer')`, [acme.id]);
    const ws = ok(await workspace.getWorkspace(deps, acme.staffActor, acme.id));
    assert.deepEqual(ws.blocks[contact_id].map((b) => [b.channel, b.reason]), [['sms', 'opt_out']]);
    const state = inboxStates(ws, clock).find((s) => s.lead.id === lead_id);
    assert.deepEqual(state.blocked.map((b) => b.reason), ['do_not_contact']);
    assert.ok(inQueue(state, 'blocked', null));
    assert.ok(state.attention);
    const view = ok(await workspace.getLeadView(deps, acme.staffActor, acme.id, lead_id));
    assert.deepEqual(view.safety.map((s) => [s.channel, s.suppressed]), [['sms', true]]);
    /* nothing about it was copied onto the contact. */
    const contact = (await db.query('select * from crm_contacts where id = $1', [contact_id])).rows[0];
    assert.equal(Object.keys(contact).some((k) => /consent|suppress|opt/.test(k)), false);
  });

  test('an external authority: the workspace says which fields are kept in their system, and the server refuses them', async () => {
    const t = await newTenant('ws-hybrid');
    const { lead_id } = await typedLead(t, t.ownerActor, 'Hybrid Lead', '+16145550313');
    ok(await crm.setSourcePolicy(deps.crm, op, t.id, { object_type: 'lead', authority: 'hybrid', connector_key: 'jobber', field_owners: { title: 'external', estimated_value_cents: 'external' } }));
    const ws = ok(await workspace.getWorkspace(deps, t.ownerActor, t.id));
    assert.deepEqual(lockedFields(ws.policies.lead).sort(), ['estimated_value_cents', 'title']);
    assert.deepEqual(lockedFields(ws.policies.contact), []);
    const refusedTitle = await asClient(t.ownerActor, 'crm-lead-update', { lead_id, lead: { title: 'Renamed here' } });
    assert.equal(refusedTitle.status, 409);
    assert.equal(refusedTitle.body.code, 'external_authority');
    assert.match(refusedTitle.body.error, /title is kept in jobber/);
    assert.equal((await asClient(t.ownerActor, 'crm-lead-update', { lead_id, lead: { stage_key: 'contacted' } })).status, 200, 'the stage is still ARC\'s here');
  });

  test('stages: the owner renames, reorders, adds and retires them; key and kind never change; a stage with open leads is not retired', async () => {
    const t = await newTenant('ws-stages');
    const { lead_id } = await typedLead(t, t.staffActor, 'Stage Lead', '+16145550314');
    const ws = ok(await workspace.getWorkspace(deps, t.ownerActor, t.id));
    const pipeline = ws.pipelines.find((p) => p.is_default);
    const list = pipeline.stages.map((s) => ({ id: s.id, name: s.name, waits_on: s.waits_on, marks_qualified: s.marks_qualified }));

    assert.equal((await asClient(t.staffActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: list })).status, 403, 'staff cannot');

    /* rename "contacted", put "qualified" before it, add a waiting stage, retire "estimate_sent" (empty). */
    const [neu, contacted, qualified, estimate, won, lost] = list;
    const next = [
      neu,
      { ...qualified },
      { ...contacted, name: 'Spoke to them' },
      { key: 'awaiting_deposit', name: 'Awaiting deposit', waits_on: 'customer' },
      { ...estimate, retired: true },
      won,
      lost,
    ];
    const saved = await asClient(t.ownerActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: next });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = saved.body.saved.stages;
    assert.deepEqual(after.map((s) => s.key), ['new', 'qualified', 'contacted', 'awaiting_deposit', 'estimate_sent', 'won', 'lost']);
    assert.equal(after.find((s) => s.key === 'contacted').name, 'Spoke to them');
    assert.equal(after.find((s) => s.key === 'awaiting_deposit').waits_on, 'customer');
    assert.ok(after.find((s) => s.key === 'estimate_sent').archived_at);
    assert.equal(await count('crm_pipeline_revisions', 'tenant_id = $1 and actor_id = $2', [t.id, t.owner]), 1);

    /* a lead moved into the new waiting stage is waiting on the customer, not needing us. */
    ok(await crm.updateLead(deps.crm, t.staffActor, t.id, lead_id, { stage_key: 'awaiting_deposit' }));
    const ws2 = ok(await workspace.getWorkspace(deps, t.staffActor, t.id));
    const state = inboxStates(ws2, clock).find((s) => s.lead.id === lead_id);
    assert.equal(state.waiting, true);
    assert.equal(state.attention, false);
    assert.equal(queueCounts(inboxStates(ws2, clock), t.staff).waiting, 1);

    /* that stage now has an open lead: it cannot be retired. */
    const withIds = after.map((s) => ({ id: s.id, name: s.name, waits_on: s.waits_on, marks_qualified: s.marks_qualified, retired: Boolean(s.archived_at) }));
    const retireBusy = withIds.map((s) => (s.name === 'Awaiting deposit' ? { ...s, retired: true } : s));
    const busy = await asClient(t.ownerActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: retireBusy });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /still has open leads/);

    /* a stage left out, a kind changed, a key changed: refused, by the parser or by 0025. */
    assert.equal((await asClient(t.ownerActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: withIds.slice(1) })).status, 422);
    assert.equal((await asClient(t.ownerActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: withIds.map((s, i) => (i === 0 ? { ...s, kind: 'won' } : s)) })).status, 422);
    const kindByHand = await refused(db, `update crm_pipeline_stages set kind = 'won' where pipeline_id = $1 and key = 'new'`, [pipeline.id]);
    assert.match(kindByHand, /arc_crm:immutable/);
    const keyByHand = await refused(db, `update crm_pipeline_stages set key = 'fresh' where pipeline_id = $1 and key = 'new'`, [pipeline.id]);
    assert.match(keyByHand, /arc_crm:immutable/);

    /* an operator's save is in the operator audit log too. */
    const byOperator = await handleWorkspaceAction('crm-stages-save', { deps, actor: op, body: { tenant_id: t.id, pipeline_id: pipeline.id, stages: withIds } });
    assert.equal(byOperator.status, 200, JSON.stringify(byOperator.body));
    assert.equal(await count('admin_actions', `action = 'crm.pipeline.stages_saved' and actor_user_id = $1`, [operator]), 1);
    /* another client's pipeline is not found from this one. */
    const theirs = await asClient(other.ownerActor, 'crm-stages-save', { pipeline_id: pipeline.id, stages: withIds });
    assert.equal(theirs.status, 404);
  });

  test('a browser role can read its own pipeline revisions and write none', async () => {
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      const rows = (await tx.query('select tenant_id from public.crm_pipeline_revisions')).rows;
      assert.ok(rows.every((r) => r.tenant_id === acme.id));
      await assert.rejects(tx.query(`select public.crm_save_stages($1, gen_random_uuid(), '[]'::jsonb, 'client_user', $2)`, [acme.id, acme.staff]), /permission denied/);
    });
  });

  test('a deboarded client\'s workspace is read, and nothing is set up for it', async () => {
    const t = await newTenant('ws-archived');
    await db.query(`update tenants set status = 'archived' where id = $1`, [t.id]);
    const ws = ok(await workspace.getWorkspace(deps, op, t.id));
    assert.deepEqual(ws.pipelines, []);
    assert.equal(await count('crm_pipelines', 'tenant_id = $1', [t.id]), 0);
  });
});
