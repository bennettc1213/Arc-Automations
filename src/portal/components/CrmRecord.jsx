import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Pill, Term } from './ui';
import { ActionButton, Field, Notice, SelectInput, TextArea, TextInput } from './ops-ui';
import { formatPhone } from '../lib/format';
import Conversation from './CrmConversation';
import { RecordBooking } from './CrmBooking';
import { lockedFields } from '../../../supabase/functions/_shared/crm/inbox.ts';

/**
 * ARC-360 — one lead, one customer, and a lead typed in: the record half of the CRM workspace.
 *
 * The screen decides nothing. Every change is one call the server answers — a move, a new
 * owner, a note — and a refusal is printed in the server's words. What their own software
 * owns (ARC-340's source-of-truth policy) is shown, disabled and named, never hidden; the
 * server refuses it regardless.
 */

export const STATUS_TONE = { open: 'idle', won: 'ok', lost: 'neutral' };
export const SOURCE_WORDS = {
  missed_call: 'missed call', inbound_call: 'call', inbound_sms: 'text', inbound_email: 'email', web_form: 'form',
  manual: 'typed in', import: 'import', webhook: 'api', referral: 'referral', external_system: 'their system', other: 'other',
};
const DOOR_WORDS = { form: 'form', booking: 'booking page', api: 'their system, through an endpoint', import: 'a file', manual: 'typed in by a person', other: '—' };
const ACTIVITY_WORDS = {
  lead_created: 'arrived', lead_updated: 'details changed', lead_stage_changed: 'moved', lead_owner_changed: 'handed over',
  lead_archived: 'archived', lead_restored: 'restored', note_added: 'note added', note_archived: 'note archived',
  task_created: 'task added', task_updated: 'task changed', task_completed: 'task done', task_cancelled: 'task cancelled',
  task_reopened: 'task reopened', contact_created: 'customer added', contact_updated: 'customer details changed',
  contact_archived: 'customer archived', contact_restored: 'customer restored', contact_merged: 'merged',
  contact_owner_changed: 'customer handed over', mapping_added: 'linked to their system', mapping_removed: 'unlinked from their system',
  appointment_requested: 'appointment requested', appointment_confirmed: 'appointment confirmed', appointment_declined: 'appointment request declined',
  appointment_rescheduled: 'appointment moved', appointment_cancelled: 'appointment cancelled', appointment_completed: 'appointment completed',
  appointment_no_show: 'customer did not show',
};
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const VALUE_SOURCES = [
  { value: 'operator_entered', label: 'we entered it' },
  { value: 'customer_provided', label: 'the customer said' },
  { value: 'external_system', label: 'from their system' },
  { value: 'price_book', label: 'from the price book' },
];

export function when(iso, timezone) {
  if (!iso) return '—';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('LLL d, h:mm a');
}

export function ago(iso, timezone) {
  if (!iso) return '';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toRelative() ?? '';
}

export const personLabel = (people, userId) => (userId ? people.find((p) => p.user_id === userId)?.label ?? 'somebody no longer on the team' : null);

function actorLabel(people, row) {
  if (row.actor_type === 'system') return 'ARC, automatically';
  if (row.actor_type === 'external') return 'their system';
  return personLabel(people, row.actor_id) ?? '—';
}

/** the owners a select can offer: whoever may be named, and whoever is named now. */
export function ownerOptions(people, current, { none = 'nobody' } = {}) {
  const list = people.filter((p) => p.assignable || p.user_id === current);
  return [{ value: '', label: none }, ...list.map((p) => ({ value: p.user_id, label: p.label }))];
}

/** an inline change: the result, or the server's refusal, printed next to the control. */
export function useChange() {
  const [state, setState] = useState({ kind: 'idle' });
  const run = useCallback(async (fn, done = 'saved') => {
    setState({ kind: 'busy' });
    try {
      await fn();
      setState({ kind: 'done', message: done });
      return true;
    } catch (error) {
      setState({ kind: 'error', message: error.message });
      return false;
    }
  }, []);
  const note = state.kind === 'error'
    ? <span className="ops-action__msg ops-action__msg--fail" role="alert">{state.message}</span>
    : state.kind === 'done'
      ? <span className="ops-action__msg ops-action__msg--ok">{state.message}</span>
      : state.kind === 'busy' ? <span className="ops-muted">working…</span> : null;
  return { run, note, busy: state.kind === 'busy' };
}

/** "kept in jobber": a field their own software owns, said where the field is. */
function Locked({ policy }) {
  return (
    <span className="crm-locked">
      <Icon name="link" size={12} /> <Term k="kept_elsewhere">kept in {policy?.connectorKey ?? 'their system'}</Term>
    </span>
  );
}

/** a stage change, with the reason a lost stage needs asked for first. */
export async function moveLead(api, lead, stage) {
  const change = { stage_id: stage.id };
  if (stage.kind === 'lost') {
    const reason = window.prompt(`why was "${lead.title}" lost? the reason is kept with the lead.`);
    if (!reason || !reason.trim()) return false;
    change.closed_reason = reason.trim();
  }
  await api.updateLead(lead.id, change);
  return true;
}

/* ── tasks and notes, shared by a lead and a customer ───── */

function TaskList({ api, tasks, people, timezone, readOnly, onChanged }) {
  const change = useChange();
  if (tasks.length === 0) return <p className="ops-muted">no tasks.</p>;
  return (
    <>
      <ul className="crm-items">
        {tasks.map((task) => {
          const overdue = task.status === 'open' && task.due_at && Date.parse(task.due_at) < Date.now();
          return (
            <li key={task.id} className={`crm-item${task.status !== 'open' ? ' is-done' : ''}`}>
              <label className="crm-check">
                <input
                  type="checkbox"
                  checked={task.status === 'done'}
                  disabled={readOnly || task.status === 'cancelled' || change.busy}
                  aria-label={task.status === 'done' ? `reopen "${task.title}"` : `mark "${task.title}" done`}
                  onChange={() => change.run(async () => {
                    await api.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' });
                    await onChanged();
                  }, task.status === 'done' ? 'reopened' : 'done')}
                />
                <span>{task.title}</span>
              </label>
              <span className="crm-item__meta">
                {task.due_at ? (overdue ? <Pill tone="warn"><Term k="overdue">overdue</Term> · {when(task.due_at, timezone)}</Pill> : `due ${when(task.due_at, timezone)}`) : 'no due date'}
                {task.assigned_user_id ? ` · ${personLabel(people, task.assigned_user_id)}` : ''}
                {task.status === 'done' && task.completed_at ? ` · done ${when(task.completed_at, timezone)}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {change.note}
    </>
  );
}

function NewTask({ api, target, people, viewer, onChanged }) {
  const [task, setTask] = useState({ title: '', kind: 'follow_up', due: '', assignee: viewer.kind === 'client_user' ? viewer.user_id : '' });
  const set = (patch) => setTask((t) => ({ ...t, ...patch }));
  return (
    <div className="ops-form crm-form">
      <Field label="next step" required>
        <TextInput value={task.title} maxLength={200} placeholder="call back about the estimate" onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="kind">
        <SelectInput value={task.kind} onChange={(e) => set({ kind: e.target.value })} options={[
          { value: 'follow_up', label: 'follow up' }, { value: 'call', label: 'call' }, { value: 'visit', label: 'visit' }, { value: 'other', label: 'other' },
        ]} />
      </Field>
      <Field label="due" hint="in your own time">
        <input className="ops-input" type="datetime-local" value={task.due} onChange={(e) => set({ due: e.target.value })} />
      </Field>
      <Field label="for">
        <SelectInput value={task.assignee} onChange={(e) => set({ assignee: e.target.value })} options={ownerOptions(people, task.assignee, { none: 'anybody' })} />
      </Field>
      <div className="ops-form__row">
        <ActionButton
          icon="plus"
          disabled={!task.title.trim()}
          onRun={async () => {
            await api.createTask({
              ...target,
              title: task.title,
              kind: task.kind,
              ...(task.due ? { due_at: new Date(task.due).toISOString() } : {}),
              ...(task.assignee ? { assigned_user_id: task.assignee } : {}),
            });
            setTask((t) => ({ ...t, title: '', due: '' }));
            await onChanged();
            return 'task added';
          }}
        >
          add the task
        </ActionButton>
      </div>
    </div>
  );
}

function Notes({ api, notes, target, people, timezone, viewer, readOnly, onChanged }) {
  const [body, setBody] = useState('');
  return (
    <>
      {notes.length === 0 && <p className="ops-muted">no notes.</p>}
      <ul className="crm-items">
        {notes.map((note) => (
          <li key={note.id} className="crm-item crm-note">
            <p className="crm-note__body">{note.body}</p>
            <span className="crm-item__meta">
              {personLabel(people, note.author_id) ?? (note.author_type === 'system' ? 'ARC' : '—')} · {when(note.created_at, timezone)}
            </span>
            {!readOnly && viewer.may.sensitive && (
              <ActionButton
                icon="archive"
                confirm="archive this note? it leaves the list and stays in the history, with who archived it."
                onRun={async () => {
                  await api.archiveNote(note.id);
                  await onChanged();
                  return 'archived';
                }}
              >
                archive
              </ActionButton>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && viewer.may.record && (
        <div className="ops-form crm-form">
          <Field label="add a note" wide hint="a note stays inside ARC and is never sent to the customer. it is never edited afterwards — it can be archived, and the history keeps it.">
            <TextArea value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="ops-form__row">
            <ActionButton
              icon="plus"
              disabled={!body.trim()}
              onRun={async () => {
                await api.addNote({ ...target, body });
                setBody('');
                await onChanged();
                return 'note added';
              }}
            >
              add the note
            </ActionButton>
          </div>
        </div>
      )}
    </>
  );
}

function Timeline({ rows, people, timezone }) {
  if (rows.length === 0) return <p className="ops-muted">nothing yet.</p>;
  return (
    <ol className="crm-timeline">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="crm-timeline__when">{when(row.occurred_at, timezone)}</span>
          <span>
            <b>{ACTIVITY_WORDS[row.activity_type] ?? row.summary}</b>
            {row.activity_type === 'lead_stage_changed' && row.detail?.to ? ` — ${row.detail.from ?? '?'} → ${row.detail.to}` : ''}
            {Array.isArray(row.detail?.fields) && row.detail.fields.length > 0 ? ` — ${row.detail.fields.join(', ')}` : ''}
            {row.activity_type === 'lead_created' && row.detail?.source ? ` — ${SOURCE_WORDS[row.detail.source] ?? row.detail.source}` : ''}
          </span>
          <span className="crm-item__meta">{actorLabel(people, row)}</span>
        </li>
      ))}
    </ol>
  );
}

function Safety({ safety }) {
  if (safety.length === 0) return null;
  return (
    <ul className="crm-items">
      {safety.map((row) => (
        <li key={`${row.channel}-${row.address}`} className="crm-item">
          <span>{row.channel === 'sms' ? 'texts' : 'email'} to <span className="mono">{row.channel === 'sms' ? formatPhone(row.address) : row.address}</span></span>
          {row.suppressed
            ? <Pill tone="warn"><Term k="do_not_contact">do not contact</Term> · {String(row.reason).replace(/_/g, ' ')}</Pill>
            : <span className="crm-item__meta">not on the do-not-contact list</span>}
        </li>
      ))}
    </ul>
  );
}

/* ── one lead ───────────────────────────────────────────── */

export function LeadDetail({ api, leadId, timezone, readOnly, businessName, onChanged, onOpenContact, onClose }) {
  const [state, setState] = useState({ kind: 'loading' });
  const [edit, setEdit] = useState(null);
  const change = useChange();

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', view: await api.leadView(leadId) });
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }, [api, leadId]);
  useEffect(() => {
    setState({ kind: 'loading' });
    setEdit(null);
    load();
  }, [load]);

  const changed = useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the lead…</p>;
  if (state.kind === 'error') return <Notice tone="fail" title="this lead could not be read"><p>{state.message}</p></Notice>;

  const { view } = state;
  const { lead, contact, stage, people, viewer, policies, source } = view;
  const locked = lockedFields(policies.lead);
  const isLocked = (field) => locked.includes(field);
  const stages = (view.pipeline?.stages ?? []).filter((s) => !s.archived_at || s.id === lead.stage_id);
  const canWrite = !readOnly && viewer.may.record && !lead.archived_at;
  const claimed = Object.entries(source.claimed ?? {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));

  return (
    <article className="crm-record" aria-label={`lead: ${lead.title}`}>
      <header className="crm-record__head">
        <div>
          <p className="crm-record__eyebrow">{SOURCE_WORDS[lead.source] ?? lead.source} · arrived {when(lead.created_at, timezone)}</p>
          <h3 className="crm-record__title">{lead.title}</h3>
          {contact && (
            <button type="button" className="crm-link" onClick={() => onOpenContact(contact.id)}>
              {contact.display_name}
              {contact.phone ? ` · ${formatPhone(contact.phone)}` : ''}
            </button>
          )}
        </div>
        <div className="crm-record__status">
          <Pill tone={STATUS_TONE[lead.status] ?? 'neutral'}><Term k={lead.status}>{lead.status}</Term></Pill>
          {lead.archived_at && <Pill tone="neutral"><Term k="archived">archived</Term></Pill>}
          <button type="button" className="ws-btn" aria-label="close this lead" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      {view.recovery && (
        <Notice tone="warn" title={`lead recovery: ${String(view.recovery.status).replace(/_/g, ' ')}`}>
          {view.recovery.safety_flags?.length > 0 && <p><Term k="safety_flag">flagged</Term>: {view.recovery.safety_flags.join(', ').replace(/_/g, ' ')}</p>}
          <p>what the automation did is on lead recovery&rsquo;s own page. this record is the business&rsquo;s copy of the lead.</p>
        </Notice>
      )}

      <div className="crm-controls">
        <Field label="stage">
          <SelectInput
            value={lead.stage_id}
            disabled={!canWrite || isLocked('stage_id') || change.busy}
            onChange={(e) => {
              const next = stages.find((s) => s.id === e.target.value);
              change.run(async () => {
                if (await moveLead(api, lead, next)) await changed();
              }, `moved to ${next.name}`);
            }}
            options={stages.map((s) => ({ value: s.id, label: `${s.name}${s.kind !== 'open' ? ` (${s.kind})` : s.waits_on === 'customer' ? ' — waiting on customer' : ''}` }))}
          />
        </Field>
        <Field label="owner" hint={viewer.may.sensitive ? null : 'the account owner hands a lead over'}>
          <SelectInput
            value={lead.owner_user_id ?? ''}
            disabled={!canWrite || !viewer.may.sensitive || change.busy}
            onChange={(e) => change.run(async () => {
              await api.updateLead(lead.id, { owner_user_id: e.target.value || null });
              await changed();
            }, 'handed over')}
            options={ownerOptions(people, lead.owner_user_id)}
          />
        </Field>
        <Field label="priority">
          <SelectInput
            value={lead.priority}
            disabled={!canWrite || isLocked('priority') || change.busy}
            onChange={(e) => change.run(async () => {
              await api.updateLead(lead.id, { priority: e.target.value });
              await changed();
            })}
            options={PRIORITIES.map((p) => ({ value: p, label: p }))}
          />
        </Field>
        <div className="crm-controls__note">
          {change.note}
          {isLocked('stage_id') && <Locked policy={policies.lead} />}
          {lead.status === 'lost' && lead.closed_reason && <span className="ops-muted">lost because: {lead.closed_reason}</span>}
        </div>
      </div>

      <section className="crm-section">
        <h4>what it is</h4>
        {edit ? (
          <div className="ops-form crm-form">
            <Field label="title" required>
              <TextInput value={edit.title} maxLength={200} disabled={isLocked('title')} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </Field>
            <Field label="estimated value ($)" hint="only with where it came from — ARC never estimates one.">
              <TextInput type="number" min={0} step="1" value={edit.value} disabled={isLocked('estimated_value_cents')} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
            </Field>
            <Field label="the value came from">
              <SelectInput value={edit.valueSource} disabled={isLocked('estimated_value_cents')} onChange={(e) => setEdit({ ...edit, valueSource: e.target.value })} options={VALUE_SOURCES} />
            </Field>
            <Field label="details" wide>
              <TextArea value={edit.summary} maxLength={2000} disabled={isLocked('summary')} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
            </Field>
            <div className="ops-form__row">
              <ActionButton
                variant="primary"
                icon="check"
                disabled={!edit.title.trim()}
                onRun={async () => {
                  const patch = {};
                  if (!isLocked('title') && edit.title !== lead.title) patch.title = edit.title;
                  if (!isLocked('summary') && (edit.summary || null) !== (lead.summary ?? null)) patch.summary = edit.summary;
                  if (!isLocked('estimated_value_cents')) {
                    const cents = edit.value === '' ? null : Math.round(Number(edit.value) * 100);
                    if (cents !== (lead.estimated_value_cents ?? null) || (cents !== null && edit.valueSource !== lead.estimated_value_source)) {
                      patch.estimated_value_cents = cents;
                      patch.estimated_value_source = cents === null ? null : edit.valueSource;
                    }
                  }
                  if (Object.keys(patch).length === 0) return 'nothing changed';
                  await api.updateLead(lead.id, patch);
                  setEdit(null);
                  await changed();
                  return 'saved';
                }}
              >
                save
              </ActionButton>
              <button type="button" className="ws-btn" onClick={() => setEdit(null)}>cancel</button>
              {locked.some((f) => ['title', 'summary', 'estimated_value_cents'].includes(f)) && <Locked policy={policies.lead} />}
            </div>
          </div>
        ) : (
          <>
            <p className="crm-record__summary">{lead.summary || <span className="ops-muted">no details written.</span>}</p>
            <p className="crm-item__meta">
              {lead.estimated_value_cents !== null && lead.estimated_value_cents !== undefined
                ? `estimated $${(lead.estimated_value_cents / 100).toLocaleString('en-US')} — ${VALUE_SOURCES.find((v) => v.value === lead.estimated_value_source)?.label ?? lead.estimated_value_source}`
                : 'no value recorded'}
              {stage ? ` · stage: ${stage.name}` : ''}
            </p>
            {canWrite && (
              <button
                type="button"
                className="ws-btn"
                onClick={() => setEdit({
                  title: lead.title, summary: lead.summary ?? '',
                  value: lead.estimated_value_cents !== null && lead.estimated_value_cents !== undefined ? String(lead.estimated_value_cents / 100) : '',
                  valueSource: lead.estimated_value_source ?? 'operator_entered',
                })}
              >
                <Icon name="edit" size={13} /> edit
              </button>
            )}
          </>
        )}
      </section>

      {contact && (
        <section className="crm-section">
          <h4>conversation</h4>
          <p className="crm-item__meta">what this customer and the business have said to each other. every message here is one the customer saw.</p>
          <Conversation api={api} by={{ contact_id: contact.id }} lead={lead} timezone={timezone} readOnly={readOnly || Boolean(lead.archived_at)} businessName={businessName} />
        </section>
      )}

      <section className="crm-section">
        <h4>appointments</h4>
        <RecordBooking api={api} by={{ lead_id: lead.id }} timezone={timezone} readOnly={!canWrite} onChanged={changed} />
      </section>

      <section className="crm-section">
        <h4>next steps</h4>
        <TaskList api={api} tasks={view.tasks} people={people} timezone={timezone} readOnly={!canWrite} onChanged={changed} />
        {canWrite && <NewTask api={api} target={{ lead_id: lead.id }} people={people} viewer={viewer} onChanged={changed} />}
      </section>

      <section className="crm-section">
        <h4><Term k="internal_note">internal notes</Term></h4>
        <Notes api={api} notes={view.notes} target={{ lead_id: lead.id }} people={people} timezone={timezone} viewer={viewer} readOnly={!canWrite} onChanged={changed} />
      </section>

      <section className="crm-section">
        <h4>where it came from</h4>
        <dl className="crm-facts">
          <div><dt>how</dt><dd>{SOURCE_WORDS[lead.source] ?? lead.source}</dd></div>
          <div><dt>through</dt><dd>{source.door.name ? `${DOOR_WORDS[source.door.kind]} — ${source.door.name}` : DOOR_WORDS[source.door.kind]}</dd></div>
          {source.event && <div><dt>received</dt><dd>{when(source.event.received_at, timezone)}</dd></div>}
          {claimed.length > 0 && (
            <div>
              <dt>they said</dt>
              <dd>
                {claimed.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}
                <span className="crm-item__meta"> — what their browser reported. recorded, not checked.</span>
              </dd>
            </div>
          )}
        </dl>
        {source.consent.length > 0 && (
          <ul className="crm-items">
            {source.consent.map((c) => (
              <li key={`${c.channel}-${c.captured_at}`} className="crm-item">
                <span>{c.channel === 'sms' ? 'permission to text' : `permission to ${c.channel}`}: <b>{c.granted ? 'ticked' : 'left unticked'}</b></span>
                <span className="crm-item__meta">shown: &ldquo;{c.disclosure}&rdquo; · {when(c.captured_at, timezone)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="ws-note">what a form showed and what was ticked is evidence of that, and nothing more. whether anyone may be texted is decided when a message is sent, from the do-not-contact list.</p>
        <Safety safety={view.safety} />
        {view.mappings.length > 0 && (
          <p className="crm-item__meta">in their system: {view.mappings.map((m) => `${m.connector_key} ${m.external_id}`).join(' · ')}</p>
        )}
      </section>

      <section className="crm-section">
        <h4>history</h4>
        <Timeline rows={view.timeline} people={people} timezone={timezone} />
      </section>

      {!readOnly && viewer.may.sensitive && (
        <div className="ops-row">
          {lead.archived_at ? (
            <ActionButton icon="refresh" onRun={async () => { await api.restoreLead(lead.id); await changed(); return 'restored'; }}>
              restore
            </ActionButton>
          ) : (
            <ActionButton
              icon="archive"
              confirm={`archive "${lead.title}"? it leaves the inbox and the board. its history, notes and tasks are kept, and it can be restored.`}
              onRun={async () => { await api.archiveLead(lead.id); await changed(); return 'archived'; }}
            >
              archive the lead
            </ActionButton>
          )}
        </div>
      )}
    </article>
  );
}

/* ── one customer ───────────────────────────────────────── */

const CONTACT_FIELDS = [
  ['display_name', 'name', 200],
  ['phone', 'phone', 40],
  ['email', 'email', 200],
  ['address_line1', 'street address', 200],
  ['city', 'city', 120],
  ['region', 'state', 120],
  ['postal_code', 'ZIP', 20],
];

export function ContactDetail({ api, contactId, timezone, readOnly, businessName, onChanged, onOpenLead, onClose }) {
  const [state, setState] = useState({ kind: 'loading' });
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', view: await api.contactView(contactId) });
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }, [api, contactId]);
  useEffect(() => {
    setState({ kind: 'loading' });
    setEdit(null);
    load();
  }, [load]);
  const changed = useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the customer…</p>;
  if (state.kind === 'error') return <Notice tone="fail" title="this customer could not be read"><p>{state.message}</p></Notice>;

  const { view } = state;
  const { contact, people, viewer, policies } = view;
  const locked = lockedFields(policies.contact);
  const canWrite = !readOnly && viewer.may.record && !contact.archived_at && !contact.merged_into_id;

  return (
    <article className="crm-record" aria-label={`customer: ${contact.display_name}`}>
      <header className="crm-record__head">
        <div>
          <p className="crm-record__eyebrow">customer since {when(contact.created_at, timezone)}</p>
          <h3 className="crm-record__title">{contact.display_name}</h3>
          <p className="crm-item__meta">
            {[contact.phone && formatPhone(contact.phone), contact.email, [contact.city, contact.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'no contact details'}
          </p>
        </div>
        <div className="crm-record__status">
          {contact.merged_into_id && <Pill tone="neutral">merged</Pill>}
          {contact.archived_at && <Pill tone="neutral"><Term k="archived">archived</Term></Pill>}
          <button type="button" className="ws-btn" aria-label="close this customer" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <section className="crm-section">
        <h4>details</h4>
        {edit ? (
          <div className="ops-form crm-form">
            {CONTACT_FIELDS.map(([key, label, max]) => (
              <Field key={key} label={label}>
                <TextInput value={edit[key]} maxLength={max} disabled={locked.includes(key)} onChange={(e) => setEdit({ ...edit, [key]: e.target.value })} />
              </Field>
            ))}
            <div className="ops-form__row">
              <ActionButton
                variant="primary"
                icon="check"
                disabled={!edit.display_name.trim()}
                onRun={async () => {
                  const patch = {};
                  for (const [key] of CONTACT_FIELDS) {
                    if (locked.includes(key)) continue;
                    if ((edit[key] || null) !== (contact[key] ?? null)) patch[key] = edit[key] || null;
                  }
                  if (Object.keys(patch).length === 0) return 'nothing changed';
                  await api.updateContact(contact.id, patch);
                  setEdit(null);
                  await changed();
                  return 'saved';
                }}
              >
                save
              </ActionButton>
              <button type="button" className="ws-btn" onClick={() => setEdit(null)}>cancel</button>
              {locked.length > 0 && <Locked policy={policies.contact} />}
            </div>
          </div>
        ) : (
          canWrite && (
            <button type="button" className="ws-btn" onClick={() => setEdit(Object.fromEntries(CONTACT_FIELDS.map(([key]) => [key, contact[key] ?? ''])))}>
              <Icon name="edit" size={13} /> edit details
            </button>
          )
        )}
        <Safety safety={view.safety} />
      </section>

      <section className="crm-section">
        <h4>conversations</h4>
        <p className="crm-item__meta">what this customer and the business have said to each other, on every channel there is an address for.</p>
        <Conversation api={api} by={{ contact_id: contact.id }} timezone={timezone} readOnly={readOnly || Boolean(contact.archived_at)} businessName={businessName} />
      </section>

      <section className="crm-section">
        <h4>leads</h4>
        {view.leads.length === 0 ? <p className="ops-muted">no leads.</p> : (
          <ul className="crm-items">
            {view.leads.map((lead) => (
              <li key={lead.id} className="crm-item">
                <button type="button" className="crm-link" onClick={() => onOpenLead(lead.id)}>{lead.title}</button>
                <span className="crm-item__meta">
                  <Term k={lead.status}>{lead.status}</Term> · {SOURCE_WORDS[lead.source] ?? lead.source} · {when(lead.created_at, timezone)}
                  {lead.archived_at ? ' · archived' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="crm-section">
        <h4>appointments</h4>
        <RecordBooking api={api} by={{ contact_id: contact.id }} timezone={timezone} readOnly={!canWrite} onChanged={changed} />
      </section>

      <section className="crm-section">
        <h4>tasks</h4>
        <TaskList api={api} tasks={view.tasks} people={people} timezone={timezone} readOnly={!canWrite} onChanged={changed} />
        {canWrite && <NewTask api={api} target={{ contact_id: contact.id }} people={people} viewer={viewer} onChanged={changed} />}
      </section>

      <section className="crm-section">
        <h4><Term k="internal_note">internal notes</Term></h4>
        <Notes api={api} notes={view.notes} target={{ contact_id: contact.id }} people={people} timezone={timezone} viewer={viewer} readOnly={!canWrite} onChanged={changed} />
      </section>

      <section className="crm-section">
        <h4>history</h4>
        <Timeline rows={view.timeline} people={people} timezone={timezone} />
      </section>
    </article>
  );
}

/* ── a lead typed in ────────────────────────────────────── */

const EMPTY = { name: '', phone: '', email: '', title: '', summary: '', service: '', priority: 'normal' };

export function QuickAdd({ api, services, onAdded, onClose }) {
  const [lead, setLead] = useState(EMPTY);
  const [result, setResult] = useState(null);
  const set = (patch) => setLead((current) => ({ ...current, ...patch }));
  const send = (allowDuplicate) => async () => {
    setResult(null);
    const contact = Object.fromEntries(
      [['display_name', lead.name], ['phone', lead.phone], ['email', lead.email]].filter(([, value]) => value.trim() !== ''),
    );
    try {
      const arrival = await api.quickAdd({
        contact,
        lead: { title: lead.title, summary: lead.summary, ...(lead.service ? { service: lead.service } : {}), priority: lead.priority },
        allow_duplicate: allowDuplicate,
      });
      setResult({ arrival });
      if (arrival.outcome === 'created') setLead(EMPTY);
      await onAdded(arrival);
      return arrival.outcome === 'created' ? 'lead added' : 'this person already has an open lead';
    } catch (error) {
      if (error.payload?.candidates) setResult({ candidates: error.payload.candidates });
      throw error;
    }
  };
  return (
    <div className="crm-quick">
      <div className="ops-form">
        <Field label="name">
          <TextInput value={lead.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="phone" hint="a name, a phone or an email — at least one.">
          <TextInput value={lead.phone} inputMode="tel" onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="email">
          <TextInput value={lead.email} inputMode="email" onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="what it is about" required>
          <TextInput value={lead.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        {services.length > 0 && (
          <Field label="service">
            <SelectInput value={lead.service} onChange={(e) => set({ service: e.target.value })} options={[{ value: '', label: '—' }, ...services.map((s) => ({ value: s.key, label: s.name }))]} />
          </Field>
        )}
        <Field label="priority">
          <SelectInput value={lead.priority} onChange={(e) => set({ priority: e.target.value })} options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="notes" wide>
          <TextArea value={lead.summary} maxLength={2000} onChange={(e) => set({ summary: e.target.value })} />
        </Field>
        <div className="ops-form__row">
          <ActionButton variant="primary" icon="plus" disabled={!lead.title.trim()} onRun={send(false)}>
            add the lead
          </ActionButton>
          <button type="button" className="ws-btn" onClick={onClose}>close</button>
        </div>
      </div>
      {result?.arrival?.outcome === 'duplicate' && (
        <Notice tone="warn" title="this person already has an open lead from the last day">
          <p>what you entered was added to that lead and no second one was made. if this really is a separate job:</p>
          <ActionButton icon="plus" onRun={send(true)}>make a separate lead anyway</ActionButton>
        </Notice>
      )}
      {result?.candidates && (
        <Notice tone="warn" title="more than one customer on file shares this phone or email">
          <p>nothing was created. leave the shared detail out, or ask ARC to merge them if they are one person:</p>
          <ul className="crm-items">
            {result.candidates.map((c) => <li key={c.id} className="crm-item">{c.display_name}</li>)}
          </ul>
        </Notice>
      )}
      <p className="ws-note">adding a lead sends nothing and starts nothing. it is recorded, typed in by you, and waits in the inbox.</p>
    </div>
  );
}

/** a conversation with an address nobody on file holds yet, opened from the conversations view. */
export function ThreadOnly({ api, conversationId, timezone, readOnly, businessName, onChanged, onClose }) {
  return (
    <article className="crm-record" aria-label="a conversation with nobody on file">
      <header className="crm-record__head">
        <div>
          <p className="crm-record__eyebrow">conversation</p>
          <h3 className="crm-record__title">nobody on file yet</h3>
        </div>
        <div className="crm-record__status">
          <button type="button" className="ws-btn" aria-label="close this conversation" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>
      <Conversation api={api} by={{ conversation_id: conversationId }} timezone={timezone} readOnly={readOnly} businessName={businessName} onChanged={onChanged} />
    </article>
  );
}

export function NoRecord() {
  return <Empty title="nothing open">choose a lead or a customer to see everything about it here.</Empty>;
}
