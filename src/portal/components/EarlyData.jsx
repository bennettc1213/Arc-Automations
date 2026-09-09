import { DateTime } from 'luxon';

/**
 * shown for a tenant's first week.
 *
 * a dashboard holding six hours of history looks broken rather than new — three
 * bars on a thirty-day chart reads as a bug, and "median response: —" reads as
 * a failure. so the charts are withheld and replaced with a designed state that
 * says plainly what is happening. this borrows the site's honest-media-slot
 * pattern: dashed border, hatch fill, no fake content.
 *
 * it takes per-page copy because "no leads yet — the pipeline went live 3 days
 * ago and is watching" and "not enough history to compare months yet" are
 * different facts, and a client who clicks through five pages and reads the
 * same paragraph five times learns that nobody wrote it for them. every page in
 * the workspace renders one of these rather than a blank, so a tenant on day
 * three is never looking at a screen that could equally mean "broken".
 *
 * the age line is always appended: whatever the page-specific sentence says,
 * "monitoring started Sep 4 — 3 days ago" is the fact that makes an empty page
 * legible instead of worrying.
 */
export default function EarlyData({ createdAt, timezone, title = 'collecting data', children }) {
  const days = Math.max(
    0,
    Math.floor(DateTime.now().diff(DateTime.fromISO(createdAt, { zone: 'utc' }), 'days').days)
  );
  const started = DateTime.fromISO(createdAt, { zone: 'utc' }).setZone(timezone).toFormat('LLL d');
  const age = days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`;

  return (
    <div className="pt-early">
      <p className="pt-early__title">{title}</p>
      <p className="pt-early__body">
        {children ?? (
          <>
            charts appear once there is a full week to draw, so they show a real trend rather
            than a shape that changes meaning every time a lead arrives. the numbers above are
            live now.
          </>
        )}
      </p>
      <p className="pt-early__meta mono">
        monitoring started {started} — {age}
      </p>
    </div>
  );
}
