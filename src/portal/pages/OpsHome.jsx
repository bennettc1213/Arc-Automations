import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import GlowButton from '../../components/GlowButton';
import ArcMark from '../../components/ArcMark';
import AsciiField from '../components/AsciiField';
import useEntrance from '../lib/entrance';
import { getSupabase, isConfigured } from '../lib/supabase';
import { site } from '../../data/site';
import './PortalHome.css';

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
 * the front door of the ops console.
 *
 * the same door as /portal, deliberately: the same tunnel, the same reveal, the
 * same bar and the same panels. walking into your own console should feel exactly
 * like walking into the product you sell, and the entrance is shared code
 * (lib/entrance.js) rather than a copy that will drift.
 *
 * what is different is who it is for and how you get in. no client ID here —
 * client IDs identify accounts, and there is no account on this side, only
 * people. by default the door is a single password field: the address it
 * checks against is a constant in site.js (the primary operator, opened
 * several times a day), because a form that asks a question it already knows
 * the answer to is a form you resent every morning. "not you? sign in as
 * someone else" reveals a blank address field for anyone else in `arc_admins`
 * — see OperatorAccount's "adding another operator" for how they get there.
 *
 * deliberately no magic-link fallback on this page. that used to live here,
 * and it was a real hole: a link request needs nothing but an address —
 * nothing checks a password before sending one — so it was an unauthenticated
 * "email the operator" button sitting on a public page, and the toggle above
 * it pre-filled that address for anyone who clicked it, no login required.
 * getting in for the first time or after a forgotten password now happens
 * where the account itself lives: supabase → authentication → users → set the
 * password directly. one more step for the person who is actually locked out,
 * and zero surface for the visitor who is not.
 */
export default function OpsHome() {
  const { entered, flown, Tunnel, enter, finish } = useEntrance();
  const navigate = useNavigate();
  const [session, setSession] = useState({ kind: 'unknown' });
  const [password, setPassword] = useState('');
  const [send, setSend] = useState({ kind: 'idle' });

  /* defaults to the constant in site.js so the common case — you, signing in —
     is one field. it costs nothing to publish that address: it is already in the
     footer and in every mailto on the site, so it was never a second factor —
     the password is the secret, and arc_admins plus row level security are what
     make the console empty for anyone who gets past it.

     it is state rather than the constant itself because a second operator has
     to be able to point this at their own address. the toggle below is what
     reveals that field — starting empty, never pre-filled with the primary
     operator's address, because a blank box a visitor has to already know
     something to fill in leaks nothing, and one that arrives pre-typed with a
     real person's email does. */
  const [email, setEmail] = useState(site.opsEmail);
  const [otherAccount, setOtherAccount] = useState(false);

  function toggleOtherAccount() {
    setOtherAccount((value) => {
      const next = !value;
      setEmail(next ? '' : site.opsEmail);
      return next;
    });
    setSend({ kind: 'idle' });
  }

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
      /* every failure here reads as one flat sentence and stops. no navigation,
         no email, no page past this one — a wrong guess gets told it is wrong
         and nothing else happens, which is the entire point of a password gate.
         supabase answers "invalid login credentials" both for a wrong password
         and for an address with no password set at all; the visitor cannot tell
         those apart from this message and should not be able to — distinguishing
         them would tell an attacker which addresses are real accounts. */
      setSend({ kind: 'error', message: 'that password is wrong.' });
      return;
    }

    navigate('/ops/console', { replace: true });
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
            ) : (
              <form className="ph__signin" onSubmit={signIn}>
                {/* the address field only appears once somebody says they are not
                    you — the common case stays one box. it starts empty rather
                    than pre-filled: this page is public, and a field that
                    arrives already carrying the primary operator's address is a
                    leak the moment it renders, before anyone types anything. */}
                {otherAccount && (
                  <label className="pt-field" style={{ marginBottom: 12 }}>
                    <span className="pt-field__label">email</span>
                    <input
                      className="pt-field__input"
                      type="email"
                      required
                      autoFocus
                      autoComplete="email"
                      placeholder="you@arcautomations.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                )}

                <label className="pt-field" style={{ marginBottom: 12 }}>
                  <span className="pt-field__label">password</span>
                  <input
                    className="pt-field__input"
                    type="password"
                    required
                    autoFocus={!otherAccount}
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

                <button type="button" className="ph__switch" onClick={toggleOtherAccount}>
                  {otherAccount ? 'sign in as the default operator instead' : 'not you? sign in as someone else'}
                </button>

                <p className="ph__note" style={{ marginTop: 14 }}>
                  no sign-up, no email link from this page. locked out? set or reset the password
                  directly in supabase — authentication → users → the account.
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
