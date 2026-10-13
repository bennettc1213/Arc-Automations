/**
 * Billing's door, without its secrets.
 *
 * `index.ts` holds the Stripe key and the service-role client; everything that decides is
 * here, so it runs under `node --test` like the Twilio door does. Two rules it holds:
 *
 *   - **The webhook's signature is checked before anything is opened.** `open()` is what
 *     builds the database client, and a forged request never reaches it.
 *   - **An event never says what the subscription is.** It only says "look again": the
 *     current subscription is fetched from Stripe and that snapshot is what is stored, so a
 *     late or replayed event cannot roll access back.
 *
 * A customer action takes who is asking from their sign-in. A body cannot claim a tenant it
 * does not own, a price, or a plan.
 */

export const BILLING_STATUSES = [
  'none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused',
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** The only two states in which a live message may start. Mirrored in 0031's SQL gate. */
export const SENDING_STATUSES: readonly BillingStatus[] = ['active', 'trialing'];

/** A subscription that has ended, so a new checkout may begin. */
const RESTARTABLE: readonly string[] = ['none', 'canceled', 'incomplete_expired'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_BYTES = 256_000;
const MAX_ACTION_BYTES = 2048;

export interface BillingSettings {
  /** False when a key, the price, the cap or the site address is missing or not test-mode. */
  configured: boolean;
  priceId: string;
  actionCap: number;
  siteUrl: string;
}

/** What Stripe says a subscription is right now. Never built from an event's own object. */
export interface SubscriptionSnapshot {
  id: string;
  customer: string;
  status: string;
  priceId: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingEvent {
  id: string;
  type: string;
  object: Record<string, unknown>;
}

export interface StripeGateway {
  /** The verified event, or null when the signature does not match the raw body. */
  verifyEvent(raw: string, signature: string): Promise<BillingEvent | null>;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  createCustomer(args: { name: string | null; tenantId: string }): Promise<string>;
  createCheckout(args: { customer: string; tenantId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<string>;
  createPortal(args: { customer: string; returnUrl: string }): Promise<string>;
}

export interface BillingAccount {
  tenantId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: string;
}

export interface BillingStore {
  /** True only when the bearer token is a signed-in owner of this tenant. */
  isOwner(authorization: string | null, tenantId: string): Promise<boolean>;
  account(tenantId: string): Promise<BillingAccount | null>;
  accountByCustomer(customer: string): Promise<BillingAccount | null>;
  tenantName(tenantId: string): Promise<string | null>;
  /** Returns the customer the tenant is bound to: this one, or the one bound first. */
  bindCustomer(tenantId: string, customer: string): Promise<string>;
  applySubscription(args: {
    eventId: string; eventType: string; customer: string; subscription: string; priceId: string;
    status: string; periodStart: string; periodEnd: string; cancelAtPeriodEnd: boolean;
    actionCap: number; observedAt: string;
  }): Promise<void>;
}

export interface BillingDoor {
  settings: BillingSettings;
  stripe: StripeGateway;
  now(): Date;
  /** Built on first use, and for a webhook only after its signature has passed. */
  open(): BillingStore;
}

export interface BillingRequest {
  method: string;
  url: string;
  body: string;
  signature: string | null;
  authorization: string | null;
}

export interface BillingAnswer { status: number; body: Record<string, unknown> }

const answer = (status: number, body: Record<string, unknown>): BillingAnswer => ({ status, body });
const ignored = () => answer(200, { received: true, ignored: true });

/** The event types that can change what a business may send. Everything else is acknowledged. */
export function isRelevantEvent(type: string): boolean {
  return type === 'checkout.session.completed'
    || type.startsWith('customer.subscription.')
    || type === 'invoice.payment_failed'
    || type === 'invoice.payment_succeeded';
}

async function handleWebhook(door: BillingDoor, request: BillingRequest): Promise<BillingAnswer> {
  if (!door.settings.configured) return answer(503, { error: 'billing is not configured' });
  if (!request.signature) return answer(400, { error: 'invalid signature' });
  if (request.body.length > MAX_EVENT_BYTES) return answer(413, { error: 'event too large' });

  let event: BillingEvent | null;
  try {
    event = await door.stripe.verifyEvent(request.body, request.signature);
  } catch {
    event = null;
  }
  if (!event) return answer(400, { error: 'invalid signature' });
  if (!isRelevantEvent(event.type)) return ignored();

  try {
    const object = event.object;
    const customer = typeof object.customer === 'string' ? object.customer : null;
    if (!customer) return ignored();

    const store = door.open();
    const account = await store.accountByCustomer(customer);
    if (!account) return answer(409, { error: 'unknown customer' });

    const subscriptionId = event.type.startsWith('customer.subscription.')
      ? String(object.id ?? '')
      : event.type === 'checkout.session.completed' && typeof object.subscription === 'string'
        ? object.subscription
        : account.stripeSubscriptionId;
    if (!subscriptionId?.startsWith('sub_')) return ignored();

    /* a second subscription on the same customer does not replace one that is paying. */
    if (
      event.type.startsWith('customer.subscription.') && account.stripeSubscriptionId &&
      subscriptionId !== account.stripeSubscriptionId &&
      (SENDING_STATUSES as readonly string[]).includes(account.status)
    ) return ignored();

    const observedAt = door.now().toISOString();
    const subscription = await door.stripe.retrieveSubscription(subscriptionId);
    if (subscription.customer !== customer) return answer(409, { error: 'customer mismatch' });
    if (!subscription.priceId || !subscription.periodStart || !subscription.periodEnd) {
      throw new Error('subscription period or price unavailable');
    }
    if (subscription.priceId !== door.settings.priceId) return answer(409, { error: 'unknown price' });

    await store.applySubscription({
      eventId: event.id, eventType: event.type, customer,
      subscription: subscription.id, priceId: subscription.priceId, status: subscription.status,
      periodStart: new Date(subscription.periodStart * 1000).toISOString(),
      periodEnd: new Date(subscription.periodEnd * 1000).toISOString(),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      actionCap: door.settings.actionCap, observedAt,
    });
    return answer(200, { received: true });
  } catch (error) {
    /* 503 so Stripe retries: the snapshot is fetched again then, so nothing is lost. */
    console.error('billing webhook reconciliation failed', (error as Error).message);
    return answer(503, { error: 'reconciliation pending' });
  }
}

async function handleAction(door: BillingDoor, request: BillingRequest): Promise<BillingAnswer> {
  if (!door.settings.configured) return answer(503, { error: 'billing is not configured for Stripe test mode' });
  if (request.body.length > MAX_ACTION_BYTES) return answer(413, { error: 'request too large' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(request.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
  } catch {
    return answer(400, { error: 'invalid request' });
  }

  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : '';
  if (!UUID.test(tenantId)) return answer(403, { error: 'owner access required' });
  const store = door.open();
  if (!await store.isOwner(request.authorization, tenantId)) return answer(403, { error: 'owner access required' });

  const account = await store.account(tenantId);
  if (!account) return answer(503, { error: 'billing account unavailable' });
  const site = door.settings.siteUrl;

  try {
    if (body.action === 'portal') {
      if (!account.stripeCustomerId) return answer(409, { error: 'no billing account yet' });
      const url = await door.stripe.createPortal({
        customer: account.stripeCustomerId, returnUrl: `${site}/portal/dashboard/billing`,
      });
      return answer(200, { url });
    }
    if (body.action !== 'checkout') return answer(400, { error: 'unknown action' });
    if (account.stripeSubscriptionId && !RESTARTABLE.includes(account.status)) {
      return answer(409, { error: 'manage the existing subscription in the billing portal' });
    }
    let customer = account.stripeCustomerId;
    if (!customer) {
      const created = await door.stripe.createCustomer({ name: await store.tenantName(tenantId), tenantId });
      /* two checkouts at once: the first binding wins and both sessions use it. */
      customer = await store.bindCustomer(tenantId, created);
    }
    const url = await door.stripe.createCheckout({
      customer, tenantId, priceId: door.settings.priceId,
      successUrl: `${site}/portal/dashboard/billing?checkout=returned`,
      cancelUrl: `${site}/portal/dashboard/billing?checkout=canceled`,
    });
    return answer(200, { url });
  } catch (error) {
    console.error('billing session failed', (error as Error).message);
    return answer(503, { error: 'billing session unavailable' });
  }
}

export async function handleBilling(door: BillingDoor, request: BillingRequest): Promise<BillingAnswer> {
  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return answer(400, { error: 'invalid request' });
  }
  if (request.method !== 'POST') return answer(405, { error: 'use POST' });
  if (pathname.endsWith('/webhook')) return await handleWebhook(door, request);
  return await handleAction(door, request);
}

/* ── the Stripe SDK, behind the gateway ─────────────────── */

/** The few SDK calls billing makes. `index.ts` passes the real client; so does the test. */
export interface StripeLike {
  webhooks: { constructEventAsync(raw: string, signature: string, secret: string, tolerance?: number, crypto?: unknown): Promise<unknown> };
  subscriptions: { retrieve(id: string): Promise<unknown> };
  customers: { create(args: Record<string, unknown>): Promise<{ id: string }> };
  checkout: { sessions: { create(args: Record<string, unknown>): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(args: Record<string, unknown>): Promise<{ url: string }> } };
}

export function stripeGateway(client: StripeLike, webhookSecret: string, cryptoProvider?: unknown): StripeGateway {
  return {
    async verifyEvent(raw, signature) {
      try {
        const event = await client.webhooks.constructEventAsync(raw, signature, webhookSecret, undefined, cryptoProvider) as
          { id: string; type: string; data: { object: Record<string, unknown> } };
        return { id: event.id, type: event.type, object: event.data.object };
      } catch {
        return null;
      }
    },
    async retrieveSubscription(id) {
      const s = await client.subscriptions.retrieve(id) as {
        id: string; customer: string | { id: string }; status: string; cancel_at_period_end?: boolean;
        items?: { data?: { price?: { id?: string }; current_period_start?: number; current_period_end?: number }[] };
      };
      const item = s.items?.data?.[0];
      return {
        id: s.id,
        customer: typeof s.customer === 'string' ? s.customer : s.customer?.id,
        status: s.status,
        priceId: item?.price?.id ?? null,
        periodStart: item?.current_period_start ?? null,
        periodEnd: item?.current_period_end ?? null,
        cancelAtPeriodEnd: s.cancel_at_period_end === true,
      };
    },
    async createCustomer({ name, tenantId }) {
      return (await client.customers.create({ name: name ?? undefined, metadata: { arc_tenant_id: tenantId } })).id;
    },
    async createCheckout({ customer, tenantId, priceId, successUrl, cancelUrl }) {
      const session = await client.checkout.sessions.create({
        mode: 'subscription', customer, client_reference_id: tenantId,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: { metadata: { arc_tenant_id: tenantId } },
        success_url: successUrl, cancel_url: cancelUrl,
      });
      if (!session.url) throw new Error('checkout session has no url');
      return session.url;
    },
    async createPortal({ customer, returnUrl }) {
      return (await client.billingPortal.sessions.create({ customer, return_url: returnUrl })).url;
    },
  };
}

/** Whether the function's secrets describe a usable test-mode setup. Never a live key. */
export function billingSettings(env: {
  secretKey: string; webhookSecret: string; priceId: string; actionCap: string | number; siteUrl: string;
  supabaseReady: boolean;
}): BillingSettings {
  const cap = Number(env.actionCap);
  const siteUrl = env.siteUrl.replace(/\/+$/, '');
  return {
    configured: env.secretKey.startsWith('sk_test_') && env.webhookSecret.startsWith('whsec_')
      && /^price_[A-Za-z0-9]+$/.test(env.priceId)
      && Number.isInteger(cap) && cap >= 1 && cap <= 100000
      && /^https:\/\//.test(siteUrl) && env.supabaseReady,
    priceId: env.priceId,
    actionCap: cap,
    siteUrl,
  };
}
