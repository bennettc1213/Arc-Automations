import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import OpsWorkspace from '../components/OpsWorkspace';
import { getOpsSession, loadRoster } from '../lib/ops';
import { getSupabase } from '../lib/supabase';
import { site } from '../../data/site';
import '../ops.css';

/**
 * the gate on the ops console.
 *
 * two checks, and they fail differently on purpose. "not signed in" sends you to a
 * sign-in form; "signed in, but not an arc admin" does not — it says so and offers
 * the client portal instead, because the person reading that sentence is a client
 * who followed a link, and bouncing them to a login form they have already
 * completed is the most confusing thing an admin tool can do.
 *
 * the admin check itself is `is_arc_admin()` in postgres, the same predicate the
 * row level security policies use. this component cannot let anybody in that the
 * database would not: even if this check were bypassed entirely, every query the
 * console makes would come back empty.
 */

function Shell({ title, children, onSignOut }) {
  return (
    <div className="portal">
      <header className="pt-head">
        <div className="pt-head__in">
          <Link to="/ops" className="pt-head__mark">
            <ArcMark size={19} title="arc automations" />
            <span>
              arc<b>.</b>ops
            </span>
          </Link>
          <div className="pt-head__right">
            <Link to="/" className="pt-head__link">
              the site
            </Link>
            {onSignOut && (
              <button type="button" className="pt-head__link" onClick={onSignOut}>
                sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="pt-body">
        <div className="pt-col">
          <div className="pt-early">
            <p className="pt-early__title">{title}</p>
            <div className="pt-early__body">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Ops() {
  const [state, setState] = useState({ kind: 'loading' });
  const navigate = useNavigate();

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    navigate('/ops');
  }, [navigate]);

  const load = useCallback(async () => {
    const session = await getOpsSession();

    if (!session.configured) {
      setState({ kind: 'unconfigured' });
      return;
    }
    if (!session.signedIn) {
      setState({ kind: 'signed-out' });
      return;
    }
    if (!session.isAdmin) {
      setState({ kind: 'not-admin', email: session.email, checkError: session.checkError });
      return;
    }

    try {
      const roster = await loadRoster();
      setState({ kind: 'ready', roster, email: session.email });
    } catch (error) {
      setState({ kind: 'error', message: error.message, email: session.email });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch((error) => {
      if (!cancelled) setState({ kind: 'error', message: error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  /* handed to every page as `reload`. the roster is one object loaded once, so a
     write has to refetch it — and every write on the console awaits this before it
     reports success, which is why a saved edit is visible in the table behind the
     panel by the time the button says "saved". */
  const reload = useCallback(async () => {
    const roster = await loadRoster();
    setState((prev) => (prev.kind === 'ready' ? { ...prev, roster } : prev));
  }, []);

  if (state.kind === 'ready') {
    return (
      <OpsWorkspace
        roster={state.roster}
        email={state.email}
        onSignOut={signOut}
        onReload={reload}
      />
    );
  }

  if (state.kind === 'signed-out') {
    return (
      <Shell title="sign in to the console">
        this is the operator side of the portal. it is not open —{' '}
        <Link to="/ops" style={{ color: 'var(--accent)' }}>
          go back to the door
        </Link>{' '}
        and request a link.
      </Shell>
    );
  }

  if (state.kind === 'not-admin') {
    return (
      <Shell title="that account is not an operator" onSignOut={signOut}>
        <span className="mono">{state.email}</span> is signed in, but it is not in{' '}
        <span className="mono">arc_admins</span>, so the database returns nothing for it here.
        {state.checkError ? (
          <>
            {' '}
            the check itself errored (<span className="mono">{state.checkError}</span>), which
            usually means migration <span className="mono">0003</span> has not been applied yet.
          </>
        ) : null}{' '}
        if you are a client, your dashboard is{' '}
        <Link to="/portal/dashboard" style={{ color: 'var(--accent)' }}>
          this way
        </Link>
        .
      </Shell>
    );
  }

  if (state.kind === 'unconfigured') {
    return (
      <Shell title="console unavailable">
        this environment has no supabase connection configured, so there is nothing for the
        console to read.{' '}
        <Link to="/demo" style={{ color: 'var(--accent)' }}>
          the client demo
        </Link>{' '}
        runs on generated data and still works.
      </Shell>
    );
  }

  if (state.kind === 'error') {
    return (
      <Shell title="could not load the roster" onSignOut={signOut}>
        {state.message}
        <br />
        <br />
        if this is a permissions error, apply{' '}
        <span className="mono">supabase/migrations/0003_client_ids_and_ops.sql</span> and add
        yourself to <span className="mono">arc_admins</span> — the bootstrap statement is in the
        comment at the bottom of that file. questions:{' '}
        <a href={`mailto:${site.email}`} style={{ color: 'var(--accent)' }}>
          {site.email}
        </a>
        .
      </Shell>
    );
  }

  return <Shell title="loading the roster…">reading every tenant, then the event window behind them.</Shell>;
}
