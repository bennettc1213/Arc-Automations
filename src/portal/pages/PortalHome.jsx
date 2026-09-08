import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GlowButton from '../../components/GlowButton';
import ArcMark from '../../components/ArcMark';
import AsciiField from '../components/AsciiField';
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
 */

const PANELS = [
  {
    tag: '01',
    title: 'the live feed',
    body: 'every run as it fires — the call that came in, the text that went back out, the job that got booked. timestamped, in order, no summarising.',
  },
  {
    tag: '02',
    title: 'speed to lead',
    body: 'median response time, hour by hour. it is the number the whole system exists to move, so it is the number the portal opens on.',
  },
  {
    tag: '03',
    title: 'when it breaks',
    body: 'failed runs surface here first, with the error attached. you find out from the dashboard, not from a customer who never got a call back.',
  },
];

export default function PortalHome() {
  const { entered, flown, Tunnel, enter, finish } = useEntrance();
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

  return (
    <div className="ph">
      {!flown && (Tunnel ? <Tunnel onBreach={enter} onDone={finish} /> : <div className="ph__veil" />)}

      <div className="ph__stage" data-entered={entered ? 'true' : 'false'}>
        <header className="ph__bar">
          <Link className="ph__mark" to="/portal">
            <ArcMark size={21} title="arc automations" />
            <span>
              arc<b>.</b>portal
            </span>
          </Link>
          <nav className="ph__barnav" aria-label="portal">
            <Link to="/">back to the site</Link>
            <Link to="/demo">demo</Link>
          </nav>
        </header>

        <section className="ph__hero">
          <AsciiField />

          <div className="ph__heroin">
            <ArcMark className="ph__crest" size={58} />
            <p className="ph__eyebrow">client portal</p>
            <h1 className="ph__title">
              your automations,
              <br />
              on the record.
            </h1>
            <p className="ph__sub">
              every lead caught, every reply sent, every job booked — logged the moment it happens.
              no monthly summary, no taking our word for it.
            </p>

            <div className="ph__actions">
              {signedIn ? (
                <GlowButton to="/portal/dashboard" variant="primary">
                  <span className="glowbtn__dot" aria-hidden="true" />
                  open your dashboard
                </GlowButton>
              ) : (
                <GlowButton to="/login" variant="primary">
                  <span className="glowbtn__dot" aria-hidden="true" />
                  sign in
                </GlowButton>
              )}
              <GlowButton to="/demo" variant="ghost">
                open the live demo
              </GlowButton>
              <GlowButton to="/" variant="ghost">
                back to the site
              </GlowButton>
            </div>

            <p className="ph__note">
              sign in with your client id — no password, no email to remember. access is set up by{' '}
              {site.brand}.
            </p>
          </div>
        </section>

        <section className="ph__panels" aria-label="what is inside">
          {PANELS.map((p) => (
            <article className="ph__panel" key={p.tag}>
              <span className="ph__paneltag">{p.tag}</span>
              <h2 className="ph__paneltitle">{p.title}</h2>
              <p className="ph__panelbody">{p.body}</p>
            </article>
          ))}
        </section>

        <footer className="ph__foot">
          <p>
            lost your client id? it is on your welcome email —{' '}
            <a href={`mailto:${site.email}`}>get in touch</a> and we will resend it.
          </p>
          <p className="ph__footmark">
            <ArcMark size={16} />
            {site.brand}
          </p>
        </footer>
      </div>
    </div>
  );
}
