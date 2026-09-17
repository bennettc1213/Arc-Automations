import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from './Icon';
import { Empty, Panel } from './ui';
import { useReducedMotion } from '../../lib/hooks';
import { downloadCsv, toCsv } from '../lib/csv';
import { formatCount } from '../lib/format';

/**
 * one table, five modules.
 *
 * the leads page established what a record table in this product is: a dense list you scan,
 * sort and export, whose rows open into the exact sequence of what happened. the estimate
 * book, the review queue, the membership exceptions and the install closeouts are all the
 * same shape of thing, and four more hand-built copies of that table is four more places for
 * the filter behaviour, the empty state and the mobile restack to quietly diverge.
 *
 * so the table is one component and the modules are configuration: a column list, a filter
 * list, a sort map and a detail renderer. what is deliberately NOT configurable is any of
 * the behaviour that has to be identical everywhere — that a filtered export matches what is
 * on screen, that "nothing here" and "nothing matches" are different sentences, and that the
 * open row lives in the url so it can be sent to somebody.
 *
 * the leads page keeps its own table. it predates this one, its mobile card layout is
 * hand-placed column by column, and rewriting a working page to prove a point about reuse is
 * how working pages stop working.
 */

const PAGE = 40;

export default function RecordTable({
  title,
  records,
  recordTotal,
  columns,
  detail,
  filters = [],
  sorts,
  defaultSort,
  search,
  searchPlaceholder = 'search',
  searchLabel = 'filter records',
  emptyTitle,
  emptyBody,
  noMatchNoun = 'records',
  paramKey = 'record',
  rowId = (record) => record.id,
  rowTone,
  note,
  actions,
  csv,
  csvName = 'records',
  footNote,
}) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() =>
    Object.fromEntries(filters.map((f) => [f.key, params.get(f.key) ?? 'all'])),
  );
  const sortKeys = useMemo(() => Object.keys(sorts ?? {}), [sorts]);
  const [sort, setSort] = useState(defaultSort ?? sortKeys[0] ?? null);
  const [shown, setShown] = useState(PAGE);
  const reduced = useReducedMotion();

  /* set when the open row changed because somebody clicked it. a click already put the row
     under the pointer; scrolling it to the middle afterwards yanks the page out from under
     the person who clicked. */
  const clicked = useRef(false);
  const openId = params.get(paramKey);

  const toggleRow = (id) => {
    clicked.current = true;
    const next = new URLSearchParams(params);
    if (openId === id) next.delete(paramKey);
    else next.set(paramKey, id);
    setParams(next, { replace: true });
  };

  /* a filter arriving in the url — from the lifecycle strip, or a link somebody was sent —
     has to actually apply rather than being overwritten by the default on mount. */
  useEffect(() => {
    setActive((current) => {
      let changed = false;
      const next = { ...current };
      for (const filter of filters) {
        const fromUrl = params.get(filter.key);
        if (fromUrl && fromUrl !== current[filter.key]) {
          next[filter.key] = fromUrl;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();

    const filtered = records.filter((record) => {
      for (const filter of filters) {
        const chosen = active[filter.key] ?? 'all';
        if (chosen === 'all') continue;
        const option = filter.options.find((o) => o.key === chosen);
        if (option && !option.match(record)) return false;
      }
      if (!q || !search) return true;
      return String(search(record) ?? '').toLowerCase().includes(q);
    });

    return sort && sorts?.[sort] ? filtered.slice().sort(sorts[sort].compare) : filtered;
  }, [records, filters, active, query, search, sort, sorts]);

  /* back to the first page whenever the result set changes underneath. leaving it at
     "showing 120" after a filter that matches nine rows means the count in the header and
     the list below it are describing different things. */
  useEffect(() => setShown(PAGE), [query, active, sort]);

  useEffect(() => {
    if (!openId) return;
    const index = rows.findIndex((record) => rowId(record) === openId);
    if (index >= shown) setShown(Math.ceil((index + 1) / PAGE) * PAGE);
  }, [openId, rows, shown, rowId]);

  useEffect(() => {
    if (!openId) return;
    if (clicked.current) {
      clicked.current = false;
      return;
    }
    document
      .querySelector(`[data-record="${CSS.escape(openId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [openId, shown, reduced]);

  const visible = rows.slice(0, shown);
  const span = columns.length + (detail ? 1 : 0);

  const setFilter = (key, value) => {
    setActive((current) => ({ ...current, [key]: value }));
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <Panel
      title={title}
      note={
        note ??
        (rows.length === records.length
          ? `${formatCount(records.length)}${
              recordTotal && recordTotal > records.length
                ? ` of ${formatCount(recordTotal)}`
                : ''
            } in the window`
          : `${formatCount(rows.length)} matching · ${formatCount(records.length)} loaded`)
      }
      actions={
        <>
          {actions}
          {csv && (
            /* exports what is on screen, filters and all. an export that quietly ignores the
               filters above it hands somebody a spreadsheet that does not match the table
               they were looking at when they clicked. */
            <button
              type="button"
              className="ws-btn"
              onClick={() =>
                downloadCsv(
                  `${csvName}-${new Date().toISOString().slice(0, 10)}.csv`,
                  toCsv(csv, rows),
                )
              }
              disabled={rows.length === 0}
            >
              <Icon name="download" />
              export {formatCount(rows.length)} rows
            </button>
          )}
        </>
      }
      bare
    >
      {(search || filters.length > 0 || sortKeys.length > 1) && (
        <div className="ws-toolbar">
          {search && (
            <label className="ws-search">
              <Icon name="search" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchLabel}
                spellCheck="false"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} title="clear">
                  <Icon name="close" size={12} />
                </button>
              )}
            </label>
          )}

          {filters.map((filter) => (
            <div className="ws-chips" role="group" aria-label={filter.label} key={filter.key}>
              {filter.options.map((option) => {
                const count =
                  option.key === 'all'
                    ? records.length
                    : records.filter((record) => option.match(record)).length;
                return (
                  <button
                    key={option.key}
                    type="button"
                    className={`ws-chip${(active[filter.key] ?? 'all') === option.key ? ' is-on' : ''}`}
                    onClick={() => setFilter(filter.key, option.key)}
                    disabled={option.key !== 'all' && count === 0}
                  >
                    {option.label}
                    <em>{count}</em>
                  </button>
                );
              })}
            </div>
          ))}

          {sortKeys.length > 1 && (
            <label className="ws-select">
              <span>sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                {sortKeys.map((key) => (
                  <option key={key} value={key}>
                    {sorts[key].label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {records.length === 0 ? (
        <Empty title={emptyTitle}>{emptyBody}</Empty>
      ) : rows.length === 0 ? (
        <Empty title="nothing matches those filters">
          the window holds {formatCount(records.length)} {noMatchNoun}. clear the search or
          widen the filters to see them.
        </Empty>
      ) : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-rtable">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className={column.num ? 'ws-table__num' : undefined}>
                    {column.label}
                  </th>
                ))}
                {detail && <th aria-label="expand" />}
              </tr>
            </thead>

            <tbody>
              {visible.map((record) => {
                const id = rowId(record);
                const isOpen = openId === id;
                const tone = rowTone?.(record);

                return [
                  <tr
                    key={id}
                    className={`ws-table__row${isOpen ? ' is-open' : ''}${
                      tone ? ` ws-table__row--${tone}` : ''
                    }`}
                    data-record={id}
                    onClick={detail ? () => toggleRow(id) : undefined}
                  >
                    {columns.map((column, i) => (
                      <td
                        key={column.key}
                        /* the column header disappears on a phone, so every value carries
                           its own label. the first column is the card's headline and needs
                           none. */
                        data-label={i === 0 ? undefined : column.label}
                        className={[
                          column.num ? 'ws-table__num mono' : '',
                          column.wide ? 'ws-table__wide' : '',
                          i === 0 ? 'ws-rtd--lead' : '',
                          column.className ?? '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {column.render(record)}
                        {column.sub && <span className="ws-table__sub">{column.sub(record)}</span>}
                      </td>
                    ))}
                    {detail && (
                      <td className="ws-table__chev">
                        <Icon name="chevron" size={12} />
                      </td>
                    )}
                  </tr>,

                  isOpen && detail && (
                    <tr key={`${id}-detail`} className="ws-table__detail">
                      <td colSpan={span}>
                        <div className="ws-detail">{detail(record)}</div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
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

      {footNote && <p className="ws-note">{footNote}</p>}
    </Panel>
  );
}

/* the detail body every module's expanded row is built out of, so an opened estimate and an
   opened install are laid out the same way. */
export function DetailFacts({ rows }) {
  return (
    <dl className="ws-facts">
      {rows
        .filter((row) => row && row.value !== null && row.value !== undefined && row.value !== '')
        .map((row) => (
          <div className="ws-facts__row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/* a record's history, drawn as the same connected ticks the leads page uses for a pipeline.
   the sequence is the claim being made, so it is drawn as a sequence. */
export function DetailSteps({ steps }) {
  if (!steps?.length) return null;
  return (
    <div className="ws-detail__steps">
      {steps.map((step, i) => (
        <div
          key={`${step.label}-${step.at ?? i}`}
          className={`ws-detail__step${step.failed ? ' is-fail' : ''}`}
        >
          {i > 0 && <span className="ws-detail__rule" aria-hidden="true" />}
          <span className="ws-detail__dot" aria-hidden="true" />
          <span className="ws-detail__step-label">{step.label}</span>
          {step.at && <span className="ws-detail__step-time mono">{step.at}</span>}
        </div>
      ))}
    </div>
  );
}
