import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Panel } from '../../components/ui';
import ClientTable, { attentionFor } from '../../components/ClientTable';
import { downloadCsv, toCsv } from '../../lib/csv';
import { formatCount, formatDuration } from '../../lib/format';

/**
 * every client, filterable.
 *
 * the same table the roster shows, with the filters that make it useful once there
 * are more accounts than fit on a screen. "needs attention" is a filter rather than
 * a separate page, because the answer to "which ones need me" and the answer to
 * "show me everyone" should be the same list looked at two ways — a second page
 * would be a second definition of attention, and they would diverge.
 */

const STATUSES = [
  { key: 'all', label: 'all' },
  { key: 'active', label: 'active' },
  { key: 'onboarding', label: 'onboarding' },
  { key: 'paused', label: 'paused' },
  { key: 'archived', label: 'archived' },
];

const SORTS = {
  leads: {
    label: 'most leads',
    compare: (a, b) => b.data.metrics.leadsLast30Days - a.data.metrics.leadsLast30Days,
  },
  name: { label: 'name', compare: (a, b) => a.tenant.name.localeCompare(b.tenant.name) },
  newest: {
    label: 'newest',
    compare: (a, b) => String(b.tenant.createdAt).localeCompare(String(a.tenant.createdAt)),
  },
  slowest: {
    /* nulls last, not first. a client with no measurable response time has not
       got the slowest one — they have none, and sorting them to the top of
       "slowest" would be the table telling a lie about them. */
    label: 'slowest reply',
    compare: (a, b) =>
      (b.data.metrics.medianResponseMs ?? -Infinity) - (a.data.metrics.medianResponseMs ?? -Infinity),
  },
};

export default function Clients({ clients, base }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sort, setSort] = useState('leads');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();

    return clients
      .filter((client) => {
        if (status !== 'all' && client.tenant.status !== status) return false;
        if (onlyFlagged && !attentionFor(client)) return false;
        if (!q) return true;
        return [
          client.tenant.name,
          client.tenant.company,
          client.tenant.slug,
          client.tenant.clientId,
          client.tenant.loginEmail,
          client.tenant.contactName,
        ].some((field) => String(field ?? '').toLowerCase().includes(q));
      })
      .sort(SORTS[sort].compare);
  }, [clients, query, status, onlyFlagged, sort]);

  const flaggedCount = clients.filter(attentionFor).length;

  /* the export is what a client list is actually for once a month: reconciling the
     book against invoicing. it exports the rows on screen, filters and all — an
     export that quietly ignored the filters above it would hand over a spreadsheet
     that did not match the table it was clicked from. */
  function exportRows() {
    downloadCsv(
      `arc-clients-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
          'client id',
          'name',
          'company',
          'status',
          'pipeline',
          'timezone',
          'leads 30d',
          'median reply',
          'sign-in address',
          'contact',
          'phone',
          'created',
        ],
        rows.map((client) => [
          client.tenant.clientId ?? '',
          client.tenant.name,
          client.tenant.company ?? '',
          client.tenant.status,
          client.data.status.status,
          client.tenant.timezone,
          client.data.metrics.leadsLast30Days,
          client.data.metrics.medianResponseMs === null
            ? ''
            : formatDuration(client.data.metrics.medianResponseMs),
          client.tenant.loginEmail ?? '',
          client.tenant.contactName ?? '',
          client.tenant.contactPhone ?? '',
          client.tenant.createdAt,
        ]),
      ),
    );
  }

  return (
    <Panel
      title="clients"
      note={
        rows.length === clients.length
          ? `${formatCount(clients.length)} account${clients.length === 1 ? '' : 's'}`
          : `${formatCount(rows.length)} of ${formatCount(clients.length)}`
      }
      actions={
        <>
          <button type="button" className="ws-btn" onClick={exportRows} disabled={rows.length === 0}>
            <Icon name="download" />
            export {formatCount(rows.length)}
          </button>
          <Link className="ws-btn ws-btn--primary" to={`${base}/clients/new`}>
            <Icon name="plus" size={13} />
            add a client
          </Link>
        </>
      }
      bare
    >
      <div className="ws-toolbar">
        <label className="ws-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="name, company, client id or address"
            aria-label="filter clients"
            spellCheck="false"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} title="clear">
              <Icon name="close" size={12} />
            </button>
          )}
        </label>

        <div className="ws-chips" role="group" aria-label="filter by account status">
          {STATUSES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`ws-chip${status === option.key ? ' is-on' : ''}`}
              onClick={() => setStatus(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="ws-chips">
          <button
            type="button"
            className={`ws-chip${onlyFlagged ? ' is-on' : ''}`}
            onClick={() => setOnlyFlagged((value) => !value)}
            disabled={flaggedCount === 0}
            title={flaggedCount === 0 ? 'nothing is flagged' : 'only clients that need looking at'}
          >
            needs attention
            {flaggedCount > 0 && <em>{flaggedCount}</em>}
          </button>
        </div>

        <label className="ws-select">
          <span>sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {Object.entries(SORTS).map(([key, option]) => (
              <option key={key} value={key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ClientTable
        clients={rows}
        base={base}
        emptyTitle={clients.length === 0 ? 'no clients yet' : 'nothing matches those filters'}
        emptyBody={
          clients.length === 0
            ? 'add the first one and their numbers appear here as soon as the pipeline sends an event.'
            : 'clear the filters above to see the full roster.'
        }
      />
    </Panel>
  );
}
