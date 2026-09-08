import { formatClock, formatDuration } from '../lib/format';

/**
 * the activity feed, one row per lead.
 *
 * a flat event log is what the database holds, but it is not what happened — what happened
 * is "a call came in at 2:14 and got a text back in eight seconds". the threading itself
 * lives in derive.js so that the feed, the leads table and the command palette are all
 * looking at the same object; this component only draws it.
 *
 * the pipeline is drawn as connected ticks rather than four stacked log lines, because the
 * sequence is the product's actual claim and a list does not make a sequence legible.
 */

const STEP_LABEL = {
  call_missed: 'missed call',
  lead_received: 'lead',
  sms_sent: 'text',
  routed: 'routed',
  reply_received: 'replied',
};

export default function EventFeed({ threads, timezone, live, freshIds, title = 'activity' }) {
  return (
    <div className="pt-feed">
      <div className="pt-feed__head">
        <span className="pt-eyebrow">{title}</span>
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
              key={thread.id}
              /* only threads that arrived over the socket after first paint animate.
                 replaying the entrance on every render would make a static page perform
                 liveness it does not have. */
              className={`pt-thread${freshIds?.has(thread.id) ? ' pt-thread--fresh' : ''}`}
            >
              <div className="pt-thread__top">
                <span className="pt-thread__time">{formatClock(thread.startedAt, timezone)}</span>
                <span className="pt-thread__src">
                  {thread.name ? `${thread.name} · ${thread.sourceLabel}` : thread.sourceLabel}
                </span>
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
                    key={`${step.type}-${step.at}`}
                    className={`pt-step${step.status === 'failure' ? ' pt-step--fail' : ''}`}
                  >
                    {i > 0 && <span className="pt-step__line" aria-hidden="true" />}
                    <span className="pt-step__dot" aria-hidden="true" />
                    {STEP_LABEL[step.type] ?? step.type.replace(/_/g, ' ')}
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
