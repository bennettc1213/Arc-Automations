import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { Empty, Panel, Pill, Term } from './ui';
import { ActionButton, Notice, SelectInput, TextInput } from './ops-ui';
import { formatPhone } from '../lib/format';
import { isNotDeployed } from '../lib/crm';
import {
  filterLeads, inboxStates, INBOX_QUEUES, lockedFields, queueCounts, QUEUE_WORDS, SORTS, sortLeads, taskBucket, createdElsewhere,
} from '../../../supabase/functions/_shared/crm/inbox.ts';
import { ago, ContactDetail, LeadDetail, moveLead, ownerOptions, personLabel, QuickAdd, SOURCE_WORDS, STATUS_TONE, ThreadOnly, useChange, when } from './CrmRecord';
import { Conversations } from './CrmConversation';
import '../ops.css';
import './CrmWorkspace.css';

/**
 * ARC-360 — the day-to-day CRM workspace: the lead inbox, the pipeline board, tasks, customers —
 * and, since ARC-370, the conversations with them (CrmConversation.jsx).
 *
 * One component for both sides. A client's dashboard and the operator's console pass it an
 * `api` (lib/crm.js) pointed at their own door, and the demo passes one over generated rows;
 * nothing below knows which. The screen decides nothing: which leads need attention is
 * `inbox.ts` (shared with the tests) read over the server's rows, and every change is one
 * call the server answers, refusals included.
 *
 * None of this is a figure. A lead in a won stage is what a person set, and is shown as that.
 */

const TABS = [
  ['inbox', 'inbox'],
  ['board', 'pipeline'],
  ['tasks', 'tasks'],
  ['customers', 'customers'],
  ['conversations', 'conversations'],
  ['stages', 'stages'],
];
const SORT_WORDS = { newest: 'newest first', oldest: 'oldest first', next_due: 'next task due', priority: 'priority', updated: 'last changed' };
const PRIORITY_TONE = { urgent: 'fail', high: 'warn' };

/* ── the inbox: queues, search, filters, a list ─────────── */

function Signals({ state }) {
  return (
    <span className="crm-signals">
      {state.blocked.length > 0 && <Pill tone="warn" title={state.blocked.map((b) => b.detail).join(' · ')}><Term k="blocked">blocked</Term></Pill>}
      {state.overdue && <Pill tone="warn"><Term k="overdue">overdue</Term></Pill>}
      {state.untouched && <Pill tone="idle"><Term k="untouched">not contacted</Term></Pill>}
      {state.waiting && <Pill tone="neutral"><Term k="waiting">waiting on customer</Term></Pill>}
      {state.closed && <Pill tone={STATUS_TONE[state.lead.status]}><Term k={state.lead.status}>{state.lead.status}</Term></Pill>}
      {PRIORITY_TONE[state.lead.priority] && !state.closed && <Pill tone={PRIORITY_TONE[state.lead.priority]}>{state.lead.priority}</Pill>}
      {!state.closed && !state.waiting && !state.untouched && !state.next_task && <span className="ops-muted">no next step</span>}
    </span>
  );
}

function BulkBar({ api, ws, selected, clear, reload }) {
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  const [refused, setRefused] = useState([]);
  const stages = ws.pipelines.flatMap((p) => p.stages.filter((s) => !s.archived_at && s.kind !== 'lost').map((s) => ({ value: s.id, label: ws.pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name })));
  const apply = (change, word) => async () => {
    const result = await api.bulk([...selected], change);
    setRefused(result.refused);
    await reload();
    if (result.refused.length === 0) clear();
    return `${result.updated.length} ${word}${result.refused.length ? ` · ${result.refused.length} refused` : ''}`;
  };
  return (
    <div className="crm-bulk" role="region" aria-label="change the chosen leads">
      <b>{selected.size} chosen</b>
      <SelectInput aria-label="move the chosen leads to" value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: '', label: 'move to…' }, ...stages]} />
      <ActionButton disabled={!stage} onRun={apply({ stage_id: stage }, 'moved')}>move</ActionButton>
      {ws.viewer.may.sensitive && (
        <>
          <SelectInput aria-label="hand the chosen leads to" value={owner} onChange={(e) => setOwner(e.target.value)} options={ownerOptions(ws.people, null, { none: 'hand to…' })} />
          <ActionButton disabled={!owner} onRun={apply({ owner_user_id: owner }, 'handed over')}>hand over</ActionButton>
        </>
      )}
      <button type="button" className="ws-btn" onClick={clear}>clear</button>
      <span className="ops-muted">each lead is changed on its own and gets its own history entry.</span>
      {refused.length > 0 && (
        <ul className="crm-items" role="alert">
          {refused.map((r) => {
            const lead = ws.leads.find((l) => l.id === r.lead_id);
            return <li key={r.lead_id} className="crm-item"><b>{lead?.title ?? 'a lead'}</b> was not changed: {r.message}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

function Inbox({ api, ws, states, timezone, readOnly, onOpen, reload }) {
  const [filter, setFilter] = useState({ queue: 'attention', text: '', stage_id: '', owner: '', source: '', priority: '' });
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState(() => new Set());
  const set = (patch) => setFilter((f) => ({ ...f, ...patch }));
  const viewerId = ws.viewer.user_id;
  const counts = useMemo(() => queueCounts(states, viewerId), [states, viewerId]);
  const rows = useMemo(() => sortLeads(filterLeads(states, filter, viewerId), sort), [states, filter, sort, viewerId]);
  const sources = [...new Set(ws.leads.map((l) => l.source))];
  const stages = ws.pipelines.flatMap((p) => p.stages.filter((s) => !s.archived_at));
  const canBulk = !readOnly && ws.viewer.may.record;
  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      <div className="crm-queues" role="group" aria-label="which leads to show">
        {INBOX_QUEUES.map((queue) => (
          <button key={queue} type="button" className={`ws-btn${filter.queue === queue ? ' ws-btn--primary' : ''}`} aria-pressed={filter.queue === queue} onClick={() => set({ queue })}>
            <Term k={queue}>{QUEUE_WORDS[queue]}</Term> <span className="crm-count">{counts[queue]}</span>
          </button>
        ))}
      </div>

      <div className="crm-filters">
        <TextInput type="search" aria-label="search leads by name, phone, email or what it is about" placeholder="search name, phone, email…" value={filter.text} onChange={(e) => set({ text: e.target.value })} />
        <SelectInput aria-label="stage" value={filter.stage_id} onChange={(e) => set({ stage_id: e.target.value })} options={[{ value: '', label: 'any stage' }, ...stages.map((s) => ({ value: s.id, label: s.name }))]} />
        <SelectInput aria-label="owner" value={filter.owner} onChange={(e) => set({ owner: e.target.value })} options={[{ value: '', label: 'any owner' }, { value: 'none', label: 'no owner' }, ...ws.people.map((p) => ({ value: p.user_id, label: p.label }))]} />
        <SelectInput aria-label="how it arrived" value={filter.source} onChange={(e) => set({ source: e.target.value })} options={[{ value: '', label: 'any source' }, ...sources.map((s) => ({ value: s, label: SOURCE_WORDS[s] ?? s }))]} />
        <SelectInput aria-label="priority" value={filter.priority} onChange={(e) => set({ priority: e.target.value })} options={[{ value: '', label: 'any priority' }, ...['urgent', 'high', 'normal', 'low'].map((p) => ({ value: p, label: p }))]} />
        <SelectInput aria-label="order" value={sort} onChange={(e) => setSort(e.target.value)} options={SORTS.map((s) => ({ value: s, label: SORT_WORDS[s] }))} />
      </div>

      {canBulk && selected.size > 0 && <BulkBar api={api} ws={ws} selected={selected} clear={() => setSelected(new Set())} reload={reload} />}

      {rows.length === 0 ? (
        <Empty title={states.length === 0 ? 'no leads yet' : 'nothing in this view'}>
          {states.length === 0
            ? 'a lead from a form, a file, a call or one typed in here shows up in this inbox.'
            : `${QUEUE_WORDS[filter.queue]} is empty with these filters. "all open" shows every lead still being worked.`}
        </Empty>
      ) : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense crm-table">
            <thead>
              <tr>
                {canBulk && <th><span className="crm-sr">choose</span></th>}
                <th>customer</th>
                <th>about</th>
                <th>stage</th>
                <th>owner</th>
                <th>next step</th>
                <th>why it is here</th>
                <th>arrived</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((state) => {
                const { lead, contact, stage, next_task: next } = state;
                return (
                  <tr key={lead.id} className="ws-table__row">
                    {canBulk && (
                      <td>
                        <input type="checkbox" aria-label={`choose ${lead.title}`} checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} />
                      </td>
                    )}
                    <td>
                      <button type="button" className="crm-link" onClick={() => onOpen({ kind: 'lead', id: lead.id })}>{contact?.display_name ?? 'unknown'}</button>
                      <span className="crm-item__meta">{contact?.phone ? formatPhone(contact.phone) : contact?.email ?? ''}</span>
                    </td>
                    <td>{lead.title}<span className="crm-item__meta">{SOURCE_WORDS[lead.source] ?? lead.source}</span></td>
                    <td>{stage?.name ?? '—'}</td>
                    <td>{personLabel(ws.people, lead.owner_user_id) ?? <span className="ops-muted"><Term k="unowned">no owner</Term></span>}</td>
                    <td>
                      {next ? <>{next.title}<span className="crm-item__meta">{next.due_at ? `due ${when(next.due_at, timezone)}` : 'no due date'}</span></> : <span className="ops-muted">{state.closed ? '—' : 'none'}</span>}
                    </td>
                    <td><Signals state={state} /></td>
                    <td><span title={when(lead.created_at, timezone)}>{ago(lead.created_at, timezone)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(ws.truncated.open || ws.truncated.closed) && (
        <p className="ws-note">this view holds the newest {ws.truncated.open ? '500 open' : '200 closed'} leads. older ones are kept and are found from their customer.</p>
      )}
    </>
  );
}

/* ── the board ──────────────────────────────────────────── */

function Board({ api, ws, states, timezone, readOnly, onOpen, reload }) {
  const [pipelineId, setPipelineId] = useState(() => (ws.pipelines.find((p) => p.is_default) ?? ws.pipelines[0])?.id);
  const [over, setOver] = useState(null);
  const change = useChange();
  const pipeline = ws.pipelines.find((p) => p.id === pipelineId) ?? ws.pipelines[0];
  if (!pipeline) return <Empty title="no pipeline yet">the first lead makes one.</Empty>;
  const locked = lockedFields(ws.policies.lead).includes('stage_id');
  const canMove = !readOnly && ws.viewer.may.record && !locked;
  const stages = pipeline.stages.filter((s) => !s.archived_at);
  const inStage = (stage) => states.filter((s) => s.lead.stage_id === stage.id);
  const move = (leadId, stage) => {
    const lead = ws.leads.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === stage.id) return;
    change.run(async () => {
      if (await moveLead(api, lead, stage)) await reload();
    }, `moved to ${stage.name}`);
  };

  return (
    <>
      <div className="ops-row">
        {ws.pipelines.length > 1 && (
          <SelectInput aria-label="pipeline" value={pipeline.id} onChange={(e) => setPipelineId(e.target.value)} options={ws.pipelines.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        {locked && <span className="ops-muted"><Term k="kept_elsewhere">stages are kept in {ws.policies.lead.connectorKey ?? 'their system'}</Term> — move a lead there.</span>}
        {change.note}
      </div>
      <div className="crm-board" role="list" aria-label={`${pipeline.name} pipeline`}>
        {stages.map((stage) => {
          const cards = inStage(stage);
          return (
            <section
              key={stage.id}
              role="listitem"
              className={`crm-col${over === stage.id ? ' is-over' : ''}${stage.kind !== 'open' ? ' crm-col--closed' : ''}`}
              onDragOver={canMove ? (e) => { e.preventDefault(); setOver(stage.id); } : undefined}
              onDragLeave={() => setOver((id) => (id === stage.id ? null : id))}
              onDrop={canMove ? (e) => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/plain'), stage); } : undefined}
            >
              <header className="crm-col__head">
                <h4>{stage.name}</h4>
                <span className="crm-count">{cards.length}</span>
                {stage.kind !== 'open' && <Term k={stage.kind}>{stage.kind}</Term>}
                {stage.kind === 'open' && stage.waits_on === 'customer' && <Term k="waiting">waiting on customer</Term>}
              </header>
              {cards.length === 0 && <p className="crm-col__empty">empty</p>}
              {cards.map((state) => (
                <div key={state.lead.id} className="crm-card" draggable={canMove} onDragStart={(e) => e.dataTransfer.setData('text/plain', state.lead.id)}>
                  <button type="button" className="crm-link" onClick={() => onOpen({ kind: 'lead', id: state.lead.id })}>{state.contact?.display_name ?? 'unknown'}</button>
                  <p className="crm-card__title">{state.lead.title}</p>
                  <p className="crm-item__meta">
                    {personLabel(ws.people, state.lead.owner_user_id) ?? 'no owner'}
                    {state.next_task ? ` · ${state.next_task.title}${state.next_task.due_at ? `, ${when(state.next_task.due_at, timezone)}` : ''}` : ''}
                  </p>
                  <Signals state={{ ...state, closed: false, untouched: false, waiting: false }} />
                  {canMove && (
                    <SelectInput
                      aria-label={`move ${state.lead.title} to`}
                      className="crm-card__move"
                      value={stage.id}
                      disabled={change.busy}
                      onChange={(e) => move(state.lead.id, stages.find((s) => s.id === e.target.value))}
                      options={stages.map((s) => ({ value: s.id, label: s.id === stage.id ? `in ${s.name}` : `move to ${s.name}` }))}
                    />
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <p className="ws-note">drag a card, or use its menu. every move is written to the lead&rsquo;s history with who made it. a won stage is what a person set here — it is not counted as a proven result anywhere.</p>
    </>
  );
}

/* ── tasks ──────────────────────────────────────────────── */

const BUCKETS = [['overdue', 'overdue'], ['today', 'due today'], ['upcoming', 'coming up'], ['undated', 'no due date'], ['done', 'recently done']];

function Tasks({ api, ws, timezone, readOnly, onOpen, reload }) {
  const change = useChange();
  const [mine, setMine] = useState(false);
  const now = new Date();
  const tasks = ws.tasks.filter((t) => t.status !== 'cancelled' && (!mine || t.assigned_user_id === ws.viewer.user_id));
  if (ws.tasks.length === 0) return <Empty title="no tasks">a next step added on a lead shows here, with when it is due.</Empty>;
  const canWrite = !readOnly && ws.viewer.may.record;
  return (
    <>
      <div className="ops-row">
        <label className="crm-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> only mine</label>
        {change.note}
      </div>
      {BUCKETS.map(([bucket, label]) => {
        const rows = tasks.filter((t) => taskBucket(t, now, timezone) === bucket)
          .sort((a, b) => String(a.due_at ?? a.created_at).localeCompare(String(b.due_at ?? b.created_at)));
        if (rows.length === 0) return null;
        return (
          <section key={bucket} className="crm-section">
            <h4>{bucket === 'overdue' ? <Term k="overdue">overdue</Term> : label} <span className="crm-count">{rows.length}</span></h4>
            <ul className="crm-items">
              {rows.map((task) => {
                const lead = ws.leads.find((l) => l.id === task.lead_id);
                const contact = ws.contacts.find((c) => c.id === (lead?.contact_id ?? task.contact_id));
                return (
                  <li key={task.id} className={`crm-item${task.status === 'done' ? ' is-done' : ''}`}>
                    <label className="crm-check">
                      <input
                        type="checkbox"
                        checked={task.status === 'done'}
                        disabled={!canWrite || change.busy}
                        aria-label={task.status === 'done' ? `reopen "${task.title}"` : `mark "${task.title}" done`}
                        onChange={() => change.run(async () => {
                          await api.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' });
                          await reload();
                        }, task.status === 'done' ? 'reopened' : 'done')}
                      />
                      <span>{task.title}</span>
                    </label>
                    <span className="crm-item__meta">
                      {(lead || contact) && (
                        <button type="button" className="crm-link" onClick={() => onOpen(lead ? { kind: 'lead', id: lead.id } : { kind: 'contact', id: contact.id })}>
                          {contact?.display_name ?? lead?.title}
                        </button>
                      )}
                      {task.due_at ? ` · due ${when(task.due_at, timezone)}` : ''}
                      {task.assigned_user_id ? ` · ${personLabel(ws.people, task.assigned_user_id)}` : ' · anybody'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/* ── customers ──────────────────────────────────────────── */

function Customers({ ws, states, timezone, onOpen }) {
  const [text, setText] = useState('');
  const q = text.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const rows = ws.contacts
    .filter((c) => !q || [c.display_name, c.email, c.city].filter(Boolean).join(' ').toLowerCase().includes(q) || (digits.length >= 3 && String(c.phone ?? '').replace(/\D/g, '').includes(digits)))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  return (
    <>
      <div className="crm-filters">
        <TextInput type="search" aria-label="search customers by name, phone or email" placeholder="search name, phone, email…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {rows.length === 0 ? <Empty title="no customers here">{ws.contacts.length === 0 ? 'a customer is added with their first lead.' : 'nobody matches that search.'}</Empty> : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense crm-table">
            <thead><tr><th>customer</th><th>phone</th><th>email</th><th>open leads</th><th>since</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="ws-table__row">
                  <td><button type="button" className="crm-link" onClick={() => onOpen({ kind: 'contact', id: c.id })}>{c.display_name}</button></td>
                  <td>{c.phone ? formatPhone(c.phone) : '—'}</td>
                  <td>{c.email ?? '—'}</td>
                  <td>{states.filter((s) => s.lead.contact_id === c.id && !s.closed).length}</td>
                  <td>{when(c.created_at, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ws-note">customers with a lead or a task in this workspace. everything else about one is on their own page.</p>
    </>
  );
}

/* ── stages ─────────────────────────────────────────────── */

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 40);

function Stages({ api, ws, reload }) {
  const pipeline = ws.pipelines.find((p) => p.is_default) ?? ws.pipelines[0];
  const [rows, setRows] = useState(() => (pipeline?.stages ?? []).map((s) => ({ id: s.id, key: s.key, name: s.name, kind: s.kind, waits_on: s.waits_on, marks_qualified: s.marks_qualified, retired: Boolean(s.archived_at) })));
  const [fresh, setFresh] = useState('');
  if (!pipeline) return <Empty title="no pipeline yet">the first lead makes one.</Empty>;
  const patch = (index, change) => setRows((list) => list.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const shift = (index, by) => setRows((list) => {
    const next = [...list];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    return next;
  });
  const key = slug(fresh);
  return (
    <>
      <p className="ops-muted">the stages of <b>{pipeline.name}</b>, in order. a stage can be renamed, moved, added or retired. what it means — open, won or lost — is fixed when it is made, because every lead in it takes its status from that.</p>
      <ul className="crm-stages">
        {rows.map((row, index) => (
          <li key={row.id ?? row.key} className={row.retired ? 'is-retired' : ''}>
            <span className="crm-stages__order">
              <button type="button" className="ws-btn" aria-label={`move ${row.name} earlier`} disabled={index === 0} onClick={() => shift(index, -1)}>↑</button>
              <button type="button" className="ws-btn" aria-label={`move ${row.name} later`} disabled={index === rows.length - 1} onClick={() => shift(index, 1)}>↓</button>
            </span>
            <TextInput aria-label={`name of the stage ${row.key}`} value={row.name} maxLength={120} onChange={(e) => patch(index, { name: e.target.value })} />
            <Term k={row.kind}>{row.kind}</Term>
            {row.kind === 'open' ? (
              <SelectInput aria-label={`what a lead in ${row.name} is waiting on`} value={row.waits_on} onChange={(e) => patch(index, { waits_on: e.target.value })} options={[{ value: 'us', label: 'waiting on us' }, { value: 'customer', label: 'waiting on the customer' }]} />
            ) : <span />}
            <label className="crm-check"><input type="checkbox" checked={row.retired} onChange={(e) => patch(index, { retired: e.target.checked })} /> retired</label>
          </li>
        ))}
      </ul>
      <div className="ops-row">
        <TextInput aria-label="name of a new stage" placeholder="a new stage, e.g. Site visit booked" value={fresh} maxLength={120} onChange={(e) => setFresh(e.target.value)} />
        <button
          type="button"
          className="ws-btn"
          disabled={key.length < 2 || rows.some((r) => r.key === key) || rows.length >= 20}
          onClick={() => {
            /* a new open stage goes in before the first closed one. */
            const at = rows.findIndex((r) => r.kind !== 'open');
            const row = { key, name: fresh.trim(), kind: 'open', waits_on: 'us', marks_qualified: false, retired: false };
            setRows((list) => (at === -1 ? [...list, row] : [...list.slice(0, at), row, ...list.slice(at)]));
            setFresh('');
          }}
        >
          <Icon name="plus" size={13} /> add the stage
        </button>
      </div>
      <div className="ops-row">
        <ActionButton
          variant="primary"
          icon="check"
          confirm="save these stages? the board changes for everyone on the team. a stage that still has open leads cannot be retired, and no lead is moved or closed by this."
          onRun={async () => {
            await api.saveStages(pipeline.id, rows.map((r) => (r.id
              ? { id: r.id, name: r.name, waits_on: r.waits_on, marks_qualified: r.marks_qualified, retired: r.retired }
              : { key: r.key, name: r.name, kind: r.kind, waits_on: r.waits_on })));
            await reload();
            return 'saved';
          }}
        >
          save the stages
        </ActionButton>
      </div>
    </>
  );
}

/* ── the workspace ──────────────────────────────────────── */

/** the read failed: either the backend is not there yet (and what fixes that), or the server's own words. */
export function WorkspaceError({ error, door, onRetry }) {
  return (
    <Panel title="lead inbox">
      {isNotDeployed(error) ? (
        <Notice tone="warn" title="the lead inbox is not switched on here yet">
          {door === 'ops'
            ? <p>apply <code>0025_crm_workspace.sql</code>, then redeploy the <code>ops</code> function and deploy <code>crm</code> — this page reads and writes through them.</p>
            : <p>this part of your workspace is still being set up. nothing is wrong with your leads — get in touch and we will switch it on.</p>}
        </Notice>
      ) : (
        <Notice tone="fail" title="your leads could not be read">
          <p>{error?.message ?? 'unknown error'}</p>
          <button type="button" className="ws-btn" onClick={onRetry}><Icon name="refresh" size={13} /> try again</button>
        </Notice>
      )}
    </Panel>
  );
}

/**
 * `api` is lib/crm.js's `crmApi(door, tenantId)`, or the demo's. `initial` draws the panel
 * from a known answer (the tests, the demo's first paint).
 */
export default function CrmWorkspace({ api, timezone: zone, readOnly: forcedReadOnly = false, initial = null }) {
  const [state, setState] = useState(initial ? { kind: 'ready', ws: initial } : { kind: 'loading' });
  const [tab, setTab] = useState('inbox');
  const [open, setOpen] = useState(null); // { kind: 'lead' | 'contact', id }
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState({ kind: 'ready', ws: await api.workspace() });
    } catch (error) {
      setState((prev) => (prev.kind === 'ready' ? { ...prev, stale: error.message } : { kind: 'error', error }));
    }
  }, [api]);
  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const ws = state.kind === 'ready' ? state.ws : null;
  const states = useMemo(() => (ws ? inboxStates(ws) : []), [ws]);
  const timezone = zone ?? ws?.tenant.timezone ?? 'UTC';
  const readOnly = forcedReadOnly || api.readOnly;

  if (state.kind === 'loading') return <Panel title="lead inbox"><p className="ops-muted">reading your leads…</p></Panel>;
  if (state.kind === 'error') return <WorkspaceError error={state.error} door={api.door} onRetry={reload} />;

  const counts = queueCounts(states, ws.viewer.user_id);
  const canAdd = !readOnly && ws.viewer.may.record && !createdElsewhere(ws.policies.lead);
  const tabs = TABS.filter(([key]) => key !== 'stages' || (!readOnly && ws.viewer.may.business));
  const view = { api, ws, states, timezone, readOnly, onOpen: setOpen, reload };

  return (
    <Panel
      title="lead inbox"
      note={`${counts.open} open · ${counts.attention} need attention · ${counts.waiting} waiting on the customer`}
      actions={!readOnly && ws.viewer.may.record && (
        <button type="button" className="ws-btn ws-btn--primary" disabled={!canAdd} onClick={() => setAdding((v) => !v)} title={canAdd ? undefined : `leads are created in ${ws.policies.lead.connectorKey ?? 'their system'}`}>
          <Icon name="plus" size={13} /> add a lead
        </button>
      )}
    >
      {state.stale && <Notice tone="warn" title="this may be out of date"><p>the last refresh failed: {state.stale}</p></Notice>}
      {api.readOnly && api.door === 'demo' && <p className="ws-note">generated leads for a fictional company. the demo is read-only: moving a card or adding a note is refused, and says so.</p>}
      {createdElsewhere(ws.policies.lead) && (
        <p className="ws-note"><Term k="kept_elsewhere">leads are kept in {ws.policies.lead.connectorKey ?? 'their system'}</Term>. they are shown here to work from; they are created and edited there.</p>
      )}
      {adding && canAdd && (
        <QuickAdd
          api={api}
          services={ws.services}
          onClose={() => setAdding(false)}
          onAdded={async (arrival) => {
            await reload();
            if (arrival.lead_id) setOpen({ kind: 'lead', id: arrival.lead_id });
          }}
        />
      )}

      <nav className="crm-tabs" aria-label="views of your leads">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" className={`ws-btn${key === tab ? ' ws-btn--primary' : ''}`} aria-pressed={key === tab} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      <div className={`crm-split${open ? ' has-record' : ''}`}>
        <div className="crm-split__main">
          {tab === 'inbox' && <Inbox {...view} />}
          {tab === 'board' && <Board {...view} />}
          {tab === 'tasks' && <Tasks {...view} />}
          {tab === 'customers' && <Customers {...view} />}
          {tab === 'conversations' && (
            <Conversations
              api={api}
              timezone={timezone}
              onOpenContact={(id) => setOpen({ kind: 'contact', id })}
              onOpenThread={(id) => setOpen({ kind: 'thread', id })}
            />
          )}
          {tab === 'stages' && <Stages key={ws.read_at} api={api} ws={ws} reload={reload} />}
        </div>
        {open && (
          <aside className="crm-split__record">
            {open.kind === 'lead' && (
              <LeadDetail api={api} leadId={open.id} timezone={timezone} readOnly={readOnly} businessName={ws.tenant.name} onChanged={reload} onOpenContact={(id) => setOpen({ kind: 'contact', id })} onClose={() => setOpen(null)} />
            )}
            {open.kind === 'contact' && (
              <ContactDetail api={api} contactId={open.id} timezone={timezone} readOnly={readOnly} businessName={ws.tenant.name} onChanged={reload} onOpenLead={(id) => setOpen({ kind: 'lead', id })} onClose={() => setOpen(null)} />
            )}
            {open.kind === 'thread' && (
              <ThreadOnly api={api} conversationId={open.id} timezone={timezone} readOnly={readOnly} businessName={ws.tenant.name} onClose={() => setOpen(null)} />
            )}
          </aside>
        )}
      </div>
    </Panel>
  );
}
