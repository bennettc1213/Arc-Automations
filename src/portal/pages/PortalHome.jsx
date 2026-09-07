import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GlowButton from '../../components/GlowButton';
import ArcMark from '../../components/ArcMark';
import AsciiField from '../components/AsciiField';
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
 * the entrance animation carries three.js, so it is fetched on demand rather
 * than bundled into a marketing site that will mostly never show it. if that
 * fetch fails or stalls, the page opens anyway — an animation is never allowed
 * to be the reason a client cannot reach their dashboard.
 */

/* guards the one-shot reload used to recover from a stale deploy */
const RELOAD_KEY = 'arc.portal.chunkRetry';

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

/* the entrance plays on every arrival at /portal. it is short, it skips on a
   click or a keypress, and it is the transition between the two halves of the
   product — suppressing it after the first visit made the door only exist once. */
function shouldSkipEntrance() {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function PortalHome() {
  /* two flags, not one. `entered` reveals the page; `flown` drops the tunnel
     from the tree. they are separated by the length of the fade — collapsing
     them would unmount the canvas on the same frame it commits to flying
     through, and the transition would end in a hard cut. */
  const [entered, setEntered] = useState(shouldSkipEntrance);
  const [flown, setFlown] = useState(shouldSkipEntrance);
  const [Tunnel, setTunnel] = useState(null);
  const [signedIn, setSignedIn] = useState(false);

  const enter = useCallback(() => setEntered(true), []);

  const finish = useCallback(() => setFlown(true), []);

  /* fetched imperatively rather than through React.lazy so a failed chunk is a
     branch we handle, not an unhandled rejection that takes the tree down. */
  useEffect(() => {
    if (flown) return undefined;
    let live = true;
    import('../components/HoleTunnel')
      .then((mod) => live && setTunnel(() => mod.default))
      .catch(() => {
        if (!live) return;
        /* a chunk that fails to load almost always means this tab is running
           an index.html from an earlier deploy, naming asset files that no
           longer exist — every build renames them. one reload picks up the
           current build. the flag is what stops that becoming a loop when the
           failure is something else, and sessionStorage is right for it
           because the question is only ever "in this tab, already tried?". */
        let retried = false;
        try {
          retried = window.sessionStorage.getItem(RELOAD_KEY) === '1';
          window.sessionStorage.setItem(RELOAD_KEY, '1');
        } catch {
          /* storage unavailable: treat as already retried and open the door */
          retried = true;
        }
        if (!retried) {
          window.location.reload();
          return;
        }
        enter();
        finish();
      });
    return () => {
      live = false;
    };
  }, [flown, enter, finish]);

  /* a slow chunk must not become a locked door — but this only guards the wait
     for the chunk. once the tunnel is actually on screen the timer is dropped:
     from that point the visitor is in control and has a cue telling them so,
     and a timeout would yank the entrance out from under someone who is still
     reading it. */
  useEffect(() => {
    if (entered || Tunnel) return undefined;
    const t = window.setTimeout(() => {
      enter();
      finish();
    }, 8000);
    return () => window.clearTimeout(t);
  }, [entered, Tunnel, enter, finish]);

  /* the last word on the overlay.
     the tunnel is an opaque full-screen element and it is responsible for
     asking to be removed. if it ever fails to — no WebGL, a lost context, a
     frame loop that never gets a frame — it would sit on top of the page it
     just revealed and the portal would look like a black screen. the reveal
     itself is 1040ms of wall clock, so anything still up at two seconds has
     stopped being a transition. */
  useEffect(() => {
    if (!entered || flown) return undefined;
    const t = window.setTimeout(finish, 2000);
    return () => window.clearTimeout(t);
  }, [entered, flown, finish]);

  /* nothing behind the tunnel should scroll while it is still the whole screen. */
  useEffect(() => {
    if (entered) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [entered]);

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
              no password — we email you a link. access is set up by {site.brand}.
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
            address not recognised? it has not been linked yet —{' '}
            <a href={`mailto:${site.email}`}>get in touch</a> and it will be.
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
