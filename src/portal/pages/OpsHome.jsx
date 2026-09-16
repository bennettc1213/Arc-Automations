import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import useEntrance from '../lib/entrance';
import { anonKey, getSupabase, isConfigured } from '../lib/supabase';
import { OPS_NAV_GROUPS, OPS_NAV_ITEMS } from '../lib/ops-nav';
import { site } from '../../data/site';
import { version } from '../../../package.json';
import './OpsHome.css';

/**
 * the front door of the ops console.
 *
 * the same entrance as /portal — lib/entrance.js, so crossing into either half
 * of the product is the same movement — but deliberately not the same page. the
 * client door is a pitch: a wordmark to push around, a headline, reasons to sign
 * in. this side has nothing to sell and one person to let in, so it is built out
 * of the console it guards instead: square panels, mono readouts, and the
 * console's own page list, read from ops-nav.js so the index here cannot name a
 * page the console no longer has. landing here should never be mistakable for
 * landing on the client portal.
 *
 * who gets in: no client ID here — client IDs identify accounts, and there is no
 * account on this side, only people. by default the door is a single password
 * field: the address it checks against is a constant in site.js (the primary
 * operator, opened several times a day), because a form that asks a question it
 * already knows the answer to is a form you resent every morning. "not you? sign
 * in as someone else" reveals a blank address field for anyone else in
 * `arc_admins` — see OperatorAccount's "adding another operator" for how they
 * get there.
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

const MOUNTAIN = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'America/Denver',
});

/* its own component so the tick re-renders one span, not the form. */
function Clock() {
  const [now, setNow] = useState(() => MOUNTAIN.format(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(MOUNTAIN.format(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* every value on the strip is something this page can actually know without
   signing in. no client counts, no uptime: those live behind the gate, and a
   door that printed a guess at them would be the first figure in the product
   that could not be proved. */
function Readout({ label, tone, glyph, children }) {
  return (
    <li className="od-read">
      <span className="od-read__label">{label}</span>
      <span className={`od-read__val${tone ? ` od-read__val--${tone}` : ''}`}>
        {glyph && <i aria-hidden="true">{glyph}</i>}
        {children}
      </span>
    </li>
  );
}

/* "signed in", not "active": a session is a fact about this browser, and it says
   nothing about whether the account behind it is an operator — the console
   asks arc_admins that question on the other side of the door. */
function sessionReadout(kind) {
  if (kind === 'in') return { tone: 'ok', glyph: '■', word: 'signed in' };
  if (kind === 'out') return { glyph: '□', word: 'none' };
  if (kind === 'unconfigured') return { glyph: '□', word: 'unavailable' };
  return { glyph: '…', word: 'checking' };
}

/**
 * the project, asked rather than assumed.
 *
 * the readout used to print "configured" whenever the build had a supabase url
 * baked in — which is true of a project that is paused, deleted or down. this
 * makes a round trip to the auth service's health endpoint and prints what came
 * back and how long it took, so the green square is an answer, not a setting.
 */
function useProjectReach() {
  const [reach, setReach] = useState({ kind: isConfigured ? 'checking' : 'unconfigured' });

  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const started = performance.now();

    fetch(`${import.meta.env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/health`, {
      headers: { apikey: anonKey ?? '' },
      signal: controller.signal,
    })
      .then((response) => {
        if (!live) return;
        const ms = Math.round(performance.now() - started);
        setReach(response.ok ? { kind: 'up', ms } : { kind: 'down', detail: `answered ${response.status}` });
      })
      .catch(() => live && setReach({ kind: 'down', detail: 'no answer' }))
      .finally(() => clearTimeout(timer));

    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return reach;
}

function reachReadout(reach) {
  if (reach.kind === 'up') return { tone: 'ok', glyph: '■', word: `reachable · ${reach.ms}ms` };
  if (reach.kind === 'down') return { tone: 'fail', glyph: '●', word: reach.detail };
  if (reach.kind === 'unconfigured') return { tone: 'warn', glyph: '▲', word: 'not configured' };
  return { glyph: '…', word: 'checking' };
}

export default function OpsHome() {
  const { entered, flown, Veil, enter, finish } = useEntrance();
  const navigate = useNavigate();
  const [session, setSession] = useState({ kind: 'unknown', email: null });
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

  /* decides which panel is shown and whether the index links. it defaults to
     signed-out, because the failure that matters is sending somebody who cannot
     get in to a console that will just tell them so. */
  useEffect(() => {
    if (!isConfigured) {
      setSession({ kind: 'unconfigured', email: null });
      return undefined;
    }
    let live = true;
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => {
        if (!live) return;
        const current = data?.session;
        setSession({ kind: current ? 'in' : 'out', email: current?.user?.email ?? null });
      })
      .catch(() => live && setSession({ kind: 'out', email: null }));
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

  const signedIn = session.kind === 'in';
  const sessionRead = sessionReadout(session.kind);
  const reachRead = reachReadout(useProjectReach());

  return (
    <div className="portal od">
      {!flown && <Veil onReveal={enter} onDone={finish} />}

      <div className="od__stage" data-entered={entered ? 'true' : 'false'}>
        <header className="od-bar">
          <Link className="od-bar__mark" to="/ops">
            <ArcMark size={19} title="arc automations" />
            <span>
              arc<b>.</b>ops
            </span>
          </Link>
          <span className="od-bar__tag">restricted</span>
          <nav className="od-bar__nav" aria-label="ops">
            <Link to="/">the site</Link>
            <Link to="/portal">client portal</Link>
          </nav>
        </header>

        <ul className="od-readouts" aria-label="environment">
          <Readout label="supabase" tone={reachRead.tone} glyph={reachRead.glyph}>
            {reachRead.word}
          </Readout>
          <Readout label="session" tone={sessionRead.tone} glyph={sessionRead.glyph}>
            {sessionRead.word}
          </Readout>
          <Readout label="gate">arc_admins · rls</Readout>
          <Readout label="build">v{version}</Readout>
          <Readout label="mountain">
            <Clock />
          </Readout>
        </ul>

        <main className="od-main">
          <section className="od-panel od-access" aria-labelledby="od-title">
            <header className="od-panel__head">
              <span>access</span>
              <span className="od-panel__note">operators only</span>
            </header>

            <div className="od-access__body">
              <h1 className="od-access__title" id="od-title">
                operator console
              </h1>
              <p className="od-access__sub">
                the staff side of {site.brand}: every client, what they are wired to, and the buttons
                that add a new one. clients sign in at the portal, not here.
              </p>

              {signedIn ? (
                <>
                  <p className="od-access__who">
                    <i aria-hidden="true">●</i>
                    signed in{session.email ? ' as' : ''}
                    {session.email && <span className="mono">{session.email}</span>}
                  </p>
                  <Link className="od-btn od-btn--primary od-btn--wide" to="/ops/console">
                    open the console <span aria-hidden="true">→</span>
                  </Link>
                </>
              ) : (
                <form onSubmit={signIn}>
                  {/* the address field only appears once somebody says they are not
                      you — the common case stays one box. it starts empty rather
                      than pre-filled: this page is public, and a field that
                      arrives already carrying the primary operator's address is a
                      leak the moment it renders, before anyone types anything. */}
                  {otherAccount && (
                    <div className="od-field">
                      <label className="od-field__label" htmlFor="od-email">
                        email
                      </label>
                      <input
                        id="od-email"
                        className="od-input"
                        type="email"
                        required
                        autoFocus
                        autoComplete="email"
                        placeholder="you@arcautomations.com"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                      />
                    </div>
                  )}

                  <div className="od-field">
                    <label className="od-field__label" htmlFor="od-password">
                      password
                    </label>
                    <div className="od-prompt">
                      <span className="od-prompt__caret" aria-hidden="true">
                        &gt;
                      </span>
                      <input
                        id="od-password"
                        className="od-input"
                        type="password"
                        required
                        autoFocus={!otherAccount}
                        autoComplete="current-password"
                        placeholder="••••••••••••"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <button
                        className="od-btn od-btn--primary"
                        type="submit"
                        disabled={send.kind === 'sending'}
                      >
                        {send.kind === 'sending' ? 'checking…' : 'enter'}
                      </button>
                    </div>
                  </div>

                  {send.kind === 'error' && <p className="pt-auth__err">{send.message}</p>}

                  <button type="button" className="od-switch" onClick={toggleOtherAccount}>
                    {otherAccount
                      ? 'sign in as the default operator instead'
                      : 'not you? sign in as someone else'}
                  </button>
                </form>
              )}

              <p className="od-fine">
                no sign-up, no email link from this page. locked out? set or reset the password
                directly in supabase — authentication → users → the account.
              </p>
            </div>
          </section>

          <section className="od-panel od-index" aria-label="what the console holds">
            <header className="od-panel__head">
              <span>the console</span>
              <span className="od-panel__note">
                {OPS_NAV_ITEMS.length} pages{signedIn ? '' : ' · sign in to open'}
              </span>
            </header>

            {OPS_NAV_GROUPS.map((group) => (
              <div className="od-index__group" key={group.label}>
                <p className="od-index__grouplabel">{group.label}</p>
                <ul>
                  {group.items.map((item) => {
                    const row = (
                      <>
                        <span className="od-index__path">/{item.to}</span>
                        <span className="od-index__label">{item.label}</span>
                        <span className="od-index__blurb">{item.blurb}</span>
                      </>
                    );
                    return (
                      <li key={item.to}>
                        {signedIn ? (
                          <Link
                            className="od-index__row"
                            to={item.to ? `/ops/console/${item.to}` : '/ops/console'}
                          >
                            {row}
                          </Link>
                        ) : (
                          <div className="od-index__row">{row}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        </main>

        <footer className="od-foot">
          <p>
            looking for your own dashboard? that is the <Link to="/portal">client portal</Link> —
            sign in there with your client id.
          </p>
          <p className="od-foot__mark">
            <ArcMark size={14} />
            {site.brand}
          </p>
        </footer>
      </div>
    </div>
  );
}
