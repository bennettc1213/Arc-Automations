/**
 * thirty days of end-to-end checks, one cell per day.
 *
 * the shape everyone already knows how to read from a status page, which is the point —
 * this is the same promise those pages make, and borrowing the visual language means nobody
 * has to be taught what they are looking at.
 *
 * failed days keep their colour permanently. hiding a resolved incident once it is fixed
 * would make the strip prettier and the product less believable: thirty days of unbroken
 * green reads as fabricated, and a failure that was detected, alerted on and fixed is the
 * clearest evidence there is that somebody is actually watching.
 */

export default function UptimeStrip({ daily }) {
  return (
    <div className="ws-strip" role="img" aria-label="daily end-to-end check results, oldest first">
      {daily.map((day) => (
        <i
          key={day.date}
          className={`ws-strip__cell ws-strip__cell--${day.state}`}
          title={
            day.checks === 0
              ? `${day.label} — no checks recorded`
              : `${day.label} — ${day.checks} checks, ${day.failures} failed`
          }
        />
      ))}
    </div>
  );
}
