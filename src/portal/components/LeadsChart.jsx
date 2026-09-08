import { Panel } from './ui';

/**
 * leads per day, 30 days. hand-rolled svg.
 *
 * a charting library was the obvious move and the wrong one: recharts ships its
 * own visual language (rounded caps, tooltip chrome, a legend component) and
 * beating that back into this design system costs more than the forty lines
 * below. the site's own decorative layers are hand-rolled for the same reason.
 *
 * days with zero leads draw a faint floor bar rather than nothing. an empty
 * column is ambiguous — it could mean "no leads" or "chart is broken" — and on
 * this product that ambiguity is the whole problem.
 */
const W = 720;
const H = 180;
const PAD_B = 22;

export default function LeadsChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.leads));
  const slot = W / data.length;
  const barW = Math.max(2, slot * 0.62);
  const plotH = H - PAD_B;

  // one label every fifth day; thirty mono labels would collide into a smear
  const labelEvery = Math.ceil(data.length / 6);

  return (
    <Panel title="leads per day" note={`30d · peak ${max}`}>

      {/* no preserveAspectRatio="none" here: it would stretch the mono axis
          labels horizontally as the panel widens. the chart scales
          proportionally instead. */}
      <svg
        className="pt-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`daily lead volume over ${data.length} days, peak ${max}`}
      >
        <line className="pt-chart__grid" x1="0" y1={plotH} x2={W} y2={plotH} />

        {data.map((d, i) => {
          const h = d.leads === 0 ? 1.5 : Math.max(2, (d.leads / max) * (plotH - 8));
          return (
            <g key={d.date}>
              <rect
                className={`pt-chart__bar${d.leads === 0 ? ' pt-chart__bar--empty' : ''}`}
                x={i * slot + (slot - barW) / 2}
                y={plotH - h}
                width={barW}
                height={h}
              >
                <title>{`${d.label}: ${d.leads} ${d.leads === 1 ? 'lead' : 'leads'}`}</title>
              </rect>

              {i % labelEvery === 0 && (
                <text
                  className="pt-chart__axis"
                  x={i * slot + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}
