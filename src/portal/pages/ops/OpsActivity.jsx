import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty, Panel, Pill } from '../../components/ui';
import { formatCount, formatDuration, formatStamp, eventLabel } from '../../lib/format';

/**
 * every run across every client, newest first.
 *
 * the raw log rather than the threaded feed, on purpose. a client's activity page
 * threads events into leads because that is what happened from their side; this
 * page is the operator's, and the operator is looking for the failure, the canary
 * and the workflow that has gone quiet — all of which are exactly the rows the
 * threading hides.
 *
 * canaries are shown, and labelled. they traverse the live pipeline and emit real
 * events, so they are excluded from every client-facing number in the product —
 * but they are the thing that proves the pipeline works, so hiding them from the
 * console would remove the evidence from the one page that wants it.
 */

const FILTERS = [
  { key: 'all', label: 'everything' },
  { key: 'failures', label: 'failures' },
  { key: 'leads', label: 'leads' },
  { key: 'canary', label: 'canaries' },
];

const PAGE = 80;

export default function OpsActivity({ roster, clients, base }) {
  const [filter, setFilter] = useState('all');
  const [tenantId, setTenantId] = useState('all');
  const [shown, setShown] = useState(PAGE);

  const events = roster.recentEvents ?? [];

  const rows = useMemo(
    () =>
      events.filter((event) => {
        if (tenantId !== 'all' && event.tenantId !== tenantId) return false;
        if (filter === 'failures') return event.status === 'failure';
        if (filter === 'leads') return event.eventType === 'lead_received' && !event.isCanary;
        if (filter === 'canary') return event.isCanary || event.eventType.startsWith('canary');
        return true;
      }),
    [events, filter, tenantId],
  );

  const failures = events.filter((event) => event.status === 'failure').length;

  return (
    <Panel
      title="activity"
      note={
        rows.length === events.length
          ? `newest ${formatCount(events.length)} of ${formatCount(roster.totalEvents ?? events.length)} in the window`
          : `${formatCount(rows.length)} matching`
      }
      bare
    >
      <div className="ws-toolbar">
        <div className="ws-chips" role="group" aria-label="filter events">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`ws-chip${filter === option.key ? ' is-on' : ''}`}
              onClick={() => {
                setFilter(option.key);
                setShown(PAGE);
              }}
              disabled={option.key === 'failures' && failures === 0}
            >
              {option.label}
              {option.key === 'failures' && failures > 0 && <em>{failures}</em>}
            </button>
          ))}
        </div>

        <label className="ws-select">
          <span>client</span>
          <select
            value={tenantId}
            onChange={(event) => {
              setTenantId(event.target.value);
              setShown(PAGE);
            }}
          >
            <option value="all">every client</option>
            {clients.map((client) => (
              <option key={client.tenant.id} value={client.tenant.id}>
                {client.tenant.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <Empty title={events.length === 0 ? 'no events in the window' : 'nothing matches those filters'}>
          {events.length === 0
            ? 'nothing has been posted to the ingest endpoint in the last sixty days. if a workflow is meant to be running, that is the thing to chase.'
            : 'clear the filters to see the whole tail.'}
        </Empty>
      ) : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense">
            <thead>
              <tr>
                <th>when</th>
                <th className="ws-table__wide">what happened</th>
                <th>client</th>
                <th>workflow</th>
                <th>result</th>
                <th className="ws-table__num">latency</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((event) => (
                <tr className="ws-table__row" key={event.id}>
                  <td className="ws-table__sub mono">
                    {formatStamp(event.occurredAt, event.tenantTimezone)}
                  </td>
                  <td>
                    <span className="ops-client">
                      <span className="ops-client__name">
                        {eventLabel(event.eventType, event.payload)}
                      </span>
                      {event.isCanary && <span className="ops-client__id">synthetic check</span>}
                    </span>
                  </td>
                  <td>
                    <Link className="ops-inline-link" to={`${base}/clients/${event.tenantId}`}>
                      {event.tenantName}
                    </Link>
                  </td>
                  <td className="ws-table__sub mono">{event.workflowId ?? '—'}</td>
                  <td>
                    <Pill tone={event.status === 'failure' ? 'fail' : 'ok'}>
                      {event.status === 'failure' ? 'failed' : 'ok'}
                    </Pill>
                  </td>
                  <td className="ws-table__num">
                    {event.latencyMs === null ? '—' : formatDuration(event.latencyMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown < rows.length && (
        <div className="ws-more">
          <button type="button" className="ws-btn" onClick={() => setShown((n) => n + PAGE)}>
            <Icon name="chevron" size={13} />
            show {Math.min(PAGE, rows.length - shown)} more
          </button>
          <span className="mono">
            {formatCount(shown)} of {formatCount(rows.length)}
          </span>
        </div>
      )}

      <p className="ws-note">
        the newest {formatCount(events.length)} events across the whole book, so this is a tail
        rather than an archive. a client's full log — threaded, filtered and exportable — is on
        their own activity page.
      </p>
    </Panel>
  );
}
