import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Pill, Term } from './ui';
import { ActionButton, CopyValue, Disclosure, Field, Notice, SelectInput, TextArea, TextInput } from './ops-ui';
import { formatPhone } from '../lib/format';
import { isNotDeployed } from '../lib/crm';
import {
  addDays, agendaDays, bookingEmbedSnippet, bookingUrl, defaultPageDefinition, localDate, nextActions, SLOT_STEPS, weekdayOf,
} from '../../../supabase/functions/_shared/booking/model.ts';

/**
 * ARC-380 — appointments: the calendar a business works from, booking a time from a lead, and
 * the setup behind the page a customer books on.
 *
 * The screen decides nothing. The times offered are the server's answer (`crm-booking-slots`);
 * the buttons on an appointment are `nextActions` — the same list of legal changes the server
 * and the database hold — and a time is given by the database under a lock, so "that time has
 * just been taken" is a sentence this page prints, not a rule it enforces.
 *
 * Nothing here tells the customer anything. Confirming, moving or cancelling an appointment
 * changes the calendar; saying so to the customer is a message, and messages are sent from the
 * conversation — which is why every button below says so before it is pressed.
 *
 * A confirmed or completed appointment is a calendar entry a person set. It is not counted as
 * a result anywhere.
 */

const STATUS_WORDS = { requested: 'requested', confirmed: 'confirmed', declined: 'declined', cancelled: 'cancelled', completed: 'completed', no_show: 'no-show' };
const STATUS_TONE = { requested: 'warn', confirmed: 'ok', declined: 'neutral', cancelled: 'neutral', completed: 'neutral', no_show: 'warn' };
const PAGE_TONE = { draft: 'idle', published: 'ok', archived: 'neutral' };
const EVENT_WORDS = {
  requested: 'requested', confirmed: 'confirmed', declined: 'declined', rescheduled: 'moved', cancelled: 'cancelled', completed: 'marked completed',
  no_show: 'marked a no-show', assigned: 'handed over', sync_applied: 'their calendar agreed', sync_conflict: 'their calendar disagreed', reconciled: 'settled',
};
const DOOR_WORDS = { booking_page: 'on the booking page', manage_link: 'by the customer, from their link', workspace: 'here', sync: 'from their calendar' };
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const NOT_SENT = 'nothing is sent to the customer from here — tell them yourself.';

const zoned = (iso, timezone) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
const clock = (iso, timezone) => zoned(iso, timezone).toFormat('h:mm a');
const whenLabel = (iso, timezone) => zoned(iso, timezone).toFormat('ccc LLL d, h:mm a');
const dayLabel = (date) => DateTime.fromISO(date).toFormat('cccc, LLL d');
const nameOf = (people, userId) => (userId ? people.find((p) => p.user_id === userId)?.label ?? 'somebody no longer on the team' : null);
const assignable = (people, current) => [{ value: '', label: 'nobody yet' }, ...people.filter((p) => p.assignable || p.user_id === current).map((p) => ({ value: p.user_id, label: p.label }))];
const calendarName = (authority) => authority?.connector_key ?? 'their own calendar';
/* where the hosted page lives: this site. the link is the whole of what is shared. */
const siteUrl = () => (typeof window === 'undefined' ? '' : `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`.replace(/\/+$/, ''));
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 40);

function actorWords(people, event) {
  if (event.actor_type === 'external') return 'their calendar';
  if (event.actor_type === 'system') return event.detail?.via === 'manage_link' ? 'the customer' : 'the customer, on the booking page';
  return nameOf(people, event.actor_id) ?? 'a team member';
}

/** why no time can be offered, in the words of whoever has to fix it. */
function Unavailable({ reason, authority, setup }) {
  if (reason === 'their_calendar') {
    return (
      <Notice tone="warn" title={`appointments are booked in ${calendarName(authority)}`}>
        <p>
          <Term k="their_calendar">kept in their calendar</Term>. no times are offered from here, because what is free is known there and not here. a
          customer can still ask for a time on the booking page; it stays a request until their calendar answers.
        </p>
      </Notice>
    );
  }
  if (reason === 'no_hours') {
    return (
      <Notice tone="warn" title="there are no opening hours to book inside">
        <p>{setup ? 'set the hours bookings follow under "rules" below. until then no time can be offered.' : 'the account owner sets the hours bookings follow. until then no time can be offered.'}</p>
      </Notice>
    );
  }
  if (reason === 'no_types') {
    return (
      <Notice tone="warn" title="nothing can be booked yet">
        <p>{setup ? 'add what can be booked — a site visit, a tune-up — under "what can be booked" below.' : 'the account owner adds what can be booked.'}</p>
      </Notice>
    );
  }
  return null;
}

/* ── choosing a time ────────────────────────────────────── */

/**
 * A day, and the times the server offers on it. `ask` names a type, or an appointment being
 * moved. `allowOutside` is for a person booking on purpose outside the hours or the notice.
 */
export function SlotPicker({ api, ask, timezone, allowOutside = true, onChange }) {
  const today = localDate(new Date(), timezone);
  const [date, setDate] = useState(today);
  const [state, setState] = useState({ kind: 'loading' });
  const [outside, setOutside] = useState(false);
  const [chosen, setChosen] = useState('');
  const key = JSON.stringify(ask);

  useEffect(() => {
    let live = true;
    setChosen('');
    onChange(null);
    if (outside) return undefined;
    setState({ kind: 'loading' });
    api.bookingSlots({ ...JSON.parse(key), from: date, days: 1 })
      .then((availability) => live && setState({ kind: 'ready', availability }))
      .catch((error) => live && setState({ kind: 'error', message: error.message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, date, outside]);

  const slots = state.kind === 'ready' ? state.availability.slots : [];
  return (
    <>
      {!outside && (
        <>
          <Field label="day" hint={`in the business's own time (${timezone})`}>
            <input className="ops-input" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value || today)} />
          </Field>
          <Field label="time">
            <SelectInput
              value={chosen}
              disabled={state.kind !== 'ready' || slots.length === 0}
              onChange={(e) => {
                setChosen(e.target.value);
                onChange(e.target.value ? { starts_at: e.target.value, outside_rules: false } : null);
              }}
              options={[
                { value: '', label: state.kind === 'loading' ? 'reading the calendar…' : slots.length === 0 ? 'no times free that day' : 'choose a time…' },
                ...slots.map((slot) => ({ value: slot.starts_at, label: `${clock(slot.starts_at, timezone)} – ${clock(slot.ends_at, timezone)}` })),
              ]}
            />
          </Field>
        </>
      )}
      {outside && (
        <Field label="day and time" hint={`in the business's own time (${timezone}). it is still refused if another appointment holds that time.`}>
          <input
            className="ops-input"
            type="datetime-local"
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              const at = e.target.value ? DateTime.fromISO(e.target.value, { zone: timezone }) : null;
              onChange(at?.isValid ? { starts_at: at.toUTC().toISO(), outside_rules: true } : null);
            }}
          />
        </Field>
      )}
      {allowOutside && (
        <label className="crm-check">
          <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} /> a time outside opening hours or the usual notice
        </label>
      )}
      {state.kind === 'error' && <span className="ops-action__msg ops-action__msg--fail" role="alert">{state.message}</span>}
    </>
  );
}

/* ── one appointment ────────────────────────────────────── */

function Reported({ appointment, timezone }) {
  const reported = appointment.sync_detail?.reported;
  if (!reported) return null;
  return (
    <>
      their calendar says <b>{whenLabel(reported.starts_at, timezone)}</b>, {STATUS_WORDS[reported.status] ?? reported.status}. this one says{' '}
      <b>{whenLabel(appointment.starts_at, timezone)}</b>, {STATUS_WORDS[appointment.status]}.
    </>
  );
}

export function AppointmentItem({ api, appointment: a, contact, people, authority, timezone, viewer, readOnly, onChanged, onOpen, events }) {
  const [moving, setMoving] = useState(false);
  const [slot, setSlot] = useState(null);
  const [refusal, setRefusal] = useState('');
  const actions = readOnly || !viewer.may.book ? [] : nextActions(a, authority, new Date());
  const can = (action) => actions.includes(action);
  const change = (body, done) => async () => {
    await api.changeAppointment(a.id, body);
    await onChanged();
    return done;
  };
  /* a reason is asked for, never required: it is kept with the appointment. */
  const withReason = (action, question, done) => async () => {
    const reason = window.prompt(question);
    if (reason === null) return 'left as it was';
    await api.changeAppointment(a.id, { action, ...(reason.trim() ? { reason: reason.trim() } : {}) });
    await onChanged();
    return done;
  };
  const where = [a.address_line1, a.city].filter(Boolean).join(', ');

  return (
    <li className={`crm-item crm-appt${a.status === 'requested' || a.status === 'confirmed' ? '' : ' is-done'}`}>
      <p className="crm-appt__when">
        <b>{clock(a.starts_at, timezone)} – {clock(a.ends_at, timezone)}</b>
        <span className="crm-item__meta"> {zoned(a.starts_at, timezone).toFormat('ccc LLL d')}</span>
      </p>
      <p className="crm-appt__what">
        {a.title}
        {contact && (
          <>
            {' · '}
            {onOpen
              ? <button type="button" className="crm-link" onClick={() => onOpen(a)}>{contact.display_name}</button>
              : contact.display_name}
            {contact.phone ? <span className="crm-item__meta"> {formatPhone(contact.phone)}</span> : null}
          </>
        )}
      </p>
      <p className="crm-signals">
        <Pill tone={STATUS_TONE[a.status] ?? 'neutral'}><Term k={`appt_${a.status}`}>{STATUS_WORDS[a.status] ?? a.status}</Term></Pill>
        {a.sync_state === 'pending' && <Pill tone="idle"><Term k="sync_pending">waiting on their calendar</Term></Pill>}
        {a.sync_state === 'conflict' && <Pill tone="warn"><Term k="sync_conflict">needs settling</Term></Pill>}
        {a.sync_detail?.overlaps > 0 && <Pill tone="warn">overlaps another appointment</Pill>}
        <span className="crm-item__meta">
          {a.assigned_user_id ? nameOf(people, a.assigned_user_id) : 'nobody has it yet'}
          {where ? ` · ${where}` : ''}
          {a.reschedule_count > 0 ? ` · moved ${a.reschedule_count === 1 ? 'once' : `${a.reschedule_count} times`}` : ''}
        </span>
      </p>
      {a.customer_note && <p className="crm-item__meta">the customer wrote: &ldquo;{a.customer_note}&rdquo;</p>}
      {a.cancel_reason && <p className="crm-item__meta">reason given: {a.cancel_reason}</p>}

      {a.sync_state === 'conflict' && (
        <Notice tone="warn" title="their calendar and this one disagree">
          <p><Reported appointment={a} timezone={timezone} /> nothing changes until somebody chooses.</p>
          {!readOnly && viewer.may.reconcile ? (
            <div className="ops-row">
              <ActionButton consequence="this appointment stays as it is here. it reads as waiting on their calendar until that is changed there." onRun={async () => { await api.reconcileAppointment(a.id, 'keep_ours'); await onChanged(); return 'kept as it is here'; }}>
                keep ours
              </ActionButton>
              <ActionButton consequence={`what their calendar says replaces what is here, as your decision. ${NOT_SENT}`} onRun={async () => { await api.reconcileAppointment(a.id, 'accept_theirs'); await onChanged(); return 'changed to match theirs'; }}>
                use theirs
              </ActionButton>
            </div>
          ) : <p className="ops-muted">the account owner settles this.</p>}
        </Notice>
      )}

      {actions.length > 0 && (
        <div className="ops-row crm-appt__actions">
          {can('confirm') && (
            <ActionButton variant="primary" icon="check" consequence={`the time is theirs and nobody else can book it. ${NOT_SENT}`} onRun={change({ action: 'confirm' }, 'confirmed')}>
              confirm
            </ActionButton>
          )}
          {can('decline') && (
            <ActionButton consequence={`the time is free for somebody else. ${NOT_SENT}`} onRun={withReason('decline', 'why is this request being declined? the reason is kept with it. leave it empty for none.', 'declined')}>
              decline
            </ActionButton>
          )}
          {can('complete') && <ActionButton icon="check" onRun={change({ action: 'complete' }, 'marked completed')}>it happened</ActionButton>}
          {can('no_show') && <ActionButton onRun={change({ action: 'no_show' }, 'marked a no-show')}>they did not show</ActionButton>}
          {can('reschedule') && (
            <button type="button" className="ws-btn" aria-expanded={moving} onClick={() => setMoving((v) => !v)}>
              <Icon name="clock" size={13} /> move
            </button>
          )}
          {can('cancel') && (
            <ActionButton consequence={`the time is free again and this stays in the history as cancelled. ${NOT_SENT}`} onRun={withReason('cancel', 'why is this appointment being cancelled? the reason is kept with it. leave it empty for none.', 'cancelled')}>
              cancel
            </ActionButton>
          )}
          {can('assign') && (
            <SelectInput
              aria-label={`who has the ${a.title} at ${clock(a.starts_at, timezone)}`}
              value={a.assigned_user_id ?? ''}
              onChange={async (e) => {
                setRefusal('');
                try {
                  await api.changeAppointment(a.id, { action: 'assign', assigned_user_id: e.target.value || null });
                  await onChanged();
                } catch (error) {
                  setRefusal(error.message);
                }
              }}
              options={assignable(people, a.assigned_user_id)}
            />
          )}
          {refusal && <span className="ops-action__msg ops-action__msg--fail" role="alert">{refusal}</span>}
        </div>
      )}

      {moving && can('reschedule') && (
        <div className="ops-form crm-form">
          <SlotPicker api={api} ask={{ appointment_id: a.id }} timezone={timezone} onChange={setSlot} />
          <div className="ops-form__row">
            <ActionButton
              variant="primary"
              icon="check"
              disabled={!slot}
              consequence={`the old time is freed and the new one is held. ${NOT_SENT}`}
              onRun={async () => {
                await api.changeAppointment(a.id, { action: 'reschedule', starts_at: slot.starts_at, ...(slot.outside_rules ? { outside_rules: true } : {}) });
                setMoving(false);
                await onChanged();
                return 'moved';
              }}
            >
              move it
            </ActionButton>
            <button type="button" className="ws-btn" onClick={() => setMoving(false)}>leave it</button>
          </div>
        </div>
      )}

      {events && events.length > 0 && (
        <ol className="crm-timeline">
          {events.map((event) => (
            <li key={event.id}>
              <span className="crm-timeline__when">{whenLabel(event.occurred_at, timezone)}</span>
              <span>
                <b>{EVENT_WORDS[event.event_type] ?? event.event_type}</b>
                {event.event_type === 'rescheduled' && event.detail?.from ? ` — from ${whenLabel(new Date(event.detail.from).toISOString(), timezone)}` : ''}
                {event.detail?.reason && event.event_type !== 'sync_conflict' ? ` — ${event.detail.reason}` : ''}
                {event.event_type === 'reconciled' ? ` — ${event.detail?.kept === 'theirs' ? 'their calendar was used' : 'this one was kept'}` : ''}
              </span>
              <span className="crm-item__meta">{actorWords(people, event)}{DOOR_WORDS[event.detail?.via] && event.actor_type !== 'system' ? `, ${DOOR_WORDS[event.detail.via]}` : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/* ── booking a time, from a lead or a customer ──────────── */

function BookForm({ api, types, target, people, viewer, timezone, onBooked }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [slot, setSlot] = useState(null);
  const [assignee, setAssignee] = useState(viewer.kind === 'client_user' ? viewer.user_id : '');
  const [note, setNote] = useState('');
  return (
    <div className="ops-form crm-form">
      <Field label="what it is for" required>
        <SelectInput value={typeId} onChange={(e) => setTypeId(e.target.value)} options={types.map((t) => ({ value: t.id, label: `${t.name} (${t.duration_minutes} min)` }))} />
      </Field>
      {typeId && <SlotPicker api={api} ask={{ appointment_type_id: typeId }} timezone={timezone} onChange={setSlot} />}
      <Field label="who has it">
        <SelectInput value={assignee} onChange={(e) => setAssignee(e.target.value)} options={assignable(people, assignee)} />
      </Field>
      <Field label="anything the crew should know" wide>
        <TextArea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="ops-form__row">
        <ActionButton
          variant="primary"
          icon="plus"
          disabled={!slot || !typeId}
          consequence={`it goes in the calendar as confirmed, and that time is not offered to anybody else. ${NOT_SENT}`}
          onRun={async () => {
            await api.bookAppointment({
              ...target,
              appointment_type_id: typeId,
              starts_at: slot.starts_at,
              ...(slot.outside_rules ? { outside_rules: true } : {}),
              ...(assignee ? { assigned_user_id: assignee } : {}),
              ...(note.trim() ? { customer_note: note.trim() } : {}),
            });
            setNote('');
            setSlot(null);
            await onBooked();
            return 'booked';
          }}
        >
          book the time
        </ActionButton>
      </div>
    </div>
  );
}

/** One lead's or one customer's appointments, each with its history, and a way to book another. */
export function RecordBooking({ api, by, timezone, readOnly, onChanged, initial = null }) {
  const [state, setState] = useState(initial ? { kind: 'ready', record: initial } : { kind: 'loading' });
  const [booking, setBooking] = useState(false);
  const key = JSON.stringify(by);

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', record: await api.bookingRecord(JSON.parse(key)) });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api, key]);
  useEffect(() => {
    if (!initial) load();
  }, [initial, load]);
  const changed = useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the calendar…</p>;
  if (state.kind === 'error') {
    return isNotDeployed(state.error)
      ? <p className="ops-muted">booking is not switched on here yet.</p>
      : <Notice tone="fail" title="the appointments could not be read"><p>{state.error.message}</p></Notice>;
  }

  const { record } = state;
  const { rules, viewer, people, types } = record;
  const zone = rules.timezone ?? timezone;
  const canBook = !readOnly && viewer.may.book && !record.unavailable;
  return (
    <>
      {record.appointments.length === 0 && <p className="ops-muted">no appointments.</p>}
      <ul className="crm-items">
        {record.appointments.map((a) => (
          <AppointmentItem
            key={a.id} api={api} appointment={a} people={people} authority={rules.authority} timezone={zone} viewer={viewer} readOnly={readOnly}
            onChanged={changed} events={record.events.filter((e) => e.appointment_id === a.id)}
          />
        ))}
      </ul>
      {!readOnly && viewer.may.book && <Unavailable reason={record.unavailable} authority={rules.authority} setup={viewer.may.setup} />}
      {canBook && !booking && (
        <button type="button" className="ws-btn" onClick={() => setBooking(true)}>
          <Icon name="plus" size={13} /> book a time
        </button>
      )}
      {canBook && booking && (
        <>
          <BookForm api={api} types={types} target={JSON.parse(key)} people={people} viewer={viewer} timezone={zone} onBooked={async () => { setBooking(false); await changed(); }} />
          <button type="button" className="ws-btn" onClick={() => setBooking(false)}>close</button>
        </>
      )}
    </>
  );
}

/* ── the setup: rules, what can be booked, the page ─────── */

function HoursEditor({ hours, onChange }) {
  return (
    <ul className="crm-hours">
      {DAYS.map(([key, label]) => {
        const periods = hours[key] ?? [];
        const first = periods[0];
        return (
          <li key={key}>
            <label className="crm-check">
              <input type="checkbox" checked={periods.length > 0} onChange={(e) => onChange({ ...hours, [key]: e.target.checked ? [{ open: '08:00', close: '17:00' }] : [] })} /> {label}
            </label>
            {periods.length === 1 && (
              <>
                <input className="ops-input" type="time" aria-label={`${label} opens`} value={first.open} onChange={(e) => onChange({ ...hours, [key]: [{ ...first, open: e.target.value }] })} />
                <input className="ops-input" type="time" aria-label={`${label} closes`} value={first.close} onChange={(e) => onChange({ ...hours, [key]: [{ ...first, close: e.target.value }] })} />
              </>
            )}
            {periods.length > 1 && <span className="ops-muted">{periods.map((p) => `${p.open}–${p.close}`).join(', ')} — kept as they are</span>}
            {periods.length === 0 && <span className="ops-muted">closed</span>}
          </li>
        );
      })}
    </ul>
  );
}

function RulesForm({ api, rules, onSaved }) {
  const [form, setForm] = useState(() => ({
    hours_source: rules.hours_source,
    hours: rules.hours,
    slot_step_minutes: String(rules.slot_step_minutes),
    lead_hours: String(rules.min_lead_minutes / 60),
    max_days_ahead: String(rules.max_days_ahead),
    buffer_before_minutes: String(rules.buffer_before_minutes),
    buffer_after_minutes: String(rules.buffer_after_minutes),
    capacity: String(rules.capacity),
    customer_may_cancel: rules.customer_may_cancel,
    customer_may_reschedule: rules.customer_may_reschedule,
    cutoff_hours: String(rules.customer_change_cutoff_minutes / 60),
    enforce_service_area: rules.enforce_service_area,
    closed: rules.closed_dates.join(', '),
  }));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const custom = form.hours_source === 'custom';
  return (
    <div className="ops-form crm-form">
      <Field label="the hours bookings follow" wide hint="the business's opening hours, or hours kept only for bookings.">
        <SelectInput value={form.hours_source} onChange={(e) => set({ hours_source: e.target.value })} options={[{ value: 'business_hours', label: 'the opening hours on the business profile' }, { value: 'custom', label: 'hours of their own' }]} />
      </Field>
      <div className="ops-field ops-field--wide">
        {custom
          ? <HoursEditor hours={form.hours} onChange={(hours) => set({ hours })} />
          : <p className="crm-item__meta">{DAYS.map(([key, label]) => `${label.slice(0, 3)} ${(rules.hours_source === 'business_hours' ? rules.hours[key] ?? [] : []).map((p) => `${p.open}–${p.close}`).join(', ') || 'closed'}`).join(' · ')}</p>}
      </div>
      <Field label="a time is offered every">
        <SelectInput value={form.slot_step_minutes} onChange={(e) => set({ slot_step_minutes: e.target.value })} options={SLOT_STEPS.map((n) => ({ value: String(n), label: `${n} minutes` }))} />
      </Field>
      <Field label="notice a booking needs (hours)">
        <TextInput type="number" min={0} max={720} step="0.5" value={form.lead_hours} onChange={(e) => set({ lead_hours: e.target.value })} />
      </Field>
      <Field label="open this many days ahead">
        <TextInput type="number" min={1} max={365} value={form.max_days_ahead} onChange={(e) => set({ max_days_ahead: e.target.value })} />
      </Field>
      <Field label={<Term k="booking_capacity">at the same time</Term>} hint="one crew is 1.">
        <TextInput type="number" min={1} max={20} value={form.capacity} onChange={(e) => set({ capacity: e.target.value })} />
      </Field>
      <Field label="kept free before (minutes)">
        <TextInput type="number" min={0} max={240} value={form.buffer_before_minutes} onChange={(e) => set({ buffer_before_minutes: e.target.value })} />
      </Field>
      <Field label="kept free after (minutes)">
        <TextInput type="number" min={0} max={240} value={form.buffer_after_minutes} onChange={(e) => set({ buffer_after_minutes: e.target.value })} />
      </Field>
      <Field label="closed days" wide hint="dates nothing is offered on, written YYYY-MM-DD and separated by commas.">
        <TextInput value={form.closed} placeholder="2026-12-25, 2027-01-01" onChange={(e) => set({ closed: e.target.value })} />
      </Field>
      <div className="ops-field ops-field--wide">
        <span className="ops-field__label">from the link a customer is given</span>
        <label className="crm-check"><input type="checkbox" checked={form.customer_may_reschedule} onChange={(e) => set({ customer_may_reschedule: e.target.checked })} /> they can move their appointment</label>
        <label className="crm-check"><input type="checkbox" checked={form.customer_may_cancel} onChange={(e) => set({ customer_may_cancel: e.target.checked })} /> they can cancel it</label>
      </div>
      <Field label="until this many hours before">
        <TextInput type="number" min={0} max={720} step="0.5" value={form.cutoff_hours} onChange={(e) => set({ cutoff_hours: e.target.value })} />
      </Field>
      <div className="ops-field">
        <label className="crm-check"><input type="checkbox" checked={form.enforce_service_area} onChange={(e) => set({ enforce_service_area: e.target.checked })} /> turn away an address outside the service area</label>
        <span className="ops-field__hint">only when the address can be checked against a ZIP, a city or a state on file. nobody is turned away on a guess.</span>
      </div>
      <div className="ops-form__row">
        <ActionButton
          variant="primary"
          icon="check"
          confirm="save these rules? they apply to every booking made from now on. nothing already in the calendar is moved or cancelled."
          onRun={async () => {
            await api.saveBookingSettings({
              hours_source: form.hours_source,
              ...(custom ? { custom_hours: Object.fromEntries(Object.entries(form.hours).filter(([, periods]) => periods.length > 0)) } : {}),
              slot_step_minutes: Number(form.slot_step_minutes),
              min_lead_minutes: Math.round(Number(form.lead_hours) * 60),
              max_days_ahead: Number(form.max_days_ahead),
              buffer_before_minutes: Number(form.buffer_before_minutes),
              buffer_after_minutes: Number(form.buffer_after_minutes),
              capacity: Number(form.capacity),
              customer_may_cancel: form.customer_may_cancel,
              customer_may_reschedule: form.customer_may_reschedule,
              customer_change_cutoff_minutes: Math.round(Number(form.cutoff_hours) * 60),
              enforce_service_area: form.enforce_service_area,
              closed_dates: form.closed.split(/[\s,]+/).filter(Boolean),
            });
            await onSaved();
            return 'saved';
          }}
        >
          save the rules
        </ActionButton>
      </div>
    </div>
  );
}

function TypeForm({ api, type, services, onSaved, onClose }) {
  const [form, setForm] = useState(() => ({
    name: type?.name ?? '', duration: String(type?.duration_minutes ?? 60), service_id: type?.service_id ?? '',
    requires_approval: type?.requires_approval ?? true, is_public: type?.is_public ?? true, description: type?.description ?? '',
  }));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const key = slug(form.name);
  return (
    <div className="ops-form crm-form">
      <Field label="what it is called" required hint="a customer sees this on the booking page.">
        <TextInput value={form.name} maxLength={120} placeholder="Site visit" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="how long (minutes)" required>
        <TextInput type="number" min={5} max={480} step={5} value={form.duration} onChange={(e) => set({ duration: e.target.value })} />
      </Field>
      {services.length > 0 && (
        <Field label="the service it is for">
          <SelectInput value={form.service_id} onChange={(e) => set({ service_id: e.target.value })} options={[{ value: '', label: 'any' }, ...services.map((s) => ({ value: s.id, label: s.name }))]} />
        </Field>
      )}
      <Field label="a line about it" wide>
        <TextInput value={form.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="ops-field ops-field--wide">
        <label className="crm-check">
          <input type="checkbox" checked={form.requires_approval} onChange={(e) => set({ requires_approval: e.target.checked })} /> <Term k="appt_approval">needs approval</Term> — a customer&rsquo;s booking is a request until a person confirms it
        </label>
        <label className="crm-check"><input type="checkbox" checked={form.is_public} onChange={(e) => set({ is_public: e.target.checked })} /> offered on the booking page</label>
      </div>
      <div className="ops-form__row">
        <ActionButton
          variant="primary"
          icon="check"
          disabled={!form.name.trim() || (!type && key.length < 2)}
          onRun={async () => {
            const body = {
              name: form.name, duration_minutes: Number(form.duration), service_id: form.service_id || null, description: form.description || null,
              requires_approval: form.requires_approval, is_public: form.is_public,
            };
            await api.saveAppointmentType(type ? body : { key, ...body }, type?.id);
            await onSaved();
            onClose();
            return 'saved';
          }}
        >
          {type ? 'save' : 'add it'}
        </ActionButton>
        <button type="button" className="ws-btn" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

function Types({ api, overview, reload }) {
  const [editing, setEditing] = useState(null); // a type id, or 'new'
  return (
    <>
      {overview.types.length === 0 && <p className="ops-muted">nothing can be booked yet.</p>}
      <ul className="crm-items">
        {overview.types.map((type) => (
          <li key={type.id} className={`crm-item${type.archived_at ? ' is-done' : ''}`}>
            <span>
              <b>{type.name}</b> <span className="crm-item__meta">{type.duration_minutes} min{type.requires_approval ? ' · needs approval' : ' · confirmed at once'}{type.is_public ? '' : ' · not on the booking page'}{type.archived_at ? ' · retired' : ''}</span>
            </span>
            <div className="ops-row">
              {!type.archived_at && <button type="button" className="ws-btn" onClick={() => setEditing(editing === type.id ? null : type.id)}><Icon name="edit" size={13} /> edit</button>}
              {type.archived_at ? (
                <ActionButton icon="refresh" onRun={async () => { await api.saveAppointmentType({ archived: false }, type.id); await reload(); return 'back in use'; }}>bring back</ActionButton>
              ) : (
                <ActionButton icon="archive" confirm={`retire "${type.name}"? it can no longer be booked. appointments already made keep it, and it can be brought back.`} onRun={async () => { await api.saveAppointmentType({ archived: true }, type.id); await reload(); return 'retired'; }}>
                  retire
                </ActionButton>
              )}
            </div>
            {editing === type.id && <TypeForm api={api} type={type} services={overview.services} onSaved={reload} onClose={() => setEditing(null)} />}
          </li>
        ))}
      </ul>
      {editing === 'new'
        ? <TypeForm api={api} services={overview.services} onSaved={reload} onClose={() => setEditing(null)} />
        : <button type="button" className="ws-btn" onClick={() => setEditing('new')}><Icon name="plus" size={13} /> add something to book</button>}
    </>
  );
}

function PageForm({ api, page, onSaved, onClose }) {
  const start = page?.definition ?? defaultPageDefinition('Book a visit');
  const [form, setForm] = useState(() => ({
    name: page?.name ?? 'Website booking', title: start.title, intro: start.intro ?? '', address: start.address, note: start.note,
    sms: Boolean(start.consent?.sms), smsText: start.consent?.sms?.text ?? defaultPageDefinition('').consent.sms.text,
  }));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <div className="ops-form crm-form">
      <Field label="what you call this page" required hint="only the team sees this.">
        <TextInput value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="the heading a customer sees" required>
        <TextInput value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="a line under it" wide>
        <TextInput value={form.intro} maxLength={500} onChange={(e) => set({ intro: e.target.value })} />
      </Field>
      <Field label="ask where the visit is">
        <SelectInput value={form.address} onChange={(e) => set({ address: e.target.value })} options={[{ value: 'optional', label: 'yes, optional' }, { value: 'required', label: 'yes, required' }, { value: 'off', label: 'no' }]} />
      </Field>
      <div className="ops-field">
        <label className="crm-check"><input type="checkbox" checked={form.note} onChange={(e) => set({ note: e.target.checked })} /> a box for anything else they want to say</label>
        <label className="crm-check"><input type="checkbox" checked={form.sms} onChange={(e) => set({ sms: e.target.checked })} /> ask for permission to text</label>
      </div>
      {form.sms && (
        <Field label="the words next to the tick box" wide hint="kept with every booking as what the customer was shown. it is evidence of that, not permission to send.">
          <TextArea value={form.smsText} maxLength={500} onChange={(e) => set({ smsText: e.target.value })} />
        </Field>
      )}
      <div className="ops-form__row">
        <ActionButton
          variant="primary"
          icon="check"
          disabled={!form.name.trim() || !form.title.trim()}
          onRun={async () => {
            const definition = {
              ...start, title: form.title, intro: form.intro || null, address: form.address, note: form.note,
              consent: { ...(start.consent?.email ? { email: start.consent.email } : {}), ...(form.sms ? { sms: { mode: start.consent?.sms?.mode ?? 'optional', text: form.smsText } } : {}) },
            };
            await api.saveBookingPage({ name: form.name, definition }, page?.id);
            await onSaved();
            onClose();
            return page ? 'saved' : 'made, as a draft';
          }}
        >
          {page ? 'save' : 'make the page'}
        </ActionButton>
        <button type="button" className="ws-btn" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

function Pages({ api, overview, reload }) {
  const [editing, setEditing] = useState(null);
  const status = (page, next, done) => async () => {
    await api.setBookingPageStatus(page.id, next);
    await reload();
    return done;
  };
  return (
    <>
      {overview.pages.length === 0 && <p className="ops-muted">no booking page yet. a page is a link a customer books on; it can also be framed on the business&rsquo;s own site.</p>}
      <ul className="crm-items">
        {overview.pages.map((page) => (
          <li key={page.id} className="crm-item">
            <span>
              <b>{page.name}</b> <Pill tone={PAGE_TONE[page.status]}><Term k={page.status}>{page.status}</Term></Pill>
              <span className="crm-item__meta"> version {page.version}</span>
            </span>
            {page.status !== 'archived' && (
              <div className="ops-row">
                <CopyValue label="link" value={bookingUrl(siteUrl(), page.public_key)} />
                <CopyValue label="embed" value={bookingEmbedSnippet(siteUrl(), page.public_key, page.definition.title)} display="a frame around the hosted page — no script" />
              </div>
            )}
            <div className="ops-row">
              {page.status !== 'archived' && <button type="button" className="ws-btn" onClick={() => setEditing(editing === page.id ? null : page.id)}><Icon name="edit" size={13} /> edit</button>}
              {page.status === 'draft' && (
                <ActionButton variant="primary" icon="check" confirm={`publish "${page.name}"? anybody with the link can book a time with this business from that moment.`} onRun={status(page, 'published', 'published')}>
                  publish
                </ActionButton>
              )}
              {page.status === 'published' && (
                <ActionButton confirm={`take "${page.name}" back to a draft? the link stops taking bookings until it is published again. bookings already made are kept, and their own links still work.`} onRun={status(page, 'draft', 'back to a draft')}>
                  unpublish
                </ActionButton>
              )}
              {page.status !== 'archived' && (
                <ActionButton icon="archive" confirm={`archive "${page.name}"? the link stops taking bookings. bookings already made are kept, and their own links still work.`} onRun={status(page, 'archived', 'archived')}>
                  archive
                </ActionButton>
              )}
              {page.status === 'archived' && <ActionButton icon="refresh" onRun={status(page, 'draft', 'restored as a draft')}>restore as a draft</ActionButton>}
            </div>
            {editing === page.id && <PageForm api={api} page={page} onSaved={reload} onClose={() => setEditing(null)} />}
          </li>
        ))}
      </ul>
      {editing === 'new'
        ? <PageForm api={api} onSaved={reload} onClose={() => setEditing(null)} />
        : <button type="button" className="ws-btn" onClick={() => setEditing('new')}><Icon name="plus" size={13} /> make a booking page</button>}
    </>
  );
}

/* ── the calendar ───────────────────────────────────────── */

/** the read failed: either the backend is not there yet (and what fixes that), or the server's own words. */
export function BookingError({ error, door, onRetry }) {
  if (isNotDeployed(error)) {
    return (
      <Notice tone="warn" title="booking is not switched on here yet">
        {door === 'ops'
          ? <p>apply <code>0027_crm_booking.sql</code>, redeploy the <code>ops</code> and <code>crm</code> functions, and deploy <code>native-booking</code> — the calendar reads and writes through them.</p>
          : <p>this part of your workspace is still being set up. nothing is wrong with your leads — get in touch and we will switch it on.</p>}
      </Notice>
    );
  }
  return (
    <Notice tone="fail" title="the calendar could not be read">
      <p>{error?.message ?? 'unknown error'}</p>
      <button type="button" className="ws-btn" onClick={onRetry}><Icon name="refresh" size={13} /> try again</button>
    </Notice>
  );
}

/**
 * The bookings view of the workspace: what is waiting for an answer, the week, and — for the
 * account owner or an operator — the setup. `initial` draws it from a known answer (the tests,
 * the demo's first paint).
 */
export function Bookings({ api, timezone: zone, readOnly = false, onOpenLead, onOpenContact, initial = null }) {
  const [state, setState] = useState(initial ? { kind: 'ready', overview: initial } : { kind: 'loading' });
  const [week, setWeek] = useState(0);

  const reload = useCallback(async () => {
    try {
      setState({ kind: 'ready', overview: await api.booking() });
    } catch (error) {
      setState((prev) => (prev.kind === 'ready' ? { ...prev, stale: error.message } : { kind: 'error', error }));
    }
  }, [api]);
  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the calendar…</p>;
  if (state.kind === 'error') return <BookingError error={state.error} door={api.door} onRetry={reload} />;

  const { overview } = state;
  const { rules, viewer, people } = overview;
  const timezone = rules.timezone ?? zone ?? 'UTC';
  const contactOf = (a) => overview.contacts.find((c) => c.id === a.contact_id) ?? null;
  const open = (a) => (a.lead_id ? onOpenLead?.(a.lead_id) : onOpenContact?.(a.contact_id));
  const item = (a) => (
    <AppointmentItem
      key={a.id} api={api} appointment={a} contact={contactOf(a)} people={people} authority={rules.authority} timezone={timezone}
      viewer={viewer} readOnly={readOnly} onChanged={reload} onOpen={open}
    />
  );

  const now = Date.now();
  const requests = overview.appointments.filter((a) => a.status === 'requested' && a.sync_state !== 'conflict');
  const conflicts = overview.appointments.filter((a) => a.sync_state === 'conflict');
  const today = localDate(new Date(now), timezone);
  /* the week on screen starts on its Monday, in the business's own calendar. */
  const monday = addDays(today, week * 7 - ((DAYS.findIndex(([key]) => key === weekdayOf(today)) + 7) % 7));
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const inWeek = overview.appointments.filter((a) => {
    const date = localDate(new Date(a.starts_at), timezone);
    return date >= dates[0] && date <= dates[6];
  });
  const byDay = new Map(agendaDays(inWeek, timezone).map((day) => [day.date, day.appointments]));
  const held = overview.appointments.filter((a) => (a.status === 'requested' || a.status === 'confirmed') && Date.parse(a.ends_at) >= now);
  const setup = !readOnly && viewer.may.setup;

  return (
    <>
      {state.stale && <Notice tone="warn" title="this may be out of date"><p>the last refresh failed: {state.stale}</p></Notice>}
      <p className="crm-item__meta">
        {held.length} ahead · {requests.length} waiting for an answer{conflicts.length > 0 ? ` · ${conflicts.length} to settle` : ''} · times in {timezone}
      </p>
      <Unavailable reason={overview.unavailable} authority={rules.authority} setup={setup} />

      {conflicts.length > 0 && (
        <section className="crm-section">
          <h4><Term k="sync_conflict">needs settling</Term> <span className="crm-count">{conflicts.length}</span></h4>
          <ul className="crm-items">{conflicts.map(item)}</ul>
        </section>
      )}

      {requests.length > 0 && (
        <section className="crm-section">
          <h4>waiting for an answer <span className="crm-count">{requests.length}</span></h4>
          <p className="crm-item__meta">a customer asked for each of these times. the time is held for them until it is confirmed or declined.</p>
          <ul className="crm-items">{requests.map(item)}</ul>
        </section>
      )}

      <section className="crm-section">
        <h4>the week</h4>
        <div className="ops-row">
          <button type="button" className="ws-btn" disabled={week <= -1} onClick={() => setWeek((w) => w - 1)}>← earlier</button>
          <button type="button" className={`ws-btn${week === 0 ? ' ws-btn--primary' : ''}`} aria-pressed={week === 0} onClick={() => setWeek(0)}>this week</button>
          <button type="button" className="ws-btn" onClick={() => setWeek((w) => w + 1)}>later →</button>
          <span className="ops-muted">{dayLabel(dates[0])} – {dayLabel(dates[6])}</span>
        </div>
        <div className="crm-week" role="list" aria-label={`appointments from ${dayLabel(dates[0])} to ${dayLabel(dates[6])}`}>
          {dates.map((date) => {
            const list = byDay.get(date) ?? [];
            return (
              <section key={date} role="listitem" className={`crm-day${date === today ? ' is-today' : ''}${list.length === 0 ? ' is-empty' : ''}`}>
                <h5>{dayLabel(date)}{date === today ? ' · today' : ''} <span className="crm-count">{list.length}</span></h5>
                {list.length === 0 ? <p className="crm-col__empty">nothing booked</p> : <ul className="crm-items">{list.map(item)}</ul>}
              </section>
            );
          })}
        </div>
        {overview.appointments.length === 0 && (
          <Empty title="nothing in the calendar yet">an appointment booked from a lead, or by a customer on the booking page, shows here.</Empty>
        )}
        {overview.truncated && <p className="ws-note">this view holds the next 500 appointments. later ones are kept and are found from their lead.</p>}
        <p className="ws-note">confirming, moving or cancelling changes the calendar and is written to the appointment&rsquo;s history with who did it. it sends the customer nothing. a completed appointment is what a person marked — it is not counted as a proven result anywhere.</p>
      </section>

      {setup && (
        <section className="crm-section">
          <h4>setup</h4>
          <Disclosure title="rules" summary={`${rules.slot_step_minutes}-minute steps · ${rules.min_lead_minutes / 60}h notice · ${rules.max_days_ahead} days ahead · ${rules.capacity} at a time`}>
            <RulesForm key={overview.read_at} api={api} rules={rules} onSaved={reload} />
          </Disclosure>
          <Disclosure title="what can be booked" summary={`${overview.types.filter((t) => !t.archived_at).length} in use`}>
            <Types api={api} overview={overview} reload={reload} />
          </Disclosure>
          <Disclosure title="booking pages" summary={`${overview.pages.filter((p) => p.status === 'published').length} published`}>
            <Pages api={api} overview={overview} reload={reload} />
            <p className="ws-note">a booking made on a page arrives as a lead with its appointment, like any other lead. whose calendar it is — this one, or the business&rsquo;s own — is set up by ARC.</p>
          </Disclosure>
        </section>
      )}
    </>
  );
}
