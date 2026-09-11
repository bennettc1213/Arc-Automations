// ─────────────────────────────────────────────────────────────
// site.js — every word, number, and link on the site lives here.
// Edit this file, not the components.
// ─────────────────────────────────────────────────────────────

export const site = {
  wordmark: 'arc',
  brand: 'arc automations',
  email: 'bennettch1213@gmail.com', // swap for hello@arcautomations.com when the domain email exists

  /* the operator console's sign-in identity.
     supabase authenticates a password against an account, so something has to
     name the account — and with one operator that is a constant, not a field
     somebody retypes daily. it is kept separate from `email` above because that
     one is the public contact address and is expected to become a shared inbox;
     this one is a login and must keep pointing at a real auth user.
     not a secret: the same address is already printed in the footer and every
     mailto on the site. what protects /ops is the password plus arc_admins and
     row level security, never the obscurity of the address. */
  opsEmail: 'bennettch1213@gmail.com',

  hero: {
    eyebrow: 'arc automations — ai systems for home-services contractors',
    lines: ["we don't just", 'wire up'],
    // last word cycles; `hold` is how long each stays on screen (ms)
    cycle: [
      { word: 'zaps.', hold: 1800 },
      { word: 'demos.', hold: 1800 },
      { word: 'templates.', hold: 1800 },
      { word: 'workflows.', hold: 3400 },
    ],
    sub: 'production automation for hvac, plumbing, roofing & restoration crews — built on n8n, claude code, and gohighlevel. leads answered in seconds, not voicemail.',
    location: 'northern utah',
  },

  marqueeA: [
    'n8n',
    'claude code',
    'gohighlevel',
    'rag',
    'react three fiber',
    'webhooks',
    'lead automation',
    'missed-call textback',
    'ai voice + sms',
    'review engines',
  ],

  marqueeB: [
    'speed-to-lead',
    'booked jobs',
    '24/7 intake',
    'error-handled',
    'production only',
    'no templates',
    'built by hand',
  ],

  projects: [
    {
      id: 'speed-to-lead',
      index: '01',
      title: 'n8n speed-to-lead',
      tag: '( n8n · GHL · twilio )',
      status: 'flagship — in production',
      copy: 'a lead fills out a form at 11pm. by 11:01 they have a text, a call queued, and a slot on the calendar — before the competitor’s office even opens. production lead-intake, wired straight into gohighlevel.',
      points: ['instant sms + call bridge', 'lead scoring before routing', 'loud failures — errors page us, not the contractor'],
      demo: 'speedToLead',
    },
    {
      id: 'lead-qualification-agent',
      index: '02',
      title: 'lead qualification agent',
      tag: '( n8n · claude · GHL )',
      status: 'in production',
      copy: 'an n8n agent that works every inbound inquiry — asks the qualifying questions, scores intent against your service area and job types, and routes hot leads straight to your phone.',
      points: ['qualifies before you pick up', 'grounded in your services + coverage area', 'hot leads routed, tire-kickers handled politely'],
      demo: 'supportAgent',
    },
    {
      id: 'rue-noir',
      index: '03',
      title: 'rue noir coffee',
      tag: '( design · gsap · scroll )',
      status: 'design build',
      copy: 'a paris-noir coffee site with a cinematic scroll hero — a slow descent from the eiffel tower down to the cup. proof the automation guy can also make things beautiful.',
      points: ['scroll-driven hero sequence', 'aged-paper grain, engraved plates', 'its hero, echoed live in this card →'],
      demo: 'rueNoir',
      liveUrl: 'https://bennettc1213.github.io/rue-noir-coffee',
    },
    {
      id: 'home-service-crm',
      index: '04',
      title: 'home-service crm',
      tag: '( n8n · supabase · GHL )',
      status: 'design build',
      copy: 'a crm that runs the whole contracting business off one screen — every customer, job, and estimate in a single record, with follow-ups and service reminders that fire on their own.',
      points: ['customers + job history in one place', 'estimates that become booked jobs', 'automatic follow-ups, reminders, and recall'],
      demo: 'crm',
    },
    {
      id: 'missed-call-text-back',
      index: '05',
      title: 'missed-call text-back',
      tag: '( n8n · twilio · GHL )',
      status: 'design build',
      copy: 'the calls contractors miss while they are on a roof — answered in 42 seconds by a text, with a booking link already in the thread. no lead ever goes to voicemail and dies.',
      points: ['every missed call texts back in under a minute', 'caller id, name, and intent, already parsed', 'one tap on the link becomes a booked job'],
      demo: 'missedCall',
    },
  ],

  /* the index — hover-reveal grid. url: null renders the honest label instead of a fake
     link, and that stays: never link to something that is not there.
     five rows, not seven. two carry a not-yet-live label and no more, because a list where
     four of seven say "soon" does not read as honest, it reads as "mostly hasn't
     happened". `pale ember espresso` is gone entirely — a local-only coffee build means
     nothing to a restoration contractor deciding whether to trust us with their phones. */
  workIndex: [
    { title: 'n8n speed-to-lead', year: '2026', kind: 'automation', url: null, urlLabel: 'in production · private', media: 'speed-to-lead-canvas.png', mediaSpec: 'full-res n8n canvas screenshot' },
    { title: 'lead qualification agent', year: '2026', kind: 'ai agent', url: null, urlLabel: 'in production · private', media: 'lead-qualification-canvas.png', mediaSpec: 'full-res n8n canvas screenshot' },
    { title: 'warranty expiration tracker', year: '2026', kind: 'automation', url: null, urlLabel: 'deployed · n8n cloud', media: 'warranty-tracker-canvas.png', mediaSpec: 'full-res n8n canvas screenshot' },
    { title: 'rue noir coffee', year: '2026', kind: 'site', url: 'https://bennettc1213.github.io/rue-noir-coffee', urlLabel: 'live site', media: 'rue-noir-cover.jpg', mediaSpec: 'hero frame, 1920×1080' },
    { title: 'missed-call text-back', year: '2026', kind: 'automation', url: null, urlLabel: 'design build · in production soon', media: 'missed-call-canvas.png', mediaSpec: 'full-res n8n canvas screenshot' },
  ],

  /* every chip renders; `core: true` gets the accent style so the tools a contractor
     cares about stand out from the rest of the stack. */
  toolkit: [
    { label: 'n8n', core: true },
    { label: 'claude code', core: true },
    { label: 'gohighlevel', core: true },
    { label: 'twilio', core: true },
    { label: 'webhooks', core: true },
    { label: 'rest apis', core: true },
    { label: 'rag', core: true },
    { label: 'javascript' },
    { label: 'node.js' },
    { label: 'react' },
    { label: 'react three fiber' },
    { label: 'rapier' },
    { label: 'three.js' },
    { label: 'gsap' },
    { label: 'lenis' },
    { label: 'framer motion' },
    { label: 'matter.js' },
    { label: 'vite' },
  ],

  /* the workflows — every tab is an offering, and there are three of them on purpose.
     an eleven-item menu from a solo operator reads as an agency that will take any job,
     which is the exact opposite of the "one narrow offer, already in production" position
     the rest of this site is built on. the other eight are shelved below rather than
     deleted: each one comes back the day there is a case study behind it. */
  workflows: [
    {
      id: 'speed-to-lead',
      label: 'speed-to-lead',
      tag: '( n8n · GHL · twilio )',
      description:
        'a lead fills out a form at 11pm — by 11:01 they have a text, a call queued, and a slot on the calendar, before the competitor’s office even opens. production lead-intake wired straight into gohighlevel.',
      points: ['instant sms + call bridge', 'lead scoring before routing', 'loud failures — errors page us, not the contractor'],
    },
    {
      id: 'missed-call-text-back',
      label: 'missed-call text-back',
      tag: '( n8n · twilio · GHL )',
      description:
        'the calls you miss while you are on a roof or under a house — answered in under a minute by a text with a booking link already in the thread. no lead goes to voicemail and dies there.',
      points: ['every missed call texts back in under a minute', 'caller id, name, and intent, already parsed', 'one tap on the link becomes a booked job'],
    },
    {
      id: 'lead-qualification',
      label: 'lead qualification agent',
      tag: '( n8n · claude · GHL )',
      description:
        'an n8n agent that works every inbound inquiry — asks the qualifying questions, scores intent against your service area and job types, and routes hot leads straight to your phone.',
      points: ['qualifies before you pick up', 'grounded in your services + coverage area', 'hot leads routed, tire-kickers handled politely'],
    },
  ],

  /* everything else we build. hidden behind a toggle under the three tabs above,
     not deleted: the three lead because they are the narrow, provable offer, and
     these are one click away for anyone who wants the rest of the menu. */
  workflowsMore: [
    {
      id: 'warranty-tracker',
      label: 'warranty expiration tracker',
      tag: '( n8n · GHL · cron )',
      description:
        'a nightly sweep finds warranties coming up on expiration, drafts the outreach, and queues the follow-up sequence — renewal work booked before the lapse, not a scramble after it.',
      points: ['nightly cron over the customer list', 'drafts + queues the outreach', 'renewal work booked early'],
    },
    {
      id: 'workflow-automations',
      label: 'workflow automations',
      tag: '( n8n · custom )',
      description:
        'custom n8n workflows that wire your tools together and run the repetitive parts of your operation — on a schedule, a webhook, or an event.',
      points: ['scheduled / webhook / event triggered', 'connects the tools you already use', 'error branches — failures page us, not you'],
    },
    {
      id: 'ai-chat-bots',
      label: 'ai chat & service bots',
      tag: '( n8n · claude · openai )',
      description:
        'chat and voice bots that answer customer questions at 2am, qualify leads before they reach you, and hand off to a human the moment it matters.',
      points: ['24/7 on every channel — web, sms, voice', 'answers grounded in your actual services', 'smooth handoff to a human'],
    },
    {
      id: 'websites',
      label: 'professional websites',
      tag: '( react · design )',
      description:
        'fast, custom-built websites that make your business look like it has its act together — built to turn visitors into booked calls, not just to look pretty.',
      points: ['custom design, no templates', 'built for speed + lead capture', 'wired into your crm from day one'],
    },
    {
      id: 'crm-data',
      label: 'crm & data integration',
      tag: '( gohighlevel · api )',
      description:
        'your crm, jobber, servicetitan, or a google sheet your office manager loves — wired together so a lead that enters anywhere shows up everywhere. no double entry.',
      points: ['gohighlevel, jobber, servicetitan + more', 'two-way sync, no double entry', 'one source of truth for your numbers'],
    },
    {
      id: 'business-process',
      label: 'business process automation',
      tag: '( n8n · custom )',
      description:
        'back-office operations — invoicing, follow-ups, scheduling, reporting — automated end to end, so your team works the exceptions instead of the busywork.',
      points: ['invoicing, scheduling, reporting', 'end-to-end, not point solutions', 'your team works the exceptions'],
    },
    {
      id: 'marketing-automation',
      label: 'marketing automation',
      tag: '( email · sms )',
      description:
        'follow-up sequences, drip campaigns, and review engines that keep your name in front of the people who have already raised their hand.',
      points: ['email + sms nurture sequences', 'review engines on autopilot', 'every campaign measured'],
    },
    {
      id: 'ai-analytics',
      label: 'ai-powered analytics',
      tag: '( ai · dashboards )',
      description:
        'your numbers, explained. dashboards that show response time, booked rate, and where leads are leaking — with ai summaries instead of spreadsheets nobody opens.',
      points: ['live dashboards, not static reports', 'ai-written summaries of the week', 'find the leak before it costs a job'],
    },
    {
      id: 'custom-saas',
      label: 'custom saas & portals',
      tag: '( custom · saas )',
      description:
        'bespoke software built around exactly how you work — employee portals, client portals, internal tools, or a whole product for your market.',
      points: ['employee + client portals', 'internal tools built to your process', 'from a single tool to a full product'],
    },
  ],

  // start-a-pilot overlay — intake questions + booking config
  pilot: {
    questions: [
      {
        key: 'trade',
        q: 'what kind of work do you do?',
        options: ['hvac', 'plumbing', 'roofing', 'restoration', 'other'],
      },
      {
        key: 'pain',
        q: 'what’s eating your week?',
        options: [
          'leads going cold before we call back',
          'drowning in customer questions',
          'chasing warranty renewals',
          'manual scheduling',
          'not sure yet — want to explore',
        ],
      },
      {
        key: 'volume',
        q: 'how many calls / leads a week?',
        options: ['under 20', '20–50', '50–100', '100+'],
      },
    ],
    // pain → which pilot the booking line shows
    pilotFor: {
      'leads going cold before we call back': 'speed-to-lead pilot',
      'drowning in customer questions': 'lead qualification pilot',
      'chasing warranty renewals': 'warranty tracker pilot',
      'manual scheduling': 'scheduling pilot',
      'not sure yet — want to explore': 'discovery call',
    },
    // openPilot(key) short-circuits to one of these — no trade/pain/volume intake
    presets: {
      'marketing-automation': {
        label: 'marketing automation pilot',
        questions: [
          { key: 'channels', q: 'where does your marketing live right now?', options: ['google ads', 'facebook + instagram', 'organic · seo', 'word of mouth', 'nowhere yet'] },
          { key: 'goal', q: 'what should it do for you?', options: ['more booked jobs', 'more calls from ads', 'reviews on autopilot', 'repeat + referral business', 'not sure — that’s the point'] },
          { key: 'material', q: 'what can we work with today?', options: ['real photos of the work', 'a stack of past reviews', 'videos of jobs', 'a logo and a story', 'barely anything — help us start'] },
        ],
        fields: [
          { key: 'name', label: 'name', type: 'text', autoComplete: 'name' },
          { key: 'business', label: 'business', type: 'text', autoComplete: 'organization' },
          { key: 'website', label: 'website / url', type: 'url', autoComplete: 'url' },
          { key: 'email', label: 'email', type: 'email', autoComplete: 'email' },
          { key: 'phone', label: 'phone', type: 'tel', autoComplete: 'tel' },
        ],
      },
    },
    /* every completed intake POSTs here before the booking step — fire and
       forget, and a failure never blocks the visitor from reaching the
       calendar. this is the only thing standing between a filled-out form and
       a lead you never learn about, so it matters more than the embed below.
       paste the n8n production webhook URL. empty = nothing is captured, and
       the overlay says so honestly rather than claiming a send it didn't make. */
    captureUrl: '',

    booking: {
      // pick 'calcom' or 'ghl' and paste the event link; buildEmbedSrc()
      // prefills name, email, phone, and the intake answers for both.
      // until a provider is set the flow lands on a pre-filled email — never
      // a dead end, and never an apology for the booking not existing.
      provider: null,
      embedUrl: '',
    },
  },

  process: [
    {
      q: 'we find the leak',
      a: 'one afternoon with your numbers: where calls go to voicemail, where forms sit unread, where reviews never get asked for. most shops are losing jobs in the first five minutes — we find exactly where.',
    },
    {
      q: 'one pilot, one week',
      a: 'a single flow, live in production — usually speed-to-lead. wired to your gohighlevel, tested against real leads, measured against your old response time. small enough to trust, real enough to matter.',
      price: 'flat $1,500 to build it — then $500/mo if it earns its keep. no retainer until the pilot is live and you have seen the numbers.',
    },
    {
      q: 'it plugs into what you already run',
      a: 'no rip-and-replace. gohighlevel, jobber, servicetitan, a google sheet your office manager loves — the automation wraps around whatever is answering the phones today.',
    },
    {
      q: 'you see every number',
      a: 'response time, booked rate, missed calls recovered. a dashboard, not a vibe. if the system stops earning its keep, you’ll know before we tell you.',
    },
    {
      q: 'it fails loud, not silent',
      a: 'every workflow ships with error branches, retries, and alerts. a 2am failure pages us — not you, and never the customer. silent breakage is the one thing we don’t ship.',
    },
  ],

  footer: {
    heading: 'your leads are waiting.',
    sub: 'most contractors respond in hours. yours will respond in seconds.',
    cta: 'start a pilot',
  },

  ticker: ['arc automations', 'northern utah', 'open for pilot builds', 'speed-to-lead < 60s', 'built by hand, not a template'],
};
