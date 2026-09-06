import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PortalShell from '../components/PortalShell';
import Dashboard from '../components/Dashboard';
import { getDashboardForUser } from '../lib/dashboard';
import { getSupabase, isConfigured } from '../lib/supabase';

/**
 * the signed-in dashboard.
 *
 * every read here goes through the anon key, so row level security decides what
 * comes back. tenant scoping is a database guarantee, not this file remembering
 * to add a filter.
 */
export default function Portal() {
  const [state, setState] = useState({ kind: 'loading' });
  const navigate = useNavigate();

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    navigate('/login');
  }, [navigate]);

  useEffect(() => {
    /* dev-only preview of the signed-in view, reached with ?preview=1.
       import.meta.env.DEV is replaced with a literal false at build time, so the
       whole branch — and the import below — is dropped from production. on a
       product sold on being believable, a sign-in that could be skipped in
       production would be the one unrecoverable bug. */
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1') {
      import('../demo/demo-data.json').then((mod) => setState({ kind: 'preview', data: mod.default }));
      return undefined;
    }

    if (!isConfigured) {
      setState({ kind: 'unconfigured' });
      return undefined;
    }

    let cancelled = false;

    getDashboardForUser()
      .then((result) => {
        if (cancelled) return;
        if (!result.signedIn) {
          navigate('/login');
          return;
        }
        if (!result.data) {
          setState({ kind: 'no-tenant', email: result.email });
          return;
        }
        setState({ kind: 'ready', data: result.data });
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: 'error', message: error.message.toLowerCase() });
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  /* kept as its own DEV-gated return rather than a branch inside the real one,
     so the whole block including its markup is dead code in a production build. */
  if (import.meta.env.DEV && state.kind === 'preview') {
    return (
      <PortalShell tenantName={state.data.tenant.name}>
        <Dashboard
          data={state.data}
          live={false}
          banner={
            <div className="pt-banner">
              <span className="pt-banner__tag">dev preview</span>
              <p>signed-in layout rendered with generated data. not present in a production build.</p>
            </div>
          }
        />
      </PortalShell>
    );
  }

  if (state.kind === 'ready') {
    return (
      <PortalShell tenantName={state.data.tenant.name} onSignOut={signOut}>
        <Dashboard data={state.data} />
      </PortalShell>
    );
  }

  if (state.kind === 'no-tenant') {
    return (
      <PortalShell onSignOut={signOut}>
        <div className="pt-body">
          <div className="pt-col">
            <div className="pt-early">
              <p className="pt-early__title">no portal linked yet</p>
              <p className="pt-early__body">
                {state.email ? (
                  <>
                    <span className="mono">{state.email}</span> is signed in, but it isn't attached
                    to an account yet.
                  </>
                ) : (
                  'this account isn’t attached to a portal yet.'
                )}{' '}
                <a href="mailto:bennettch1213@gmail.com" style={{ color: 'var(--accent)' }}>
                  get in touch
                </a>{' '}
                and it'll be linked.
              </p>
            </div>
          </div>
        </div>
      </PortalShell>
    );
  }

  if (state.kind === 'unconfigured' || state.kind === 'error') {
    return (
      <PortalShell>
        <div className="pt-body">
          <div className="pt-col">
            <div className="pt-early">
              <p className="pt-early__title">portal unavailable</p>
              <p className="pt-early__body">
                {state.kind === 'error'
                  ? state.message
                  : 'this environment has no portal connection configured.'}{' '}
                <Link to="/demo" style={{ color: 'var(--accent)' }}>
                  view the demo
                </Link>
              </p>
            </div>
          </div>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <div className="pt-body">
        <div className="pt-col">
          <p className="pt-feed__empty">loading…</p>
        </div>
      </div>
    </PortalShell>
  );
}
