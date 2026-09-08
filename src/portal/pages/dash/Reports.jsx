import Icon from '../../components/Icon';
import { Empty, Panel, StatCard } from '../../components/ui';
import {
  formatCount,
  formatDuration,
  formatPct,
  formatUptime,
} from '../../lib/format';

/**
 * the month-by-month view, and the way out of the product.
 *
 * two deliberate choices here. months only partly covered by the loaded window are labelled
 * partial rather than hidden — hiding them makes the table look like those months did not
 * happen, and labelling them lets someone read the number knowing exactly how much of the
 * month is behind it. and the export is a real csv of real rows, because a client's own
 * lead history is theirs and a portal that will not hand it back is a hostage situation
 * with a nice chart on it.
 */

export default function Reports({ data, onExport }) {
  const { monthly, deltas, routing, metrics, threads, threadTotal } = data;

  return (
    <>
      <div className="ws-stats ws-stats--three">
        <StatCard
          label="leads · last 30 days"
          value={formatCount(metrics.leadsLast30Days)}
          delta={deltas.leads}
          deltaLabel={deltas.periodLabel}
          tone="lead"
        />
        <StatCard
          label="median response"
          value={formatDuration(metrics.medianResponseMs)}
          delta={deltas.medianResponseMs}
          deltaLabel={deltas.periodLabel}
          sub="lower is better"
        />
        <StatCard
          label="missed calls answered"
          value={formatCount(metrics.missedCallsAnswered)}
          delta={deltas.missedCallsAnswered}
          deltaLabel={deltas.periodLabel}
        />
      </div>

      <Panel title="by month" note={`${monthly.length} months in the loaded window`} bare>
        {monthly.length === 0 ? (
          <Empty title="not enough history yet">
            month rollups appear once there is a full month of events behind them.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>month</th>
                  <th className="ws-table__num">leads</th>
                  <th className="ws-table__num">missed calls answered</th>
                  <th className="ws-table__num">texts sent</th>
                  <th className="ws-table__num">median response</th>
                  <th className="ws-table__num">uptime</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((month) => (
                  <tr key={month.key}>
                    <td className="ws-table__strong">
                      {month.label}
                      {month.partial && (
                        <span className="ws-table__sub">
                          {month.inProgress ? 'in progress' : 'window starts mid-month'}
                        </span>
                      )}
                    </td>
                    <td className="ws-table__num mono">{formatCount(month.leads)}</td>
                    <td className="ws-table__num mono">{formatCount(month.missedCallsAnswered)}</td>
                    <td className="ws-table__num mono">{formatCount(month.sends)}</td>
                    <td className="ws-table__num mono">{formatDuration(month.medianResponseMs)}</td>
                    <td className="ws-table__num mono">{formatUptime(month.uptimePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!deltas.comparable && (
          <p className="ws-note">
            period-over-period comparisons are held back until there is a full previous window
            to compare against. a percentage measured against a half-empty period is worse than
            no percentage at all.
          </p>
        )}
      </Panel>

      <div className="ws-two">
        <Panel title="where the work went" note="30d">
          {routing.length === 0 ? (
            <Empty title="no routed leads in the window" />
          ) : (
            <ul className="ws-bars">
              {routing.map((row) => (
                <li key={row.tech}>
                  <span className="ws-bars__label">{row.tech}</span>
                  <span className="ws-bars__track">
                    <i style={{ width: `${Math.max(2, row.pct)}%` }} />
                  </span>
                  <span className="ws-bars__val mono">
                    {row.count} · {formatPct(row.pct, 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="ws-note">
            counted from the routing step, so this is who the lead was sent to — not who ended
            up doing the job. the portal has no booking data and does not pretend to.
          </p>
        </Panel>

        <Panel title="export">
          <p className="ws-panel__body">
            every loaded lead as a csv: received time in your timezone, customer, phone, source,
            loss type, response seconds, who it was routed to, whether they replied, and the
            failure reason where there was one. it opens in excel and sheets without a fight.
          </p>

          <button type="button" className="ws-btn ws-btn--primary" onClick={onExport}>
            <Icon name="download" />
            export {formatCount(threads.length)} leads
          </button>

          <p className="ws-note">
            {formatCount(threads.length)} of {formatCount(threadTotal)} leads in the window are
            loaded in the browser. need the full history, or a different window? ask and we will
            send it.
          </p>
        </Panel>
      </div>

      <Panel title="what these numbers are not">
        <p className="ws-panel__body">
          there is no revenue figure on this page and no conversion rate, because the pipeline
          does not see either one. it sees that a lead arrived, that a text went out, how long
          that took, and whether the customer wrote back. attributing a booked job to a text
          message would need data this system does not have, and a number we cannot defend
          takes every number next to it down with it.
        </p>
      </Panel>
    </>
  );
}
