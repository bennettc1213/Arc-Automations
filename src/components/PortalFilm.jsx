import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import ArcMark from './ArcMark';
import Icon from '../portal/components/Icon';
import { useInView, useReducedMotion, useWeakDevice } from '../lib/hooks';
import './PortalFilm.css';

/**
 * the film — a sixteen-second loop of somebody using the portal, running in the hero.
 *
 * the pitch beside it is a claim; this is the evidence. it walks the path an owner takes
 * now that the portal covers the whole revenue lifecycle rather than one pipeline: open on
 * what needs a person, scroll down to where the money is sitting, watch a missed call land
 * and move the lifecycle, then open lead capture, narrow it to what needs you, and open the
 * emergency that was texted back in seven seconds and put in front of a person inside two
 * minutes. speed and judgement, in one row.
 *
 * it is a replica, not the product. the real workspace is a lazy route carrying a
 * supabase client, a router and six hundred kilobytes of generated data, and dragging
 * all of that into the marketing bundle to play a loop nobody can click would be the
 * wrong trade by an order of magnitude. what it does share is the numbers: every
 * figure below is the one `/demo` renders, and the lead that arrives on camera is the
 * demo's own newest lead — so the counters step up *to* the demo's figures, and a
 * visitor who clicks through lands on the dashboard the film finished on.
 *
 * the scene list is the whole animation. every visual on screen is derived from the
 * current index rather than accumulated by side effects, which is what lets the loop
 * restart by setting a number back to zero.
 */

const SCENES = [
  { name: 'boot', ms: 900 },
  { name: 'idle', ms: 1300 },
  { name: 'scroll', ms: 1300 },
  { name: 'liveMove', ms: 650 },
  { name: 'liveDrop', ms: 2000 },
  { name: 'navMove', ms: 850 },
  { name: 'navClick', ms: 420 },
  { name: 'swap', ms: 800 },
  { name: 'chipMove', ms: 800 },
  { name: 'chipClick', ms: 420 },
  { name: 'filtered', ms: 900 },
  { name: 'rowMove', ms: 800 },
  { name: 'rowClick', ms: 420 },
  { name: 'expand', ms: 1900 },
  { name: 'read', ms: 1500 },
  { name: 'fade', ms: 700 },
];

const CUE = Object.fromEntries(SCENES.map((scene, i) => [scene.name, i]));

const EASE = [0.22, 1, 0.36, 1];

/* the rail. the work and the machine, as the real one declares them — the six lifecycle
   modules are what the portal is now, so they are the one part of the rail the film
   cannot abbreviate. the account group is left off: at this height the foot would cut it
   in half, and a nav clipped mid-word reads as a rendering fault rather than a window.
   the counts are what the real rail counts — lead capture's volume, and for every other
   module the items waiting on a person. lead capture's steps up when the lead lands. */
const RAIL = [
  {
    label: 'the work',
    items: [
      { key: 'overview', icon: 'overview', label: 'overview' },
      { key: 'leads', icon: 'leads', label: 'lead capture', count: '674', before: '673' },
      { key: 'estimates', icon: 'reports', label: 'estimates', count: '6' },
      { key: 'reviews', icon: 'reliability', label: 'reviews', count: '8' },
      { key: 'memberships', icon: 'account', label: 'memberships', count: '5' },
      { key: 'installs', icon: 'automations', label: 'install & warranty', count: '8' },
    ],
  },
  {
    label: 'the machine',
    items: [
      { key: 'activity', icon: 'activity', label: 'activity' },
      { key: 'automations', icon: 'automations', label: 'automations' },
      { key: 'reliability', icon: 'reliability', label: 'reliability' },
    ],
  },
];

const PAGES = {
  overview: {
    path: '',
    title: 'overview',
    blurb: 'the lifecycle, what needs you, and whether it is all running',
  },
  leads: {
    path: '/leads',
    title: 'lead capture',
    blurb: 'every opportunity, how fast it was answered, and where it went',
  },
};

/* the film's clock stands at about 12:04 on the 18th — thirty seconds after the lead it
   shows arriving — and the relative times below are read against that, not against
   whenever the demo data was last generated. */

/* three of the six the real queue opens on, one per module, in the order it sorts them.
   the counts in the header are the whole queue's. */
const QUEUE_COUNTS = { urgent: 6, high: 14, normal: 10 };

const QUEUE = [
  {
    key: 'yvonne',
    who: 'yvonne vasquez',
    module: 'estimate recovery',
    reason: 'customer objection',
    detail: 'that is a lot more than the other quote we got',
    waiting: 'waiting 1 month',
    due: 'due 1 month ago',
    to: 'sam okonkwo',
    state: 'sequence stopped on reply',
  },
  {
    key: 'bettina',
    who: 'bettina hobbs',
    module: 'reviews & recovery',
    reason: 'negative service experience',
    detail: 'no updates for three days, equipment left running',
    waiting: 'waiting 8 days',
    due: 'due 8 days ago',
    to: 'marcus whitfield',
    state: 'service recovery open',
  },
  {
    key: 'duane',
    who: 'duane ferraro',
    module: 'lead capture',
    reason: 'handed to a person',
    detail: 'electrical — automation stopped, on-call notified directly',
    waiting: 'waiting 12 hours',
    due: 'due 12 hours ago',
    to: 'dana reyes',
    state: 'waiting on a person',
  },
];

/* the overview's first row, in the order it opens on them. `after` is what the figure
   reads once the missed call lands — the demo's own number. */
const STATS = [
  {
    key: 'answered',
    label: 'missed calls answered',
    value: '112',
    after: '113',
    delta: { arrow: '▲', pct: '+9.7%' },
    sub: 'calls that rang out — every one got a text back instead of voicemail',
    tone: 'lead',
  },
  {
    key: 'median',
    label: 'median response',
    value: '10.9s',
    delta: { arrow: '▼', pct: '-8.1%' },
    sub: '9 in 10 answered within 30.0s · 245 texts sent',
    subAfter: '9 in 10 answered within 30.0s · 246 texts sent',
  },
  {
    key: 'leads',
    label: 'leads · last 30 days',
    value: '245',
    after: '246',
    spark: true,
    delta: { arrow: '▲', pct: '+6.5%' },
    sub: 'every one answered automatically',
  },
  {
    key: 'uptime',
    label: 'pipeline uptime',
    value: '99.49%',
    sub: 'not “the server is up” — a lead sent right now would have been answered. 771 checks · see them',
  },
];

/* the second row: the lifecycle modules' money, which is the part of the portal that
   did not exist the last time this film was cut. */
const MODULE_STATS = [
  { key: 'open', label: 'open quoted work', value: '$395k', sub: '29 estimates still waiting on a decision' },
  { key: 'recovered', label: 'recovered revenue', value: '$77k', sub: '7 approved after a follow-up we sent' },
  { key: 'reviews', label: 'reviews received', value: '7', sub: '4★ average · 1 recovery case open' },
  { key: 'closeout', label: 'closeout complete', value: '50.0%', sub: '5 of 10 installs fully closed out' },
];

/* captured moves the moment the lead lands; qualified a beat later, when the qualifier
   has answered. the lag is the pipeline, drawn. */
const LIFECYCLE = [
  { key: 'captured', label: 'captured', value: '245', after: '246', note: 'calls and forms that came in' },
  {
    key: 'qualified',
    label: 'qualified',
    value: '219',
    after: '220',
    lag: 0.75,
    note: 'passed job type, service area and capacity',
  },
  { key: 'estimated', label: 'estimated', value: '20', note: 'quotes raised in the window' },
  { key: 'approved', label: 'approved', value: '9', note: 'customers who said yes' },
  { key: 'installed', label: 'installed', value: '10', note: 'installations completed' },
  { key: 'retained', label: 'retained', value: '115', note: 'active service agreements' },
];

/* leads per day, Aug 20 → Sep 18. today's bar is one short until the lead lands. */
const PER_DAY = [8, 17, 4, 8, 11, 5, 6, 11, 15, 8, 4, 5, 11, 7, 5, 11, 8, 8, 9, 9, 10, 9, 11, 6, 4, 7, 9, 6, 6, 6];
const PEAK = Math.max(...PER_DAY);
const AXIS = ['Aug 20', 'Aug 25', 'Aug 30', 'Sep 4', 'Sep 9', 'Sep 14'];

function perDay(live) {
  return live ? PER_DAY : [...PER_DAY.slice(0, -1), PER_DAY[PER_DAY.length - 1] - 1];
}

/* the activity feed, newest first. the arriving thread is the demo's newest lead, and its
   steps are the ones that exist thirty seconds after the call — the reply came later. */
const ARRIVING = {
  id: 'nate',
  at: '12:03:46',
  src: 'nate delacruz · missed call',
  ms: '9.9s',
  steps: ['missed call', 'lead', 'text', 'routed'],
};

const FEED = [
  { id: 'doug', at: '10:31:59', src: 'doug rasmussen · google message', ms: '1m 19s', steps: ['lead', 'text', 'routed', 'replied'] },
  { id: 'greg', at: '09:31:56', src: 'greg lindqvist · missed call', ms: '6.8s', steps: ['missed call', 'lead', 'text', 'routed', 'replied'] },
  { id: 'greg2', at: '05:58:59', src: 'greg lindqvist · web form', ms: '9.1s', steps: ['lead', 'text', 'routed'] },
  { id: 'sheila', at: '05:45:03', src: 'sheila hobbs · web form', ms: '29.7s', steps: ['lead', 'text', 'routed', 'replied'] },
  { id: 'wes', at: '04:43:53', src: 'wes delacruz · missed call', ms: '11.4s', steps: ['missed call', 'lead', 'text', 'routed', 'replied'] },
  { id: 'duane', at: '23:58:02', src: 'duane ferraro · web form', ms: '1m 08s', steps: ['lead', 'text', 'routed'] },
];

/* lead capture's first row. already the demo's figures: the film only gets here after
   the lead has landed. */
const LEAD_STATS = [
  {
    key: 'in',
    label: 'opportunities in',
    value: '246',
    sub: '113 of them calls that rang out and got a text back',
    tone: 'lead',
  },
  { key: 'median', label: 'median response', value: '10.9s', sub: '100.0% inside your 5m 00s target' },
  { key: 'qualified', label: 'qualified', value: '220', sub: 'passed job type, service area and capacity' },
  {
    key: 'handed',
    label: 'handed to a person',
    value: '110',
    sub: 'safety cases, distressed callers and anything your own rules mark human-only',
  },
];

const OUTCOMES = ['all', 'needs you', 'replied', 'routed', 'failed'];

/* the table, as the demo sorts it. the three rows marked `needsYou` are the three the
   "needs you" chip leaves standing, and greg's is the one that gets opened: an emergency
   that was answered in seconds *and* stopped and handed to a person, which is the whole
   argument for the automation knowing when not to automate. */
const LEADS = [
  {
    id: 'nate',
    date: 'Sep 18',
    at: '12:03:46',
    name: 'nate delacruz',
    phone: '(614) 737-9159',
    job: 'water — water heater failure',
    tag: 'missed call · scheduling',
    response: '9.9s',
    routed: 'sam okonkwo',
    outcome: 'routed',
    tone: 'ok',
  },
  {
    id: 'doug',
    date: 'Sep 18',
    at: '10:31:59',
    name: 'doug rasmussen',
    phone: '(614) 531-1096',
    job: 'water — roof leak, ceiling',
    tag: 'google message · scheduling',
    response: '1m 19s',
    routed: 'priya raghunathan',
    outcome: 'replied',
    tone: 'ok',
  },
  {
    id: 'greg',
    date: 'Sep 18',
    at: '09:31:56',
    name: 'greg lindqvist',
    phone: '(614) 352-2666',
    job: 'water — basement seepage',
    tag: 'missed call · emergency',
    response: '6.8s',
    routed: 'dana reyes',
    outcome: 'with a person',
    tone: 'warn',
    needsYou: true,
    steps: [
      { label: 'missed call', date: 'Sep 18 · ', at: '09:31:56' },
      { label: 'lead', date: 'Sep 18 · ', at: '09:31:57' },
      { label: 'text', date: 'Sep 18 · ', at: '09:32:02' },
      { label: 'routed', date: 'Sep 18 · ', at: '09:32:10' },
      { label: 'replied', date: 'Sep 18 · ', at: '09:35:56' },
      { label: 'handed to a person — sam okonkwo', date: 'Sep 18 · ', at: '09:33:28', fail: true },
    ],
    facts: [
      ['urgency', 'emergency'],
      ['service area', 'in area · 43230'],
      ['consent', 'sms: yes · email: no'],
      ['qualification', 'qualified'],
    ],
    next: 'waiting on a person',
    meta: 'thread fa719456 · customer replied Sep 18 · 09:35:56 · acknowledged Sep 18 · 09:38:01',
  },
  {
    id: 'greg2',
    date: 'Sep 18',
    at: '05:58:59',
    name: 'greg lindqvist',
    phone: '(614) 255-0287',
    job: 'water — roof leak, ceiling',
    tag: 'web form · same day',
    response: '9.1s',
    routed: 'marcus whitfield',
    outcome: 'routed',
    tone: 'ok',
  },
  {
    id: 'sheila',
    date: 'Sep 18',
    at: '05:45:03',
    name: 'sheila hobbs',
    phone: '(614) 244-0499',
    job: 'water — roof leak, ceiling',
    tag: 'web form · scheduling',
    response: '29.7s',
    routed: 'marcus whitfield',
    outcome: 'replied',
    tone: 'ok',
  },
  {
    id: 'wes',
    date: 'Sep 18',
    at: '04:43:53',
    name: 'wes delacruz',
    phone: '(614) 847-5826',
    job: 'water — burst supply line',
    tag: 'missed call · emergency',
    response: '11.4s',
    routed: 'sam okonkwo',
    outcome: 'with a person',
    tone: 'warn',
    needsYou: true,
  },
  {
    id: 'duane',
    date: 'Sep 17',
    at: '23:58:02',
    name: 'duane ferraro',
    phone: '(614) 206-6908',
    job: 'water — dishwasher overflow',
    tag: 'web form · electrical hazard',
    response: '1m 08s',
    routed: 'priya raghunathan',
    outcome: 'with a person',
    tone: 'warn',
    needsYou: true,
  },
];

const LOADED = 150;

/* the same glyph per tone the real pills carry, so status is never colour alone here
   either. */
const GLYPH = { ok: '■', warn: '▲', fail: '●' };

/* a spring loose enough to overshoot a little. a cursor that arrives at its target
   with no overrun reads as a value being assigned, not as a hand being moved. */
const CURSOR_SPRING = { type: 'spring', stiffness: 130, damping: 19, mass: 0.7 };

/* a wheel scroll, not a jump: slow out of rest, slow into it. */
const SCROLL_EASE = { duration: 0.95, ease: [0.65, 0, 0.35, 1] };

const NO_SCROLL = { overview: 0, leads: 0 };

/* the film runs five components deep in places, and the only thing any of them
   needs to know about the machine underneath is whether to spend frames on it.
   that travels as context rather than as a prop threaded through every layer. */
const WeakContext = createContext(false);

/* a figure that steps rather than swaps — the portal's own counter, at film scale.
   there are nine of these on screen at once.

   `popLayout` is what makes the outgoing digit leave without the incoming one
   waiting for it, and it pays for that by measuring both against the layout on
   every frame of the swap. nine of those at once was the single most expensive
   thing in the hero. a device that told us it is working hard gets the same step
   as a css keyframe instead — one animation the compositor owns, no measuring,
   no per-frame style write — and loses only the overlap between the two digits,
   which lasts a quarter of a second. */
function Tick({ value, delay = 0 }) {
  const weak = useContext(WeakContext);
  if (weak) {
    return (
      <span className="pf-tick pf-tick--css" key={value} style={{ animationDelay: `${delay}s` }}>
        {value}
      </span>
    );
  }
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={value}
        className="pf-tick"
        initial={{ y: '70%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '-70%', opacity: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay }}
      >
        {value}
      </motion.span>
    </AnimatePresence>
  );
}

function Pill({ tone, children }) {
  return (
    <i className={`pf-pill pf-pill--${tone}`}>
      <b aria-hidden="true">{GLYPH[tone]}</b>
      {children}
    </i>
  );
}

function Spark({ live }) {
  const points = perDay(live);
  const d = points.map((v, i) => `${(i / (points.length - 1)) * 100},${29 - (v / PEAK) * 27}`).join(' L');
  return (
    <svg className="pf-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={`M${d}`} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Rail({ active, live, leadsRef }) {
  return (
    <nav className="pf-rail" aria-hidden="true">
      <div className="pf-rail__brand">
        <ArcMark size={14} />
        <span>
          arc<b>.</b>portal
        </span>
      </div>

      <div className="pf-rail__tenant">
        <span className="pf-rail__tenant-name">Halstead Restoration</span>
        <span className="pf-rail__tenant-sub">client portal</span>
      </div>

      <div className="pf-rail__scroll">
        {RAIL.map((group) => (
          <div className="pf-nav" key={group.label}>
            <p className="pf-nav__label">{group.label}</p>
            <ul>
              {group.items.map((item) => (
                <li key={item.key}>
                  <span
                    ref={item.key === 'leads' ? leadsRef : undefined}
                    className={`pf-nav__item${active === item.key ? ' is-active' : ''}`}
                  >
                    <span className="pf-nav__glyph">
                      <Icon name={item.icon} size={12} />
                    </span>
                    <span className="pf-nav__text">{item.label}</span>
                    {item.count && (
                      <span className="pf-nav__count">
                        {item.before ? <Tick value={live ? item.count : item.before} /> : item.count}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="pf-rail__foot">
        <span className="pf-rail__status">
          <span aria-hidden="true">■</span>
          <span>operational</span>
        </span>
        <span className="pf-rail__collapse">
          <Icon name="collapse" size={11} />
          <span>collapse</span>
        </span>
      </div>
    </nav>
  );
}

function Topbar({ page, still }) {
  const { title, blurb } = PAGES[page];

  return (
    <div className="pf-top">
      <motion.div
        className="pf-top__title"
        key={page}
        initial={still ? false : { opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        <b>{title}</b>
        <span>{blurb}</span>
      </motion.div>

      <span className="pf-top__search">
        <Icon name="search" size={11} />
        <span>search leads, pages, automations</span>
        <kbd>⌘K</kbd>
      </span>
      <span className="pf-top__window">30d · America/New_York</span>
      <span className="pf-top__icon">
        <Icon name="bell" size={12} />
      </span>
      <span className="pf-top__avatar">hr</span>
    </div>
  );
}

function Overview({ live, hot, still, modRef, feedRef }) {
  const feed = live ? [ARRIVING, ...FEED] : FEED;
  const bars = perDay(live);

  return (
    <>
      <div className="pf-status">
        <span className="pf-status__glyph" aria-hidden="true">
          ■
        </span>
        <b>all systems operational</b>
        <span className="pf-status__check">last check 11:58:40 · 5 minutes ago</span>
      </div>

      {/* what a person has to do today, above anything that is merely true — the same
          order the real overview argues for. */}
      <section className="pf-panel">
        <header className="pf-panel__head">
          <p className="pf-eyebrow">needs a person</p>
          <span className="pf-queue__counts">
            <b className="is-urgent">{QUEUE_COUNTS.urgent} urgent</b>
            <b className="is-high">{QUEUE_COUNTS.high} high</b>
            <b>{QUEUE_COUNTS.normal} normal</b>
          </span>
        </header>

        <ul className="pf-queue">
          {QUEUE.map((item) => (
            <li className="pf-queue__item" key={item.key}>
              <div className="pf-queue__head">
                <Pill tone="fail">urgent</Pill>
                <span className="pf-queue__who">{item.who}</span>
                <span className="pf-queue__module">{item.module}</span>
              </div>
              <p className="pf-queue__reason">
                {item.reason}
                <em>{item.detail}</em>
              </p>
              <div className="pf-queue__meta">
                <span>{item.waiting}</span>
                <span className="is-overdue">
                  <Icon name="clock" size={9} />
                  {item.due}
                </span>
                <span>→ {item.to}</span>
                <span className="pf-queue__state">{item.state}</span>
                <span className="pf-queue__link">
                  open
                  <Icon name="chevron" size={9} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="pf-stats">
        {STATS.map((stat) => (
          <div className={`pf-stat${stat.tone === 'lead' ? ' pf-stat--lead' : ''}`} key={stat.key}>
            <p className="pf-stat__label">{stat.label}</p>
            <p className="pf-stat__value">
              <Tick value={live && stat.after ? stat.after : stat.value} />
            </p>
            {stat.spark && <Spark live={live} />}
            {stat.delta && (
              <p className="pf-delta">
                <i aria-hidden="true">{stat.delta.arrow}</i>
                {stat.delta.pct}
                <em>vs prev 30d</em>
              </p>
            )}
            <p className="pf-stat__sub">{live && stat.subAfter ? stat.subAfter : stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="pf-stats pf-stats--compact" ref={modRef}>
        {MODULE_STATS.map((stat) => (
          <div className="pf-stat" key={stat.key}>
            <p className="pf-stat__label">{stat.label}</p>
            <p className="pf-stat__value">{stat.value}</p>
            <p className="pf-stat__sub">{stat.sub}</p>
          </div>
        ))}
      </div>

      <section className="pf-panel">
        <header className="pf-panel__head">
          <p className="pf-eyebrow">the lifecycle</p>
          <span className="pf-panel__note">last 30 days · counts of records, not estimates of them</span>
        </header>

        <ol className="pf-life">
          {LIFECYCLE.map((stage) => (
            <li
              key={stage.key}
              className={`pf-life__stage${hot && stage.after ? ' is-hot' : ''}`}
              style={stage.lag ? { transitionDelay: hot ? `${stage.lag}s` : '0s' } : undefined}
            >
              <span className="pf-life__value">
                {stage.after ? <Tick value={live ? stage.after : stage.value} delay={stage.lag} /> : stage.value}
              </span>
              <span className="pf-life__label">{stage.label}</span>
              <span className="pf-life__note">{stage.note}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="pf-split">
        <section className="pf-panel pf-chart">
          <header className="pf-panel__head">
            <p className="pf-eyebrow">leads per day</p>
            <span className="pf-panel__note">30d · peak {PEAK}</span>
          </header>
          <div className={`pf-bars${hot ? ' is-hot' : ''}`}>
            {bars.map((v, i) => (
              <span key={i} style={{ height: `${(v / PEAK) * 100}%` }} />
            ))}
          </div>
          <div className="pf-axis">
            {AXIS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </section>

        <section className="pf-feed" ref={feedRef}>
          <header className="pf-feed__head">
            <p className="pf-eyebrow">activity</p>
            <span className="pf-feed__live">
              <i aria-hidden="true" />
              live
            </span>
          </header>

          <ul className="pf-feed__list">
            <AnimatePresence initial={false}>
              {feed.map((thread) => {
                const isNew = thread === ARRIVING && !still;

                return (
                  <motion.li
                    key={thread.id}
                    layout={!still}
                    initial={isNew ? { opacity: 0, y: -12 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, ease: EASE }}
                    className={thread === ARRIVING ? 'is-new' : undefined}
                  >
                    <div className="pf-thread__top">
                      <span className="pf-thread__time">{thread.at}</span>
                      <span className="pf-thread__src">{thread.src}</span>
                      {/* the response time appears when the text does, not before it:
                          it is the gap between the first step and the third. */}
                      <motion.span
                        className="pf-thread__ms"
                        initial={isNew ? { opacity: 0 } : false}
                        animate={{ opacity: 1 }}
                        transition={{ delay: isNew ? 0.95 : 0, duration: 0.3 }}
                      >
                        {thread.ms}
                      </motion.span>
                    </div>
                    <div className="pf-steps">
                      {thread.steps.map((step, i) => (
                        <motion.span
                          className="pf-step"
                          key={step}
                          initial={isNew ? { opacity: 0 } : false}
                          animate={{ opacity: 1 }}
                          transition={{ delay: isNew ? 0.35 + i * 0.3 : 0, duration: 0.25 }}
                        >
                          {i > 0 && <span className="pf-step__line" aria-hidden="true" />}
                          <span className="pf-step__dot" aria-hidden="true" />
                          {step}
                        </motion.span>
                      ))}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </section>
      </div>
    </>
  );
}

function LeadCapture({ open, chip, still, panelRef, rowRef, chipRef }) {
  const rows = chip === 'all' ? LEADS : LEADS.filter((lead) => lead.needsYou);
  const shown = chip === 'all' ? LOADED : rows.length;

  return (
    <>
      <div className="pf-stats">
        {LEAD_STATS.map((stat) => (
          <div className={`pf-stat${stat.tone === 'lead' ? ' pf-stat--lead' : ''}`} key={stat.key}>
            <p className="pf-stat__label">{stat.label}</p>
            <p className="pf-stat__value">{stat.value}</p>
            <p className="pf-stat__sub">{stat.sub}</p>
          </div>
        ))}
      </div>

      <section className="pf-panel pf-panel--bare" ref={panelRef}>
        <header className="pf-panel__head">
          <p className="pf-eyebrow">every lead</p>
          <span className="pf-panel__note">
            {chip === 'all' ? `${LOADED} of 674 in the window` : `${rows.length} matching · ${LOADED} loaded`}
          </span>
          <span className="pf-btn">
            <Icon name="download" size={10} />
            export {shown} rows
          </span>
        </header>

        <div className="pf-toolbar">
          <span className="pf-search">
            <Icon name="search" size={10} />
            name, phone, loss type or tech
          </span>
          <div className="pf-chips">
            {OUTCOMES.map((key) => (
              <span
                key={key}
                ref={key === 'needs you' ? chipRef : undefined}
                className={`pf-chip${chip === key ? ' is-on' : ''}`}
              >
                {key}
              </span>
            ))}
          </div>
        </div>

        <div className="pf-table">
          <div className="pf-table__head">
            <span>received</span>
            <span>customer</span>
            <span>job type</span>
            <span className="pf-num">response</span>
            <span>routed to</span>
            <span>outcome</span>
            <span />
          </div>

          {/* keyed on the filter so the narrowed table arrives rather than snaps. */}
          <motion.div
            key={chip}
            initial={chip === 'all' || still ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            {rows.map((lead) => {
              const isOpen = open && lead.id === 'greg';

              return (
                <div key={lead.id}>
                  <div
                    ref={lead.id === 'greg' ? rowRef : undefined}
                    className={`pf-row${isOpen ? ' is-open' : ''}`}
                  >
                    <span className="pf-row__at">
                      {lead.at}
                      <em>{lead.date}</em>
                    </span>
                    <span>
                      <b>{lead.name}</b>
                      <em>{lead.phone}</em>
                    </span>
                    <span>
                      {lead.job}
                      <em>{lead.tag}</em>
                    </span>
                    <span className="pf-num pf-row__resp">{lead.response}</span>
                    <span>{lead.routed}</span>
                    <span>
                      <Pill tone={lead.tone}>{lead.outcome}</Pill>
                    </span>
                    <span className={`pf-row__chev${isOpen ? ' is-open' : ''}`}>
                      <Icon name="chevron" size={10} />
                    </span>
                  </div>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        className="pf-detail"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease: EASE }}
                      >
                        <div className="pf-detail__inner">
                          <div className="pf-detail__steps">
                            {lead.steps.map((step, i) => (
                              <motion.div
                                className={`pf-detail__step${step.fail ? ' is-fail' : ''}`}
                                key={step.label}
                                initial={still ? false : { opacity: 0, x: -6 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.22 + i * 0.13, duration: 0.3 }}
                              >
                                {i > 0 && <span className="pf-detail__rule" aria-hidden="true" />}
                                <span className="pf-detail__dot" aria-hidden="true" />
                                <span>{step.label}</span>
                                <span className="pf-detail__time">
                                  <i>{step.date}</i>
                                  {step.at}
                                </span>
                              </motion.div>
                            ))}
                          </div>

                          <motion.div
                            initial={still ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 1.05, duration: 0.35 }}
                          >
                            <dl className="pf-facts">
                              {lead.facts.map(([term, value]) => (
                                <div key={term}>
                                  <dt>{term}</dt>
                                  <dd>{value}</dd>
                                </div>
                              ))}
                            </dl>
                            <p className="pf-detail__next">
                              <b>next:</b> {lead.next}
                            </p>
                            <p className="pf-detail__meta">{lead.meta}</p>
                          </motion.div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </motion.div>
        </div>
      </section>
    </>
  );
}

export default function PortalFilm() {
  const stageRef = useRef(null);
  const viewRef = useRef(null);
  const scrollRef = useRef(null);
  const modRef = useRef(null);
  const feedRef = useRef(null);
  const navLeadsRef = useRef(null);
  const panelRef = useRef(null);
  const rowRef = useRef(null);
  const chipRef = useRef(null);

  const reduced = useReducedMotion();
  const weak = useWeakDevice();
  const inView = useInView(stageRef, '160px');
  const [i, setI] = useState(0);
  const [run, setRun] = useState(0);
  const [cursor, setCursor] = useState({ x: 0, y: 0, shown: false });
  const [scroll, setScroll] = useState(NO_SCROLL);

  const scene = SCENES[i].name;

  /* the clock. it stops when the film is scrolled off screen — a loop nobody is
     looking at is a timer and a layout pass every few hundred milliseconds, paid
     for by the scroll the visitor is actually doing. */
  useEffect(() => {
    if (reduced || !inView) return undefined;

    const id = setTimeout(() => {
      if (i === SCENES.length - 1) {
        /* the scroll resets in the same render as the run, so the next loop mounts at
           the top of the page rather than mounting scrolled and then rewinding. */
        setRun((n) => n + 1);
        setScroll(NO_SCROLL);
        setI(0);
      } else {
        setI(i + 1);
      }
    }, SCENES[i].ms);

    return () => clearTimeout(id);
  }, [i, reduced, inView]);

  /* where the hand goes, and how far the page scrolls. both are measured off the live
     dom rather than written down, so the cursor keeps landing on the thing it is
     pointing at — and the page stops where the content does — whether the card is
     560px wide on a laptop or 980px on a monitor. */
  useLayoutEffect(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;

    /* scroll an element to the top of the pane, but never past the end of the page:
       a replica that scrolls into empty space below its last panel is showing you
       something no browser would. */
    const reach = (el) => {
      const view = viewRef.current;
      const body = scrollRef.current;
      if (!el || !view || !body) return 0;
      return Math.max(0, Math.min(el.offsetTop - 12, body.offsetHeight - view.clientHeight));
    };

    if (reduced) {
      setScroll({ overview: 0, leads: reach(panelRef.current) });
      return;
    }

    const aim = (el, fx = 0.5, fy = 0.55) => {
      const box = el?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setCursor({ x: box.left - stage.left + box.width * fx, y: box.top - stage.top + box.height * fy, shown: true });
    };

    if (scene === 'idle') setCursor({ x: stage.width * 0.6, y: stage.height * 0.4, shown: true });
    else if (scene === 'scroll') {
      setScroll((s) => ({ ...s, overview: reach(modRef.current) }));
      setCursor({ x: stage.width * 0.66, y: stage.height * 0.58, shown: true });
    } else if (scene === 'liveMove' || scene === 'liveDrop') aim(feedRef.current, 0.42, 0.24);
    else if (scene === 'navMove' || scene === 'navClick') aim(navLeadsRef.current, 0.42);
    else if (scene === 'chipMove' || scene === 'chipClick') aim(chipRef.current);
    else if (scene === 'rowMove' || scene === 'rowClick') aim(rowRef.current, 0.3, 0.5);
    else if (scene === 'read') {
      /* the detail can run past the bottom of the pane. the hand stays where it clicked
         and the page moves under it, the way reading an opened row actually goes. */
      setScroll((s) => ({ ...s, leads: reach(panelRef.current) }));
    }
  }, [scene, run, reduced]);

  /* reduced motion gets the last frame of the film rather than none of it. the point
     of the thing is "here is what happened to a lead, to the second", and that
     survives being still — what does not survive is being absent. */
  const still = reduced;
  const idx = still ? CUE.read : CUE[scene];
  const live = idx >= CUE.liveDrop;
  const hot = scene === 'liveDrop';
  const page = idx >= CUE.swap ? 'leads' : 'overview';
  const navActive = idx >= CUE.navClick ? 'leads' : 'overview';
  const chip = idx >= CUE.chipClick ? 'needs you' : 'all';
  const open = idx >= CUE.expand;
  const clicking = !still && scene.endsWith('Click');
  const fading = !still && scene === 'fade';

  return (
    <WeakContext.Provider value={weak}>
      {/* `is-idle` parks the css animations inside the film — the live dot pulses on
       an opacity keyframe, which is a style recalculation every frame whether or
       not the film is on screen. the clock above already stops; this stops the
         part of the film that was never on the clock. */}
      <div
        className={`pf ${inView && !reduced ? '' : 'is-idle'}`}
        ref={stageRef}
        aria-hidden="true"
      >
        <div className="pf-win">
          <div className="pf-win__bar">
            <span className="pf-win__lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="pf-win__url">
              arcautomations.com/demo
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.b
                  key={page}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  {PAGES[page].path}
                </motion.b>
              </AnimatePresence>
            </span>
          </div>

          {/* keyed on the run so the loop restarts from a clean mount rather than
              unwinding every piece of state in reverse. `initial` matters: without it
              the new run would cut in at full opacity the instant the old one finished
              fading, which reads as a dropped frame. */}
          <motion.div
            className="pf-win__body"
            key={run}
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: fading ? 0 : 1 }}
            transition={{ duration: fading ? 0.55 : 0.35, ease: 'easeInOut' }}
          >
            <Rail active={navActive} live={live} leadsRef={navLeadsRef} />

            <div className="pf-main">
              <Topbar page={page} still={still} />

              <motion.div
                className="pf-pane"
                key={page}
                ref={viewRef}
                initial={still ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.45, ease: 'easeOut' }}
              >
                <motion.div
                  className="pf-scroll"
                  ref={scrollRef}
                  initial={false}
                  animate={{ y: -scroll[page] }}
                  transition={still ? { duration: 0 } : SCROLL_EASE}
                >
                  {page === 'overview' ? (
                    <Overview live={live} hot={hot} still={still} modRef={modRef} feedRef={feedRef} />
                  ) : (
                    <LeadCapture
                      open={open}
                      chip={chip}
                      still={still}
                      panelRef={panelRef}
                      rowRef={rowRef}
                      chipRef={chipRef}
                    />
                  )}
                </motion.div>
              </motion.div>
            </div>
          </motion.div>
        </div>

        {/* the click ring, keyed so every press draws a fresh one */}
        {clicking && (
          <motion.span
            className="pf-ring"
            key={`ring-${scene}-${run}`}
            style={{ left: cursor.x - 15, top: cursor.y - 15 }}
            initial={{ scale: 0.3, opacity: 0.85 }}
            animate={{ scale: 1.7, opacity: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          />
        )}

        {/* the site's own cursor, borrowed. an arrow pointer here would be the only
            arrow on a site that replaced its pointer with a square. */}
        {!still &&
          (weak ? (
            /* the hand moves between a handful of fixed points, a few seconds apart.
               a spring makes that journey out of sixty style writes a second; a css
               transition makes it out of none, and on a machine that is struggling
               the difference is visible in the scroll, not in the hand. */
            <span
              className="pf-cursor pf-cursor--css"
              style={{
                transform: `translate3d(${cursor.x - 5}px, ${cursor.y - 5}px, 0) scale(${
                  clicking ? 0.72 : 1
                })`,
                opacity: cursor.shown && !fading ? 1 : 0,
              }}
            />
          ) : (
            <motion.span
              className="pf-cursor"
              initial={false}
              animate={{
                x: cursor.x - 5,
                y: cursor.y - 5,
                scale: clicking ? 0.72 : 1,
                opacity: cursor.shown && !fading ? 1 : 0,
              }}
              transition={{ ...CURSOR_SPRING, scale: { duration: 0.14 }, opacity: { duration: 0.3 } }}
            />
          ))}
      </div>
    </WeakContext.Provider>
  );
}
