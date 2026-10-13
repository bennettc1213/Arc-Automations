import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, loadPglite, SKIP_REASON } from './pglite-harness.js';

const skip = await loadPglite() ? false : SKIP_REASON;

describe('public form capacity across workers', { skip }, () => {
  test('form and recipient caps persist in Postgres; rejected requests do not mutate lead state', async () => {
    const db = await freshDatabase();
    try {
      const tenant = (await db.query("insert into tenants (name,slug) values ('Fictional Glassworks','fictional-glassworks') returning id")).rows[0].id;
      const key = (await db.query("insert into intake_keys (tenant_id,public_key,allowed_origins) values ($1,'arcw_abcdefghijklmnopqrstuvwx',array['https://example.test']) returning id", [tenant])).rows[0].id;
      const second = (await db.query("insert into intake_keys (tenant_id,public_key,allowed_origins) values ($1,'arcw_abcdefghijklmnopqrstuvwy',array['https://example.test']) returning id", [tenant])).rows[0].id;
      let serial = 0;
      const use = (form, phone = null, submission = `submission-${++serial}`) => db.query(
        'select public.consume_public_intake_capacity($1,$2,$3)', [form, phone, submission]);
      await use(key, '+15551230001');
      await use(key, '+15551230001', 'submission-1');
      await use(key, '+15551230001');
      await use(second, '+15551230001');
      await assert.rejects(use(second, '+15551230001'), /rate_limited/);
      assert.equal((await db.query("select hits from public_intake_capacity where scope='recipient_day'")).rows[0].hits, 3);
      for (let i = 2; i < 30; i++) await use(key);
      await assert.rejects(use(key), /rate_limited/);
      assert.equal((await db.query('select count(*)::int as n from leads')).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int as n from scheduled_actions')).rows[0].n, 0);
    } finally { await db.close(); }
  });
});
