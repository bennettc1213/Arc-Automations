import { useState } from 'react';
import { Link } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import { anonKey, functionUrl, isConfigured } from '../lib/supabase';
import { CLIENT_ID_EXAMPLE, formatClientIdInput, normaliseClientId } from '../lib/client-id';

/**
 * sign in with a client ID.
 *
 * the ID replaces the email box because an email address is a fact about a person
 * and a client ID is a fact about an account. the owner of a restoration company
 * has three addresses and cannot remember which one we set them up with; the ID
 * is on their welcome email, it is one line, and it is the same string they quote
 * at us when they ask about a specific lead.
 *
 * the ID is not a password. it selects the account, and the sign-in link still
 * goes to a mailbox somebody has to control — so a leaked ID buys an attacker a
 * login email delivered to the client, which is noise, not access. that is the
 * whole reason this can stay a single field with no second factor bolted on.
 *
 * the resolution from ID to address happens in the client-login edge function,
 * under the service role. doing it here would mean an endpoint that hands out an
 * email address to anyone holding a client ID; the function returns a masked hint
 * instead, which is enough to recognise your own inbox and useless for harvesting.
 */
export default function Login() {
  const [clientId, setClientId] = useState('');
  const [state, setState] = useState({ kind: 'idle' });

  const complete = normaliseClientId(clientId) !== null;

  async function handleSubmit(e) {
    e.preventDefault();

    if (!isConfigured) {
      setState({ kind: 'error', message: 'portal is not configured in this environment.' });
      return;
    }

    const normalised = normaliseClientId(clientId);
    if (!normalised) {
      setState({ kind: 'error', message: `that is not a client id. they look like ${CLIENT_ID_EXAMPLE.toLowerCase()}.` });
      return;
    }

    setState({ kind: 'sending' });

    try {
      const response = await fetch(functionUrl('client-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey ?? '' },
        body: JSON.stringify({ client_id: normalised }),
      });

      /* a function that has never been deployed answers with the gateway's html,
         not json. that is a deployment state with a specific fix, so it gets a
         specific message rather than a parse error. */
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.ok) {
        setState({
          kind: 'error',
          message:
            payload?.error ??
            (response.status === 404
              ? 'sign-in is not switched on in this environment yet.'
              : 'could not reach the sign-in service. try again in a moment.'),
        });
        return;
      }

      setState({ kind: 'sent', account: payload.account, hint: payload.hint });
    } catch {
      setState({ kind: 'error', message: 'could not reach the sign-in service. check your connection.' });
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className="pt-auth">
        <div className="pt-auth__card">
          <p className="pt-auth__mark">
            <ArcMark size={20} title="arc automations" />
            <span>
              arc<b>.</b>portal
            </span>
          </p>
          <h1 className="pt-auth__title">check your email</h1>
          <p className="pt-auth__body">
            a sign-in link is on its way to <span className="mono">{state.hint}</span>
            {state.account && (
              <>
                {' '}
                — the address on file for <b>{state.account}</b>
              </>
            )}
            . it expires in one hour.
          </p>
          <p className="pt-auth__fine">
            not the inbox you expected? that is the address we have for this account —{' '}
            <a href="mailto:bennettch1213@gmail.com">tell us</a> and we will change it.
            <br />
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
          <ArcMark size={20} title="arc automations" />
          <span>
            arc<b>.</b>portal
          </span>
        </p>
        <h1 className="pt-auth__title">sign in</h1>
        <p className="pt-auth__body">
          your client id is on your welcome email. we send the link to the address on file — no
          password to remember.
        </p>

        <label className="pt-field">
          <span className="pt-field__label">client id</span>
          <input
            className="pt-field__input pt-field__input--id"
            type="text"
            required
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck="false"
            autoFocus
            placeholder={CLIENT_ID_EXAMPLE}
            value={clientId}
            /* formatted on every keystroke rather than validated on submit. a
               field that silently accepts twenty characters and then says "not a
               client id" watched you make the mistake and said nothing. */
            onChange={(e) => setClientId(formatClientIdInput(e.target.value))}
            aria-describedby="client-id-help"
          />
        </label>

        <p className="pt-field__help mono" id="client-id-help">
          {complete ? 'looks right' : 'twelve characters, dashes added for you'}
        </p>

        {state.kind === 'error' && <p className="pt-auth__err">{state.message}</p>}

        <button className="pt-btn" type="submit" disabled={state.kind === 'sending' || !complete}>
          {state.kind === 'sending' ? 'sending…' : 'email me a sign-in link'}
        </button>

        <p className="pt-auth__fine">
          lost the id? it is on your welcome email, and we can resend it —{' '}
          <a href="mailto:bennettch1213@gmail.com">get in touch</a>.
          <br />
          want to see it first? <Link to="/demo">open the live demo</Link>.
        </p>
      </form>
    </div>
  );
}
