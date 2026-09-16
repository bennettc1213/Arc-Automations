import { DateTime } from 'luxon';

/* the services a client's automation can be wired to, and where to go to wire one.
 *
 * "connect" in the console is not OAuth. none of these accounts belong to Arc —
 * they are the client's n8n, the client's twilio number, sometimes paid for by us
 * and sometimes by them — so connecting one means sending somebody to that
 * provider's own sign-up or sign-in page, and then recording here what came back:
 * which account, the last four of the key, where the key is actually kept, and
 * what it costs and when it renews.
 *
 * each entry's links go to the provider's own pages. `keysUrl` may be a function of
 * the connection's endpoint, because for a self-hosted n8n the API keys live on
 * that instance rather than on n8n.io.
 */

export const INTEGRATIONS = [
  {
    key: 'n8n',
    name: 'n8n',
    kind: 'n8n',
    category: 'automation',
    blurb: 'the workflow engine every automation runs on',
    connectUrl: 'https://app.n8n.cloud/register',
    billingUrl: 'https://app.n8n.cloud/',
    keysUrl: (endpoint) =>
      endpoint && /^https?:\/\//.test(endpoint)
        ? `${endpoint.replace(/\/+$/, '')}/settings/api`
        : 'https://app.n8n.cloud/',
    endpointHint: 'https://client.app.n8n.cloud',
    keyStore: 'n8n credentials',
  },
  {
    key: 'twilio',
    name: 'Twilio',
    kind: 'twilio',
    category: 'messaging',
    blurb: 'the number that texts leads back',
    connectUrl: 'https://www.twilio.com/try-twilio',
    billingUrl: 'https://console.twilio.com/us1/billing/manage-billing/billing-overview',
    keysUrl: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
    endpointHint: '+1 801 555 0134',
    keyStore: 'n8n credentials',
  },
  {
    key: 'gohighlevel',
    name: 'GoHighLevel',
    kind: 'gohighlevel',
    category: 'crm',
    blurb: 'crm, pipelines and the sub-account leads land in',
    connectUrl: 'https://www.gohighlevel.com/',
    billingUrl: 'https://app.gohighlevel.com/',
    keysUrl: 'https://app.gohighlevel.com/',
    endpointHint: 'sub-account id',
    keyStore: 'n8n credentials',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    kind: 'ai',
    category: 'ai',
    blurb: 'models behind replies, summaries and triage',
    connectUrl: 'https://platform.openai.com/signup',
    billingUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    keysUrl: 'https://platform.openai.com/api-keys',
    endpointHint: 'organization id',
    keyStore: 'n8n credentials',
  },
  {
    key: 'anthropic',
    name: 'Anthropic',
    kind: 'ai',
    category: 'ai',
    blurb: 'claude, for replies and anything that reads',
    connectUrl: 'https://console.anthropic.com/',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    endpointHint: 'workspace',
    keyStore: 'n8n credentials',
  },
  {
    key: 'vapi',
    name: 'Vapi',
    kind: 'ai',
    category: 'voice',
    blurb: 'the voice agent that picks up missed calls',
    connectUrl: 'https://dashboard.vapi.ai/',
    billingUrl: 'https://dashboard.vapi.ai/',
    keysUrl: 'https://dashboard.vapi.ai/',
    endpointHint: 'assistant id',
    keyStore: 'n8n credentials',
  },
  {
    key: 'google',
    name: 'Google Workspace',
    kind: 'calendar',
    category: 'calendar',
    blurb: 'calendar booking, gmail and sheets',
    connectUrl: 'https://workspace.google.com/',
    billingUrl: 'https://admin.google.com/ac/billing/subscriptions',
    keysUrl: 'https://console.cloud.google.com/apis/credentials',
    endpointHint: 'owner@company.com',
    keyStore: 'n8n credentials',
  },
  {
    key: 'calendly',
    name: 'Calendly',
    kind: 'calendar',
    category: 'calendar',
    blurb: 'booking links sent in the first reply',
    connectUrl: 'https://calendly.com/signup',
    billingUrl: 'https://calendly.com/app/admin/billing',
    keysUrl: 'https://calendly.com/integrations/api_webhooks',
    endpointHint: 'calendly.com/company',
    keyStore: 'n8n credentials',
  },
  {
    key: 'jobber',
    name: 'Jobber',
    kind: 'crm',
    category: 'field service',
    blurb: 'jobs, quotes and the client list for trades',
    connectUrl: 'https://getjobber.com/',
    billingUrl: 'https://secure.getjobber.com/',
    keysUrl: 'https://developer.getjobber.com/',
    endpointHint: 'account name',
    keyStore: 'n8n credentials',
  },
  {
    key: 'housecallpro',
    name: 'Housecall Pro',
    kind: 'crm',
    category: 'field service',
    blurb: 'dispatch and jobs for home-service shops',
    connectUrl: 'https://www.housecallpro.com/',
    billingUrl: 'https://pro.housecallpro.com/',
    keysUrl: 'https://pro.housecallpro.com/',
    endpointHint: 'company name',
    keyStore: 'n8n credentials',
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    kind: 'crm',
    category: 'crm',
    blurb: 'contacts and deals, where a client already lives there',
    connectUrl: 'https://app.hubspot.com/signup-hubspot/crm',
    billingUrl: 'https://app.hubspot.com/',
    keysUrl: 'https://app.hubspot.com/',
    endpointHint: 'portal id',
    keyStore: 'n8n credentials',
  },
  {
    key: 'stripe',
    name: 'Stripe',
    kind: 'payments',
    category: 'payments',
    blurb: 'deposits and invoices taken inside a flow',
    connectUrl: 'https://dashboard.stripe.com/register',
    billingUrl: 'https://dashboard.stripe.com/settings/billing',
    keysUrl: 'https://dashboard.stripe.com/apikeys',
    endpointHint: 'acct_…',
    keyStore: 'n8n credentials',
  },
  {
    key: 'sendgrid',
    name: 'SendGrid',
    kind: 'email',
    category: 'email',
    blurb: 'transactional email out of a workflow',
    connectUrl: 'https://signup.sendgrid.com/',
    billingUrl: 'https://app.sendgrid.com/settings/billing',
    keysUrl: 'https://app.sendgrid.com/settings/api_keys',
    endpointHint: 'sender address',
    keyStore: 'n8n credentials',
  },
  {
    key: 'slack',
    name: 'Slack',
    kind: 'messaging',
    category: 'messaging',
    blurb: 'lead alerts into the client’s own channel',
    connectUrl: 'https://slack.com/get-started',
    billingUrl: 'https://slack.com/help/articles/218915077',
    keysUrl: 'https://api.slack.com/apps',
    endpointHint: '#leads in workspace',
    keyStore: 'n8n credentials',
  },
  {
    key: 'airtable',
    name: 'Airtable',
    kind: 'database',
    category: 'data',
    blurb: 'a base the client edits by hand',
    connectUrl: 'https://airtable.com/signup',
    billingUrl: 'https://airtable.com/account',
    keysUrl: 'https://airtable.com/create/tokens',
    endpointHint: 'base id',
    keyStore: 'n8n credentials',
  },
];

export const INTEGRATION_BY_KEY = new Map(INTEGRATIONS.map((entry) => [entry.key, entry]));

export function integrationFor(connection) {
  return INTEGRATION_BY_KEY.get(providerOf(connection)) ?? null;
}

/* rows written before 0006 have no provider. where the old `kind` names exactly one
   service it is safe to read it as that service; `crm` or `other` is not. */
export function providerOf(connection) {
  if (connection.provider) return connection.provider;
  return ['n8n', 'twilio', 'gohighlevel'].includes(connection.kind) ? connection.kind : null;
}

export function keysUrlFor(integration, connection) {
  if (!integration) return null;
  return typeof integration.keysUrl === 'function'
    ? integration.keysUrl(connection?.endpoint)
    : integration.keysUrl;
}

/* when a client has more than one row for a service — a retired number and its
   replacement — the card speaks for the best of them. */
const STATUS_RANK = { connected: 0, paused: 1, planned: 2, retired: 3 };

export function connectionsFor(integration, connections) {
  return connections
    .filter((connection) => providerOf(connection) === integration.key)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
}

/* ── billing ───────────────────────────────────────────────── */

export const BILLING_STATUS_OPTIONS = [
  { value: 'none', label: 'not tracked' },
  { value: 'trial', label: 'trial' },
  { value: 'active', label: 'active · paid' },
  { value: 'past_due', label: 'past due' },
  { value: 'cancelled', label: 'cancelled' },
];

export const PAID_BY_OPTIONS = [
  { value: '', label: '—' },
  { value: 'arc', label: 'arc pays' },
  { value: 'client', label: 'client pays' },
];

export const BILLING_CYCLE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'monthly', label: 'monthly' },
  { value: 'annual', label: 'annual' },
  { value: 'usage', label: 'usage-based' },
];

/* inside this, a renewal is something to know about this week. */
const RENEWAL_WARN_DAYS = 7;

/**
 * where a subscription stands, as a pill.
 *
 * a renewal date in the past is not read as "lapsed". the date is typed by a human,
 * and the likeliest story is that the card was charged and nobody rolled the date
 * forward — so it says to confirm the charge, which is true either way, rather
 * than claiming an outage the console cannot see.
 */
export function billingState(connection, timezone = 'UTC', now = DateTime.now()) {
  const status = connection.billingStatus ?? 'none';
  const today = now.setZone(timezone).startOf('day');
  const renews = connection.renewsAt
    ? DateTime.fromISO(connection.renewsAt, { zone: timezone }).startOf('day')
    : null;
  const days = renews ? Math.round(renews.diff(today, 'days').days) : null;
  const when = renews ? renews.toFormat('LLL d, yyyy') : null;

  if (status === 'none') return { tone: 'idle', label: 'not tracked', days: null, rank: 5 };
  if (status === 'cancelled') {
    return {
      tone: connection.status === 'connected' ? 'fail' : 'idle',
      label: 'cancelled',
      days,
      rank: connection.status === 'connected' ? 0 : 6,
    };
  }
  if (status === 'past_due') return { tone: 'fail', label: 'payment past due', days, rank: 0 };

  const noun = status === 'trial' ? 'trial ends' : 'renews';

  if (days === null) {
    return { tone: 'neutral', label: status === 'trial' ? 'trial · no end date' : 'paid · no renewal date', days, rank: 4 };
  }
  if (days < 0) {
    return {
      tone: 'warn',
      label: status === 'trial' ? `trial ended ${when}` : `renewal passed ${when} — confirm it charged`,
      days,
      rank: 1,
    };
  }
  if (days === 0) return { tone: 'warn', label: `${noun} today`, days, rank: 1 };
  if (days <= RENEWAL_WARN_DAYS) {
    return { tone: 'warn', label: `${noun} in ${days}d`, days, rank: 2 };
  }
  return { tone: 'ok', label: `${noun} ${when}`, days, rank: 3 };
}

/* a subscription's cost per month, so a roster total can add annual and monthly
   plans without lying about either. usage-based costs are an estimate and the
   total says so. */
export function monthlyCents(connection) {
  if (connection.costCents == null || connection.billingStatus === 'cancelled') return 0;
  return connection.billingCycle === 'annual'
    ? Math.round(connection.costCents / 12)
    : connection.costCents;
}

export function billingTotals(connections) {
  const billed = connections.filter(
    (connection) => connection.billingStatus && connection.billingStatus !== 'none',
  );
  const sum = (who) =>
    billed
      .filter((connection) => (who ? connection.paidBy === who : true))
      .reduce((total, connection) => total + monthlyCents(connection), 0);

  return {
    tracked: billed.length,
    monthly: sum(null),
    arc: sum('arc'),
    client: sum('client'),
    hasUsage: billed.some((connection) => connection.billingCycle === 'usage'),
  };
}

export function formatMoney(cents) {
  if (cents == null) return '—';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/* the next renewal date after paying, one cycle on from the current one — or from
   today if the date was never set or has long passed. */
export function nextRenewal(connection, timezone = 'UTC', now = DateTime.now()) {
  const today = now.setZone(timezone).startOf('day');
  const unit = connection.billingCycle === 'annual' ? 'years' : 'months';
  const base = connection.renewsAt
    ? DateTime.fromISO(connection.renewsAt, { zone: timezone }).startOf('day')
    : today;
  /* always counted from the original date, never stepped from the last result:
     a plan billed on the 31st goes through february as the 28th and must come
     back out as the 31st, not stay on the 28th. */
  let n = 1;
  while (base.plus({ [unit]: n }) < today) n += 1;
  return base.plus({ [unit]: n }).toISODate();
}
