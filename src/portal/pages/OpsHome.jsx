import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
 * what is different is who it is for and how you get in. no client ID here —
 * client IDs identify accounts, and there is no account on this side, only a
 * person. and only one of them, so the door is a single password field: the
 * address the password belongs to is a constant in site.js rather than a box,
 * because a form that asks a question it already knows the answer to is a form
 * you resent every morning.
 *
 * a one-click magic link stays as the fallback — it is how you get in before a
 * password exists and how you get back in having lost it. it comes back to
 * /auth/callback carrying a destination, which is why the operator lands in the
 * console rather than in a client dashboard they are not a member of.
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

/**
 * where the operator's password lives, since it is the question this file invites.
 *
 * not here. not anywhere in this repo. the site is a static bundle served from a
 * public repository — every string in it is readable by anyone who opens the
 * network tab, so a password compared in this file would be a published password,
 * and one that protected nothing anyway: the real gate is `arc_admins` plus row
 * level security in postgres, which is what makes the console empty for anyone
 * who is not ben regardless of what this form decided.
 *
 * so the password is a real supabase auth credential. it is set on the auth user
 * (console → supabase → your operator account), stored hashed by supabase, and
 * checked server-side by signInWithPassword below. nothing about it ever enters
 * the bundle.
 */
export default function OpsHome() {
  const { entered, flown, Tunnel, enter, finish } = useEntrance();
  const navigate = useNavigate();
  const [session, setSession] = useState({ kind: 'unknown' });
  const [password, setPassword] = useState('');
  const [send, setSend] = useState({ kind: 'idle' });

  /* one field, because there is one operator. the address is a constant in
     site.js rather than an input: supabase has to be told which account the
     password belongs to, but there is only ever one answer here and asking for
     it daily is a form asking a question it already knows.

     it costs nothing to publish. that address is already in the footer and in
     every mailto on the site, so it was never a second factor — the password is
     the secret, and arc_admins plus row level security are what make the console
     empty for anyone who gets past it. */
  const email = site.opsEmail;

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

  async function signIn(e) {
    e.preventDefault();
    if (!isConfigured) {
      setSend({ kind: 'error', message: 'no supabase connection configured in this environment.' });
      return;
    }

    setSend({ kind: 'sending' });

    const { error } = await getSupabase().auth.signInWithPassword({ email, password });

    if (error) {
      /* supabase answers "invalid login credentials" for a wrong password and for
         an address with no password set, which are different problems with
         different fixes. the second is the likely one the first time this form is
         used, so it is named rather than left as a shrug. */
      const message = error.message.toLowerCase();
      setSend({
        kind: 'error',
        message: message.includes('invalid login credentials')
          ? 'that address and password do not match. if you have never set a password, use the email link and set one from inside the console.'
          : message,
      });
      return;
    }

    navigate('/ops/console', { replace: true });
  }

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
              <form className="ph__signin" onSubmit={signIn}>
                {/* one field. the account this password belongs to is a constant,
                    so there is nothing else to ask. */}
                <label className="pt-field" style={{ marginBottom: 12 }}>
                  <span className="pt-field__label">password</span>
                  <input
                    className="pt-field__input"
                    type="password"
                    required
                    autoFocus
                    autoComplete="current-password"
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>

                {send.kind === 'error' && <p className="pt-auth__err">{send.message}</p>}

                <button className="pt-btn" type="submit" disabled={send.kind === 'sending'}>
                  {send.kind === 'sending' ? 'signing in…' : 'sign in'}
                </button>

                {/* the recovery path, and now a one-click one: with the address
                    already known there is no form to fill in, so this is a button
                    rather than a second mode of the page. it is how you get in the
                    first time and how you get back in having forgotten the
                    password — not a courtesy. */}
                <button
                  type="button"
                  className="ph__switch"
                  onClick={requestLink}
                  disabled={send.kind === 'sending'}
                >
                  forgot it? email me a sign-in link instead
                </button>

                <p className="ph__note" style={{ marginTop: 14 }}>
                  one operator, no sign-up. set or change the password from inside the console,
                  under supabase.
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
