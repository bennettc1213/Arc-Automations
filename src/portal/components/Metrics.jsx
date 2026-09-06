import TickValue from './TickValue';
import { formatDuration, formatUptime } from '../lib/format';

/**
 * the four numbers, sized by how much they matter.
 *
 * deliberately not four equal cards. the lead count is what an owner opens this
 * page to see; response time and uptime are the evidence that the count is
 * trustworthy. equal weighting would say they are equally interesting, which
 * is not true.
 *
 * every label here is load-bearing wording from brand/arc.md:
 *   - "answered", never "recovered" — recovered implies the job came back, and
 *     that cannot be proven without booking data this pipeline does not have.
 *   - median, not mean, with p90 shown underneath as context. one four-hour
 *     carrier delay destroys a mean, and a response figure a contractor can
 *     argue with takes every other number on the page down with it.
 */
export default function Metrics({ metrics, leadWindow = 'month' }) {
  const { leadsThisMonth, leadsLast30Days, medianResponseMs, p90ResponseMs, missedCallsAnswered, uptimePct } =
    metrics;

  /* the window picks both the number and its label together, so they can never
     disagree. deriving one from the wording of the other would mean a copy edit
     could silently change which figure is on screen — the precise class of
     quiet wrongness this portal exists to rule out. */
  const isRolling = leadWindow === 'rolling30';
  const leadValue = isRolling ? leadsLast30Days : leadsThisMonth;
  const leadLabel = isRolling ? 'leads · last 30 days' : 'leads this month';

  return (
    <div className="pt-metrics">
      <div className="pt-metric pt-metric--lead">
        <span className="pt-metric__label">{leadLabel}</span>
        <span className="pt-metric__val">
          <TickValue value={leadValue} />
        </span>
        <span className="pt-metric__sub">every one answered automatically</span>
      </div>

      <div className="pt-metric">
        <span className="pt-metric__label">median response</span>
        <span className={`pt-metric__val${medianResponseMs === null ? ' pt-metric__val--none' : ''}`}>
          {formatDuration(medianResponseMs)}
        </span>
        <span className="pt-metric__sub">
          {p90ResponseMs === null ? 'no sends yet' : `p90 ${formatDuration(p90ResponseMs)}`}
        </span>
      </div>

      <div className="pt-metric">
        <span className="pt-metric__label">missed calls answered</span>
        <span className="pt-metric__val">
          <TickValue value={missedCallsAnswered} />
        </span>
        <span className="pt-metric__sub">text back, last 30 days</span>
      </div>

      <div className="pt-metric">
        <span className="pt-metric__label">pipeline uptime</span>
        <span className={`pt-metric__val${uptimePct === null ? ' pt-metric__val--none' : ''}`}>
          {formatUptime(uptimePct)}
        </span>
        <span className="pt-metric__sub">end-to-end checks, 30 days</span>
      </div>
    </div>
  );
}
