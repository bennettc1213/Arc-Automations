import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, loadPglite, SKIP_REASON } from './pglite-harness.js';

const skip = await loadPglite() ? false : SKIP_REASON;
const userIds = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
];
const settings = (name) => ({ name, timezone: 'America/Denver', trade: 'Window cleaning',
  services: 'Window cleaning, Screen repair', area: '80202, 80203', days: 'Monday-Friday',
  open: '08:00', close: '17:00', alerts: 'Inbox only', ownerPhone: '' });

async function asUser(db, user, callback) {
  return db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await tx.query('set local role authenticated');
    return callback(tx);
  });
}
const one = (tx, sql, params = []) => tx.query(sql, params).then(result => result.rows[0]);

describe('self-service account and draft persistence', { skip }, () => {
  test('two owners create once, save across requests, and cannot read or write across businesses', async () => {
    const db = await freshDatabase();
    try {
      for (const id of userIds) await db.query('insert into auth.users (id,email) values ($1,$2)', [id, `${id}@example.test`]);
      const create = (id, name) => asUser(db, id, tx => one(tx,
        'select public.self_service_create_business($1,$2) as id', [name, 'America/Denver']));
      const a = (await create(userIds[0], 'Fictional Window Co')).id;
      const b = (await create(userIds[1], 'Fictional Screen Co')).id;
      assert.notEqual(a, b);
      assert.equal((await create(userIds[0], 'Different Name')).id, a);
      assert.equal((await db.query('select count(*)::int as n from public.tenants')).rows[0].n, 2);
      assert.equal((await db.query('select count(*)::int as n from public.tenant_members')).rows[0].n, 2);

      const saved = await asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_save_setup($1,$2,$3::jsonb,$4) as revision',
        [a, 1, JSON.stringify(settings('Fictional Window Co')), 1]));
      assert.equal(saved.revision, 2);
      const fetched = await asUser(db, userIds[0], tx => tx.query('select * from public.tenant_setup_answers'));
      assert.equal(fetched.rows.length, 1);
      assert.equal(fetched.rows[0].business_type, 'Window cleaning');
      const other = await asUser(db, userIds[1], tx => tx.query('select * from public.tenant_setup_answers'));
      assert.equal(other.rows.length, 1);
      assert.equal(other.rows[0].tenant_id, b);
      await assert.rejects(asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_save_setup($1,$2,$3::jsonb,$4)',
        [b, 1, JSON.stringify(settings('Cross Tenant')), 1])), /forbidden/);
      await assert.rejects(asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_save_setup($1,$2,$3::jsonb,$4)',
        [a, 1, JSON.stringify(settings('Stale Save')), 1])), /stale/);

      const draft = { kind: 'inbound', name: 'New Lead Response', source: 'form', audience: 'inquiry', channel: 'sms',
        message: 'Hi, this is {{business}}. Thanks for reaching out. Reply STOP to opt out.', questions: [],
        cooldown: 24, delay: 1, followupHours: 24, maxContacts: 2 };
      const campaign = await asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_save_campaign($1,null,0,$2::jsonb) as id', [a, JSON.stringify(draft)]));
      assert.ok(campaign.id);
      const ownDrafts = await asUser(db, userIds[0], tx => tx.query('select * from public.customer_campaign_drafts'));
      const otherDrafts = await asUser(db, userIds[1], tx => tx.query('select * from public.customer_campaign_drafts'));
      assert.equal(ownDrafts.rows.length, 1);
      assert.equal(otherDrafts.rows.length, 0);
      await assert.rejects(asUser(db, userIds[1], tx => one(tx,
        'select public.self_service_save_campaign($1,$2,1,$3::jsonb)',
        [a, campaign.id, JSON.stringify(draft)])), /forbidden/);
      await assert.rejects(asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_save_campaign($1,null,0,$2::jsonb)',
        [a, JSON.stringify({ ...draft, maxContacts: 999 })])), /invalid/);
      const form = (await asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_configure_form($1,$2) as value',
        [a, 'https://fictional-window.example']))).value;
      assert.match(form.public_key, /^arcw_[a-z0-9]{48}$/);
      assert.deepEqual(form.origins, ['https://fictional-window.example']);
      assert.equal((await asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_form_status($1) as value', [a]))).value.public_key, form.public_key);
      await assert.rejects(asUser(db, userIds[1], tx => one(tx,
        'select public.self_service_form_status($1)', [a])), /forbidden/);
      await assert.rejects(asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_configure_form($1,$2)', [a, 'https://fictional-window.example/path'])), /invalid/);
      assert.equal((await asUser(db, userIds[0], tx => one(tx,
        'select public.self_service_configure_form($1,$2) as value', [a, '']))).value.public_key, null);
      assert.equal((await db.query('select revoked_at is not null as revoked from intake_keys where tenant_id=$1', [a])).rows[0].revoked, true);
      assert.equal((await db.query('select count(*)::int as n from public.automation_runs')).rows[0].n, 0);
    } finally { await db.close(); }
  });
});
