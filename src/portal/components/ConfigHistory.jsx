import { useCallback, useEffect, useState } from 'react';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Notice } from './ops-ui';
import { ChangeTable, PublishReview } from './ConfigReview';
import { settingsApi } from '../lib/ops';
import { formatStamp } from '../lib/format';

/**
 * ARC-310 — every published version of one scope, never edited.
 *
 * Compare: tick two versions and the server diffs them with the same analysis a publish
 * preview uses, so a hidden field is hidden here too. Restore: the server previews what
 * republishing that version would change against the current one and what the lifecycle
 * would make of it; confirming is ARC-110's rollback, which publishes it as the NEXT version.
 * No historical row is ever changed — restoring v2 over v5 makes v6.
 *
 * Restore is held while a draft is open: the draft was written against the current version,
 * and publishing over it would leave the draft describing a configuration that is gone.
 */
export default function ConfigHistory({ tenantId, scope, moduleKey = null, current, readOnly = false, timezone = 'UTC', api = settingsApi, initial = null, onChanged }) {
  const [state, setState] = useState(initial ? { kind: 'ready', versions: initial } : { kind: 'loading' });
  const [picked, setPicked] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [restore, setRestore] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.history(tenantId, scope, moduleKey);
      setState({ kind: 'ready', versions: result.versions ?? [] });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api, tenantId, scope, moduleKey]);

  useEffect(() => {
    if (!initial) load();
  }, [initial, load]);

  const toggle = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev.slice(-1), id]));

  return (
    <Panel title="version history" note={state.kind === 'ready' ? `${state.versions.length} published` : 'published versions, newest first'}>
      {state.kind === 'loading' && <p className="ops-muted">reading the history…</p>}
      {state.kind === 'error' && (
        <Notice tone="fail" title="the history could not be read">
          <p>{state.error?.message ?? 'unknown error'}</p>
        </Notice>
      )}
      {state.kind === 'ready' && state.versions.length === 0 && (
        <Empty title="nothing published yet">the first publish appears here, and every one after it.</Empty>
      )}

      {state.kind === 'ready' && state.versions.length > 0 && (
        <>
          <table className="ws-table cfg-history">
            <thead>
              <tr>
                <th aria-label="compare" />
                <th>version</th>
                <th>published</th>
                <th>how</th>
                <th>note</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {state.versions.map((version) => {
                const isCurrent = current && version.id === current.id;
                return (
                  <tr key={version.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`compare v${version.version}`}
                        checked={picked.includes(version.id)}
                        onChange={() => toggle(version.id)}
                      />
                    </td>
                    <td className="mono">
                      v{version.version} {isCurrent && <Pill tone="ok">live</Pill>}
                    </td>
                    <td className="mono">{version.published_at ? formatStamp(version.published_at, timezone) : '—'}</td>
                    <td>{version.rollback_of_version_id ? 'restored' : version.source ?? 'published'}</td>
                    <td>{version.note ?? ''}</td>
                    <td>
                      {!readOnly && !isCurrent && (
                        <ActionButton
                          icon="refresh"
                          onRun={async () => {
                            setComparison(null);
                            setRestore({ version, preview: await api.rollbackPreview(tenantId, scope, moduleKey, version.id) });
                            return null;
                          }}
                        >
                          restore…
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="ops-row" style={{ marginTop: 12 }}>
            <ActionButton
              icon="chevron"
              disabled={picked.length !== 2}
              title={picked.length !== 2 ? 'tick two versions' : undefined}
              onRun={async () => {
                const byVersion = state.versions.filter((v) => picked.includes(v.id)).sort((a, b) => a.version - b.version);
                setRestore(null);
                setComparison(await api.compare(tenantId, scope, moduleKey, byVersion[0].id, byVersion[1].id));
                return null;
              }}
            >
              compare the two ticked
            </ActionButton>
            {readOnly && current && (
              <span className="ops-muted">restore is off while a draft is open, and for a deboarded client.</span>
            )}
          </div>
        </>
      )}

      {comparison && (
        <div className="cfg-compare" aria-label="version comparison">
          <p className="cfg-compare__title">
            v{comparison.from.version} → v{comparison.to.version}: {comparison.impact.changes.length} change{comparison.impact.changes.length === 1 ? '' : 's'}
          </p>
          <ChangeTable
            changes={comparison.impact.changes}
            beforeLabel={`v${comparison.from.version}`}
            afterLabel={`v${comparison.to.version}`}
            empty="the two versions are the same."
          />
        </div>
      )}

      {restore && (
        <div className="cfg-compare" aria-label="restore preview">
          <p className="cfg-compare__title">
            restore v{restore.version.version} — published as v{(current?.version ?? 0) + 1}; v{restore.version.version} itself is not changed
          </p>
          <PublishReview preview={restore.preview} />
          <div className="ops-row" style={{ marginTop: 12 }}>
            <ActionButton
              variant="primary"
              icon="refresh"
              confirm={`restore v${restore.version.version} as the new live version?`}
              consequence={`a copy of v${restore.version.version} is published as v${(current?.version ?? 0) + 1} and becomes what new work runs on, with the effects listed above. v${restore.version.version} and every version since stay in the history — nothing is rewritten.`}
              onRun={async () => {
                const result = await api.rollback(tenantId, scope, moduleKey, restore.version.id, current.version, `restored v${restore.version.version}`);
                setRestore(null);
                await onChanged?.();
                return `published v${result.version}`;
              }}
            >
              restore as v{(current?.version ?? 0) + 1}
            </ActionButton>
            <button type="button" className="ws-btn" onClick={() => setRestore(null)}>
              cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
