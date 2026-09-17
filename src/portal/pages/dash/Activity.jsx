import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import EventFeed from '../../components/EventFeed';
import EarlyData from '../../components/EarlyData';
import ModuleHealth from '../../components/ModuleHealth';
import { Empty, Panel, Pill } from '../../components/ui';
import { Freshness } from '../../components/ModuleUI';
import { ACTIVITY_GROUPS, matchesGroup } from '../../lib/activity';
import { formatCount, formatDuration, formatStamp } from '../../lib/format';

/**
 * the run log, and what is checking it.
 *
 * the overview's feed answers "what is happening"; this page answers "what exactly
 * happened, in order, with times". it is the page you open when a customer says nobody
 * called them back, and it has to be flat and boring and complete — a log that summarises
 * is a log that cannot be used as evidence.
 *
 * it now spans every module rather than the lead pipeline alone, which made one existing
 * decision worth revisiting. the internal verification rows used to be excluded outright,
 * on the grounds that a canary sitting in a list of customers reads as a customer who never
 * existed. that reasoning still holds for the default view, so they are still not in it —
 * but they are reachable behind their own filter, clearly labelled, because "show me what
 * checked this" is a fair question and the reliability page only answers it for one module.
 */

const ROW_LIMIT = 240;

export default function Activity({ data, live }) {
  const { tenant, threads, activity } = data;
  const tz = tenant.timezone;
  const [params, setParams] = useSearchParams();
  const [group, setGroup] = useState(() => params.get('module') ?? 'all');
  const [openId, setOpenId] = useState(null);

  /* the module filter is linkable, because the health panel and the needs-attention queue
     both send people here to look at one module's failures. */
  useEffect(() => {
    const fromUrl = params.get('module');
    if (fromUrl && fromUrl !== group) setGroup(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const choose = (key) => {
    setGroup(key);
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('module');
    else next.set('module', key);
    setParams(next, { replace: true });
  };

  const pool = useMemo(
    () => [...activity.rows, ...activity.verification],
    [activity.rows, activity.verification],
  );

  const counts = useMemo(() => {
    const map = {};
    for (const option of ACTIVITY_GROUPS) {
      map[option.key] = pool.filter((row) => matchesGroup(row, option.key)).length;
    }
    return map;
  }, [pool]);

  const filtered = useMemo(
    () => pool.filter((row) => matchesGroup(row, group)).slice(0, ROW_LIMIT),
    [pool, group],
  );

  const groups = ACTIVITY_GROUPS.filter(
    (option) => option.key === 'all' || counts[option.key] > 0,
  );

  return (
    <>
      <div className="ws-split">
        <div className="ws-col">
          <Panel
            title="run log"
            note={`${formatCount(filtered.length)} of ${formatCount(counts[group] ?? 0)} rows`}
            bare
          >
            <div className="ws-toolbar">
              <div className="ws-chips" role="group" aria-label="filter the run log">
                {groups.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`ws-chip${group === option.key ? ' is-on' : ''}`}
                    onClick={() => choose(option.key)}
                    disabled={option.key !== 'all' && !counts[option.key]}
                  >
                    {option.label}
                    <em>{counts[option.key] ?? 0}</em>
                  </button>
                ))}
              </div>
            </div>

            {pool.length === 0 ? (
              <EarlyData
                createdAt={tenant.createdAt}
                timezone={tz}
                title="nothing has run yet"
              >
                this is the raw log — every step of every automation, in order, with times. it
                stays empty until the first thing runs, and then it never forgets one. it is the
                page to open when somebody says nobody called them back.
              </EarlyData>
            ) : filtered.length === 0 ? (
              <Empty title="no rows of that kind in the window">
                the log holds {formatCount(pool.length)} rows. pick another filter, or
                everything, to see them.
              </Empty>
            ) : (
              <div className="ws-tablewrap">
                <table className="ws-table ws-table--dense">
                  <thead>
                    <tr>
                      <th>time</th>
                      <th>event</th>
                      <th>module</th>
                      <th>record</th>
                      <th className="ws-table__num">took</th>
                      <th>result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => [
                      <tr
                        key={row.id}
                        className={`ws-log__row${openId === row.id ? ' is-open' : ''}`}
                        onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      >
                        <td className="mono">{formatStamp(row.at, tz)}</td>
                        <td className="ws-table__strong">
                          {row.label}
                          {row.actor === 'human' && <span className="ws-table__sub">by a person</span>}
                        </td>
                        <td>{row.moduleLabel}</td>
                        <td className="mono ws-table__sub">
                          {row.entityId ? `${row.entityType ?? 'record'} ${String(row.entityId).slice(0, 8)}` : '—'}
                        </td>
                        <td className="ws-table__num mono">
                          {row.latencyMs === null ? '—' : formatDuration(row.latencyMs)}
                        </td>
                        <td>
                          <Pill tone={row.failed ? 'fail' : row.isVerification ? 'idle' : 'ok'}>
                            {row.failed ? (row.errorClass ?? 'failed') : row.isVerification ? 'check' : 'ok'}
                          </Pill>
                        </td>
                      </tr>,

                      openId === row.id && (
                        <tr key={`${row.id}-detail`} className="ws-table__detail">
                          <td colSpan={6}>
                            <div className="ws-detail">
                              <dl className="ws-facts">
                                {[
                                  ['event type', row.type],
                                  ['module', row.moduleLabel],
                                  ['occurred', formatStamp(row.at, tz)],
                                  ['recorded', row.recordedAt ? formatStamp(row.recordedAt, tz) : null],
                                  ['record', row.entityId ? `${row.entityType ?? 'record'} · ${row.entityId}` : null],
                                  ['source system', row.sourceSystem],
                                  ['their record id', row.externalId],
                                  ['automation', row.workflowId],
                                  ['run', row.executionId],
                                  ['thread', row.correlationId],
                                  ['idempotency key', row.idempotencyKey],
                                  ['actor', row.actor],
                                  ['error class', row.errorClass],
                                ]
                                  .filter(([, value]) => value)
                                  .map(([label, value]) => (
                                    <div className="ws-facts__row" key={label}>
                                      <dt>{label}</dt>
                                      <dd className="mono">{value}</dd>
                                    </div>
                                  ))}
                                {row.meta.map(([key, value]) => (
                                  <div className="ws-facts__row" key={`meta-${key}`}>
                                    <dt>{key.replace(/_/g, ' ')}</dt>
                                    <dd className="mono">{value}</dd>
                                  </div>
                                ))}
                              </dl>
                            </div>
                          </td>
                        </tr>
                      ),
                    ])}
                  </tbody>
                </table>
              </div>
            )}

            <Freshness at={activity.rows[0]?.at ?? null} timezone={tz} label="newest row" />

            <p className="ws-note">
              customer contact details and anything that looks like a credential are stripped
              from these rows before they reach this page. the record tables carry the contact
              details where they belong; a run log does not need them to be a log, and the
              fewer places they appear the fewer there are to get wrong.
              {group !== 'verification' && counts.verification > 0 && (
                <>
                  {' '}
                  internal verification rows — the canary, schema asserts, watermark checks —
                  are kept out of this view on purpose: they travel the same live pipeline and
                  would sit in here looking like customers who never existed.{' '}
                  <button type="button" className="ws-linkbtn" onClick={() => choose('verification')}>
                    show them on their own
                  </button>
                  .
                </>
              )}
            </p>
          </Panel>
        </div>

        <EventFeed threads={threads.slice(0, 30)} timezone={tz} live={live} title="by lead" />
      </div>

      <ModuleHealth
        health={data.health}
        timezone={tz}
        title="system health"
        note="what is checking each module, and what it last said"
      />
    </>
  );
}
