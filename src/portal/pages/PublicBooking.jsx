import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { addDays, BOOKING_KEY, localDate, MANAGE_TOKEN, parseSubmission } from '../../../supabase/functions/_shared/booking/model.ts';
import { instantFor } from '../../../supabase/functions/_shared/engine/hours.ts';
import './PublicForm.css';
import './PublicBooking.css';

/**
 * ARC-380 — a client's hosted booking page, at `/book/<key>`, and the page a customer's own
 * link opens, at `/book/<key>/manage#<token>`. The same page is what the embed frames
 * (`?embed=1`), so there is one renderer and no script on anybody else's site.
 *
 * It is read by a member of the public who has never heard of ARC: the business's name, what
 * can be booked, the times that are free, a few details, one button. The page knows only the
 * key in its address. Every time shown is in the business's own timezone, and says so.
 *
 * It decides nothing. The times are the `native-booking` function's answer; a booking is
 * checked here with the same `parseSubmission` the function runs, so a mistake shows next to
 * the field before anything is sent; and whether a time is still free is decided by the
 * database when the booking arrives — "that time has just been taken" is its answer, printed.
 *
 * The token in a customer's link rides in the address's fragment, which a browser does not
 * send to any server, and goes to the function in a request body. It is never in a query string.
 *
 * Deliberately not the Supabase client, as the hosted form is not: two GETs and a POST.
 */

const ENDPOINT = `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/native-booking`;
const CONFIGURED = Boolean(import.meta.env.VITE_SUPABASE_URL);
const AUTOCOMPLETE = { name: 'name', phone: 'tel', email: 'email', address: 'street-address', city: 'address-level2', postal_code: 'postal-code' };
const STATUS_WORDS = {
  requested: 'Waiting for the business to confirm', confirmed: 'Confirmed', declined: 'Declined by the business',
  cancelled: 'Cancelled', completed: 'Completed', no_show: 'Missed',
};

const format = (iso, timeZone, options) => new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(iso));
const clock = (iso, zone) => format(iso, zone, { hour: 'numeric', minute: '2-digit' });
const longWhen = (iso, zone) => format(iso, zone, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dayParts = (date) => {
  const at = new Date(`${date}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(at),
    day: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(at),
    long: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(at),
  };
};

function newSubmissionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

async function send(route, body) {
  const response = await fetch(`${ENDPOINT}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
}

/* ── choosing a day and a time ──────────────────────────── */

/**
 * A week of days, and the times free on the one chosen. `load(from)` asks the function for
 * seven days starting at `from`; nothing here works out what is free.
 */
export function TimePicker({ load, timezone, today, lastDay, value, onChange, refresh = 0, initial = null }) {
  const [from, setFrom] = useState(today);
  const [state, setState] = useState(initial ? { kind: 'ready', slots: initial.slots } : { kind: 'loading' });
  const [day, setDay] = useState(null);

  useEffect(() => {
    if (initial) return undefined;
    let live = true;
    setState({ kind: 'loading' });
    load(from)
      .then((availability) => live && setState(availability ? { kind: 'ready', slots: availability.slots } : { kind: 'failed' }))
      .catch(() => live && setState({ kind: 'failed' }));
    return () => {
      live = false;
    };
  }, [load, from, refresh, initial]);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const slot of state.kind === 'ready' ? state.slots : []) {
      const date = localDate(new Date(slot.starts_at), timezone);
      map.set(date, [...(map.get(date) ?? []), slot]);
    }
    return map;
  }, [state, timezone]);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i)).filter((date) => date <= lastDay);
  const shown = day && byDay.has(day) ? day : dates.find((date) => byDay.has(date)) ?? null;
  const times = shown ? byDay.get(shown) : [];

  return (
    <div className="pbook__when">
      <div className="pbook__nav">
        <button type="button" className="pbook__step" disabled={from <= today} onClick={() => { setDay(null); onChange(null); setFrom(addDays(from, -7) < today ? today : addDays(from, -7)); }}>
          ← Earlier
        </button>
        <button type="button" className="pbook__step" disabled={addDays(from, 7) > lastDay} onClick={() => { setDay(null); onChange(null); setFrom(addDays(from, 7)); }}>
          Later →
        </button>
      </div>
      <div className="pbook__days" role="group" aria-label="Choose a day">
        {dates.map((date) => {
          const parts = dayParts(date);
          const free = byDay.has(date);
          return (
            <button
              key={date}
              type="button"
              className="pbook__day"
              aria-pressed={date === shown}
              aria-label={free ? parts.long : `${parts.long}, no times free`}
              disabled={!free}
              onClick={() => { setDay(date); onChange(null); }}
            >
              <span>{parts.weekday}</span>
              <b>{parts.day}</b>
            </button>
          );
        })}
      </div>
      {state.kind === 'loading' && <p className="pform__quiet" aria-busy="true">Looking for free times…</p>}
      {state.kind === 'failed' && <p className="pform__error" role="alert">The free times could not be loaded. Please try again in a moment.</p>}
      {state.kind === 'ready' && !shown && <p className="pform__quiet">No times are free this week. Try a later one.</p>}
      {shown && (
        <div className="pbook__times" role="group" aria-label={`Times on ${dayParts(shown).long}`}>
          {times.map((slot) => (
            <button key={slot.starts_at} type="button" className="pbook__time" aria-pressed={slot.starts_at === value} onClick={() => onChange(slot.starts_at)}>
              {clock(slot.starts_at, timezone)}
            </button>
          ))}
        </div>
      )}
      <p className="pform__help">Times are shown in the business&rsquo;s local time ({timezone.replace(/_/g, ' ')}).</p>
    </div>
  );
}

/* ── booking ────────────────────────────────────────────── */

function TextField({ name, label, required, type = 'text', value, error, onChange, multiline = false, maxLength }) {
  const id = `pb-${name}`;
  const props = {
    id, name, required, maxLength, value: value ?? '', 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined,
    onChange: (e) => onChange(e.target.value),
  };
  return (
    <div className="pform__field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : <span className="pform__optional"> (optional)</span>}
      </label>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} type={type} autoComplete={AUTOCOMPLETE[name] ?? 'off'} />}
      {error && <p className="pform__error" id={`${id}-error`}>{label} {error}</p>}
    </div>
  );
}

/** what the customer is told once the booking is made: the time, where it stands, and their own link. */
export function Booked({ page, booking, pageKey }) {
  const href = `${import.meta.env.BASE_URL ?? '/'}book/${pageKey}/manage#${booking.manage_token}`;
  return (
    <div role="status">
      <p className="pform__business">{page.business}</p>
      <h1 className="pform__title">{booking.status === 'confirmed' ? 'You are booked' : 'Your request is in'}</h1>
      <div className="pbook__summary">
        <b>{booking.title}</b>
        <span>{longWhen(booking.starts_at, booking.timezone)}</span>
        <span>{booking.status === 'confirmed' ? 'Confirmed.' : `${page.business} will confirm this time with you. It is held for you until they do.`}</span>
      </div>
      <p className="pform__intro">{page.success_message}</p>
      <p className="pbook__link">
        <a href={href}>Change or cancel this booking</a>
      </p>
      <p className="pform__help">Keep that link — it is the only way to change this booking online. It works for you alone.</p>
    </div>
  );
}

export function BookingFlow({ pageKey, embedded = false, initial = null }) {
  const [state, setState] = useState(initial ? { kind: 'ready', page: initial.page } : { kind: 'loading' });
  const [typeKey, setTypeKey] = useState(initial?.page.types.length === 1 ? initial.page.types[0].key : '');
  const [slot, setSlot] = useState(null);
  const [wish, setWish] = useState({ date: '', time: '' });
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | sending | failed
  const [failure, setFailure] = useState('');
  const [booked, setBooked] = useState(initial?.booked ?? null);
  const [refresh, setRefresh] = useState(0);
  const renderedAt = useRef(Date.now());
  const submissionId = useRef(null);
  const formNode = useRef(null);

  useEffect(() => {
    if (initial) return undefined;
    let live = true;
    if (!BOOKING_KEY.test(pageKey ?? '') || !CONFIGURED) {
      setState({ kind: 'unavailable' });
      return undefined;
    }
    fetch(`${ENDPOINT}/page?key=${encodeURIComponent(pageKey)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live) return;
        if (!body?.page) return setState({ kind: 'unavailable' });
        document.title = `${body.page.title} — ${body.page.business}`;
        renderedAt.current = Date.now();
        if (body.page.types.length === 1) setTypeKey(body.page.types[0].key);
        return setState({ kind: 'ready', page: body.page });
      })
      .catch(() => live && setState({ kind: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [pageKey, initial]);

  const page = state.kind === 'ready' ? state.page : null;
  const load = useCallback(
    (from) => fetch(`${ENDPOINT}/slots?key=${encodeURIComponent(pageKey)}&type=${encodeURIComponent(typeKey)}&from=${from}&days=7`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => body?.availability ?? null),
    [pageKey, typeKey],
  );
  const errorFor = (field) => errors.find((error) => error.field === field)?.message;
  const set = (field, value) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => current.filter((error) => error.field !== field));
  };
  /* a preferred time, where the business keeps its own calendar: what they typed, in its timezone. */
  const wished = page?.mode === 'request' && wish.date && wish.time ? instantFor(wish.date, wish.time, page.timezone)?.toISOString() ?? null : null;
  const startsAt = page?.mode === 'request' ? wished : slot;

  async function submit(event) {
    event.preventDefault();
    if (!page || phase === 'sending') return;
    const answers = { ...values, type: typeKey || undefined, starts_at: startsAt ?? undefined };
    const checked = parseSubmission(page, answers, { types: page.types });
    if (!checked.ok) {
      setErrors(checked.errors);
      formNode.current?.querySelector(`[name="${checked.errors[0].field}"]`)?.focus();
      return;
    }
    submissionId.current ??= newSubmissionId();
    setPhase('sending');
    setFailure('');
    try {
      const response = await send('/book', {
        key: pageKey,
        values: answers,
        submission_id: submissionId.current,
        rendered_at: renderedAt.current,
        company_website: new FormData(formNode.current).get('company_website') ?? '',
        attribution: { page: window.location.href, referrer: document.referrer, embedded },
      });
      if (response.ok && response.body?.booking) return setBooked(response.body.booking);
      if (response.status === 422 && response.body?.field_errors?.length) {
        setErrors(response.body.field_errors);
        return setPhase('idle');
      }
      if (response.status === 409) {
        /* somebody got there first: a new attempt is a new booking, with the times read again. */
        submissionId.current = null;
        setSlot(null);
        setRefresh((n) => n + 1);
      }
      setFailure(response.body?.error ?? 'That did not go through.');
      return setPhase('failed');
    } catch {
      setFailure('That did not go through — check your connection and try again.');
      return setPhase('failed');
    }
  }

  if (state.kind === 'loading') return <p className="pform__quiet" aria-busy="true">Loading…</p>;
  if (state.kind === 'unavailable') {
    return (
      <>
        <h1 className="pform__title">This booking page is not available</h1>
        <p className="pform__quiet">The link may be out of date. Please contact the business directly.</p>
      </>
    );
  }
  if (booked) return <Booked page={page} booking={booked} pageKey={pageKey} />;

  const type = page.types.find((t) => t.key === typeKey) ?? null;
  const request = page.mode === 'request';
  return (
    <form ref={formNode} onSubmit={submit} noValidate>
      <p className="pform__business">{page.business}</p>
      <h1 className="pform__title">{page.title}</h1>
      {page.intro && <p className="pform__intro">{page.intro}</p>}

      {page.types.length === 0 && <p className="pform__quiet">Online booking is not open right now. Please contact the business directly.</p>}

      {page.types.length > 1 && (
        <fieldset className="pbook__group">
          <legend>What is it for?</legend>
          <div className="pbook__types">
            {page.types.map((t) => (
              <label key={t.key} className="pbook__type">
                <input type="radio" name="type" value={t.key} checked={typeKey === t.key} onChange={() => { setTypeKey(t.key); setSlot(null); setErrors((list) => list.filter((e) => e.field !== 'type')); }} />
                <span>
                  <b>{t.name}</b>
                  <span className="pform__optional"> about {t.duration_minutes} minutes</span>
                  {t.description && <span className="pbook__about">{t.description}</span>}
                </span>
              </label>
            ))}
          </div>
          {errorFor('type') && <p className="pform__error">Please {errorFor('type')}.</p>}
        </fieldset>
      )}

      {type && (
        <fieldset className="pbook__group">
          <legend>{request ? 'When would suit you?' : 'When?'}</legend>
          {page.types.length === 1 && <p className="pform__help">{type.name}, about {type.duration_minutes} minutes.</p>}
          {request ? (
            <>
              <div className="pbook__wish">
                <label>
                  Day
                  <input type="date" name="wish_date" min={page.today} max={page.last_day} value={wish.date} onChange={(e) => setWish({ ...wish, date: e.target.value })} />
                </label>
                <label>
                  Time
                  <input type="time" name="wish_time" step={900} value={wish.time} onChange={(e) => setWish({ ...wish, time: e.target.value })} />
                </label>
              </div>
              <p className="pform__help">
                This is a request, not a booking yet. {page.business} keeps its own calendar and will confirm the time with you. Times are in the
                business&rsquo;s local time ({page.timezone.replace(/_/g, ' ')}).
              </p>
            </>
          ) : (
            <TimePicker key={typeKey} load={load} timezone={page.timezone} today={page.today} lastDay={page.last_day} value={slot} onChange={setSlot} refresh={refresh} initial={initial?.availability ?? null} />
          )}
          {errorFor('starts_at') && <p className="pform__error">Please {errorFor('starts_at')}.</p>}
        </fieldset>
      )}

      {type && startsAt && (
        <fieldset className="pbook__group">
          <legend>Your details</legend>
          <div className="pbook__summary">
            <b>{type.name}</b>
            <span>{longWhen(startsAt, page.timezone)}</span>
          </div>
          <TextField name="name" label="Your name" required value={values.name} error={errorFor('name')} onChange={(v) => set('name', v)} maxLength={120} />
          <TextField name="phone" label="Phone number" type="tel" required={!values.email} value={values.phone} error={errorFor('phone')} onChange={(v) => set('phone', v)} maxLength={24} />
          <TextField name="email" label="Email" type="email" value={values.email} error={errorFor('email')} onChange={(v) => set('email', v)} maxLength={200} />
          {page.address !== 'off' && (
            <>
              <TextField name="address" label="Street address" required={page.address === 'required'} value={values.address} error={errorFor('address')} onChange={(v) => set('address', v)} maxLength={200} />
              <TextField name="city" label="City" value={values.city} error={errorFor('city')} onChange={(v) => set('city', v)} maxLength={120} />
              <TextField name="postal_code" label="ZIP code" required={page.address === 'required'} value={values.postal_code} error={errorFor('postal_code')} onChange={(v) => set('postal_code', v)} maxLength={20} />
            </>
          )}
          {page.note && <TextField name="note" label="Anything we should know" multiline value={values.note} error={errorFor('note')} onChange={(v) => set('note', v)} maxLength={1000} />}

          {/* a field a person never sees and a script usually fills. */}
          <div className="pform__hp" aria-hidden="true">
            <label>
              Company website
              <input name="company_website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>

          {['sms', 'email'].map((channel) => {
            const asked = page.consent?.[channel];
            const name = `consent_${channel}`;
            const problem = errorFor(name);
            if (!asked) return null;
            return (
              <div key={channel} className="pform__field">
                {/* never ticked for them: what is sent is what they chose. */}
                <label className="pform__tick">
                  <input type="checkbox" name={name} checked={values[name] === true} onChange={(e) => set(name, e.target.checked)} />
                  <span>{asked.text}</span>
                </label>
                {problem && <p className="pform__error">{problem.charAt(0).toUpperCase() + problem.slice(1)}</p>}
              </div>
            );
          })}

          {errors.length > 0 && (
            <p className="pform__error" role="alert">
              {errors.length === 1 ? 'One detail needs another look.' : `${errors.length} details need another look.`}
            </p>
          )}
          {phase === 'failed' && <p className="pform__error" role="alert">{failure}</p>}

          <button type="submit" className="pform__send" disabled={phase === 'sending'}>
            {phase === 'sending' ? 'Sending…' : request || type.requires_approval ? 'Request this time' : 'Book this time'}
          </button>
          {(request || type.requires_approval) && <p className="pform__help">The business confirms the time before it is final.</p>}
        </fieldset>
      )}
      {phase === 'failed' && !startsAt && <p className="pform__error" role="alert">{failure}</p>}
    </form>
  );
}

/* ── a customer's own link ──────────────────────────────── */

export function ManageFlow({ pageKey, token, initial = null }) {
  const [state, setState] = useState(initial ? { kind: 'ready', view: initial } : { kind: 'loading' });
  const [mode, setMode] = useState('view'); // view | move | cancel
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text }
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (initial) return undefined;
    let live = true;
    if (!BOOKING_KEY.test(pageKey ?? '') || !MANAGE_TOKEN.test(token ?? '') || !CONFIGURED) {
      setState({ kind: 'unknown' });
      return undefined;
    }
    send('/manage', { key: pageKey, token })
      .then((response) => live && setState(response.ok && response.body?.appointment ? { kind: 'ready', view: response.body.appointment } : { kind: 'unknown' }))
      .catch(() => live && setState({ kind: 'unknown' }));
    return () => {
      live = false;
    };
  }, [pageKey, token, initial]);

  const load = useCallback(
    (from) => send('/manage/slots', { key: pageKey, token, from, days: 7 }).then((response) => (response.ok ? response.body?.availability ?? null : null)),
    [pageKey, token],
  );

  async function change(body, done) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await send('/manage/change', { key: pageKey, token, ...body });
      if (response.ok && response.body?.appointment) {
        setState({ kind: 'ready', view: response.body.appointment });
        setMode('view');
        setSlot(null);
        setMessage({ tone: 'ok', text: done(response.body.appointment) });
      } else {
        if (response.status === 409) setRefresh((n) => n + 1);
        setMessage({ tone: 'fail', text: response.body?.error ?? 'That did not go through.' });
      }
    } catch {
      setMessage({ tone: 'fail', text: 'That did not go through — check your connection and try again.' });
    }
    setBusy(false);
  }

  if (state.kind === 'loading') return <p className="pform__quiet" aria-busy="true">Loading…</p>;
  if (state.kind === 'unknown') {
    return (
      <>
        <h1 className="pform__title">This link does not open a booking</h1>
        <p className="pform__quiet">It may be incomplete — copy the whole link again. To change a booking without it, contact the business directly.</p>
      </>
    );
  }

  const { view } = state;
  const { appointment: a, can } = view;
  const live = a.status === 'requested' || a.status === 'confirmed';
  const today = localDate(new Date(), view.timezone);
  return (
    <>
      <p className="pform__business">{view.business}</p>
      <h1 className="pform__title">Your booking</h1>
      <div className="pbook__summary">
        <b>{a.title}</b>
        <span>{longWhen(a.starts_at, view.timezone)}</span>
        <span>{STATUS_WORDS[a.status] ?? a.status}</span>
        {(a.address_line1 || a.city) && <span>{[a.address_line1, a.city].filter(Boolean).join(', ')}</span>}
      </div>
      {message && <p className={message.tone === 'ok' ? 'pbook__done' : 'pform__error'} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p>}

      {live && mode === 'view' && (
        <div className="pbook__choices">
          <button type="button" className="pform__send" disabled={!can.reschedule.ok} onClick={() => { setMode('move'); setMessage(null); }}>Move it to another time</button>
          {!can.reschedule.ok && <p className="pform__help">Moving it: {can.reschedule.message}.</p>}
          <button type="button" className="pbook__quiet-btn" disabled={!can.cancel.ok} onClick={() => { setMode('cancel'); setMessage(null); }}>Cancel this booking</button>
          {!can.cancel.ok && <p className="pform__help">Cancelling it: {can.cancel.message}.</p>}
        </div>
      )}

      {live && mode === 'move' && (
        <fieldset className="pbook__group">
          <legend>Choose a new time</legend>
          <TimePicker load={load} timezone={view.timezone} today={today} lastDay={addDays(today, 365)} value={slot} onChange={setSlot} refresh={refresh} />
          <button
            type="button"
            className="pform__send"
            disabled={!slot || busy}
            onClick={() => change({ action: 'reschedule', starts_at: slot }, (next) => (next.appointment.status === 'requested'
              ? 'Your booking was moved. The business will confirm the new time with you.'
              : 'Your booking was moved.'))}
          >
            {busy ? 'Moving…' : slot ? `Move it to ${longWhen(slot, view.timezone)}` : 'Choose a time above'}
          </button>
          {a.requires_approval && <p className="pform__help">The business confirms the new time before it is final. Your old time is given up when you move.</p>}
          <button type="button" className="pbook__quiet-btn" onClick={() => setMode('view')}>Keep it as it is</button>
        </fieldset>
      )}

      {live && mode === 'cancel' && (
        <fieldset className="pbook__group">
          <legend>Cancel this booking?</legend>
          <p className="pform__help">The time is given up and offered to somebody else. This cannot be undone from here.</p>
          <div className="pform__field">
            <label htmlFor="pb-reason">Anything you want to tell the business <span className="pform__optional">(optional)</span></label>
            <textarea id="pb-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="button" className="pform__send" disabled={busy} onClick={() => change({ action: 'cancel', ...(reason.trim() ? { reason: reason.trim() } : {}) }, () => 'Your booking was cancelled.')}>
            {busy ? 'Cancelling…' : 'Yes, cancel it'}
          </button>
          <button type="button" className="pbook__quiet-btn" onClick={() => setMode('view')}>Keep my booking</button>
        </fieldset>
      )}

      {!live && <p className="pform__quiet">Nothing more can be changed here. To book again, contact the business.</p>}
    </>
  );
}

/* ── the page ───────────────────────────────────────────── */

export default function PublicBooking({ manage = false }) {
  const { key } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get('embed') === '1';
  /* read once: the fragment is the customer's own link, and is never put anywhere else. */
  const [token] = useState(() => (manage ? window.location.hash.replace(/^#/, '') : ''));

  /* the site's square cursor and dark page belong to ARC, not to this business's customer. */
  useEffect(() => {
    document.documentElement.classList.add('arc-form-page');
    return () => document.documentElement.classList.remove('arc-form-page');
  }, []);

  return (
    <main className={`pform pbook${embedded ? ' pform--embed' : ''}`}>
      <div className="pform__card">
        {manage ? <ManageFlow pageKey={key} token={token} /> : <BookingFlow pageKey={key} embedded={embedded} />}
      </div>
      <p className="pform__by">Booking by ARC Automations</p>
    </main>
  );
}
