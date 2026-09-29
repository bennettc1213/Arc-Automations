/* ARC-300 — creating a client and choosing its modules, against real Postgres.
 *
 * Two parts, as for 0015:
 *
 *   1. The text of 0021, always: the function is the service role's alone, the browser
 *      insert policy on tenants is gone, and nothing is activated.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the real
 *      `ops` handler over the real store, so what the console sends is what 0021 receives.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { supabaseTenantStore } from '../supabase/functions/_shared/tenants/supabase-tenant-store.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { handleLifecycleAction } from '../supabase/functions/ops/lifecycle.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0021_ops_tenant_creation.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0021 as written', () => {
  test('create_tenant is the service role\'s alone, and no browser role may execute anything here', () => {
    assert.match(CODE, /revoke all on function public\.create_tenant\(uuid, jsonb, text\[\], text\) from public, anon, authenticated/);
    assert.match(CODE, /grant execute on function public\.create_tenant\(uuid, jsonb, text\[\], text\) to service_role/);
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
  });

  test('the browser can no longer insert a tenant, and nothing else about tenants changes', () => {
    assert.match(CODE, /drop policy if exists tenants_admin_insert on public\.tenants;/);
    assert.doesNotMatch(CODE, /create policy [a-z_]+ on public\.tenants/);
    assert.doesNotMatch(CODE, /tenants_admin_update/);
  });

  test('the creation record has a read policy and no write policy', () => {
    assert.match(CODE, /alter table public\.tenant_creations enable row level security/);
    assert.doesNotMatch(CODE, /create policy [a-z_]+ on public\.tenant_creations\s+for (insert|update|delete|all)/i);
  });

  test('selection goes through 0015\'s transition function; nothing writes active', () => {
    assert.match(CODE, /apply_tenant_module_transition\(\s*v_tenant\.id, v_key, 'select', 0, 'operator', p_actor/);
    assert.doesNotMatch(CODE, /insert into public\.tenant_modules/);
    assert.doesNotMatch(CODE, /'active'\s*\)|state\s*=\s*'active'|'activate'/);
  });

  test('forward-only: the only drops are the policy it replaces and a trigger re-created by name', () => {
    const drops = [...CODE.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'policy' || d === 'trigger'), drops.join(', '));
    assert.doesNotMatch(CODE, /\btruncate\b|\bdelete from\b/i);
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
const key = () => `test-create-${uuid('dddddddd')}`;

async function newUser(db) {
  const id = uuid('cccccccc');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
  return id;
}
async function newOperator(db) {
  const id = await newUser(db);
  await db.query('insert into public.arc_admins (user_id) values ($1)', [id]);
  return id;
}

const form = (slug, extra = {}) => ({
  name: `Cascade ${slug}`,
  slug,
  timezone: 'America/Denver',
  status: 'onboarding',
  login_email: 'Owner@Cascade.example',
  contact_name: 'Pat',
  ...extra,
});

describe('creating a client through ops', { skip }, () => {
  let db;
  let operator;
  let call;
  let lifecycle;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    const client = restClient(db);
    const context = (actorId, body) => ({ store: supabaseStore(client), tenants: supabaseTenantStore(client), body, actorId });
    call = (action, body, actorId = operator) => handleTenantAction(action, context(actorId, body));
    lifecycle = (action, body, actorId = operator) => handleLifecycleAction(action, { store: supabaseStore(client), body, actorId });
  });

  const count = async (table, where = 'true', params = []) =>
    Number((await db.query(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0].n);

  test('an operator creates a tenant with a module: tenant, lifecycle, history, readiness, record and audit, in one go', async () => {
    const idem = key();
    const res = await call('tenant-create', { tenant: form('cascade-one'), modules: ['lead_recovery'], idempotency_key: idem });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const tenant = res.body.tenant;
    assert.equal(tenant.slug, 'cascade-one');
    assert.match(tenant.client_id, /^ARC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(tenant.login_email, 'owner@cascade.example');
    assert.equal(res.body.creation.actor_user_id, operator);
    assert.deepEqual(res.body.creation.modules, ['lead_recovery']);

    /* the lifecycle, exactly as a later selection would have made it. */
    assert.equal(res.body.lifecycles.length, 1);
    assert.equal(res.body.lifecycles[0].state, 'configuring');
    assert.equal(res.body.lifecycles[0].state_version, 1);
    assert.equal(res.body.lifecycles[0].authorized, null);
    const history = (await db.query('select * from tenant_module_transitions where tenant_id = $1', [tenant.id])).rows;
    assert.equal(history.length, 1);
    assert.equal(history[0].transition, 'select');
    assert.equal(history[0].from_state, 'unselected');
    assert.equal(history[0].to_state, 'configuring');
    assert.equal(history[0].actor_type, 'operator');
    assert.equal(history[0].actor_id, operator);

    /* the readiness step the creation itself proves, and nothing else ticked. */
    const steps = (await db.query('select step_key from module_onboarding where tenant_id = $1 and done_at is not null', [tenant.id])).rows;
    assert.deepEqual(steps.map((s) => s.step_key), ['tenant_created']);

    /* the audit row names actor, tenant, modules and time. */
    const audit = (await db.query(`select * from admin_actions where action = 'tenant.created' and target_id = $1`, [tenant.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, operator);
    assert.deepEqual(audit[0].metadata.modules, ['lead_recovery']);
    assert.ok(audit[0].occurred_at);
  });

  test('selecting a module does not activate it: configuring, switch off, nothing authorised', async () => {
    const res = await call('tenant-create', { tenant: form('cascade-off'), modules: ['lead_recovery'], idempotency_key: key() });
    const id = res.body.tenant.id;
    const row = (await db.query('select state, authorized_module_config_version_id from tenant_modules where tenant_id = $1', [id])).rows[0];
    assert.equal(row.state, 'configuring');
    assert.equal(row.authorized_module_config_version_id, null);
    const mc = (await db.query('select enabled from module_configs where tenant_id = $1', [id])).rows;
    assert.ok(mc.every((r) => r.enabled === false));
    /* and ARC-120's gate still stands between it and live: activation is refused. */
    const activate = await lifecycle('module-activate', { tenant_id: id, module_key: 'lead_recovery', expected_state_version: 1 });
    assert.notEqual(activate.status, 200);
  });

  test('a tenant with no modules is created with no lifecycle at all — unselected is the absence of one', async () => {
    const res = await call('tenant-create', { tenant: form('cascade-bare'), modules: [], idempotency_key: key() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await count('tenant_modules', 'tenant_id = $1', [res.body.tenant.id]), 0);
    assert.equal(await count('tenant_creations', 'tenant_id = $1', [res.body.tenant.id]), 1);
  });

  test('a repeat of the idempotency key is the same client, not a second one; other details under it are refused', async () => {
    const idem = key();
    const first = await call('tenant-create', { tenant: form('cascade-twice'), modules: ['lead_recovery'], idempotency_key: idem });
    const again = await call('tenant-create', { tenant: form('cascade-twice'), modules: ['lead_recovery'], idempotency_key: idem });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.tenant.id, first.body.tenant.id);
    assert.equal(await count('tenants', `slug = 'cascade-twice'`), 1);
    const other = await call('tenant-create', { tenant: form('cascade-other'), modules: [], idempotency_key: idem });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'idempotency_conflict');
  });

  test('somebody who is not an operator cannot create a tenant, and nothing is written', async () => {
    const stranger = await newUser(db);
    const before = await count('tenants');
    const res = await call('tenant-create', { tenant: form('cascade-stranger'), modules: ['lead_recovery'], idempotency_key: key() }, stranger);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'forbidden');
    const none = await call('tenant-create', { tenant: form('cascade-anon'), modules: [], idempotency_key: key() }, null);
    assert.equal(none.status, 401);
    assert.equal(await count('tenants'), before);
  });

  test('an unregistered or planned module is refused before anything is written', async () => {
    const before = await count('tenants');
    const unknown = await call('tenant-create', { tenant: form('cascade-unknown'), modules: ['crm_sync'], idempotency_key: key() });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.code, 'module_not_found');
    const planned = await call('tenant-create', { tenant: form('cascade-planned'), modules: ['review_recovery'], idempotency_key: key() });
    assert.equal(planned.status, 422);
    assert.equal(planned.body.code, 'module_unavailable');
    const alias = await call('tenant-create', { tenant: form('cascade-alias'), modules: ['lead_capture'], idempotency_key: key() });
    assert.equal(alias.body.code, 'module_not_found');
    assert.match(alias.body.error, /select lead_recovery/);
    assert.equal(await count('tenants'), before);
  });

  test('the database refuses an unregistered or planned module even if the service is bypassed', async () => {
    const tenants = supabaseTenantStore(restClient(db));
    const base = { actorId: operator, tenant: form('cascade-direct'), idempotencyKey: key() };
    await assert.rejects(tenants.createTenant({ ...base, modules: ['crm_sync'] }), (e) => e.code === 'module_not_found');
    await assert.rejects(tenants.createTenant({ ...base, modules: ['estimate_recovery'] }), (e) => e.code === 'module_unavailable');
    await assert.rejects(tenants.createTenant({ ...base, actorId: await newUser(db), modules: [] }), (e) => e.code === 'forbidden');
    assert.equal(await count('tenants', `slug = 'cascade-direct'`), 0);
  });

  test('every problem with the form comes back at once, by field', async () => {
    const res = await call('tenant-create', {
      tenant: { name: '', slug: 'Not A Slug', timezone: 'Mars/Olympus', login_email: 'nope', client_id: 'ARC-OOOO-IIII' },
      modules: ['review_recovery'],
      idempotency_key: 'short',
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'invalid');
    const fields = res.body.field_errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ['client_id', 'idempotency_key', 'login_email', 'modules.review_recovery', 'name', 'slug', 'timezone']);
  });

  test('a taken handle is a named conflict, and the transaction leaves nothing behind', async () => {
    await call('tenant-create', { tenant: form('cascade-taken'), modules: [], idempotency_key: key() });
    const before = await count('tenant_modules');
    const res = await call('tenant-create', { tenant: form('cascade-taken'), modules: ['lead_recovery'], idempotency_key: key() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'slug_taken');
    assert.equal(await count('tenant_modules'), before);
  });

  test('the overview reads every registered module off the registry, with lifecycle and configuration for the selected one', async () => {
    const created = await call('tenant-create', { tenant: form('cascade-view'), modules: ['lead_recovery'], idempotency_key: key() });
    const res = await call('tenant-modules', { tenant_id: created.body.tenant.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const keys = res.body.modules.map((m) => m.key);
    assert.deepEqual(keys, ['lead_recovery', 'estimate_recovery', 'review_recovery', 'membership_retention', 'install_warranty']);
    const lr = res.body.modules[0];
    assert.equal(lr.selectable, true);
    assert.equal(lr.lifecycle.lifecycle.state, 'configuring');
    assert.equal(lr.lifecycle.readiness.ok, false, 'a fresh client is not ready to activate');
    assert.ok(lr.lifecycle.history.length >= 1);
    assert.deepEqual(lr.configuration.map((c) => [c.scope, c.published]), [['tenant', null], ['module', null]]);
    const planned = res.body.modules.find((m) => m.key === 'review_recovery');
    assert.equal(planned.selectable, false);
    assert.equal(planned.lifecycle, null);
    assert.equal(res.body.creation.slug, 'cascade-view');
    const missing = await call('tenant-modules', { tenant_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(missing.status, 404);
  });

  test('the browser cannot insert a tenant any more, nor call create_tenant, nor write the creation record', async () => {
    const admin = await newOperator(db);
    await asRole(db, { role: 'authenticated', sub: admin }, async (tx) => {
      await assert.rejects(tx.query(`insert into public.tenants (name, slug) values ('Sneaky', 'sneaky')`), /row-level security/i);
    });
    for (const role of ['anon', 'authenticated']) {
      await asRole(db, { role, sub: admin }, async (tx) => {
        await assert.rejects(tx.query(`select public.create_tenant($1, '{}'::jsonb, '{}'::text[], 'browser-attempt')`, [admin]), /permission denied/);
      });
    }
    await asRole(db, { role: 'authenticated', sub: admin }, async (tx) => {
      const visible = await tx.query('select count(*)::int as n from public.tenant_creations');
      assert.ok(visible.rows[0].n > 0, 'operators can read the record');
      await assert.rejects(tx.query(`insert into public.tenant_creations (tenant_id, actor_user_id, idempotency_key, slug) values (gen_random_uuid(), $1, 'browser-write', 'x')`, [admin]));
    });
  });

  test('the creation record is never rewritten, even by the service role', async () => {
    const message = await refused(db, `update public.tenant_creations set slug = 'rewritten'`);
    assert.match(message, /arc_tenant:immutable/);
  });

  test('module-select on an existing client still goes through ARC-120, and a planned module is refused there too', async () => {
    const created = await call('tenant-create', { tenant: form('cascade-later'), modules: [], idempotency_key: key() });
    const id = created.body.tenant.id;
    const planned = await lifecycle('module-select', { tenant_id: id, module_key: 'review_recovery', expected_state_version: 0 });
    assert.equal(planned.body.code, 'module_unavailable');
    const ok = await lifecycle('module-select', { tenant_id: id, module_key: 'lead_recovery', expected_state_version: 0 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.lifecycle.state, 'configuring');
    const off = await lifecycle('module-deselect', { tenant_id: id, module_key: 'lead_recovery', expected_state_version: 1 });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.lifecycle.state, 'unselected');
  });
});
