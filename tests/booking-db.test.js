/* ARC-380 — scheduling, availability and booking, against real Postgres.
 *
 * Two parts, as for 0023–0026:
 *
 *   1. The text of 0027, always: RLS and a read policy on every table and no write policy, the
 *      link table readable by no browser role at all, nothing granted to a browser role, and
 *      its vocabularies and transitions the model's.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the real
 *      public handler, the real service and the real action table over the real stores — so
 *      what a stranger's browser posts, and what a person in the workspace presses, is what
 *      0027 receives.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 *
 * The clock is the real one: 0027 reads `now()` for the notice a booking needs, so every time
 * here is a day or more ahead, written in the business's own timezone.
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
import * as crm from '../supabase/functions/_shared/crm/service.ts';
import * as intake from '../supabase/functions/_shared/intake/service.ts';
import * as workspace from '../supabase/functions/_shared/crm/workspace.ts';
import * as booking from '../supabase/functions/_shared/booking/service.ts';
import { createPublicBooking, PUBLIC_LIMITS, windowLimiter } from '../supabase/functions/_shared/booking/public.ts';
import { ACTIVITY_TYPES, OBJECT_TYPES } from '../supabase/functions/_shared/crm/model.ts';
import { inboxStates } from '../supabase/functions/_shared/crm/inbox.ts';
import { instantFor } from '../supabase/functions/_shared/engine/hours.ts';
import {
  addDays, APPOINTMENT_EVENT_TYPES, APPOINTMENT_SOURCES, APPOINTMENT_STATUSES, APPOINTMENT_TRANSITIONS, BOOKING_ACTIVITY_TYPES, CHANGE_DOORS,
  DEFAULT_SETTINGS, defaultPageDefinition, HOURS_SOURCES, localDate, PAGE_STATUSES, SLOT_STEPS, SYNC_STATES,
} from '../supabase/functions/_shared/booking/model.ts';
import { handleWorkspaceAction, WORKSPACE_ACTIONS } from '../supabase/functions/_shared/crm/actions.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0027_crm_booking.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');
const functionBody = (name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$;`).exec(CODE)?.[0] ?? '';

/* ══ 1. the file ══════════════════════════════════════════ */

function checkList(table, column) {
  const body = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(CODE)?.[1] ?? '';
  const match = new RegExp(`\\n\\s+${column}\\s[^\\n]*?in \\(([^)]*)\\)`).exec(body) ?? new RegExp(`\\n\\s+${column}\\s[\\s\\S]*?in \\(([^)]*)\\)`).exec(body);
  assert.ok(match, `${table}.${column} has a check list`);
  return [...match[1].matchAll(/'([^']+)'|\b(\d+)\b/g)].map((m) => m[1] ?? Number(m[2]));
}
const widened = (constraint) => {
  const match = new RegExp(`add constraint ${constraint}\\s+check \\(\\w+ in \\(([\\s\\S]*?)\\)\\);`).exec(CODE);
  assert.ok(match, `${constraint} is re-created`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe('0027 as written', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);

  test('every table has RLS, a read policy and no write policy; the link table is read by no browser role at all', () => {
    assert.deepEqual([...tables].sort(), [...booking.BOOKING_TABLES].sort());
    const listed = /foreach t in array array\[([\s\S]*?)\] loop/.exec(CODE)[1];
    for (const table of tables.filter((t) => t !== 'crm_appointment_links')) assert.match(listed, new RegExp(`'${table}'`), `${table} is in the RLS loop`);
    assert.doesNotMatch(listed, /crm_appointment_links/);
    assert.match(CODE, /alter table public\.crm_appointment_links enable row level security/);
    assert.match(CODE, /revoke all on public\.crm_appointment_links from anon, authenticated/);
    assert.doesNotMatch(CODE, /create policy [^;]*for (insert|update|delete|all)\b/i);
    assert.equal([...CODE.matchAll(/create policy/g)].length, 1, 'only the loop\'s read policy');
  });

  test('no function here is executable by a browser role, and none is security definer', () => {
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
    const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(functions.length >= 15);
    for (const fn of new Set(functions)) {
      assert.match(CODE, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), `${fn} is revoked`);
    }
    assert.doesNotMatch(CODE, /security definer/i);
  });

  test('the vocabularies are the model\'s', () => {
    assert.deepEqual(checkList('crm_appointments', 'status'), [...APPOINTMENT_STATUSES]);
    assert.deepEqual(checkList('crm_appointments', 'source'), [...APPOINTMENT_SOURCES]);
    assert.deepEqual(checkList('crm_appointments', 'sync_state'), [...SYNC_STATES]);
    assert.deepEqual(checkList('crm_appointments', 'changed_via'), [...CHANGE_DOORS]);
    assert.deepEqual(checkList('crm_appointment_events', 'event_type'), [...APPOINTMENT_EVENT_TYPES]);
    assert.deepEqual(checkList('crm_booking_pages', 'status'), [...PAGE_STATUSES]);
    assert.deepEqual(checkList('crm_booking_settings', 'hours_source'), [...HOURS_SOURCES]);
    assert.deepEqual(checkList('crm_booking_settings', 'slot_step_minutes'), [...SLOT_STEPS]);
    /* the three lists 0027 widens are 0023's plus exactly what the model adds. */
    assert.deepEqual(widened('crm_activities_activity_type_check'), [...ACTIVITY_TYPES, ...BOOKING_ACTIVITY_TYPES]);
    assert.deepEqual(widened('crm_external_mappings_object_type_check'), [...OBJECT_TYPES]);
    assert.deepEqual(widened('crm_source_policies_object_type_check'), [...OBJECT_TYPES]);
    assert.ok(OBJECT_TYPES.includes('appointment'));
  });

  test('the changes of status the guard allows a person are the model\'s list', () => {
    const guard = functionBody('crm_appointments_guard');
    const found = [];
    for (const [, from, list] of guard.matchAll(/old\.status = '(\w+)' and new\.status in \(([^)]*)\)/g)) {
      for (const [, to] of list.matchAll(/'(\w+)'/g)) found.push([from, to]);
    }
    for (const [, from, to] of guard.matchAll(/old\.status = '(\w+)' and new\.status = '(\w+)' and new\.starts_at <> old\.starts_at/g)) found.push([from, to]);
    assert.deepEqual(found.map((t) => t.join('>')).sort(), APPOINTMENT_TRANSITIONS.map((t) => t.join('>')).sort());
  });

  test('a time is given under the client\'s lock, and by the row\'s own guard — so no path around a function skips it', () => {
    const guard = functionBody('crm_appointments_guard');
    const lock = guard.indexOf('perform public.crm_booking_lock(new.tenant_id)');
    const count = guard.indexOf('select count(*) into v_overlaps');
    assert.ok(lock > 0 && count > lock, 'the lock is taken before the overlap is counted');
    assert.match(guard, /raise exception 'arc_crm:slot_taken:/);
    assert.match(functionBody('crm_booking_lock'), /pg_advisory_xact_lock\(hashtextextended\('arc_crm_booking:' \|\| p_tenant::text, 0\)\)/);
    for (const fn of ['crm_book_appointment', 'crm_appointment_change', 'crm_appointment_external_report', 'crm_appointment_reconcile']) {
      assert.match(functionBody(fn), /perform public\.crm_booking_lock\(p_tenant\)/, fn);
    }
  });

  test('a booking is not evidence, sends nothing and starts nothing; a link is kept only as its hash', () => {
    for (const fn of ['crm_book_appointment', 'crm_appointment_change', 'crm_appointment_external_report', 'crm_appointment_reconcile', 'crm_appointments_history']) {
      assert.doesNotMatch(functionBody(fn), /public\.(events|leads|automation_runs|scheduled_actions|suppressions|crm_messages|messages)\b/, fn);
    }
    const links = /create table if not exists public\.crm_appointment_links \(([\s\S]*?)\n\);/.exec(CODE)[1];
    assert.match(links, /token_hash\s+text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    const columns = [...CODE.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|jsonb|timestamptz|boolean|integer|bigint)\b/gm)].map((m) => m[1]);
    for (const column of columns.filter((c) => c !== 'token_hash')) assert.doesNotMatch(column, /token|secret|password|credential|api_key/, column);
    /* a stranger's booking goes through 0024's own arrival: it never edits a customer. */
    assert.match(functionBody('crm_book_appointment'), /public\.crm_intake_arrival\(p_tenant/);
    assert.doesNotMatch(functionBody('crm_book_appointment'), /update public\.crm_contacts/);
  });

  test('forward-only: nothing is dropped but triggers, read policies and the three check constraints it widens', () => {
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), drops.join(', '));
    const constraints = [...CODE.matchAll(/drop constraint if exists (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(constraints.sort(), ['crm_activities_activity_type_check', 'crm_external_mappings_object_type_check', 'crm_source_policies_object_type_check']);
    assert.doesNotMatch(CODE, /\btruncate table\b|\bdrop table\b|\bdrop column\b/i);
  });

  test('both doors run the booking actions from one table, and neither takes a calendar report from a person', () => {
    for (const name of ['crm-booking', 'crm-booking-record', 'crm-booking-slots', 'crm-appointment-book', 'crm-appointment-change', 'crm-appointment-reconcile', 'crm-booking-settings-save', 'crm-appointment-type-save', 'crm-booking-page-save', 'crm-booking-page-status']) {
      assert.ok(WORKSPACE_ACTIONS.includes(name), name);
    }
    assert.ok(!WORKSPACE_ACTIONS.some((name) => /report|sync/.test(name)), 'a calendar reports through its connector, never through a signed-in person');
    for (const door of ['crm', 'ops']) {
      const source = readFileSync(new URL(`../supabase/functions/${door}/index.ts`, import.meta.url), 'utf8');
      assert.match(source, /booking: supabaseBookingStore\(db\)/, door);
      assert.match(source, /0027_crm_booking\.sql/, door);
    }
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
const SITE = 'https://arcautomation.site';
const EVERY_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ open: '08:00', close: '17:00' }]]));
/** `days` from today in the business's own calendar, at a wall-clock time there. */
const dayAhead = (days) => addDays(localDate(new Date(), TZ), days);
const at = (days, time) => instantFor(dayAhead(days), time, TZ).toISOString();
const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(String(value)));

describe('booking on real SQL', { skip }, () => {
  let db;
  let deps;
  let wdeps;
  let handle;
  let operator;
  let op;
  let acme;
  let other;
  let request = 0;

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
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  async function newTenant(slug) {
    const client = restClient(db);
    const res = await handleTenantAction('tenant-create', {
      store: supabaseStore(client),
      tenants: supabaseTenantStore(client),
      body: { tenant: { name: `Co ${slug}`, slug, timezone: TZ, status: 'onboarding' }, modules: [], idempotency_key: `booking-test-${slug}` },
      actorId: operator,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.tenant.id;
    const owner = await newUser();
    const staff = await newUser();
    await db.query(`insert into tenant_members (user_id, tenant_id, role) values ($1, $3, 'owner'), ($2, $3, 'staff')`, [owner, staff, id]);
    const tenant = {
      id, owner, staff,
      ownerActor: { kind: 'client_user', userId: owner, tenantId: id, role: 'owner' },
      staffActor: { kind: 'client_user', userId: staff, tenantId: id, role: 'staff' },
    };
    ok(await crm.saveBusinessProfile(deps.crm, op, id, { business_hours: EVERY_DAY }));
    tenant.visit = ok(await booking.saveAppointmentType(deps, tenant.ownerActor, id, { key: 'visit', name: 'Site visit', duration_minutes: 60 }));
    tenant.quick = ok(await booking.saveAppointmentType(deps, tenant.ownerActor, id, { key: 'tune_up', name: 'Tune-up', duration_minutes: 30, requires_approval: false }));
    const page = ok(await booking.saveBookingPage(deps, tenant.ownerActor, id, { name: 'Website booking', definition: defaultPageDefinition('Book a visit') }));
    tenant.page = ok(await booking.setPageStatus(deps, tenant.ownerActor, id, page.id, 'published'));
    return tenant;
  }

  const post = (route, body) => handle({ method: 'POST', route, query: {}, origin: SITE, ip: `10.0.${Math.floor((request += 1) / 250)}.${request % 250}`, body });
  const get = (route, query) => handle({ method: 'GET', route, query, origin: SITE, ip: '10.9.9.9', body: undefined });
  const person = (n) => ({ name: `Customer ${n}`, phone: `+1614555${String(1000 + n)}`, email: `customer${n}@example.com` });
  const submission = () => `submission-${String(counter += 1).padStart(12, '0')}`;
  /** one booking through the public door, as the hosted page posts it. */
  const bookVia = (tenant, values, extra = {}) => post('/book', { key: tenant.page.public_key, values, submission_id: submission(), ...extra });
  /** what a client user's request through the `crm` function does, minus HTTP. */
  const asClient = (actor, action, body) => handleWorkspaceAction(action, { deps: wdeps, actor, body: { tenant_id: actor.tenantId, ...body } });
  const appointmentAt = async (tenant, startsAt) => one('select * from public.crm_appointments where tenant_id = $1 and starts_at = $2 order by created_at desc limit 1', [tenant.id, startsAt]);

  before(async () => {
    db = await freshDatabase();
    operator = await newUser();
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    op = { kind: 'operator', userId: operator };
    const client = restClient(db);
    deps = { crm: supabaseCrmStore(client), booking: supabaseBookingStore(client) };
    wdeps = { ...deps, intake: supabaseIntakeStore(client) };
    handle = createPublicBooking({ deps, allowedOrigins: [SITE], limiter: { over: () => false } });
    acme = await newTenant('book-acme');
    other = await newTenant('book-other');
  });

  /* ── the rules ── */

  test('a client with no settings gets the model\'s defaults, its profile\'s hours, its own timezone, and ARC as the calendar', async () => {
    const rules = await deps.booking.rules(acme.id);
    const { timezone, hours, authority, ...settings } = rules;
    assert.deepEqual(settings, { ...DEFAULT_SETTINGS });
    assert.equal(timezone, TZ);
    assert.deepEqual(hours, EVERY_DAY);
    assert.deepEqual(authority, { authority: 'arc', connector_key: null, time_owner: 'arc', status_owner: 'arc' });
    assert.equal(await count('crm_booking_settings', 'tenant_id = $1', [acme.id]), 0);
    assert.equal(await deps.booking.rules(uuid('aaaaaaaa')), null);
  });

  test('the account owner or an operator sets the rules, types and pages; staff and other clients do not', async () => {
    for (const [action, body] of [
      ['crm-booking-settings-save', { settings: { capacity: 2 } }],
      ['crm-appointment-type-save', { type: { key: 'x_visit', name: 'X', duration_minutes: 30 } }],
      ['crm-booking-page-save', { page: { name: 'P', definition: defaultPageDefinition('P') } }],
      ['crm-booking-page-status', { id: acme.page.id, status: 'archived' }],
    ]) {
      assert.equal((await asClient(acme.staffActor, action, body)).status, 403, `${action} as staff`);
      assert.equal((await handleWorkspaceAction(action, { deps: wdeps, actor: other.ownerActor, body: { tenant_id: acme.id, ...body } })).status, 403, `${action} as another client`);
    }
    const saved = await asClient(acme.ownerActor, 'crm-booking-settings-save', { settings: { min_lead_minutes: 60, closed_dates: [dayAhead(20)] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.rules.min_lead_minutes, 60);
    assert.equal(saved.body.rules.slot_step_minutes, 30, 'what was not sent keeps its default');
    const again = ok(await booking.saveSettings(deps, op, acme.id, { min_lead_minutes: 120 }));
    assert.deepEqual(again.closed_dates, [dayAhead(20)], 'a second save changes only what it names');
    assert.equal((await asClient(acme.ownerActor, 'crm-booking-settings-save', { settings: { slot_step_minutes: 7, capacity: 0, nonsense: true } })).status, 422);

    /* a type keeps its key; a page keeps its link, and is published on purpose. */
    assert.equal((await booking.saveAppointmentType(deps, acme.ownerActor, acme.id, { key: 'visit', name: 'Again', duration_minutes: 30 })).code, 'key_taken');
    assert.equal((await booking.saveAppointmentType(deps, acme.ownerActor, acme.id, { key: 'renamed' }, acme.visit.id)).code, 'invalid');
    assert.match(await refused(db, `update crm_appointment_types set key = 'other' where id = $1`, [acme.visit.id]), /arc_crm:immutable/);
    assert.match(acme.page.public_key, /^arcb_[a-z0-9]{32}$/);
    assert.match(await refused(db, `update crm_booking_pages set public_key = 'arcb_' || repeat('a', 32) where id = $1`, [acme.page.id]), /arc_crm:immutable/);
    const draft = ok(await booking.saveBookingPage(deps, acme.ownerActor, acme.id, { name: 'Draft page', definition: defaultPageDefinition('Draft') }));
    assert.equal(draft.status, 'draft');
    assert.equal((await get('/page', { key: draft.public_key })).status, 404, 'a draft is the same 404 as a key that was never issued');
    assert.equal((await get('/page', { key: `arcb_${'z'.repeat(32)}` })).status, 404);
  });

  /* ── availability ── */

  test('the times offered are inside opening hours in the business\'s own timezone, far enough ahead, and not on a closed day', async () => {
    const read = async (query) => (await get('/slots', { key: acme.page.public_key, ...query })).body.availability;
    const day = await read({ type: 'visit', from: dayAhead(3), days: '1' });
    assert.equal(day.mode, 'slots');
    assert.equal(day.timezone, TZ);
    /* 08:00–17:00, an hour long, every half hour: 08:00 … 16:00. */
    assert.equal(day.slots.length, 17);
    assert.equal(day.slots[0].starts_at, at(3, '08:00'));
    assert.equal(day.slots.at(-1).starts_at, at(3, '16:00'));
    assert.equal(day.slots.at(-1).ends_at, at(3, '17:00'));
    /* half an hour long: 08:00 … 16:30. */
    assert.equal((await read({ type: 'tune_up', from: dayAhead(3), days: '1' })).slots.length, 18);
    /* today: nothing sooner than the notice a booking needs. */
    const today = await read({ type: 'visit', from: dayAhead(0), days: '1' });
    assert.ok(today.slots.every((s) => Date.parse(s.starts_at) >= Date.now() + 119 * 60_000));
    /* the day the owner closed. */
    assert.equal((await read({ type: 'visit', from: dayAhead(20), days: '1' })).slots.length, 0);
    /* past the horizon. */
    assert.equal((await read({ type: 'visit', from: dayAhead(40), days: '1' })).slots.length, 0);
    assert.equal((await get('/slots', { key: acme.page.public_key, type: 'no_such_type' })).status, 404);
  });

  /* ── a stranger books ── */

  test('a hosted booking makes the appointment, the customer, the lead, the consent evidence and the history — in one go', async () => {
    const page = await get('/page', { key: acme.page.public_key });
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.page.types.map((t) => t.key), ['visit', 'tune_up']);
    assert.equal(page.body.page.business, 'Co book-acme');
    assert.ok(!JSON.stringify(page.body).includes(acme.id), 'the page is never given the client\'s id');

    const startsAt = at(4, '10:00');
    const res = await bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(1), address: '12 Elm St', postal_code: '80202', note: 'Gate code is on the fence', consent_sms: true }, {
      attribution: { page: 'https://arcautomation.site/book/x?utm_source=google&gclid=abc', referrer: 'https://www.google.com/search?q=plumber' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.booking).sort(), ['ends_at', 'manage_token', 'starts_at', 'status', 'timezone', 'title']);
    assert.equal(res.body.booking.status, 'requested', 'this type waits for the business to confirm');
    assert.equal(res.body.booking.starts_at, startsAt);
    assert.match(res.body.booking.manage_token, /^arcm_[a-z0-9]{40}$/);
    assert.doesNotMatch(JSON.stringify(res.body), /lead|contact|tenant|[0-9a-f]{8}-[0-9a-f]{4}-/, 'a stranger is told their time and nothing about the records');

    const a = await appointmentAt(acme, startsAt);
    assert.equal(a.status, 'requested');
    assert.equal(a.source, 'booking_page');
    assert.equal(a.title, 'Site visit');
    assert.equal(a.timezone, TZ);
    assert.equal(a.booking_page_id, acme.page.id);
    assert.equal(a.requires_approval, true);
    assert.equal(a.customer_note, 'Gate code is on the fence');
    assert.equal(a.postal_code, '80202');
    assert.equal(ms(a.ends_at) - ms(a.starts_at), 3_600_000);

    const contact = await one('select * from crm_contacts where id = $1', [a.contact_id]);
    assert.deepEqual([contact.display_name, contact.phone, contact.email], ['Customer 1', '+16145551001', 'customer1@example.com']);
    const lead = await one('select * from crm_leads where id = $1', [a.lead_id]);
    assert.deepEqual([lead.source, lead.title, lead.status, lead.contact_id], ['web_form', 'Site visit', 'open', contact.id]);
    const source = await one('select * from crm_source_events where id = $1', [a.source_event_id]);
    assert.equal(source.detail.booking_page.name, 'Website booking');
    assert.equal(source.detail.claimed.utm_source, 'google');
    assert.deepEqual(source.detail.claimed.click_ids, ['gclid']);
    assert.doesNotMatch(JSON.stringify(source.detail), /abc|search\?q/, 'the click id and the query are not kept');
    const consent = await one('select * from crm_consent_records where source_event_id = $1', [source.id]);
    assert.deepEqual([consent.channel, consent.address, consent.granted], ['sms', '+16145551001', true]);

    /* the lead's own timeline says it, and the appointment's history holds the time. */
    const activity = (await db.query('select activity_type, actor_type from crm_activities where lead_id = $1 order by occurred_at, activity_type', [lead.id])).rows;
    assert.deepEqual(activity.map((r) => r.activity_type).sort(), ['appointment_requested', 'lead_created']);
    assert.ok(activity.every((r) => r.actor_type === 'system'));
    const event = await one('select * from crm_appointment_events where appointment_id = $1', [a.id]);
    assert.deepEqual([event.event_type, event.actor_type, event.detail.via], ['requested', 'system', 'booking_page']);

    /* a booking is not evidence, sends nothing and starts nothing. */
    for (const table of ['events', 'leads', 'automation_runs', 'scheduled_actions', 'crm_messages']) {
      assert.equal(await count(table, 'tenant_id = $1', [acme.id]), 0, table);
    }
  });

  test('a type that needs no approval is confirmed at once; a retried request is the same booking, with a link that works', async () => {
    const startsAt = at(4, '14:00');
    const body = { key: acme.page.public_key, values: { type: 'tune_up', starts_at: startsAt, ...person(2) }, submission_id: submission() };
    const first = await post('/book', body);
    assert.equal(first.body.booking.status, 'confirmed');
    const again = await post('/book', body);
    assert.equal(again.status, 200);
    assert.equal(await count('crm_appointments', 'tenant_id = $1 and starts_at = $2', [acme.id, startsAt]), 1);
    assert.equal(await count('crm_leads', `tenant_id = $1 and contact_id = (select id from crm_contacts where phone = '+16145551002')`, [acme.id]), 1);
    /* each response holds its own link, and both open the same appointment. */
    assert.notEqual(first.body.booking.manage_token, again.body.booking.manage_token);
    for (const token of [first.body.booking.manage_token, again.body.booking.manage_token]) {
      const view = await post('/manage', { key: acme.page.public_key, token });
      assert.equal(view.status, 200);
      assert.equal(view.body.appointment.appointment.starts_at, startsAt);
    }
    /* somebody already on file books again within the day: the same customer, the same open lead. */
    const second = await bookVia(acme, { type: 'tune_up', starts_at: at(5, '09:00'), ...person(2) });
    assert.equal(second.status, 200);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145551002'`, [acme.id]), 1);
    assert.equal(await count('crm_leads', `tenant_id = $1 and contact_id = (select id from crm_contacts where phone = '+16145551002')`, [acme.id]), 1);
    assert.equal(await count('crm_appointments', `tenant_id = $1 and contact_id = (select id from crm_contacts where phone = '+16145551002')`, [acme.id]), 2);
  });

  test('a time that cannot be offered is refused: outside hours, off the grid, too soon, closed, or already taken', async () => {
    const taken = at(6, '10:00');
    assert.equal((await bookVia(acme, { type: 'visit', starts_at: taken, ...person(3) })).status, 200);
    const before_ = await count('crm_appointments', 'tenant_id = $1', [acme.id]);
    for (const [why, startsAt] of [
      ['after closing', at(6, '18:00')],
      ['runs past closing', at(6, '16:30')],
      ['off the half-hour grid', at(6, '13:10')],
      ['too soon', new Date(Date.now() + 20 * 60_000).toISOString()],
      ['in the past', new Date(Date.now() - 86_400_000).toISOString()],
      ['the closed day', at(20, '10:00')],
      ['past the horizon', at(45, '10:00')],
      ['already taken', taken],
      ['overlaps the one taken', at(6, '10:30')],
    ]) {
      const res = await bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(4) });
      assert.equal(res.status, 409, `${why}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'slot_unavailable', why);
    }
    assert.equal(await count('crm_appointments', 'tenant_id = $1', [acme.id]), before_, 'a refused booking writes nothing');
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145551004'`, [acme.id]), 0, 'not even the customer');

    /* the database says the same thing to a caller that skipped the service. */
    const direct = (startsAt) => deps.booking.book(acme.id, { actor_type: 'system', booking_page_id: acme.page.id, appointment_type_id: acme.visit.id, starts_at: startsAt, contact: { display_name: 'Direct', phone: '+16145551999' }, lead: { title: 'Direct' } });
    await assert.rejects(direct(at(6, '18:00')), (e) => e.code === 'slot_unavailable' && /outside opening hours/.test(e.message));
    await assert.rejects(direct(at(20, '10:00')), (e) => e.code === 'slot_unavailable' && /closed that day/.test(e.message));
    await assert.rejects(direct(taken), (e) => e.code === 'slot_taken');
    /* and the row's own guard says it to a plain insert. */
    const a = await appointmentAt(acme, taken);
    assert.match(await refused(db, `insert into crm_appointments (tenant_id, contact_id, title, status, starts_at, ends_at, busy_from, busy_until, timezone, source, updated_by_type)
      values ($1, $2, 'Sneak', 'confirmed', $3, $3::timestamptz + interval '1 hour', $3, $3::timestamptz + interval '1 hour', $4, 'staff', 'system')`, [acme.id, a.contact_id, taken, TZ]), /arc_crm:slot_taken/);
  });

  test('two people choosing the same time at once are one booking and one refusal; capacity is how many may overlap', async () => {
    const startsAt = at(7, '11:00');
    const both = await Promise.all([
      bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(11) }),
      bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(12) }),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await count('crm_appointments', `tenant_id = $1 and starts_at = $2 and status in ('requested', 'confirmed')`, [acme.id, startsAt]), 1);
    assert.match(both.find((r) => r.status === 409).body.error, /no longer available/);

    /* two crews: two bookings of the same time, and a third is refused. */
    ok(await booking.saveSettings(deps, acme.ownerActor, acme.id, { capacity: 2 }));
    const shared = at(7, '14:00');
    const three = await Promise.all([13, 14, 15].map((n) => bookVia(acme, { type: 'visit', starts_at: shared, ...person(n) })));
    assert.deepEqual(three.map((r) => r.status).sort(), [200, 200, 409]);
    ok(await booking.saveSettings(deps, acme.ownerActor, acme.id, { capacity: 1 }));
  });

  test('a buffer keeps the next appointment off this one, by the larger of the two buffers and not their sum', async () => {
    const buffered = ok(await booking.saveAppointmentType(deps, acme.ownerActor, acme.id, { key: 'install', name: 'Install', duration_minutes: 60, buffer_before_minutes: 30, buffer_after_minutes: 30, requires_approval: false }));
    assert.equal((await bookVia(acme, { type: 'install', starts_at: at(8, '10:00'), ...person(21) })).status, 200);
    const a = await appointmentAt(acme, at(8, '10:00'));
    assert.equal(ms(a.starts_at) - ms(a.busy_from), 30 * 60_000);
    assert.equal(ms(a.busy_until) - ms(a.ends_at), 30 * 60_000);
    const slots = (await get('/slots', { key: acme.page.public_key, type: 'tune_up', from: dayAhead(8), days: '1' })).body.availability.slots.map((s) => s.starts_at);
    /* 10:00–11:00 with half an hour either side: a 30-minute tune-up fits 09:00 and 11:30, not 09:30 or 11:00. */
    assert.ok(slots.includes(at(8, '09:00')) && slots.includes(at(8, '11:30')));
    assert.ok(!slots.includes(at(8, '09:30')) && !slots.includes(at(8, '10:30')) && !slots.includes(at(8, '11:00')));
    /* another buffered install: 30 minutes apart is enough, not 60. */
    const installs = (await get('/slots', { key: acme.page.public_key, type: 'install', from: dayAhead(8), days: '1' })).body.availability.slots.map((s) => s.starts_at);
    assert.ok(installs.includes(at(8, '11:30')) && installs.includes(at(8, '08:30')));
    assert.ok(!installs.includes(at(8, '11:00')) && !installs.includes(at(8, '09:00')));
    assert.equal((await bookVia(acme, { type: 'tune_up', starts_at: at(8, '11:00'), ...person(22) })).status, 409);
    assert.equal((await bookVia(acme, { type: 'tune_up', starts_at: at(8, '11:30'), ...person(22) })).status, 200);
    ok(await booking.saveAppointmentType(deps, acme.ownerActor, acme.id, { archived: true }, buffered.id));
    assert.equal((await bookVia(acme, { type: 'install', starts_at: at(8, '14:00'), ...person(23) })).status, 422, 'a retired type is not on the page');
  });

  test('the public door: only from ARC\'s own site, never as a GET, and a caught script is answered like a real booking', async () => {
    const values = { type: 'visit', starts_at: at(9, '09:00'), ...person(31) };
    const body = { key: acme.page.public_key, values, submission_id: submission() };
    const elsewhere = await handle({ method: 'POST', route: '/book', query: {}, origin: 'https://evil.example', ip: '10.8.0.1', body });
    assert.equal(elsewhere.status, 403);
    assert.equal(elsewhere.headers['Access-Control-Allow-Origin'], 'null');
    assert.equal((await handle({ method: 'POST', route: '/book', query: {}, origin: null, ip: '10.8.0.2', body })).status, 403);
    assert.equal((await handle({ method: 'GET', route: '/book', query: {}, origin: SITE, ip: '10.8.0.3', body: undefined })).status, 405);
    assert.equal((await post('/book', { ...body, key: `arcb_${'q'.repeat(32)}` })).status, 404);
    assert.equal((await post('/nowhere', body)).status, 404);
    /* no origins configured refuses everything rather than allowing everything. */
    const unconfigured = createPublicBooking({ deps, allowedOrigins: [], limiter: { over: () => false } });
    assert.equal((await unconfigured({ method: 'POST', route: '/book', query: {}, origin: SITE, ip: '10.8.0.4', body })).status, 403);

    const honeypot = await post('/book', { ...body, company_website: 'https://spam.example' });
    assert.equal(honeypot.status, 200);
    assert.deepEqual(Object.keys(honeypot.body.booking).sort(), ['ends_at', 'manage_token', 'starts_at', 'status', 'timezone', 'title']);
    const fast = await post('/book', { ...body, rendered_at: Date.now() });
    assert.equal(fast.status, 200);
    assert.equal(await count('crm_appointments', 'tenant_id = $1 and starts_at = $2', [acme.id, values.starts_at]), 0, 'nothing was written');
    assert.equal((await post('/manage', { key: acme.page.public_key, token: honeypot.body.booking.manage_token })).status, 404, 'and its link opens nothing');

    /* missing details come back by field, and nothing is written. */
    const empty = await post('/book', { key: acme.page.public_key, values: { type: 'visit', starts_at: values.starts_at }, submission_id: submission() });
    assert.equal(empty.status, 422);
    assert.deepEqual(empty.body.field_errors.map((e) => e.field).sort(), ['name', 'phone']);

    /* the limiter, when it is the real one. */
    const limited = createPublicBooking({ deps, allowedOrigins: [SITE], limiter: windowLimiter(60_000) });
    let last;
    for (let i = 0; i <= PUBLIC_LIMITS.perIp; i += 1) last = await limited({ method: 'POST', route: '/book', query: {}, origin: SITE, ip: '10.7.7.7', body: { key: acme.page.public_key, values: {} } });
    assert.equal(last.status, 429);
    assert.equal(last.headers['Retry-After'], '60');
  });

  /* ── a person books, from the lead ── */

  test('a lead becomes an appointment from the workspace: linked to the lead and the customer, confirmed, and the inbox reads it as the next step', async () => {
    const arrival = ok(await intake.createManualLead(wdeps, acme.staffActor, acme.id, { contact: { display_name: 'Lead Person', phone: '+16145552001' }, lead: { title: 'Furnace is rattling' } }));
    const before_ = inboxStates(ok(await workspace.getWorkspace(wdeps, acme.staffActor, acme.id))).find((s) => s.lead.id === arrival.lead_id);
    assert.equal(before_.next_appointment, null);
    assert.ok(before_.reasons.includes('no next step'));

    const slots = await asClient(acme.staffActor, 'crm-booking-slots', { appointment_type_id: acme.visit.id, from: dayAhead(10), days: 1 });
    assert.equal(slots.status, 200, JSON.stringify(slots.body));
    assert.equal(slots.body.availability.slots[0].starts_at, at(10, '08:00'));

    const booked = await asClient(acme.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: acme.visit.id, starts_at: at(10, '09:00'), lead_id: arrival.lead_id, customer_note: 'Side door' } });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const a = booked.body.booked.appointment;
    assert.deepEqual([a.status, a.source, a.lead_id, a.contact_id, a.requires_approval], ['confirmed', 'staff', arrival.lead_id, arrival.contact_id, false]);
    assert.equal(a.starts_at, at(10, '09:00'));
    assert.equal(await count('crm_appointment_links', 'appointment_id = $1', [a.id]), 0, 'a person\'s booking has no customer link');

    const record = await asClient(acme.staffActor, 'crm-booking-record', { lead_id: arrival.lead_id });
    assert.equal(record.status, 200);
    assert.deepEqual(record.body.record.appointments.map((x) => x.id), [a.id]);
    const [event] = record.body.record.events;
    assert.deepEqual([event.event_type, event.actor_type, event.actor_id, event.detail.via], ['confirmed', 'client_user', acme.staff, 'workspace']);
    assert.deepEqual(record.body.record.viewer.may, { book: true, setup: false, reconcile: false });

    const ws = ok(await workspace.getWorkspace(wdeps, acme.staffActor, acme.id));
    const state = inboxStates(ws).find((s) => s.lead.id === arrival.lead_id);
    assert.equal(state.next_appointment.id, a.id);
    assert.ok(!state.reasons.includes('no next step'), 'a booked time is a next step');
    const timeline = ok(await workspace.getLeadView(wdeps, acme.staffActor, acme.id, arrival.lead_id)).timeline;
    assert.ok(timeline.some((t) => t.activity_type === 'appointment_confirmed' && t.actor_id === acme.staff));

    /* outside the hours: refused, unless the person says so on purpose. */
    const late = { appointment_type_id: acme.visit.id, starts_at: at(10, '19:00'), lead_id: arrival.lead_id };
    const refusedLate = await asClient(acme.staffActor, 'crm-appointment-book', { booking: late });
    assert.equal(refusedLate.status, 409);
    assert.equal(refusedLate.body.code, 'slot_unavailable');
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-book', { booking: { ...late, outside_rules: true } })).status, 201);
    /* but never on top of another appointment. */
    const clash = await asClient(acme.staffActor, 'crm-appointment-book', { booking: { ...late, starts_at: at(10, '09:30'), outside_rules: true } });
    assert.equal(clash.body.code, 'slot_taken');

    /* a lead that is not this client's does not exist here. */
    const theirs = ok(await intake.createManualLead({ ...wdeps }, other.ownerActor, other.id, { contact: { display_name: 'Elsewhere', phone: '+16145552002' }, lead: { title: 'Other job' } }));
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: acme.visit.id, starts_at: at(10, '13:00'), lead_id: theirs.lead_id } })).status, 404);
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: other.visit.id, starts_at: at(10, '13:00'), lead_id: arrival.lead_id } })).status, 404);
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: acme.visit.id, starts_at: at(10, '13:00') } })).status, 422, 'an appointment is for somebody');
  });

  /* ── confirm, move, cancel ── */

  test('a request is confirmed, moved and cancelled — each by a named person, each kept in the history, none rewritten', async () => {
    const startsAt = at(11, '10:00');
    assert.equal((await bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(41) })).status, 200);
    const a = await appointmentAt(acme, startsAt);
    const ws = ok(await workspace.getWorkspace(wdeps, acme.staffActor, acme.id));
    const state = inboxStates(ws).find((s) => s.lead.id === a.lead_id);
    assert.equal(state.booking_request, true);
    assert.ok(state.attention && state.reasons.includes('a booking request is waiting for an answer'));

    const change = (actor, body) => asClient(actor, 'crm-appointment-change', { appointment_id: a.id, change: body });
    const confirmed = await change(acme.ownerActor, { action: 'confirm' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.appointment.status, 'confirmed');
    assert.ok(confirmed.body.appointment.confirmed_at);

    /* not yet started: it cannot be closed as done or as a no-show. */
    assert.equal((await change(acme.staffActor, { action: 'complete' })).status, 422);
    assert.equal((await change(acme.staffActor, { action: 'no_show' })).status, 422);

    const moved = await change(acme.staffActor, { action: 'reschedule', starts_at: at(11, '14:00') });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual([moved.body.appointment.starts_at, moved.body.appointment.status, moved.body.appointment.reschedule_count], [at(11, '14:00'), 'confirmed', 1]);
    /* the time it left is free again; the one it took is not. */
    const free = (await get('/slots', { key: acme.page.public_key, type: 'visit', from: dayAhead(11), days: '1' })).body.availability.slots.map((s) => s.starts_at);
    assert.ok(free.includes(startsAt) && !free.includes(at(11, '14:00')));
    assert.equal((await change(acme.staffActor, { action: 'reschedule', starts_at: at(11, '14:00') })).status, 422, 'the time it already has');
    assert.equal((await change(acme.staffActor, { action: 'reschedule', starts_at: at(11, '20:00') })).body.code, 'slot_unavailable');
    assert.equal((await change(acme.staffActor, { action: 'assign', assigned_user_id: acme.staff })).body.appointment.assigned_user_id, acme.staff);
    assert.equal((await change(acme.staffActor, { action: 'assign', assigned_user_id: other.staff })).status, 422, 'only somebody who could open it');

    const cancelled = await handleWorkspaceAction('crm-appointment-change', { deps: wdeps, actor: op, body: { tenant_id: acme.id, appointment_id: a.id, change: { action: 'cancel', reason: 'Customer sold the house' } } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual([cancelled.body.appointment.status, cancelled.body.appointment.cancel_reason], ['cancelled', 'Customer sold the house']);
    assert.ok(cancelled.body.appointment.closed_at);
    /* cancelled is final for a person, and it keeps its time. */
    assert.equal((await change(acme.ownerActor, { action: 'confirm' })).body.code, 'invalid_transition');
    assert.match(await refused(db, `update crm_appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day', busy_from = busy_from + interval '1 day', busy_until = busy_until + interval '1 day', updated_by_type = 'system' where id = $1`, [a.id]), /arc_crm:immutable/);

    const events = (await db.query('select event_type, actor_type, actor_id, detail from crm_appointment_events where appointment_id = $1 order by occurred_at, event_type', [a.id])).rows;
    assert.deepEqual(events.map((e) => e.event_type).sort(), ['assigned', 'cancelled', 'confirmed', 'requested', 'rescheduled']);
    const by = Object.fromEntries(events.map((e) => [e.event_type, e]));
    assert.deepEqual([by.confirmed.actor_type, by.confirmed.actor_id], ['client_user', acme.owner]);
    assert.deepEqual([ms(by.rescheduled.detail.from), ms(by.rescheduled.detail.to), by.rescheduled.actor_id], [Date.parse(startsAt), Date.parse(at(11, '14:00')), acme.staff]);
    assert.deepEqual([by.cancelled.actor_type, by.cancelled.actor_id, by.cancelled.detail.reason], ['operator', operator, 'Customer sold the house']);
    /* the timeline names each, and an operator's move or cancel is also in the audit log. */
    const activity = (await db.query('select activity_type from crm_activities where lead_id = $1', [a.lead_id])).rows.map((r) => r.activity_type);
    for (const type of ['appointment_requested', 'appointment_confirmed', 'appointment_rescheduled', 'appointment_cancelled']) assert.ok(activity.includes(type), type);
    assert.equal(await count('admin_actions', `action = 'crm.appointment.cancelled' and target_id = $1 and actor_user_id = $2`, [a.id, operator]), 1);
    /* history is not rewritten or removed. */
    assert.match(await refused(db, `update crm_appointment_events set event_type = 'confirmed' where appointment_id = $1`, [a.id]), /arc_crm:immutable/);
    assert.match(await refused(db, 'delete from crm_appointment_events where appointment_id = $1', [a.id]), /arc_crm:immutable/);
    /* and an appointment keeps where it came from. */
    assert.match(await refused(db, `update crm_appointments set source = 'staff', updated_by_type = 'system' where id = $1`, [a.id]), /arc_crm:immutable/);
  });

  test('declining a request frees the time, and what is over can be closed as done or as a no-show', async () => {
    const startsAt = at(12, '10:00');
    await bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(42) });
    const a = await appointmentAt(acme, startsAt);
    const declined = await asClient(acme.staffActor, 'crm-appointment-change', { appointment_id: a.id, change: { action: 'decline', reason: 'Fully booked that week' } });
    assert.equal(declined.body.appointment.status, 'declined');
    assert.equal((await bookVia(acme, { type: 'visit', starts_at: startsAt, ...person(43) })).status, 200, 'the time is free again');

    /* an appointment that has already happened, written down afterwards. */
    const lead = ok(await intake.createManualLead(wdeps, acme.staffActor, acme.id, { contact: { display_name: 'Walk In', phone: '+16145552101' }, lead: { title: 'Walk-in' } }));
    const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const booked = await asClient(acme.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: acme.quick.id, starts_at: past, lead_id: lead.lead_id, outside_rules: true } });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const done = await asClient(acme.staffActor, 'crm-appointment-change', { appointment_id: booked.body.booked.appointment.id, change: { action: 'complete' } });
    assert.equal(done.body.appointment.status, 'completed');
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-change', { appointment_id: booked.body.booked.appointment.id, change: { action: 'no_show' } })).body.code, 'invalid_transition');
    /* a won lead and a completed appointment are records a person set. neither is counted as a result. */
    assert.equal(await count('events', 'tenant_id = $1', [acme.id]), 0);
  });

  /* ── the customer's own link ── */

  test('a customer moves or cancels from their own link — within the client\'s rules, and a move of a request-type is a request again', async () => {
    const booked = await bookVia(acme, { type: 'visit', starts_at: at(13, '10:00'), ...person(51) });
    const token = booked.body.booking.manage_token;
    const a = await appointmentAt(acme, at(13, '10:00'));
    await asClient(acme.ownerActor, 'crm-appointment-change', { appointment_id: a.id, change: { action: 'confirm' } });

    const view = await post('/manage', { key: acme.page.public_key, token });
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.appointment.appointment.status, view.body.appointment.appointment.title, view.body.appointment.business], ['confirmed', 'Site visit', 'Co book-acme']);
    assert.deepEqual([view.body.appointment.can.cancel.ok, view.body.appointment.can.reschedule.ok], [true, true]);
    assert.doesNotMatch(JSON.stringify(view.body), /[0-9a-f]{8}-[0-9a-f]{4}-|phone|email/, 'no ids and no contact details');
    assert.equal(view.headers['Cache-Control'], 'no-store');

    /* the times it could move to include the one it holds now — it does not block itself. */
    const slots = await post('/manage/slots', { key: acme.page.public_key, token, from: dayAhead(13), days: 1 });
    assert.ok(slots.body.availability.slots.some((s) => s.starts_at === at(13, '10:30')));

    const moved = await post('/manage/change', { key: acme.page.public_key, token, action: 'reschedule', starts_at: at(13, '15:00') });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual([moved.body.appointment.appointment.starts_at, moved.body.appointment.appointment.status], [at(13, '15:00'), 'requested']);
    const event = await one(`select * from crm_appointment_events where appointment_id = $1 and event_type = 'rescheduled'`, [a.id]);
    assert.deepEqual([event.actor_type, event.actor_id, event.detail.via, event.detail.status], ['system', null, 'manage_link', 'requested']);
    assert.equal((await post('/manage/change', { key: acme.page.public_key, token, action: 'reschedule', starts_at: at(13, '22:00') })).body.code, 'slot_unavailable');
    assert.equal((await post('/manage/change', { key: acme.page.public_key, token, action: 'confirm' })).status, 422, 'a link confirms nothing');

    const cancelled = await post('/manage/change', { key: acme.page.public_key, token, action: 'cancel', reason: 'Found a leak elsewhere' });
    assert.equal(cancelled.body.appointment.appointment.status, 'cancelled');
    assert.equal(cancelled.body.appointment.can.cancel.ok, false);
    assert.equal((await post('/manage/change', { key: acme.page.public_key, token, action: 'cancel' })).body.code, 'conflict');

    /* a wrong link, a made-up one, and a real one through another client's page are one answer. */
    for (const [key, t] of [[acme.page.public_key, `arcm_${'a'.repeat(40)}`], [acme.page.public_key, 'not-a-token'], [other.page.public_key, token]]) {
      assert.equal((await post('/manage', { key, token: t })).status, 404);
      assert.equal((await post('/manage/change', { key, token: t, action: 'cancel' })).status, 404);
    }
    assert.equal((await handle({ method: 'POST', route: '/manage', query: {}, origin: 'https://evil.example', ip: '10.6.0.1', body: { key: acme.page.public_key, token } })).status, 403);
  });

  test('too close to the appointment, or switched off by the client, the link says to call — and the page says so first', async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const lead = ok(await intake.createManualLead(wdeps, acme.staffActor, acme.id, { contact: { display_name: 'Soon Person', phone: '+16145552201' }, lead: { title: 'Soon' } }));
    const booked = ok(await booking.bookAppointment(deps, acme.staffActor, acme.id, { appointment_type_id: acme.quick.id, starts_at: soon, lead_id: lead.lead_id, outside_rules: true }));
    /* a link for it, as the hosted page would have been given. */
    const token = `arcm_${'s'.repeat(40)}`;
    await db.query('insert into crm_appointment_links (tenant_id, appointment_id, token_hash) values ($1, $2, $3)', [acme.id, booked.appointment.id, await intake.sha256Hex(token)]);
    const view = await post('/manage', { key: acme.page.public_key, token });
    assert.equal(view.body.appointment.can.cancel.ok, false, 'three hours out, inside the four-hour cutoff');
    assert.match(view.body.appointment.can.cancel.message, /please call/);
    const tried = await post('/manage/change', { key: acme.page.public_key, token, action: 'cancel' });
    assert.deepEqual([tried.status, tried.body.code], [409, 'too_late']);
    /* the database refuses it too, whatever the service thought. */
    await assert.rejects(deps.booking.change(acme.id, booked.appointment.id, { action: 'cancel', changed_via: 'manage_link' }, 'system', null), (e) => e.code === 'too_late');
    /* a link is the only thing that acts with nobody signed in. */
    await assert.rejects(deps.booking.change(acme.id, booked.appointment.id, { action: 'cancel', changed_via: 'workspace' }, 'system', null), (e) => e.code === 'forbidden');
    await assert.rejects(deps.booking.change(acme.id, booked.appointment.id, { action: 'cancel', changed_via: 'manage_link' }, 'client_user', acme.staff), (e) => e.code === 'forbidden');

    const far = await bookVia(acme, { type: 'tune_up', starts_at: at(14, '09:00'), ...person(52) });
    ok(await booking.saveSettings(deps, acme.ownerActor, acme.id, { customer_may_cancel: false }));
    const off = await post('/manage', { key: acme.page.public_key, token: far.body.booking.manage_token });
    assert.deepEqual([off.body.appointment.can.cancel.ok, off.body.appointment.can.reschedule.ok], [false, true]);
    assert.equal((await post('/manage/change', { key: acme.page.public_key, token: far.body.booking.manage_token, action: 'cancel' })).body.code, 'too_late');
    ok(await booking.saveSettings(deps, acme.ownerActor, acme.id, { customer_may_cancel: true }));

    /* a retired page still opens the bookings it made. */
    const page = ok(await booking.saveBookingPage(deps, acme.ownerActor, acme.id, { name: 'Old page', definition: defaultPageDefinition('Old') }));
    ok(await booking.setPageStatus(deps, acme.ownerActor, acme.id, page.id, 'published'));
    const old = await post('/book', { key: page.public_key, values: { type: 'tune_up', starts_at: at(14, '11:00'), ...person(53) }, submission_id: submission() });
    ok(await booking.setPageStatus(deps, acme.ownerActor, acme.id, page.id, 'archived'));
    assert.equal((await get('/page', { key: page.public_key })).status, 404);
    assert.equal((await post('/manage', { key: page.public_key, token: old.body.booking.manage_token })).status, 200);
  });

  /* ── the service area ── */

  test('a booking outside the service area is turned away only when the client asks for that, and only on a match it can check', async () => {
    const zip = async (value) => ok(await crm.saveServiceArea(deps.crm, op, other.id, { kind: 'postal_code', value }));
    await zip('80202');
    await zip('80203');
    const book = (n, postal) => bookVia(other, { type: 'tune_up', starts_at: at(3, `${String(8 + n).padStart(2, '0')}:00`), ...person(60 + n), address: '1 Main St', postal_code: postal });
    assert.equal((await book(0, '99999')).status, 200, 'not enforced: anywhere books');
    ok(await booking.saveSettings(deps, other.ownerActor, other.id, { enforce_service_area: true }));
    const outside = await book(1, '99999');
    assert.deepEqual([outside.status, outside.body.code], [422, 'outside_service_area']);
    assert.equal((await book(2, '80203-1234')).status, 200);
    assert.equal((await bookVia(other, { type: 'tune_up', starts_at: at(3, '12:00'), ...person(65) })).status, 200, 'no address given: not turned away on a guess');
    ok(await booking.saveSettings(deps, other.ownerActor, other.id, { enforce_service_area: false }));
  });

  /* ── whose calendar it is ── */

  test('their own calendar is the authority: ARC offers no times, takes a request, and nobody here confirms or moves it', async () => {
    const theirs = await newTenant('book-theirs');
    ok(await crm.setSourcePolicy(deps.crm, op, theirs.id, { object_type: 'appointment', authority: 'external', connector_key: 'google_calendar' }));
    const rules = await deps.booking.rules(theirs.id);
    assert.deepEqual(rules.authority, { authority: 'external', connector_key: 'google_calendar', time_owner: 'external', status_owner: 'external' });

    const page = await get('/page', { key: theirs.page.public_key });
    assert.equal(page.body.page.mode, 'request');
    const slots = await get('/slots', { key: theirs.page.public_key, type: 'tune_up', from: dayAhead(3), days: '1' });
    assert.deepEqual([slots.body.availability.slots.length, slots.body.availability.unavailable], [0, 'their_calendar'], 'ARC does not invent availability');
    const overview = ok(await booking.getBookingOverview(deps, theirs.ownerActor, theirs.id));
    assert.deepEqual([overview.mode, overview.unavailable], ['request', 'their_calendar']);

    /* a preferred time — at an hour ARC's own rules would refuse, because they are not the rules here. */
    const wanted = at(3, '19:30');
    const res = await bookVia(theirs, { type: 'tune_up', starts_at: wanted, ...person(71) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.booking.status, 'requested', 'even a type that needs no approval: their calendar has not agreed');
    const a = await appointmentAt(theirs, wanted);
    assert.deepEqual([a.status, a.sync_state], ['requested', 'pending']);

    /* nobody on ARC's side books, confirms, moves or cancels. */
    const lead = ok(await intake.createManualLead(wdeps, theirs.staffActor, theirs.id, { contact: { display_name: 'On File', phone: '+16145552301' }, lead: { title: 'Job' } }));
    const book = await asClient(theirs.staffActor, 'crm-appointment-book', { booking: { appointment_type_id: theirs.quick.id, starts_at: at(4, '10:00'), lead_id: lead.lead_id } });
    assert.deepEqual([book.status, book.body.code], [409, 'external_authority']);
    assert.match(book.body.error, /google_calendar/);
    for (const change of [{ action: 'confirm' }, { action: 'cancel' }, { action: 'reschedule', starts_at: at(4, '11:00') }]) {
      const tried = await asClient(theirs.ownerActor, 'crm-appointment-change', { appointment_id: a.id, change });
      assert.deepEqual([tried.status, tried.body.code], [409, 'external_authority'], change.action);
    }
    await assert.rejects(deps.booking.change(theirs.id, a.id, { action: 'confirm' }, 'operator', operator), (e) => e.code === 'external_authority');
    await assert.rejects(deps.booking.book(theirs.id, { actor_type: 'operator', actor_id: operator, appointment_type_id: theirs.quick.id, starts_at: at(4, '10:00'), contact_id: lead.contact_id }), (e) => e.code === 'external_authority');
    assert.equal((await asClient(theirs.staffActor, 'crm-appointment-change', { appointment_id: a.id, change: { action: 'assign', assigned_user_id: theirs.staff } })).status, 200, 'who has it is still ARC\'s to say');
    assert.equal((await post('/manage/change', { key: theirs.page.public_key, token: res.body.booking.manage_token, action: 'cancel' })).body.code, 'too_late');

    /* their calendar answers: the request becomes their entry, at the time they gave it. */
    const calendar = { kind: 'external', connectorKey: 'google_calendar' };
    const answered = ok(await booking.reportExternalAppointment(deps, calendar, theirs.id, {
      external_id: 'gcal-evt-1', appointment_id: a.id, status: 'confirmed', starts_at: at(3, '18:00'), ends_at: at(3, '18:30'), observed_at: new Date().toISOString(),
    }));
    assert.equal(answered.outcome, 'applied');
    assert.deepEqual([answered.appointment.status, answered.appointment.starts_at, answered.appointment.sync_state], ['confirmed', at(3, '18:00'), 'synced']);
    assert.equal(await count('crm_external_mappings', `tenant_id = $1 and object_type = 'appointment' and object_id = $2 and external_id = 'gcal-evt-1'`, [theirs.id, a.id]), 1);
    const sync = await one(`select * from crm_appointment_events where appointment_id = $1 and event_type = 'sync_applied'`, [a.id]);
    assert.equal(sync.actor_type, 'external');

    /* an older observation than the one applied changes nothing. */
    const stale = ok(await booking.reportExternalAppointment(deps, calendar, theirs.id, { external_id: 'gcal-evt-1', status: 'cancelled', starts_at: at(3, '18:00'), ends_at: at(3, '18:30'), observed_at: new Date(Date.now() - 3_600_000).toISOString() }));
    assert.equal(stale.outcome, 'stale');
    assert.equal((await appointmentAt(theirs, at(3, '18:00'))).status, 'confirmed');
    /* an entry ARC never saw, for a customer it has. */
    const fresh = ok(await booking.reportExternalAppointment(deps, calendar, theirs.id, { external_id: 'gcal-evt-2', contact_id: lead.contact_id, lead_id: lead.lead_id, title: 'Estimate walk-through', status: 'confirmed', starts_at: at(5, '10:00'), ends_at: at(5, '11:00') }));
    assert.deepEqual([fresh.outcome, fresh.appointment.source, fresh.appointment.sync_state, fresh.appointment.title], ['created', 'external_system', 'synced', 'Estimate walk-through']);
    /* only the calendar that is the authority, and only a connector, reports. */
    assert.equal((await booking.reportExternalAppointment(deps, { kind: 'external', connectorKey: 'jobber' }, theirs.id, { external_id: 'j-1', contact_id: lead.contact_id, status: 'confirmed', starts_at: at(5, '13:00'), ends_at: at(5, '14:00') })).code, 'arc_authority');
    assert.equal((await booking.reportExternalAppointment(deps, op, theirs.id, { external_id: 'x', status: 'confirmed', starts_at: at(5, '13:00'), ends_at: at(5, '14:00') })).code, 'forbidden');
    assert.equal((await booking.reportExternalAppointment(deps, calendar, theirs.id, { external_id: 'gcal-evt-3', status: 'confirmed', starts_at: at(5, '13:00'), ends_at: at(5, '12:00') })).code, 'invalid');
    /* ARC keeps acme's calendar: an external one cannot add to it. */
    assert.equal((await booking.reportExternalAppointment(deps, calendar, acme.id, { external_id: 'gcal-evt-9', contact_id: lead.contact_id, status: 'confirmed', starts_at: at(15, '10:00'), ends_at: at(15, '11:00') })).code, 'arc_authority');
  });

  test('a report that disagrees with what ARC owns is not applied and not dropped: the appointment is frozen until a person settles it', async () => {
    const lead = ok(await intake.createManualLead(wdeps, acme.staffActor, acme.id, { contact: { display_name: 'Mirror Person', phone: '+16145552401' }, lead: { title: 'Mirrored' } }));
    const a = ok(await booking.bookAppointment(deps, acme.staffActor, acme.id, { appointment_type_id: acme.visit.id, starts_at: at(16, '10:00'), lead_id: lead.lead_id })).appointment;
    /* ARC keeps the calendar and mirrors this one to theirs. */
    ok(await crm.addMapping(deps.crm, op, acme.id, { object_type: 'appointment', object_id: a.id, connector_key: 'google_calendar', external_id: 'gcal-mirror-1' }));
    const calendar = { kind: 'external', connectorKey: 'google_calendar' };
    const report = (startsAt, endsAt, extra = {}) => booking.reportExternalAppointment(deps, calendar, acme.id, { external_id: 'gcal-mirror-1', status: 'confirmed', starts_at: startsAt, ends_at: endsAt, ...extra });

    const same = ok(await report(at(16, '10:00'), at(16, '11:00'), { observed_at: new Date(Date.now() - 60_000).toISOString() }));
    assert.deepEqual([same.outcome, same.appointment.sync_state], ['unchanged', 'synced']);

    /* somebody dragged it in their calendar. */
    const observed = new Date(Date.now() - 30_000).toISOString();
    const moved = ok(await report(at(16, '13:00'), at(16, '14:00'), { observed_at: observed }));
    assert.equal(moved.outcome, 'conflict');
    assert.deepEqual([moved.appointment.starts_at, moved.appointment.sync_state, moved.appointment.sync_detail.reason], [at(16, '10:00'), 'conflict', 'time'], 'ARC\'s time stands');
    assert.equal(moved.appointment.sync_detail.reported.external_id, 'gcal-mirror-1');

    /* frozen: no move and no change of status until it is settled. */
    for (const change of [{ action: 'cancel' }, { action: 'reschedule', starts_at: at(16, '15:00') }]) {
      const tried = await asClient(acme.ownerActor, 'crm-appointment-change', { appointment_id: a.id, change });
      assert.deepEqual([tried.status, tried.body.code], [409, 'needs_reconciliation'], change.action);
    }
    assert.match(await refused(db, `update crm_appointments set status = 'cancelled', updated_by_type = 'system' where id = $1`, [a.id]), /arc_crm:needs_reconciliation/);

    /* staff do not settle it; the account owner does. */
    assert.equal((await asClient(acme.staffActor, 'crm-appointment-reconcile', { appointment_id: a.id, resolution: 'keep_ours' })).status, 403);
    assert.equal((await asClient(acme.ownerActor, 'crm-appointment-reconcile', { appointment_id: a.id, resolution: 'whatever' })).status, 422);
    const kept = await asClient(acme.ownerActor, 'crm-appointment-reconcile', { appointment_id: a.id, resolution: 'keep_ours' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual([kept.body.appointment.starts_at, kept.body.appointment.sync_state], [at(16, '10:00'), 'pending']);
    assert.equal((await asClient(acme.ownerActor, 'crm-appointment-reconcile', { appointment_id: a.id, resolution: 'keep_ours' })).status, 409, 'nothing left to settle');
    /* the same report again is old news; a newer one that still disagrees is a new disagreement. */
    assert.equal(ok(await report(at(16, '13:00'), at(16, '14:00'), { observed_at: observed })).outcome, 'stale');
    assert.equal(ok(await report(at(16, '13:00'), at(16, '14:00'))).outcome, 'conflict');

    const accepted = await handleWorkspaceAction('crm-appointment-reconcile', { deps: wdeps, actor: op, body: { tenant_id: acme.id, appointment_id: a.id, resolution: 'accept_theirs' } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual([accepted.body.appointment.starts_at, accepted.body.appointment.sync_state], [at(16, '13:00'), 'synced']);

    const events = (await db.query('select event_type, actor_type, detail from crm_appointment_events where appointment_id = $1 order by occurred_at', [a.id])).rows;
    assert.deepEqual(events.filter((e) => e.event_type === 'sync_conflict').length, 2);
    assert.deepEqual(events.filter((e) => e.event_type === 'reconciled').map((e) => [e.actor_type, e.detail.kept]), [['client_user', 'ours'], ['operator', 'theirs']]);
    assert.ok(events.some((e) => e.event_type === 'rescheduled' && e.actor_type === 'operator'), 'accepting their time is that person\'s move, in the history');
  });

  /* ── isolation ── */

  test('one client\'s calendar is not another\'s: refused before anything is read, absent inside their own, and held by RLS', async () => {
    const mine = ok(await booking.getBookingOverview(deps, acme.ownerActor, acme.id));
    assert.ok(mine.appointments.length > 5);
    assert.ok(mine.appointments.every((a) => a.tenant_id === acme.id));
    assert.ok(mine.contacts.every((c) => !/Elsewhere/.test(c.display_name)));
    const theirs = mine.appointments[0];
    for (const [action, body] of [
      ['crm-booking', {}], ['crm-booking-record', { lead_id: theirs.lead_id }], ['crm-booking-slots', { appointment_type_id: acme.visit.id }],
      ['crm-appointment-change', { appointment_id: theirs.id, change: { action: 'cancel' } }],
      ['crm-appointment-book', { booking: { appointment_type_id: acme.visit.id, starts_at: at(17, '10:00'), contact_id: theirs.contact_id } }],
    ]) {
      const res = await handleWorkspaceAction(action, { deps: wdeps, actor: other.ownerActor, body: { tenant_id: acme.id, ...body } });
      assert.equal(res.status, 403, action);
    }
    /* acme's appointment named inside the other client's own tenant: it does not exist there. */
    assert.equal((await asClient(other.ownerActor, 'crm-appointment-change', { appointment_id: theirs.id, change: { action: 'cancel' } })).status, 404);
    assert.equal((await asClient(other.ownerActor, 'crm-appointment-reconcile', { appointment_id: theirs.id, resolution: 'keep_ours' })).status, 404);
    assert.deepEqual((await asClient(other.ownerActor, 'crm-booking-record', { lead_id: theirs.lead_id })).body.record.appointments, []);
    assert.equal((await handleWorkspaceAction('crm-booking', { deps: wdeps, actor: null, body: { tenant_id: acme.id } })).status, 401);
    assert.equal((await handleWorkspaceAction('crm-booking', { deps: { crm: deps.crm, intake: wdeps.intake }, actor: op, body: { tenant_id: acme.id } })).status, 422, 'a door without the store says so');

    /* row level security, as a signed-in browser would meet it. */
    const seen = async (user, table) => Number((await asRole(db, { role: 'authenticated', sub: user }, (tx) => tx.query(`select count(*)::int as n from public.${table} where tenant_id = $1`, [acme.id]))).rows[0].n);
    assert.ok(await seen(acme.staff, 'crm_appointments') > 5);
    assert.ok(await seen(operator, 'crm_appointments') > 5);
    for (const table of ['crm_appointments', 'crm_appointment_events', 'crm_appointment_types', 'crm_booking_pages', 'crm_booking_settings']) {
      assert.equal(await seen(other.owner, table), 0, table);
    }
    /* nobody holding a browser key reads a link, operator or not, and nobody writes anything. */
    assert.ok(await count('crm_appointment_links', 'tenant_id = $1', [acme.id]) > 0);
    await assert.rejects(seen(acme.owner, 'crm_appointment_links'), /permission denied/);
    await assert.rejects(seen(operator, 'crm_appointment_links'), /permission denied/);
    await assert.rejects(asRole(db, { role: 'authenticated', sub: acme.owner }, (tx) => tx.query(`update public.crm_appointments set status = 'cancelled' where tenant_id = $1`, [acme.id])), /permission denied/);
    await assert.rejects(asRole(db, { role: 'anon' }, (tx) => tx.query('select count(*) from public.crm_appointments')), /permission denied/);
    await assert.rejects(asRole(db, { role: 'authenticated', sub: acme.owner }, (tx) => tx.query('select public.crm_book_appointment($1, $2)', [acme.id, '{}'])), /permission denied/);
  });

  /* ── what else moves with it ── */

  test('when two customers are found to be one, their appointments go with them; nothing secret-shaped is ever kept', async () => {
    await bookVia(acme, { type: 'tune_up', starts_at: at(18, '09:00'), name: 'Dup One', phone: '+16145552501' });
    await bookVia(acme, { type: 'tune_up', starts_at: at(18, '10:00'), name: 'Dup Two', phone: '+16145552502' });
    const one_ = await one(`select id from crm_contacts where tenant_id = $1 and phone = '+16145552501'`, [acme.id]);
    const two = await one(`select id from crm_contacts where tenant_id = $1 and phone = '+16145552502'`, [acme.id]);
    ok(await crm.mergeContacts(deps.crm, op, acme.id, { keepId: one_.id, mergeId: two.id }));
    assert.equal(await count('crm_appointments', 'tenant_id = $1 and contact_id = $2', [acme.id, one_.id]), 2);
    assert.equal(await count('crm_appointments', 'tenant_id = $1 and contact_id = $2', [acme.id, two.id]), 0);
    assert.match(await refused(db, `update crm_appointments set contact_id = $2, updated_by_type = 'system' where contact_id = $1`, [one_.id, two.id]), /arc_crm:invalid/);

    /* a pasted password does not cost the customer their booking, and is not kept. */
    const secret = ['pass', 'word: hunter2hunter2'].join('');
    const res = await bookVia(acme, { type: 'tune_up', starts_at: at(18, '13:00'), ...person(81), note: secret });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = await appointmentAt(acme, at(18, '13:00'));
    assert.match(a.customer_note, /removed/);
    assert.doesNotMatch(JSON.stringify(a), /hunter2/);
    assert.equal(await count('crm_leads', `tenant_id = $1 and summary like '%hunter2%'`, [acme.id]), 0);
    assert.equal((await booking.saveBookingPage(deps, acme.ownerActor, acme.id, { name: 'P', definition: { ...defaultPageDefinition('P'), intro: secret } })).code, 'invalid');
    assert.match(await refused(db, `update crm_appointments set customer_note = $2, updated_by_type = 'system' where id = $1`, [a.id, secret]), /violates check constraint/);
    /* and what the workspace is given holds no link, in any spelling. */
    const overview = JSON.stringify(ok(await booking.getBookingOverview(deps, op, acme.id)));
    assert.doesNotMatch(overview, /token_hash|arcm_|manage_token/);
    assert.doesNotMatch(JSON.stringify(ok(await booking.getRecordBooking(deps, op, acme.id, { lead_id: a.lead_id }))), /token_hash|arcm_/);
  });

  test('a client with only its booking setup is still a test client; one with an appointment is not', async () => {
    const setup = await newTenant('book-setup');
    ok(await booking.saveSettings(deps, setup.ownerActor, setup.id, { capacity: 3 }));
    await db.query('select public.purge_test_tenant($1, $2, $3)', [operator, setup.id, 'book-setup']);
    assert.equal(await count('crm_booking_pages', 'tenant_id = $1', [setup.id]), 0);
    assert.equal(await count('crm_appointment_types', 'tenant_id = $1', [setup.id]), 0);
    assert.equal(await count('crm_booking_settings', 'tenant_id = $1', [setup.id]), 0);
    const message = await refused(db, 'select public.purge_test_tenant($1, $2, $3)', [operator, acme.id, 'book-acme']);
    assert.match(message, /arc_tenant:tenant_has_activity/);
    assert.match(message, /\d+ appointments/);
  });
});
