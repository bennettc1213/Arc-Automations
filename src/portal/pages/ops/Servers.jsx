import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import Icon from '../../components/Icon';
import { Empty, Panel, StatCard } from '../../components/ui';
import { LivenessPill, Notice } from '../../components/ops-ui';
import { CONNECTION_KINDS, connectionLiveness } from '../../lib/ops';
import { formatCount, formatRelative } from '../../lib/format';

/**
 * everything every client is wired to, in one table.
 *
 * two columns carry the whole page. **declared** is what we said we hooked up, and
 * it is typed by a human. **observed** is what the event log says has actually run,
 * matched on workflow id. they are deliberately allowed to disagree, because the
 * disagreement is the finding: a connection marked connected that has not sent
 * anything in nine days is the row worth opening, and no amount of care typing the
 * first column would ever surface it.
 *
 * a connection with no workflow id is shown as unmatched rather than assumed
 * healthy. inferring that it is fine from the tenant's overall activity would be
 * this page quietly making something up, which is the one thing it must not do.
 */

const FILTERS = [
  { key: 'all', label: 'all' },
  { key: 'trouble', label: 'not sending' },
  { key: 'live', label: 'live' },
  { key: 'unmatched', label: 'unmatched' },
];

export default function Servers({ clients, base }) {
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');

  const rows = useMemo(() => {
    const now = DateTime.now();
    return clients
      .flatMap((client) =>
        client.connections.map((connection) => ({
          client,
          connection,
          liveness: connectionLiveness(connection, client.workflowActivity, now),
        })),
      )
      .sort((a, b) => {
        /* worst first. an operator opens this page to find what is broken, and a
           table sorted alphabetically makes them read all of it to find out. */
        const rank = { stale: 0, flaky: 1, silent: 2, unmatched: 3, live: 4 };
        return rank[a.liveness.state] - rank[b.liveness.state];
      });
  }, [clients]);

  const shown = rows.filter((row) => {
    if (kind !== 'all' && row.connection.kind !== kind) return false;
    if (filter === 'trouble') return ['stale', 'flaky', 'silent'].includes(row.liveness.state);
    if (filter === 'live') return row.liveness.state === 'live';
    if (filter === 'unmatched') return row.liveness.state === 'unmatched';
    return true;
  });

  const counts = {
    live: rows.filter((row) => row.liveness.state === 'live').length,
    trouble: rows.filter((row) => ['stale', 'flaky', 'silent'].includes(row.liveness.state)).length,
    unmatched: rows.filter((row) => row.liveness.state === 'unmatched').length,
  };

  /* declared connected, observed not sending. the one number on this page that
     should be zero, and the reason the page exists. */
  const contradictions = rows.filter(
    (row) =>
      row.connection.status === 'connected' &&
      ['stale', 'silent'].includes(row.liveness.state),
  );

  return (
    <>
      {contradictions.length > 0 && (
        <Notice
          tone="fail"
          title={`${contradictions.length} connection${
            contradictions.length === 1 ? ' is' : 's are'
          } marked connected but not sending`}
        >
          <p>
            {contradictions
              .slice(0, 4)
              .map((row) => `${row.client.tenant.name} · ${row.connection.label}`)
              .join(', ')}
            {contradictions.length > 4 && ` and ${contradictions.length - 4} more`}. either the
            workflow has stopped, or its workflow id changed and the events no longer match.
          </p>
        </Notice>
      )}

      <div className="ws-stats ws-stats--three">
        <StatCard
          label="connections declared"
          value={rows.length}
          animate
          sub={`across ${formatCount(clients.length)} client${clients.length === 1 ? '' : 's'}`}
        />
        <StatCard
          label="sending"
          value={counts.live}
          animate
          sub="an event on that workflow id in the last 48h"
        />
        <StatCard
          label="not sending"
          value={counts.trouble}
          animate
          tone={counts.trouble > 0 ? 'fail' : undefined}
          sub={counts.unmatched > 0 ? `${counts.unmatched} more cannot be checked` : 'nothing quiet'}
        />
      </div>

      <Panel title="connections & servers" note={`${shown.length} shown`} bare>
        <div className="ws-toolbar">
          <div className="ws-chips" role="group" aria-label="filter by liveness">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`ws-chip${filter === option.key ? ' is-on' : ''}`}
                onClick={() => setFilter(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="ws-select">
            <span>kind</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">all kinds</option>
              {CONNECTION_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {shown.length === 0 ? (
          <Empty title={rows.length === 0 ? 'nothing declared yet' : 'nothing matches those filters'}>
            {rows.length === 0
              ? 'open a client and record what their automation touches — the n8n instance, the twilio number, the workflow ids. this page then checks each one against the event log.'
              : 'clear the filters to see everything that is declared.'}
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th className="ws-table__wide">connection</th>
                  <th>client</th>
                  <th>kind</th>
                  <th>declared</th>
                  <th>observed</th>
                  <th>last seen</th>
                  <th className="ws-table__num">runs · 30d</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ client, connection, liveness }) => (
                  <tr
                    className={`ws-table__row${
                      connection.status === 'connected' &&
                      ['stale', 'silent'].includes(liveness.state)
                        ? ' ops-row--down'
                        : ''
                    }`}
                    key={connection.id}
                  >
                    <td>
                      <span className="ops-client">
                        <span className="ops-client__name">{connection.label}</span>
                        {connection.endpoint && (
                          <span className="ops-client__id">{connection.endpoint}</span>
                        )}
                      </span>
                    </td>
                    <td>
                      <Link className="ops-inline-link" to={`${base}/clients/${client.tenant.id}`}>
                        {client.tenant.name}
                      </Link>
                    </td>
                    <td className="ws-table__sub">
                      {CONNECTION_KINDS.find((k) => k.value === connection.kind)?.label ??
                        connection.kind}
                    </td>
                    <td className="ws-table__sub">{connection.status}</td>
                    <td>
                      <LivenessPill liveness={liveness} />
                    </td>
                    <td className="ws-table__sub">
                      {liveness.lastAt
                        ? formatRelative(liveness.lastAt, client.tenant.timezone)
                        : '—'}
                    </td>
                    <td className="ws-table__num">{formatCount(liveness.runs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="ws-note">
          <b>observed</b> is matched on <code>workflow_id</code> against the last sixty days of
          events. <b>live</b> means something ran in the last 48 hours — two days rather than one,
          because a contractor's speed-to-lead workflow can legitimately go a quiet weekend, and a
          console that cried down every monday is one you stop reading.
        </p>
      </Panel>

      <Panel title="add or edit">
        <p className="ops-muted">
          connections are declared per client, on the client's own page — that is where the
          workflow ids and the numbers live in your head, and it keeps this page as the read.
        </p>
        <div className="ops-row" style={{ marginTop: 14 }}>
          <Link className="ws-btn" to={`${base}/clients`}>
            <Icon name="clients" size={13} />
            open a client
          </Link>
        </div>
      </Panel>
    </>
  );
}
