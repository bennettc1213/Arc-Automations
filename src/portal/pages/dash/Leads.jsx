import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import EarlyData from '../../components/EarlyData';
import { Empty, Panel, Pill } from '../../components/ui';
import { useReducedMotion } from '../../../lib/hooks';
import { downloadCsv, threadsToCsv } from '../../lib/csv';
import { formatCount, formatDuration, formatPhone, formatStamp } from '../../lib/format';

/**
 * every lead, and what happened to it.
 *
 * this is the page that settles arguments. an owner who thinks the phone was quiet last
 * Tuesday can open it, and a row that says a text went out in six seconds — with the
 * pipeline underneath it and the tech's name attached — is a different kind of answer from
 * a number on a chart.
 *
 * so it is a table, not a card grid. cards are for things you browse; this is something
 * people scan, sort and export, and a table is the shape that does that.
 */

const STATE_TONE = {
  'send failed': 'fail',
  replied: 'ok',
  routed: 'ok',
  answered: 'ok',
  received: 'idle',
};

const STEP_LABEL = {
  call_missed: 'missed call',
  lead_received: 'lead',
  sms_sent: 'text',
  routed: 'routed',
  reply_received: 'replied',
};

const OUTCOMES = [
  { key: 'all', label: 'all' },
  { key: 'replied', label: 'replied' },
  { key: 'routed', label: 'routed' },
  { key: 'send failed', label: 'failed' },
];

/* revealed in pages rather than paginated. an owner scanning for "the tuesday one" reads
   down a continuous list; splitting that across numbered pages makes them hold a position
   in their head. the cap only exists so first paint is not a hundred and fifty rows of dom. */
const PAGE = 60;

const SORTS = {
  newest: { label: 'newest', compare: (a, b) => b.startedAt.localeCompare(a.startedAt) },
  oldest: { label: 'oldest', compare: (a, b) => a.startedAt.localeCompare(b.startedAt) },
  /* nulls last in both directions. a failed send has no response time, and letting it sort
     as zero would put every failure at the top of "fastest" — the exact opposite of true. */
  fastest: {
    label: 'fastest',
    compare: (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
  },
  slowest: {
    label: 'slowest',
    compare: (a, b) => (b.latencyMs ?? -Infinity) - (a.latencyMs ?? -Infinity),
  },
};

export default function Leads({ data }) {
  const { tenant, threads, threadTotal } = data;
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [sort, setSort] = useState('newest');
  const [shown, setShown] = useState(PAGE);
  const reduced = useReducedMotion();

  /* set when the open row changed because somebody clicked it. a click already put the row
     under the pointer, and scrolling it to the middle of the screen afterwards yanks the
     page out from under the person who clicked. */
  const clicked = useRef(false);

  /* the opened row lives in the url so the command palette can link straight to a lead and
     so a client can send someone the row rather than describing it. */
  const openId = params.get('thread');

  const toggleRow = (id) => {
    clicked.current = true;
    const next = new URLSearchParams(params);
    if (openId === id) next.delete('thread');
    else next.set('thread', id);
    setParams(next, { replace: true });
  };

  const sourceOptions = useMemo(
    () => [{ key: 'all', label: 'all sources' }, ...data.sources.map((s) => ({ key: s.key, label: s.label }))],
    [data.sources],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();

    return threads
      .filter((thread) => {
        if (source !== 'all' && thread.source !== source) return false;
        if (outcome !== 'all' && thread.state !== outcome) return false;
        if (!q) return true;
        return [thread.name, thread.phone, thread.lossType, thread.tech].some((field) =>
          String(field ?? '').toLowerCase().includes(q),
        );
      })
      .sort(SORTS[sort].compare);
  }, [threads, query, source, outcome, sort]);

  /* back to the first page whenever the result set changes underneath. leaving it at
     "showing 120" after a filter that matches nine rows means the count in the panel header
     and the list below it are describing different things. */
  useEffect(() => setShown(PAGE), [query, source, outcome, sort]);

  /* a lead opened from the command palette can be the hundredth row. without this the url
     says a thread is open and the table does not contain it, which reads as the search
     having silently failed. */
  useEffect(() => {
    if (!openId) return;
    const index = rows.findIndex((thread) => thread.id === openId);
    if (index >= shown) setShown(Math.ceil((index + 1) / PAGE) * PAGE);
  }, [openId, rows, shown]);

  /* a lead arrived at from the palette has to end up on screen. the promise the search box
     makes is "here is that customer", and delivering the leads page scrolled to the top with
     the row open eighty places down is not that promise kept. */
  useEffect(() => {
    if (!openId) return;
    if (clicked.current) {
      clicked.current = false;
      return;
    }
    const row = document.querySelector(`[data-thread="${openId}"]`);
    row?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [openId, shown, reduced]);

  const visible = rows.slice(0, shown);

  return (
    <Panel
      title="leads"
      note={
        rows.length === threads.length
          ? `${formatCount(threads.length)} of ${formatCount(threadTotal)} in the window`
          : `${formatCount(rows.length)} matching · ${formatCount(threads.length)} loaded`
      }
      actions={
        /* exports what is on screen, filters and all. an export button that quietly ignores
           the filters above it hands somebody a spreadsheet that does not match the table
           they were looking at when they clicked it. */
        <button
          type="button"
          className="ws-btn"
          onClick={() =>
            downloadCsv(
              `${tenant.slug ?? 'arc'}-leads-${new Date().toISOString().slice(0, 10)}.csv`,
              threadsToCsv(rows, tenant.timezone),
            )
          }
          disabled={rows.length === 0}
        >
          <Icon name="download" />
          export {formatCount(rows.length)} rows
        </button>
      }
      bare
    >
      <div className="ws-toolbar">
        <label className="ws-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="name, phone, loss type or tech"
            aria-label="filter leads"
            spellCheck="false"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} title="clear">
              <Icon name="close" size={12} />
            </button>
          )}
        </label>

        <div className="ws-chips" role="group" aria-label="filter by source">
          {sourceOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`ws-chip${source === option.key ? ' is-on' : ''}`}
              onClick={() => setSource(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="ws-chips" role="group" aria-label="filter by outcome">
          {OUTCOMES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`ws-chip${outcome === option.key ? ' is-on' : ''}`}
              onClick={() => setOutcome(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="ws-select">
          <span>sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {Object.entries(SORTS).map(([key, option]) => (
              <option key={key} value={key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {threads.length === 0 ? (
        /* no leads at all is a different fact from no leads matching, and telling
           somebody to widen their filters when there is nothing behind them reads
           as the page blaming them for its own emptiness. */
        <EarlyData
          createdAt={tenant.createdAt}
          timezone={tenant.timezone}
          title="no leads yet"
        >
          the pipeline is live and watching. the first lead through your web form, your google
          business profile, or a call that rings out will appear here within seconds of it
          happening — with the exact time we texted them back.
        </EarlyData>
      ) : rows.length === 0 ? (
        <Empty title="nothing matches those filters">
          the window holds {formatCount(threads.length)} leads. clear the search or widen the
          filters to see them.
        </Empty>
      ) : (
        <>
        {/* the expansion is the best thing on this page and nobody finds it from a
            chevron alone. the hint retires itself the moment a row has been opened —
            a permanent instruction is a permanent admission the ui did not explain
            itself. */}
        {!openId && (
          <p className="ws-tablehint">
            <Icon name="chevron" size={11} className="ws-tablehint__chev" />
            open any row to see the exact timeline — call, text, routed, replied, to the second
          </p>
        )}
        <div className="ws-tablewrap">
          <table className="ws-table">
            <thead>
              <tr>
                <th>received</th>
                <th>customer</th>
                <th>source</th>
                <th>loss type</th>
                <th className="ws-table__num">response</th>
                <th>routed to</th>
                <th>outcome</th>
                <th aria-label="expand" />
              </tr>
            </thead>

            <tbody>
              {visible.map((thread) => {
                const isOpen = openId === thread.id;

                return [
                  <tr
                    key={thread.id}
                    className={`ws-table__row${isOpen ? ' is-open' : ''}`}
                    data-thread={thread.id}
                    onClick={() => toggleRow(thread.id)}
                  >
                    <td className="mono ws-td--time">
                      {formatStamp(thread.startedAt, tenant.timezone)}
                    </td>
                    <td className="ws-td--customer">
                      <span className="ws-table__strong">{thread.name ?? 'unknown caller'}</span>
                      <span className="ws-table__sub mono">{formatPhone(thread.phone)}</span>
                    </td>
                    <td className="ws-td--source">{thread.sourceLabel}</td>
                    <td className="ws-table__wide ws-td--loss">{thread.lossType ?? '—'}</td>
                    <td className="ws-table__num mono ws-td--response" data-label="answered in">
                      {thread.failed ? '—' : formatDuration(thread.latencyMs)}
                    </td>
                    <td className="ws-td--tech" data-label="routed to">{thread.tech ?? '—'}</td>
                    <td className="ws-td--outcome">
                      <Pill tone={STATE_TONE[thread.state] ?? 'neutral'}>{thread.state}</Pill>
                    </td>
                    <td className="ws-table__chev">
                      <Icon name="chevron" size={12} />
                    </td>
                  </tr>,

                  isOpen && (
                    <tr key={`${thread.id}-detail`} className="ws-table__detail">
                      <td colSpan={8}>
                        <div className="ws-detail">
                          <div className="ws-detail__steps">
                            {thread.steps.map((step, i) => (
                              <div
                                key={`${step.type}-${step.at}`}
                                className={`ws-detail__step${
                                  step.status === 'failure' ? ' is-fail' : ''
                                }`}
                              >
                                {i > 0 && <span className="ws-detail__rule" aria-hidden="true" />}
                                <span className="ws-detail__dot" aria-hidden="true" />
                                <span className="ws-detail__step-label">
                                  {STEP_LABEL[step.type] ?? step.type.replace(/_/g, ' ')}
                                </span>
                                <span className="ws-detail__step-time mono">
                                  {formatStamp(step.at, tenant.timezone)}
                                </span>
                              </div>
                            ))}
                          </div>

                          {thread.failureReason && (
                            <p className="ws-detail__fail">
                              <b>send failed:</b> {thread.failureReason}
                            </p>
                          )}

                          <p className="ws-detail__meta mono">
                            thread {thread.id}
                            {thread.repliedAt &&
                              ` · customer replied ${formatStamp(thread.repliedAt, tenant.timezone)}`}
                          </p>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {rows.length > visible.length && (
        <div className="ws-more">
          <button type="button" className="ws-btn" onClick={() => setShown((n) => n + PAGE)}>
            show {formatCount(Math.min(PAGE, rows.length - visible.length))} more
          </button>
          <span className="mono">
            {formatCount(visible.length)} of {formatCount(rows.length)} shown
          </span>
        </div>
      )}

      {threadTotal > threads.length && (
        <p className="ws-note">
          the {formatCount(threads.length)} most recent of {formatCount(threadTotal)} leads in the
          window are loaded, and the export covers those. the cap is deliberate — shipping the
          whole log to draw a table is how a dashboard ends up costing megabytes to show
          twenty rows. ask and we will pull any window you need in full.
        </p>
      )}
    </Panel>
  );
}
