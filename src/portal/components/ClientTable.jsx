import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { Empty } from './ui';
import { TenantStatus, PipelineStatus } from './ops-ui';
import { formatCount, formatDuration, formatRelative } from '../lib/format';

/**
 * the roster, as a table.
 *
 * one implementation shared by the overview and the clients page, because they
 * are the same list with a different filter above it. every column is read off
 * the same per-client dashboard the client themselves sees, so a figure here
 * cannot disagree with the figure behind their sign-in.
 *
 * the row highlight is the argument the page is making. a client is flagged for
 * one of three reasons and each one is a different colour on the left edge:
 * their pipeline is failing, they are live but have gone quiet, or they cannot
 * sign in yet. everything else is left plain — a table where every row is
 * highlighted has said nothing.
 */

/* ordered by what you would act on first, and it stops at the first hit: a client
   whose pipeline is down does not also need to be told their client id is not
   wired up yet. one row, one reason, the most urgent one. */
export function attentionFor(client) {
  if (client.data.status.status === 'failed') {
    return { level: 'down', why: 'the last end-to-end check failed' };
  }
  if (client.tenant.status === 'active' && client.eventCount === 0) {
    return { level: 'attention', why: 'live, but has never sent an event' };
  }
  if (!client.tenant.loginEmail) {
    return { level: 'attention', why: 'no sign-in address — the client id will not work yet' };
  }
  if (client.data.status.status === 'degraded') {
    return { level: 'attention', why: 'a recent check failed and the next one passed' };
  }
  return null;
}

export default function ClientTable({ clients, base, dense = false, emptyTitle, emptyBody }) {
  const navigate = useNavigate();

  if (clients.length === 0) {
    return (
      <Empty title={emptyTitle ?? 'no clients yet'}>
        {emptyBody ?? 'the first client you add will appear here with their live numbers attached.'}
      </Empty>
    );
  }

  return (
    <div className="ws-tablewrap">
      <table className={`ws-table${dense ? ' ws-table--dense' : ''}`}>
        <thead>
          <tr>
            <th className="ws-table__wide">client</th>
            <th>account</th>
            <th>pipeline</th>
            <th className="ws-table__num">leads · 30d</th>
            <th className="ws-table__num">median reply</th>
            <th>last event</th>
            <th className="ws-table__num">wired</th>
            <th aria-label="open" />
          </tr>
        </thead>

        <tbody>
          {clients.map((client) => {
            const { tenant, data } = client;
            const attention = attentionFor(client);
            const live = client.connections.filter((c) => c.status === 'connected').length;

            return (
              <tr
                key={tenant.id}
                className={`ws-table__row${attention ? ` ops-row--${attention.level}` : ''}`}
                onClick={() => navigate(`${base}/clients/${tenant.id}`)}
                style={{ cursor: 'pointer' }}
                title={attention?.why}
              >
                <td>
                  <span className="ops-client">
                    <span className="ops-client__name">{tenant.name}</span>
                    <span className="ops-client__id">{tenant.clientId ?? 'no client id'}</span>
                  </span>
                </td>

                <td>
                  <TenantStatus status={tenant.status} />
                </td>

                <td>
                  <PipelineStatus status={data.status} />
                </td>

                <td className="ws-table__num ws-table__strong">
                  {formatCount(data.metrics.leadsLast30Days)}
                </td>

                <td className="ws-table__num">
                  {data.metrics.medianResponseMs === null
                    ? '—'
                    : formatDuration(data.metrics.medianResponseMs)}
                </td>

                <td className="ws-table__sub">
                  {client.lastEventAt ? formatRelative(client.lastEventAt, tenant.timezone) : 'never'}
                </td>

                <td className="ws-table__num">
                  {client.connections.length === 0 ? '—' : `${live}/${client.connections.length}`}
                </td>

                <td className="ws-table__chev">
                  <Icon name="chevron" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
