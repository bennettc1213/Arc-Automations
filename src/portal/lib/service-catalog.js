import { site } from '../../data/site';

/* what arc sells, and what building each one for a client actually takes.
 *
 * arc is a menu of services, not a consultancy: a client buys speed-to-lead and
 * missed-call text-back, and each one is a job with an end. this is the one
 * declaration of those jobs — the picker on "add a client" reads it, and so does
 * "add a service" on a client page.
 *
 * the keys are the ids in site.js, and the name and stack tag are read from there,
 * so the console calls a service what the public site calls it. `fallback` is only
 * used if a service is ever taken off the site while clients still have it.
 *
 * each checklist is two phases, in the order the work happens:
 *
 *   build      on arc's side — in arc's n8n, against test data — before the
 *              client's business is touched
 *   integrate  into their business: their number, their crm, their team, real
 *              traffic
 *
 * the steps are copied into the database when a service is added to a client
 * (migration 0008), so editing a list here changes the next client, never a build
 * already underway.
 *
 * `evidence` names something the console can check for itself — see stepEvidence
 * in builds.js. a step with evidence shows what the event log or the services
 * panel says beside the tick, so "ticked" and "true" are allowed to disagree on
 * screen. most steps have none: nothing in the log can prove a walkthrough
 * happened, and a step that pretended to would be worse than one that does not.
 */

const CATALOG = [
  {
    key: 'speed-to-lead',
    fallback: 'speed-to-lead',
    brief: 'form or message in, a text back in seconds, a call bridged, a slot booked',
    needs: ['n8n', 'twilio', 'gohighlevel'],
    steps: [
      ['build', 'sources', 'list every lead source and what each one sends', 'web forms, google business messages, ads, angi — the fields each one actually delivers'],
      ['build', 'first-reply', 'write the first text in their voice', 'their business name and the lead’s first name in it; approved by the owner'],
      ['build', 'workflow', 'build the intake workflow', 'lead in → text back → call bridge → calendar slot'],
      ['build', 'scoring', 'score and route before anyone is called', 'service area and job type decide who hears about it'],
      ['build', 'errors', 'error branches, retries and a failure alert to arc'],
      ['build', 'tested', 'run test leads end to end, after hours included'],
      ['integrate', 'twilio', 'their texting number is live and recorded', 'a2p registration done; the number is on services & subscriptions', 'account:twilio'],
      ['integrate', 'crm', 'leads land in their gohighlevel, in the right stage', null, 'account:gohighlevel'],
      ['integrate', 'sources-live', 'point every lead source at the live webhook'],
      ['integrate', 'events', 'it posts its events to their portal', 'ingest token in the n8n credential; the portal shows the runs', 'token'],
      ['integrate', 'first-lead', 'a real lead answered', null, 'leads'],
      ['integrate', 'monitoring', 'the hourly end-to-end check runs against it', null, 'canary'],
      ['integrate', 'handover', 'walk the owner through a live lead and their portal'],
    ],
  },
  {
    key: 'missed-call-text-back',
    fallback: 'missed-call text-back',
    brief: 'a call rings out, and the caller gets a text with a booking link instead of voicemail',
    needs: ['n8n', 'twilio', 'gohighlevel'],
    steps: [
      ['build', 'wording', 'agree the text-back wording and the booking link in it'],
      ['build', 'workflow', 'build the missed-call trigger and the text back', 'under a minute from the call ringing out'],
      ['build', 'parse', 'caller id, name and intent parsed into the thread'],
      ['build', 'hours', 'business hours and after hours behave differently', 'what they want said at 2am is not what they want said at 2pm'],
      ['build', 'errors', 'error branches, retries and a failure alert to arc'],
      ['build', 'tested', 'test with real calls from an outside number'],
      ['integrate', 'forwarding', 'their main line forwards unanswered calls to the twilio number', 'or the twilio number is the tracking line on their site and ads', 'account:twilio'],
      ['integrate', 'calendar', 'the booking link goes to their real calendar'],
      ['integrate', 'crm', 'replies and bookings land in their gohighlevel', null, 'account:gohighlevel'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'first-call', 'a real missed call answered', null, 'missed'],
      ['integrate', 'handover', 'show the office where the replies reach them'],
    ],
  },
  {
    key: 'lead-qualification',
    fallback: 'lead qualification agent',
    brief: 'an agent asks the qualifying questions and routes the hot leads to a phone',
    needs: ['n8n', 'anthropic', 'gohighlevel'],
    steps: [
      ['build', 'ground-truth', 'write down their service area, job types and what makes a lead hot'],
      ['build', 'questions', 'draft the qualifying questions and the tone', 'approved by the owner before the agent is built'],
      ['build', 'agent', 'build the agent, grounded in their services and coverage'],
      ['build', 'routing', 'scoring and routing rules', 'hot leads to a phone now; the rest handled politely'],
      ['build', 'guardrails', 'guardrails: a human handoff, no prices or promises it cannot keep'],
      ['build', 'tested', 'replay twenty past inquiries and read every answer'],
      ['integrate', 'model', 'the model account and key are recorded', null, 'account:anthropic'],
      ['integrate', 'channels', 'connected to the channels their inquiries arrive on'],
      ['integrate', 'phones', 'hot-lead routing reaches the right phones', 'tested with whoever is on call'],
      ['integrate', 'crm', 'score and answers written to their gohighlevel', null, 'account:gohighlevel'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'first-lead', 'a real inquiry qualified and routed', null, 'leads'],
      ['integrate', 'sign-off', 'the owner reads a week of conversations and signs off'],
    ],
  },
  {
    key: 'warranty-tracker',
    fallback: 'warranty expiration tracker',
    brief: 'a nightly sweep finds warranties coming due and queues the outreach',
    needs: ['n8n', 'gohighlevel'],
    steps: [
      ['build', 'source', 'find where install and warranty dates live today'],
      ['build', 'sweep', 'build the nightly sweep for warranties coming due'],
      ['build', 'outreach', 'draft the outreach and the follow-up sequence', 'approved by the owner'],
      ['build', 'errors', 'error branches and a failure alert to arc'],
      ['build', 'dry-run', 'dry run over their real list, sending nothing'],
      ['integrate', 'list', 'their customer list is connected', null, 'account:gohighlevel'],
      ['integrate', 'sender', 'outreach sends from their number or address'],
      ['integrate', 'review', 'review the first night’s run with the owner before anything sends'],
      ['integrate', 'on', 'switched on for real'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
    ],
  },
  {
    key: 'workflow-automations',
    fallback: 'workflow automations',
    brief: 'a custom n8n workflow for one repetitive part of their operation',
    needs: ['n8n'],
    steps: [
      ['build', 'process', 'write the process down as it happens today, step by step'],
      ['build', 'trigger', 'agree the trigger — a schedule, a webhook or an event'],
      ['build', 'workflow', 'build the workflow'],
      ['build', 'errors', 'error branches, retries and a failure alert to arc'],
      ['build', 'tested', 'test against real examples from their week'],
      ['integrate', 'credentials', 'credentials for every tool it touches are recorded'],
      ['integrate', 'on', 'switched on in production', null, 'account:n8n'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'first-run', 'the first production run checked by hand', null, 'events'],
      ['integrate', 'handover', 'handover: what it does, and what happens when it alerts'],
    ],
  },
  {
    key: 'ai-chat-bots',
    fallback: 'ai chat & service bots',
    brief: 'a chat or voice bot that answers at 2am and hands off to a human',
    needs: ['n8n', 'anthropic'],
    steps: [
      ['build', 'knowledge', 'gather what it answers from', 'services, service area, hours, the questions the office hears every day'],
      ['build', 'persona', 'write the persona and the handoff rules'],
      ['build', 'bot', 'build the bot and its knowledge base'],
      ['build', 'errors', 'error branches and a failure alert to arc'],
      ['build', 'tested', 'ask it thirty real customer questions and fix every wrong answer'],
      ['integrate', 'model', 'the model account and key are recorded', null, 'account:anthropic'],
      ['integrate', 'placed', 'live on their channels', 'website widget, sms or voice — whichever they bought'],
      ['integrate', 'handoff', 'a handoff reaches the right person'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'first-conversation', 'a real conversation read end to end', null, 'events'],
      ['integrate', 'handover', 'walk the owner through it'],
    ],
  },
  {
    key: 'websites',
    fallback: 'professional websites',
    brief: 'a fast custom site built to turn visitors into booked calls',
    needs: [],
    steps: [
      ['build', 'material', 'collect the logo, photos, reviews, services and service area'],
      ['build', 'copy', 'sitemap and copy approved'],
      ['build', 'design', 'design approved'],
      ['build', 'site', 'build it — mobile first, fast'],
      ['build', 'forms', 'lead forms tested end to end'],
      ['build', 'seo', 'titles, local business schema and the google business link'],
      ['integrate', 'domain', 'domain pointed and https on'],
      ['integrate', 'crm', 'forms deliver into their crm'],
      ['integrate', 'analytics', 'analytics installed'],
      ['integrate', 'redirects', 'the old site’s pages redirected'],
      ['integrate', 'launch', 'launched and checked on a phone'],
      ['integrate', 'handover', 'show the owner how to ask for changes'],
    ],
  },
  {
    key: 'crm-data',
    fallback: 'crm & data integration',
    brief: 'their tools wired together so a lead entered anywhere shows up everywhere',
    needs: ['n8n', 'gohighlevel'],
    steps: [
      ['build', 'inventory', 'list every place a lead or a customer lives today'],
      ['build', 'mapping', 'field mapping between the systems, agreed'],
      ['build', 'truth', 'decide which system owns each field'],
      ['build', 'sync', 'build the sync — two-way only where it has to be'],
      ['build', 'dedupe', 'dedupe and backfill tested on a copy'],
      ['build', 'errors', 'a failure alert to arc when a sync fails'],
      ['integrate', 'access', 'api access to each system recorded', null, 'account:gohighlevel'],
      ['integrate', 'backfill', 'historical backfill run'],
      ['integrate', 'live', 'live sync switched on'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'no-double-entry', 'the office confirms a week without double entry'],
    ],
  },
  {
    key: 'business-process',
    fallback: 'business process automation',
    brief: 'a back-office process automated end to end, with people working the exceptions',
    needs: ['n8n'],
    steps: [
      ['build', 'map', 'map the process end to end with whoever does it now'],
      ['build', 'exceptions', 'mark the exceptions a person still has to handle'],
      ['build', 'stages', 'build each stage'],
      ['build', 'errors', 'error branches, retries and a failure alert to arc'],
      ['build', 'parallel', 'run it beside the manual process and compare'],
      ['integrate', 'credentials', 'credentials for every tool it touches are recorded'],
      ['integrate', 'training', 'the team trained on the exceptions queue'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'retired', 'the manual process retired'],
      ['integrate', 'review', 'the first month reviewed with the owner'],
    ],
  },
  {
    key: 'marketing-automation',
    fallback: 'marketing automation',
    brief: 'nurture sequences and a review engine for people who already raised a hand',
    needs: ['n8n', 'twilio'],
    steps: [
      ['build', 'segments', 'segment the list — past customers, open estimates, new leads'],
      ['build', 'sequences', 'write the sequences', 'every message approved by the owner'],
      ['build', 'reviews', 'build the review request after a completed job'],
      ['build', 'opt-out', 'opt-out handling on every send'],
      ['build', 'tested', 'test sends to arc and the owner'],
      ['integrate', 'sender', 'sending number and domain verified', 'a2p registration for sms; spf and dkim for email', 'account:twilio'],
      ['integrate', 'list', 'contact list imported and cleaned'],
      ['integrate', 'on', 'switched on'],
      ['integrate', 'events', 'it posts its events to their portal', null, 'token'],
      ['integrate', 'results', 'the first campaign’s results reviewed with the owner'],
    ],
  },
  {
    key: 'ai-analytics',
    fallback: 'ai-powered analytics',
    brief: 'their numbers on a live dashboard, with a written summary each week',
    needs: ['n8n'],
    steps: [
      ['build', 'numbers', 'agree the numbers that matter to them'],
      ['build', 'provable', 'confirm every figure can be derived from real events', 'no revenue or attribution the pipeline cannot see'],
      ['build', 'summary', 'build the weekly written summary'],
      ['build', 'checked', 'check the figures against a week the owner already knows'],
      ['integrate', 'events', 'their sources post events to the portal', null, 'token'],
      ['integrate', 'arriving', 'real events arriving', null, 'events'],
      ['integrate', 'scheduled', 'the weekly summary scheduled to their inbox'],
      ['integrate', 'handover', 'walk the owner through their portal'],
    ],
  },
  {
    key: 'custom-saas',
    fallback: 'custom saas & portals',
    brief: 'a portal or internal tool built around exactly how they work',
    needs: [],
    steps: [
      ['build', 'scope', 'written scope, including what is out of it'],
      ['build', 'model', 'data model and screens agreed'],
      ['build', 'build', 'build it'],
      ['build', 'auth', 'sign-in and permissions'],
      ['build', 'tested', 'tested with their real data'],
      ['integrate', 'deployed', 'deployed to production'],
      ['integrate', 'accounts', 'user accounts created for their team'],
      ['integrate', 'migrated', 'their existing data migrated'],
      ['integrate', 'training', 'the team trained'],
      ['integrate', 'support', 'support handover: who to call and how'],
    ],
  },
];

const SITE_ENTRIES = new Map(
  [...(site.workflows ?? []), ...(site.workflowsMore ?? [])].map((entry) => [entry.id, entry]),
);

/* the three on the site's front tabs are the offer; the rest sit behind "more".
   the picker keeps that order and marks the difference. */
const FEATURED = new Set((site.workflows ?? []).map((entry) => entry.id));

export const SERVICE_CATALOG = CATALOG.map((entry) => {
  const onSite = SITE_ENTRIES.get(entry.key);
  return {
    key: entry.key,
    name: onSite?.label ?? entry.fallback,
    tag: onSite?.tag?.replace(/^\(\s*|\s*\)$/g, '') ?? null,
    brief: entry.brief,
    needs: entry.needs,
    featured: FEATURED.has(entry.key),
    steps: entry.steps.map(([phase, key, label, detail = null, evidence = null]) => ({
      phase,
      key,
      label,
      detail,
      evidence,
    })),
  };
}).sort((a, b) => Number(b.featured) - Number(a.featured));

export const SERVICE_BY_KEY = new Map(SERVICE_CATALOG.map((service) => [service.key, service]));

export const PHASES = [
  { key: 'build', label: 'build it', note: 'on arc’s side, before it touches their business' },
  { key: 'integrate', label: 'integrate it', note: 'into their business, on real traffic' },
];
