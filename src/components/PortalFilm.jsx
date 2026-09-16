import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import ArcMark from './ArcMark';
import Icon from '../portal/components/Icon';
import { useInView, useReducedMotion } from '../lib/hooks';
import './PortalFilm.css';

/**
 * the film — a sixteen-second loop of somebody using the portal, running in the hero.
 *
 * the pitch above it is a claim; this is the evidence. it walks the one path that
 * settles the argument: a missed call lands in the live feed, the counter moves, and
 * then a lead row is opened to show the exact timeline underneath it — call, text,
 * routed, replied, to the second.
 *
 * it is a replica, not the product. the real workspace is a lazy route carrying a
 * supabase client, a router and a hundred kilobytes of generated data, and dragging
 * all of that into the marketing bundle to play a loop nobody can click would be the
 * wrong trade by an order of magnitude. what it does share is the numbers: every
 * figure below is the one `/demo` actually renders, so a visitor who clicks through
 * from here lands on the same dashboard they just watched.
 *
 * the scene list is the whole animation. every visual on screen is derived from the
 * current index rather than accumulated by side effects, which is what lets the loop
 * restart by setting a number back to zero.
 */

const SCENES = [
  { name: 'boot', ms: 900 },
  { name: 'idle', ms: 1000 },
  { name: 'liveMove', ms: 800 },
  { name: 'liveDrop', ms: 1500 },
  { name: 'navMove', ms: 850 },
  { name: 'navClick', ms: 420 },
  { name: 'swap', ms: 750 },
  { name: 'rowMove', ms: 950 },
  { name: 'rowClick', ms: 420 },
  { name: 'expand', ms: 1700 },
  { name: 'read', ms: 1400 },
  { name: 'chipMove', ms: 850 },
  { name: 'chipClick', ms: 420 },
  { name: 'filtered', ms: 1900 },
  { name: 'hold', ms: 1200 },
  { name: 'fade', ms: 700 },
];

const CUE = Object.fromEntries(SCENES.map((scene, i) => [scene.name, i]));

/* the rail. the same three groups the real one declares, minus the pages the film
   never visits — a nav with nine items at this scale is nine unreadable words. */
const RAIL = [
  {
    label: 'the work',
    items: [
      { key: 'overview', icon: 'overview', label: 'overview' },
      { key: 'leads', icon: 'leads', label: 'leads', count: '253' },
      { key: 'activity', icon: 'activity', label: 'activity' },
    ],
  },
  {
    label: 'the machine',
    items: [
      { key: 'automations', icon: 'automations', label: 'automations' },
      { key: 'reliability', icon: 'reliability', label: 'reliability' },
    ],
  },
];

/* the four cards the overview opens on, in the order it opens on them. `after` is
   what the figure reads once the missed call lands. */
const STATS = [
  {
    key: 'answered',
    label: 'missed calls answered',
    value: '115',
    after: '116',
    sub: 'every one got a text back instead of voicemail',
    tone: 'lead',
  },
  { key: 'median', label: 'median response', value: '11.0s', sub: 'p90 27.9s · 253 sends' },
  { key: 'leads', label: 'leads · last 30 days', value: '253', after: '254', sub: 'every one answered automatically' },
  { key: 'uptime', label: 'pipeline uptime', value: '99.44%', sub: '180 checks · see them' },
];

const SPARK = [4, 9, 6, 11, 8, 14, 10, 7, 13, 16, 11, 9, 15, 12, 18, 14, 10, 17, 13, 19];

/* the feed, newest first. the top entry is the one that arrives on camera. */
const ARRIVING = {
  id: 'new',
  name: 'dana whitlock',
  line: 'missed call — texted back in 6.1s',
  at: 'Sep 15 · 14:22:07',
};

const FEED = [
  { id: 'f1', name: 'vince vasquez', line: 'web form — routed to marcus whitfield', at: 'Sep 15 · 21:03:36' },
  { id: 'f2', name: 'rosalind brennan', line: 'web form — replied in 39m', at: 'Sep 15 · 19:30:54' },
  { id: 'f3', name: 'arthur nakamura', line: 'missed call — texted back in 4.8s', at: 'Sep 15 · 18:12:09' },
  { id: 'f4', name: 'priya raghunathan', line: 'google message — routed to sam okonkwo', at: 'Sep 15 · 16:47:22' },
  { id: 'f5', name: 'unknown caller', line: 'missed call — send failed, carrier rejected', at: 'Sep 15 · 15:02:40' },
  { id: 'f6', name: 'tobias lindqvist', line: 'web form — texted back in 5.4s', at: 'Sep 15 · 13:55:18' },
];

/* the leads table. the second row is the one that gets opened — it is the strongest
   row in the set, because a reply means a human on the other end answered a robot. */
const LEADS = [
  {
    id: 'a1',
    at: '21:03:36',
    name: 'vince vasquez',
    phone: '(614) 994-8631',
    loss: 'mold — crawlspace',
    source: 'web form',
    response: '6.1s',
    state: 'routed',
    tone: 'ok',
  },
  {
    id: 'a2',
    at: '19:30:54',
    name: 'rosalind brennan',
    phone: '(614) 228-1776',
    loss: 'water — burst supply line',
    source: 'web form',
    response: '8.2s',
    state: 'replied',
    tone: 'ok',
    steps: [
      { label: 'lead', at: 'Sep 15 · 19:30:54' },
      { label: 'text', at: 'Sep 15 · 19:31:02' },
      { label: 'routed', at: 'Sep 15 · 19:31:24' },
      { label: 'replied', at: 'Sep 15 · 20:09:54' },
    ],
    meta: 'thread 82712908 · customer replied Sep 15 · 20:09:54',
  },
  {
    id: 'a3',
    at: '18:12:09',
    name: 'arthur nakamura',
    phone: '(614) 771-0402',
    loss: 'fire — kitchen',
    source: 'missed call',
    response: '4.8s',
    state: 'replied',
    tone: 'ok',
  },
  {
    id: 'a4',
    at: '16:47:22',
    name: 'priya raghunathan',
    phone: '(614) 305-9917',
    loss: 'water — roof leak',
    source: 'google message',
    response: '13.4s',
    state: 'routed',
    tone: 'ok',
  },
  {
    id: 'a5',
    at: '15:02:40',
    name: 'unknown caller',
    phone: '(614) 880-2245',
    loss: '—',
    source: 'missed call',
    response: '—',
    state: 'send failed',
    tone: 'fail',
  },
  {
    id: 'a6',
    at: '13:55:18',
    name: 'tobias lindqvist',
    phone: '(614) 447-3190',
    loss: 'water — water heater',
    source: 'web form',
    response: '5.4s',
    state: 'replied',
    tone: 'ok',
  },
  {
    id: 'a7',
    at: '11:38:51',
    name: 'colleen ferraro',
    phone: '(614) 662-8074',
    loss: 'smoke — garage',
    source: 'missed call',
    response: '7.9s',
    state: 'routed',
    tone: 'ok',
  },
];

const CHIPS = ['all', 'replied', 'routed', 'failed'];

/* a spring loose enough to overshoot a little. a cursor that arrives at its target
   with no overrun reads as a value being assigned, not as a hand being moved. */
const CURSOR_SPRING = { type: 'spring', stiffness: 130, damping: 19, mass: 0.7 };

function Spark() {
  const max = Math.max(...SPARK);
  const d = SPARK.map((v, i) => `${(i / (SPARK.length - 1)) * 100},${30 - (v / max) * 26}`).join(' L');
  return (
    <svg className="pf-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={`M${d}`} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Rail({ active, leadsRef }) {
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
                    <Icon name={item.icon} size={13} />
                    <span className="pf-nav__text">{item.label}</span>
                    {item.count && <span className="pf-nav__count">{item.count}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="pf-rail__foot">
        <span aria-hidden="true">■</span>
        <span>operational</span>
      </div>
    </nav>
  );
}

function Overview({ live, feedRef }) {
  const feed = live ? [ARRIVING, ...FEED] : FEED;

  return (
    <div className="pf-page">
      <div className="pf-statusbar">
        <span className="pf-statusbar__glyph" aria-hidden="true">
          ■
        </span>
        <b>everything is running.</b>
        <span>last end-to-end check 4 minutes ago</span>
      </div>

      <div className="pf-stats">
        {STATS.map((stat) => (
          <div className={`pf-stat${stat.tone === 'lead' ? ' pf-stat--lead' : ''}`} key={stat.key}>
            <p className="pf-stat__label">{stat.label}</p>
            <div className="pf-stat__value">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={live && stat.after ? stat.after : stat.value}
                  initial={{ y: '70%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '-70%', opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                >
                  {live && stat.after ? stat.after : stat.value}
                </motion.span>
              </AnimatePresence>
            </div>
            {stat.key === 'leads' && <Spark />}
            <p className="pf-stat__sub">{stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="pf-feed" ref={feedRef}>
        <div className="pf-feed__head">
          <p className="pf-panel__title">live feed</p>
          <span className="pf-feed__dot" aria-hidden="true" />
        </div>

        <ul className="pf-feed__list">
          <AnimatePresence initial={false}>
            {feed.map((entry) => (
              <motion.li
                key={entry.id}
                layout
                initial={entry.id === 'new' ? { opacity: 0, y: -14 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className={entry.id === 'new' ? 'is-new' : undefined}
              >
                <span className="pf-feed__name">{entry.name}</span>
                <span className="pf-feed__line">{entry.line}</span>
                <span className="pf-feed__at">{entry.at}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  );
}

function Leads({ open, chip, rowRef, chipRef }) {
  const rows = chip === 'all' ? LEADS : LEADS.filter((lead) => lead.state === chip);

  return (
    <div className="pf-page">
      <div className="pf-toolbar">
        <span className="pf-search">
          <Icon name="search" size={11} />
          name, phone, loss type or tech
        </span>
        <div className="pf-chips">
          {CHIPS.map((key) => (
            <span
              key={key}
              ref={key === 'replied' ? chipRef : undefined}
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
          <span>loss type</span>
          <span className="pf-num">response</span>
          <span>outcome</span>
          <span />
        </div>

        {rows.map((lead) => {
          const isOpen = open && lead.id === 'a2';

          return (
            <div key={lead.id}>
              <div
                ref={lead.id === 'a2' ? rowRef : undefined}
                className={`pf-row${isOpen ? ' is-open' : ''}`}
              >
                <span className="pf-row__at">{lead.at}</span>
                <span>
                  <b>{lead.name}</b>
                  <em>{lead.phone}</em>
                </span>
                <span>
                  {lead.loss}
                  <em>{lead.source}</em>
                </span>
                <span className="pf-num pf-row__resp">{lead.response}</span>
                <span>
                  <i className={`pf-pill pf-pill--${lead.tone}`}>{lead.state}</i>
                </span>
                <span className={`pf-row__chev${isOpen ? ' is-open' : ''}`}>
                  <Icon name="chevron" size={11} />
                </span>
              </div>

              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    className="pf-detail"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="pf-detail__inner">
                      <div className="pf-detail__steps">
                        {lead.steps.map((step, i) => (
                          <motion.div
                            className="pf-detail__step"
                            key={step.label}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.22 + i * 0.13, duration: 0.3 }}
                          >
                            {i > 0 && <span className="pf-detail__rule" aria-hidden="true" />}
                            <span className="pf-detail__dot" aria-hidden="true" />
                            <span>{step.label}</span>
                            <span className="pf-detail__time">{step.at}</span>
                          </motion.div>
                        ))}
                      </div>
                      <p className="pf-detail__meta">{lead.meta}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <p className="pf-tablefoot">
        {chip === 'all'
          ? '7 of 253 in the window'
          : `${rows.length} matching · 253 loaded`}
      </p>
    </div>
  );
}

export default function PortalFilm() {
  const stageRef = useRef(null);
  const feedRef = useRef(null);
  const navLeadsRef = useRef(null);
  const rowRef = useRef(null);
  const chipRef = useRef(null);

  const reduced = useReducedMotion();
  const inView = useInView(stageRef, '160px');
  const [i, setI] = useState(0);
  const [run, setRun] = useState(0);
  const [cursor, setCursor] = useState({ x: 0, y: 0, shown: false });

  const scene = SCENES[i].name;

  /* the clock. it stops when the film is scrolled off screen — a loop nobody is
     looking at is a timer and a layout pass every few hundred milliseconds, paid
     for by the scroll the visitor is actually doing. */
  useEffect(() => {
    if (reduced || !inView) return undefined;

    const id = setTimeout(() => {
      if (i === SCENES.length - 1) {
        setRun((n) => n + 1);
        setI(0);
      } else {
        setI(i + 1);
      }
    }, SCENES[i].ms);

    return () => clearTimeout(id);
  }, [i, reduced, inView]);

  /* where the hand goes. measured off the live dom rather than written down as
     coordinates, so the cursor keeps landing on the thing it is pointing at when
     the card is 560px wide on a laptop and 880px on a monitor. */
  useLayoutEffect(() => {
    if (reduced) return;
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;

    const aim = (el, fx = 0.5, fy = 0.55) => {
      const box = el?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setCursor({ x: box.left - stage.left + box.width * fx, y: box.top - stage.top + box.height * fy, shown: true });
    };

    if (scene === 'idle') setCursor({ x: stage.width * 0.58, y: stage.height * 0.42, shown: true });
    else if (scene === 'liveMove' || scene === 'liveDrop') aim(feedRef.current, 0.5, 0.26);
    else if (scene === 'navMove' || scene === 'navClick') aim(navLeadsRef.current, 0.42);
    else if (scene === 'rowMove' || scene === 'rowClick') aim(rowRef.current, 0.34);
    else if (scene === 'chipMove' || scene === 'chipClick') aim(chipRef.current);
  }, [scene, run, reduced]);

  const idx = CUE[scene];
  const live = idx >= CUE.liveDrop;
  const page = idx >= CUE.swap ? 'leads' : 'overview';
  const navActive = idx >= CUE.navClick ? 'leads' : 'overview';
  const open = idx >= CUE.expand;
  const chip = idx >= CUE.chipClick ? 'replied' : 'all';
  const clicking = scene.endsWith('Click');
  const fading = scene === 'fade';

  /* reduced motion gets the last frame of the film rather than none of it. the
     point of the thing is "here is the timeline under a lead", and that survives
     being still — what does not survive is being absent. */
  if (reduced) {
    return (
      <div className="pf" ref={stageRef} aria-hidden="true">
        <div className="pf-win">
          <div className="pf-win__bar">
            <span className="pf-win__lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="pf-win__url">arcautomations.com/demo/leads</span>
          </div>
          <div className="pf-win__body">
            <Rail active="leads" leadsRef={navLeadsRef} />
            <Leads open chip="all" rowRef={rowRef} chipRef={chipRef} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pf" ref={stageRef} aria-hidden="true">
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
                {page === 'leads' ? '/leads' : ''}
              </motion.b>
            </AnimatePresence>
          </span>
        </div>

        {/* keyed on the run so the loop restarts from a clean mount rather than
            unwinding fourteen pieces of state in reverse. `initial` matters: without
            it the new run would cut in at full opacity the instant the old one
            finished fading, which reads as a dropped frame. */}
        <motion.div
          className="pf-win__body"
          key={run}
          initial={{ opacity: 0 }}
          animate={{ opacity: fading ? 0 : 1 }}
          transition={{ duration: fading ? 0.55 : 0.35, ease: 'easeInOut' }}
        >
          <Rail active={navActive} leadsRef={navLeadsRef} />

          <motion.div
            className="pf-pane"
            key={page}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            {page === 'overview' ? (
              <Overview live={live} feedRef={feedRef} />
            ) : (
              <Leads open={open} chip={chip} rowRef={rowRef} chipRef={chipRef} />
            )}
          </motion.div>
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
    </div>
  );
}
