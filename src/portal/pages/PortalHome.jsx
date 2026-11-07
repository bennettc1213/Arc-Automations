import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import Icon from '../components/Icon';
import useEntrance from '../lib/entrance';
import { getSupabase, isConfigured } from '../lib/supabase';
import { site } from '../../data/site';
import './PortalHome.css';

/**
 * the front door of the portal.
 *
 * the portal button on the marketing site lands here, not on the sign-in form.
 * a login box is a toll gate: it asks a visitor to prove who they are before
 * telling them what is on the other side. this page answers that first, and the
 * form is one click away for the people who already know.
 *
 * the entrance itself lives in lib/entrance.js, shared with the ops console's
 * door at /ops. both are the same transition because they are the same code.
 *
 * the preview on the right is a drawing of the workspace, labelled as sample data — the
 * same made-up company the demo opens on. it states no figure about any real client.
 */

const PANELS = [
  {
    tag: '01',
    icon: 'check',
    title: 'A guided start',
    body: 'Your business details, a first campaign, and the connections it needs. See what is ready and what still needs a check.',
  },
  {
    tag: '02',
    icon: 'mail',
    title: 'One conversation',
    body: 'From an eligible missed call or website inquiry to a useful reply, a few questions, and a clear handoff to you.',
  },
  {
    tag: '03',
    icon: 'reports',
    title: 'Results with evidence',
    body: 'See what was sent, what was delivered, and who replied. A conversation is a conversation; a booking needs its own evidence.',
  },
];

const PREVIEW_ROWS = [
  { who: 'Alex Morgan', what: 'Heating repair · asked for a callback', tone: 'warn', state: 'Needs you' },
  { who: 'Jamie Chen', what: 'AC repair · replied with a ZIP code', tone: 'warn', state: 'Needs you' },
  { who: 'Riley Brooks', what: 'Furnace tune-up · answered both questions', tone: 'good', state: 'Handed to you' },
];

function Preview() {
  return (
    <div className="ph-preview" aria-label="A preview of the portal, with sample data" role="img">
      <div className="ph-preview__bar">
        <span className="ph-preview__dots" aria-hidden="true"><i /><i /><i /></span>
        <span>arc portal · home</span>
        <span className="ph-preview__sample">Sample data</span>
      </div>
      <div className="ph-preview__body">
        <aside className="ph-preview__rail" aria-hidden="true">
          <b />
          <span className="is-on" />
          <span />
          <span />
          <span />
          <em />
          <span />
          <span />
        </aside>
        <div className="ph-preview__main">
          <p className="ph-preview__eyebrow">Recommended next step</p>
          <div className="ph-preview__next">
            <div>
              <strong>2 customers waiting on you</strong>
              <small>Alex Morgan and Jamie Chen need a person.</small>
            </div>
            <span className="ph-preview__btn">Open inbox</span>
          </div>
          <p className="ph-preview__eyebrow">Waiting on you</p>
          <ul className="ph-preview__list">
            {PREVIEW_ROWS.map((row) => (
              <li key={row.who}>
                <span className="ph-preview__avatar">{row.who.split(' ').map((w) => w[0]).join('')}</span>
                <span className="ph-preview__who">
                  <b>{row.who}</b>
                  <small>{row.what}</small>
                </span>
                <span className={`ph-preview__state ph-preview__state--${row.tone}`}>{row.state}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function PortalHome() {
  const { entered, flown, Veil, enter, finish } = useEntrance();
  const [signedIn, setSignedIn] = useState(false);

  /* only changes the label on the primary button. a wrong guess here sends a
     signed-in client to a login form, which is why it defaults to signed-out. */
  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => live && setSignedIn(Boolean(data?.session)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const primary = signedIn
    ? { to: '/portal/dashboard', label: 'Open your dashboard' }
    : { to: '/login', label: 'Sign in' };

  return (
    <div className="ph">
      {!flown && <Veil onReveal={enter} onDone={finish} />}

      <div className="ph__stage" data-entered={entered ? 'true' : 'false'}>
        <header className="ph-header">
          <div className="ph-header__in">
            <Link className="ph-brand" to="/portal">
              <ArcMark size={22} title="arc automations" />
              <span className="ph-brand__word">ARC</span>
              <span className="ph-brand__tag">Portal</span>
            </Link>
            <nav className="ph-nav" aria-label="portal">
              <a href="#inside">What is inside</a>
              <Link to="/demo">Demo</Link>
              <Link to="/">Back to the site</Link>
            </nav>
            <div className="ph-header__actions">
              {!signedIn && (
                <Link className="ph-header__signin" to="/login">
                  Sign in
                </Link>
              )}
              <Link className="ph-btn ph-btn--primary ph-btn--sm" to={signedIn ? '/portal/dashboard' : '/demo'}>
                {signedIn ? 'Open dashboard' : 'Try the demo'} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </header>

        <section className="ph-hero">
          <div className="ph-hero__copy">
            <p className="ph-eyebrow">Client portal</p>
            <h1 className="ph-title">
              Your next inquiry,
              <br />
              a clearer next step.
            </h1>
            <p className="ph-sub">
              Set up your response, follow the conversation, and know when to step in. Explore the
              working demo with sample data before connecting your business.
            </p>

            <div className="ph-actions">
              <Link className="ph-btn ph-btn--primary" to={primary.to}>
                {primary.label} <span aria-hidden="true">→</span>
              </Link>
              <Link className="ph-btn" to="/demo">
                Try the interactive demo
              </Link>
            </div>

            <p className="ph-note">
              <Icon name="identity" size={16} />
              Sign in with your client ID — no password to remember. Access is set up by {site.brand}.
            </p>
          </div>

          <Preview />
        </section>

        <section className="ph-inside" id="inside" aria-labelledby="ph-inside-title">
          <header className="ph-inside__head">
            <p className="ph-eyebrow">What is inside</p>
            <h2 id="ph-inside-title">Everything a missed inquiry needs, in one place.</h2>
          </header>
          <div className="ph-panels">
            {PANELS.map((p) => (
              <article className="ph-panel" key={p.tag}>
                <div className="ph-panel__top">
                  <span className="ph-panel__icon">
                    <Icon name={p.icon} size={18} />
                  </span>
                  <span className="ph-panel__tag">{p.tag}</span>
                </div>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="ph-cta">
          <div>
            <h2>See it with sample data first.</h2>
            <p>The demo is a made-up heating and cooling company. Every page works; no messages are sent.</p>
          </div>
          <div className="ph-actions">
            <Link className="ph-btn ph-btn--primary" to="/demo">
              Open the demo <span aria-hidden="true">→</span>
            </Link>
            <Link className="ph-btn" to="/login">
              Sign in
            </Link>
          </div>
        </section>

        <footer className="ph-foot">
          <p>
            Lost your client ID? It is on your welcome email — <a href={`mailto:${site.email}`}>get in touch</a> and
            we will resend it.
          </p>
          <p className="ph-foot__mark">
            <ArcMark size={16} />
            {site.brand}
          </p>
        </footer>
      </div>
    </div>
  );
}
