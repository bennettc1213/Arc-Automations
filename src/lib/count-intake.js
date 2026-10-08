// the missed-call count request: what the overlay checks, what it sends and how.
// pure and imports nothing, so the tests run it without a browser. the words an
// owner reads are in site.pilot; this file only handles what they typed.

// field key → why it cannot be sent yet. `messages` is site.pilot.copy.errors.
export function validateContact(contact, messages = {}) {
  const errors = {};
  const filled = (key) => String(contact?.[key] ?? '').trim() !== '';
  for (const key of ['name', 'business', 'serviceArea']) {
    if (!filled(key)) errors[key] = messages[key] ?? 'required';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact?.email ?? '').trim())) {
    errors.email = messages.email ?? 'required';
  }
  if (String(contact?.phone ?? '').replace(/\D/g, '').length < 7) {
    errors.phone = messages.phone ?? 'required';
  }
  return errors;
}

// every answer under its question's key, then the service area — it is typed, not
// picked, but it is an answer about the business, not a way to reach a person.
export function intakeAnswers(questions, answers, contact) {
  const out = {};
  for (const q of questions) out[q.key] = answers?.[q.key] ?? '';
  out.service_area = String(contact?.serviceArea ?? '').trim();
  return out;
}

/* what is posted. `pilot`, `answers` and `contact` keep the names the capture has
   always received, so whatever reads it needs no change: it lists `answers` as it
   finds them and reads name, business, email and phone off `contact`.
   `route` is a note for the call and is null from every button on the homepage.
   it is sent to us and never shown to the owner. */
export function intakePayload({ label, questions, answers, contact, route, page, submittedAt }) {
  return {
    pilot: label,
    route: route?.route ?? null,
    routeSource: route?.routeSource ?? null,
    answers: intakeAnswers(questions, answers, contact),
    contact: {
      name: String(contact?.name ?? '').trim(),
      business: String(contact?.business ?? '').trim(),
      email: String(contact?.email ?? '').trim(),
      phone: String(contact?.phone ?? '').trim(),
    },
    page,
    submittedAt,
  };
}

// the same answers as lines, for the email fallback and the calendar's notes box.
// both are shown to the owner, so nothing goes here that they did not type.
export function intakeLines(questions, answers, contact) {
  return Object.entries(intakeAnswers(questions, answers, contact)).map(
    ([key, value]) => `${key.replace(/_/g, ' ')}: ${value || '—'}`,
  );
}

/* POST the request somewhere durable. it resolves true only on a real 2xx and false
   for everything else — no address, a refused connection, a 500, a fetch that throws.
   it never rejects and never throws, and the caller does not wait for it: a capture
   that fails must not stand between a contractor and the calendar. `keepalive` so the
   request still goes out if they close the tab the instant they press the button. */
export function sendCapture(url, payload, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(
      fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }),
    )
      .then((r) => Boolean(r?.ok))
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
