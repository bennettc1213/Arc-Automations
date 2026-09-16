import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import ReportDialog from './ReportDialog';
import { Empty } from './ui';
import { Help, PipelinePill, TenantStatus } from './ops-ui';
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
 *
 * every row carries its own "generate report" button, which opens the report
 * builder over the page instead of navigating. the dialog is mounted beside the
 * table rather than inside the row, so a click inside it can never bubble into
 * the row's own click and open the client page underneath.
 */

/* ordered by what you would act on first, and it stops at the first hit: a client
   whose pipeline is down does not also need to be told their client id is not
   wired up yet. one row, one reason, the most urgent one.

   the pipeline verdict leads, because it is the live answer: it already folds in
   the end-to-end check, the tokens, the last event and — when n8n can be asked —
   whether the workflows are switched on. the event-log reasons below it only
   decide when there is no verdict yet. */
export function attentionFor(client) {
  const verdict = client.pipeline;
  if (verdict?.state === 'disconnected') {
    return { level: 'down', why: `not connected — ${verdict.summary}` };
  }
  if (client.data.status.status === 'failed') {
    return { level: 'down', why: 'the last end-to-end check failed' };
  }
  if (client.tenant.status === 'active' && client.eventCount === 0) {
    return { level: 'attention', why: 'marked active, but has never sent an event' };
  }
  if (verdict?.state === 'partial') {
    return { level: 'attention', why: `partly connected — ${verdict.summary}` };
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
  /* held by id, not by object: a roster reload hands down new client objects, and
     the open dialog should follow the fresh one rather than keep a stale copy. */
  const [reportId, setReportId] = useState(null);
  const reportClient = reportId ? clients.find((client) => client.tenant.id === reportId) : null;

  if (clients.length === 0) {
    return (
      <Empty title={emptyTitle ?? 'no clients yet'}>
        {emptyBody ?? 'the first client you add will appear here with their live numbers attached.'}
      </Empty>
    );
  }

  return (
    <>
      <div className="ws-tablewrap">
        <table className={`ws-table${dense ? ' ws-table--dense' : ''}`}>
          <thead>
            <tr>
              <th className="ws-table__wide">client</th>
              <th>
                account
                <Help>
                  what you set on the client: onboarding, active or paused. it is a label you
                  choose — it does not check anything.
                </Help>
              </th>
              <th>
                pipeline
                <Help>
                  checked live, every few minutes: the ingest endpoint answers, the client has a
                  token n8n is using, events are still arriving, and their n8n workflows are
                  switched on. hover a row&rsquo;s pill for the reason.
                </Help>
              </th>
              <th className="ws-table__num">leads · 30d</th>
              <th className="ws-table__num">
                median reply
                <Help>half of this client&rsquo;s leads got a text back faster than this.</Help>
              </th>
              <th>last event</th>
              <th className="ws-table__num">
                connected
                <Help>
                  connections marked connected, out of all the services recorded for this client.
                </Help>
              </th>
              <th aria-label="report" />
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
                  <td className="ws-td--customer">
                    <span className="ops-client">
                      <span className="ops-client__name">{tenant.name}</span>
                      <span className="ops-client__id">{tenant.clientId ?? 'no client id'}</span>
                    </span>
                  </td>

                  <td className="ws-td--source">
                    <TenantStatus status={tenant.status} />
                  </td>

                  <td className="ws-td--loss">
                    <PipelinePill verdict={client.pipeline} />
                  </td>

                  <td className="ws-table__num ws-table__strong ws-td--response" data-label="leads 30d">
                    {formatCount(data.metrics.leadsLast30Days)}
                  </td>

                  <td className="ws-table__num ws-td--outcome" data-label="median">
                    {data.metrics.medianResponseMs === null
                      ? '—'
                      : formatDuration(data.metrics.medianResponseMs)}
                  </td>

                  <td className="ws-table__sub ws-td--time" data-label="last event">
                    {client.lastEventAt ? formatRelative(client.lastEventAt, tenant.timezone) : 'never'}
                  </td>

                  <td className="ws-table__num ws-td--tech" data-label="wired">
                    {client.connections.length === 0 ? '—' : `${live}/${client.connections.length}`}
                  </td>

                  <td className="ws-td--report ops-report-cell">
                    <button
                      type="button"
                      className="ws-btn ops-report-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        setReportId(tenant.id);
                      }}
                      title={`build a pdf report for ${tenant.name}`}
                    >
                      <Icon name="reports" size={13} />
                      generate report
                    </button>
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

      {reportClient && <ReportDialog client={reportClient} onClose={() => setReportId(null)} />}
    </>
  );
}
