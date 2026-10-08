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

  /* the offer, in the owner's words. one company, one phone line, missed calls texted
     back, every step shown. nothing here promises a speed or a result we have not
     measured on a real phone line, and nothing names the machinery.
     tests/site-offer.test.js reads the rendered page and fails on the words an owner
     should never have to learn. */
  cta: {
    primary: 'get my missed-call count',
    secondary: 'see the proof ledger',
  },

  nav: {
    links: [
      { id: 'leaks', label: 'where jobs slip' },
      { id: 'ledger', label: 'proof ledger' },
      { id: 'process', label: 'how it works' },
      { id: 'price', label: 'price' },
      { id: 'work', label: 'past work' },
    ],
    portal: 'portal',
    // the bar has room for three words, not five
    cta: 'missed-call count',
  },

  hero: {
    eyebrow: 'arc automations — for hvac shops with 2 to 10 trucks',
    // one short line each: the headline is sized so its longest line fills the column
    lines: ['missed calls', 'become', 'missed jobs.'],
    accent: ['arc texts', 'them back.'],
    sub: 'for small hvac companies that cannot answer every call. arc texts the caller back, books the job or hands it to you, and shows you every step. a small monthly base, plus a fee only for jobs we can prove we brought back. the missed-call count is free.',
    stageCaption: 'the owner portal, on example data — open the demo →',
  },

  marqueeA: [
    'missed call',
    'text back',
    'customer replied',
    'booked job',
    'handed to you',
    'needs you',
    'proof',
    'not billable yet',
  ],

  marqueeB: [
    'one company',
    'one phone line',
    'every step shown',
    'only proven jobs count',
    'stop means stop',
    'a person takes over when it matters',
  ],

  /* the four places a job slips away, as a staged map. `stage` is a claim about today:
     launch | next | later | blocked. only the first is offered, and even that one says
     "opening with one pilot", not "live" — move a stage only when the thing behind it
     works from start to finish. */
  leaks: {
    eyebrow: '02 — where jobs slip away',
    title: 'jobs slip away in four places.',
    lead: 'we start with one: the call you missed. the other three come one at a time, and none is switched on until it works from start to finish.',
    items: [
      {
        key: 'missed-calls',
        stage: 'launch',
        name: 'the call you missed',
        what: 'a call nobody picks up gets a text back. arc asks what is wrong and where, then books the job or hands it to you.',
        status: 'first — opening with one hvac pilot',
      },
      {
        key: 'quiet-estimates',
        stage: 'next',
        name: 'the estimate that went quiet',
        what: 'you quote a job and hear nothing. a short follow-up that stops the moment the customer answers.',
        status: 'next — not built yet',
      },
      {
        key: 'missing-reviews',
        stage: 'later',
        name: 'the review you never got',
        what: 'one request after a finished job, and one reminder at most.',
        status: 'later — not built yet',
      },
      {
        key: 'past-customers',
        stage: 'blocked',
        name: 'the customer who never came back',
        what: 'tune-up reminders to past customers. we text nobody until we can prove they agreed to it.',
        status: 'blocked — waiting on consent records',
      },
    ],
  },

  /* the proof ledger, shown as three made-up leads and labelled as made up. no clock
     times on the steps: how fast the text goes out is a number we publish after it has
     been measured on a real line, not before. */
  ledger: {
    eyebrow: '03 — the proof ledger',
    title: 'every job comes with its proof.',
    lead: 'each lead is one line you can open: when the call came in, what arc sent, what the customer said, what was booked, and why it counts or does not.',
    exampleNote: 'example leads — not real customers',
    leads: [
      {
        key: 'counts',
        who: 'missed call · tuesday evening',
        steps: [
          'call came in. nobody answered.',
          'arc texted back.',
          'customer replied: “ac is blowing warm air.”',
          'booked for wednesday morning.',
          'you confirmed the visit happened.',
        ],
        verdict: 'counts',
        reason: 'every step is on record.',
      },
      {
        key: 'no-reply',
        who: 'missed call · saturday',
        steps: ['call came in. nobody answered.', 'arc texted back.', 'no reply.'],
        verdict: 'does not count',
        reason: 'the customer never answered. shown, never billed.',
      },
      {
        key: 'handed-off',
        who: 'missed call · monday night',
        steps: [
          'call came in. nobody answered.',
          'arc texted back.',
          'customer replied: “i smell gas.”',
          'arc stopped texting and alerted you.',
        ],
        verdict: 'handed to you',
        reason: 'anything that sounds unsafe goes straight to a person.',
      },
    ],
    demo: 'open the demo portal →',
  },

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

  /* parked: the toolkit section no longer renders on the homepage — a list of tool
     names is the machine, and the page now sells the result. the data and the
     component (Toolkit.jsx) are kept. `core: true` gets the accent style. */
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

  /* parked: neither list below renders on the homepage any more. the offer is one
     thing — missed calls texted back — and a menu of twelve services said the opposite.
     they are kept, with their ids, because portal/lib/service-catalog.js keys the
     console's service checklists on them, and because each can come back the day there
     is a case study behind it. */
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

  /* parked with the three above: the nine extra services. */
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

  /* parked: the "your route" section and its five questions left the public homepage —
     a cold visitor is no longer asked to choose a route. the model
     (supabase/functions/_shared/routes/model.ts), operator onboarding and the
     component (YourRoute.jsx) are kept; these are that component's own words.
     `status` is a claim about today: only say "in production" for what is. */
  routes: {
    eyebrow: '04 — your route',
    title: 'start from where you are.',
    lead: 'no software? we bring it. already have some you like? you keep it. which one sounds like you?',
    pick: 'pick the one that sounds like you',
    status: {
      native: 'arc crm in build · pilots open',
      hybrid: 'built around your tools',
      connected: 'in production',
    },
    provides: 'we bring',
    keeps: 'you keep',
    cta: 'talk through',
    suggestedFlag: 'suggested for you',
    compareToggle: 'compare all three',
    compareLabel: 'the three routes side by side',
    quizToggle: 'not sure? five quick questions',
    quizBack: 'back',
    quizSuggested: 'sounds like',
    quizCta: 'book a call about',
    quizReset: 'start over',
  },

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
    captureUrl: 'https://benchu33.app.n8n.cloud/webhook/arc-pilot-intake',

    booking: {
      // pick 'calcom' or 'ghl' and paste the event link; buildEmbedSrc()
      // prefills name, email, phone, and the intake answers for both.
      // until a provider is set the flow lands on a pre-filled email — never
      // a dead end, and never an apology for the booking not existing.
      provider: 'calcom',
      embedUrl: 'https://cal.com/ben-c-745ymo/arc-meeting',
    },
  },

  process: {
    eyebrow: '04 — how it works',
    title: 'four steps. one phone line.',
    steps: [
      {
        q: 'we count your missed calls, free',
        a: 'send us the last 30 days of call history from your phone system — an export or screenshots. we count the calls nobody answered and show you the number. no charge.',
      },
      {
        q: 'we set it up with you on a call',
        a: 'your hours, your service area, what counts as an emergency, and who gets the alert. then your unanswered calls are forwarded to arc. every company runs the same system; only the settings are yours.',
      },
      {
        q: 'a missed call gets a text back',
        a: 'arc asks what is wrong and where, then books the job or hands it to you. it stops the moment the customer says stop, and a person takes over when something sounds unsafe. every text is written and reviewed ahead of time — nothing is made up on the spot.',
      },
      {
        q: 'you see every step, and say what happened',
        a: 'after a booked visit you answer one question: did the job happen? a job counts only when the whole chain is on record. anything we cannot prove is shown and never billed.',
      },
    ],
  },

  /* the pilot terms. `terms` is the ONE place a number lives: set it here and the price
     section prints it. null means "not agreed yet" and prints the row's `unset` words —
     never a zero, and never a number nobody has agreed to. */
  price: {
    eyebrow: '05 — what it costs',
    title: 'you pay for jobs we can prove.',
    terms: {
      monthlyBase: null, // dollars a month
      perRecoveredJob: null, // dollars for each proven recovered job
      monthlyCap: null, // dollars, the most a month can cost
    },
    rows: [
      { label: 'the missed-call count', value: 'free' },
      { label: 'monthly base', term: 'monthlyBase', suffix: ' a month', unset: 'small — agreed before you start' },
      { label: 'each job we bring back', term: 'perRecoveredJob', suffix: ' a job', unset: 'a fixed fee — agreed before you start' },
      { label: 'the most a month can cost', term: 'monthlyCap', suffix: '', unset: 'capped — agreed before you start' },
      { label: 'the pilot', value: 'one company, one phone line, 30 to 60 days' },
    ],
    counts: 'a job counts when the call, the text, the reply, the booking and the visit are all on record.',
    disputeLead: 'you can dispute a job for any of these:',
    disputeReasons: [
      'spam',
      'wrong number',
      'out of your area',
      'customer cancelled',
      'job did not happen',
      'you got there first',
      'duplicate',
    ],
  },

  footer: {
    eyebrow: '08 — start',
    heading: 'how many calls did you miss last month?',
    sub: 'send us your last 30 days of call history. we count the calls nobody answered. the count is free.',
  },

  ticker: ['arc automations', 'first hvac pilot opening', 'missed calls texted back', 'every step shown', 'free missed-call count'],
};
