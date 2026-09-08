import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GlowButton from '../../components/GlowButton';
import ArcMark from '../../components/ArcMark';
import AsciiField from '../components/AsciiField';
import useEntrance from '../lib/entrance';
import { rememberDestination } from '../lib/auth-next';
import { getSupabase, isConfigured } from '../lib/supabase';
import { site } from '../../data/site';
import './PortalHome.css';

/**
 * the front door of the ops console.
 *
 * the same door as /portal, deliberately: the same tunnel, the same reveal, the
 * same bar and the same panels. walking into your own console should feel exactly
 * like walking into the product you sell, and the entrance is shared code
 * (lib/entrance.js) rather than a copy that will drift.
 *
 * what is different is who it is for and how you get in. the console signs in with
 * an email magic link, not a client ID — client IDs identify accounts, and there is
 * no account here, only a person. the link comes back to /auth/callback carrying a
 * destination, which is why the operator lands in the console rather than in a
 * client dashboard they are not a member of.
 */

const PANELS = [
  {
    tag: '01',
    title: 'the whole book',
    body: 'every client on one screen — leads, response time, whether their pipeline answered its last check. the same numbers they see, computed by the same code.',
  },
  {
    tag: '02',
    title: 'what is wired to what',
    body: 'the n8n instance, the twilio number, the workflow ids. declared on one side, checked against the event log on the other, and allowed to disagree.',
  },
  {
    tag: '03',
    title: 'getting them in',
    body: 'generate a client id, add the account, invite the address, mint the pipeline token. four steps, four buttons, each one reporting for itself.',
  },
];

export default function OpsHome() {
  const { entered, flown, Tunnel, enter, finish } = useEntrance();
  const [session, setSession] = useState({ kind: 'unknown' });
  const [email, setEmail] = useState('');
  const [send, setSend] = useState({ kind: 'idle' });

  /* only decides which button is shown. it defaults to signed-out, because the
     failure that matters is sending somebody who cannot get in to a console that
     will just tell them so. */
  useEffect(() => {
    if (!isConfigured) {
      setSession({ kind: 'unconfigured' });
      return undefined;
    }
    let live = true;
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => live && setSession({ kind: data?.session ? 'in' : 'out' }))
      .catch(() => live && setSession({ kind: 'out' }));
    return () => {
      live = false;
    };
  }, []);

  async function requestLink(e) {
    e.preventDefault();
    if (!isConfigured) {
      setSend({ kind: 'error', message: 'no supabase connection configured in this environment.' });
      return;
    }

    setSend({ kind: 'sending' });

    /* two ways to carry the destination, because supabase can drop a query string
       on the way through and a magic link routinely opens in a different tab. the
       query param is the one that is read first; this is the belt. */
    rememberDestination('/ops/console');

    const { error } = await getSupabase().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}auth/callback?next=/ops/console`,
        /* the console has exactly one operator and he already exists. a form that
           could provision an account would be a public sign-up page for the admin
           tool, which is not a thing that should exist. */
        shouldCreateUser: false,
      },
    });

    if (error) {
      setSend({ kind: 'error', message: error.message.toLowerCase() });
      return;
    }
    setSend({ kind: 'sent' });
  }

  return (
    <div className="ph">
      {!flown && (Tunnel ? <Tunnel onBreach={enter} onDone={finish} /> : <div className="ph__veil" />)}

      <div className="ph__stage" data-entered={entered ? 'true' : 'false'}>
        <header className="ph__bar">
          <Link className="ph__mark" to="/ops">
            <ArcMark size={21} title="arc automations" />
            <span>
              arc<b>.</b>ops
            </span>
          </Link>
          <nav className="ph__barnav" aria-label="ops">
            <Link to="/">back to the site</Link>
            <Link to="/portal">client portal</Link>
          </nav>
        </header>

        <section className="ph__hero">
          <AsciiField />

          <div className="ph__heroin">
            <ArcMark className="ph__crest" size={58} />
            <p className="ph__eyebrow">operator console</p>
            <h1 className="ph__title">
              every client,
              <br />
              one screen.
            </h1>
            <p className="ph__sub">
              who is live, what they are wired to, how fast their leads are being answered — and
              the buttons that put a new one into the system. this side is not open to clients.
            </p>

            {session.kind === 'in' ? (
              <div className="ph__actions">
                <GlowButton to="/ops/console" variant="primary">
                  <span className="glowbtn__dot" aria-hidden="true" />
                  open the console
                </GlowButton>
                <GlowButton to="/portal" variant="ghost">
                  client portal
                </GlowButton>
                <GlowButton to="/" variant="ghost">
                  back to the site
                </GlowButton>
              </div>
            ) : send.kind === 'sent' ? (
              <div className="ph__signin">
                <p className="ph__signin-title">check your email</p>
                <p className="ph__note">
                  a sign-in link is on its way to <span className="mono">{email}</span>. it lands
                  straight in the console and expires in one hour.
                </p>
              </div>
            ) : (
              <form className="ph__signin" onSubmit={requestLink}>
                <label className="pt-field" style={{ marginBottom: 12 }}>
                  <span className="pt-field__label">operator email</span>
                  <input
                    className="pt-field__input"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@arcautomations.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>

                {send.kind === 'error' && <p className="pt-auth__err">{send.message}</p>}

                <button className="pt-btn" type="submit" disabled={send.kind === 'sending'}>
                  {send.kind === 'sending' ? 'sending…' : 'email me a link'}
                </button>

                <p className="ph__note" style={{ marginTop: 14 }}>
                  the address has to already exist in auth and be listed in{' '}
                  <span className="mono">arc_admins</span>. there is no sign-up here on purpose.
                </p>
              </form>
            )}
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
            looking for your own dashboard? that is the{' '}
            <Link to="/portal">client portal</Link> — sign in there with your client id.
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
