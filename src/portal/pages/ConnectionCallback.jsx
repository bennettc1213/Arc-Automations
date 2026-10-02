import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import { isConfigured } from '../lib/supabase';
import { activationApi } from '../lib/ops';

/**
 * ARC-320 — where a provider sends the browser back after an OAuth authorisation
 * (`ARC_OAUTH_REDIRECT_URL`, ARC-130 §17).
 *
 * The query string carries a one-time authorisation code and state. They are read once and
 * stripped from the address bar and history **before anything else runs** — before the
 * Supabase client exists, too, because that client is built to consume a `code` in the URL
 * as its own sign-in. The page asks for no referrer while it is open. Then the code and state
 * go to the `connections` function with the signed-in user's own token, never a cookie: the
 * state is bound to the person who began the flow, so a code posted by anyone else is
 * refused there, and a repeat of the same callback is answered with the first result.
 *
 * The return path comes back from the server, which stored it when the flow began and only
 * ever stores a page inside the portal or the console; it is checked again here before it is
 * navigated to.
 */

const RETURN_PATH = /^\/(portal\/dashboard|ops\/console)(\/[A-Za-z0-9._~-]{1,64}){0,6}\/?$/;

let taken = null;

/** Read the callback's parameters once, and remove them from the URL at once. */
export function takeCallbackParams(location = window.location, history = window.history) {
  if (taken) return taken;
  const url = new URL(location.href);
  const read = (name) => {
    const value = url.searchParams.get(name);
    return value && value.length <= 2048 ? value : null;
  };
  taken = {
    state: read('state'),
    code: read('code'),
    error: read('error'),
    errorDescription: read('error_description'),
  };
  history.replaceState(null, '', url.pathname);
  return taken;
}

export default function ConnectionCallback({ api = activationApi }) {
  const [params] = useState(() => takeCallbackParams());
  const [state, setState] = useState({ kind: 'working' });
  const navigate = useNavigate();

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let live = true;
    if (!isConfigured) {
      setState({ kind: 'error', message: 'the portal is not configured in this environment.' });
      return undefined;
    }
    if (!params.state) {
      setState({ kind: 'error', message: 'there is nothing to finish here — start the connection again from the console.' });
      return undefined;
    }
    api
      .completeOAuth(params)
      .then((result) => {
        if (!live) return;
        const to = typeof result?.return_path === 'string' && RETURN_PATH.test(result.return_path) ? result.return_path : '/ops/console';
        setState({ kind: 'done', status: result?.connection?.status ?? null });
        navigate(to, { replace: true });
      })
      .catch((error) => {
        if (live) setState({ kind: 'error', message: error.message });
      });
    return () => {
      live = false;
    };
  }, [api, navigate, params]);

  return (
    <div className="pt-auth">
      <div className="pt-auth__card">
        <p className="pt-auth__mark">
          <ArcMark size={20} title="arc automations" />
          <span>
            arc<b>.</b>connections
          </span>
        </p>
        <h1 className="pt-auth__title">
          {state.kind === 'error' ? 'the connection was not completed' : state.kind === 'done' ? 'connected' : 'finishing the connection'}
        </h1>
        <p className="pt-auth__body">
          {state.kind === 'error'
            ? state.message
            : state.kind === 'done'
              ? `the provider answered; the connection is ${state.status ?? 'recorded'}. taking you back.`
              : 'checking the answer with the provider — one moment.'}
        </p>
        {state.kind === 'error' && (
          <button className="pt-btn pt-btn--ghost" type="button" onClick={() => navigate('/ops/console', { replace: true })}>
            back to the console
          </button>
        )}
      </div>
    </div>
  );
}
