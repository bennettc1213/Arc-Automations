/* ARC-390 — route-aware onboarding, against real Postgres.
 *
 * Two parts, as for 0023–0027:
 *
 *   1. The text of 0028, always: RLS and an operator-only read policy on both tables and no
 *      write policy, nothing granted to a browser role, its vocabularies the model's, and —
 *      read off the function bodies — that saving a plan touches nothing but the plan.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the real
 *      `ops` handler and the real service over the real stores, so what an operator presses
 *      is what 0028 receives.
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
import { supabaseBookingStore } from '../supabase/functions/_shared/booking/supabase-booking-store.ts';
import { supabaseOnboardingStore } from '../supabase/functions/_shared/onboarding/supabase-onboarding-store.ts';
import * as crm from '../supabase/functions/_shared/crm/service.ts';
import * as intake from '../supabase/functions/_shared/intake/service.ts';
import * as booking from '../supabase/functions/_shared/booking/service.ts';
import * as onboarding from '../supabase/functions/_shared/onboarding/service.ts';
import {
  CAPABILITY_KEYS, EVENT_TYPES, OWNING_CAPABILITIES, recommendPlan, SOURCES,
} from '../supabase/functions/_shared/onboarding/model.ts';
import { ROUTE_DISCOVERY, ROUTE_KEYS } from '../supabase/functions/_shared/routes/model.ts';
import { handleOnboardingAction, ONBOARDING_ACTIONS } from '../supabase/functions/ops/onboarding.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0028_onboarding.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');
const functionBody = (name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$;`).exec(CODE)?.[0] ?? '';
const quoted = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0028 as written', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  const functions = [...new Set([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]))];

  test('both tables have RLS and a read policy for operators only, and no write policy', () => {
    assert.deepEqual([...tables].sort(), [...onboarding.ONBOARDING_TABLES].sort());
    const listed = /foreach t in array array\[([\s\S]*?)\] loop/.exec(CODE)[1];
    for (const table of tables) assert.match(listed, new RegExp(`'${table}'`), `${table} is in the RLS loop`);
    assert.equal([...CODE.matchAll(/create policy/g)].length, 1, 'only the loop\'s read policy');
    assert.match(CODE, /for select to authenticated using \(public\.is_arc_admin\(\)\)/);
    assert.doesNotMatch(CODE, /is_tenant_member/, 'a client does not read the operator\'s working record');
    assert.doesNotMatch(CODE, /create policy [^;]*for (insert|update|delete|all)\b/i);
  });

  test('no function here is executable by a browser role, and none is security definer', () => {
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
    assert.ok(functions.length >= 12);
    for (const fn of functions) {
      assert.match(CODE, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), `${fn} is revoked`);
    }
    assert.doesNotMatch(CODE, /security definer/i);
  });

  test('the vocabularies are the model\'s', () => {
    assert.deepEqual(quoted(/select array\[([\s\S]*?)\]::text\[\]/.exec(functionBody('onboarding_capabilities'))[1]), [...CAPABILITY_KEYS]);
    const owned = [...functionBody('onboarding_capability_object').matchAll(/when '(\w+)' then '(\w+)'/g)].map((m) => ({ capability: m[1], object: m[2] }));
    assert.deepEqual(owned, [...OWNING_CAPABILITIES]);
    /* the three kinds of record a change of authority walks, in the model's order. */
    const walked = [...functionBody('onboarding_authority_pending').matchAll(/\(\d, '(\w+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(walked, OWNING_CAPABILITIES.map((o) => o.capability));
    const problem = functionBody('onboarding_plan_problem');
    assert.deepEqual(quoted(/v_source not in \(([^)]*)\)/.exec(problem)[1]), [...SOURCES]);
    assert.deepEqual(quoted(/v_route not in \(([^)]*)\)/.exec(problem)[1]), [...ROUTE_KEYS]);
    const events = /event_type\s+text not null check \(event_type in \(([\s\S]*?)\)\)/.exec(CODE)[1];
    assert.deepEqual(quoted(events), [...EVENT_TYPES]);
  });

  test('saving a plan writes the plan and its history line, and nothing a plan could lead to', () => {
    const save = functionBody('onboarding_save');
    assert.ok(save.length > 0);
    for (const name of ['onboarding_save', 'onboarding_record', 'onboarding_log', 'tenant_onboarding_guard']) {
      assert.doesNotMatch(
        functionBody(name),
        /tenant_modules|module_configs|apply_tenant_module_transition|crm_source_policies|business_profiles|crm_intake_forms|crm_booking_pages|provider_connections|scheduled_actions|automation_runs/,
        `${name} reaches only the onboarding tables and the audit log`,
      );
    }
    const written = [...save.matchAll(/(?:insert into|update) public\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(written)], ['tenant_onboarding']);
  });

  test('authority moves only in one function, only for the change that was read, and in 0023\'s order', () => {
    const writers = functions.filter((fn) => /(insert into|update) public\.(crm_source_policies|business_profiles)/.test(functionBody(fn)));
    assert.deepEqual(writers.sort(), ['onboarding_apply_authority', 'onboarding_write_route']);
    const apply = functionBody('onboarding_apply_authority');
    const check = apply.indexOf("p_digest is distinct from v_pending ->> 'digest'");
    const leaving = apply.indexOf("v_route <> 'native'");
    const policies = apply.indexOf('insert into public.crm_source_policies');
    const arriving = apply.indexOf("if v_route = 'native' then");
    assert.ok(check > 0 && leaving > check && policies > leaving && arriving > policies, 'digest, then the route when leaving Native, then the policies, then the route when arriving');
    assert.match(apply, /from public\.tenant_onboarding o where o\.tenant_id = p_tenant for update/);
    assert.match(apply, /perform public\.onboarding_check_operator\(p_actor\)/);
    assert.match(apply, /'authority_changed'/);
    assert.match(apply, /'route_changed'/);
  });

  test('nothing here deletes a row, writes evidence, sends anything or starts a run', () => {
    assert.doesNotMatch(CODE, /\bdelete from\b|\btruncate table\b|\bdrop table\b|\bdrop column\b/i);
    for (const fn of functions) {
      assert.doesNotMatch(functionBody(fn), /public\.(events|leads|messages|crm_messages|suppressions|automation_runs|scheduled_actions)\b/, fn);
    }
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), drops.join(', '));
    const columns = [...CODE.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|jsonb|timestamptz|boolean|integer|bigint)\b/gm)].map((m) => m[1]);
    for (const column of columns) assert.doesNotMatch(column, /token|secret|password|credential|api_key/, column);
  });

  test('the history is append-only, with the one exception a purged test client makes', () => {
    assert.match(CODE, /create trigger tenant_onboarding_events_immutable\s+before update on public\.tenant_onboarding_events/);
    assert.match(CODE, /create trigger tenant_onboarding_events_immutable_delete\s+before delete on public\.tenant_onboarding_events\s+for each row when \(not public\.tenant_purge_in_progress\(old\.tenant_id\)\)/);
  });

  test('the ops door runs four onboarding actions, and none of them names a workflow runner', () => {
    assert.deepEqual(ONBOARDING_ACTIONS, ['onboarding-overview', 'onboarding-save', 'onboarding-authority-apply', 'onboarding-enable']);
    assert.ok(!ONBOARDING_ACTIONS.some((name) => /n8n|workflow|activate|select/.test(name)));
    const door = readFileSync(new URL('../supabase/functions/ops/index.ts', import.meta.url), 'utf8');
    assert.match(door, /\.\.\.ONBOARDING_ACTIONS,/);
    assert.match(door, /onboarding: supabaseOnboardingStore\(db\)/);
    assert.match(door, /0028_onboarding\.sql/);
    /* the client's own `crm` door is not given onboarding at all. */
    assert.doesNotMatch(readFileSync(new URL('../supabase/functions/crm/index.ts', import.meta.url), 'utf8'), /onboarding/i);
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

const TZ = 'America/Denver';
const EVERY_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ open: '08:00', close: '17:00' }]]));

const arc = { source: 'arc', connector_key: null, tool: null };
const out = { source: 'not_needed', connector_key: null, tool: null };
const kept = (connector_key, tool = null) => ({ source: 'external', connector_key, tool });
const discovery = (answers) => Object.fromEntries(ROUTE_DISCOVERY.map((q) => [q.key, answers[q.key]]));
const tools = (overrides = {}) => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, overrides[key] ?? { uses: 'nothing' }]));

const NATIVE_ANSWERS = {
  discovery: discovery({ crm: 'none', lead_tracking: 'no', online_booking: 'no', follow_up: 'no', keep: 'nothing' }),
  tools: tools(),
  existing_records: 'none',
};
const NATIVE_PLAN = {
  route: 'native',
  capabilities: {
    customer_records: arc, lead_intake: arc, lead_pipeline: arc, website_form: arc, messaging: arc,
    email: out, calendar: arc, booking: arc, field_service: out, accounting: out,
  },
};
const HYBRID_PLAN = {
  route: 'hybrid',
  capabilities: {
    customer_records: arc, lead_intake: arc, lead_pipeline: arc, website_form: arc, messaging: kept(null, 'their phone system'),
    email: out, calendar: kept('google_calendar'), booking: kept('google_calendar'), field_service: out, accounting: kept(null, 'their books'),
  },
};
const CONNECTED_PLAN = {
  route: 'connected',
  capabilities: {
    customer_records: kept('servicetitan'), lead_intake: kept('servicetitan'), lead_pipeline: kept('servicetitan'), website_form: out, messaging: arc,
    email: out, calendar: kept('servicetitan'), booking: out, field_service: kept('servicetitan'), accounting: kept(null, 'their books'),
  },
};

describe('onboarding on real SQL', { skip }, () => {
  let db;
  let deps;
  let operator;
  let op;

  async function newUser() {
    const id = uuid('eeeeeeee');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  }
  const ok = (outcome) => {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome.result;
  };
  const count = async (table, where = 'true', params = []) =>
    Number((await db.query(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0].n);
  const all = async (sql, params = []) => (await db.query(sql, params)).rows;

  async function newTenant(slug, modules = []) {
    const client = restClient(db);
    const res = await handleTenantAction('tenant-create', {
      store: supabaseStore(client),
      tenants: supabaseTenantStore(client),
      body: { tenant: { name: `Co ${slug}`, slug, timezone: TZ, status: 'onboarding' }, modules, idempotency_key: `onboarding-test-${slug}` },
      actorId: operator,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.tenant.id;
    const owner = await newUser();
    await db.query(`insert into tenant_members (user_id, tenant_id, role) values ($1, $2, 'owner')`, [owner, id]);
    return { id, slug, owner, ownerActor: { kind: 'client_user', userId: owner, tenantId: id, role: 'owner' } };
  }

  /** what the operator's request through the `ops` function does, minus HTTP. */
  const call = (action, tenant, body = {}, actorId = operator) =>
    handleOnboardingAction(action, { deps, body: { tenant_id: tenant.id, ...body }, actorId });
  const read = async (tenant) => {
    const res = await call('onboarding-overview', tenant);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.onboarding;
  };
  const save = async (tenant, body) => {
    const current = await read(tenant);
    const res = await call('onboarding-save', tenant, { expected_revision: current.revision, ...body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.onboarding;
  };
  const apply = async (tenant) => {
    const current = await read(tenant);
    const res = await call('onboarding-authority-apply', tenant, { acknowledged: current.pending.digest });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.onboarding;
  };
  const row = (view, key) => view.matrix.find((r) => r.capability === key);
  const step = (view, key) => view.steps.find((s) => s.key === key);
  const policies = (tenant) => all('select object_type, authority, connector_key from public.crm_source_policies where tenant_id = $1 order by object_type', [tenant.id]);
  const person = (n) => ({ display_name: `Customer ${n}`, phone: `+1614555${String(2000 + n)}` });

  before(async () => {
    db = await freshDatabase();
    operator = await newUser();
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    op = { kind: 'operator', userId: operator };
    const client = restClient(db);
    deps = {
      onboarding: supabaseOnboardingStore(client),
      crm: supabaseCrmStore(client),
      intake: supabaseIntakeStore(client),
      booking: supabaseBookingStore(client),
      channels: [],
    };
  });

  /* ── nothing yet ── */

  test('a client nobody has onboarded reads as nothing decided: every capability a gap, and no row written', async () => {
    const tenant = await newTenant('onb-blank');
    const view = await read(tenant);
    assert.equal(view.revision, 0);
    assert.equal(view.plan, null);
    assert.equal(view.recommendation.complete, false);
    assert.equal(view.gaps.length, CAPABILITY_KEYS.length);
    assert.ok(view.matrix.every((r) => r.state === 'undecided'));
    assert.ok(view.steps.every((s) => s.status !== 'done'));
    assert.equal(view.pending.digest, null);
    assert.deepEqual(view.history, []);
    assert.equal(await count('tenant_onboarding', 'tenant_id = $1', [tenant.id]), 0, 'reading is not starting');
  });

  /* ── a recommendation, and a plan, are paper ── */

  test('answers, a recommendation and a saved plan activate nothing, select nothing and move nothing', async () => {
    const tenant = await newTenant('onb-paper', ['lead_recovery']);
    const lifecycle = async () => all('select module_key, state, state_version from public.tenant_modules where tenant_id = $1', [tenant.id]);
    const before = {
      modules: await lifecycle(),
      transitions: await count('tenant_module_transitions', 'tenant_id = $1', [tenant.id]),
      configs: await count('module_configs', 'tenant_id = $1', [tenant.id]),
    };
    assert.deepEqual(before.modules.map((m) => m.state), ['configuring']);

    const said = await save(tenant, { answers: NATIVE_ANSWERS });
    assert.equal(said.recommendation.route, 'native');
    assert.equal(said.plan, null, 'a recommendation is not a plan');
    assert.deepEqual(said.recommendation, recommendPlan(NATIVE_ANSWERS));

    const planned = await save(tenant, { plan: said.recommendation.plan });
    assert.equal(planned.plan.route, 'native');
    assert.equal(planned.revision, 2);

    assert.deepEqual(await lifecycle(), before.modules, 'the module is exactly where it was');
    assert.equal(await count('tenant_module_transitions', 'tenant_id = $1', [tenant.id]), before.transitions);
    assert.equal(await count('module_configs', 'tenant_id = $1', [tenant.id]), before.configs);
    assert.equal(await count('business_profiles', 'tenant_id = $1', [tenant.id]), 0, 'no route is recorded by saving a plan');
    assert.equal(await count('crm_source_policies', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('crm_pipelines', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('crm_intake_forms', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('crm_booking_pages', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('events', 'tenant_id = $1', [tenant.id]), 0);
    assert.deepEqual(planned.history.map((e) => e.event_type), ['plan_saved', 'answers_saved']);
    assert.equal(step(planned, 'route').status, 'todo', 'the plan says native; nothing is recorded');
    assert.deepEqual(planned.pending.route, { from: null, to: 'native' });
  });

  /* ── ARC Native ── */

  test('ARC Native goes end to end with no other system: no connector, no connection, no policy row', async () => {
    const tenant = await newTenant('onb-native');
    await save(tenant, { answers: NATIVE_ANSWERS, plan: NATIVE_PLAN });
    const applied = await apply(tenant);
    assert.equal(applied.facts.route, 'native');
    assert.equal(applied.pending.digest, null);

    for (const capability of ['lead_pipeline', 'website_form', 'booking']) {
      const res = await call('onboarding-enable', tenant, { capability });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const form = (await all('select * from public.crm_intake_forms where tenant_id = $1', [tenant.id]))[0];
    const page = (await all('select * from public.crm_booking_pages where tenant_id = $1', [tenant.id]))[0];
    assert.equal(form.status, 'draft', 'onboarding drafts; a person publishes');
    assert.equal(page.status, 'draft');
    ok(await intake.setFormStatus(deps, op, tenant.id, form.id, 'published'));
    ok(await booking.setPageStatus(deps, op, tenant.id, page.id, 'published'));
    ok(await crm.saveBusinessProfile(deps.crm, op, tenant.id, { business_hours: EVERY_DAY }));
    ok(await crm.saveService(deps.crm, op, tenant.id, { key: 'repair', name: 'Repair' }));

    const view = await read(tenant);
    for (const key of ['customer_records', 'lead_intake', 'lead_pipeline', 'website_form', 'calendar', 'booking']) {
      assert.equal(row(view, key).state, 'arc', `${key}: ${row(view, key).reason}`);
      assert.equal(row(view, key).provider, 'ARC');
    }
    assert.deepEqual(view.gaps.map((r) => r.capability), ['messaging'], 'the one gap is said, not hidden');
    assert.match(row(view, 'messaging').reason, /No channel is switched on/);
    assert.equal(step(view, 'connections').status, 'not_needed');
    assert.equal(step(view, 'mapping').status, 'not_needed');
    for (const key of ['stack', 'route', 'capabilities', 'business', 'authority', 'lead_capture', 'booking']) assert.equal(step(view, key).status, 'done', key);

    assert.equal(await count('crm_source_policies', 'tenant_id = $1', [tenant.id]), 0, 'ARC is the answer with no row at all');
    assert.equal(await count('provider_connections', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('crm_external_mappings', 'tenant_id = $1', [tenant.id]), 0);
    assert.ok(!JSON.stringify(view.matrix).match(/servicetitan|jobber|gohighlevel/i));
  });

  test('setting up an ARC piece twice makes it once, and never publishes or switches anything on', async () => {
    const tenant = await newTenant('onb-enable', ['lead_recovery']);
    await save(tenant, { plan: NATIVE_PLAN });
    const first = await call('onboarding-enable', tenant, { capability: 'booking' });
    assert.deepEqual(first.body.onboarding.enabled.made, ['appointment type', 'booking page (draft)']);
    const second = await call('onboarding-enable', tenant, { capability: 'booking' });
    assert.deepEqual(second.body.onboarding.enabled.made, []);
    assert.equal(await count('crm_appointment_types', 'tenant_id = $1', [tenant.id]), 1);
    assert.equal(await count('crm_booking_pages', 'tenant_id = $1', [tenant.id]), 1);
    assert.equal(await count('crm_booking_pages', "tenant_id = $1 and status = 'published'", [tenant.id]), 0);
    assert.deepEqual((await all('select state from public.tenant_modules where tenant_id = $1', [tenant.id])).map((m) => m.state), ['configuring']);
    assert.equal(second.body.onboarding.history.filter((e) => e.event_type === 'capability_enabled').length, 1);

    /* what ARC cannot make from a draft says so, and what the plan does not give ARC is refused. */
    const channel = await call('onboarding-enable', tenant, { capability: 'messaging' });
    assert.equal(channel.status, 409);
    assert.equal(channel.body.code, 'no_channel');
    const notArc = await call('onboarding-enable', tenant, { capability: 'accounting' });
    assert.equal(notArc.status, 422);
    assert.equal((await call('onboarding-enable', tenant, { capability: 'payroll' })).status, 422);
  });

  /* ── ARC Hybrid ── */

  test('ARC Hybrid mixes: ARC keeps customers and leads, their calendar keeps the time', async () => {
    const tenant = await newTenant('onb-hybrid');
    const planned = await save(tenant, { plan: HYBRID_PLAN });
    assert.deepEqual(planned.pending.changes.map((c) => [c.object_type, c.to.authority, c.to.connector_key]), [['appointment', 'external', 'google_calendar']]);
    assert.deepEqual(planned.pending.route, { from: null, to: 'hybrid' });

    const view = await apply(tenant);
    assert.deepEqual(await policies(tenant), [{ object_type: 'appointment', authority: 'external', connector_key: 'google_calendar' }]);
    assert.equal(view.facts.route, 'hybrid');
    assert.equal(row(view, 'customer_records').state, 'arc');
    assert.equal(row(view, 'lead_intake').state, 'arc');
    assert.equal(row(view, 'calendar').state, 'blocked', 'named, handed over, and not reachable yet');
    assert.match(row(view, 'calendar').reason, /no connection to Google Calendar yet/);
    assert.equal(row(view, 'accounting').state, 'external');
    assert.equal(row(view, 'messaging').state, 'blocked');
    assert.equal(step(view, 'connections').status, 'blocked');

    /* ARC-380 reads the same policy: ARC offers no times over a calendar it does not keep. */
    const rules = await deps.booking.rules(tenant.id);
    assert.equal(rules.authority.time_owner, 'external');
    assert.equal(rules.authority.connector_key, 'google_calendar');
    /* and ARC still keeps the customers: an ARC-side edit goes through. */
    const contact = ok(await crm.createContact(deps.crm, op, tenant.id, person(1)));
    ok(await crm.updateContact(deps.crm, op, tenant.id, contact.id, { city: 'Denver' }));
  });

  /* ── ARC Connected, and back ── */

  test('ARC Connected hands the records to their system — for the change that was read, and no other', async () => {
    const tenant = await newTenant('onb-connected');
    const first = ok(await crm.createContact(deps.crm, op, tenant.id, person(10)));
    const planned = await save(tenant, { plan: CONNECTED_PLAN });
    assert.deepEqual(planned.pending.changes.map((c) => [c.object_type, c.records, c.mapped]), [['contact', 1, 0], ['lead', 0, 0], ['appointment', 0, 0]]);
    assert.match(planned.pending.lines.join(' '), /ARC holds 1 customer record\. /);
    assert.match(planned.pending.lines.join(' '), /1 of them is not linked to a record in ServiceTitan yet/);

    /* no acknowledgement, a made-up one, and a real one that has gone stale. */
    assert.equal((await call('onboarding-authority-apply', tenant, {})).status, 422);
    const wrong = await call('onboarding-authority-apply', tenant, { acknowledged: 'a'.repeat(32) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'impact_changed');
    ok(await crm.createContact(deps.crm, op, tenant.id, person(11)));
    const stale = await call('onboarding-authority-apply', tenant, { acknowledged: planned.pending.digest });
    assert.equal(stale.body.code, 'impact_changed', 'a customer arrived since it was read');
    assert.deepEqual(await policies(tenant), [], 'nothing was applied');
    assert.equal(await count('business_profiles', 'tenant_id = $1', [tenant.id]), 0);

    const view = await apply(tenant);
    assert.deepEqual(await policies(tenant), [
      { object_type: 'appointment', authority: 'external', connector_key: 'servicetitan' },
      { object_type: 'contact', authority: 'external', connector_key: 'servicetitan' },
      { object_type: 'lead', authority: 'external', connector_key: 'servicetitan' },
    ]);
    assert.equal(view.facts.route, 'connected');
    assert.deepEqual(view.applied.changes.map((c) => c.records), [2, 0, 0], 'the counts applied are the counts acknowledged');

    /* their system is the authority: ARC's side is refused, theirs is not. */
    const mine = await crm.updateContact(deps.crm, op, tenant.id, first.id, { city: 'Boulder' });
    assert.equal(mine.ok, false);
    assert.equal(mine.code, 'external_authority');
    ok(await crm.updateContact(deps.crm, { kind: 'external', connectorKey: 'servicetitan' }, tenant.id, first.id, { city: 'Boulder' }));

    /* the working copy is still there, and what is not linked yet is counted. */
    assert.equal(await count('crm_contacts', 'tenant_id = $1', [tenant.id]), 2);
    assert.equal(row(view, 'customer_records').state, 'blocked');
    assert.match(step(view, 'mapping').detail, /2 of 2 customer records are not linked to a record in ServiceTitan/);
    ok(await crm.addMapping(deps.crm, op, tenant.id, { object_type: 'contact', object_id: first.id, connector_key: 'servicetitan', external_id: 'st-1001' }));
    assert.match(step(await read(tenant), 'mapping').detail, /1 of 2 customer records/);
  });

  test('changing route later keeps every record, mapping and line of history', async () => {
    const tenant = await newTenant('onb-switch');
    const contact = ok(await crm.createContact(deps.crm, op, tenant.id, person(20)));
    ok(await crm.createLead(deps.crm, op, tenant.id, { contact_id: contact.id, title: 'No heat', source: 'manual' }));
    ok(await crm.addNote(deps.crm, op, tenant.id, { contact_id: contact.id, body: 'Prefers mornings.' }));
    await save(tenant, { plan: CONNECTED_PLAN });
    await apply(tenant);
    ok(await crm.addMapping(deps.crm, op, tenant.id, { object_type: 'contact', object_id: contact.id, connector_key: 'servicetitan', external_id: 'st-2001' }));

    const tables = ['crm_contacts', 'crm_leads', 'crm_notes', 'crm_activities', 'crm_external_mappings', 'crm_source_events', 'tenant_onboarding_events'];
    const held = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t, 'tenant_id = $1', [tenant.id])])));
    const before = await held();
    assert.ok(before.crm_activities > 0 && before.crm_external_mappings === 1);

    /* they leave their system: the plan becomes ARC Native, and says what that does first. */
    const planned = await save(tenant, { plan: NATIVE_PLAN });
    assert.deepEqual(planned.pending.route, { from: 'connected', to: 'native' });
    assert.deepEqual(planned.pending.changes.map((c) => [c.object_type, c.from.connector_key, c.to.authority, c.mapped]), [
      ['contact', 'servicetitan', 'arc', 1], ['lead', 'servicetitan', 'arc', 0], ['appointment', 'servicetitan', 'arc', 0],
    ]);
    assert.match(planned.pending.lines.join(' '), /1 of them keeps its link to ServiceTitan as history/);
    assert.match(planned.pending.lines.join(' '), /No customer, lead, message or appointment is deleted/);
    assert.equal(row(planned, 'customer_records').state, 'blocked', 'the plan is not the fact until it is applied');
    assert.equal(planned.facts.route, 'connected');

    const view = await apply(tenant);
    assert.equal(view.facts.route, 'native');
    assert.ok((await policies(tenant)).every((p) => p.authority === 'arc' && p.connector_key === null));
    const after = await held();
    for (const table of tables.filter((t) => t !== 'tenant_onboarding_events')) assert.equal(after[table], before[table], `${table} lost or gained a row`);
    assert.equal(await count('crm_external_mappings', 'tenant_id = $1 and removed_at is null', [tenant.id]), 1, 'the link stays, as history');
    assert.ok(after.tenant_onboarding_events > before.tenant_onboarding_events);

    /* ARC is the authority again: its own edits go through, and their system's are refused. */
    ok(await crm.updateContact(deps.crm, op, tenant.id, contact.id, { city: 'Golden' }));
    const theirs = await crm.updateContact(deps.crm, { kind: 'external', connectorKey: 'servicetitan' }, tenant.id, contact.id, { city: 'Lakewood' });
    assert.equal(theirs.code, 'arc_authority');
    assert.equal(row(view, 'customer_records').state, 'arc');

    assert.deepEqual(view.history.map((e) => e.event_type).filter((t) => t !== 'plan_saved'), ['authority_changed', 'route_changed', 'authority_changed', 'route_changed']);
  });

  /* ── permission and audit ── */

  test('a change of route or authority is an operator\'s, and is in the audit log with who did it', async () => {
    const tenant = await newTenant('onb-audit');
    await save(tenant, { plan: HYBRID_PLAN });
    const current = await read(tenant);

    /* the client's own account owner, another client's, nobody, and somebody who is not an operator. */
    for (const actor of [tenant.ownerActor, { ...tenant.ownerActor, tenantId: uuid('aaaaaaaa') }, { kind: 'system' }, { kind: 'external', connectorKey: 'google_calendar' }, null]) {
      for (const run of [
        () => onboarding.applyAuthority(deps, actor, tenant.id, { acknowledged: current.pending.digest }),
        () => onboarding.saveOnboarding(deps, actor, tenant.id, { expected_revision: current.revision, plan: NATIVE_PLAN }),
        () => onboarding.enableCapability(deps, actor, tenant.id, 'website_form'),
        () => onboarding.getOnboarding(deps, actor, tenant.id),
      ]) {
        const outcome = await run();
        assert.equal(outcome.ok, false);
        assert.ok(['forbidden', 'unauthorized'].includes(outcome.code), outcome.code);
      }
    }
    const stranger = await newUser();
    assert.match(await refused(db, 'select public.onboarding_apply_authority($1, $2, $3)', [tenant.id, stranger, current.pending.digest]), /arc_onboarding:forbidden/);
    assert.match(await refused(db, 'select public.onboarding_apply_authority($1, $2, $3)', [tenant.id, tenant.owner, current.pending.digest]), /arc_onboarding:forbidden/);
    assert.match(await refused(db, 'select public.onboarding_save($1, $2, $3, null, $4::jsonb)', [tenant.id, tenant.owner, current.revision, JSON.stringify(NATIVE_PLAN)]), /arc_onboarding:forbidden/);
    assert.deepEqual(await policies(tenant), []);
    assert.equal(await count('business_profiles', 'tenant_id = $1', [tenant.id]), 0);

    await apply(tenant);
    const audit = await all(
      `select action, actor_user_id, metadata from public.admin_actions where target_type = 'tenant' and target_id = $1 order by occurred_at, action`,
      [tenant.id],
    );
    const actions = audit.map((a) => a.action);
    for (const action of ['onboarding.plan_saved', 'onboarding.route_changed', 'onboarding.authority_changed', 'crm.route.recorded', 'crm.source_policy.set']) {
      assert.ok(actions.includes(action), `${action} is in the audit log`);
    }
    assert.ok(audit.filter((a) => a.action.startsWith('onboarding.')).every((a) => a.actor_user_id === operator));
    const changed = audit.find((a) => a.action === 'onboarding.authority_changed');
    assert.deepEqual(changed.metadata.changes.map((c) => [c.object_type, c.to.connector_key, c.records]), [['appointment', 'google_calendar', 0]]);

    /* and the history cannot be rewritten or thinned. */
    assert.match(await refused(db, `update public.tenant_onboarding_events set detail = '{}'::jsonb where tenant_id = $1`, [tenant.id]), /arc_onboarding:immutable/);
    assert.match(await refused(db, 'delete from public.tenant_onboarding_events where tenant_id = $1', [tenant.id]), /arc_onboarding:immutable/);
  });

  test('applying when nothing is pending is refused, and so is anything for an archived client', async () => {
    const tenant = await newTenant('onb-idle');
    assert.equal((await call('onboarding-authority-apply', tenant, { acknowledged: 'b'.repeat(32) })).body.code, 'nothing_to_apply');
    await save(tenant, { plan: NATIVE_PLAN });
    const applied = await apply(tenant);
    assert.equal(applied.pending.digest, null);
    assert.equal((await call('onboarding-authority-apply', tenant, { acknowledged: 'b'.repeat(32) })).body.code, 'nothing_to_apply');

    await db.query(`update public.tenants set status = 'archived' where id = $1`, [tenant.id]);
    const current = await read(tenant);
    const saved = await call('onboarding-save', tenant, { expected_revision: current.revision, plan: HYBRID_PLAN });
    assert.equal(saved.status, 409);
    assert.equal(saved.body.code, 'tenant_inactive');
    assert.equal((await call('onboarding-enable', tenant, { capability: 'website_form' })).body.code, 'tenant_inactive');
    assert.equal(current.plan.route, 'native', 'what was decided can still be read');
  });

  /* ── resuming ── */

  test('onboarding resumes from what is stored: a second operator\'s page reads the same, and a stale one cannot overwrite', async () => {
    const tenant = await newTenant('onb-resume');
    const one = await save(tenant, { answers: NATIVE_ANSWERS });
    const two = await save(tenant, { plan: NATIVE_PLAN });
    assert.equal(two.revision, one.revision + 1);

    /* another process, another store over the same database. */
    const later = restClient(db);
    const elsewhere = { ...deps, onboarding: supabaseOnboardingStore(later), crm: supabaseCrmStore(later), intake: supabaseIntakeStore(later), booking: supabaseBookingStore(later) };
    const resumed = ok(await onboarding.getOnboarding(elsewhere, op, tenant.id));
    assert.deepEqual(resumed.answers, two.answers);
    assert.deepEqual(resumed.plan, two.plan);
    assert.deepEqual(resumed.steps, two.steps);
    assert.deepEqual(resumed.matrix, two.matrix);

    /* the page drawn before the plan was saved tries to save its own. */
    const stale = await call('onboarding-save', tenant, { expected_revision: one.revision, plan: HYBRID_PLAN });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale');
    assert.equal((await read(tenant)).plan.route, 'native');
    assert.equal((await call('onboarding-save', tenant, { plan: HYBRID_PLAN })).status, 422, 'a save says what it read');

    /* saving what is already there is not a change, and not an event. */
    const again = await call('onboarding-save', tenant, { expected_revision: two.revision, plan: NATIVE_PLAN, answers: NATIVE_ANSWERS });
    assert.equal(again.status, 200);
    assert.equal(again.body.onboarding.revision, two.revision);
    assert.equal(again.body.onboarding.history.length, two.history.length);

    /* a step done elsewhere — the hours, on the business profile — is done here on the next read. */
    assert.equal(step(two, 'business').status, 'todo');
    ok(await crm.saveBusinessProfile(deps.crm, op, tenant.id, { business_hours: EVERY_DAY }));
    ok(await crm.saveService(deps.crm, op, tenant.id, { key: 'tune_up', name: 'Tune-up' }));
    assert.equal(step(await read(tenant), 'business').status, 'done');
  });

  test('every problem with a save comes back at once, by field, and nothing is written', async () => {
    const tenant = await newTenant('onb-invalid');
    const res = await call('onboarding-save', tenant, {
      expected_revision: 0,
      answers: { discovery: { crm: 'sometimes' } },
      plan: { route: 'native', capabilities: { customer_records: kept('jobber'), accounting: arc } },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.field_errors.map((e) => e.field).sort(), [
      'answers.discovery.crm', 'plan.capabilities.accounting.source', 'plan.capabilities.customer_records.source',
    ]);
    assert.equal(await count('tenant_onboarding', 'tenant_id = $1', [tenant.id]), 0);
  });

  test('0028 refuses a plan the model would refuse, whichever path writes the row', async () => {
    const tenant = await newTenant('onb-guard');
    const write = (plan) => refused(db, 'select public.onboarding_save($1, $2, 0, null, $3::jsonb)', [tenant.id, operator, JSON.stringify(plan)]);
    assert.match(await write({ route: 'native', capabilities: { customer_records: kept('jobber') } }), /arc_onboarding:invalid: ARC Native keeps every record in ARC/);
    assert.match(await write({ route: 'sideways', capabilities: {} }), /a route is native, hybrid or connected/);
    assert.match(await write({ route: 'hybrid', capabilities: { payroll: arc } }), /"payroll" is not a capability/);
    assert.match(await write({ route: 'hybrid', capabilities: { calendar: kept('not_a_connector') } }), /is not a connector ARC has/);
    assert.match(await write({ route: 'hybrid', capabilities: { calendar: { source: 'arc', connector_key: 'google_calendar' } } }), /names another system/);
    assert.match(await write({ route: 'hybrid', capabilities: {}, activate: true }), /nothing else/);
    const secret = ['api', 'key=', 'abcdef1234567890'].join('_').replace('_=', '=').replace('=_', '=');
    assert.match(await refused(db, 'select public.onboarding_save($1, $2, 0, $3::jsonb, null)', [tenant.id, operator, JSON.stringify({ note: secret })]), /check/i);
    /* a direct write, around the function: the row's own guard decides. */
    assert.match(
      await refused(db, `insert into public.tenant_onboarding (tenant_id, plan, updated_by) values ($1, $2::jsonb, $3)`, [tenant.id, JSON.stringify({ route: 'native', capabilities: { calendar: kept('google_calendar') } }), operator]),
      /arc_onboarding:invalid/,
    );
    assert.match(
      await refused(db, `insert into public.tenant_onboarding (tenant_id, plan, updated_by) values ($1, $2::jsonb, $3)`, [tenant.id, JSON.stringify(NATIVE_PLAN), tenant.owner]),
      /arc_onboarding:forbidden/,
    );
    assert.equal(await count('tenant_onboarding', 'tenant_id = $1', [tenant.id]), 0);
  });

  /* ── one client at a time ── */

  test('what is set up, counted and read for one client never reaches another', async () => {
    const a = await newTenant('onb-iso-a');
    const b = await newTenant('onb-iso-b');
    await save(a, { answers: NATIVE_ANSWERS, plan: NATIVE_PLAN });
    await apply(a);
    for (const capability of ['lead_pipeline', 'website_form', 'booking']) assert.equal((await call('onboarding-enable', a, { capability })).status, 200);
    ok(await crm.createContact(deps.crm, op, a.id, person(30)));
    ok(await crm.saveBusinessProfile(deps.crm, op, a.id, { business_hours: EVERY_DAY }));
    /* a file a's operator previews for a: it is a's import, and b's count of imports is still none. */
    ok(await intake.previewImport(deps, op, a.id, { file_name: 'customers.csv', csv: 'name,phone\nPat Jones,6145553031\n', mapping: { name: 'name', phone: 'phone' } }));

    for (const table of ['crm_pipelines', 'crm_intake_forms', 'crm_appointment_types', 'crm_booking_pages', 'crm_contacts', 'crm_imports', 'business_profiles', 'tenant_onboarding', 'tenant_onboarding_events']) {
      assert.ok(await count(table, 'tenant_id = $1', [a.id]) > 0, `${table} for a`);
      assert.equal(await count(table, 'tenant_id = $1', [b.id]), 0, `${table} for b`);
    }
    const other = await read(b);
    assert.equal(other.revision, 0);
    assert.deepEqual(other.facts.forms, { total: 0, published: 0 });
    assert.equal(other.facts.records.contact.total, 0);
    assert.equal(other.facts.pipeline, false);
    assert.equal(other.facts.route, null);
    assert.deepEqual(other.history, []);
    assert.equal((await read(a)).facts.records.contact.total, 1);

    /* a's account owner is not an operator, and b's is not a's. */
    for (const actor of [a.ownerActor, b.ownerActor]) {
      assert.equal((await onboarding.getOnboarding(deps, actor, a.id)).ok, false);
      assert.equal((await onboarding.enableCapability(deps, actor, a.id, 'website_form')).ok, false);
    }
    assert.equal(await count('crm_intake_forms', 'tenant_id = $1', [a.id]), 1);
  });

  test('a browser reads the working record only as an operator, and writes it as nobody', async () => {
    const tenant = await newTenant('onb-rls');
    await save(tenant, { plan: NATIVE_PLAN });
    await asRole(db, { role: 'authenticated', sub: tenant.owner }, async (tx) => {
      assert.equal((await tx.query('select count(*)::int as n from public.tenant_onboarding')).rows[0].n, 0, 'a member reads none of it');
      assert.equal((await tx.query('select count(*)::int as n from public.tenant_onboarding_events')).rows[0].n, 0);
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      assert.ok((await tx.query('select count(*)::int as n from public.tenant_onboarding')).rows[0].n >= 1);
    });
    for (const role of ['authenticated', 'anon']) {
      for (const sql of [
        `update public.tenant_onboarding set answers = '{}'::jsonb`,
        `insert into public.tenant_onboarding_events (tenant_id, event_type, actor_user_id, revision) values ('${tenant.id}', 'plan_saved', '${operator}', 1)`,
        `select public.onboarding_apply_authority('${tenant.id}', '${operator}', 'x')`,
        `select public.onboarding_facts('${tenant.id}')`,
      ]) {
        await assert.rejects(asRole(db, { role, sub: operator }, (tx) => tx.query(sql)), /permission denied/, `${role}: ${sql.slice(0, 40)}`);
      }
    }
    await assert.rejects(asRole(db, { role: 'anon' }, (tx) => tx.query('select * from public.tenant_onboarding')), /permission denied/);
  });

  test('onboarding is setup: a client that was only ever planned can still be deleted as a test client', async () => {
    const tenant = await newTenant('onb-purge');
    await save(tenant, { answers: NATIVE_ANSWERS, plan: NATIVE_PLAN });
    await apply(tenant);
    assert.ok(await count('tenant_onboarding_events', 'tenant_id = $1', [tenant.id]) >= 3);
    await db.query('delete from public.tenant_members where tenant_id = $1', [tenant.id]);
    const client = restClient(db);
    const res = await handleTenantAction('tenant-purge', {
      store: supabaseStore(client), tenants: supabaseTenantStore(client), body: { tenant_id: tenant.id, confirm_slug: tenant.slug }, actorId: operator,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await count('tenant_onboarding', 'tenant_id = $1', [tenant.id]), 0);
    assert.equal(await count('tenant_onboarding_events', 'tenant_id = $1', [tenant.id]), 0);
  });
});
