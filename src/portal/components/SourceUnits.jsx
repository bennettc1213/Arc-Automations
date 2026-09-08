import { Panel } from './ui';
import { formatPct } from '../lib/format';

/**
 * where the leads come from, drawn as a hundred squares.
 *
 * a donut was the obvious move. it is also the one chart type people reliably misread —
 * nobody can tell 22% from 28% by arc length — and it is round, which is a shape this
 * design system does not otherwise contain. a hundred unit squares are countable, exact to
 * the percentage point, and made of the same vocabulary as the cursor and the focus ring.
 *
 * the three sources are three opacities of the one accent rather than three hues. the
 * site's rule is one accent, no exceptions; inventing a blue and a green here to label
 * "web form" and "google message" would break it for decoration.
 */

const CELLS = 100;

/* largest remainder, not rounding. rounding each share independently gives ninety-nine or
   a hundred and one squares depending on the data, and a chart that sometimes has a hole in
   it is a chart people stop trusting. */
function allocate(sources) {
  const exact = sources.map((source) => ({ ...source, exact: (source.pct / 100) * CELLS }));
  const base = exact.map((source) => ({ ...source, cells: Math.floor(source.exact) }));
  let remaining = CELLS - base.reduce((sum, source) => sum + source.cells, 0);

  const byRemainder = [...base].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
  );

  for (let i = 0; remaining > 0 && byRemainder.length > 0; i++, remaining--) {
    byRemainder[i % byRemainder.length].cells += 1;
  }

  return base;
}

export default function SourceUnits({ sources, total }) {
  if (!sources.length) {
    return (
      <Panel title="lead sources" note="30d">
        <p className="ws-panel__empty">no leads in this window yet.</p>
      </Panel>
    );
  }

  const allocated = allocate(sources);
  const cells = allocated.flatMap((source, rank) =>
    Array.from({ length: source.cells }, () => rank),
  );

  return (
    <Panel title="lead sources" note={`${total} leads · 30d`}>
      <div className="ws-units" role="img" aria-label={sources.map((s) => `${s.label} ${formatPct(s.pct)}`).join(', ')}>
        {cells.map((rank, i) => (
          <i key={i} className={`ws-units__cell ws-units__cell--${Math.min(rank, 3)}`} />
        ))}
      </div>

      <ul className="ws-legend">
        {allocated.map((source, rank) => (
          <li key={source.key}>
            <i className={`ws-units__cell ws-units__cell--${Math.min(rank, 3)}`} aria-hidden="true" />
            <span className="ws-legend__label">{source.label}</span>
            <span className="ws-legend__val">
              {source.count} · {formatPct(source.pct)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
