import { useMemo, useState } from 'react';
import EventFeed from '../../components/EventFeed';
import { Empty, Panel, Pill } from '../../components/ui';
import { formatCount, formatDuration, formatStamp } from '../../lib/format';

/**
 * the run log.
 *
 * the overview's feed answers "what is happening"; this page answers "what exactly
 * happened, in order, with times". it is the page you open when a customer says nobody
 * called them back, and it has to be flat and boring and complete — a log that summarises
 * is a log that cannot be used as evidence.
 *
 * the threaded feed stays alongside it, because the two are different readings of the same
 * rows and losing the thread view here would mean losing the shape of the pipeline.
 */

const TYPE_LABEL = {
  call_missed: 'call missed',
  lead_received: 'lead received',
  sms_sent: 'text sent',
  routed: 'routed',
  reply_received: 'customer replied',
};

const TYPES = ['all', 'call_missed', 'lead_received', 'sms_sent', 'routed', 'reply_received'];

const ROW_LIMIT = 240;

export default function Activity({ data, live }) {
  const { tenant, threads } = data;
  const [type, setType] = useState('all');

  /* flattened back out of the threads rather than re-derived from raw events: the threads
     are the one grouping in the product, and a log built from a second pass over the events
     could quietly disagree with the table above it about which lead a row belongs to. */
  const rows = useMemo(() => {
    const flat = [];
    for (const thread of threads) {
      for (const step of thread.steps) {
        flat.push({
          key: `${thread.id}-${step.type}-${step.at}`,
          at: step.at,
          type: step.type,
          status: step.status,
          threadId: thread.id,
          name: thread.name,
          source: thread.sourceLabel,
          latencyMs: step.type === 'sms_sent' ? thread.latencyMs : null,
        });
      }
    }
    return flat.sort((a, b) => b.at.localeCompare(a.at));
  }, [threads]);

  const counts = useMemo(() => {
    const map = { all: rows.length };
    for (const row of rows) map[row.type] = (map[row.type] ?? 0) + 1;
    return map;
  }, [rows]);

  const filtered = useMemo(
    () => (type === 'all' ? rows : rows.filter((row) => row.type === type)).slice(0, ROW_LIMIT),
    [rows, type],
  );

  return (
    <div className="ws-split">
      <div className="ws-col">
        <Panel
          title="run log"
          note={`${formatCount(filtered.length)} of ${formatCount(counts[type] ?? 0)} rows`}
          bare
        >
          <div className="ws-toolbar">
            <div className="ws-chips" role="group" aria-label="filter by event type">
              {TYPES.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`ws-chip${type === key ? ' is-on' : ''}`}
                  onClick={() => setType(key)}
                  disabled={key !== 'all' && !counts[key]}
                >
                  {key === 'all' ? 'everything' : TYPE_LABEL[key]}
                  <em>{counts[key] ?? 0}</em>
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <Empty title="no rows of that type in the window" />
          ) : (
            <div className="ws-tablewrap">
              <table className="ws-table ws-table--dense">
                <thead>
                  <tr>
                    <th>time</th>
                    <th>event</th>
                    <th>lead</th>
                    <th className="ws-table__num">took</th>
                    <th>result</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr key={row.key}>
                      <td className="mono">{formatStamp(row.at, tenant.timezone)}</td>
                      <td className="ws-table__strong">{TYPE_LABEL[row.type] ?? row.type}</td>
                      <td>
                        {row.name ?? 'unknown caller'}
                        <span className="ws-table__sub">{row.source}</span>
                      </td>
                      <td className="ws-table__num mono">
                        {row.latencyMs === null ? '—' : formatDuration(row.latencyMs)}
                      </td>
                      <td>
                        <Pill tone={row.status === 'failure' ? 'fail' : 'ok'}>
                          {row.status === 'failure' ? 'failed' : 'ok'}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="ws-note">
            internal verification rows — the hourly canary, schema asserts, watermark checks —
            are filtered out of this log on purpose. they travel the same live pipeline and
            would otherwise sit in here looking like customers who never existed. they are on
            the reliability page instead, counted where they belong.
          </p>
        </Panel>
      </div>

      <EventFeed
        threads={threads.slice(0, 30)}
        timezone={tenant.timezone}
        live={live}
        title="by lead"
      />
    </div>
  );
}
