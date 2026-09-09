import EarlyData from '../../components/EarlyData';
import { Empty, Panel, Pill, StatCard } from '../../components/ui';
import { formatCount, formatDuration, formatPct, formatRelative, formatStamp } from '../../lib/format';

/**
 * what is actually running for this client.
 *
 * every figure on this page is counted from the run log, never from a catalogue. the
 * descriptions are written by us; the numbers are not, and that split is the whole point —
 * "speed to lead: healthy" written by hand is marketing, and "speed to lead: 99 runs, 0
 * failures, last run 4 minutes ago" is a fact.
 *
 * the monitoring workflows are listed too, in their own section. a client paying for this
 * should be able to see the thing that watches their automations as plainly as the
 * automations themselves — an unseen safety net is indistinguishable from no safety net.
 */

const STATE = {
  healthy: { tone: 'ok', label: 'healthy' },
  failing: { tone: 'fail', label: 'failing' },
  quiet: { tone: 'warn', label: 'quiet' },
  idle: { tone: 'idle', label: 'no runs' },
};

function AutomationTable({ rows, timezone }) {
  return (
    <div className="ws-tablewrap">
      <table className="ws-table">
        <thead>
          <tr>
            <th>automation</th>
            <th className="ws-table__num">runs · 30d</th>
            <th className="ws-table__num">success</th>
            <th className="ws-table__num">median</th>
            <th>last run</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((automation) => {
            const state = STATE[automation.state] ?? STATE.idle;

            return (
              <tr key={automation.id}>
                <td className="ws-table__wide">
                  <span className="ws-table__strong">{automation.name}</span>
                  {automation.blurb && <span className="ws-table__sub">{automation.blurb}</span>}
                  <span className="ws-table__sub mono">{automation.id}</span>
                </td>
                <td className="ws-table__num mono">{formatCount(automation.runs)}</td>
                <td className="ws-table__num mono">
                  {formatPct(automation.successPct, 1)}
                  {automation.failures > 0 && (
                    <span className="ws-table__sub">
                      {automation.failures} failed in window
                    </span>
                  )}
                </td>
                <td className="ws-table__num mono">
                  {automation.medianLatencyMs === null ? '—' : formatDuration(automation.medianLatencyMs)}
                </td>
                <td className="mono">
                  {automation.lastRunAt ? (
                    <>
                      {formatRelative(automation.lastRunAt, timezone)}
                      <span className="ws-table__sub">
                        {formatStamp(automation.lastRunAt, timezone)}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Automations({ data }) {
  const { tenant, automations } = data;
  const client = automations.filter((a) => a.kind === 'client');
  const monitoring = automations.filter((a) => a.kind === 'monitoring');

  const totalRuns = client.reduce((sum, a) => sum + a.runs, 0);
  const totalFailures = client.reduce((sum, a) => sum + a.failures, 0);
  const failingNow = automations.filter((a) => a.state === 'failing').length;

  return (
    <>
      <div className="ws-stats ws-stats--three">
        <StatCard
          label="automations running"
          value={formatCount(client.length)}
          sub={`${formatCount(monitoring.length)} more watching them`}
          tone="lead"
        />
        <StatCard
          label="runs · last 30 days"
          value={formatCount(totalRuns)}
          sub={
            totalFailures === 0
              ? 'no failed runs in the window'
              : `${formatCount(totalFailures)} failed and were alerted on`
          }
        />
        <StatCard
          label="failing right now"
          value={formatCount(failingNow)}
          sub={
            failingNow === 0
              ? 'nothing has failed in the last 24 hours'
              : 'we have been paged — see reliability'
          }
        />
      </div>

      <Panel title="running for you" note={`${formatCount(client.length)} workflows`} bare>
        {client.length === 0 ? (
          <EarlyData
            createdAt={tenant.createdAt}
            timezone={tenant.timezone}
            title="nothing has run yet"
          >
            automations appear here the first time they actually fire, not the day they are
            switched on — a list of things we promised to build is not a list of things that
            are working. every figure on this page is counted from real runs.
          </EarlyData>
        ) : (
          <AutomationTable rows={client} timezone={tenant.timezone} />
        )}
      </Panel>

      <Panel title="watching it for you" note="verification, not customer-facing" bare>
        {monitoring.length === 0 ? (
          <Empty title="no verification runs in this window" />
        ) : (
          <AutomationTable rows={monitoring} timezone={tenant.timezone} />
        )}

        <p className="ws-note">
          these two do not touch a customer. once an hour a synthetic lead is pushed through
          the live pipeline and a separate run checks it came out the far end — separate on
          purpose, because a workflow that verifies its own output proves nothing. the
          synthetic rows are tagged and excluded from every count on every other page.
        </p>
      </Panel>
    </>
  );
}
