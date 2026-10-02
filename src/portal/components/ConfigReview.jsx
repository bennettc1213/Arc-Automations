import { Pill, Term } from './ui';
import { Notice } from './ops-ui';
import { describeValue } from '../lib/config-form';

/**
 * ARC-310 — a change between two configuration documents, as the server reported it.
 *
 * Shared by the publish review, the version comparison and the restore preview, so all three
 * redact the same fields: a change the registry marks `sensitiveDisplay` (staff numbers) is
 * shown as changed, never with its values — the server did not send them.
 */
export function ChangeTable({ changes, beforeLabel = 'before', afterLabel = 'after', empty = 'nothing changed.' }) {
  return (
    <table className="ws-table cfg-diff">
      <thead>
        <tr>
          <th>setting</th>
          <th>{beforeLabel}</th>
          <th>{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {changes.length === 0 && (
          <tr>
            <td colSpan={3}>{empty}</td>
          </tr>
        )}
        {changes.map((change) => (
          <tr key={change.path}>
            <td className="mono">{change.path}</td>
            {change.redacted ? (
              <td colSpan={2} className="ops-muted">changed — values hidden</td>
            ) : (
              <>
                <td>{describeValue(change.before)}</td>
                <td>{describeValue(change.after)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** the server's preview, in words: what changes, what each change needs, what each module does. */
export function PublishReview({ preview }) {
  const { impact } = preview;
  const consequenceFree =
    impact.changed_fields.length > 0 && !impact.requires_retest && !impact.requires_shadow && !impact.requires_reactivation;
  return (
    <div className="cfg-review">
      {preview.base_is_current === false && (
        <Notice tone="warn" title="another version was published since this draft began">
          <p>this draft was started from v{preview.base_version}. publishing replaces what is live now — check the changes below against it.</p>
        </Notice>
      )}
      {preview.valid === false && (
        <Notice tone="fail" title="this draft is not valid, so it cannot be published">
          <p>{preview.error}</p>
        </Notice>
      )}
      {preview.denied_fields?.length > 0 && (
        <Notice tone="fail" title="changes to fields you may not edit">
          <p>{preview.denied_fields.join(', ')}</p>
        </Notice>
      )}
      <ChangeTable changes={impact.changes} />
      <ul className="cfg-effects">
        {impact.requires_reactivation && (
          <li>
            <Pill tone="warn">pauses a live module</Pill> it must be re-approved before it runs again
          </li>
        )}
        {!impact.requires_reactivation && impact.requires_shadow && (
          <li>
            <Pill tone="warn">
              <Term k="shadow">shadow</Term> review
            </Pill>{' '}
            it must be watched in shadow mode first — a dry run on real leads that sends nothing
          </li>
        )}
        {!impact.requires_reactivation && !impact.requires_shadow && impact.requires_retest && (
          <li>
            <Pill tone="idle">retest</Pill> a test must pass on the new version
          </li>
        )}
        {consequenceFree && (
          <li>
            <Pill tone="ok">no consequence</Pill> takes effect for new work straight away
          </li>
        )}
        {(preview.lifecycle_effect ?? []).map((effect) => (
          <li key={effect.module_key}>
            <b>{effect.module_name}</b> ({effect.state}) {effect.headline}.
          </li>
        ))}
      </ul>
    </div>
  );
}
