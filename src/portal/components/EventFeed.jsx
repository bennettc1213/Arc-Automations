import { formatClock, formatDuration } from '../lib/format';

/**
 * the activity feed, grouped into one row per lead.
 *
 * a flat event log is what the database holds, but it is not what happened —
 * what happened is "a call came in at 2:14 and got a text back in 8 seconds."
 * so events are threaded by correlation_id and rendered as a pipeline: the
 * source, then the steps it passed through, then how long the acknowledgement
 * took. that shape is the product's actual claim, made legible.
 */

const STEP_LABEL = {
  call_missed: 'missed call',
  lead_received: 'lead',
  sms_sent: 'text',
  routed: 'routed',
  reply_received: 'replied',
};

const SOURCE_LABEL = {
  missed_call: 'missed call',
  web_form: 'web form',
  gbp_message: 'google message',
};

/** groups a flat, newest-first event list into per-lead threads. */
function toThreads(events) {
  const order = [];
  const byKey = new Map();

  for (const event of events) {
    const key = event.correlationId ?? event.id;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key).push(event);
  }

  return order.map((key) => {
    // oldest-first inside a thread: a pipeline reads left to right in the
    // order it actually ran, even though the feed itself is newest-first.
    const steps = byKey.get(key).slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const lead = steps.find((e) => e.eventType === 'lead_received');
    const sms = steps.find((e) => e.eventType === 'sms_sent');

    return {
      key,
      steps,
      startedAt: steps[0].occurredAt,
      source: SOURCE_LABEL[lead?.payload?.source] ?? 'lead',
      latencyMs: sms?.status === 'success' ? sms.latencyMs : null,
      failed: sms?.status === 'failure',
    };
  });
}

export default function EventFeed({ events, timezone, live, freshIds }) {
  const threads = toThreads(events);

  return (
    <div className="pt-feed">
      <div className="pt-feed__head">
        <span className="pt-eyebrow">activity</span>
        <span className={`pt-feed__live${live ? '' : ' pt-feed__live--off'}`}>
          <i aria-hidden="true" />
          {live ? 'live' : 'static'}
        </span>
      </div>

      <div className="pt-feed__scroll">
        {threads.length === 0 ? (
          <p className="pt-feed__empty">no activity in this window yet.</p>
        ) : (
          threads.map((thread) => (
            <article
              key={thread.key}
              /* only threads that arrived over the socket after first paint
                 animate. replaying the entrance on every render would make a
                 static page perform liveness it does not have. */
              className={`pt-thread${freshIds?.has(thread.key) ? ' pt-thread--fresh' : ''}`}
            >
              <div className="pt-thread__top">
                <span className="pt-thread__time">{formatClock(thread.startedAt, timezone)}</span>
                <span className="pt-thread__src">{thread.source}</span>
                {thread.failed ? (
                  <span className="pt-thread__ms pt-thread__ms--fail">send failed</span>
                ) : (
                  thread.latencyMs !== null && (
                    <span className="pt-thread__ms">{formatDuration(thread.latencyMs)}</span>
                  )
                )}
              </div>

              <div className="pt-steps">
                {thread.steps.map((step, i) => (
                  <span
                    key={step.id}
                    className={`pt-step${step.status === 'failure' ? ' pt-step--fail' : ''}`}
                  >
                    {i > 0 && <span className="pt-step__line" aria-hidden="true" />}
                    <span className="pt-step__dot" aria-hidden="true" />
                    {STEP_LABEL[step.eventType] ?? step.eventType.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
