import TickValue from './TickValue';
import { formatSignedPct } from '../lib/format';

/**
 * the small pieces every dashboard page is built out of.
 *
 * kept together because they are one decision, not eight: a panel, its heading, the way a
 * number is shown and the way a delta is shown all have to agree, and splitting them across
 * eight files is how they stop agreeing.
 */

export function Panel({ title, note, actions, children, className = '', bare = false }) {
  return (
    <section className={`ws-panel${bare ? ' ws-panel--bare' : ''} ${className}`}>
      {(title || note || actions) && (
        <header className="ws-panel__head">
          {title && <h2 className="pt-eyebrow">{title}</h2>}
          {note && <span className="ws-panel__note">{note}</span>}
          {actions && <div className="ws-panel__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/* status is never colour alone anywhere in this product. every pill carries a glyph and a
   word, so it survives a colourblind read, a bad screen in daylight, and the greyscale
   screenshot somebody pastes into an email. */
const PILL_GLYPH = { ok: '■', warn: '▲', fail: '●', idle: '□', neutral: '·' };

export function Pill({ tone = 'neutral', children, title }) {
  return (
    <span className={`ws-pill ws-pill--${tone}`} title={title}>
      <i aria-hidden="true">{PILL_GLYPH[tone] ?? PILL_GLYPH.neutral}</i>
      {children}
    </span>
  );
}

/**
 * a period-over-period change.
 *
 * `direction` draws the arrow and `good` picks the colour, and they are deliberately not
 * the same field: a median response time falling is an arrow pointing down and a result
 * worth being pleased about. tying colour to direction is how a dashboard ends up painting
 * an improvement red.
 *
 * when there is no comparable previous period this renders the reason rather than a zero.
 * a delta invented against a half-empty window is exactly the quiet wrongness this portal
 * exists to rule out.
 */
export function Delta({ delta, label, unavailable = 'no previous period yet' }) {
  if (!delta || delta.pct === null) {
    return <span className="ws-delta ws-delta--none">{unavailable}</span>;
  }

  const tone = delta.good === null ? 'flat' : delta.good ? 'good' : 'bad';
  const arrow = delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '—';

  return (
    <span className={`ws-delta ws-delta--${tone}`}>
      <i aria-hidden="true">{arrow}</i>
      {formatSignedPct(delta.pct)}
      {label && <em>{label}</em>}
    </span>
  );
}

/**
 * `children` renders directly under the value, not at the end of the card. a sparkline
 * belongs against the number it is the shape of — and putting it last would push the sub
 * line up by its own height on one card in a row, leaving four cards whose bottom lines do
 * not agree with each other.
 *
 * `compact` is for cards whose value is a phrase rather than a figure. "59 minutes ago" set
 * at the same 2.4rem as "99.44%" wraps to two lines and breaks the row.
 */
export function StatCard({
  label,
  value,
  sub,
  delta,
  deltaLabel,
  tone,
  compact = false,
  children,
  animate = false,
  format,
}) {
  return (
    <div className={`ws-stat${tone ? ` ws-stat--${tone}` : ''}${compact ? ' ws-stat--compact' : ''}`}>
      <span className="ws-stat__label">{label}</span>
      <span className="ws-stat__value">
        {/* the mechanical counter only moves when the value does, which today means on a
            refetch. it is wired here rather than later because it is the site's motion
            language — the same stepping tick the section numbers use — and a count that
            silently swaps digits when the feed goes live would be the odd one out. */}
        {animate && typeof value === 'number' ? (
          <TickValue value={value} format={format} />
        ) : (
          value
        )}
      </span>
      {children}
      {delta !== undefined && <Delta delta={delta} label={deltaLabel} />}
      {sub && <span className="ws-stat__sub">{sub}</span>}
    </div>
  );
}

/* the honest empty state, borrowed from the site's media slot: dashed edge, hatch fill, no
   invented content sitting where real content will go. */
export function Empty({ title, children }) {
  return (
    <div className="ws-empty">
      <p className="ws-empty__title">{title}</p>
      {children && <p className="ws-empty__body">{children}</p>}
    </div>
  );
}

/**
 * a thirty-point trend line, drawn small enough to sit inside a stat card.
 *
 * no axis, no labels, no tooltip. it is not a chart you read values off — the value is the
 * number printed above it — it is the shape of the month, and anything more turns a
 * supporting detail into a competing one.
 */
export function Sparkline({ points, width = 132, height = 30 }) {
  if (!points || points.length < 2) return null;

  const max = Math.max(1, ...points);
  const step = width / (points.length - 1);
  const line = points
    .map((value, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(height - (value / max) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      className="ws-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={line} />
    </svg>
  );
}
