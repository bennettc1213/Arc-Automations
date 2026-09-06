import { formatClock, formatRelative } from '../lib/format';

/**
 * the single most prominent element on the page, because it answers the one
 * question the owner opened the portal to ask: is it still working.
 *
 * state is never carried by colour alone — each one has its own glyph and its
 * own words. a greyscale screenshot of this bar still says what it means, and
 * so does a red/green colourblind read of it.
 */
const PRESENTATION = {
  operational: { label: 'all systems operational', glyph: '■', mod: 'ok' },
  degraded: { label: 'degraded — watching', glyph: '▲', mod: 'degraded' },
  failed: { label: 'action required', glyph: '●', mod: 'failed' },
};

export default function StatusBar({ status, timezone }) {
  const { label, glyph, mod } = PRESENTATION[status.status] ?? PRESENTATION.operational;

  return (
    <div className={`pt-status pt-status--${mod}`} role="status" aria-live="polite">
      <div className="pt-status__in">
        {/* a real character, not a tinted box: the shape differs per state, so
            the meaning survives greyscale and colourblind reads */}
        <span className="pt-status__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="pt-status__label">{label}</span>

        {status.lastCheckedAt && (
          <span className="pt-status__check">
            last check {formatClock(status.lastCheckedAt, timezone)}
            <span className="pt-status__ago"> · {formatRelative(status.lastCheckedAt, timezone)}</span>
          </span>
        )}

        {status.detail && <p className="pt-status__detail">{status.detail}</p>}
      </div>
    </div>
  );
}
