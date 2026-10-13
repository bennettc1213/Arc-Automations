/** Stripe test-mode subscriptions for self-service ARC businesses.
 * Deploy with --no-verify-jwt: Stripe cannot send a Supabase JWT. Every customer action
 * verifies its bearer token; the webhook verifies the raw Stripe signature first.
 *
 * This file is only secrets and clients. What is decided is in `handler.ts`.
 */
import Stripe from 'npm:stripe@23.0.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { billingSettings, handleBilling, stripeGateway } from './handler.ts';
import type { BillingStore, StripeLike } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_WEBHOOK_SECRET = Deno.env.get('ARC_STRIPE_WEBHOOK_SECRET') ?? '';

const settings = billingSettings({
  secretKey: STRIPE_SECRET_KEY,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  priceId: Deno.env.get('ARC_STRIPE_PRICE_ID') ?? '',
  actionCap: Deno.env.get('ARC_STRIPE_MONTHLY_ACTION_CAP') ?? '0',
  siteUrl: Deno.env.get('ARC_SITE_URL') ?? '',
  supabaseReady: Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY),
});

const CORS = {
  'Access-Control-Allow-Origin': settings.siteUrl || 'null',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function store(): BillingStore {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const row = (data: Record<string, unknown> | null) => data && {
    tenantId: String(data.tenant_id),
    stripeCustomerId: (data.stripe_customer_id as string | null) ?? null,
    stripeSubscriptionId: (data.stripe_subscription_id as string | null) ?? null,
    status: String(data.status ?? 'none'),
  };
  const columns = 'tenant_id,stripe_customer_id,stripe_subscription_id,status';
  return {
    async isOwner(authorization, tenantId) {
      if (!authorization?.startsWith('Bearer ')) return false;
      const caller = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await caller.auth.getUser();
      if (error || !data.user?.id) return false;
      const { data: membership, error: memberError } = await db.from('tenant_members')
        .select('role').eq('tenant_id', tenantId).eq('user_id', data.user.id).maybeSingle();
      return !memberError && membership?.role === 'owner';
    },
    async account(tenantId) {
      const { data, error } = await db.from('saas_billing_accounts').select(columns).eq('tenant_id', tenantId).maybeSingle();
      if (error) throw error;
      return row(data);
    },
    async accountByCustomer(customer) {
      const { data, error } = await db.from('saas_billing_accounts').select(columns).eq('stripe_customer_id', customer).maybeSingle();
      if (error) throw error;
      return row(data);
    },
    async tenantName(tenantId) {
      const { data } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
      return (data?.name as string | undefined) ?? null;
    },
    async bindCustomer(tenantId, customer) {
      const { data, error } = await db.rpc('saas_bind_stripe_customer', { p_tenant: tenantId, p_customer: customer });
      if (error) throw error;
      return String(data);
    },
    async applySubscription(a) {
      const { error } = await db.rpc('saas_apply_stripe_subscription', {
        p_event: a.eventId, p_type: a.eventType, p_customer: a.customer, p_subscription: a.subscription,
        p_price: a.priceId, p_status: a.status, p_start: a.periodStart, p_end: a.periodEnd,
        p_cancel: a.cancelAtPeriodEnd, p_cap: a.actionCap, p_observed: a.observedAt,
      });
      if (error) throw error;
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  /* the handler answers 503 before it touches Stripe when billing is not configured, so no
     client is built from an empty key. */
  const client = settings.configured
    ? new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() })
    : null;
  let opened: BillingStore | null = null;
  const result = await handleBilling(
    {
      settings,
      stripe: stripeGateway(client as unknown as StripeLike, STRIPE_WEBHOOK_SECRET, Stripe.createSubtleCryptoProvider()),
      now: () => new Date(),
      /* reached by a webhook only after its signature has passed. */
      open: () => (opened ??= store()),
    },
    {
      method: request.method,
      url: request.url,
      body: request.method === 'POST' ? await request.text() : '',
      signature: request.headers.get('stripe-signature'),
      authorization: request.headers.get('authorization'),
    },
  );
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
