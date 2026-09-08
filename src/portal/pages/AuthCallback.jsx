import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import { getSupabase, isConfigured } from '../lib/supabase';
import { safePath, takeDestination } from '../lib/auth-next';

/**
 * where the magic link lands. exchanges the one-time code for a session, then
 * hands off.
 *
 * the supabase client is created with detectSessionInUrl, so it consumes the
 * code on construction; this route waits for the resulting session rather than
 * calling exchangeCodeForSession a second time, which would fail on an
 * already-spent code.
 *
 * where it hands off to is now a question, because there are two destinations.
 * a client goes to their dashboard; ben goes to the ops console. the answer is
 * looked up rather than assumed — see resolveDestination.
 */

export default function AuthCallback() {
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isConfigured) {
      setError('portal is not configured in this environment.');
      return undefined;
    }

    const supabase = getSupabase();
    let done = false;

    /**
     * three sources, in order of how much they know.
     *
     * an explicit ?next= wins because somebody asked for it. the remembered hint
     * covers the case where supabase dropped the query string on the way through.
     * failing both, the admin check is what stops ben — who is not a member of
     * any tenant — landing on "no portal linked yet" and concluding the whole
     * thing is broken.
     */
    async function resolveDestination() {
      const asked = safePath(new URLSearchParams(window.location.search).get('next'));
      if (asked) return asked;

      const remembered = takeDestination();
      if (remembered) return remembered;

      const { data, error: rpcError } = await supabase.rpc('is_arc_admin');
      return !rpcError && data === true ? '/ops/console' : '/portal/dashboard';
    }

    async function handOff() {
      if (done) return;
      done = true;
      navigate(await resolveDestination(), { replace: true });
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) handOff();
    });

    // covers the case where the session was already established before this
    // listener attached — otherwise a fast exchange would hang on "signing in".
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) handOff();
      else if (!done) setError('that link is invalid or has expired.');
    });

    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  return (
    <div className="pt-auth">
      <div className="pt-auth__card">
        <p className="pt-auth__mark">
          <ArcMark size={20} title="arc automations" />
          <span>
            arc<b>.</b>portal
          </span>
        </p>
        <h1 className="pt-auth__title">{error ? 'sign-in failed' : 'signing you in'}</h1>
        <p className="pt-auth__body">{error ?? 'one moment.'}</p>
        {error && (
          <button className="pt-btn pt-btn--ghost" type="button" onClick={() => navigate('/login')}>
            request a new link
          </button>
        )}
      </div>
    </div>
  );
}
