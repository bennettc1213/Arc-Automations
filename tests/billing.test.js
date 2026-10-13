/* billing's door (ARC SaaS foundation): supabase/functions/billing/handler.ts.
 *
 * The signature is checked by the real Stripe SDK — the one `index.ts` hands the handler —
 * against a header the SDK itself generates, so a pass here is the same check production
 * runs. Stripe's API is never called: `subscriptions.retrieve` and the session calls are
 * replaced on the client, and what they would return is the test's own state.
 *
 * What is held: a forged or unsigned event opens nothing; an event only ever causes a
 * re-read of the subscription; a body cannot name a tenant the caller does not own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

import {
  billingSettings,
  handleBilling,
  isRelevantEvent,
  SENDING_STATUSES,
  stripeGateway,
} from '../supabase/functions/billing/handler.ts';

/* credential-shaped fixtures are built from parts: the repository is public and a scanner
   reads a literal as a leak. none of these is a real key. */
const SECRET_KEY = ['sk', 'test', 'a'.repeat(24)].join('_');
const WEBHOOK_SECRET = ['whsec', 'b'.repeat(32)].join('_');
const PRICE = 'price_FictionalPlan1';
const TENANT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER_TENANT = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const OWNER_TOKEN = 'Bearer owner-of-a';
const NOW = new Date('2026-10-13T12:00:00Z');
const DAY = 86_400;

function world({ configured = true } = {}) {
  const client = new Stripe(SECRET_KEY);
  const subscriptions = new Map();
  const calls = { retrieve: 0, customers: 0, checkout: [], portal: [] };
  client.subscriptions.retrieve = async (id) => {
    calls.retrieve += 1;
    const found = subscriptions.get(id);
    if (!found) throw new Error('no such subscription');
    return found;
  };
  client.customers.create = async () => ({ id: `cus_Created${++calls.customers}` });
  client.checkout.sessions.create = async (args) => { calls.checkout.push(args); return { url: 'https://checkout.stripe.test/session' }; };
  client.billingPortal.sessions.create = async (args) => { calls.portal.push(args); return { url: 'https://billing.stripe.test/portal' }; };

  const accounts = new Map([
    [TENANT, { tenantId: TENANT, stripeCustomerId: null, stripeSubscriptionId: null, status: 'none' }],
    [OTHER_TENANT, { tenantId: OTHER_TENANT, stripeCustomerId: 'cus_Other', stripeSubscriptionId: null, status: 'none' }],
  ]);
  const applied = [];
  const seen = new Set();
  let opened = 0;
  const store = {
    isOwner: async (authorization, tenantId) => authorization === OWNER_TOKEN && tenantId === TENANT,
    account: async (tenantId) => accounts.get(tenantId) ?? null,
    accountByCustomer: async (customer) => [...accounts.values()].find((a) => a.stripeCustomerId === customer) ?? null,
    tenantName: async () => 'Fictional Glassworks',
    bindCustomer: async (tenantId, customer) => {
      const account = accounts.get(tenantId);
      account.stripeCustomerId ??= customer;
      return account.stripeCustomerId;
    },
    /* the SQL function's contract (0031): one row per event id, and the newest snapshot wins. */
    applySubscription: async (args) => {
      if (seen.has(args.eventId)) return;
      seen.add(args.eventId);
      applied.push(args);
      const account = [...accounts.values()].find((a) => a.stripeCustomerId === args.customer);
      Object.assign(account, { stripeSubscriptionId: args.subscription, status: args.status });
    },
  };

  const settings = configured
    ? billingSettings({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, priceId: PRICE, actionCap: 500, siteUrl: 'https://arc.example/', supabaseReady: true })
    : billingSettings({ secretKey: '', webhookSecret: '', priceId: '', actionCap: 0, siteUrl: '', supabaseReady: false });
  const door = {
    settings,
    stripe: stripeGateway(client, WEBHOOK_SECRET),
    now: () => NOW,
    open: () => { opened += 1; return store; },
  };

  const subscription = (id, customer, status, extra = {}) => {
    const row = {
      id, customer, status, cancel_at_period_end: false,
      items: { data: [{ price: { id: PRICE }, current_period_start: NOW / 1000 - DAY, current_period_end: NOW / 1000 + 29 * DAY }] },
      ...extra,
    };
    subscriptions.set(id, row);
    return row;
  };
  const event = (id, type, object) => JSON.stringify({ id, object: 'event', type, data: { object } });
  const sign = (raw, secret = WEBHOOK_SECRET) => client.webhooks.generateTestHeaderStringAsync({ payload: raw, secret });
  const webhook = async (raw, { signature } = {}) => handleBilling(door, {
    method: 'POST', url: 'https://edge.internal/functions/v1/billing/webhook', body: raw,
    signature: signature === undefined ? await sign(raw) : signature, authorization: null,
  });
  const action = (body, authorization = OWNER_TOKEN) => handleBilling(door, {
    method: 'POST', url: 'https://edge.internal/functions/v1/billing', body: JSON.stringify(body), signature: null, authorization,
  });

  return { accounts, applied, calls, event, sign, subscription, webhook, action, opened: () => opened, door };
}

describe('billing settings', () => {
  test('only a complete test-mode setup is configured, and a live key is not one', () => {
    const base = { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, priceId: PRICE, actionCap: '500', siteUrl: 'https://arc.example', supabaseReady: true };
    assert.equal(billingSettings(base).configured, true);
    assert.equal(billingSettings({ ...base, secretKey: ['sk', 'live', 'a'.repeat(24)].join('_') }).configured, false);
    for (const broken of [{ webhookSecret: '' }, { priceId: 'prod_NotAPrice' }, { actionCap: '0' }, { actionCap: '2.5' }, { actionCap: '100001' }, { siteUrl: 'http://arc.example' }, { supabaseReady: false }]) {
      assert.equal(billingSettings({ ...base, ...broken }).configured, false, JSON.stringify(broken));
    }
  });

  test('with nothing configured every request is answered 503 and nothing is opened', async () => {
    const w = world({ configured: false });
    assert.equal((await w.action({ tenant_id: TENANT, action: 'checkout' })).status, 503);
    assert.equal((await w.webhook(w.event('evt_1', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' }), { signature: 'anything' })).status, 503);
    assert.equal(w.opened(), 0);
  });

  test('sending is allowed in exactly two states', () => {
    assert.deepEqual([...SENDING_STATUSES], ['active', 'trialing']);
  });
});

describe('the Stripe webhook', () => {
  test('a forged, unsigned or altered event is refused before anything is opened', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';
    w.subscription('sub_A', 'cus_A', 'active');
    const raw = w.event('evt_forged', 'customer.subscription.updated', { id: 'sub_A', customer: 'cus_A' });

    const attempts = {
      'no signature header': { signature: null },
      'a signature that is not one': { signature: 't=1,v1=deadbeef' },
      'signed with another secret': { signature: await w.sign(raw, ['whsec', 'c'.repeat(32)].join('_')) },
    };
    for (const [why, options] of Object.entries(attempts)) {
      const answer = await w.webhook(raw, options);
      assert.equal(answer.status, 400, why);
      assert.deepEqual(answer.body, { error: 'invalid signature' }, `${why}: a forger is told nothing more`);
    }
    /* a genuine signature over a body that was changed afterwards */
    const signature = await w.sign(raw);
    assert.equal((await w.webhook(raw.replace('sub_A', 'sub_B'), { signature })).status, 400);

    assert.equal(w.opened(), 0, 'the database client was never built');
    assert.equal(w.calls.retrieve, 0, 'Stripe was never asked');
    assert.deepEqual(w.applied, []);
    assert.equal(w.accounts.get(TENANT).status, 'none');
  });

  test('a genuine event stores what Stripe says now, not what the event said', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';
    w.subscription('sub_A', 'cus_A', 'past_due');
    /* the event's own object claims "active"; the subscription has since gone past due. */
    const answer = await w.webhook(w.event('evt_late', 'customer.subscription.updated', { id: 'sub_A', customer: 'cus_A', status: 'active' }));
    assert.equal(answer.status, 200);
    assert.equal(w.applied.length, 1);
    assert.equal(w.applied[0].status, 'past_due');
    assert.equal(w.applied[0].actionCap, 500, 'the cap comes from configuration, never from the event');
    assert.equal(w.applied[0].observedAt, NOW.toISOString());
    assert.equal(w.accounts.get(TENANT).status, 'past_due');
  });

  test('the same event delivered twice is one change', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';
    w.subscription('sub_A', 'cus_A', 'active');
    const raw = w.event('evt_twice', 'checkout.session.completed', { id: 'cs_1', customer: 'cus_A', subscription: 'sub_A' });
    assert.equal((await w.webhook(raw)).status, 200);
    assert.equal((await w.webhook(raw)).status, 200);
    assert.equal(w.applied.length, 1);
  });

  test('a failed payment and a cancellation each end in the state Stripe reports', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';
    w.subscription('sub_A', 'cus_A', 'active');
    await w.webhook(w.event('evt_start', 'customer.subscription.created', { id: 'sub_A', customer: 'cus_A' }));
    assert.equal(w.accounts.get(TENANT).status, 'active');

    /* an invoice event carries no subscription id of its own: the account's is re-read. */
    w.subscription('sub_A', 'cus_A', 'past_due');
    await w.webhook(w.event('evt_failed', 'invoice.payment_failed', { id: 'in_1', customer: 'cus_A' }));
    assert.equal(w.accounts.get(TENANT).status, 'past_due');

    w.subscription('sub_A', 'cus_A', 'active');
    await w.webhook(w.event('evt_paid', 'invoice.payment_succeeded', { id: 'in_2', customer: 'cus_A' }));
    assert.equal(w.accounts.get(TENANT).status, 'active');

    w.subscription('sub_A', 'cus_A', 'active', { cancel_at_period_end: true });
    await w.webhook(w.event('evt_cancel_later', 'customer.subscription.updated', { id: 'sub_A', customer: 'cus_A' }));
    assert.equal(w.applied.at(-1).cancelAtPeriodEnd, true);
    assert.equal(w.accounts.get(TENANT).status, 'active', 'cancelling at period end keeps access until then');

    w.subscription('sub_A', 'cus_A', 'canceled');
    await w.webhook(w.event('evt_cancelled', 'customer.subscription.deleted', { id: 'sub_A', customer: 'cus_A' }));
    assert.equal(w.accounts.get(TENANT).status, 'canceled');
  });

  test('an event for a customer, price or subscription ARC does not know changes nothing', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';

    w.subscription('sub_X', 'cus_Stranger', 'active');
    assert.equal((await w.webhook(w.event('evt_stranger', 'customer.subscription.created', { id: 'sub_X', customer: 'cus_Stranger' }))).status, 409);

    /* the event names our customer; the subscription it points at belongs to someone else. */
    assert.equal((await w.webhook(w.event('evt_borrowed', 'customer.subscription.created', { id: 'sub_X', customer: 'cus_A' }))).status, 409);

    w.subscription('sub_P', 'cus_A', 'active', { items: { data: [{ price: { id: 'price_SomeOtherPlan' }, current_period_start: 1, current_period_end: 2 }] } });
    assert.equal((await w.webhook(w.event('evt_price', 'customer.subscription.created', { id: 'sub_P', customer: 'cus_A' }))).status, 409);

    assert.deepEqual(w.applied, []);
    assert.equal(w.accounts.get(TENANT).status, 'none');
  });

  test('a second subscription does not displace one that is paying', async () => {
    const w = world();
    Object.assign(w.accounts.get(TENANT), { stripeCustomerId: 'cus_A', stripeSubscriptionId: 'sub_A', status: 'active' });
    w.subscription('sub_Second', 'cus_A', 'incomplete');
    const answer = await w.webhook(w.event('evt_second', 'customer.subscription.created', { id: 'sub_Second', customer: 'cus_A' }));
    assert.deepEqual(answer.body, { received: true, ignored: true });
    assert.equal(w.accounts.get(TENANT).stripeSubscriptionId, 'sub_A');
  });

  test('an event that is not about access is acknowledged and reads nothing', async () => {
    const w = world();
    assert.equal(isRelevantEvent('customer.updated'), false);
    const answer = await w.webhook(w.event('evt_other', 'customer.updated', { id: 'cus_A' }));
    assert.deepEqual(answer.body, { received: true, ignored: true });
    assert.equal(w.opened(), 0);
  });

  test('when Stripe cannot be read the event is answered 503 so it is delivered again', async () => {
    const w = world();
    w.accounts.get(TENANT).stripeCustomerId = 'cus_A';
    const answer = await w.webhook(w.event('evt_retry', 'customer.subscription.updated', { id: 'sub_Missing', customer: 'cus_A' }));
    assert.equal(answer.status, 503);
    assert.deepEqual(w.applied, []);
  });
});

describe('a customer starting or managing a subscription', () => {
  test('only a signed-in owner of that business may, whatever the body claims', async () => {
    const w = world();
    assert.equal((await w.action({ tenant_id: TENANT, action: 'checkout' }, null)).status, 403);
    assert.equal((await w.action({ tenant_id: TENANT, action: 'checkout' }, 'Bearer somebody-else')).status, 403);
    assert.equal((await w.action({ tenant_id: OTHER_TENANT, action: 'checkout' })).status, 403, "an owner of A cannot open B's billing");
    assert.equal((await w.action({ tenant_id: 'not-a-uuid', action: 'checkout' })).status, 403);
    assert.equal(w.calls.customers, 0);
    assert.deepEqual(w.calls.checkout, []);
  });

  test('checkout binds one customer and uses the configured price, never one from the body', async () => {
    const w = world();
    const first = await w.action({ tenant_id: TENANT, action: 'checkout', price: 'price_Cheaper', plan: 'enterprise' });
    assert.equal(first.status, 200);
    assert.equal(first.body.url, 'https://checkout.stripe.test/session');
    await w.action({ tenant_id: TENANT, action: 'checkout' });
    assert.equal(w.calls.customers, 1, 'the second checkout reuses the bound customer');
    for (const session of w.calls.checkout) {
      assert.deepEqual(session.line_items, [{ price: PRICE, quantity: 1 }]);
      assert.equal(session.customer, 'cus_Created1');
      assert.equal(session.client_reference_id, TENANT);
      assert.equal(session.success_url, 'https://arc.example/portal/dashboard/billing?checkout=returned');
    }
  });

  test('reaching the success page grants nothing: access changes only through the webhook', async () => {
    const w = world();
    await w.action({ tenant_id: TENANT, action: 'checkout' });
    assert.equal(w.accounts.get(TENANT).status, 'none');
    assert.deepEqual(w.applied, []);
  });

  test('a paying business is sent to the portal rather than a second checkout', async () => {
    const w = world();
    Object.assign(w.accounts.get(TENANT), { stripeCustomerId: 'cus_A', stripeSubscriptionId: 'sub_A', status: 'past_due' });
    assert.equal((await w.action({ tenant_id: TENANT, action: 'checkout' })).status, 409);
    const portal = await w.action({ tenant_id: TENANT, action: 'portal' });
    assert.equal(portal.body.url, 'https://billing.stripe.test/portal');
    assert.equal(w.calls.portal[0].customer, 'cus_A');

    w.accounts.get(TENANT).status = 'canceled';
    assert.equal((await w.action({ tenant_id: TENANT, action: 'checkout' })).status, 200, 'a cancelled business may subscribe again');
  });

  test('malformed and unknown requests are refused', async () => {
    const w = world();
    assert.equal((await w.action({ tenant_id: TENANT, action: 'refund' })).status, 400);
    assert.equal((await w.action({ tenant_id: TENANT, action: 'portal' })).status, 409, 'no billing account yet');
    const raw = (body) => handleBilling(w.door, { method: 'POST', url: 'https://edge.internal/functions/v1/billing', body, signature: null, authorization: OWNER_TOKEN });
    assert.equal((await raw('not json')).status, 400);
    assert.equal((await raw('[]')).status, 400);
    assert.equal((await raw(JSON.stringify({ tenant_id: TENANT, pad: 'x'.repeat(3000) }))).status, 413);
    assert.equal((await handleBilling(w.door, { method: 'GET', url: 'https://edge.internal/functions/v1/billing', body: '', signature: null, authorization: OWNER_TOKEN })).status, 405);
  });
});
