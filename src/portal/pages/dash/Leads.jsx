import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import EarlyData from '../../components/EarlyData';
import { Empty, Panel, Pill, StatCard } from '../../components/ui';
import { DetailFacts } from '../../components/RecordTable';
import { Freshness, RuleCheck, RuleList, Withheld } from '../../components/ModuleUI';
import { useReducedMotion } from '../../../lib/hooks';
import { downloadCsv, threadsToCsv } from '../../lib/csv';
import { SAFETY_FLAG_LABEL } from '../../lib/lifecycle';
import {
  formatCount,
  formatDuration,
  formatPct,
  formatPhone,
  formatStamp,
} from '../../lib/format';

/**
 * lead capture: every opportunity, and what happened to it.
 *
 * this is the page that settles arguments. an owner who thinks the phone was quiet last
 * Tuesday can open it, and a row that says a text went out in six seconds — with the
 * pipeline underneath it and the tech's name attached — is a different kind of answer from
 * a number on a chart.
 *
 * so it is a table, not a card grid. cards are for things you browse; this is something
 * people scan, sort and export, and a table is the shape that does that.
 *
 * the page grew to cover qualification, routing and human handoff without gaining columns.
 * the seven columns here are hand-placed into a phone card layout in workspace.css, and this
 * is the page a contractor opens from a truck — so the qualifier's verdict, the safety flags
 * and the consent record live in the expanded row rather than pushing the table sideways.
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
  { key: 'needs-you', label: 'needs you' },
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

function matchesOutcome(lead, outcome) {
  if (outcome === 'all') return true;
  if (outcome === 'needs-you') {
    return Boolean(lead.safetyBreach || lead.unacknowledged || (lead.handoff && !lead.handoff.resolvedAt));
  }
  return lead.state === outcome;
}

export default function Leads({ data }) {
  const { tenant, threadTotal } = data;
  /* the same array the rest of the workspace calls `threads`, carrying the qualifier's
     verdict and any handoff. one list, so this table and the overview's feed can never
     disagree about what happened to a lead. */
  const leads = data.threads;
  const m = data.leadCapture.metrics;
  const tz = tenant.timezone;

  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [outcome, setOutcome] = useState(() => params.get('view') === 'needs-you' ? 'needs-you' : 'all');
  const [sort, setSort] = useState('newest');
  const [shown, setShown] = useState(PAGE);
  const reduced = useReducedMotion();

  /* set when the open row changed because somebody clicked it. a click already put the row
     under the pointer, and scrolling it to the middle of the screen afterwards yanks the
     page out from under the person who clicked. */
  const clicked = useRef(false);

  /* the opened row lives in the url so the command palette can link straight to a lead and
     so a client can send someone the row rather than describing it. `record` is the name the
     needs-attention queue uses across every module; `thread` is what this page has always
     used and every existing link still carries. both are honoured. */
  const openId = params.get('thread') ?? params.get('record');

  const toggleRow = (id) => {
    clicked.current = true;
    const next = new URLSearchParams(params);
    next.delete('record');
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

    return leads
      .filter((lead) => {
        if (source !== 'all' && lead.source !== source) return false;
        if (!matchesOutcome(lead, outcome)) return false;
        if (!q) return true;
        return [lead.name, lead.phone, lead.lossType, lead.tech, lead.qualification?.jobType].some(
          (field) => String(field ?? '').toLowerCase().includes(q),
        );
      })
      .sort(SORTS[sort].compare);
  }, [leads, query, source, outcome, sort]);

  /* back to the first page whenever the result set changes underneath. leaving it at
     "showing 120" after a filter that matches nine rows means the count in the panel header
     and the list below it are describing different things. */
  useEffect(() => setShown(PAGE), [query, source, outcome, sort]);

  /* a lead opened from the command palette can be the hundredth row. without this the url
     says a thread is open and the table does not contain it, which reads as the search
     having silently failed. */
  useEffect(() => {
    if (!openId) return;
    const index = rows.findIndex((lead) => lead.id === openId);
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
    <>
      <div className="ws-stats">
        <StatCard
          label="opportunities in"
          value={m.opportunities}
          animate
          format={formatCount}
          sub={`${formatCount(m.missedCallsRecovered)} of them calls that rang out and got a text back`}
          tone="lead"
        />

        <StatCard
          label="median response"
          value={formatDuration(m.medianResponseMs)}
          sub={
            m.withinSlaPct === null
              ? 'nothing answered in this window yet'
              : `${formatPct(m.withinSlaPct)} inside your ${formatDuration(m.slaMs)} target`
          }
        />

        <StatCard
          label="qualified"
          value={m.qualificationSeen ? m.qualified : '—'}
          animate={m.qualificationSeen}
          format={formatCount}
          compact={!m.qualificationSeen}
          sub={
            m.qualificationSeen ? (
              'passed job type, service area and capacity'
            ) : (
              <Withheld>
                qualification is not running yet — leads are captured and routed without it, so
                this is not zero, it is unknown
              </Withheld>
            )
          }
        />

        <StatCard
          label="handed to a person"
          value={m.escalations}
          animate
          format={formatCount}
          sub="safety cases, distressed callers and anything your own rules mark human-only"
        />
      </div>

      <div className="ws-stats ws-stats--four">
        <StatCard
          label="nobody picked up"
          value={m.unacknowledged}
          compact
          sub="routed more than two hours ago with no acknowledgement and no reply"
        />
        <StatCard
          label="messages that failed"
          value={m.failedSends}
          compact
          sub="carrier or provider rejections in this window"
        />
        <StatCard
          label="inside target"
          value={formatPct(m.withinSlaPct)}
          compact
          sub={`answered within ${formatDuration(m.slaMs)}`}
        />
        <StatCard
          label="answered"
          value={m.answered}
          compact
          sub="leads that got a text back at all"
        />
      </div>

      <Freshness at={leads[0]?.startedAt ?? null} timezone={tz} label="newest lead" />

      <RuleList note="the safety rule, checked against the log">
        <RuleCheck
          rule="a safety case never gets booked by an automation"
          breaches={m.safetyBreaches}
          detail="electrical, gas, fire, smoke, flooding with a safety concern, medical distress, an angry or distressed caller, a complaint, an unclear scope, or anything you have marked human-only — the sequence stops and a person is put in front of it"
        />
      </RuleList>

      <Panel
        title="every lead"
        note={
          rows.length === leads.length
            ? `${formatCount(leads.length)} of ${formatCount(threadTotal)} in the window`
            : `${formatCount(rows.length)} matching · ${formatCount(leads.length)} loaded`
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
                threadsToCsv(rows, tz),
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

        {leads.length === 0 ? (
          /* no leads at all is a different fact from no leads matching, and telling
             somebody to widen their filters when there is nothing behind them reads
             as the page blaming them for its own emptiness. */
          <EarlyData createdAt={tenant.createdAt} timezone={tz} title="no leads yet">
            the pipeline is live and watching. the first lead through your web form, your google
            business profile, or a call that rings out will appear here within seconds of it
            happening — with the exact time we texted them back.
          </EarlyData>
        ) : rows.length === 0 ? (
          <Empty title="nothing matches those filters">
            the window holds {formatCount(leads.length)} leads. clear the search or widen the
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
                    <th>job type</th>
                    <th className="ws-table__num">response</th>
                    <th>routed to</th>
                    <th>outcome</th>
                    <th aria-label="expand" />
                  </tr>
                </thead>

                <tbody>
                  {visible.map((lead) => {
                    const isOpen = openId === lead.id;
                    const q = lead.qualification;

                    return [
                      <tr
                        key={lead.id}
                        className={`ws-table__row${isOpen ? ' is-open' : ''}${
                          lead.safetyBreach ? ' ws-table__row--attention' : ''
                        }`}
                        data-thread={lead.id}
                        data-record={lead.id}
                        onClick={() => toggleRow(lead.id)}
                      >
                        <td className="mono ws-td--time">{formatStamp(lead.startedAt, tz)}</td>
                        <td className="ws-td--customer">
                          <span className="ws-table__strong">{lead.name ?? 'unknown caller'}</span>
                          <span className="ws-table__sub mono">{formatPhone(lead.phone)}</span>
                        </td>
                        <td className="ws-td--source">{lead.sourceLabel}</td>
                        <td className="ws-table__wide ws-td--loss">
                          {q?.jobType ?? lead.lossType ?? '—'}
                          {/* urgency and service-area eligibility ride under the job type
                              rather than taking columns the phone layout cannot spare. */}
                          {(q?.urgency || q?.inServiceArea === false || lead.safetyFlags.length > 0) && (
                            <span className="ws-table__sub">
                              {lead.safetyFlags.length > 0
                                ? lead.safetyFlags
                                    .map((f) => SAFETY_FLAG_LABEL[f] ?? f)
                                    .join(' · ')
                                : q?.inServiceArea === false
                                  ? 'outside your service area'
                                  : q.urgency}
                            </span>
                          )}
                        </td>
                        <td className="ws-table__num mono ws-td--response" data-label="answered in">
                          {lead.failed ? '—' : formatDuration(lead.latencyMs)}
                        </td>
                        <td className="ws-td--tech" data-label="routed to">
                          {lead.routingDestination ?? '—'}
                        </td>
                        <td className="ws-td--outcome">
                          {lead.safetyBreach ? (
                            <Pill tone="fail">needs a person</Pill>
                          ) : lead.handoff && !lead.handoff.resolvedAt ? (
                            <Pill tone="warn">with a person</Pill>
                          ) : lead.unacknowledged ? (
                            <Pill tone="warn">not picked up</Pill>
                          ) : (
                            <Pill tone={STATE_TONE[lead.state] ?? 'neutral'}>{lead.state}</Pill>
                          )}
                        </td>
                        <td className="ws-table__chev">
                          <Icon name="chevron" size={12} />
                        </td>
                      </tr>,

                      isOpen && (
                        <tr key={`${lead.id}-detail`} className="ws-table__detail">
                          <td colSpan={8}>
                            <div className="ws-detail">
                              <div className="ws-detail__steps">
                                {lead.steps.map((step, i) => (
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
                                      {formatStamp(step.at, tz)}
                                    </span>
                                  </div>
                                ))}
                                {lead.handoff && (
                                  <div className="ws-detail__step is-fail">
                                    <span className="ws-detail__rule" aria-hidden="true" />
                                    <span className="ws-detail__dot" aria-hidden="true" />
                                    <span className="ws-detail__step-label">
                                      handed to a person
                                      {lead.handoff.assignedTo && ` — ${lead.handoff.assignedTo}`}
                                    </span>
                                    <span className="ws-detail__step-time mono">
                                      {formatStamp(lead.handoff.at, tz)}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {lead.failureReason && (
                                <p className="ws-detail__fail">
                                  <b>send failed:</b> {lead.failureReason}
                                </p>
                              )}

                              {lead.safetyBreach && (
                                <p className="ws-detail__fail">
                                  <b>this should not have been handled automatically.</b> it carries{' '}
                                  {lead.safetyFlags.map((f) => SAFETY_FLAG_LABEL[f] ?? f).join(', ')}{' '}
                                  and no handoff to a person was recorded against it.
                                </p>
                              )}

                              {q && (
                                <DetailFacts
                                  rows={[
                                    { label: 'job type', value: q.jobType },
                                    { label: 'urgency', value: q.urgency },
                                    {
                                      label: 'service area',
                                      value:
                                        q.inServiceArea === null
                                          ? null
                                          : q.inServiceArea
                                            ? `in area${q.zip ? ` · ${q.zip}` : ''}`
                                            : `outside your area${q.zip ? ` · ${q.zip}` : ''}`,
                                    },
                                    { label: 'property', value: q.propertyType },
                                    { label: 'customer', value: q.customerStatus },
                                    { label: 'scope', value: q.scope },
                                    {
                                      label: 'capacity',
                                      value:
                                        q.capacityOk === null
                                          ? null
                                          : q.capacityOk
                                            ? 'you can take this'
                                            : 'no capacity for this right now',
                                    },
                                    { label: 'preferred time', value: q.preferredTime },
                                    {
                                      label: 'consent',
                                      value: q.consent
                                        ? Object.entries(q.consent)
                                            .map(([channel, ok]) => `${channel}: ${ok ? 'yes' : 'no'}`)
                                            .join(' · ')
                                        : null,
                                    },
                                    { label: 'attributed to', value: q.sourceAttribution },
                                    {
                                      label: 'qualification',
                                      value: q.outcome
                                        ? q.outcome === 'qualified'
                                          ? 'qualified'
                                          : `not qualified — ${q.outcome}`
                                        : null,
                                    },
                                  ]}
                                />
                              )}

                              {lead.nextAction && (
                                <p className="ws-detail__next">
                                  <b>next:</b> {lead.nextAction}
                                </p>
                              )}

                              <p className="ws-detail__meta mono">
                                thread {lead.id}
                                {lead.repliedAt &&
                                  ` · customer replied ${formatStamp(lead.repliedAt, tz)}`}
                                {lead.acknowledgedAt &&
                                  ` · acknowledged ${formatStamp(lead.acknowledgedAt, tz)}`}
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

        {threadTotal > leads.length && (
          <p className="ws-note">
            the {formatCount(leads.length)} most recent of {formatCount(threadTotal)} leads in the
            window are loaded, and the export covers those. the cap is deliberate — shipping the
            whole log to draw a table is how a dashboard ends up costing megabytes to show
            twenty rows. ask and we will pull any window you need in full.
          </p>
        )}
      </Panel>
    </>
  );
}
