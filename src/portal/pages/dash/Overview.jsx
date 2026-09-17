import { Link } from 'react-router-dom';
import StatusBar from '../../components/StatusBar';
import LeadsChart from '../../components/LeadsChart';
import ResponseChart from '../../components/ResponseChart';
import SourceUnits from '../../components/SourceUnits';
import HourChart from '../../components/HourChart';
import EventFeed from '../../components/EventFeed';
import EarlyData from '../../components/EarlyData';
import AttentionQueue from '../../components/AttentionQueue';
import LifecycleStrip from '../../components/LifecycleStrip';
import ModuleHealth from '../../components/ModuleHealth';
import { ModuleStat } from '../../components/ModuleUI';
import { Sparkline, StatCard } from '../../components/ui';
import {
  UPTIME_MEANING,
  describeP90,
  describeSends,
  formatCount,
  formatDuration,
  formatMoneyShort,
  formatPct,
  formatRating,
  formatUptime,
} from '../../lib/format';

/**
 * the page the portal opens on.
 *
 * ordered by the questions an owner actually asks, in the order they ask them: is it still
 * working, what needs me right now, how much came in and how fast was it answered, and where
 * is it all sitting. everything else in the workspace is a drill-down from one of those.
 *
 * the queue sits second, above the numbers, on purpose. a dashboard's job is not to be
 * admired — it is to make somebody do the one thing today that money depends on, and a list
 * of four people waiting on a callback beats any chart on this page at that.
 *
 * every card below the first row goes through `ModuleStat`, which is the component that
 * knows the difference between "none" and "we cannot say". a client running lead capture
 * only must see estimate and membership figures as dashes with a reason — four zeros would
 * read as a quarter in which they quoted nothing and sold nothing.
 */

const FEED_THREADS = 14;

export default function Overview({ data, base, live }) {
  const { tenant, metrics, deltas, leadsPerDay, hourly, sources, threads, availability } = data;
  const isDemo = base === '/demo';
  const tz = tenant.timezone;

  /* the public demo headlines the rolling thirty-day figure; a signed-in client sees their
     calendar month. a calendar month reads as near-zero for the first days of every month —
     honest on your own account, misleading on a page a stranger is judging the product by.
     the delta has to be picked with the number rather than separately: a month-to-date count
     sitting under a rolling thirty-day percentage is two different windows in one card. */
  const leadValue = isDemo ? metrics.leadsLast30Days : metrics.leadsThisMonth;
  const leadLabel = isDemo ? 'leads · last 30 days' : 'leads this month';
  const leadDelta = isDemo ? deltas.leads : deltas.monthToDate.leads;
  const leadDeltaLabel = isDemo ? 'vs prev 30d' : deltas.monthToDate.periodLabel;

  const est = data.estimates.metrics;
  const rev = data.reviews.metrics;
  const mem = data.memberships.metrics;
  const ins = data.installs.metrics;
  const liveModule = (key) => availability[key]?.state === 'live';

  /* a module that this client does not have contributes nothing to the second row rather
     than contributing a dash. the row is only drawn at all if something is in it. */
  const hasLifecycle = ['estimates', 'reviews', 'memberships', 'installs'].some((key) =>
    ['live', 'awaiting'].includes(availability[key]?.state),
  );

  return (
    <>
      <StatusBar status={data.status} timezone={tz} />

      {/* what a person has to do today, before anything that is merely true. */}
      <AttentionQueue attention={data.attention} base={base} timezone={tz} limit={6} />

      {/* order is the argument. the lead count is the number their crm already tells
          them; missed calls answered is the number that maps to money, because every one
          of them is a job that would have gone to voicemail and died there. so it goes
          first and carries the hero tone. median response is second — it is the figure
          the whole system exists to move. */}
      <div className="ws-stats">
        <StatCard
          label="missed calls answered"
          value={metrics.missedCallsAnswered}
          animate
          format={formatCount}
          delta={deltas.missedCallsAnswered}
          deltaLabel="vs prev 30d"
          sub="calls that rang out — every one got a text back instead of voicemail"
          tone="lead"
        />

        <StatCard
          label="median response"
          value={formatDuration(metrics.medianResponseMs)}
          delta={deltas.medianResponseMs}
          deltaLabel="vs prev 30d"
          sub={
            metrics.p90ResponseMs === null
              ? 'no texts sent yet'
              : `${describeP90(metrics.p90ResponseMs)} · ${describeSends(metrics.sends)}`
          }
        />

        <StatCard
          label={leadLabel}
          value={leadValue}
          animate
          format={formatCount}
          delta={leadDelta}
          deltaLabel={leadDeltaLabel}
          sub="every one answered automatically"
        >
          <Sparkline points={leadsPerDay.map((day) => day.leads)} />
        </StatCard>

        <StatCard
          label="pipeline uptime"
          value={formatUptime(metrics.uptimePct)}
          sub={
            <>
              {UPTIME_MEANING}. {formatCount(data.reliability.checks)} checks ·{' '}
              <Link to={`${base}/reliability`}>see them</Link>
            </>
          }
        />
      </div>

      {hasLifecycle && (
        <div className="ws-stats ws-stats--four">
          <ModuleStat
            label="open quoted work"
            value={formatMoneyShort(est.eligibleValueCents)}
            compact
            available={liveModule('estimates')}
            unavailable={availability.estimates?.awaiting}
            sub={`${formatCount(est.eligibleOpen)} estimates still waiting on a decision`}
          />

          <ModuleStat
            label="recovered revenue"
            value={formatMoneyShort(est.recoveredRevenueCents)}
            compact
            available={liveModule('estimates') && est.recoveredRevenueCents !== null}
            unavailable={
              liveModule('estimates')
                ? 'no approval yet has the full chain behind it — quote, follow-up, reply and a value'
                : availability.estimates?.awaiting
            }
            sub={`${formatCount(est.recoveredCount)} approved after a follow-up we sent`}
          />

          <ModuleStat
            label="reviews received"
            value={rev.reviewsReceived}
            compact
            available={liveModule('reviews')}
            unavailable={availability.reviews?.awaiting}
            sub={
              rev.averageRating === null
                ? 'no ratings yet'
                : `${formatRating(rev.averageRating)} average · ${formatCount(rev.recoveryOpen)} recovery case${rev.recoveryOpen === 1 ? '' : 's'} open`
            }
          />

          <ModuleStat
            label="closeout complete"
            value={
              ins.installsCompleted === 0
                ? '—'
                : formatPct((ins.closeoutsCompleted / ins.installsCompleted) * 100)
            }
            compact
            available={liveModule('installs')}
            unavailable={availability.installs?.awaiting}
            sub={`${formatCount(ins.closeoutsCompleted)} of ${formatCount(ins.installsCompleted)} installs fully closed out`}
          />
        </div>
      )}

      <LifecycleStrip lifecycle={data.lifecycle} base={base} />

      {data.isEarlyData ? (
        <EarlyData createdAt={tenant.createdAt} timezone={tz} />
      ) : (
        <>
          <div className="ws-split">
            <div className="ws-col">
              <LeadsChart data={leadsPerDay} />

              <div className="ws-two">
                <ResponseChart data={data.responseBuckets} />
                <SourceUnits sources={sources} total={hourly.total} />
              </div>

              <HourChart hourly={hourly} />
            </div>

            {/* the feed is the most convincing thing in the product, so on a wide screen it
                is a permanent rail rather than something below the fold. */}
            <EventFeed threads={threads.slice(0, FEED_THREADS)} timezone={tz} live={live} />
          </div>

          {liveModule('memberships') && mem.exceptions > 0 && (
            <p className="ws-note ws-note--loud">
              <b>{formatCount(mem.exceptions)} membership exception{mem.exceptions === 1 ? '' : 's'}</b>{' '}
              your billing provider and your crm will not resolve on their own —{' '}
              <Link to={`${base}/memberships`}>open them</Link>.
            </p>
          )}

          <ModuleHealth health={data.health} timezone={tz} />
        </>
      )}
    </>
  );
}
