import { useCallback, useEffect, useRef, useState } from 'react';
import { site } from '../data/site';
import { onOpenPilot, pilotContext } from '../lib/pilot';
import { intakeLines, intakePayload, sendCapture, validateContact } from '../lib/count-intake';
import { lenisRef } from '../lib/SmoothScroll';
import TickOnChange from './TickOnChange';
import PixelGuy from './PixelGuy';
import './PilotOverlay.css';

/* the calendar, with what we already know filled in. the notes are shown to the owner
   in the booking form, so they carry only what the owner typed. */
function buildEmbedSrc(booking, contact, lines) {
  if (booking.provider === 'calcom') {
    const u = new URL(booking.embedUrl);
    u.searchParams.set('theme', 'dark');
    u.searchParams.set('name', contact.name);
    u.searchParams.set('email', contact.email);
    u.searchParams.set('notes', lines.join(' | '));
    return u.toString();
  }
  if (booking.provider === 'ghl') {
    const u = new URL(booking.embedUrl);
    const [first, ...rest] = contact.name.split(' ');
    u.searchParams.set('first_name', first);
    u.searchParams.set('last_name', rest.join(' '));
    u.searchParams.set('email', contact.email);
    u.searchParams.set('phone', contact.phone);
    return u.toString();
  }
  return null;
}

function buildMailto(label, contact, lines, fields) {
  const body = [...lines, '', ...fields.map((f) => `${f.label}: ${contact[f.key] || ''}`)].join('\n');
  return `mailto:${site.email}?subject=${encodeURIComponent(
    `${label} — ${contact.business || ''}`
  )}&body=${encodeURIComponent(body)}`;
}

function PixelX() {
  // pixel ×, drawn in rects like everything else he owns
  const px = [
    [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7],
    [7, 1], [6, 2], [5, 3], [3, 5], [2, 6], [1, 7],
  ];
  return (
    <svg viewBox="0 0 9 9" width="18" height="18" shapeRendering="crispEdges" aria-hidden="true">
      {px.map(([x, y]) => (
        <rect key={`${x}${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />
      ))}
    </svg>
  );
}

/* `initial` is for the tests, which render one screen at a time to read its words;
   the site mounts this with no props and opens it through the bus. */
export default function PilotOverlay({ initial = {} }) {
  const [open, setOpen] = useState(initial.open ?? false);
  // which arc route the visitor arrived on, if a route button opened this.
  // a note for us, sent with the request and never shown here.
  const [routeContext, setRouteContext] = useState(() => pilotContext());
  const [step, setStep] = useState(initial.step ?? 0);
  const [answers, setAnswers] = useState({});
  const [contact, setContact] = useState({});
  const [errors, setErrors] = useState(initial.errors ?? {});
  const [booked, setBooked] = useState(initial.booked ?? false);
  // 'idle' until the POST resolves; 'sent' only on a confirmed 2xx, so the
  // copy never claims a delivery that did not happen.
  const [capture, setCapture] = useState(initial.capture ?? 'idle');
  const panelRef = useRef(null);
  const restoreFocus = useRef(null);

  // one request, one set of questions. the bus may still carry a key from a
  // parked section; it opens the same form.
  const { label, questions, fields, copy } = site.pilot;
  const booking = initial.booking ?? site.pilot.booking;
  const questionCount = questions.length;
  const totalSteps = questionCount + 1; // questions + contact screen
  const bookingStep = totalSteps;

  const close = useCallback(() => {
    setOpen(false);
    lenisRef.current?.start();
    document.documentElement.style.overflow = '';
    restoreFocus.current?.focus?.();
  }, []);

  // open via the bus, from any "get my missed-call count" button
  useEffect(
    () =>
      onOpenPilot((context = {}) => {
        restoreFocus.current = document.activeElement;
        setRouteContext(pilotContext(context));
        setStep(0);
        setAnswers({});
        setContact({});
        setErrors({});
        setBooked(false);
        setCapture('idle');
        setOpen(true);
        lenisRef.current?.stop();
        document.documentElement.style.overflow = 'hidden';
        requestAnimationFrame(() => panelRef.current?.focus());
      }),
    []
  );

  // esc closes, enter advances
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && step < questionCount) {
        const q = questions[step];
        if (answers[q.key]) setStep((s) => s + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, questionCount, questions, answers, close]);

  // best-effort: catch booking-success postMessage from an embed
  useEffect(() => {
    if (!open) return undefined;
    const onMsg = (e) => {
      const s = JSON.stringify(e.data ?? '');
      if (/bookingSuccessful|booking_success|appointment.*(booked|created)/i.test(s)) {
        setBooked(true);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [open]);

  if (!open) return null;

  const lines = intakeLines(questions, answers, contact);
  const embedSrc =
    step === bookingStep && booking.provider && booking.embedUrl
      ? buildEmbedSrc(booking, { name: '', email: '', phone: '', ...contact }, lines)
      : null;
  const mailto = buildMailto(label, contact, lines, fields);

  const pick = (key, value) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    // selecting advances — no review step, no dithering
    setTimeout(() => setStep((s) => s + 1), 120);
  };

  const submitContact = (e) => {
    e.preventDefault();
    const errs = validateContact(contact, copy.errors);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    sendCapture(
      site.pilot.captureUrl,
      intakePayload({
        label,
        questions,
        answers,
        contact,
        // a hint for the call, not a decision — null when no route button was used
        route: routeContext,
        page: window.location.href,
        submittedAt: new Date().toISOString(),
      }),
    ).then((ok) => setCapture(ok ? 'sent' : 'failed'));

    // advance immediately — the visitor never waits on the network, and a post
    // that fails changes nothing about reaching the calendar
    setStep(bookingStep);
  };

  return (
    <div
      className="pilot"
      role="dialog"
      aria-modal="true"
      aria-label={copy.dialog}
      ref={panelRef}
      tabIndex={-1}
    >
      <header className="pilot__bar">
        {step < bookingStep ? (
          <span className="pilot__progress mono">
            <TickOnChange value={step + 1} /> / {String(totalSteps).padStart(2, '0')}
          </span>
        ) : (
          <span className="pilot__progress mono">{label}</span>
        )}
        {step > 0 && !booked && (
          <button
            className="pilot__back mono"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            aria-label={copy.back}
          >
            ← {copy.back}
          </button>
        )}
        <button className="pilot__close" onClick={close} aria-label={copy.close}>
          <PixelX />
        </button>
      </header>

      <div className="pilot__body">
        {step < questionCount && (
          <div className="pilot__step" key={step}>
            <h2 className="pilot__q">{questions[step].q}</h2>
            <div className="pilot__options">
              {questions[step].options.map((opt) => (
                <button
                  key={opt}
                  className={`pilot__opt ${answers[questions[step].key] === opt ? 'is-picked' : ''}`}
                  onClick={() => pick(questions[step].key, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === questionCount && (
          <form className="pilot__step" onSubmit={submitContact} noValidate>
            <h2 className="pilot__q">{copy.contactTitle}</h2>
            <div className="pilot__fields">
              {fields.map((f) => (
                <label className={`pilot__field ${f.wide ? 'pilot__field--wide' : ''}`} key={f.key}>
                  <span className="mono">{f.label}</span>
                  <input
                    type={f.type}
                    autoComplete={f.autoComplete}
                    placeholder={f.placeholder}
                    value={contact[f.key] || ''}
                    onChange={(e) =>
                      setContact((c) => ({ ...c, [f.key]: e.target.value }))
                    }
                  />
                  {errors[f.key] && <em className="pilot__err mono">{errors[f.key]}</em>}
                </label>
              ))}
            </div>
            <button className="pilot__next" type="submit">
              {copy.submit} <span aria-hidden="true">→</span>
            </button>
          </form>
        )}

        {step === bookingStep && !booked && (
          <div className="pilot__step pilot__booking">
            <h2 className="pilot__booknow">{copy.bookTitle}</h2>
            <p className="pilot__confline mono">
              {label} · {copy.bookLine}
            </p>
            <p className="pilot__bring">{copy.bring}</p>

            {embedSrc ? (
              <>
                <div className="pilot__embed">
                  <iframe src={embedSrc} title={copy.embedTitle} loading="eager" />
                </div>
                <p className="pilot__tz mono">{copy.timezone}</p>
                <a className="pilot__fallback mono" href={mailto}>
                  {copy.fallback} →
                </a>
              </>
            ) : capture === 'sent' ? (
              <div className="pilot__nofall">
                <PixelGuy size={56} autoHop />
                <p className="pilot__nofall-copy">{copy.sent}</p>
                <button className="pilot__next" onClick={close}>
                  {copy.done}
                </button>
                <p className="pilot__tz mono">{copy.sentNote}</p>
              </div>
            ) : (
              <div className="pilot__nofall">
                <p className="pilot__nofall-copy">{copy.unsent}</p>
                <a className="pilot__next" href={mailto}>
                  {copy.unsentCta} <span aria-hidden="true">→</span>
                </a>
                <p className="pilot__tz mono">{copy.unsentNote}</p>
              </div>
            )}
          </div>
        )}

        {booked && (
          <div className="pilot__step pilot__done">
            <PixelGuy size={56} autoHop />
            <h2 className="pilot__q">{copy.bookedTitle}</h2>
            <p className="pilot__nofall-copy">{copy.booked}</p>
            <button className="pilot__next" onClick={close}>
              {copy.done}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
