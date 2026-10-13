import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Field, Notice, TextInput } from './ops-ui';
import { getSelfServiceBusinesses, getSendingStatus, setSendingStopped } from '../lib/ops';
import { formatStamp } from '../lib/format';

/**
 * the two things an operator needs when something is wrong with the product as a whole:
 * one switch that stops every real text, and every self-signup business with where it
 * stands (0031, 0033; `ops` actions `platform-*`).
 *
 * the page decides nothing. the stop is one row the send gates read in SQL; the list is
 * read off the rows that decide each answer. no customer's number, no message and no
 * credential is on it. where the hosted project has not been given the migrations or the
 * `ops` function yet, it says so rather than drawing an empty list that looks like "none".
 */

const SUBSCRIPTION_TONE = { active: 'ok', trialing: 'ok', past_due: 'fail', unpaid: 'fail', canceled: 'warn', none: 'warn' };
const USAGE_WORDS = { at_cap: 'at the cap — new texts are refused', near_cap: 'close to the cap', none: '' };

export default function PlatformPanel({ base }) {
  const [state, setState] = useState({ kind: 'loading' });
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [sending, businesses] = await Promise.all([getSendingStatus(), getSelfServiceBusinesses()]);
      setState({ kind: 'ready', sending, businesses });
    } catch (error) {
      setState({ kind: 'unavailable', message: error.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (state.kind === 'loading') return <Panel title="sending, everywhere"><p className="ws-panel__note">loading…</p></Panel>;
  if (state.kind === 'unavailable') {
    return (
      <Panel title="sending, everywhere">
        <Notice title="the emergency stop is not available on this project yet">
          {state.message}. it needs migrations 0029 to 0033 applied and the ops function redeployed. until
          then, pausing a client's module on its own page is the way to stop its texts.
        </Notice>
      </Panel>
    );
  }

  const { sending, businesses } = state;
  const stopped = sending.sending_stopped === true;

  return (
    <>
      <Panel
        title="sending, everywhere"
        note={stopped ? `stopped ${sending.changed_at ? formatStamp(sending.changed_at) : ''}` : 'running'}
      >
        {stopped ? (
          <Notice tone="fail" title="every real text is stopped, for every business">
            reason given: {sending.reason}. calls, forms and replies are still being recorded. each text
            that was refused was cancelled and its lead handed to a person, so resuming sends none of
            them.
          </Notice>
        ) : (
          <p className="ws-panel__note">
            one switch for an incident: a carrier problem, a wrong message going out, anything where the
            right move is to stop first. it stops customer texts and owner alerts alike. a synthetic test
            still runs.
          </p>
        )}
        <Field label={stopped ? 'what changed (optional)' : 'why are you stopping it'} required={!stopped}>
          <TextInput value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} />
        </Field>
        {stopped ? (
          <ActionButton
            confirm="Resume sending for every business? New leads will be texted again. Nothing refused during the stop is sent."
            onRun={async () => { await setSendingStopped(false, reason.trim()); setReason(''); await load(); return 'sending resumed'; }}
          >
            resume sending
          </ActionButton>
        ) : (
          <ActionButton
            disabled={reason.trim().length < 3}
            title={reason.trim().length < 3 ? 'say why first' : undefined}
            confirm="Stop every real text, for every business? Each text that would have gone is cancelled and its lead handed to a person. Calls, forms and replies are still recorded."
            onRun={async () => { await setSendingStopped(true, reason.trim()); setReason(''); await load(); return 'sending stopped'; }}
          >
            stop all sending
          </ActionButton>
        )}
      </Panel>

      <Panel title="self-signup businesses" note={`${businesses.length} signed up on their own`}>
        {businesses.length === 0 ? (
          <Empty title="nobody has signed up on their own yet">
            a business that creates its own account at /signup appears here, with its subscription.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr><th>business</th><th>setup</th><th>module</th><th>subscription</th><th>used this period</th></tr>
              </thead>
              <tbody>
                {businesses.map((business) => (
                  <tr key={business.tenant_id}>
                    <td>
                      <Link to={`${base}/clients/${business.tenant_id}`}>{business.name || 'unnamed'}</Link>
                      <small> signed up {formatStamp(business.signed_up_at)}</small>
                    </td>
                    <td>
                      {business.setup.details_complete ? 'details saved' : 'details missing'}
                      <small> · {business.campaign_drafts.length} campaign draft{business.campaign_drafts.length === 1 ? '' : 's'}
                        {business.form.exists ? (business.form.last_used_at ? ' · form in use' : ' · form made, never used') : ' · no form'}</small>
                    </td>
                    <td>
                      {business.module.state}
                      {business.module.pending_requirements.length > 0 && <small> · waiting on {business.module.pending_requirements.join(', ')}</small>}
                    </td>
                    <td>
                      <Pill tone={SUBSCRIPTION_TONE[business.subscription.status] || 'warn'}>{String(business.subscription.status).replaceAll('_', ' ')}</Pill>
                      {business.subscription.period_end && <small> to {formatStamp(business.subscription.period_end)}{business.subscription.cancel_at_period_end ? ', then cancels' : ''}</small>}
                    </td>
                    <td>
                      {business.usage.used === null ? (
                        <span aria-label="not available">—</span>
                      ) : (
                        <>{business.usage.used} of {business.usage.cap}{USAGE_WORDS[business.usage.flag] && <small> · {USAGE_WORDS[business.usage.flag]}</small>}</>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
