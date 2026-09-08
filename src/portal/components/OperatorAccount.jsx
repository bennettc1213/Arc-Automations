import { useState } from 'react';
import { Panel } from './ui';
import { ActionButton, Disclosure, Field, Notice, TextInput } from './ops-ui';
import { getSupabase } from '../lib/supabase';

/**
 * setting the password on the operator's own auth account.
 *
 * this exists so the password never has to be typed into the supabase dashboard,
 * and — much more importantly — so it never has to be typed into this repo. the
 * site is a static bundle served from a public repository: a password compared in
 * front-end code is a published password, and it would not even be doing anything,
 * because what actually empties the console for anyone who is not an admin is
 * `arc_admins` and row level security in postgres.
 *
 * so the value here goes straight to supabase's auth API over TLS, is hashed
 * server-side, and is never held anywhere this code can read it back. the fields
 * are cleared on success for the same reason: there is no version of "convenient"
 * that justifies leaving it sitting in component state.
 *
 * the confirm field is not ceremony. there is no password reset flow on this side
 * beyond the magic link, so a typo here means signing in by email and coming back
 * — recoverable, but only if you notice, and a mistyped password is invisible.
 */

/* supabase's own floor is six. twelve is this file's, because the address it
   protects is public and the console behind it holds every client's data. */
const MIN_LENGTH = 12;

export default function OperatorAccount({ email }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= MIN_LENGTH && password === confirm;

  return (
    <Panel
      title="your operator account"
      note={email ?? 'signed in'}
      actions={
        <ActionButton
          variant="primary"
          icon="check"
          disabled={!ready}
          onRun={async () => {
            const { error } = await getSupabase().auth.updateUser({ password });
            if (error) throw new Error(error.message.toLowerCase());
            setPassword('');
            setConfirm('');
            return 'password set — it works at /ops from now on';
          }}
        >
          set password
        </ActionButton>
      }
    >
      <p className="ops-muted">
        set a password and you can sign in at <span className="mono">/ops</span> with your email
        and password instead of waiting on a link. the magic link keeps working either way —
        it is how you get back in if you forget this.
      </p>

      <div className="ops-form" style={{ marginTop: 16 }}>
        <Field
          label="new password"
          hint={tooShort ? `at least ${MIN_LENGTH} characters` : `${MIN_LENGTH} characters or more`}
        >
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••••"
          />
        </Field>

        <Field label="again" hint={mismatch ? 'these do not match' : 'to catch a typo'}>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="••••••••••••"
          />
        </Field>
      </div>

      <Notice tone="warn" title="where this is stored">
        <p>
          it goes straight to supabase over TLS and is hashed there. it is never written to this
          repository, never baked into the bundle, and cannot be read back out of either — which
          is the whole reason this box exists instead of a password sitting in the source.
        </p>
        <p style={{ marginTop: 8 }}>
          it is also not what protects this console. that is{' '}
          <code>arc_admins</code> and row level security: an attacker past this password still
          gets an empty console, because postgres refuses the rows.
        </p>
      </Notice>

      {/* closed by default — this is a reference for the one afternoon a year
          somebody new needs console access, not something to read every visit.
          it exists because writing these four steps out once, correctly, in a
          place future-ben will actually find beats reconstructing them from a
          chat log a second time. */}
      <Disclosure title="adding another operator" summary="4 steps · one-time per person">
        <p>
          this console has no sign-up. every operator is added by hand, in supabase, by
          somebody who is already an admin. that is deliberate — a public site with a public
          sign-up form for its own admin tool is a back door with a nicer name.
        </p>

        <ol className="ops-steps">
          <li>
            <b>create their login.</b> supabase dashboard → authentication → users → add user.
            enter their email and a password, and tick <b>auto confirm user</b> — without that
            box, supabase waits on a confirmation email that this project's auth settings may
            not be sending.
          </li>

          <li>
            <b>confirm the admin schema exists.</b> only needed once, ever, for the whole
            project — skip this if you have already added an operator before. sql editor → new
            query:
            <pre>{'select proname from pg_proc where proname = \'is_arc_admin\';'}</pre>
            one row back means it is already set up. nothing back means the migration has never
            run — apply <code>supabase/migrations/0003_client_ids_and_ops.sql</code> first (the
            whole file, run once) and then come back to this step.
          </li>

          <li>
            <b>add them to <code>arc_admins</code>.</b> sql editor → new query, with their
            actual email in place of the placeholder:
            <pre>{`insert into public.arc_admins (user_id, email, label)
select id, email, 'their name'
  from auth.users
 where email = 'them@example.com'
on conflict (user_id) do nothing;`}</pre>
          </li>

          <li>
            <b>send them the door and their password.</b>{' '}
            <span className="mono">/ops</span> defaults to signing in as the primary operator,
            so they tap <b>not you? sign in as someone else</b>, which reveals an email field —
            their address, the password from step 1. same door, their own login.
          </li>
        </ol>
      </Disclosure>
    </Panel>
  );
}
