import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ArcMark from './ArcMark';
import Icon from '../portal/components/Icon';
import { useInView, useReducedMotion } from '../lib/hooks';
import {
  FILM_ANSWERS,
  FILM_COMPANY,
  FILM_DONE,
  FILM_FIGURES,
  FILM_HANDOFF,
  FILM_JOBS,
  FILM_NAV,
  FILM_NEED,
  FILM_PAGES,
  FILM_PROVEN,
} from './portal-film-data';
import './PortalFilm.css';

/**
 * the film — a thirteen-second loop of an owner using the portal, running in the hero.
 *
 * the pitch beside it is a claim; this is the evidence, and it is the portal a launch client
 * actually gets: four screens, not the whole workspace. so the story is the four screens'
 * own: open *this month* and read three figures, open *needs you*, answer the one question
 * with one tap, and see on *jobs* that the lead now counts. nothing else is on screen.
 *
 * it is a replica, not the product. the real workspace is a lazy route carrying a supabase
 * client, a router and generated data, and dragging that into the marketing bundle to play a
 * loop nobody can click would be the wrong trade. what it shares is the words: every line
 * is in `portal-film-data.js`, and `tests/portal-film.test.js` holds that file to what
 * `/demo` derives, so the film and the page a visitor clicks through to cannot disagree.
 *
 * the scene list is the whole animation. every visual on screen is derived from the current
 * index rather than accumulated by side effects, which is what lets the loop restart by
 * setting a number back to zero.
 */

const SCENES = [
  { name: 'boot', ms: 800 },
  { name: 'idle', ms: 1900 },
  { name: 'btnMove', ms: 900 },
  { name: 'btnClick', ms: 450 },
  { name: 'needs', ms: 1900 },
  { name: 'tapMove', ms: 900 },
  { name: 'tapClick', ms: 450 },
  { name: 'done', ms: 1500 },
  { name: 'navMove', ms: 850 },
  { name: 'navClick', ms: 450 },
  { name: 'jobs', ms: 2800 },
  { name: 'fade', ms: 700 },
];

const CUE = Object.fromEntries(SCENES.map((scene, i) => [scene.name, i]));

/* the same glyph per tone the real pills carry, so status is never colour alone here either. */
const GLYPH = { ok: '■', warn: '▲', idle: '□', fail: '●' };

function Pill({ tone, children }) {
  return (
    <i className={`pf-pill pf-pill--${tone}`}>
      <b aria-hidden="true">{GLYPH[tone]}</b>
      {children}
    </i>
  );
}

function Rail({ active, jobsRef }) {
  return (
    <nav className="pf-rail" aria-hidden="true">
      <div className="pf-rail__brand">
        <ArcMark size={14} />
        <span>
          arc<b>.</b>portal
        </span>
      </div>

      <div className="pf-rail__tenant">
        <span className="pf-rail__tenant-name">{FILM_COMPANY}</span>
        <span className="pf-rail__tenant-sub">client portal</span>
      </div>

      <div className="pf-nav">
        <p className="pf-nav__label">your account</p>
        <ul>
          {FILM_NAV.map((item) => (
            <li key={item.key}>
              <span
                ref={item.key === 'jobs' ? jobsRef : undefined}
                className={`pf-nav__item${active === item.key ? ' is-active' : ''}`}
              >
                <span className="pf-nav__glyph">
                  <Icon name={item.icon} size={13} />
                </span>
                <span className="pf-nav__text">{item.label}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="pf-rail__foot">
        <span>■</span>
        <span>example data</span>
      </div>
    </nav>
  );
}

function Topbar({ page }) {
  const { title, blurb } = FILM_PAGES[page];

  return (
    <div className="pf-top">
      <div className="pf-top__title pf-fade" key={page}>
        <b>{title}</b>
        <span>{blurb}</span>
      </div>
      <span className="pf-top__avatar">hr</span>
    </div>
  );
}

function Month({ buttonRef }) {
  return (
    <>
      <div className="pf-figures">
        {FILM_FIGURES.map((figure) => (
          <div className="pf-figure" key={figure.key}>
            <p className="pf-figure__label">{figure.label}</p>
            <p className={`pf-figure__value${figure.value === null ? ' is-none' : ''}`}>{figure.value ?? '—'}</p>
            <p className="pf-figure__note">{figure.note}</p>
          </div>
        ))}
      </div>

      <div className="pf-actions">
        <span ref={buttonRef} className="pf-button pf-button--primary">
          see what needs you
        </span>
        <span className="pf-button">see every job</span>
      </div>

      <section className="pf-panel">
        <header className="pf-panel__head">
          <p className="pf-eyebrow">what happened</p>
          <span className="pf-panel__note">the seven examples</span>
        </header>
        <dl className="pf-proven">
          {FILM_PROVEN.map((row) => (
            <div key={row.label}>
              <dd>{row.value}</dd>
              <dt>{row.label}</dt>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

function Needs({ answered, answerRef }) {
  return (
    <>
      <section className="pf-panel">
        <header className="pf-panel__head">
          <p className="pf-eyebrow">did the job happen?</p>
          <span className="pf-panel__note">{answered ? 'nothing waiting' : '1 waiting'}</span>
        </header>

        {answered ? (
          <p className="pf-done pf-fade" role="status">
            <b aria-hidden="true">■</b>
            {FILM_DONE}
          </p>
        ) : (
          <div className="pf-need">
            <Pill tone="warn">{FILM_NEED.kind}</Pill>
            <p className="pf-need__title">{FILM_NEED.title}</p>
            <p className="pf-need__detail">{FILM_NEED.detail}</p>
            <p className="pf-need__reason">{FILM_NEED.reason}</p>
            <div className="pf-answers">
              {FILM_ANSWERS.map((label, n) => (
                <span key={label} ref={n === 0 ? answerRef : undefined} className="pf-button">
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="pf-panel">
        <header className="pf-panel__head">
          <p className="pf-eyebrow">{FILM_HANDOFF.kind}</p>
          <span className="pf-panel__note">1 waiting</span>
        </header>
        <div className="pf-need">
          <p className="pf-need__title">{FILM_HANDOFF.title}</p>
          <p className="pf-need__detail">{FILM_HANDOFF.detail}</p>
        </div>
      </section>
    </>
  );
}

function Jobs({ answered }) {
  return (
    <div className="pf-jobs">
      {FILM_JOBS.map((job) => {
        const changed = answered && job.then;
        const status = changed ? job.then : job;

        return (
          <div className={`pf-job${changed ? ' is-changed' : ''}`} key={job.key}>
            <div className="pf-job__head">
              <b>{job.title}</b>
              <Pill tone={status.tone}>{status.label}</Pill>
            </div>
            <p className="pf-job__when">{job.arrived}</p>
            <p className="pf-job__reason">{status.reason}</p>
          </div>
        );
      })}
    </div>
  );
}

export default function PortalFilm() {
  const stageRef = useRef(null);
  const buttonRef = useRef(null);
  const answerRef = useRef(null);
  const jobsRef = useRef(null);

  const reduced = useReducedMotion();
  const inView = useInView(stageRef, '160px');
  const [i, setI] = useState(0);
  const [run, setRun] = useState(0);
  const [cursor, setCursor] = useState({ x: 0, y: 0, shown: false });

  const scene = SCENES[i].name;

  /* the clock. it stops when the film is scrolled off screen — a loop nobody is looking at
     is a timer and a layout pass every few hundred milliseconds, paid for by the scroll the
     visitor is actually doing. */
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

  /* where the hand goes. measured off the live dom rather than written down, so it keeps
     landing on the thing it is pointing at whether the card is 560px wide or 980. */
  useLayoutEffect(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || reduced) return;

    const aim = (el, fx = 0.5, fy = 0.5) => {
      const box = el?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setCursor({ x: box.left - stage.left + box.width * fx, y: box.top - stage.top + box.height * fy, shown: true });
    };

    if (scene === 'idle') setCursor({ x: stage.width * 0.62, y: stage.height * 0.7, shown: true });
    else if (scene === 'btnMove' || scene === 'btnClick') aim(buttonRef.current, 0.5);
    else if (scene === 'tapMove' || scene === 'tapClick') aim(answerRef.current, 0.55);
    else if (scene === 'navMove' || scene === 'navClick') aim(jobsRef.current, 0.45);
  }, [scene, run, reduced]);

  /* reduced motion gets the last frame of the film rather than none of it. */
  const idx = reduced ? CUE.jobs : CUE[scene];
  const page = idx >= CUE.jobs ? 'jobs' : idx >= CUE.needs ? 'needs' : 'month';
  const answered = idx >= CUE.done;
  const clicking = !reduced && scene.endsWith('Click');
  const fading = !reduced && scene === 'fade';

  return (
    <div className={`pf ${inView && !reduced ? '' : 'is-idle'}`} ref={stageRef} aria-hidden="true">
      <div className="pf-win">
        <div className="pf-win__bar">
          <span className="pf-win__lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="pf-win__url">
            arcautomations.com/demo
            <b>{FILM_PAGES[page].path}</b>
          </span>
        </div>

        {/* keyed on the run so the loop restarts from a clean mount rather than unwinding
            every piece of state in reverse. */}
        <div className={`pf-win__body${fading ? ' is-fading' : ''}`} key={run}>
          <Rail active={page} jobsRef={jobsRef} />

          <div className="pf-main">
            <Topbar page={page} />

            <div className="pf-pane">
              <div className="pf-page pf-fade" key={page}>
                {page === 'month' && <Month buttonRef={buttonRef} />}
                {page === 'needs' && <Needs answered={answered} answerRef={answerRef} />}
                {page === 'jobs' && <Jobs answered={answered} />}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* the click ring, keyed so every press draws a fresh one */}
      {clicking && (
        <span className="pf-ring" key={`ring-${scene}-${run}`} style={{ left: cursor.x - 15, top: cursor.y - 15 }} />
      )}

      {/* an ordinary arrow pointer: the film is a picture of somebody using software, and
          a pointer is what tells a visitor that. its tip is the origin, so the point the
          scene aims at is the point the arrow touches. */}
      {!reduced && (
        <span
          className="pf-cursor"
          style={{
            transform: `translate3d(${cursor.x - 2}px, ${cursor.y - 1.5}px, 0) scale(${clicking ? 0.85 : 1})`,
            opacity: cursor.shown && !fading ? 1 : 0,
          }}
        >
          <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
            <path
              d="M2 1.5v18.2l4.7-4.3 3.3 7.4 3.1-1.4-3.3-7.3h6.6z"
              fill="#fff"
              stroke="#0a0a0b"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}
