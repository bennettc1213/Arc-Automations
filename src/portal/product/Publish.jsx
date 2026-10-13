import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { previewCampaign, publishCampaign } from './api';
import { Button, Dialog, Notice } from './ui';

/**
 * switching a campaign on (0034, `crm` actions `campaign-preview` / `campaign-publish`).
 *
 * the page decides nothing and words nothing: the server reads the saved campaign, says
 * exactly which parts of it will change what ARC sends and which will not, and returns the
 * texts as a customer would receive them. the owner reads that and confirms. what they
 * confirm is tied to the versions they were shown, so a campaign or an account that changed
 * in between is shown again rather than switched on unseen.
 */
export default function PublishDialog({ state, campaign, base, onClose, onPublished }) {
  const [view, setView] = useState({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    previewCampaign(state.tenantId, campaign.id)
      .then(preview => { if (live) setView({ kind: 'ready', preview }); })
      .catch(failure => { if (live) setView({ kind: 'refused', failure }); });
    return () => { live = false; };
  }, [state.tenantId, campaign.id, campaign.revision]);

  async function confirm() {
    setBusy(true);
    try {
      const answer = await publishCampaign(state.tenantId, view.preview);
      setView({ kind: 'done', preview: answer.preview, changed: answer.published.changed });
      await onPublished?.();
    } catch (failure) {
      /* something changed since the preview: show the new one rather than an error to retry. */
      if (failure.code === 'stale' && failure.preview) setView({ kind: 'ready', preview: failure.preview, changedSince: true });
      else setView({ kind: 'refused', failure });
    } finally { setBusy(false); }
  }

  const title = view.kind === 'done' ? 'Switched on' : `Switch on ${campaign.name}?`;
  return (
    <Dialog title={title} onClose={onClose}>
      {view.kind === 'loading' && <p className="ap-muted" role="status">Checking what this will change…</p>}

      {view.kind === 'refused' && (
        <>
          <Notice warning>{view.failure.message}</Notice>
          {view.failure.problems?.length > 0 && (
            <ul className="ap-blockers">{view.failure.problems.map(problem => <li key={problem.id + problem.text}>{problem.text}</li>)}</ul>
          )}
          <div className="ap-actions">
            {view.failure.problems?.length > 0 && <Link className="ap-button ap-button--primary" to={`${base}/campaigns/${campaign.id}`} onClick={onClose}>Open the campaign</Link>}
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      )}

      {(view.kind === 'ready' || view.kind === 'done') && (
        <>
          {view.changedSince && <Notice warning>Something changed since you opened this. Here is what it would do now.</Notice>}
          {view.kind === 'done' && <Notice>{view.changed ? 'Your words are now the ones ARC uses.' : 'These were already the words ARC uses. Nothing needed changing.'}</Notice>}
          <p>{view.preview.sending.text}</p>

          <h3 className="ap-subheading">What your customer will receive</h3>
          {view.preview.samples.map(sample => (
            <div key={sample.id}>
              <p className="ap-muted">{sample.label}</p>
              <div className="ap-bubble">{sample.text}</div>
            </div>
          ))}
          <p className="ap-muted">Shown for a customer called Alex. A customer with no name gets the same text without one.</p>

          <h3 className="ap-subheading">{view.kind === 'done' ? 'What changed' : 'What this changes'}</h3>
          <ul className="ap-blockers">{view.preview.applied.map(line => <li key={line.id}>{line.text}</li>)}</ul>

          {view.preview.not_applied.length > 0 && (
            <>
              <h3 className="ap-subheading">Saved, but not used yet</h3>
              <ul className="ap-blockers">{view.preview.not_applied.map(line => <li key={line.id}>{line.text}</li>)}</ul>
            </>
          )}

          <div className="ap-actions">
            {view.kind === 'ready' && (
              <Button primary disabled={busy} onClick={confirm}>
                {busy ? 'Switching on…' : view.preview.already_live ? 'Switch on again' : 'Switch it on'}
              </Button>
            )}
            <Button onClick={onClose}>{view.kind === 'done' ? 'Done' : 'Not now'}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
