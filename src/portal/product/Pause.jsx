import { useState } from 'react';
import { setSendingPaused } from './api';
import { Button, Dialog, Notice, dateLabel } from './ui';

/**
 * the owner's own pause (0035, `self_service_set_sending_pause`).
 *
 * one switch for "stop texting my customers for now". it is not ARC switching the account
 * off — that is ARC's own decision and is shown under setup — so it is worded as the owner's,
 * and it says the three things that are true whichever way it is flipped: new inquiries still
 * arrive, the owner is still told about them, and nothing held back is sent on resuming.
 *
 * drawn only where the switch exists. on an account whose database does not have it yet there
 * is no button, rather than one that would fail.
 */
export default function SendingPause({ state, onReload }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (state.mode === 'demo' || !state.sending) return null;
  const paused = state.sending.paused;

  async function flip() {
    setBusy(true); setError('');
    try {
      await setSendingPaused(state.tenantId, !paused);
      setConfirming(false);
      await onReload?.();
    } catch (failure) {
      setError('That did not go through, so nothing changed. Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <>
      {paused ? (
        <Notice warning>
          <b>You paused your texts{state.sending.changedAt ? ` on ${dateLabel(state.sending.changedAt, state.business.timezone)}` : ''}.</b>{' '}
          Nobody is being texted. New inquiries still arrive in your inbox and you are still told about each one.{' '}
          <Button primary onClick={() => setConfirming(true)}>Resume texts</Button>
        </Notice>
      ) : (
        <div className="ap-actions">
          <Button quiet onClick={() => setConfirming(true)}>Pause all texts</Button>
        </div>
      )}
      {confirming && (
        <Dialog title={paused ? 'Resume your texts?' : 'Pause all your texts?'} onClose={() => setConfirming(false)}>
          {paused ? (
            <>
              <p>ARC goes back to texting customers who reach you from now on.</p>
              <p className="ap-muted">Inquiries that came in while you were paused are not texted now. They are in your inbox for you to call.</p>
            </>
          ) : (
            <>
              <p>ARC stops texting your customers until you resume. Missed calls and website inquiries still arrive in your inbox, and you are still told about each one.</p>
              <p className="ap-muted">A text that has already gone out cannot be taken back.</p>
            </>
          )}
          {error && <p role="alert" className="ap-error">{error}</p>}
          <div className="ap-actions">
            <Button primary disabled={busy} onClick={flip}>{busy ? 'Working…' : paused ? 'Resume texts' : 'Pause all texts'}</Button>
            <Button onClick={() => setConfirming(false)}>Not now</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
