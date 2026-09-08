import UptimeStrip from '../../components/UptimeStrip';
import { Empty, Panel, Pill, StatCard } from '../../components/ui';
import {
  formatCount,
  formatRelative,
  formatSpan,
  formatStamp,
  formatUptime,
} from '../../lib/format';

/**
 * the page that says whether any of the rest of this can be believed.
 *
 * a lead count is only worth what the pipeline behind it is worth, so this page shows the
 * check that proves the pipeline works — hourly, end to end, through the live system — and
 * then shows every time it failed, how long it took us to notice, and how long it took to
 * fix.
 *
 * resolved incidents are never removed. thirty days of unbroken green reads as fabricated,
 * and a failure that was detected, alerted on and fixed is the single most persuasive thing
 * in this product: it is the difference between an automation and an automation somebody is
 * watching.
 */

export default function Reliability({ data }) {
  const { tenant, reliability, incidents, status } = data;
  const open = incidents.filter((incident) => incident.open);

  return (
    <>
      <div className="ws-stats">
        <StatCard
          label="pipeline uptime"
          value={formatUptime(reliability.uptimePct)}
          sub="end-to-end checks, last 30 days"
          tone="lead"
        />
        <StatCard
          label="checks run"
          value={formatCount(reliability.checks)}
          sub={`${reliability.intervalLabel}, through the live system`}
        />
        <StatCard
          label="checks failed"
          value={formatCount(reliability.failures)}
          sub={
            reliability.failures === 0
              ? 'none in the window'
              : 'every one alerted on — see below'
          }
        />
        <StatCard
          label="last check"
          compact
          value={
            reliability.lastCheckAt ? formatRelative(reliability.lastCheckAt, tenant.timezone) : '—'
          }
          sub={
            reliability.lastCheckAt
              ? formatStamp(reliability.lastCheckAt, tenant.timezone)
              : 'no checks recorded'
          }
        />
      </div>

      <Panel
        title="daily checks"
        note={`30 days · ${formatCount(reliability.checks)} checks`}
      >
        <UptimeStrip daily={reliability.daily} />

        <div className="ws-strip__legend">
          <span>
            <i className="ws-strip__cell ws-strip__cell--ok" aria-hidden="true" /> all checks passed
          </span>
          <span>
            <i className="ws-strip__cell ws-strip__cell--failed" aria-hidden="true" /> one or more
            failed
          </span>
          <span>
            <i className="ws-strip__cell ws-strip__cell--none" aria-hidden="true" /> no checks
            recorded
          </span>
          <span className="ws-strip__ends">
            {reliability.daily[0]?.label} → {reliability.daily[reliability.daily.length - 1]?.label}
          </span>
        </div>

        <p className="ws-note">
          once an hour a synthetic lead is pushed through the same pipeline a customer's lead
          takes, and a second, separate run checks it arrived. that is what uptime means here:
          not "the server responded", but "a lead submitted right now would have been answered".
        </p>
      </Panel>

      <Panel
        title="incidents"
        note={
          incidents.length === 0
            ? 'none in the window'
            : `${formatCount(incidents.length)} · ${formatCount(open.length)} open`
        }
        bare
      >
        {incidents.length === 0 ? (
          <Empty title="no incidents in this window">
            nothing has failed a check in the last thirty days. when something does, it appears
            here with the time it was detected, the time it was acknowledged and the time it was
            fixed — resolved ones stay on the record permanently.
          </Empty>
        ) : (
          <ol className="ws-timeline">
            {incidents.map((incident) => (
              <li key={incident.id} className={incident.open ? 'is-open' : ''}>
                <div className="ws-timeline__head">
                  <Pill tone={incident.open ? 'fail' : 'ok'}>
                    {incident.open ? 'open' : 'resolved'}
                  </Pill>
                  <span className="ws-timeline__type mono">
                    {incident.checkType} · {incident.severity}
                  </span>
                  <span className="ws-timeline__span mono">
                    {incident.open ? 'open for' : 'lasted'} {formatSpan(incident.durationMs)}
                  </span>
                </div>

                <p className="ws-timeline__msg">{incident.message}</p>

                <div className="ws-timeline__marks">
                  <span>
                    <em>detected</em>
                    {formatStamp(incident.firedAt, tenant.timezone)}
                  </span>
                  <span>
                    <em>acknowledged</em>
                    {incident.acknowledgedAt
                      ? `${formatStamp(incident.acknowledgedAt, tenant.timezone)}${
                          incident.detectMs !== null ? ` · ${formatSpan(incident.detectMs)} later` : ''
                        }`
                      : 'not yet'}
                  </span>
                  <span>
                    <em>resolved</em>
                    {incident.resolvedAt
                      ? formatStamp(incident.resolvedAt, tenant.timezone)
                      : 'in progress'}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {status.status !== 'operational' && status.detail && (
        <Panel title="right now">
          <p className="ws-note ws-note--loud">{status.detail}</p>
        </Panel>
      )}
    </>
  );
}
