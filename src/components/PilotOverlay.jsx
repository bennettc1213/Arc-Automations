import { useCallback, useEffect, useRef, useState } from 'react';
import { site } from '../data/site';
import { onOpenPilot } from '../lib/pilot';
import { lenisRef } from '../lib/SmoothScroll';
import TickOnChange from './TickOnChange';
import PixelGuy from './PixelGuy';
import './PilotOverlay.css';

const QUESTIONS = site.pilot.questions;
const FIELDS = [
  { key: 'name', label: 'name', type: 'text', autoComplete: 'name' },
  { key: 'business', label: 'business', type: 'text', autoComplete: 'organization' },
  { key: 'email', label: 'email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'phone', type: 'tel', autoComplete: 'tel' },
];
const TOTAL_STEPS = 4; // 3 choice questions + contact screen

function validateContact(c) {
  const errors = {};
  if (!c.name?.trim()) errors.name = 'need a name';
  if (!c.business?.trim()) errors.business = 'need the business';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '')) errors.email = 'real email, please';
  if ((c.phone || '').replace(/\D/g, '').length < 7) errors.phone = 'real phone, please';
  return errors;
}

function buildMailto(answers, contact, pilotLabel) {
  const body = [
    `pilot: ${pilotLabel}`,
    `trade: ${answers.trade || '—'}`,
    `pain: ${answers.pain || '—'}`,
    `volume: ${answers.volume || '—'}`,
    '',
    `name: ${contact.name || ''}`,
    `business: ${contact.business || ''}`,
    `phone: ${contact.phone || ''}`,
  ].join('\n');
  return `mailto:${site.email}?subject=${encodeURIComponent(
    `pilot request — ${answers.trade || 'contractor'}`
  )}&body=${encodeURIComponent(body)}`;
}

function buildEmbedSrc(booking, answers, contact) {
  const notes = `trade: ${answers.trade} | pain: ${answers.pain} | volume: ${answers.volume} | business: ${contact.business}`;
  if (booking.provider === 'calcom') {
    const u = new URL(booking.embedUrl);
    u.searchParams.set('theme', 'dark');
    u.searchParams.set('name', contact.name);
    u.searchParams.set('email', contact.email);
    u.searchParams.set('notes', notes);
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

export default function PilotOverlay() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0); // 0..2 choices, 3 contact, 4 booking
  const [answers, setAnswers] = useState({});
  const [contact, setContact] = useState({});
  const [errors, setErrors] = useState({});
  const [booked, setBooked] = useState(false);
  const panelRef = useRef(null);
  const restoreFocus = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    lenisRef.current?.start();
    document.documentElement.style.overflow = '';
    restoreFocus.current?.focus?.();
  }, []);

  // open via the bus, from any "start a pilot" button
  useEffect(
    () =>
      onOpenPilot(() => {
        restoreFocus.current = document.activeElement;
        setStep(0);
        setAnswers({});
        setContact({});
        setErrors({});
        setBooked(false);
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
      if (e.key === 'Enter' && step < 3) {
        const q = QUESTIONS[step];
        if (answers[q.key]) setStep((s) => s + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, answers, close]);

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

  const pilotLabel = site.pilot.pilotFor[answers.pain] || 'pilot build';
  const booking = site.pilot.booking;
  const embedSrc =
    booking.provider && booking.embedUrl
      ? buildEmbedSrc(booking, answers, contact)
      : null;

  const pick = (key, value) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    // selecting advances — no review step, no dithering
    setTimeout(() => setStep((s) => s + 1), 120);
  };

  const submitContact = (e) => {
    e.preventDefault();
    const errs = validateContact(contact);
    setErrors(errs);
    if (Object.keys(errs).length === 0) setStep(4);
  };

  return (
    <div
      className="pilot"
      role="dialog"
      aria-modal="true"
      aria-label="start a pilot"
      ref={panelRef}
      tabIndex={-1}
    >
      <header className="pilot__bar">
        {step < 4 ? (
          <span className="pilot__progress mono">
            <TickOnChange value={step + 1} /> / {String(TOTAL_STEPS).padStart(2, '0')}
          </span>
        ) : (
          <span className="pilot__progress mono">{pilotLabel}</span>
        )}
        {step > 0 && !booked && (
          <button
            className="pilot__back mono"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            aria-label="back"
          >
            ← back
          </button>
        )}
        <button className="pilot__close" onClick={close} aria-label="close">
          <PixelX />
        </button>
      </header>

      <div className="pilot__body">
        {step < 3 && (
          <div className="pilot__step" key={step}>
            <h2 className="pilot__q">{QUESTIONS[step].q}</h2>
            <div className="pilot__options">
              {QUESTIONS[step].options.map((opt) => (
                <button
                  key={opt}
                  className={`pilot__opt ${answers[QUESTIONS[step].key] === opt ? 'is-picked' : ''}`}
                  onClick={() => pick(QUESTIONS[step].key, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <form className="pilot__step" onSubmit={submitContact} noValidate>
            <h2 className="pilot__q">where do we send the plan?</h2>
            <div className="pilot__fields">
              {FIELDS.map((f) => (
                <label className="pilot__field" key={f.key}>
                  <span className="mono">{f.label}</span>
                  <input
                    type={f.type}
                    autoComplete={f.autoComplete}
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
              book the call <span aria-hidden="true">→</span>
            </button>
          </form>
        )}

        {step === 4 && !booked && (
          <div className="pilot__step pilot__booking">
            <h2 className="pilot__booknow">BOOK NOW</h2>
            <p className="pilot__confline mono">
              {pilotLabel} · 30 min · ben chu
            </p>

            {embedSrc ? (
              <>
                <div className="pilot__embed">
                  <iframe
                    src={embedSrc}
                    title="book a pilot call"
                    loading="eager"
                  />
                </div>
                <p className="pilot__tz mono">
                  times shown in your timezone — we’re on mountain time
                </p>
                <a
                  className="pilot__fallback mono"
                  href={buildMailto(answers, contact, pilotLabel)}
                >
                  calendar not loading? email us instead →
                </a>
              </>
            ) : (
              <div className="pilot__nofall">
                <p className="pilot__nofall-copy">
                  direct booking is being wired up. your answers are packed into an
                  email — one tap and they’re in our inbox.
                </p>
                <a
                  className="pilot__next"
                  href={buildMailto(answers, contact, pilotLabel)}
                >
                  email us the details <span aria-hidden="true">→</span>
                </a>
                <p className="pilot__tz mono">we reply same-day, mountain time</p>
              </div>
            )}
          </div>
        )}

        {booked && (
          <div className="pilot__step pilot__done">
            <PixelGuy size={56} autoHop />
            <h2 className="pilot__q">booked.</h2>
            <p className="pilot__nofall-copy">
              calendar invite is on its way. we’ll read your answers before we talk —
              come with the messy version.
            </p>
            <button className="pilot__next" onClick={close}>
              done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
