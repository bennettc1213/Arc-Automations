import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import Icon from '../../components/Icon';
import ReportDialog from '../../components/ReportDialog';
import { Empty, Panel, StatCard } from '../../components/ui';
import { ActionButton, Notice } from '../../components/ops-ui';
import { restoreClient } from '../../lib/ops';
import { formatCount, formatDate, formatRelative, formatSpan } from '../../lib/format';

/**
 * everyone who used to be a client.
 *
 * a deboarded client leaves the roster, the totals and the live check — they are
 * not on the books, and a "not connected" pill about somebody whose tokens we
 * revoked on purpose would be the console crying wolf. but they are not gone. the
 * events that prove what the service did for them are all still there, so this
 * page keeps the record: when they left, why, how long they were with arc, and a
 * report built from their real history for the conversation that sometimes comes
 * a year later.
 *
 * restore is here as well as on the client's own page, and deliberately modest:
 * it puts them back on the books as paused and nothing more. their old tokens
 * stay dead and nobody regains access by accident.
 */
export default function PastClients({ pastClients, base, reload }) {
  const navigate = useNavigate();
  const [reportId, setReportId] = useState(null);
  const reportClient = reportId ? pastClients.find((client) => client.tenant.id === reportId) : null;

  const now = DateTime.now();
  const recent = pastClients.filter(
    (client) =>
      client.tenant.archivedAt &&
      now.diff(DateTime.fromISO(client.tenant.archivedAt, { zone: 'utc' }), 'days').days <= 90,
  );

  const reasons = new Map();
  for (const client of pastClients) {
    const reason = client.tenant.archiveReason ?? 'no reason recorded';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];

  const undated = pastClients.filter((client) => !client.tenant.archivedAt).length;

  return (
    <>
      <div className="ws-stats ws-stats--three">
        <StatCard
          label="past clients"
          value={pastClients.length}
          animate
          sub="deboarded — history kept, access removed"
        />
        <StatCard
          label="left in the last 90 days"
          value={recent.length}
          animate
          sub={recent.length ? `most recently ${recent[0].tenant.name}` : 'nobody recently'}
        />
        <StatCard
          label="most common reason"
          value={topReason ? topReason[0] : '—'}
          compact
          sub={topReason ? `${topReason[1]} of ${pastClients.length}` : 'no past clients yet'}
        />
      </div>

      {undated > 0 && (
        <Notice tone="warn" title={`${undated} archived without a date`}>
          <p>
            {undated === 1 ? 'this client was' : 'these clients were'} archived by hand before
            deboarding existed, or migration <code>0007_client_offboarding.sql</code> has not been
            applied. their tokens may still be valid — open each one and check the ingest tokens
            panel.
          </p>
        </Notice>
      )}

      <Panel
        title="past clients"
        note={`${formatCount(pastClients.length)} account${pastClients.length === 1 ? '' : 's'}`}
        bare
      >
        {pastClients.length === 0 ? (
          <Empty title="no past clients">
            when an engagement ends, open the client and use <b>deboard this client</b> at the foot
            of their page. it cuts off their pipeline and their sign-in, and moves them here with
            their history intact.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th className="ws-table__wide">client</th>
                  <th>left</th>
                  <th>why</th>
                  <th>with arc</th>
                  <th>last event</th>
                  <th aria-label="actions" />
                  <th aria-label="open" />
                </tr>
              </thead>
              <tbody>
                {pastClients.map((client) => {
                  const { tenant } = client;
                  const started = tenant.onboardedAt ?? tenant.createdAt;
                  const tenure =
                    tenant.archivedAt && started
                      ? DateTime.fromISO(tenant.archivedAt, { zone: 'utc' }).diff(
                          DateTime.fromISO(started, { zone: 'utc' }),
                        ).milliseconds
                      : null;

                  return (
                    <tr
                      key={tenant.id}
                      className="ws-table__row"
                      onClick={() => navigate(`${base}/clients/${tenant.id}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span className="ops-client">
                          <span className="ops-client__name">{tenant.name}</span>
                          <span className="ops-client__id">{tenant.clientId ?? 'no client id'}</span>
                        </span>
                      </td>
                      <td className="ws-table__sub">
                        {tenant.archivedAt ? formatDate(tenant.archivedAt, tenant.timezone) : 'undated'}
                      </td>
                      <td>
                        <span className="ops-client">
                          <span>{tenant.archiveReason ?? '—'}</span>
                          {tenant.archiveNote && (
                            <span className="ops-client__id" title={tenant.archiveNote}>
                              {tenant.archiveNote}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="ws-table__sub">
                        {tenure === null ? '—' : formatSpan(tenure).replace(/ 0h$/, '')}
                      </td>
                      <td className="ws-table__sub">
                        {client.lastEventAt
                          ? formatRelative(client.lastEventAt, tenant.timezone)
                          : 'none in 61 days'}
                      </td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="ops-row">
                          <button
                            type="button"
                            className="ws-btn"
                            onClick={() => setReportId(tenant.id)}
                            title={`build a pdf report from ${tenant.name}'s history`}
                          >
                            <Icon name="reports" size={13} />
                            report
                          </button>
                          <ActionButton
                            icon="refresh"
                            confirm={`restore ${tenant.name} as a paused client? their old tokens stay revoked and nobody regains access until you mint a token and link the account.`}
                            onRun={async () => {
                              await restoreClient(tenant.id, 'paused');
                              await reload();
                            }}
                          >
                            restore
                          </ActionButton>
                        </div>
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
        )}

        <p className="ws-note">
          a past client is out of every total, the live pipeline check and the alert count. their
          events are untouched, so their own page still shows the numbers they had and a report
          covers any period they were with us.{' '}
          <Link className="ops-inline-link" to={`${base}/clients`}>
            current clients →
          </Link>
        </p>
      </Panel>

      {reportClient && <ReportDialog client={reportClient} onClose={() => setReportId(null)} />}
    </>
  );
}
