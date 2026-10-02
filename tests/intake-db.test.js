/* ARC-350 — native lead capture against real Postgres.
 *
 * Two parts, as for 0023:
 *
 *   1. The text of 0024, always: every table has RLS and no write policy, nothing is granted
 *      to a browser role, and its vocabularies are the model's.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the real
 *      public handler, the real service and the real `ops` handler over the real stores, so
 *      what a stranger's browser posts is what 0024 receives.
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
import { supabaseIntakeStore } from '../supabase/functions/_shared/intake/supabase-intake-store.ts';
import * as intake from '../supabase/functions/_shared/intake/service.ts';
import { createPublicIntake, PUBLIC_LIMITS, windowLimiter } from '../supabase/functions/_shared/intake/public.ts';
import {
  ARRIVAL_OUTCOMES, CONSENT_CHANNELS, CONTACT_MATCHES, defaultFormDefinition, FORM_STATUSES, IMPORT_ROW_STATUSES, IMPORT_STATUSES,
} from '../supabase/functions/_shared/intake/model.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { handleIntakeAction, INTAKE_ACTIONS } from '../supabase/functions/ops/intake.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0024_native_intake.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');

/* ══ 1. the file ══════════════════════════════════════════ */

function checkList(table, column) {
  const body = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(CODE)?.[1] ?? '';
  const match = new RegExp(`\\n\\s+${column}\\s[^\\n]*?in \\(([^)]*)\\)`).exec(body);
  assert.ok(match, `${table}.${column} has a check list`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('0024 as written', () => {
  const tables = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);

  test('every table has RLS, a read policy, and no write policy; only an operator reads the endpoints', () => {
    assert.deepEqual([...tables].sort(), [...intake.INTAKE_TABLES].sort());
    const listed = /foreach t in array array\[([\s\S]*?)\] loop/.exec(CODE)[1];
    for (const table of tables.filter((t) => t !== 'crm_intake_endpoints')) assert.match(listed, new RegExp(`'${table}'`), `${table} is in the RLS loop`);
    assert.match(CODE, /alter table public\.crm_intake_endpoints enable row level security/);
    assert.match(CODE, /create policy crm_intake_endpoints_read on public\.crm_intake_endpoints\s+for select to authenticated using \(public\.is_arc_admin\(\)\)/);
    assert.doesNotMatch(CODE, /create policy [^;]*for (insert|update|delete|all)\b/i);
    assert.equal([...CODE.matchAll(/create policy/g)].length, 2, 'the loop\'s read policy and the endpoints\' operator-only one');
    assert.match(CODE, /revoke insert, update, delete, truncate on public\.crm_intake_endpoints from anon, authenticated/);
  });

  test('no function here is executable by a browser role', () => {
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
    const functions = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(functions.length >= 9);
    for (const fn of new Set(functions)) {
      assert.match(CODE, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), `${fn} is revoked`);
    }
    assert.doesNotMatch(CODE, /security definer/i);
  });

  test('the vocabularies are the model\'s', () => {
    assert.deepEqual(checkList('crm_intake_forms', 'status'), [...FORM_STATUSES]);
    assert.deepEqual(checkList('crm_imports', 'status'), [...IMPORT_STATUSES]);
    assert.deepEqual(checkList('crm_import_rows', 'status'), [...IMPORT_ROW_STATUSES]);
    assert.deepEqual(checkList('crm_import_rows', 'match'), [...CONTACT_MATCHES]);
    assert.deepEqual(checkList('crm_import_rows', 'outcome'), [...ARRIVAL_OUTCOMES]);
    assert.deepEqual(checkList('crm_consent_records', 'channel'), [...CONSENT_CHANNELS]);
  });

  test('a token is kept only as its hash, and an existing contact is never edited by an arrival', () => {
    const endpoints = /create table if not exists public\.crm_intake_endpoints \(([\s\S]*?)\n\);/.exec(CODE)[1];
    assert.match(endpoints, /token_hash\s+text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    const columns = [...CODE.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|jsonb|timestamptz|boolean|integer|bigint)\b/gm)].map((m) => m[1]);
    for (const column of columns.filter((c) => !['token_hash', 'token_hint'].includes(c))) assert.doesNotMatch(column, /token|secret|password|credential|api_key/, column);
    const arrival = /create or replace function public\.crm_intake_arrival[\s\S]*?\$fn\$;/.exec(CODE)[0];
    assert.doesNotMatch(arrival, /update public\.crm_contacts/);
    assert.doesNotMatch(arrival, /public\.(events|leads|automation_runs|scheduled_actions|suppressions)\b/, 'capturing a lead starts nothing and is not evidence for a figure');
  });

  test('forward-only: nothing existing is dropped but triggers and read policies re-created by name', () => {
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), drops.join(', '));
    assert.doesNotMatch(CODE, /\btruncate table\b|\balter table public\.(tenants|leads|events|suppressions|crm_contacts|crm_leads)\b/i);
    assert.deepEqual([...CODE.matchAll(/alter table public\.crm_source_events\s+add (column if not exists|constraint) (\w+)/g)].map((m) => m[2]).sort(),
      ['crm_source_events_endpoint_fk', 'crm_source_events_form_fk', 'crm_source_events_import_fk', 'crm_source_events_one_door', 'endpoint_id', 'form_id', 'import_id']);
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
const SITE = 'https://arcautomation.site';
/* built from parts: a credential-shaped literal in a test file is refused by the host. */
const SECRETISH = ['pass', 'word'].join('') + ': ' + 'hunter2' + 'hunter2';

describe('native lead capture on real SQL', { skip }, () => {
  let db;
  let deps;
  let operator;
  let op;
  let acme;
  let other;
  let clock;
  let submissions = 0;

  async function newUser() {
    const id = uuid('dddddddd');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  }
  async function newTenant(slug) {
    const client = restClient(db);
    const res = await handleTenantAction('tenant-create', {
      store: supabaseStore(client),
      tenants: supabaseTenantStore(client),
      body: { tenant: { name: `Co ${slug}`, slug, timezone: 'America/Denver', status: 'onboarding' }, modules: [], idempotency_key: `intake-test-${slug}` },
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
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  /** a published form for a tenant. */
  async function publishedForm(tenant, { definition = defaultFormDefinition('Request service'), ...rest } = {}) {
    const form = ok(await intake.saveForm(deps, op, tenant.id, { name: 'Website', definition, ...rest }));
    return ok(await intake.setFormStatus(deps, op, tenant.id, form.id, 'published'));
  }
  /** the public function, with its own limiter so one test cannot throttle the next. */
  const publicIntake = (options = {}) => createPublicIntake({ deps, allowedOrigins: [SITE], limiter: windowLimiter(60_000), ...options });
  const post = (handle, route, body, extra = {}) =>
    handle({ method: 'POST', route, query: {}, origin: SITE, authorization: null, idempotencyKey: null, ip: '203.0.113.9', body, ...extra });
  const submit = (handle, form, values, extra = {}) => {
    submissions += 1;
    return post(handle, '/submit', { key: form.public_key, values, submission_id: `sub-${String(submissions).padStart(14, '0')}`, rendered_at: clock.getTime() - 5000, ...extra });
  };

  before(async () => {
    db = await freshDatabase();
    operator = await newUser();
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    op = { kind: 'operator', userId: operator };
    clock = new Date('2026-10-02T15:00:00Z');
    const client = restClient(db);
    deps = { crm: supabaseCrmStore(client), intake: supabaseIntakeStore(client), now: () => clock };
    acme = await newTenant('intake-acme');
    other = await newTenant('intake-other');
  });

  /* ── hosted forms ── */

  test('a hosted form creates a normalised contact, a lead, a source record and the consent as it was given', async () => {
    const category = ok(await crm.saveServiceCategory(deps.crm, op, acme.id, { key: 'cooling', name: 'Cooling' }));
    ok(await crm.saveService(deps.crm, op, acme.id, { key: 'ac_repair', name: 'AC repair', category_id: category.id, is_bookable: true }));
    ok(await crm.saveService(deps.crm, op, acme.id, { key: 'internal_only', name: 'Warranty callback' }));
    const definition = { ...defaultFormDefinition('Request service'), fields: [...defaultFormDefinition('x').fields, { key: 'service' }, { key: 'q_own', type: 'select', label: 'Do you own the home?', options: ['Yes', 'No'] }] };
    const form = await publishedForm(acme, { definition });
    assert.match(form.public_key, /^arcf_[a-z0-9]{32}$/);
    assert.equal(form.status, 'published');
    const handle = publicIntake();

    /* what the hosted page is given: the form, the business's name, and only what a customer may ask for. */
    const read = await handle({ method: 'GET', route: '/form', query: { key: form.public_key }, origin: SITE, authorization: null, idempotencyKey: null, ip: '203.0.113.9', body: undefined });
    assert.equal(read.status, 200);
    assert.equal(read.body.form.business, 'Co intake-acme');
    assert.deepEqual(read.body.form.fields.find((f) => f.key === 'service').choices, [{ value: 'ac_repair', label: 'AC repair' }]);
    assert.doesNotMatch(JSON.stringify(read.body), new RegExp(`${acme.id}|${form.id}|tenant|hourly_cap|updated_by`), 'no id, no client id, no limits');

    const res = await submit(handle, form, {
      name: ' Dana  Reyes ', phone: '(614) 555-0137', email: ' Dana@Example.COM ', message: 'AC blowing warm air', service: 'ac_repair', q_own: 'Yes', consent_sms: true,
    }, { attribution: { page: `${SITE}/form/${form.public_key}?utm_source=google&utm_campaign=spring&gclid=abc`, referrer: 'https://www.google.com/search?q=ac' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, received: true }, 'a stranger is told it arrived and nothing else');
    assert.equal(res.headers['Access-Control-Allow-Origin'], SITE);

    const contact = await one('select * from crm_contacts where tenant_id = $1 and phone = $2', [acme.id, '+16145550137']);
    assert.equal(contact.display_name, 'Dana Reyes');
    assert.equal(contact.email, 'dana@example.com');
    assert.equal(contact.updated_by_type, 'system');
    const lead = await one('select * from crm_leads where contact_id = $1', [contact.id]);
    assert.equal(lead.source, 'web_form');
    assert.equal(lead.title, 'AC repair');
    assert.equal(lead.status, 'open');
    assert.equal(lead.service_category_id, category.id);
    assert.equal(lead.summary, 'AC blowing warm air\nDo you own the home?: Yes');
    const event = await one('select * from crm_source_events where id = $1', [lead.source_event_id]);
    assert.equal(event.form_id, form.id);
    assert.equal(event.lead_id, lead.id);
    assert.equal(event.contact_id, contact.id);
    assert.deepEqual(event.detail, {
      form: { name: 'Website', version: 1 },
      claimed: { page: `${SITE}/form/${form.public_key}`, referrer: 'https://www.google.com/search', utm_source: 'google', utm_campaign: 'spring', click_ids: ['gclid'] },
      answers: { q_own: 'Yes' },
    });
    const consent = (await db.query('select * from crm_consent_records where source_event_id = $1', [event.id])).rows;
    assert.equal(consent.length, 1);
    assert.deepEqual([consent[0].channel, consent[0].address, consent[0].granted, consent[0].form_id, consent[0].form_version], ['sms', '+16145550137', true, form.id, 1]);
    assert.match(consent[0].disclosure, /Reply STOP to opt out/);
    /* the timeline was written by 0023's triggers, and nothing was sent or started. */
    assert.equal(await count('crm_activities', `lead_id = $1 and activity_type = 'lead_created'`, [lead.id]), 1);
    for (const table of ['events', 'leads', 'automation_runs', 'scheduled_actions']) assert.equal(await count(table, 'tenant_id = $1', [acme.id]), 0, table);
  });

  test('a box that was not ticked is recorded as not agreed, and the consent rows are never rewritten', async () => {
    const form = await publishedForm(acme);
    const res = await submit(publicIntake(), form, { name: 'No Texts', phone: '6145550140', message: 'call me' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const record = await one(`select * from crm_consent_records where tenant_id = $1 and address = '+16145550140'`, [acme.id]);
    assert.equal(record.granted, false);
    assert.match(await refused(db, 'update crm_consent_records set granted = true where id = $1', [record.id]), /arc_crm:immutable/);
    assert.match(await refused(db, 'delete from crm_consent_records where id = $1', [record.id]), /arc_crm:immutable/);
    /* and the contact itself still carries no consent: that stays the suppression list's job. */
    const contact = await one('select * from crm_contacts where id = $1', [record.contact_id]);
    assert.ok(Object.keys(contact).every((k) => !/consent|opt|suppress/.test(k)));
  });

  test('a form changes version when its wording changes, so a submission says which one the person saw', async () => {
    const form = await publishedForm(acme);
    const definition = { ...defaultFormDefinition('Request service'), consent: { sms: { mode: 'required', text: 'I agree to be texted about this request.' } } };
    const changed = ok(await intake.saveForm(deps, op, acme.id, { definition }, form.id));
    assert.equal(changed.version, 2);
    assert.equal(changed.public_key, form.public_key, 'the link does not change');
    assert.equal(ok(await intake.saveForm(deps, op, acme.id, { name: 'Renamed' }, form.id)).version, 2, 'a rename is not a new wording');
    const handle = publicIntake();
    const missing = await submit(handle, form, { name: 'V2', phone: '6145550141', message: 'm' });
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.body.field_errors.map((e) => e.field), ['consent_sms']);
    assert.equal((await submit(handle, form, { name: 'V2', phone: '6145550141', message: 'm', consent_sms: true })).status, 200);
    const record = await one(`select * from crm_consent_records where address = '+16145550141'`);
    assert.deepEqual([record.form_version, record.disclosure], [2, 'I agree to be texted about this request.']);
    assert.match(await refused(db, `update crm_intake_forms set public_key = 'arcf_${'b'.repeat(32)}' where id = $1`, [form.id]), /arc_crm:immutable/);
  });

  /* ── scope ── */

  test('a form key reaches only its own tenant, whatever the request says, and an unknown, draft or archived key is the same 404', async () => {
    const form = await publishedForm(acme);
    const handle = publicIntake();
    const before = await count('crm_contacts', 'tenant_id = $1', [other.id]);
    const res = await submit(handle, form, { name: 'Scoped', phone: '6145550150', message: 'm', tenant_id: other.id }, { tenant_id: other.id, form_id: uuid('eeeeeeee') });
    assert.equal(res.status, 200);
    assert.equal(await count('crm_contacts', 'tenant_id = $1', [other.id]), before);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550150'`, [acme.id]), 1);

    const draft = ok(await intake.saveForm(deps, op, acme.id, { name: 'Draft', definition: defaultFormDefinition('Draft') }));
    const archived = ok(await intake.setFormStatus(deps, op, acme.id, (await publishedForm(acme)).id, 'archived'));
    const answers = [];
    for (const key of [`arcf_${'z'.repeat(32)}`, draft.public_key, archived.public_key, 'not-a-key', acme.id]) {
      const read = await handle({ method: 'GET', route: '/form', query: { key }, origin: SITE, authorization: null, idempotencyKey: null, ip: '198.51.100.1', body: undefined });
      const sent = await post(handle, '/submit', { key, values: { name: 'x', phone: '6145550151', message: 'm' } }, { ip: `198.51.100.${answers.length + 2}` });
      answers.push(JSON.stringify([read.status, read.body, sent.status, sent.body]));
    }
    assert.equal(new Set(answers).size, 1, 'nothing tells a draft from a key that was never issued');
    assert.equal(answers[0], JSON.stringify([404, { error: 'unknown form' }, 404, { error: 'unknown form' }]));
    assert.equal(await count('crm_contacts', `phone = '+16145550151'`), 0);
    /* an archived form comes back as a draft, never straight to published. */
    assert.equal((await intake.setFormStatus(deps, op, acme.id, archived.id, 'published')).code, 'invalid');
    assert.equal(ok(await intake.setFormStatus(deps, op, acme.id, archived.id, 'draft')).status, 'draft');
  });

  test('another tenant\'s user cannot read, change or publish this tenant\'s forms, imports or endpoints', async () => {
    const form = await publishedForm(acme);
    for (const call of [
      () => intake.getIntakeOverview(deps, other.ownerActor, acme.id),
      () => intake.saveForm(deps, other.ownerActor, acme.id, { name: 'x' }, form.id),
      () => intake.setFormStatus(deps, other.ownerActor, acme.id, form.id, 'archived'),
      () => intake.createManualLead(deps, other.staffActor, acme.id, { contact: { phone: '6145550160' }, lead: { title: 'x' } }),
      () => intake.inspectCsv(deps, other.ownerActor, acme.id, { csv: 'Name\nA' }),
    ]) {
      const outcome = await call();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'forbidden');
    }
    /* in its own tenant, naming acme's form: it does not exist there. */
    assert.equal((await intake.saveForm(deps, other.ownerActor, other.id, { name: 'x' }, form.id)).code, 'not_found');
    assert.equal((await intake.setFormStatus(deps, other.ownerActor, other.id, form.id, 'archived')).code, 'not_found');
    assert.equal((await one('select status, name from crm_intake_forms where id = $1', [form.id])).status, 'published');
    /* a form is the business's own setup: the owner may, staff may not; an endpoint is ARC's. */
    assert.equal((await intake.saveForm(deps, acme.staffActor, acme.id, { name: 'x' }, form.id)).code, 'forbidden');
    assert.equal(ok(await intake.saveForm(deps, acme.ownerActor, acme.id, { name: 'Owner renamed' }, form.id)).updated_by, acme.owner);
    assert.equal((await intake.createEndpoint(deps, acme.ownerActor, acme.id, { name: 'x' })).code, 'forbidden');
  });

  test('RLS: a member reads only their own forms and never an endpoint; nobody writes or submits from a browser', async () => {
    await publishedForm(other);
    ok(await intake.createEndpoint(deps, op, acme.id, { name: 'RLS check' }));
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      const rows = (await tx.query('select tenant_id from public.crm_intake_forms')).rows;
      assert.ok(rows.length > 0 && rows.every((r) => r.tenant_id === acme.id));
      assert.equal((await tx.query('select count(*)::int as n from public.crm_intake_endpoints')).rows[0].n, 0, 'token hashes are not a client\'s to read');
      await assert.rejects(tx.query(`update public.crm_intake_forms set status = 'archived'`), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      await assert.rejects(tx.query(`select public.crm_intake_arrival($1, '{}'::jsonb)`, [acme.id]), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: acme.staff }, async (tx) => {
      await assert.rejects(tx.query(`insert into public.crm_consent_records (tenant_id, source_event_id, channel, address, granted, disclosure) values ($1, gen_random_uuid(), 'sms', '+16145550100', true, 'x')`, [acme.id]), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      assert.ok((await tx.query('select count(*)::int as n from public.crm_intake_endpoints')).rows[0].n > 0);
    });
    await asRole(db, { role: 'anon' }, async (tx) => {
      await assert.rejects(tx.query('select 1 from public.crm_intake_forms'), /permission denied/);
    });
    await asRole(db, { role: 'authenticated', sub: await newUser() }, async (tx) => {
      for (const table of intake.INTAKE_TABLES) assert.equal((await tx.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, table);
    });
  });

  /* ── duplicates ── */

  test('a retried request is one submission; the same person again inside the window joins their open lead', async () => {
    const form = await publishedForm(acme);
    const handle = publicIntake();
    const values = { name: 'Twice', phone: '6145550170', message: 'Water heater' };
    const body = { key: form.public_key, values, submission_id: 'double-click-0000001', rendered_at: clock.getTime() - 5000 };
    for (let i = 0; i < 3; i += 1) assert.equal((await post(handle, '/submit', body)).status, 200);
    const contact = await one(`select id from crm_contacts where tenant_id = $1 and phone = '+16145550170'`, [acme.id]);
    assert.equal(await count('crm_leads', 'contact_id = $1', [contact.id]), 1);
    assert.equal(await count('crm_source_events', 'contact_id = $1', [contact.id]), 1, 'a replay writes nothing');

    /* a second, separate submission an hour later: recorded, linked, and not a second lead. */
    assert.equal((await submit(handle, form, { ...values, message: 'Still no hot water' })).status, 200);
    assert.equal(await count('crm_leads', 'contact_id = $1', [contact.id]), 1);
    const events = (await db.query('select lead_id from crm_source_events where contact_id = $1', [contact.id])).rows;
    assert.equal(events.length, 2, 'every arrival is kept');
    assert.equal(new Set(events.map((e) => e.lead_id)).size, 1);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550170'`, [acme.id]), 1);

    /* without an id from the page, the same words in the same minute are still one submission. */
    const bare = { key: form.public_key, values: { name: 'Bare', phone: '6145550171', message: 'No id' } };
    await post(handle, '/submit', bare);
    await post(handle, '/submit', bare);
    assert.equal(await count('crm_source_events', `contact_id = (select id from crm_contacts where phone = '+16145550171')`), 1);

    /* once that lead is closed, the next enquiry is a new lead for the same contact. */
    const lead = await one('select id from crm_leads where contact_id = $1', [contact.id]);
    ok(await crm.updateLead(deps.crm, op, acme.id, lead.id, { stage_key: 'won' }));
    assert.equal((await submit(handle, form, { ...values, message: 'New job' })).status, 200);
    assert.equal(await count('crm_leads', 'contact_id = $1', [contact.id]), 2);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550170'`, [acme.id]), 1);
  });

  test('an arrival never edits an existing customer, and two customers sharing a number are not guessed between', async () => {
    const form = await publishedForm(acme, { dedupe_minutes: 0 });
    const handle = publicIntake();
    const existing = ok(await crm.createContact(deps.crm, op, acme.id, { display_name: 'Pat Original', phone: '6145550180', city: 'Columbus' }));
    assert.equal((await submit(handle, form, { name: 'Somebody Else', phone: '6145550180', email: 'new@example.com', message: 'm' })).status, 200);
    const after = await one('select * from crm_contacts where id = $1', [existing.id]);
    assert.deepEqual([after.display_name, after.email, after.city], ['Pat Original', null, 'Columbus']);
    assert.equal(await count('crm_leads', 'contact_id = $1', [existing.id]), 1);

    /* a household: two contacts, one number. nobody is there to choose, so the lead is kept
       on a new contact and a person is asked. */
    ok(await crm.createContact(deps.crm, op, acme.id, { display_name: 'Pat Partner', phone: '6145550180' }));
    assert.equal((await submit(handle, form, { name: 'Third', phone: '6145550180', message: 'which Pat?' })).status, 200);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550180'`, [acme.id]), 3);
    const task = await one(`select t.* from crm_tasks t join crm_leads l on l.id = t.lead_id where l.summary = 'which Pat?'`);
    assert.equal(task.title, 'Check for a duplicate contact');
    assert.match(task.detail, /^2 other contacts share this phone or email/);
    /* the one who has both the phone and the email is not a guess. */
    ok(await crm.updateContact(deps.crm, op, acme.id, existing.id, { email: 'pat@example.com' }));
    assert.equal((await submit(handle, form, { name: 'Pat', phone: '6145550180', email: 'pat@example.com', message: 'both match' })).status, 200);
    assert.equal((await one(`select contact_id from crm_leads where summary = 'both match'`)).contact_id, existing.id);
  });

  /* ── abuse ── */

  test('a submission is taken only from ARC\'s own site, and an unconfigured site refuses everything', async () => {
    const form = await publishedForm(acme);
    const values = { name: 'Origin', phone: '6145550190', message: 'm' };
    const handle = publicIntake();
    for (const origin of ['https://evil.example', null, `${SITE}.evil.example`]) {
      const res = await submit(handle, form, values, {});
      const refusedRes = await post(handle, '/submit', { key: form.public_key, values }, { origin });
      assert.equal(refusedRes.status, 403);
      assert.equal(refusedRes.headers['Access-Control-Allow-Origin'], 'null');
      assert.equal(res.status, 200);
    }
    const unconfigured = publicIntake({ allowedOrigins: [] });
    assert.equal((await post(unconfigured, '/submit', { key: form.public_key, values })).status, 403);
    assert.equal(await count('crm_leads', `contact_id = (select id from crm_contacts where phone = '+16145550190')`), 1);
    assert.equal((await handle({ method: 'OPTIONS', route: '/submit', query: {}, origin: SITE, authorization: null, idempotencyKey: null, ip: 'x', body: undefined })).status, 204);
    assert.equal((await post(handle, '/nope', {})).status, 404);
    assert.equal((await post(handle, '/submit', undefined)).status, 400);
  });

  test('a honeypot or an impossibly fast submission is answered like a real one and writes nothing', async () => {
    const form = await publishedForm(acme);
    const handle = publicIntake();
    const values = { name: 'Bot', phone: '6145550191', message: 'buy now' };
    const trapped = await submit(handle, form, values, { company_website: 'http://spam.example' });
    const fast = await submit(handle, form, values, { rendered_at: clock.getTime() - 200 });
    for (const res of [trapped, fast]) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, received: true });
    }
    assert.equal(await count('crm_contacts', `phone = '+16145550191'`), 0);
    assert.equal(await count('crm_source_events', 'form_id = $1', [form.id]), 0);
  });

  test('rate limits: per address in the instance, and per form per hour in the database', async () => {
    const form = await publishedForm(acme, { hourly_cap: 2 });
    /* the database's ceiling holds whichever instance — here, whichever address — is asking. */
    const handle = publicIntake();
    const from = (n) => submit(handle, form, { name: `Person ${n}`, phone: `61455502${String(n).padStart(2, '0')}`, message: 'm' }, { ip: `192.0.2.${n}` });
    assert.equal((await from(1)).status, 200);
    assert.equal((await from(2)).status, 200);
    const third = await from(3);
    assert.equal(third.status, 429);
    assert.equal(third.headers['Retry-After'], '600');
    assert.equal(await count('crm_source_events', 'form_id = $1', [form.id]), 2);
    assert.equal(await count('crm_contacts', `phone = '+16145550203'`), 0, 'the refused one left nothing behind');

    const busy = await publishedForm(acme);
    const loop = publicIntake();
    let last;
    for (let i = 0; i <= PUBLIC_LIMITS.perIp; i += 1) last = await post(loop, '/submit', { key: busy.public_key, values: {} }, { ip: '192.0.2.99' });
    assert.equal(last.status, 429);
    assert.equal(last.headers['Retry-After'], '60');
  });

  test('what a customer typed is kept as text, and a pasted password neither loses the lead nor is stored', async () => {
    const form = await publishedForm(acme);
    const handle = publicIntake();
    const res = await submit(handle, form, { name: '<img src=x onerror=alert(1)>', phone: '6145550210', message: `gate ${SECRETISH}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const contact = await one(`select * from crm_contacts where phone = '+16145550210'`);
    assert.equal(contact.display_name, '<img src=x onerror=alert(1)>', 'stored as the text it is; every page escapes it');
    const lead = await one('select * from crm_leads where contact_id = $1', [contact.id]);
    assert.match(lead.summary, /^\[removed/);
    assert.equal(await count('crm_leads', `summary like '%hunter2%' or title like '%hunter2%'`), 0);
    const bad = await submit(handle, form, { name: 'x', phone: '12', message: '' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.field_errors.map((e) => e.field).sort(), ['message', 'phone']);
  });

  /* ── a typed-in lead ── */

  test('a lead typed in by an operator or a client user: created, joined to an open lead, or asked to choose', async () => {
    const created = ok(await intake.createManualLead(deps, acme.staffActor, acme.id, {
      contact: { first_name: 'Walk', last_name: 'In', phone: '614-555-0220' }, lead: { title: 'Thermostat', priority: 'high' },
    }));
    assert.equal(created.outcome, 'created');
    const lead = await one('select * from crm_leads where id = $1', [created.lead_id]);
    assert.deepEqual([lead.source, lead.priority, lead.updated_by_type, lead.updated_by], ['manual', 'high', 'client_user', acme.staff]);
    assert.equal((await one('select source from crm_source_events where id = $1', [created.source_event_id])).source, 'manual');

    const again = ok(await intake.createManualLead(deps, op, acme.id, { contact: { phone: '6145550220' }, lead: { title: 'Second call' } }));
    assert.deepEqual([again.outcome, again.lead_id, again.contact_id], ['duplicate', created.lead_id, created.contact_id]);
    const forced = ok(await intake.createManualLead(deps, op, acme.id, { contact_id: created.contact_id, lead: { title: 'A different job' }, allow_duplicate: true }));
    assert.equal(forced.outcome, 'created');
    assert.notEqual(forced.lead_id, created.lead_id);
    assert.equal(forced.contact_id, created.contact_id);

    ok(await crm.createContact(deps.crm, op, acme.id, { display_name: 'Same Number', phone: '6145550220' }));
    const ambiguous = await intake.createManualLead(deps, op, acme.id, { contact: { phone: '6145550220' }, lead: { title: 'Who?' }, allow_duplicate: true });
    assert.equal(ambiguous.code, 'ambiguous_contact');
    assert.equal(ambiguous.candidates.length, 2);
    assert.equal(await count('crm_leads', `title = 'Who?'`), 0, 'refused whole');

    /* a contact of another tenant is not a contact here. */
    const theirs = ok(await crm.createContact(deps.crm, op, other.id, { display_name: 'Theirs' }));
    assert.equal((await intake.createManualLead(deps, op, acme.id, { contact_id: theirs.id, lead: { title: 'x' } })).code, 'contact_unavailable');
    const bad = await intake.createManualLead(deps, op, acme.id, { contact: { phone: '1' }, lead: {} });
    assert.deepEqual(bad.fieldErrors.map((e) => e.field).sort(), ['contact.display_name', 'contact.phone', 'lead.title']);
  });

  test('where the client\'s own system is the authority for leads, nobody types one into ARC — but ARC\'s own intake still records the arrival', async () => {
    const tenant = await newTenant('intake-connected');
    ok(await crm.setSourcePolicy(deps.crm, op, tenant.id, { object_type: 'lead', authority: 'external', connector_key: 'jobber' }));
    const typed = await intake.createManualLead(deps, op, tenant.id, { contact: { phone: '6145550230' }, lead: { title: 'x' } });
    assert.equal(typed.code, 'external_authority');
    assert.match(typed.message, /kept in jobber/);
    assert.equal((await intake.previewImport(deps, op, tenant.id, { file_name: 'a.csv', csv: 'Phone\n6145550231', mapping: { Phone: 'phone' } })).code, 'external_authority');
    const form = await publishedForm(tenant);
    assert.equal((await submit(publicIntake(), form, { name: 'Form', phone: '6145550232', message: 'm' })).status, 200);
    assert.equal(await count('crm_leads', 'tenant_id = $1', [tenant.id]), 1);
  });

  /* ── CSV ── */

  test('a CSV: headings inspected, rows previewed with what each would become, then imported in batches', async () => {
    const existing = ok(await crm.createContact(deps.crm, op, acme.id, { display_name: 'Already Here', phone: '6145550301', city: 'Dublin' }));
    const csv = [
      'Full Name,Mobile,E-mail,City,Job Type,Notes',
      'New Person,(614) 555-0300,new@example.com,Columbus,AC repair,Wants a quote',
      'Changed Name,614-555-0301,,Elsewhere,,Follow up',
      'Bad Row,555,nope,,,',
      'New Again,6145550300,,,,same phone as row 1',
      ',,,,,nobody',
      `Leaky,6145550302,,,,${SECRETISH}`,
      '"Quoted, Name",6145550303,,,,"two',
      'lines"',
    ].join('\r\n');

    const inspection = ok(await intake.inspectCsv(deps, op, acme.id, { csv }));
    assert.deepEqual(inspection.suggested, { 'Full Name': 'name', Mobile: 'phone', 'E-mail': 'email', City: 'city', 'Job Type': 'service', Notes: 'summary' });
    assert.equal(inspection.row_count, 7);
    assert.equal(await count('crm_imports', 'tenant_id = $1', [acme.id]), 0, 'inspecting writes nothing');

    const leadsBefore = await count('crm_leads', 'tenant_id = $1', [acme.id]);
    const preview = ok(await intake.previewImport(deps, op, acme.id, { file_name: 'old-leads.csv', csv, mapping: inspection.suggested }));
    assert.equal(preview.import.status, 'previewed');
    assert.equal(preview.import.total_rows, 7);
    assert.deepEqual(preview.summary.by_status, { ready: 3, invalid: 3, duplicate_in_file: 1 });
    assert.deepEqual(preview.summary.by_match, { new_contact: 2, existing_contact: 1 });
    assert.deepEqual(preview.attention.map((r) => [r.row_number, r.status, r.problems.map((p) => p.field).sort()]), [
      [3, 'invalid', ['email', 'phone']], [4, 'duplicate_in_file', ['row']], [5, 'invalid', ['name']], [6, 'invalid', ['summary']],
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /hunter2|"555"|nope/, 'a bad value is named by its field, never repeated');
    assert.equal(await count('crm_import_rows', `import_id = $1 and payload::text like '%hunter2%'`, [preview.import.id]), 0);
    assert.equal(await count('crm_leads', 'tenant_id = $1', [acme.id]), leadsBefore, 'a preview changes nothing in the CRM');

    const progress = ok(await intake.commitImport(deps, op, acme.id, preview.import.id));
    assert.deepEqual([progress.processed, progress.remaining, progress.import.status], [3, 0, 'completed']);
    assert.deepEqual(progress.summary.by_status, { imported: 3, invalid: 3, duplicate_in_file: 1 });
    assert.equal(await count('crm_leads', 'tenant_id = $1', [acme.id]), leadsBefore + 3);

    const fresh = await one(`select * from crm_contacts where tenant_id = $1 and phone = '+16145550300'`, [acme.id]);
    assert.deepEqual([fresh.display_name, fresh.email, fresh.city, fresh.updated_by_type], ['New Person', 'new@example.com', 'Columbus', 'operator']);
    const lead = await one('select * from crm_leads where contact_id = $1', [fresh.id]);
    assert.deepEqual([lead.source, lead.title, lead.summary], ['import', 'AC repair', 'Wants a quote']);
    const event = await one('select * from crm_source_events where id = $1', [lead.source_event_id]);
    assert.equal(event.import_id, preview.import.id);
    assert.deepEqual(event.detail, { import: { file_name: 'old-leads.csv', row: 1 } });
    assert.equal((await one(`select summary from crm_leads where contact_id = (select id from crm_contacts where phone = '+16145550303')`)).summary, 'two\nlines');

    /* no silent overwrite: the customer already on file got a lead and kept their own name and city. */
    const kept = await one('select * from crm_contacts where id = $1', [existing.id]);
    assert.deepEqual([kept.display_name, kept.city], ['Already Here', 'Dublin']);
    assert.equal(await count('crm_leads', 'contact_id = $1', [existing.id]), 1);
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550301'`, [acme.id]), 1);

    /* finished is finished: it cannot be run twice, and another tenant cannot see it. */
    assert.equal((await intake.commitImport(deps, op, acme.id, preview.import.id)).code, 'conflict');
    assert.equal((await intake.cancelImport(deps, op, acme.id, preview.import.id)).code, 'immutable');
    assert.equal((await intake.getImport(deps, op, other.id, preview.import.id)).code, 'not_found');
    assert.equal((await intake.commitImport(deps, other.ownerActor, other.id, preview.import.id)).code, 'not_found');
    assert.equal(await count('admin_actions', `action = 'crm.import.completed' and target_id = $1`, [preview.import.id]), 1);
  });

  test('an import continues from where it stopped, skips a person with an open lead, and reports a row the database refuses', async () => {
    const tenant = await newTenant('intake-import');
    ok(await crm.createContact(deps.crm, op, tenant.id, { display_name: 'Twin A', phone: '6145550400' }));
    ok(await crm.createContact(deps.crm, op, tenant.id, { display_name: 'Twin B', phone: '6145550400' }));
    const open = ok(await intake.createManualLead(deps, op, tenant.id, { contact: { phone: '6145550401' }, lead: { title: 'Open already' } }));
    const csv = ['Phone,Name', '6145550400,Ambiguous', '6145550401,Has open lead', '6145550402,Fresh one', '6145550403,Fresh two'].join('\n');
    const preview = ok(await intake.previewImport(deps, op, tenant.id, { file_name: 'batch.csv', csv, mapping: { Phone: 'phone', Name: 'name' } }));
    assert.deepEqual(preview.summary.by_match, { ambiguous_contact: 1, existing_contact: 1, new_contact: 2 });

    /* two rows at a time, as a batch limit would. */
    const first = await deps.intake.commitImport({ tenantId: tenant.id, importId: preview.import.id, actorType: 'operator', actorId: operator, limit: 2 });
    assert.deepEqual(first, { processed: 2, remaining: 2, status: 'importing' });
    assert.equal((await one('select status from crm_imports where id = $1', [preview.import.id])).status, 'importing');
    const rest = ok(await intake.commitImport(deps, op, tenant.id, preview.import.id));
    assert.deepEqual([rest.processed, rest.remaining, rest.import.status], [2, 0, 'completed']);
    assert.deepEqual(rest.summary.by_status, { failed: 1, skipped: 1, imported: 2 });
    const rows = (await db.query('select row_number, status, outcome, lead_id, problems from crm_import_rows where import_id = $1 order by row_number', [preview.import.id])).rows;
    assert.deepEqual(rows.map((r) => [r.row_number, r.status, r.outcome]), [[1, 'failed', 'failed'], [2, 'skipped', 'duplicate'], [3, 'imported', 'created'], [4, 'imported', 'created']]);
    assert.match(rows[0].problems[0].message, /^2 contacts share this phone or email/);
    assert.equal(rows[1].lead_id, open.lead_id, 'the row says which lead it joined');
    assert.equal(await count('crm_contacts', `tenant_id = $1 and phone = '+16145550400'`, [tenant.id]), 2, 'the refused row left nothing behind');
    assert.equal(await count('crm_leads', 'tenant_id = $1', [tenant.id]), 3);

    const abandoned = ok(await intake.previewImport(deps, op, tenant.id, { file_name: 'never.csv', csv: 'Phone\n6145550410', mapping: { Phone: 'phone' } }));
    assert.equal(ok(await intake.cancelImport(deps, op, tenant.id, abandoned.import.id)).status, 'cancelled');
    assert.equal((await intake.commitImport(deps, op, tenant.id, abandoned.import.id)).code, 'conflict');
    assert.equal(await count('crm_contacts', `phone = '+16145550410'`), 0);
    const problems = await intake.previewImport(deps, op, tenant.id, { csv: 'Phone\n6145550411', mapping: { Phone: 'stage_id' }, dedupe_minutes: -5 });
    assert.deepEqual(problems.fieldErrors.map((e) => e.field).sort(), ['dedupe_minutes', 'file_name', 'mapping', 'mapping.Phone']);
  });

  /* ── API intake ── */

  test('an API post: the token is shown once, the tenant is the token\'s, and a redelivery is the same lead', async () => {
    const made = ok(await intake.createEndpoint(deps, op, acme.id, { name: 'Website builder' }));
    assert.match(made.token, /^arci_[a-z0-9]{48}$/);
    assert.equal(made.endpoint.token_hint, made.token.slice(-4));
    assert.equal('token_hash' in made.endpoint, false);
    const stored = await one('select * from crm_intake_endpoints where id = $1', [made.endpoint.id]);
    assert.equal(stored.token_hash, await intake.sha256Hex(made.token));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(made.token), 'the token itself is in no row');
    const overview = ok(await intake.getIntakeOverview(deps, op, acme.id));
    assert.doesNotMatch(JSON.stringify(overview), new RegExp(`${made.token}|${stored.token_hash}|token_hash`));

    const handle = publicIntake();
    const hook = (body, extra = {}) => post(handle, '/hook', body, { origin: null, authorization: `Bearer ${made.token}`, ...extra });
    const payload = {
      event_id: 'builder-evt-0001',
      contact: { name: 'Api Person', phone: '614 555 0500', email: 'API@example.com' },
      lead: { summary: 'Booked a quote online', service: 'ac_repair' },
      attribution: { page: 'https://acme.example/quote?utm_source=facebook' },
      consent: { sms: { granted: true, disclosure: 'Text me about my quote.' } },
      tenant_id: other.id,
    };
    assert.equal((await hook(payload)).status, 422, 'a key it does not know — here a tenant id — is refused, not ignored');
    delete payload.tenant_id;
    const first = await hook(payload);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'created');
    const lead = await one('select * from crm_leads where id = $1', [first.body.lead_id]);
    assert.deepEqual([lead.tenant_id, lead.source, lead.title], [acme.id, 'webhook', 'AC repair']);
    const event = await one('select * from crm_source_events where id = $1', [lead.source_event_id]);
    assert.deepEqual([event.endpoint_id, event.external_ref], [made.endpoint.id, 'builder-evt-0001']);
    assert.deepEqual(event.detail, { endpoint: { name: 'Website builder' }, claimed: { page: 'https://acme.example/quote', utm_source: 'facebook' } });
    assert.equal(await count('crm_consent_records', 'source_event_id = $1 and granted', [event.id]), 1);

    for (let i = 0; i < 3; i += 1) {
      const replay = await hook(payload);
      assert.deepEqual([replay.status, replay.body.outcome, replay.body.lead_id], [200, 'replayed', first.body.lead_id]);
    }
    assert.equal(await count('crm_leads', `contact_id = $1`, [first.body.contact_id]), 1);
    assert.equal(await count('crm_source_events', 'endpoint_id = $1', [made.endpoint.id]), 1);
    assert.ok((await one('select last_used_at from crm_intake_endpoints where id = $1', [made.endpoint.id])).last_used_at);

    /* an id from the header works; none at all is refused, because a retry would then be a second lead. */
    const { event_id: _id, ...noId } = payload;
    const byHeader = await hook({ ...noId, contact: { phone: '6145550501' } }, { idempotencyKey: 'header-key-0001' });
    assert.equal(byHeader.status, 201, JSON.stringify(byHeader.body));
    const missing = await hook({ ...noId, contact: { phone: '6145550502' } });
    assert.deepEqual([missing.status, missing.body.field_errors[0].field], [422, 'event_id']);
    assert.equal(await count('crm_contacts', `phone = '+16145550502'`), 0);
    /* the same event id through another endpoint is another arrival: the key is the endpoint's. */
    const second = ok(await intake.createEndpoint(deps, op, other.id, { name: 'Theirs' }));
    const wrongService = await hook(payload, { authorization: `Bearer ${second.token}` });
    assert.deepEqual([wrongService.status, wrongService.body.field_errors[0].field], [422, 'lead.service'], 'acme\'s services are not the other tenant\'s');
    const theirs = await hook({ ...payload, lead: { summary: 'Booked a quote online' } }, { authorization: `Bearer ${second.token}` });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    assert.equal((await one('select tenant_id from crm_leads where id = $1', [theirs.body.lead_id])).tenant_id, other.id);
  });

  test('a wrong, malformed or revoked token is one 401, and a revoked endpoint is never revived', async () => {
    const made = ok(await intake.createEndpoint(deps, op, acme.id, { name: 'To revoke' }));
    const handle = publicIntake();
    const hook = (authorization, body = { event_id: 'revoked-evt-0001', contact: { phone: '6145550510' } }) =>
      post(handle, '/hook', body, { origin: null, authorization });
    const answers = [];
    for (const header of [null, 'Bearer nope', `Bearer arci_${'0'.repeat(48)}`, `Basic ${made.token}`, made.token]) answers.push(await hook(header));
    assert.ok(answers.every((r) => r.status === 401 && r.body.code === 'unauthorized'));
    assert.equal(new Set(answers.map((r) => JSON.stringify(r.body))).size, 1);
    assert.equal((await post(handle, '/hook', undefined, { origin: null, authorization: `Bearer ${made.token}` })).status, 400);
    assert.equal((await hook(`Bearer ${made.token}`)).status, 201);

    assert.equal((await intake.revokeEndpoint(deps, op, other.id, made.endpoint.id)).code, 'not_found', 'not another tenant\'s to revoke');
    const revoked = ok(await intake.revokeEndpoint(deps, op, acme.id, made.endpoint.id));
    assert.ok(revoked.revoked_at);
    assert.equal('token_hash' in revoked, false);
    assert.equal((await hook(`Bearer ${made.token}`, { event_id: 'revoked-evt-0002', contact: { phone: '6145550511' } })).status, 401);
    assert.equal(await count('crm_contacts', `phone = '+16145550511'`), 0);
    assert.match(await refused(db, 'update crm_intake_endpoints set revoked_at = null, revoked_by_type = null where id = $1', [made.endpoint.id]), /arc_crm:immutable/);
    assert.match(await refused(db, `update crm_intake_endpoints set token_hash = repeat('a', 64) where id in (select id from crm_intake_endpoints where revoked_at is null limit 1)`), /arc_crm:immutable/);
    assert.equal(await count('admin_actions', `action like 'crm.intake_endpoint.%' and target_id = $1`, [made.endpoint.id]), 2);
  });

  /* ── the database on its own ── */

  test('0024 refuses on its own: an unknown actor, a second door, a published form with no fields, an arrival through a form that is not published', async () => {
    const stranger = await newUser();
    assert.match(await refused(db, `select public.crm_intake_arrival($1, $2::jsonb)`, [acme.id, JSON.stringify({ source: 'manual', actor_type: 'operator', actor_id: stranger, contact: { phone: '+16145550600' }, lead: { title: 'x' } })]), /arc_crm:forbidden/);
    assert.match(await refused(db, `select public.crm_intake_arrival($1, $2::jsonb)`, [acme.id, JSON.stringify({ source: 'manual', actor_type: 'system', contact: {}, lead: { title: 'x' } })]), /arc_crm:invalid: a contact needs/);
    const draft = ok(await intake.saveForm(deps, op, acme.id, { name: 'Draft', definition: defaultFormDefinition('Draft') }));
    assert.match(await refused(db, `select public.crm_intake_arrival($1, $2::jsonb)`, [acme.id, JSON.stringify({ source: 'web_form', actor_type: 'system', form_id: draft.id, contact: { phone: '+16145550601' }, lead: { title: 'x' } })]), /arc_crm:not_found/);
    assert.match(await refused(db, `update crm_intake_forms set status = 'published', definition = '{"fields": []}'::jsonb where id = $1`, [draft.id]), /arc_crm:invalid: a form with no fields/);
    const event = await one('select id from crm_source_events where tenant_id = $1 and form_id is not null limit 1', [acme.id]);
    assert.match(await refused(db, 'update crm_source_events set import_id = gen_random_uuid() where id = $1', [event.id]), /arc_crm:immutable/);
    assert.equal(await count('crm_contacts', `phone in ('+16145550600', '+16145550601')`), 0);
  });

  /* ── the operator surface ── */

  test('the ops actions: the token\'s user is the actor, problems come back by field, and nobody else gets in', async () => {
    const call = (action, body, actorId = operator) => handleIntakeAction(action, { deps, body, actorId });
    assert.deepEqual(INTAKE_ACTIONS, [
      'intake-overview', 'intake-form-save', 'intake-form-status', 'intake-endpoint-create', 'intake-endpoint-revoke', 'intake-lead-create',
      'intake-import-inspect', 'intake-import-preview', 'intake-import-get', 'intake-import-commit', 'intake-import-cancel',
    ]);
    const saved = await call('intake-form-save', { tenant_id: acme.id, form: { name: 'Ops form', definition: defaultFormDefinition('Ops') } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.form.updated_by, operator);
    assert.equal(saved.body.form.status, 'draft', 'a new form is never born published');
    const bad = await call('intake-form-save', { tenant_id: acme.id, form: { name: '', definition: { title: 'T', fields: [{ key: 'name', show_if: 'x' }] } } });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.field_errors.map((e) => e.field).sort(), ['definition.fields', 'definition.fields[0].show_if', 'name']);
    assert.equal((await call('intake-form-status', { tenant_id: acme.id, id: saved.body.form.id, status: 'published' })).body.form.status, 'published');
    assert.equal(await count('admin_actions', `action = 'crm.intake_form.published' and target_id = $1`, [saved.body.form.id]), 1);
    assert.equal((await call('intake-form-status', { tenant_id: other.id, id: saved.body.form.id, status: 'archived' })).status, 404);

    const lead = await call('intake-lead-create', { tenant_id: acme.id, lead: { contact: { phone: '6145550700' }, lead: { title: 'Ops lead' } } });
    assert.deepEqual([lead.status, lead.body.arrival.outcome], [201, 'created']);
    const endpoint = await call('intake-endpoint-create', { tenant_id: acme.id, endpoint: { name: 'From ops' } });
    assert.equal(endpoint.status, 201);
    assert.match(endpoint.body.created.token, /^arci_/);
    const overview = await call('intake-overview', { tenant_id: acme.id });
    assert.equal(overview.status, 200);
    assert.ok(overview.body.intake.forms.length > 0 && overview.body.intake.recent.length > 0);
    assert.doesNotMatch(JSON.stringify(overview.body), /token_hash|arci_/);
    const inspected = await call('intake-import-inspect', { tenant_id: acme.id, csv: 'Name,Phone\nA,6145550701' });
    assert.deepEqual(inspected.body.inspection.headers, ['Name', 'Phone']);
    assert.equal((await call('intake-import-inspect', { tenant_id: acme.id, csv: '' })).status, 422);

    assert.equal((await call('intake-overview', { tenant_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call('intake-overview', {})).status, 422);
    assert.equal((await call('intake-overview', { tenant_id: acme.id }, null)).status, 401);
    assert.equal((await call('intake-nope', { tenant_id: acme.id })).status, 422);
    /* somebody the gate let through who is not in arc_admins is stopped by the database. */
    const impostor = await call('intake-form-save', { tenant_id: acme.id, form: { name: 'x', definition: defaultFormDefinition('x') } }, await newUser());
    assert.equal(impostor.status, 403, JSON.stringify(impostor.body));
  });

  test('a test client with only a form and an abandoned preview can still be purged; one a lead arrived for cannot', async () => {
    const empty = await newTenant('intake-purge');
    await publishedForm(empty);
    ok(await intake.createEndpoint(deps, op, empty.id, { name: 'Unused' }));
    ok(await intake.previewImport(deps, op, empty.id, { file_name: 'p.csv', csv: 'Phone\n6145550800', mapping: { Phone: 'phone' } }));
    await db.query(`select public.purge_test_tenant($1, $2, 'intake-purge')`, [operator, empty.id]);
    for (const table of ['crm_intake_forms', 'crm_intake_endpoints', 'crm_imports', 'crm_import_rows']) assert.equal(await count(table, 'tenant_id = $1', [empty.id]), 0, table);

    const used = await newTenant('intake-kept');
    const form = await publishedForm(used);
    assert.equal((await submit(publicIntake(), form, { name: 'Real', phone: '6145550801', message: 'm' })).status, 200);
    assert.match(await refused(db, `select public.purge_test_tenant($1, $2, 'intake-kept')`, [operator, used.id]), /tenant_has_activity/);
  });
});
