import { useCallback, useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { Empty, Panel, Pill } from '../../components/ui';
import { Notice } from '../../components/ops-ui';
import { fetchAdminActions } from '../../lib/ops';
import { formatCount, formatStamp } from '../../lib/format';

/**
 * who did what, and when.
 *
 * read-only by construction, not by convention. `admin_actions` has a select
 * policy for admins and no insert policy for `authenticated` at all — rows get
 * in only through the service role inside an edge function — and there is no
 * update policy and no delete policy for anyone. RLS denies by default, so the
 * absence of those two policies is what makes the table append-only. Nothing on
 * this page could edit a row even if somebody wanted it to.
 *
 * Today the console's blast radius is small enough that this is hygiene. It stops
 * being hygiene in Phase 2, when the same password can provision n8n workflows
 * and handle client credentials — an admin surface that can do that with no
 * record of who did it is a liability rather than a gap. It lands before that
 * work, not after it.
 */

/* the verbs the edge functions write. anything not listed still renders — the
   action column is free text on purpose, so a new verb is never invisible here
   just because this map has not caught up. */
const ACTION_TONE = {
  'client.linked': 'ok',
  'client.unlinked': 'warn',
  'alert.raised': 'fail',
  'alert.acknowledged': 'neutral',
  'alert.resolved': 'ok',
};

export default function AuditLog() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await fetchAdminActions());
    } catch (caught) {
      setRows([]);
      setError(caught.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const actions = useMemo(
    () => ['all', ...new Set((rows ?? []).map((row) => row.action))],
    [rows],
  );

  const shown = (rows ?? []).filter((row) => filter === 'all' || row.action === filter);

  /* a missing table is the normal state until migration 0004 is applied, and it
     has a specific fix. saying so beats a raw postgres error string. */
  const missing = error && /relation .*admin_actions|does not exist|schema cache/i.test(error);

  return (
    <>
      {missing ? (
        <Notice tone="warn" title="the audit table is not there yet">
          run <code>supabase/migrations/0004_audit_log.sql</code> against the project. until it
          exists the edge functions still work — the audit write is deliberately non-blocking,
          so an action never fails because logging did — but nothing is being recorded, and
          their responses come back with <code>logged: false</code>.
        </Notice>
      ) : (
        error && <Notice tone="fail" title="could not read the log">{error}</Notice>
      )}

      <Panel
        title="operator actions"
        note={rows === null ? 'loading…' : `${formatCount(shown.length)} of ${formatCount(rows.length)}`}
        actions={
          <button type="button" className="ws-btn" onClick={load}>
            reload
          </button>
        }
        bare
      >
        {actions.length > 2 && (
          <div className="ws-toolbar">
            <div className="ws-chips" role="group" aria-label="filter by action">
              {actions.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`ws-chip${filter === key ? ' is-on' : ''}`}
                  onClick={() => setFilter(key)}
                >
                  {key === 'all' ? 'everything' : key}
                </button>
              ))}
            </div>
          </div>
        )}

        {rows === null ? null : shown.length === 0 ? (
          <Empty title="nothing recorded yet">
            every action that changes something — linking a client, raising or resolving an
            alert — writes a row here from inside the edge function, so it cannot be skipped by
            anything running in a browser. an empty log means nothing has been done since the
            table was created, not that the log is off.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th>when</th>
                  <th>action</th>
                  <th>target</th>
                  <th>details</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">
                      {formatStamp(row.occurredAt, DateTime.local().zoneName)}
                    </td>
                    <td>
                      <Pill tone={ACTION_TONE[row.action] ?? 'neutral'}>{row.action}</Pill>
                    </td>
                    <td className="mono">
                      {row.targetType ? (
                        <>
                          {row.targetType}
                          <span className="ws-table__sub mono">{row.targetId}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="ws-table__wide mono">
                      {Object.keys(row.metadata).length === 0
                        ? '—'
                        : Object.entries(row.metadata)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="ws-note">
          append-only, and enforced rather than promised: there is no update policy and no
          delete policy on this table for any role. the actor is read from the caller&rsquo;s
          verified token inside the function, never from anything the caller sent.
        </p>
      </Panel>
    </>
  );
}
