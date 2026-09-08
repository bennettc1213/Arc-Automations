import { Panel } from './ui';

/**
 * response-time distribution. horizontal bars, because the labels ("0-10s",
 * "30-60s") are text and text wants a horizontal axis to sit on.
 *
 * this is the chart that answers "is the median hiding a long tail" — a good
 * median with a fat 60s+ bucket is a different story from a good median with an
 * empty one, and an owner deserves to see which they have.
 */
/* sized for a half-width panel rather than a full one. the svg scales
   proportionally, so a 720-wide viewBox squeezed into a 400px column renders its
   10px mono labels at five and a half pixels — legible in the design file and not
   on the page. */
const W = 440;
const ROW_H = 30;
const LABEL_W = 58;
const COUNT_W = 86;

export default function ResponseChart({ data }) {
  const total = data.reduce((sum, b) => sum + b.count, 0);
  const max = Math.max(1, ...data.map((b) => b.count));
  const trackW = W - LABEL_W - COUNT_W;
  const H = data.length * ROW_H;

  return (
    <Panel title="response time" note={total === 0 ? 'no sends yet' : `${total} sends · 30d`}>

      <svg
        className="pt-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="distribution of response times across buckets"
      >
        {data.map((bucket, i) => {
          const y = i * ROW_H;
          const w = bucket.count === 0 ? 1.5 : Math.max(2, (bucket.count / max) * trackW);
          const pct = total === 0 ? 0 : Math.round((bucket.count / total) * 100);

          return (
            <g key={bucket.label}>
              <text className="pt-chart__axis" x="0" y={y + ROW_H / 2 + 3}>
                {bucket.label}
              </text>

              <rect
                className={`pt-chart__bar${bucket.count === 0 ? ' pt-chart__bar--empty' : ''}`}
                x={LABEL_W}
                y={y + 7}
                width={w}
                height={ROW_H - 16}
              >
                <title>{`${bucket.label}: ${bucket.count} (${pct}%)`}</title>
              </rect>

              <text className="pt-chart__val" x={W - COUNT_W + 8} y={y + ROW_H / 2 + 3}>
                {bucket.count === 0 ? '—' : `${bucket.count} · ${pct}%`}
              </text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}
