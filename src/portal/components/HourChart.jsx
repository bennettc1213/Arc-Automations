import { Panel } from './ui';
import { formatPct } from '../lib/format';

/**
 * when leads actually arrive, by hour of the client's own day.
 *
 * this is the chart that makes the argument out loud. a restoration company's burst pipe at
 * 2am is the job that pays and the one their competitor sleeps through, and the share of
 * leads landing outside office hours is the single number that says why an automated
 * response is worth paying for. so the out-of-hours bars are the ones drawn in the accent,
 * and the figure is printed in words underneath rather than left for the reader to add up.
 *
 * hours are in the tenant's timezone, not the browser's. a contractor in ohio looking at
 * their overnight volume shifted by whatever laptop they opened it on would be looking at a
 * different business.
 */

const W = 720;
const H = 168;
const PAD_B = 24;
const DAY_START = 7;
const DAY_END = 18;

export default function HourChart({ hourly }) {
  const { hours, total, afterHours, afterHoursPct, windowLabel } = hourly;
  const max = Math.max(1, ...hours.map((h) => h.count));
  const slot = W / 24;
  const barW = slot * 0.66;
  const plotH = H - PAD_B;

  return (
    <Panel
      title="when leads arrive"
      note={total === 0 ? 'no leads yet' : `${total} leads · 30d`}
    >
      <svg
        className="pt-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`lead volume by hour of day. ${afterHours} of ${total} arrived outside ${windowLabel}`}
      >
        <line className="pt-chart__grid" x1="0" y1={plotH} x2={W} y2={plotH} />

        {hours.map((hour, i) => {
          const outside = hour.hour < DAY_START || hour.hour >= DAY_END;
          const h = hour.count === 0 ? 1.5 : Math.max(2, (hour.count / max) * (plotH - 10));

          return (
            <g key={hour.hour}>
              <rect
                className={`pt-chart__bar${
                  hour.count === 0 ? ' pt-chart__bar--empty' : outside ? ' pt-chart__bar--hot' : ''
                }`}
                x={i * slot + (slot - barW) / 2}
                y={plotH - h}
                width={barW}
                height={h}
              >
                {/* one string, not interpolated fragments: an svg <title> holding several
                    text nodes renders the comment markers between them as visible text in
                    some browsers. */}
                <title>{`${String(hour.hour).padStart(2, '0')}:00 — ${hour.count} ${
                  hour.count === 1 ? 'lead' : 'leads'
                }${outside ? ' (outside office hours)' : ''}`}</title>
              </rect>

              {/* one label every three hours. twenty-four mono labels collide into a smear */}
              {hour.hour % 3 === 0 && (
                <text className="pt-chart__axis" x={i * slot + slot / 2} y={H - 8} textAnchor="middle">
                  {String(hour.hour).padStart(2, '0')}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <p className="ws-note">
        {afterHoursPct === null ? (
          'not enough leads yet to say when they arrive.'
        ) : (
          <>
            <b>{formatPct(afterHoursPct)}</b> of leads arrived outside {windowLabel} — {afterHours} of{' '}
            {total}. every one of them got an answer at the same speed as a lead at noon.
          </>
        )}
      </p>
    </Panel>
  );
}
