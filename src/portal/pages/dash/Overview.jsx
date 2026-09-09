import { Link } from 'react-router-dom';
import StatusBar from '../../components/StatusBar';
import LeadsChart from '../../components/LeadsChart';
import ResponseChart from '../../components/ResponseChart';
import SourceUnits from '../../components/SourceUnits';
import HourChart from '../../components/HourChart';
import EventFeed from '../../components/EventFeed';
import EarlyData from '../../components/EarlyData';
import { Sparkline, StatCard } from '../../components/ui';
import {
  UPTIME_MEANING,
  describeP90,
  describeSends,
  formatCount,
  formatDuration,
  formatUptime,
} from '../../lib/format';

/**
 * the page the portal opens on.
 *
 * ordered by the questions an owner actually asks, in the order they ask them: is it still
 * working, how many jobs came in, how fast were they answered, and what is happening right
 * now. everything else in the workspace is a drill-down from one of those four.
 *
 * the four stat cards are deliberately equal here, unlike the old single-column layout
 * which sized the lead count much larger. once a sidebar is carrying the hierarchy, a
 * five-rem number in a row of one-rem numbers stops reading as emphasis and starts reading
 * as a layout that broke.
 */

const FEED_THREADS = 14;

export default function Overview({ data, base, live }) {
  const { tenant, metrics, deltas, leadsPerDay, hourly, sources, threads } = data;
  const isDemo = base === '/demo';

  /* the public demo headlines the rolling thirty-day figure; a signed-in client sees their
     calendar month. a calendar month reads as near-zero for the first days of every month —
     honest on your own account, misleading on a page a stranger is judging the product by.
     the delta has to be picked with the number rather than separately: a month-to-date count
     sitting under a rolling thirty-day percentage is two different windows in one card. */
  const leadValue = isDemo ? metrics.leadsLast30Days : metrics.leadsThisMonth;
  const leadLabel = isDemo ? 'leads · last 30 days' : 'leads this month';
  const leadDelta = isDemo ? deltas.leads : deltas.monthToDate.leads;
  const leadDeltaLabel = isDemo ? 'vs prev 30d' : deltas.monthToDate.periodLabel;

  return (
    <>
      <StatusBar status={data.status} timezone={tenant.timezone} />

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

      {data.isEarlyData ? (
        <EarlyData createdAt={tenant.createdAt} timezone={tenant.timezone} />
      ) : (
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
          <EventFeed
            threads={threads.slice(0, FEED_THREADS)}
            timezone={tenant.timezone}
            live={live}
          />
        </div>
      )}
    </>
  );
}
