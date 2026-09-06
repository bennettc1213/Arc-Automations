import { DateTime } from 'luxon';

/**
 * shown for a tenant's first week.
 *
 * a dashboard holding six hours of history looks broken rather than new — three
 * bars on a thirty-day chart reads as a bug, and "median response: —" reads as
 * a failure. so the charts are withheld and replaced with a designed state that
 * says plainly what is happening. this borrows the site's honest-media-slot
 * pattern: dashed border, hatch fill, no fake content.
 */
export default function EarlyData({ createdAt, timezone }) {
  const days = Math.max(
    0,
    Math.floor(DateTime.now().diff(DateTime.fromISO(createdAt, { zone: 'utc' }), 'days').days)
  );
  const started = DateTime.fromISO(createdAt, { zone: 'utc' }).setZone(timezone).toFormat('LLL d');

  return (
    <div className="pt-early">
      <p className="pt-early__title">collecting data</p>
      <p className="pt-early__body">
        monitoring started {started} — {days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`}. charts
        appear once there is a full week to draw, so they show a real trend rather than a shape
        that changes meaning every time a lead arrives. the numbers above are live now.
      </p>
    </div>
  );
}
