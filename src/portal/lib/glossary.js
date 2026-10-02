/* the words this product uses for itself, said once in plain language.
 *
 * both workspaces print state names that are exact — `shadow`, `configuring`, `unverified` —
 * because the name is what the system checks and what the audit log records. exact is not
 * the same as understood: a new operator, or a client reading their own reliability page,
 * should not have to already know what a canary is.
 *
 * so the name stays on screen unchanged, and `<Term>` (components/ui.jsx) hangs the gloss
 * from it. nothing here renames, hides or reinterprets a state: `label` is the same word
 * the system uses, and `gloss` only says what that word means for the person reading it.
 * one list, so the console and the client portal cannot explain the same word two ways.
 *
 * a gloss is one or two short sentences, written for somebody who has never seen the code.
 */

export const GLOSSARY = Object.freeze({
  /* ── where a module is: the operator's decision (ARC-120) ── */
  unselected: {
    label: 'unselected',
    gloss: 'This client does not have this module. Nothing runs and nothing is set up for it.',
  },
  configuring: {
    label: 'configuring',
    gloss: 'Chosen for this client and being set up. Nothing runs yet.',
  },
  testing: {
    label: 'testing',
    gloss: 'Being tested with made-up leads only. No real customer is contacted.',
  },
  shadow: {
    label: 'shadow',
    gloss: 'A dry run on real leads: the system records what it would have done, and sends nothing to anyone.',
  },
  active: {
    label: 'active',
    gloss: 'Live. Real leads are handled and real messages are sent.',
  },
  paused: {
    label: 'paused',
    gloss: 'Switched off by a person or by a safety rule. No new work starts until somebody resumes it — the system never resumes on its own.',
  },

  /* ── how a module is doing: the health overlay, kept apart from the state ── */
  healthy: {
    label: 'healthy',
    gloss: 'An independent check has proved this works end to end, recently.',
  },
  unverified: {
    label: 'not verified',
    gloss: 'It may be working, but nothing independent has proved it yet. This is not a failure, and it is not a pass.',
  },
  degraded: {
    label: 'degraded',
    gloss: 'Working, with problems: some checks are failing or slow. Worth looking at before it gets worse.',
  },
  failing: {
    label: 'failing',
    gloss: 'A check is failing right now. Something is not reaching where it should.',
  },
  blocking: {
    label: 'blocking',
    gloss: 'Unhealthy enough that new live work is held until it is fixed.',
  },
  quiet: {
    label: 'quiet',
    gloss: 'Less has come through than usual. It may be a slow day, or something upstream may have stopped sending.',
  },
  awaiting: {
    label: 'awaiting connection',
    gloss: 'Part of the plan, but not connected to your system yet. Figures show a dash rather than a zero, because zero would claim a working pipeline.',
  },

  /* ── how "working" is proved ── */
  canary: {
    label: 'canary',
    gloss: 'A made-up test lead pushed through the real pipeline to prove it works end to end. It is never counted in your numbers and can never reach a real phone.',
  },
  schema_assert: {
    label: 'schema assert',
    gloss: 'A check that what arrived has the fields it should — it catches a form or a connection that changed shape.',
  },
  watermark: {
    label: 'watermark',
    gloss: 'A floor under the volume: an alarm if fewer leads arrive than a normal day would bring.',
  },
  health: {
    label: 'health',
    gloss: 'How the module is doing right now. It is reported separately from its state and never changes the state by itself.',
  },

  /* ── settings ── */
  lifecycle: {
    label: 'lifecycle',
    gloss: 'The stage a module is at for this client, from chosen through testing to live. Each change is recorded with who made it.',
  },
  effective_configuration: {
    label: 'effective configuration',
    gloss: 'The settings actually in force: the client-wide settings and this module’s settings, combined, as last published.',
  },
  draft: {
    label: 'draft',
    gloss: 'Changes saved but not in force. Nothing runs on a draft until it is published.',
  },
  publish: {
    label: 'publish',
    gloss: 'Make the draft the version new work runs on. Work already running finishes on the version it started with.',
  },
  restore: {
    label: 'restore',
    gloss: 'Bring an older version back by publishing a copy of it as the newest version. No history is rewritten.',
  },

  /* ── people and safety ── */
  handoff: {
    label: 'handoff',
    gloss: 'The automation stopped and passed this lead to a person, because a rule said a person should decide.',
  },
  suppression: {
    label: 'opted out',
    gloss: 'This person must not be messaged — they asked to stop, or the address is wrong. It is checked again immediately before every send.',
  },

  /* ── taking a client out ── */
  deboard: {
    label: 'deboard',
    gloss: 'End a client’s access: their logins, tokens and connections are cut off, and their history is kept.',
  },
  purge: {
    label: 'delete permanently',
    gloss: 'Remove a test client completely. Only possible for a client that never did anything real.',
  },

  /* ── lead capture: a form, an arrival, an import row (ARC-350) ── */
  published: {
    label: 'published',
    gloss: 'Open to the public. Anyone with the link can send a request, and each one becomes a lead.',
  },
  archived: {
    label: 'archived',
    gloss: 'Closed. The link no longer takes requests. Everything it collected is kept.',
  },
  created: {
    label: 'created',
    gloss: 'A new lead was made, on a new customer record or on the one this person already had.',
  },
  duplicate: {
    label: 'duplicate',
    gloss: 'This person already had an open lead, so the new request was recorded against it instead of making a second lead.',
  },
  ready: {
    label: 'ready',
    gloss: 'This row is valid and will become a lead when the file is imported.',
  },
  invalid: {
    label: 'invalid',
    gloss: 'This row cannot be imported as it is. The reason is listed next to it, by column.',
  },
  duplicate_in_file: {
    label: 'duplicate_in_file',
    gloss: 'The same phone number or email appears on an earlier row of this file, so this row is left out.',
  },
  imported: {
    label: 'imported',
    gloss: 'This row became a lead.',
  },
  skipped: {
    label: 'skipped',
    gloss: 'Not imported as a new lead: this person already had an open lead, and the row was recorded against it.',
  },
  existing_contact: {
    label: 'existing_contact',
    gloss: 'This person is already a customer on file. They get a new lead, and their record is left exactly as it is.',
  },
  ambiguous_contact: {
    label: 'ambiguous_contact',
    gloss: 'More than one customer on file shares this phone number or email. A person has to choose, or merge them, first.',
  },
});

/** the entry for a term, or null — an unknown word is printed as it is, never guessed at. */
export function glossFor(key) {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, key) ? GLOSSARY[key] : null;
}

/* a confirmation reads "pause this module? no new live run starts, …" — or, the other way
   round, "this switches on live texting. continue?". either way one part is the question and
   the other is what will happen, and what will happen belongs on the page before the button
   is pressed, not only inside the dialog that follows. this returns that part; the dialog
   itself is unchanged. a confirmation that is only a question returns null, and the caller
   says the consequence in its own words. */
export function consequenceOf(confirm) {
  if (typeof confirm !== 'string') return null;
  const text = confirm.replace(/\s*\n+\s*/g, ' ').trim();
  const at = text.indexOf('?');
  if (at === -1) return null;
  const after = text.slice(at + 1).trim();
  if (after) return after;
  const lead = text.lastIndexOf('. ', at);
  return lead === -1 ? null : text.slice(0, lead + 1).trim();
}
