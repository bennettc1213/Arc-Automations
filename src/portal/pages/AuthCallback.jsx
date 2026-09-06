import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase, isConfigured } from '../lib/supabase';

/**
 * where the magic link lands. exchanges the one-time code for a session, then
 * hands off to the portal.
 *
 * the supabase client is created with detectSessionInUrl, so it consumes the
 * code on construction; this route waits for the resulting session rather than
 * calling exchangeCodeForSession a second time, which would fail on an
 * already-spent code.
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

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && !done) {
        done = true;
        navigate('/portal/dashboard', { replace: true });
      }
    });

    // covers the case where the session was already established before this
    // listener attached — otherwise a fast exchange would hang on "signing in".
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !done) {
        done = true;
        navigate('/portal/dashboard', { replace: true });
      } else if (!session) {
        setError('that link is invalid or has expired.');
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  return (
    <div className="pt-auth">
      <div className="pt-auth__card">
        <p className="pt-auth__mark">
          arc<b>.</b>portal
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
