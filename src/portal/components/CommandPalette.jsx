import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { NAV_ITEMS } from '../lib/nav';
import { formatDuration, formatPhone, formatStamp } from '../lib/format';

/**
 * ⌘K. one box that searches everything the portal knows about.
 *
 * the useful version of this is not a page jumper — it is "a customer called, what happened
 * to them". so leads are searchable by name, by phone and by loss type, and selecting one
 * lands on the leads table with that thread opened. a palette that only listed the eight
 * page names would be a keyboard shortcut for something the sidebar already does.
 *
 * matching is substring, not fuzzy. a contractor typing "kowal" wants the kowalczyk job,
 * and fuzzy matching's habit of confidently returning something else for a typo is worse
 * than returning nothing on this kind of search.
 */

const MAX_PER_GROUP = 6;

function normalise(value) {
  return String(value ?? '').toLowerCase();
}

export default function CommandPalette({
  open,
  onClose,
  base,
  data,
  actions = [],
  /* the ops console runs the same palette over its own pages and its own records
     — clients rather than leads. one implementation, because a second search box
     that behaved almost the same would be worse than either. */
  items = NAV_ITEMS,
  records = [],
  recordsLabel = 'records',
  placeholder = 'search a customer, a phone number, a page…',
  emptyHint = 'leads are searchable by name, phone, loss type or the tech they went to.',
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    /* focus after paint: focusing an input that is still being mounted loses the caret in
       safari, and this box is useless if you have to click it. */
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const results = useMemo(() => {
    const q = normalise(query).trim();
    const groups = [];

    const pages = items.filter(
      (item) => q === '' || normalise(item.label).includes(q) || normalise(item.blurb).includes(q),
    ).map((item) => ({
      id: `page:${item.label}`,
      kind: 'page',
      icon: item.icon,
      label: item.label,
      hint: item.blurb,
      run: () => navigate(item.to ? `${base}/${item.to}` : base),
    }));
    if (pages.length) groups.push({ label: 'pages', items: pages.slice(0, MAX_PER_GROUP) });

    /* records match on one character, unlike leads below. an ops console holds a
       dozen clients, not four hundred leads, so the two-character floor that keeps
       a lead search from dumping the whole table buys nothing here and costs the
       one keystroke it takes to find "cascade". */
    if (records.length > 0) {
      const matched = records
        .filter(
          (record) =>
            q === '' ||
            normalise(record.label).includes(q) ||
            normalise(record.hint).includes(q) ||
            normalise(record.keywords).includes(q),
        )
        .slice(0, MAX_PER_GROUP)
        .map((record) => ({ ...record, kind: 'record' }));
      if (matched.length) groups.push({ label: recordsLabel, items: matched });
    }

    if (q.length >= 2) {
      const leads = (data?.threads ?? [])
        .filter(
          (thread) =>
            normalise(thread.name).includes(q) ||
            normalise(thread.phone).includes(q) ||
            normalise(thread.lossType).includes(q) ||
            normalise(thread.tech).includes(q),
        )
        .slice(0, MAX_PER_GROUP)
        .map((thread) => ({
          id: `lead:${thread.id}`,
          kind: 'lead',
          icon: 'leads',
          label: thread.name ?? formatPhone(thread.phone),
          hint: `${formatStamp(thread.startedAt, data.tenant.timezone)} · ${thread.sourceLabel}${
            thread.latencyMs !== null ? ` · ${formatDuration(thread.latencyMs)}` : ''
          }`,
          run: () => navigate(`${base}/leads?thread=${encodeURIComponent(thread.id)}`),
        }));
      if (leads.length) groups.push({ label: 'leads', items: leads });

      const automations = (data?.automations ?? [])
        .filter((a) => normalise(a.name).includes(q) || normalise(a.id).includes(q))
        .slice(0, MAX_PER_GROUP)
        .map((automation) => ({
          id: `wf:${automation.id}`,
          kind: 'automation',
          icon: 'automations',
          label: automation.name,
          hint: `${automation.runs} runs · ${automation.state}`,
          run: () => navigate(`${base}/automations`),
        }));
      if (automations.length) groups.push({ label: 'automations', items: automations });
    }

    const matchedActions = actions
      .filter((action) => q === '' || normalise(action.label).includes(q))
      .map((action) => ({ ...action, kind: 'action', id: `action:${action.label}` }));
    if (matchedActions.length) groups.push({ label: 'actions', items: matchedActions });

    return groups;
  }, [query, data, actions, items, records, recordsLabel, base, navigate]);

  const flat = useMemo(() => results.flatMap((group) => group.items), [results]);

  useEffect(() => setCursor(0), [query]);

  /* keeps the highlighted row on screen when the cursor is driven from the keyboard past
     the fold. `nearest` rather than `center` so the list does not jump under the pointer
     on every keystroke. */
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results]);

  if (!open) return null;

  const choose = (item) => {
    onClose();
    item.run();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (flat.length === 0 ? 0 : (c + 1) % flat.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (flat.length === 0 ? 0 : (c - 1 + flat.length) % flat.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (flat[cursor]) choose(flat[cursor]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let index = -1;

  return (
    <div className="ws-cmd" role="dialog" aria-modal="true" aria-label="search">
      <button type="button" className="ws-cmd__scrim" onClick={onClose} tabIndex={-1} aria-hidden="true" />

      <div className="ws-cmd__box">
        <div className="ws-cmd__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="search the portal"
            spellCheck="false"
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </div>

        <div className="ws-cmd__list" ref={listRef}>
          {flat.length === 0 ? (
            <p className="ws-cmd__empty">
              nothing matches “{query}”. {emptyHint}
            </p>
          ) : (
            results.map((group) => (
              <div className="ws-cmd__group" key={group.label}>
                <p className="ws-cmd__group-label">{group.label}</p>

                {group.items.map((item) => {
                  index += 1;
                  const isCursor = index === cursor;
                  const myIndex = index;

                  return (
                    <button
                      type="button"
                      key={item.id}
                      data-cursor={isCursor}
                      className={`ws-cmd__row${isCursor ? ' is-cursor' : ''}`}
                      onPointerMove={() => setCursor(myIndex)}
                      onClick={() => choose(item)}
                    >
                      <Icon name={item.icon ?? 'chevron'} />
                      <span className="ws-cmd__row-label">{item.label}</span>
                      {item.hint && <span className="ws-cmd__row-hint">{item.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="ws-cmd__foot">
          <span>↑↓ move</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
