import { Link } from 'react-router-dom';
import { Panel, StatCard, Sparkline, Empty } from '../../components/ui';
import { Notice } from '../../components/ops-ui';
import ClientTable, { attentionFor } from '../../components/ClientTable';
import Icon from '../../components/Icon';
import { formatCount, formatDuration, formatRelative } from '../../lib/format';

/**
 * the whole book on one screen.
 *
 * the page opens on what is wrong rather than on what is total, because a console
 * with nothing wrong should be boring and a console with something wrong should
 * say so before anything else. the totals sit underneath that, and the full
 * roster underneath them.
 *
 * the median response figure is labelled "median of medians" every single time it
 * appears. it is the middle client's median, not the middle lead's — those are
 * different numbers, and printing the first while implying the second is the exact
 * species of quiet wrongness this product exists to rule out.
 */
export default function Roster({ clients, totals, base }) {
  const flagged = clients
    .map((client) => ({ client, attention: attentionFor(client) }))
    .filter((row) => row.attention);

  /* leads per day across the book, summed day by day. the per-client series are
     already aligned to the same thirty buckets, so this is a real sum rather than
     an average of shapes. */
  const combined = clients.length
    ? clients[0].data.leadsPerDay.map((_, index) =>
        clients.reduce((sum, client) => sum + (client.data.leadsPerDay[index]?.leads ?? 0), 0),
      )
    : [];

  const busiest = [...clients]
    .filter((client) => client.data.metrics.leadsLast30Days > 0)
    .sort((a, b) => b.data.metrics.leadsLast30Days - a.data.metrics.leadsLast30Days)
    .slice(0, 5);

  return (
    <>
      {flagged.length > 0 && (
        <Panel title="needs looking at" note={`${flagged.length} of ${totals.clients}`}>
          <ul className="ws-list">
            {flagged.map(({ client, attention }) => (
              <li key={client.tenant.id}>
                <Icon name={attention.level === 'down' ? 'warn' : 'reliability'} />
                <span className="ws-list__label">
                  <Link className="ops-inline-link" to={`${base}/clients/${client.tenant.id}`}>
                    {client.tenant.name}
                  </Link>{' '}
                  <span style={{ color: 'var(--muted)' }}>— {attention.why}</span>
                </span>
                <span className="ws-list__val mono">
                  {client.lastEventAt
                    ? formatRelative(client.lastEventAt, client.tenant.timezone)
                    : 'no events'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {clients.length === 0 && (
        <Notice tone="warn" title="no clients in the database yet">
          <p>
            this console reads <code>public.tenants</code>. add the first client and everything on
            these pages fills in from the event log behind them.
          </p>
          <p style={{ marginTop: 8 }}>
            <Link className="ops-inline-link" to={`${base}/clients/new`}>
              add a client →
            </Link>
          </p>
        </Notice>
      )}

      <div className="ws-stats">
        <StatCard
          label="clients"
          value={totals.clients}
          animate
          sub={`${totals.active} active · ${totals.onboarding} onboarding${
            totals.paused ? ` · ${totals.paused} paused` : ''
          }`}
        />

        <StatCard
          label="leads · 30d"
          value={totals.leads}
          animate
          format={formatCount}
          tone="lead"
          sub={`${formatCount(totals.leadsThisMonth)} this calendar month`}
        >
          <Sparkline points={combined} />
        </StatCard>

        <StatCard
          label="median of medians"
          value={totals.medianOfMedians === null ? '—' : formatDuration(totals.medianOfMedians)}
          compact
          sub="the middle active client's median reply — not the middle lead's"
        />

        <StatCard
          label="pipelines down"
          value={totals.degraded}
          animate
          tone={totals.degraded > 0 ? 'fail' : undefined}
          sub={
            totals.openIncidents > 0
              ? `${formatCount(totals.openIncidents)} open incident${totals.openIncidents === 1 ? '' : 's'}`
              : 'no open incidents'
          }
        />
      </div>

      <div className="ws-two">
        <Panel
          title="the roster"
          note={`${totals.clients} account${totals.clients === 1 ? '' : 's'}`}
          bare
          actions={
            <Link className="ws-btn ws-btn--primary" to={`${base}/clients/new`}>
              <Icon name="plus" size={13} /> add a client
            </Link>
          }
        >
          <ClientTable clients={clients} base={base} dense />
        </Panel>

        <Panel title="busiest, 30d" note="by leads received">
          {busiest.length === 0 ? (
            <Empty title="no leads in the window">
              nothing has come through for any client in the last thirty days. that is either a
              very quiet month or a pipeline that is not sending.
            </Empty>
          ) : (
            <ul className="ws-bars">
              {busiest.map((client) => {
                const top = busiest[0].data.metrics.leadsLast30Days;
                const pct = top > 0 ? (client.data.metrics.leadsLast30Days / top) * 100 : 0;
                return (
                  <li key={client.tenant.id}>
                    <span className="ws-bars__label">
                      <Link className="ops-inline-link" to={`${base}/clients/${client.tenant.id}`}>
                        {client.tenant.name}
                      </Link>
                    </span>
                    <span className="ws-bars__track">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                    <span className="ws-bars__val mono">
                      {formatCount(client.data.metrics.leadsLast30Days)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="ws-note">
            every figure on this page is computed by the same code that computes the figure the
            client sees behind their own sign-in. there is one derivation chain, so the console and
            the dashboard cannot disagree.
          </p>
        </Panel>
      </div>
    </>
  );
}
