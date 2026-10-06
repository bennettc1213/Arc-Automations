/* ARC-340 — the CRM core and business profile, against real Postgres.
 *
 * Two parts, as for 0021:
 *
 *   1. The text of 0023, always: every table has RLS and a read policy and no write policy,
 *      nothing is granted to a browser role, and its vocabularies are the model's.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the real
 *      service and the real `ops` handler over the real store, so what a caller sends is
 *      what 0023 receives.
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
import * as crm from '../supabase/functions/_shared/crm/service.ts';
import {
  ACTIVITY_TYPES, ACTOR_TYPES, AREA_KINDS, AUTHORITIES, LEAD_SOURCES, OBJECT_TYPES, PRIORITIES,
  STAGE_KINDS, TASK_KINDS, TASK_STATUSES, VALUE_SOURCES,
} from '../supabase/functions/_shared/crm/model.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { CRM_ACTIONS, handleCrmAction } from '../supabase/functions/ops/crm.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0023_crm_core.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');

/* ══ 1. the file ══════════════════════════════════════════ */

/** the values of `<column> ... in ( ... )` inside one table's definition. */
function checkList(table, column) {
  const body = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(CODE)?.[1] ?? '';
  const match = new RegExp(`\\n\\s+${column}\\s[^\\n]*?in \\(([^)]*)\\)`).exec(body);
  assert.ok(match, `${table}.${column} has a check list`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('0023 as written', () => {
  test('every table has RLS, a read policy for members and operators, and no write policy', () => {
    const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...tables].sort(), [...crm.CRM_TABLES].sort());
    const listed = /foreach t in array array\[([\s\S]*?)\] loop/.exec(CODE)[1];
    for (const table of tables) assert.match(listed, new RegExp(`'${table}'`), `${table} is in the RLS loop`);
    assert.match(CODE, /enable row level security/);
    assert.match(CODE, /for select to authenticated using \(public\.is_tenant_member\(tenant_id\) or public\.is_arc_admin\(\)\)/);
    assert.doesNotMatch(CODE, /create policy [^;]*for (insert|update|delete|all)\b/i);
    assert.equal([...CODE.matchAll(/create policy/g)].length, 1, 'the one policy statement is the read policy in the loop');
    assert.match(CODE, /revoke insert, update, delete, truncate on public\.%I from anon, authenticated/);
  });

  test('no function here is executable by a browser role', () => {
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
    const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    for (const fn of new Set(functions)) {
      assert.match(CODE, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), `${fn} is revoked`);
    }
    assert.doesNotMatch(CODE, /security definer/i);
  });

  test('the vocabularies are the model\'s', () => {
    assert.deepEqual(checkList('crm_leads', 'source'), [...LEAD_SOURCES]);
    assert.deepEqual(checkList('crm_source_events', 'source'), [...LEAD_SOURCES]);
    assert.deepEqual(checkList('crm_activities', 'activity_type'), [...ACTIVITY_TYPES]);
    assert.deepEqual(checkList('crm_activities', 'actor_type'), [...ACTOR_TYPES]);
    /* 0023's six kinds of record. ARC-380 (0027) widens both lists with `appointment`, and
       tests/booking-db.test.js holds 0027's own lists to the model's. */
    const core = OBJECT_TYPES.filter((type) => type !== 'appointment');
    assert.deepEqual(checkList('crm_external_mappings', 'object_type'), core);
    assert.deepEqual(checkList('crm_source_policies', 'object_type'), core);
    assert.deepEqual(checkList('crm_source_policies', 'authority'), [...AUTHORITIES]);
    assert.deepEqual(checkList('crm_pipeline_stages', 'kind'), [...STAGE_KINDS]);
    assert.deepEqual(checkList('crm_leads', 'priority'), [...PRIORITIES]);
    assert.deepEqual(checkList('crm_leads', 'estimated_value_source'), [...VALUE_SOURCES]);
    assert.deepEqual(checkList('crm_tasks', 'kind'), [...TASK_KINDS]);
    assert.deepEqual(checkList('crm_tasks', 'status'), [...TASK_STATUSES]);
    assert.deepEqual(checkList('business_service_areas', 'kind'), [...AREA_KINDS]);
  });

  test('a contact carries no consent or opt-out column, and no table holds a credential column', () => {
    const contacts = /create table if not exists public\.crm_contacts \(([\s\S]*?)\n\);/.exec(CODE)[1];
    assert.doesNotMatch(contacts, /consent|opt_?out|suppress|do_not_contact/i);
    const columns = [...CODE.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|jsonb|timestamptz|boolean|integer|bigint)\b/gm)].map((m) => m[1]);
    for (const column of columns) assert.doesNotMatch(column, /token|secret|password|credential|api_key/, column);
  });

  test('forward-only: nothing existing is dropped but triggers re-created by name and the read policies', () => {
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger'), drops.join(', '));
    assert.doesNotMatch(CODE, /\btruncate table\b|\balter table public\.(tenants|leads|events|suppressions)\b/i);
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

describe('the CRM core on real SQL', { skip }, () => {
  let db;
  let store;
  let operator;
  let acme;      // { id, owner, staff, ownerActor, staffActor }
  let other;
  let op;        // the operator actor
  const system = { kind: 'system' };

  async function newUser() {
    const id = uuid('cccccccc');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  }
  async function newTenant(slug) {
    const client = restClient(db);
    const res = await handleTenantAction('tenant-create', {
      store: supabaseStore(client),
      tenants: supabaseTenantStore(client),
      body: { tenant: { name: `Co ${slug}`, slug, timezone: 'America/Denver', status: 'onboarding' }, modules: [], idempotency_key: `crm-test-${slug}` },
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
  const contact = (tenant, fields, actor = op) => crm.createContact(store, actor, tenant.id, fields).then(ok);
  const lead = (tenant, fields, actor = op) => crm.createLead(store, actor, tenant.id, { source: 'manual', title: 'No heat', ...fields }).then(ok);

  before(async () => {
    db = await freshDatabase();
    operator = await newUser();
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    op = { kind: 'operator', userId: operator };
    store = supabaseCrmStore(restClient(db));
    acme = await newTenant('crm-acme');
    other = await newTenant('crm-other');
  });

  /* ── contacts and isolation ── */

  test('a contact is created, read and updated inside its tenant, with one spelling of its phone and email', async () => {
    const c = await contact(acme, { first_name: 'Dana', last_name: 'Reyes', phone: '(614) 555-0137', email: ' Dana@Example.COM ' }, acme.staffActor);
    assert.equal(c.display_name, 'Dana Reyes');
    assert.equal(c.phone, '+16145550137');
    assert.equal(c.email, 'dana@example.com');
    assert.equal(c.updated_by_type, 'client_user');
    assert.equal(c.updated_by, acme.staff);

    const read = ok(await crm.getContact(store, acme.ownerActor, acme.id, c.id));
    assert.equal(read.contact.id, c.id);
    const updated = ok(await crm.updateContact(store, acme.staffActor, acme.id, c.id, { city: 'Columbus', phone: '614.555.0199' }));
    assert.equal(updated.phone, '+16145550199');
    assert.equal(updated.city, 'Columbus');
  });

  test('another tenant\'s user cannot read, find, update, merge or attach to that contact — and neither can a mismatched tenant id', async () => {
    const c = await contact(acme, { display_name: 'Private Person', phone: '+16145550101' });
    /* an actor from the other tenant, asking about acme. */
    for (const call of [
      () => crm.getContact(store, other.ownerActor, acme.id, c.id),
      () => crm.listContacts(store, other.ownerActor, acme.id),
      () => crm.findContacts(store, other.ownerActor, acme.id, { phone: '+16145550101' }),
      () => crm.updateContact(store, other.ownerActor, acme.id, c.id, { city: 'X' }),
      () => crm.addNote(store, other.ownerActor, acme.id, { contact_id: c.id, body: 'hello' }),
    ]) {
      const outcome = await call();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'forbidden');
    }
    /* the same actor, in its own tenant, naming acme's contact id: it does not exist there. */
    assert.equal((await crm.getContact(store, other.ownerActor, other.id, c.id)).code, 'not_found');
    assert.equal((await crm.updateContact(store, other.ownerActor, other.id, c.id, { city: 'X' })).code, 'not_found');
    assert.deepEqual(ok(await crm.findContacts(store, other.ownerActor, other.id, { phone: '+16145550101' })), []);
    const cross = await crm.createLead(store, other.ownerActor, other.id, { contact_id: c.id, source: 'manual', title: 'Theirs' });
    assert.equal(cross.code, 'not_found');
    const note = await crm.addNote(store, other.ownerActor, other.id, { contact_id: c.id, body: 'not mine' });
    assert.equal(note.code, 'not_found');
    const mine = await contact(other, { display_name: 'Mine' });
    assert.equal((await crm.mergeContacts(store, other.ownerActor, other.id, { keepId: mine.id, mergeId: c.id })).code, 'not_found');
    assert.equal(await count('crm_notes', 'contact_id = $1', [c.id]), 0);
    assert.equal(await count('crm_leads', 'contact_id = $1', [c.id]), 0);
  });

  test('RLS: a signed-in member sees only their tenant\'s rows; an operator sees all; nobody writes from a browser', async () => {
    await contact(other, { display_name: 'Other Co Customer' });
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      const rows = (await tx.query('select tenant_id from public.crm_contacts')).rows;
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => r.tenant_id === acme.id));
      await assert.rejects(tx.query(`insert into public.crm_contacts (tenant_id, display_name, updated_by_type, updated_by) values ($1, 'x', 'client_user', $2)`, [acme.id, acme.staff]), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      await assert.rejects(tx.query(`update public.crm_contacts set city = 'x'`), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      await assert.rejects(tx.query(`select public.crm_merge_contacts($1, gen_random_uuid(), gen_random_uuid(), 'client_user', $2)`, [acme.id, acme.staff]), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      const tenants = new Set((await tx.query('select tenant_id from public.crm_contacts')).rows.map((r) => r.tenant_id));
      assert.ok(tenants.has(acme.id) && tenants.has(other.id));
    });
    await asRole(db, { role: 'anon' }, async (tx) => {
      await assert.rejects(tx.query('select 1 from public.crm_contacts'), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: await newUser() }, async (tx) => {
      for (const table of crm.CRM_TABLES) {
        assert.equal((await tx.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, table);
      }
    });
  });

  test('the database checks the actor itself: a write naming a user who is not this tenant\'s is refused', async () => {
    const message = await refused(db,
      `insert into public.crm_contacts (tenant_id, display_name, updated_by_type, updated_by) values ($1, 'Sneaky', 'client_user', $2)`,
      [acme.id, other.owner]);
    assert.match(message, /arc_crm:forbidden/);
    const notOperator = await refused(db,
      `insert into public.crm_contacts (tenant_id, display_name, updated_by_type, updated_by) values ($1, 'Sneaky', 'operator', $2)`,
      [acme.id, acme.owner]);
    assert.match(notOperator, /arc_crm:forbidden/);
  });

  /* ── lookup ── */

  test('lookup normalises what was typed; a merged contact is never a match; several matches are never guessed at', async () => {
    const a = await contact(acme, { display_name: 'Lookup A', phone: '614-555-0142', email: 'shared@example.com' });
    const found = ok(await crm.findContacts(store, op, acme.id, { phone: '1 (614) 555-0142' }));
    assert.deepEqual(found.map((c) => [c.id, c.matched_on]), [[a.id, ['phone']]]);
    assert.deepEqual(ok(await crm.findContacts(store, op, acme.id, { email: 'SHARED@example.com ' })).map((c) => c.id), [a.id]);
    assert.deepEqual(ok(await crm.findContacts(store, op, acme.id, { phone: 'not a number' })), []);

    /* one match is the contact; none is a new one; two is a question. */
    const same = ok(await crm.resolveContact(store, system, acme.id, { phone: '+16145550142' }));
    assert.equal(same.matched, true);
    assert.equal(same.contact.id, a.id);
    const fresh = ok(await crm.resolveContact(store, system, acme.id, { phone: '+16145550143' }));
    assert.equal(fresh.matched, false);
    assert.equal(fresh.contact.display_name, '+16145550143');
    assert.equal(fresh.contact.updated_by_type, 'system');

    const b = await contact(acme, { display_name: 'Lookup B', email: 'shared@example.com' });
    const ambiguous = await crm.resolveContact(store, system, acme.id, { email: 'shared@example.com' });
    assert.equal(ambiguous.code, 'ambiguous_contact');
    assert.deepEqual(ambiguous.candidates.map((c) => c.id).sort(), [a.id, b.id].sort());

    ok(await crm.mergeContacts(store, op, acme.id, { keepId: a.id, mergeId: b.id }));
    assert.deepEqual(ok(await crm.findContacts(store, op, acme.id, { email: 'shared@example.com' })).map((c) => c.id), [a.id]);
    assert.equal(ok(await crm.resolveContact(store, system, acme.id, { email: 'shared@example.com' })).contact.id, a.id);
  });

  test('the database refuses a phone or an email that is not in its one spelling', async () => {
    for (const [column, value] of [['phone', '(614) 555-0137'], ['email', 'Mixed@Case.com'], ['email', 'not-an-email']]) {
      const message = await refused(db,
        `insert into public.crm_contacts (tenant_id, display_name, ${column}, updated_by_type) values ($1, 'x', $2, 'system')`, [acme.id, value]);
      assert.match(message, /check constraint/);
    }
  });

  /* ── leads, pipelines, stages ── */

  test('a lead is linked to a contact, lands in the default pipeline\'s first open stage, and its status is the stage\'s', async () => {
    const c = await contact(acme, { display_name: 'Lead Holder' });
    const l = await lead(acme, { contact_id: c.id, priority: 'high' }, acme.staffActor);
    assert.equal(l.contact_id, c.id);
    assert.equal(l.status, 'open');
    assert.equal(l.closed_at, null);
    const business = ok(await crm.getBusinessOverview(store, op, acme.id));
    const pipeline = business.pipelines.find((p) => p.is_default);
    assert.equal(pipeline.id, l.pipeline_id);
    assert.deepEqual(pipeline.stages.map((s) => s.key), ['new', 'contacted', 'qualified', 'estimate_sent', 'won', 'lost']);
    assert.equal(pipeline.stages[0].id, l.stage_id);
    assert.equal(await count('crm_pipelines', 'tenant_id = $1', [acme.id]), 1);
    await lead(acme, { contact_id: c.id });
    assert.equal(await count('crm_pipelines', 'tenant_id = $1', [acme.id]), 1, 'the default pipeline is made once');

    const detail = ok(await crm.getLead(store, acme.ownerActor, acme.id, l.id));
    assert.equal(detail.contact.id, c.id);
    assert.equal(detail.stage.key, 'new');
    assert.equal(ok(await crm.getContact(store, op, acme.id, c.id)).leads.length, 2);
  });

  test('moving a lead: qualified stamps once, lost needs a reason, won closes, reopening clears the close', async () => {
    const c = await contact(acme, { display_name: 'Mover' });
    const l = await lead(acme, { contact_id: c.id });
    const qualified = ok(await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'qualified' }));
    assert.ok(qualified.qualified_at);
    const noReason = await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'lost' });
    assert.equal(noReason.code, 'invalid');
    assert.match(noReason.message, /needs a reason/);
    const lost = ok(await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'lost', closed_reason: 'Went with a competitor' }));
    assert.equal(lost.status, 'lost');
    assert.ok(lost.closed_at);
    const reopened = ok(await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'contacted' }));
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.closed_at, null);
    assert.equal(reopened.closed_reason, null);
    assert.equal(String(reopened.qualified_at), String(qualified.qualified_at), 'qualified once is qualified');
    const won = ok(await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'won' }));
    assert.equal(won.status, 'won');

    const types = ok(await crm.getLead(store, op, acme.id, l.id)).timeline.map((t) => t.activity_type);
    assert.equal(types.filter((t) => t === 'lead_stage_changed').length, 4);
    assert.ok(types.includes('lead_created'));
  });

  test('a stage from another pipeline or another tenant, a retired stage and a typed status are all refused or ignored', async () => {
    const c = await contact(acme, { display_name: 'Stage Tester' });
    const l = await lead(acme, { contact_id: c.id });
    const custom = ok(await crm.createPipeline(store, acme.ownerActor, acme.id, {
      key: 'service_plans', name: 'Service plans',
      stages: [{ key: 'interested', name: 'Interested' }, { key: 'signed', name: 'Signed', kind: 'won' }],
    }));
    assert.deepEqual(custom.stages.map((s) => [s.key, s.kind]), [['interested', 'open'], ['signed', 'won']]);

    /* through the service: a stage that is not in the lead's pipeline. */
    assert.equal((await crm.updateLead(store, op, acme.id, l.id, { stage_id: custom.stages[0].id })).code, 'invalid_stage');
    assert.equal((await crm.updateLead(store, op, acme.id, l.id, { stage_key: 'no_such_stage' })).code, 'invalid_stage');
    /* moving pipelines names the pipeline, and lands in its first open stage. */
    const moved = ok(await crm.updateLead(store, op, acme.id, l.id, { pipeline_id: custom.pipeline.id }));
    assert.equal(moved.stage_id, custom.stages[0].id);

    /* past the service: the database's own answer. */
    const otherLead = await lead(other, { contact_id: (await contact(other, { display_name: 'Elsewhere' })).id });
    const wrong = await refused(db, `update public.crm_leads set stage_id = $1 where id = $2`, [otherLead.stage_id, l.id]);
    assert.match(wrong, /arc_crm:invalid_stage/);
    await db.query(`update public.crm_pipeline_stages set archived_at = now() where id = $1`, [custom.stages[1].id]);
    const retired = await refused(db, `update public.crm_leads set stage_id = $1 where id = $2`, [custom.stages[1].id, l.id]);
    assert.match(retired, /arc_crm:invalid_stage.*retired/);
    await db.query(`update public.crm_leads set status = 'won' where id = $1`, [l.id]);
    assert.equal((await db.query('select status from crm_leads where id = $1', [l.id])).rows[0].status, 'open', 'a status is never typed');

    assert.equal((await crm.createPipeline(store, op, acme.id, { key: 'service_plans', name: 'Again', stages: [{ key: 'only', name: 'Only' }] })).code, 'key_taken');
    const closedOnly = await crm.createPipeline(store, op, acme.id, { key: 'closed_only', name: 'X', stages: [{ key: 'won', name: 'Won', kind: 'won' }] });
    assert.equal(closedOnly.code, 'invalid');
    assert.equal(await count('crm_pipelines', `tenant_id = $1 and key = 'closed_only'`, [acme.id]), 0);
  });

  test('a lead\'s value needs where it came from, and a lead keeps its contact', async () => {
    const c = await contact(acme, { display_name: 'Valued' });
    assert.equal((await crm.createLead(store, op, acme.id, { contact_id: c.id, source: 'manual', title: 'x', estimated_value_cents: 250000 })).code, 'invalid');
    const l = await lead(acme, { contact_id: c.id, estimated_value_cents: 250000, estimated_value_source: 'customer_provided' });
    assert.equal(Number(l.estimated_value_cents), 250000);
    assert.match(await refused(db, `update public.crm_leads set estimated_value_source = null where id = $1`, [l.id]), /check constraint/);
    const elsewhere = await contact(acme, { display_name: 'Someone Else' });
    assert.equal((await crm.updateLead(store, op, acme.id, l.id, { contact_id: elsewhere.id })).code, 'invalid');
    assert.match(await refused(db, `update public.crm_leads set contact_id = $1 where id = $2`, [elsewhere.id, l.id]), /keeps its contact/);
    ok(await crm.setContactArchived(store, op, acme.id, elsewhere.id, true, 'duplicate'));
    assert.equal((await crm.createLead(store, op, acme.id, { contact_id: elsewhere.id, source: 'manual', title: 'x' })).code, 'contact_unavailable');
  });

  /* ── notes, tasks, history ── */

  test('notes, tasks and the timeline: every change is recorded by the database, with who did it', async () => {
    const c = await contact(acme, { display_name: 'History' }, acme.staffActor);
    const l = await lead(acme, { contact_id: c.id }, acme.staffActor);
    const note = ok(await crm.addNote(store, acme.staffActor, acme.id, { lead_id: l.id, contact_id: c.id, body: 'Prefers mornings.' }));
    assert.equal(note.author_id, acme.staff);
    const task = ok(await crm.createTask(store, acme.staffActor, acme.id, { lead_id: l.id, contact_id: c.id, title: 'Call back', due_at: '2026-10-05T15:00:00Z' }));
    assert.equal(task.status, 'open');
    const done = ok(await crm.updateTask(store, acme.ownerActor, acme.id, task.id, { status: 'done' }));
    assert.ok(done.completed_at);
    assert.equal(done.completed_by, acme.owner);
    const reopened = ok(await crm.updateTask(store, acme.ownerActor, acme.id, task.id, { status: 'open' }));
    assert.equal(reopened.completed_at, null);
    ok(await crm.updateContact(store, acme.staffActor, acme.id, c.id, { city: 'Dublin', region: 'OH' }));

    const timeline = ok(await crm.getContact(store, op, acme.id, c.id)).timeline;
    const types = timeline.map((t) => t.activity_type);
    for (const expected of ['contact_created', 'lead_created', 'note_added', 'task_created', 'task_completed', 'task_reopened', 'contact_updated']) {
      assert.ok(types.includes(expected), `${expected} is in the timeline`);
    }
    const edit = timeline.find((t) => t.activity_type === 'contact_updated');
    assert.deepEqual(edit.detail.fields, ['city', 'region'], 'names of what changed, never the values');
    assert.equal(edit.actor_type, 'client_user');
    assert.equal(edit.actor_id, acme.staff);
    assert.equal(timeline.find((t) => t.activity_type === 'task_completed').actor_id, acme.owner);
    assert.doesNotMatch(JSON.stringify(timeline), /Prefers mornings|Dublin/);

    /* a note is never edited; removing one is an owner's or an operator's, and says who. */
    assert.match(await refused(db, `update public.crm_notes set body = 'rewritten' where id = $1`, [note.id]), /arc_crm:immutable/);
    assert.equal((await crm.archiveNote(store, acme.staffActor, acme.id, note.id)).code, 'forbidden');
    const archived = ok(await crm.archiveNote(store, acme.ownerActor, acme.id, note.id));
    assert.equal(archived.archived_by, acme.owner);
    assert.equal(ok(await crm.getLead(store, op, acme.id, l.id)).notes.length, 0);
    assert.equal((await crm.archiveNote(store, acme.ownerActor, acme.id, note.id)).code, 'immutable');

    /* the timeline itself is history. */
    assert.match(await refused(db, `update public.crm_activities set summary = 'x' where contact_id = $1`, [c.id]), /arc_crm:immutable/);
    assert.match(await refused(db, `delete from public.crm_activities where contact_id = $1`, [c.id]), /arc_crm:immutable/);
    assert.match(await refused(db, `insert into public.crm_activities (tenant_id, contact_id, activity_type, actor_type, summary) values ($1, $2, 'made_up', 'system', 'x')`, [acme.id, c.id]), /check constraint/);
  });

  /* ── sensitive changes ── */

  test('archiving, restoring and changing an owner are an owner\'s or an operator\'s, and an operator\'s are in the audit log', async () => {
    const c = await contact(acme, { display_name: 'Sensitive' });
    assert.equal((await crm.setContactArchived(store, acme.staffActor, acme.id, c.id, true)).code, 'forbidden');
    assert.equal((await crm.updateContact(store, acme.staffActor, acme.id, c.id, { owner_user_id: acme.staff })).code, 'forbidden');

    const owned = ok(await crm.updateContact(store, op, acme.id, c.id, { owner_user_id: acme.staff }));
    assert.equal(owned.owner_user_id, acme.staff);
    assert.equal((await crm.updateContact(store, op, acme.id, c.id, { owner_user_id: other.owner })).code, 'invalid_owner');
    const archived = ok(await crm.setContactArchived(store, op, acme.id, c.id, true, 'Asked to be removed'));
    assert.ok(archived.archived_at);
    assert.equal(ok(await crm.listContacts(store, op, acme.id, { limit: 200 })).some((x) => x.id === c.id), false);
    assert.equal(ok(await crm.listContacts(store, op, acme.id, { archived: true, limit: 200 })).some((x) => x.id === c.id), true);
    ok(await crm.setContactArchived(store, acme.ownerActor, acme.id, c.id, false));

    const audit = (await db.query(`select action, actor_user_id, metadata from admin_actions where target_type = 'crm_contact' and target_id = $1 order by occurred_at`, [c.id])).rows;
    assert.deepEqual(audit.map((a) => a.action), ['crm.contact.owner_changed', 'crm.contact.archived'], 'the client owner\'s restore is in the timeline, not the operator log');
    assert.ok(audit.every((a) => a.actor_user_id === operator));
    assert.equal(audit[1].metadata.reason, 'Asked to be removed');
    const types = ok(await crm.getContact(store, op, acme.id, c.id)).timeline.map((t) => t.activity_type);
    for (const expected of ['contact_owner_changed', 'contact_archived', 'contact_restored']) assert.ok(types.includes(expected), expected);
  });

  test('a merge moves everything in one transaction, leaves the merged contact read-only, and is audited', async () => {
    const keep = await contact(acme, { display_name: 'Pat Keeper', phone: '+16145550160' });
    const dupe = await contact(acme, { display_name: 'P. Keeper', email: 'pat@example.com', city: 'Hilliard' });
    const l = await lead(acme, { contact_id: dupe.id });
    ok(await crm.addNote(store, op, acme.id, { contact_id: dupe.id, body: 'Gate code is on file with dispatch.' }));
    ok(await crm.createTask(store, op, acme.id, { contact_id: dupe.id, title: 'Follow up' }));
    ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: dupe.id, connector_key: 'jobber', external_id: 'J-1001' }));

    assert.equal((await crm.mergeContacts(store, acme.staffActor, acme.id, { keepId: keep.id, mergeId: dupe.id })).code, 'forbidden');
    assert.equal((await crm.mergeContacts(store, op, acme.id, { keepId: keep.id, mergeId: keep.id })).code, 'invalid');
    const merged = ok(await crm.mergeContacts(store, op, acme.id, { keepId: keep.id, mergeId: dupe.id }));
    assert.deepEqual(merged.moved, { leads: 1, notes: 1, tasks: 1 });
    assert.equal(merged.contact.email, 'pat@example.com', 'the survivor takes what it lacked');
    assert.equal(merged.contact.display_name, 'Pat Keeper', 'and keeps what it had');
    assert.equal(merged.contact.city, 'Hilliard');

    const detail = ok(await crm.getContact(store, op, acme.id, keep.id));
    assert.deepEqual(detail.leads.map((x) => x.id), [l.id]);
    assert.equal(detail.notes.length, 1);
    assert.equal(detail.tasks.length, 1);
    assert.deepEqual(detail.mappings.map((m) => m.external_id), ['J-1001']);
    assert.ok(detail.timeline.some((t) => t.contact_id === dupe.id && t.activity_type === 'contact_created'), 'the merged contact\'s own history is read with the survivor\'s');

    const gone = (await db.query('select merged_into_id, archived_at, archived_reason from crm_contacts where id = $1', [dupe.id])).rows[0];
    assert.equal(gone.merged_into_id, keep.id);
    assert.ok(gone.archived_at);
    assert.equal((await crm.updateContact(store, op, acme.id, dupe.id, { city: 'X' })).code, 'merged');
    assert.equal((await crm.mergeContacts(store, op, acme.id, { keepId: keep.id, mergeId: dupe.id })).code, 'contact_unavailable');
    assert.match(await refused(db, `update public.crm_contacts set merged_into_id = $1 where id = $2`, [keep.id, (await contact(acme, { display_name: 'By hand' })).id]), /merged by crm_merge_contacts/);

    const audit = (await db.query(`select metadata from admin_actions where action = 'crm.contact.merged' and target_id = $1`, [keep.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].metadata.merged_contact_id, dupe.id);
  });

  test('a merge that would give one contact two records in the same external system is refused, and nothing moves', async () => {
    const a = await contact(acme, { display_name: 'Mapped A' });
    const b = await contact(acme, { display_name: 'Mapped B' });
    await lead(acme, { contact_id: b.id });
    ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'jobber', external_id: 'J-2001' }));
    ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: b.id, connector_key: 'jobber', external_id: 'J-2002' }));
    const outcome = await crm.mergeContacts(store, op, acme.id, { keepId: a.id, mergeId: b.id });
    assert.equal(outcome.code, 'mapping_conflict');
    assert.equal(await count('crm_leads', 'contact_id = $1', [b.id]), 1, 'the transaction left the lead where it was');
    assert.equal((await db.query('select merged_into_id from crm_contacts where id = $1', [b.id])).rows[0].merged_into_id, null);
  });

  /* ── external mappings ── */

  test('external mappings: one live mapping per record per system, one record per external id, in one tenant', async () => {
    const a = await contact(acme, { display_name: 'Ext A' });
    const b = await contact(acme, { display_name: 'Ext B' });
    const mapping = ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'housecall_pro', external_id: 'cus_100' }));
    assert.equal((await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: b.id, connector_key: 'housecall_pro', external_id: 'cus_100' })).code, 'mapping_conflict');
    assert.equal((await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'housecall_pro', external_id: 'cus_101' })).code, 'mapping_conflict');
    /* the same id in another system, or for another kind of record, is a different thing. */
    ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'jobber', external_id: 'cus_100' }));
    /* and another tenant's customer can carry the same external id. */
    const theirs = await contact(other, { display_name: 'Ext Other' });
    ok(await crm.addMapping(store, op, other.id, { object_type: 'contact', object_id: theirs.id, connector_key: 'housecall_pro', external_id: 'cus_100' }));

    assert.equal((await crm.addMapping(store, op, other.id, { object_type: 'contact', object_id: a.id, connector_key: 'jobber', external_id: 'x1' })).code, 'not_found', 'not this tenant\'s record');
    assert.equal((await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'salesforce', external_id: 'x1' })).code, 'invalid', 'not a connector ARC has');
    assert.equal((await crm.addMapping(store, acme.ownerActor, acme.id, { object_type: 'contact', object_id: a.id, connector_key: 'servicetitan', external_id: 'x1' })).code, 'forbidden');

    const found = ok(await crm.findByExternalId(store, op, acme.id, { object_type: 'contact', connector_key: 'housecall_pro', external_id: 'cus_100' }));
    assert.equal(found.record.id, a.id);
    assert.equal(ok(await crm.findByExternalId(store, op, other.id, { object_type: 'contact', connector_key: 'housecall_pro', external_id: 'cus_100' })).record.id, theirs.id);

    /* removed, never repointed; once removed the slot is free again. */
    assert.match(await refused(db, `update public.crm_external_mappings set object_id = $1 where id = $2`, [b.id, mapping.id]), /arc_crm:immutable/);
    const removed = ok(await crm.removeMapping(store, op, acme.id, mapping.id));
    assert.ok(removed.removed_at);
    assert.equal(ok(await crm.findByExternalId(store, op, acme.id, { object_type: 'contact', connector_key: 'housecall_pro', external_id: 'cus_100' })), null);
    ok(await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: b.id, connector_key: 'housecall_pro', external_id: 'cus_100' }));
    const types = ok(await crm.getContact(store, op, acme.id, a.id)).timeline.map((t) => t.activity_type);
    assert.ok(types.includes('mapping_added') && types.includes('mapping_removed'));
  });

  /* ── source of truth ── */

  test('source-of-truth policy: validated, an operator\'s decision, audited, and never against the route', async () => {
    const t = await newTenant('crm-policy');
    const overview = ok(await crm.getBusinessOverview(store, op, t.id));
    assert.ok(overview.source_policies.every((p) => p.authority === 'arc'), 'no row means ARC');

    assert.equal((await crm.setSourcePolicy(store, t.ownerActor, t.id, { object_type: 'contact', authority: 'external', connector_key: 'jobber' })).code, 'forbidden');
    for (const bad of [
      { object_type: 'contact', authority: 'external' },
      { object_type: 'contact', authority: 'external', connector_key: 'salesforce' },
      { object_type: 'contact', authority: 'arc', connector_key: 'jobber' },
      { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber' },
      { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'both' } },
      { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { owner_user_id: 'external' } },
      { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'arc' } },
      { object_type: 'invoice', authority: 'arc' },
      { object_type: 'contact', authority: 'latest_wins' },
    ]) {
      assert.equal((await crm.setSourcePolicy(store, op, t.id, bad)).code, 'invalid', JSON.stringify(bad));
    }
    const hybrid = ok(await crm.setSourcePolicy(store, op, t.id, { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'external', email: 'external' } }));
    assert.deepEqual(hybrid.fieldOwners, { phone: 'external', email: 'external' });
    const external = ok(await crm.setSourcePolicy(store, op, t.id, { object_type: 'lead', authority: 'external', connector_key: 'jobber' }));
    assert.equal(external.authority, 'external');
    assert.equal(await count('admin_actions', `action = 'crm.source_policy.set' and target_id = $1`, [t.id]), 2);

    /* past the service: the database's own shape checks. */
    const insert = `insert into public.crm_source_policies (tenant_id, object_type, authority, connector_key, field_owners, updated_by) values ($1, $2, $3, $4, $5::jsonb, $6)`;
    assert.match(await refused(db, insert, [t.id, 'task', 'external', null, '{}', operator]), /check constraint/);
    assert.match(await refused(db, insert, [t.id, 'task', 'hybrid', 'jobber', '{}', operator]), /check constraint/);
    assert.match(await refused(db, insert, [t.id, 'task', 'hybrid', 'jobber', '{"title":"both"}', operator]), /arc_crm:invalid/);
    assert.match(await refused(db, insert, [t.id, 'task', 'external', 'jobber', '{}', t.owner]), /arc_crm:forbidden/);
    assert.match(await refused(db, insert, [t.id, 'task', 'external', 'salesforce', '{}', operator]), /foreign key/);

    /* the route and the policies cannot disagree, in either order. */
    const native = await crm.setRoute(store, op, t.id, 'native');
    assert.equal(native.code, 'route_conflict');
    ok(await crm.setRoute(store, op, t.id, 'hybrid'));
    const n = await newTenant('crm-native');
    assert.equal((await crm.setRoute(store, n.ownerActor, n.id, 'native')).code, 'forbidden');
    assert.equal((await crm.setRoute(store, op, n.id, 'sideways')).code, 'invalid');
    const recorded = ok(await crm.setRoute(store, op, n.id, 'native'));
    assert.equal(recorded.route, 'native');
    assert.equal(recorded.route_recorded_by, operator);
    assert.equal((await crm.setSourcePolicy(store, op, n.id, { object_type: 'contact', authority: 'external', connector_key: 'jobber' })).code, 'invalid');
    assert.match(await refused(db, insert, [n.id, 'contact', 'external', 'jobber', '{}', operator]), /arc_crm:route_conflict/);
    assert.equal(await count('admin_actions', `action = 'crm.route.recorded' and target_id = $1`, [n.id]), 1);
  });

  test('the authority is enforced: the side that does not own a field cannot write it, and nothing is merged', async () => {
    const t = await newTenant('crm-authority');
    const top = { kind: 'operator', userId: operator };
    const sync = { kind: 'external', connectorKey: 'jobber' };
    /* ARC by default: a sync cannot write. */
    assert.equal((await crm.createContact(store, sync, t.id, { display_name: 'From Jobber' })).code, 'arc_authority');

    ok(await crm.setSourcePolicy(store, top, t.id, { object_type: 'contact', authority: 'hybrid', connector_key: 'jobber', field_owners: { phone: 'external' } }));
    const c = ok(await crm.createContact(store, top, t.id, { display_name: 'Split Owner', email: 'split@example.com' }));
    const blocked = await crm.updateContact(store, t.ownerActor, t.id, c.id, { phone: '+16145550170', city: 'Columbus' });
    assert.equal(blocked.code, 'external_authority');
    assert.match(blocked.message, /phone is kept in jobber/);
    assert.equal((await db.query('select city from crm_contacts where id = $1', [c.id])).rows[0].city, null, 'refused whole, not half applied');
    ok(await crm.updateContact(store, t.ownerActor, t.id, c.id, { city: 'Columbus' }));
    const synced = ok(await crm.updateContact(store, sync, t.id, c.id, { phone: '+16145550170' }));
    assert.equal(synced.updated_by_type, 'external');
    assert.equal((await crm.updateContact(store, sync, t.id, c.id, { email: 'other@example.com' })).code, 'arc_authority');
    assert.equal((await crm.updateContact(store, { kind: 'external', connectorKey: 'housecall_pro' }, t.id, c.id, { phone: '+16145550171' })).code, 'arc_authority');

    /* their system is the authority for leads: ARC's intake may record an arrival, nobody in ARC edits it. */
    ok(await crm.setSourcePolicy(store, top, t.id, { object_type: 'lead', authority: 'external', connector_key: 'jobber' }));
    assert.equal((await crm.createLead(store, top, t.id, { contact_id: c.id, source: 'manual', title: 'Typed in ARC' })).code, 'external_authority');
    const arrival = ok(await crm.createLead(store, system, t.id, { contact_id: c.id, source: 'missed_call', title: 'Missed call' }));
    assert.equal((await crm.updateLead(store, top, t.id, arrival.id, { title: 'Renamed in ARC' })).code, 'external_authority');
    assert.equal((await crm.updateLead(store, system, t.id, arrival.id, { stage_key: 'contacted' })).code, 'external_authority');
    ok(await crm.updateLead(store, sync, t.id, arrival.id, { stage_key: 'contacted' }));
    /* who owns it in ARC, and whether it is archived, stay ARC's on every route. */
    ok(await crm.updateLead(store, top, t.id, arrival.id, { owner_user_id: t.staff }));
    ok(await crm.setLeadArchived(store, top, t.id, arrival.id, true));
  });

  /* ── the business ── */

  test('business profile, locations, service areas and services: saved, validated, and each tenant\'s own', async () => {
    const profile = ok(await crm.saveBusinessProfile(store, acme.ownerActor, acme.id, {
      public_phone: '(614) 555-0100', public_email: 'Office@Acme.example', website_url: 'https://acme.example',
      business_hours: { mon: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }], sat: [{ open: '09:00', close: '13:00' }] },
    }));
    assert.equal(profile.public_phone, '+16145550100');
    assert.equal(profile.public_email, 'office@acme.example');
    assert.equal(profile.route, null);
    assert.equal((await crm.saveBusinessProfile(store, acme.staffActor, acme.id, { website_url: 'https://x.example' })).code, 'forbidden');
    for (const bad of [
      { business_hours: { mon: [{ open: '17:00', close: '08:00' }] } },
      { business_hours: { funday: [] } },
      { business_hours: { mon: [{ open: '08:00', close: '12:00' }, { open: '11:00', close: '15:00' }] } },
      { website_url: 'http://insecure.example' },
      { website_url: 'https://acme.example/?token=abc' },
      { display_name: 'A second name' },
      { timezone: 'America/Denver' },
      { route: 'native' },
    ]) {
      assert.equal((await crm.saveBusinessProfile(store, op, acme.id, bad)).code, 'invalid', JSON.stringify(bad));
    }
    /* a later save changes what it names and leaves the rest. */
    const again = ok(await crm.saveBusinessProfile(store, op, acme.id, { website_url: null }));
    assert.equal(again.website_url, null);
    assert.equal(again.public_phone, '+16145550100');

    const hq = ok(await crm.saveLocation(store, acme.ownerActor, acme.id, { name: 'Main shop', city: 'Columbus', region: 'OH', postal_code: '43215', is_primary: true }));
    assert.equal((await crm.saveLocation(store, op, acme.id, { name: 'Second primary', is_primary: true })).code, 'conflict');
    assert.equal((await crm.saveLocation(store, op, acme.id, { name: 'Nowhere', timezone: 'Mars/Olympus' })).code, 'invalid');
    const renamed = ok(await crm.saveLocation(store, op, acme.id, { name: 'Main shop (Front St)' }, hq.id));
    assert.equal(renamed.city, 'Columbus');

    ok(await crm.saveServiceArea(store, op, acme.id, { kind: 'postal_code', value: '43215' }));
    assert.equal((await crm.saveServiceArea(store, op, acme.id, { kind: 'postal_code', value: '43215' })).code, 'conflict');
    assert.equal((await crm.saveServiceArea(store, op, acme.id, { kind: 'radius_miles', value: '25' })).code, 'invalid');
    ok(await crm.saveServiceArea(store, op, acme.id, { kind: 'radius_miles', value: '25', location_id: hq.id }));

    const category = ok(await crm.saveServiceCategory(store, op, acme.id, { key: 'heating', name: 'Heating' }));
    const service = ok(await crm.saveService(store, op, acme.id, { key: 'furnace_repair', name: 'Furnace repair', category_id: category.id, default_duration_minutes: 90, is_bookable: true }));
    assert.equal((await crm.saveService(store, op, acme.id, { key: 'furnace_repair', name: 'Again' })).code, 'key_taken');
    const retired = ok(await crm.saveService(store, op, acme.id, { archived: true }, service.id));
    assert.ok(retired.archived_at);

    /* isolation: the other tenant's actor, the other tenant's ids, the other tenant's overview. */
    assert.equal((await crm.getBusinessOverview(store, other.ownerActor, acme.id)).code, 'forbidden');
    assert.equal((await crm.saveLocation(store, other.ownerActor, other.id, { name: 'Hijack' }, hq.id)).code, 'not_found');
    assert.equal((await crm.saveService(store, other.ownerActor, other.id, { key: 'x_service', name: 'X', category_id: category.id })).code, 'not_found');
    assert.equal((await crm.saveServiceArea(store, other.ownerActor, other.id, { kind: 'radius_miles', value: '10', location_id: hq.id })).code, 'not_found');
    const theirs = ok(await crm.getBusinessOverview(store, other.ownerActor, other.id));
    assert.equal(theirs.profile, null);
    assert.deepEqual([theirs.locations, theirs.service_areas, theirs.service_categories, theirs.services], [[], [], [], []]);
    const mine = ok(await crm.getBusinessOverview(store, acme.staffActor, acme.id));
    assert.equal(mine.tenant.name, 'Co crm-acme', 'the name and timezone are the tenant\'s own');
    assert.equal(mine.tenant.timezone, 'America/Denver');
    assert.equal(mine.locations.length, 1);
    assert.equal(mine.service_areas.length, 2);

    await asRole(db, { role: 'authenticated', sub: other.owner }, async (tx) => {
      for (const table of ['business_profiles', 'business_locations', 'business_service_areas', 'business_service_categories', 'business_services']) {
        assert.equal((await tx.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, table);
      }
    });
    await asRole(db, { role: 'authenticated', sub: acme.owner }, async (tx) => {
      assert.equal((await tx.query('select count(*)::int as n from public.business_locations')).rows[0].n, 1);
      await assert.rejects(tx.query(`update public.business_profiles set website_url = 'https://evil.example'`), /permission denied/);
    });
  });

  /* ── secrets ── */

  test('no secret-shaped value is accepted in a CRM field — by the service, or by the database behind it', async () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBhcnQ'].join('.');
    const named = ['api', 'key: ', 'abcd1234efgh5678'].join('_').replace('_key: _', '_key: ');
    const c = await contact(acme, { display_name: 'Clean' });
    for (const value of [jwt, named, `Bearer ${'a1b2c3d4e5f6g7h8'}`]) {
      assert.equal((await crm.addNote(store, op, acme.id, { contact_id: c.id, body: `their login is ${value}` })).code, 'invalid');
      assert.equal((await crm.createContact(store, op, acme.id, { display_name: value })).code, 'invalid');
      assert.equal((await crm.createLead(store, op, acme.id, { contact_id: c.id, source: 'manual', title: 'x', summary: value })).code, 'invalid');
      assert.equal((await crm.recordSourceEvent(store, system, acme.id, { source: 'webhook', detail: { note: value } })).code, 'invalid');
      assert.match(await refused(db, `insert into public.crm_notes (tenant_id, contact_id, body, author_type) values ($1, $2, $3, 'system')`, [acme.id, c.id, `x ${value}`]), /check constraint/);
    }
    assert.equal((await crm.recordSourceEvent(store, system, acme.id, { source: 'webhook', detail: { access_token: 'abcdefgh12345678' } })).code, 'invalid');
    assert.match(await refused(db, `insert into public.crm_source_events (tenant_id, source, detail) values ($1, 'webhook', $2::jsonb)`, [acme.id, JSON.stringify({ password: 'hunter2hunter2' })]), /check constraint/);
    assert.equal((await crm.addMapping(store, op, acme.id, { object_type: 'contact', object_id: c.id, connector_key: 'jobber', external_id: jwt })).code, 'invalid');
    /* ordinary words that merely mention one are fine. */
    ok(await crm.addNote(store, op, acme.id, { contact_id: c.id, body: 'Forgot their password to the thermostat app; walked them through a reset.' }));
  });

  /* ── safety by reference, and source records ── */

  test('whether a contact may be messaged is read from the suppression list, never stored on the contact', async () => {
    const c = await contact(acme, { display_name: 'Opted Out', phone: '+16145550180', email: 'optout@example.com' });
    let safety = ok(await crm.getContact(store, op, acme.id, c.id)).safety;
    assert.deepEqual(safety.map((s) => [s.channel, s.suppressed]), [['sms', false], ['email', false]]);
    await db.query(`insert into suppressions (tenant_id, channel, address, reason, source) values ($1, 'sms', '+16145550180', 'opt_out', 'customer')`, [acme.id]);
    await db.query(`insert into suppressions (tenant_id, channel, address, reason) values ($1, 'email', 'optout@example.com', 'opt_out')`, [other.id]);
    safety = ok(await crm.getContact(store, op, acme.id, c.id)).safety;
    assert.deepEqual(safety.map((s) => [s.channel, s.suppressed, s.reason]), [['sms', true, 'opt_out'], ['email', false, null]], 'another tenant\'s opt-out is not this one\'s');
    assert.equal(Object.keys(c).some((k) => /consent|suppress|opt/.test(k)), false);
  });

  test('a source record is one arrival: idempotent, linked once, and never rewritten', async () => {
    const first = ok(await crm.recordSourceEvent(store, system, acme.id, {
      source: 'web_form', idempotency_key: 'form-post-0001', detail: { form: 'contact-us', utm_source: 'google' }, external_ref: 'sub_1',
    }));
    assert.equal(first.replayed, false);
    const again = ok(await crm.recordSourceEvent(store, system, acme.id, { source: 'web_form', idempotency_key: 'form-post-0001', detail: { form: 'changed' } }));
    assert.equal(again.replayed, true);
    assert.equal(again.source_event.id, first.source_event.id);
    assert.deepEqual(again.source_event.detail, { form: 'contact-us', utm_source: 'google' });
    /* the same key for another tenant is another arrival. */
    assert.equal(ok(await crm.recordSourceEvent(store, system, other.id, { source: 'web_form', idempotency_key: 'form-post-0001' })).replayed, false);

    const c = ok(await crm.resolveContact(store, system, acme.id, { email: 'form@example.com', first_name: 'Form' })).contact;
    const l = ok(await crm.createLead(store, system, acme.id, { contact_id: c.id, source: 'web_form', title: 'Website enquiry', source_event_id: first.source_event.id }));
    assert.equal(l.source_event_id, first.source_event.id);
    const linked = ok(await crm.linkSourceEvent(store, system, acme.id, first.source_event.id, { contact_id: c.id, lead_id: l.id }));
    assert.equal(linked.lead_id, l.id);
    const elsewhere = await contact(acme, { display_name: 'Not the sender' });
    assert.equal((await crm.linkSourceEvent(store, system, acme.id, first.source_event.id, { contact_id: elsewhere.id })).code, 'immutable');
    assert.match(await refused(db, `update public.crm_source_events set source = 'manual' where id = $1`, [first.source_event.id]), /arc_crm:immutable/);
    assert.match(await refused(db, `delete from public.crm_source_events where id = $1`, [first.source_event.id]), /arc_crm:immutable/);
    assert.equal((await crm.recordSourceEvent(store, system, acme.id, { source: 'carrier_pigeon' })).code, 'invalid');
    /* a source record from another tenant cannot be a lead's source here. */
    assert.equal((await crm.createLead(store, op, other.id, { contact_id: (await contact(other, { display_name: 'O' })).id, source: 'web_form', title: 'x', source_event_id: first.source_event.id })).code, 'not_found');
  });

  test('a CRM lead can point at the engine\'s lead for the same arrival, once, in the same tenant', async () => {
    const correlation = uuid('eeeeeeee');
    const engine = (await db.query(`insert into public.leads (tenant_id, correlation_id, source, phone) values ($1, $2, 'missed_call', '+16145550190') returning id`, [acme.id, correlation])).rows[0].id;
    const c = ok(await crm.resolveContact(store, system, acme.id, { phone: '+16145550190' })).contact;
    const l = ok(await crm.createLead(store, system, acme.id, { contact_id: c.id, source: 'missed_call', title: 'Missed call', recovery_lead_id: engine }));
    assert.equal(l.recovery_lead_id, engine);
    assert.equal((await crm.createLead(store, system, acme.id, { contact_id: c.id, source: 'missed_call', title: 'Twice', recovery_lead_id: engine })).code, 'conflict');
    const theirs = await contact(other, { display_name: 'Other' });
    assert.equal((await crm.createLead(store, system, other.id, { contact_id: theirs.id, source: 'missed_call', title: 'Cross', recovery_lead_id: engine })).code, 'not_found');
  });

  /* ── the ops surface and the purge ── */

  test('the ops actions: an operator\'s token is the actor, every problem comes back by field, and nobody else gets in', async () => {
    const call = (action, body, actorId = operator) => handleCrmAction(action, { crm: store, body, actorId });
    const created = await call('crm-contact-create', { tenant_id: acme.id, contact: { first_name: 'Opal', phone: '614 555 0111' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.contact.updated_by, operator);
    const bad = await call('crm-contact-create', { tenant_id: acme.id, contact: { phone: '12', email: 'nope', nickname: 'x' } });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.field_errors.map((e) => e.field).sort(), ['display_name', 'email', 'nickname', 'phone']);
    assert.equal((await call('crm-contact-get', { tenant_id: acme.id, contact_id: created.body.contact.id })).body.detail.contact.display_name, 'Opal');
    assert.equal((await call('crm-contact-get', { tenant_id: other.id, contact_id: created.body.contact.id })).status, 404);
    assert.equal((await call('crm-overview', { tenant_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call('crm-overview', {})).status, 422);
    assert.equal((await call('crm-contact-list', { tenant_id: acme.id }, null)).status, 401);
    /* somebody the gate let through who is not in arc_admins is stopped by the database. */
    const stranger = await call('crm-contact-create', { tenant_id: acme.id, contact: { display_name: 'By a stranger' } }, acme.owner);
    assert.equal(stranger.status, 403);
    assert.equal(await count('crm_contacts', `display_name = 'By a stranger'`), 0);
    for (const action of CRM_ACTIONS) {
      const res = await call(action, { tenant_id: acme.id });
      assert.notEqual(res.status, 500, action);
    }
  });

  test('a client with customers is not a test client: the purge refuses it, and still deletes one with only setup', async () => {
    const client = restClient(db);
    const purge = (tenant) => handleTenantAction('tenant-purge', {
      store: supabaseStore(client), tenants: supabaseTenantStore(client), body: { tenant_id: tenant.id, confirm_slug: tenant.slug }, actorId: operator,
    });
    const real = { ...(await newTenant('crm-purge-real')), slug: 'crm-purge-real' };
    await contact(real, { display_name: 'A real customer' });
    const refusedPurge = await purge(real);
    assert.equal(refusedPurge.body.code, 'tenant_has_activity');
    assert.match(refusedPurge.body.error, /1 customer records/);

    const setup = { ...(await newTenant('crm-purge-setup')), slug: 'crm-purge-setup' };
    ok(await crm.saveBusinessProfile(store, op, setup.id, { website_url: 'https://setup.example' }));
    ok(await crm.saveLocation(store, op, setup.id, { name: 'Shop' }));
    ok(await crm.createPipeline(store, op, setup.id, { key: 'sales', name: 'Sales', is_default: true, stages: [{ key: 'new', name: 'New' }] }));
    ok(await crm.setSourcePolicy(store, op, setup.id, { object_type: 'contact', authority: 'external', connector_key: 'jobber' }));
    const purged = await purge(setup);
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    for (const table of ['business_profiles', 'business_locations', 'crm_pipelines', 'crm_pipeline_stages', 'crm_source_policies']) {
      assert.equal(await count(table, 'tenant_id = $1', [setup.id]), 0, table);
    }
  });
});
