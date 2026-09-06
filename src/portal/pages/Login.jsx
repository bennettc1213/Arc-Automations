import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getSupabase, isConfigured } from '../lib/supabase';

/**
 * magic-link sign in.
 *
 * no passwords: the owner of a restoration company will not manage one for a
 * dashboard they open twice a month, and a forgotten-password flow is support
 * cost that buys nothing.
 *
 * there is no sign-up, and `shouldCreateUser: false` is what enforces it. ben
 * creates the tenant and invites the address; an unknown email cannot
 * provision itself an account by typing itself into this box.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ kind: 'idle' });

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isConfigured) {
      setState({ kind: 'error', message: 'portal is not configured in this environment.' });
      return;
    }

    setState({ kind: 'sending' });

    const { error } = await getSupabase().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}auth/callback`,
        shouldCreateUser: false,
      },
    });

    if (error) {
      setState({ kind: 'error', message: error.message.toLowerCase() });
      return;
    }
    setState({ kind: 'sent' });
  }

  if (state.kind === 'sent') {
    return (
      <div className="pt-auth">
        <div className="pt-auth__card">
          <p className="pt-auth__mark">
            arc<b>.</b>portal
          </p>
          <h1 className="pt-auth__title">check your email</h1>
          <p className="pt-auth__body">
            a sign-in link is on its way to <span className="mono">{email}</span>. it expires in one
            hour.
          </p>
          <p className="pt-auth__fine">
            nothing arrived? check spam, then <Link to="/login">try again</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-auth">
      <form className="pt-auth__card" onSubmit={handleSubmit}>
        <p className="pt-auth__mark">
          arc<b>.</b>portal
        </p>
        <h1 className="pt-auth__title">sign in</h1>
        <p className="pt-auth__body">we email you a link. no password to remember.</p>

        <label className="pt-field">
          <span className="pt-field__label">email address</span>
          <input
            className="pt-field__input"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        {state.kind === 'error' && <p className="pt-auth__err">{state.message}</p>}

        <button className="pt-btn" type="submit" disabled={state.kind === 'sending'}>
          {state.kind === 'sending' ? 'sending…' : 'email me a link'}
        </button>

        <p className="pt-auth__fine">
          portal access is set up by arc automations. if your address isn't recognised, it hasn't
          been linked yet — <a href="mailto:bennettch1213@gmail.com">get in touch</a>.
          <br />
          want to see it first? <Link to="/demo">open the live demo</Link>.
        </p>
      </form>
    </div>
  );
}
