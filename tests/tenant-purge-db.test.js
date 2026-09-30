/* Deleting a test client (0022), against real Postgres.
 *
 * The promise: a client that was only ever set up can be deleted completely, and a client
 * that did anything real cannot — it is deboarded instead and its history kept. Everything
 * else about the append-only tables is unchanged: outside the purge, the guards refuse a
 * delete exactly as before, even for the service role and even with the flag set by hand.
 *
 * Without PGlite the database part is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { supabaseTenantStore } from '../supabase/functions/_shared/tenants/supabase-tenant-store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { leadRecoveryConfig } from './config-fixtures.js';

const SQL = readFileSync(new URL('../supabase/migrations/0022_purge_test_tenant.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');

const GUARDED = [
  'tenant_config_versions', 'module_config_versions', 'tenant_config_drafts', 'module_config_drafts',
  'tenant_module_transitions', 'tenant_module_evidence', 'tenant_modules',
];

describe('0022 as written', () => {
  test('every guarded table keeps its guard for insert and update, and for delete except inside a purge', () => {
    for (const table of GUARDED) {
      assert.match(CODE, new RegExp(`create trigger ${table}_guard\\s+before insert or update on public\\.${table}\\s`));
      assert.match(CODE, new RegExp(`create trigger ${table}_guard_delete\\s+before delete on public\\.${table}\\s+for each row when \\(not public\\.tenant_purge_in_progress\\(old\\.tenant_id\\)\\)`));
    }
  });

  test('the purge is the service role\'s alone', () => {
    assert.match(CODE, /revoke all on function public\.purge_test_tenant\(uuid, uuid, text\) from public, anon, authenticated/);
    assert.doesNotMatch(CODE, /grant execute on function [^;]* to [^;]*(anon|authenticated)/);
  });
});

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const uuid = (prefix) => {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};
let numbers = 7000;
const freshNumber = () => `+1614558${String(numbers++).padStart(4, '0')}`;

describe('deleting a test client', { skip }, () => {
  let db;
  let operator;
  let call;
  before(async () => {
    db = await freshDatabase();
    operator = uuid('cccccccc');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [operator, 'op@example.test']);
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    const client = restClient(db);
    call = (action, body, actorId = operator) =>
      handleTenantAction(action, { store: supabaseStore(client), tenants: supabaseTenantStore(client), body, actorId });
  });

  const count = async (table, where = 'true', params = []) =>
    Number((await db.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n);

  /** a client with every kind of setup row and nothing real: lifecycle, published config, a draft, services, an unused token. */
  async function setUpClient(slug) {
    const created = await call('tenant-create', {
      tenant: { name: `Test ${slug}`, slug, timezone: 'America/Denver' }, modules: ['lead_recovery'], idempotency_key: `purge-${slug}-key`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.tenant.id;
    const store = supabaseStore(restClient(db));
    const published = await publishEffectiveConfig(store, {
      tenantId: id, moduleKey: 'lead_recovery',
      config: leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: freshNumber() } }),
      expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: operator },
    });
    assert.equal(published.ok, true, published.message);
    await db.query(`insert into client_services (tenant_id, service_key, name) values ($1, 'speed-to-lead', 'speed-to-lead')`, [id]).catch(() => {});
    await db.query(`insert into ingest_tokens (tenant_id, token_hash, label) values ($1, $2, 'n8n')`, [id, `hash-${slug}`]);
    return id;
  }

  test('a client that was only set up is deleted completely, and the deletion is recorded', async () => {
    const id = await setUpClient('purge-me');
    for (const table of GUARDED.filter((t) => !t.endsWith('drafts') && t !== 'tenant_module_evidence')) {
      assert.ok(await count(`public.${table}`, 'tenant_id = $1', [id]) > 0, `${table} has setup rows to delete`);
    }
    const res = await call('tenant-purge', { tenant_id: id, confirm_slug: 'purge-me' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.purged.slug, 'purge-me');

    assert.equal(await count('public.tenants', 'id = $1', [id]), 0);
    for (const table of [...GUARDED, 'tenant_creations', 'module_configs', 'module_onboarding', 'ingest_tokens', 'client_services']) {
      assert.equal(await count(`public.${table}`, 'tenant_id = $1', [id]), 0, `${table} is empty for the client`);
    }
    const record = (await db.query('select * from tenant_purges where tenant_id = $1', [id])).rows[0];
    assert.equal(record.actor_user_id, operator);
    assert.equal(record.name, 'Test purge-me');
    assert.equal(await count('public.admin_actions', `action = 'tenant.purged' and target_id = $1`, [id]), 1);
    assert.equal(await count('public.admin_actions', `action = 'tenant.created' and target_id = $1`, [id]), 1, 'the creation row outlives the client too');
  });

  test('the handle must be typed exactly, or nothing happens', async () => {
    const id = await setUpClient('purge-typo');
    const res = await call('tenant-purge', { tenant_id: id, confirm_slug: 'purge-typ' });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'confirmation_mismatch');
    const empty = await call('tenant-purge', { tenant_id: id, confirm_slug: '' });
    assert.equal(empty.body.code, 'confirmation_mismatch');
    assert.equal(await count('public.tenants', 'id = $1', [id]), 1);
  });

  test('a client with real activity is refused with the list, and kept whole', async () => {
    const withEvent = await setUpClient('purge-event');
    await db.query(`insert into events (tenant_id, event_type, occurred_at) values ($1, 'lead_received', now())`, [withEvent]);
    const res = await call('tenant-purge', { tenant_id: withEvent, confirm_slug: 'purge-event' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'tenant_has_activity');
    assert.match(res.body.error, /1 events/);
    assert.match(res.body.error, /deboard it instead/);
    assert.equal(await count('public.tenants', 'id = $1', [withEvent]), 1);
    assert.ok(await count('public.tenant_modules', 'tenant_id = $1', [withEvent]) > 0);
    assert.equal(await count('public.tenant_purges', 'tenant_id = $1', [withEvent]), 0, 'no record of a purge that did not happen');

    const usedToken = await setUpClient('purge-token');
    await db.query(`update ingest_tokens set last_used_at = now() where tenant_id = $1`, [usedToken]);
    const second = await call('tenant-purge', { tenant_id: usedToken, confirm_slug: 'purge-token' });
    assert.equal(second.body.code, 'tenant_has_activity');
    assert.match(second.body.error, /ingest tokens that were used/);

    const optedOut = await setUpClient('purge-optout');
    await db.query(`insert into suppressions (tenant_id, channel, address, reason) values ($1, 'sms', '+15005550006', 'opt_out')`, [optedOut]);
    const third = await call('tenant-purge', { tenant_id: optedOut, confirm_slug: 'purge-optout' });
    assert.match(third.body.error, /1 opt-outs/);
  });

  test('only an operator may delete, and an unknown client is a 404', async () => {
    const id = await setUpClient('purge-stranger');
    const stranger = uuid('cccccccc');
    await db.query('insert into auth.users (id, email) values ($1, $2)', [stranger, 'x@example.test']);
    assert.equal((await call('tenant-purge', { tenant_id: id, confirm_slug: 'purge-stranger' }, stranger)).status, 403);
    assert.equal((await call('tenant-purge', { tenant_id: id, confirm_slug: 'purge-stranger' }, null)).status, 401);
    assert.equal((await call('tenant-purge', { tenant_id: '00000000-0000-4000-8000-000000000000', confirm_slug: 'x' })).status, 404);
    assert.equal((await call('tenant-purge', { tenant_id: 'not-a-uuid', confirm_slug: 'x' })).status, 404);
    assert.equal(await count('public.tenants', 'id = $1', [id]), 1);
  });

  test('outside a purge the guards refuse a delete exactly as before — even with the flag set by hand', async () => {
    const id = await setUpClient('purge-guarded');
    for (const table of ['tenant_modules', 'tenant_module_transitions', 'tenant_config_versions']) {
      const message = await refused(db, `delete from public.${table} where tenant_id = $1`, [id]);
      assert.match(message, /arc_|forbidden|append-only|never/i, table);
    }
    /* the flag alone, with no purge recorded for the client, opens nothing. */
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('arc.purging_tenant', $1, true)`, [id]);
      await assert.rejects(tx.query('delete from public.tenant_modules where tenant_id = $1', [id]));
      await tx.rollback();
    });
    assert.ok(await count('public.tenant_modules', 'tenant_id = $1', [id]) > 0);
  });

  test('a browser cannot call the purge, and the purge record cannot be changed', async () => {
    const id = await setUpClient('purge-browser');
    await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => {
      await assert.rejects(tx.query('select public.purge_test_tenant($1, $2, $3)', [operator, id, 'purge-browser']), /permission denied/);
    });
    await call('tenant-purge', { tenant_id: id, confirm_slug: 'purge-browser' });
    assert.match(await refused(db, `update public.tenant_purges set slug = 'x' where tenant_id = $1`, [id]), /arc_tenant:immutable/);
    assert.match(await refused(db, `delete from public.tenant_purges where tenant_id = $1`, [id]), /arc_tenant:immutable/);
  });
});
