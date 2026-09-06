import StatusBar from './StatusBar';
import Metrics from './Metrics';
import LeadsChart from './LeadsChart';
import ResponseChart from './ResponseChart';
import EventFeed from './EventFeed';
import EarlyData from './EarlyData';

/**
 * the dashboard body.
 *
 * takes fully-resolved data and renders it, so the signed-in route and the
 * public demo render the identical component. the demo has to show the real
 * product rather than a mock of it — the moment it is a mock, it stops being
 * evidence and starts being a brochure.
 */
export default function Dashboard({ data, banner, live = true, leadWindow, freshIds }) {
  const { tenant } = data;

  return (
    <>
      {banner}
      <StatusBar status={data.status} timezone={tenant.timezone} />

      <div className="pt-body">
        <div className="pt-col">
          <Metrics metrics={data.metrics} leadWindow={leadWindow} />

          {data.isEarlyData ? (
            <EarlyData createdAt={tenant.createdAt} timezone={tenant.timezone} />
          ) : (
            <>
              <LeadsChart data={data.leadsPerDay} />
              <ResponseChart data={data.responseBuckets} />
            </>
          )}
        </div>

        <EventFeed
          events={data.feed}
          timezone={tenant.timezone}
          live={live}
          freshIds={freshIds}
        />
      </div>
    </>
  );
}
