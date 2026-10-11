/* ARC-MK-230 — what arc did with a lead, as the three things the homepage names.
 *
 * the launch offer is three lines an owner would say out loud (`site.leaks.covers`): a missed
 * call gets a text back, a website request gets one too, and the questions are asked before
 * the owner calls back. this file is where the portal shows each of them happening:
 *
 *   - `handlingLines` is five lines for one lead: how long the text took, what the customer
 *     needs, where they are, how soon, and who was told. it takes plain facts, so a written
 *     example and a real lead are worded by the same code and cannot drift.
 *   - `summariseFacts` counts those facts over many leads, per way in.
 *   - `ownerHandling` words that count as three cards, one per line of the offer.
 *
 * nothing here decides anything. the time is the one the text's own record carries, the
 * answers are the ones read from the customer's reply, and the area check is the one made
 * when the reply was read. a figure that cannot be shown is null with its reason — the page
 * prints a dash, never a zero — and a line that does not apply to a lead says so.
 *
 * it also keeps no customer's words: what they need is the kind of job read from the reply,
 * not the reply.
 */

import { SAFETY_FLAG_LABEL } from './lifecycle.js';

export const HANDLING_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ── words ──────────────────────────────────────────────── */

/* how soon, as the customer would say it. keyed on the reader's own vocabulary; anything
   else — including "unknown" — has no words and reads as "they did not say". */
export const URGENCY_WORDS = {
  emergency: 'an emergency',
  same_day: 'today',
  this_week: 'this week',
  scheduling: 'no rush — they are booking ahead',
};

export function urgencyWords(urgency) {
  const key = String(urgency ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return URGENCY_WORDS[key] ?? null;
}

/* a length of time the way a person says it. null when there is nothing to say. */
export function spokenDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  const hours = Math.floor(minutes / 60);
  const over = minutes % 60;
  return over === 0 ? `${hours} hr` : `${hours} hr ${over} min`;
}

const clip = (value, max = 80) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/* who the answers went to. a phone number is never printed whole. */
function toldName(destination) {
  const text = String(destination ?? '').trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (/^\+?[\d\s().-]+$/.test(text) && digits.length >= 7) return `the phone ending ${digits.slice(-4)}`;
  return clip(text, 60);
}

/* ── one lead ───────────────────────────────────────────── */

/**
 * a real lead, as the facts the five lines read. `lead` is one of the workspace's threads:
 * the event log folded by lead, with the reading of the reply and any handoff already on it.
 */
export function leadHandlingFacts(lead) {
  const q = lead?.qualification ?? null;
  const sent = !lead?.failed && (
    (lead?.latencyMs !== null && lead?.latencyMs !== undefined) ||
    (lead?.steps ?? []).some((step) => step.type === 'sms_sent' && step.status !== 'failure')
  );
  const flags = (lead?.safetyFlags ?? []).map((flag) => SAFETY_FLAG_LABEL[flag] ?? String(flag).replace(/_/g, ' '));

  return {
    source: lead?.source ?? null,
    texted: Boolean(sent),
    textFailed: Boolean(lead?.failed),
    speedMs: sent && typeof lead?.latencyMs === 'number' ? lead.latencyMs : null,
    speedHidden: null,
    replied: Boolean(lead?.replied),
    read: Boolean(q),
    wrongNumber: lead?.suppressionReason === 'wrong_contact',
    need: clip(q?.jobType ?? lead?.lossType),
    zip: q?.zip ?? lead?.zip ?? null,
    inArea: typeof q?.inServiceArea === 'boolean' ? q.inServiceArea : null,
    urgency: flags.length > 0 ? 'emergency' : (q?.urgency ?? null),
    safety: flags,
    handoff: Boolean(lead?.handoff),
    toldTo: toldName(lead?.routingDestination),
  };
}

export const HANDLING_LABELS = ['time to arc’s text', 'what they need', 'where', 'how soon', 'who was told'];

/* why a question has no answer on this lead, when it has none. `held` null is "does not
   apply", false is a gap. */
function unanswered(facts, missing) {
  if (facts.wrongNumber) return ['nothing to ask — it was a wrong number', null];
  if (!facts.replied) return ['not answered — the customer has not replied', null];
  if (!facts.read) return ['their reply has not been read yet', false];
  return [missing, false];
}

/**
 * the five lines, in the order they happen. each is `{ label, value, held }`, the same shape
 * as the ledger's seven: true when it is on record, false when it is the gap, null when it
 * does not apply to this lead.
 */
export function handlingLines(facts) {
  const arrival = facts.source === 'missed_call' ? 'the missed call' : 'the request came in';

  let speed;
  if (facts.textFailed) speed = ['the text did not send', false];
  else if (!facts.texted) speed = ['no text went out', false];
  else if (facts.speedHidden) speed = [facts.speedHidden, null];
  else if (facts.speedMs === null || facts.speedMs === undefined) speed = ['sent — the time was not measured', null];
  else speed = [`${spokenDuration(facts.speedMs)} after ${arrival}`, true];

  const need = facts.need && !facts.wrongNumber ? [facts.need, true] : unanswered(facts, 'they did not say');

  let where;
  if (facts.zip && !facts.wrongNumber) {
    if (facts.inArea === true) where = [`${facts.zip} — in your area`, true];
    else if (facts.inArea === false) where = [`${facts.zip} — outside your area`, false];
    else where = [`${facts.zip} — not checked against your area`, null];
  } else where = unanswered(facts, 'no zip code given');

  const soon = urgencyWords(facts.urgency);
  const how = soon && !facts.wrongNumber
    ? [facts.safety?.length ? `${soon} — ${facts.safety.join(', ')}` : soon, true]
    : unanswered(facts, 'they did not say');

  let told;
  if (facts.handoff) told = ['you — handed over, and arc stopped texting', true];
  else if (facts.toldTo === 'you') told = ['you, by text, with these answers', true];
  else if (facts.toldTo) told = [`${facts.toldTo}, with these answers`, true];
  else if (facts.replied && facts.read && !facts.wrongNumber) told = ['nobody yet', false];
  else told = ['nobody — there was nothing to pass on', null];

  return [speed, need, where, how, told].map(([value, held], index) => ({ label: HANDLING_LABELS[index], value, held }));
}

/* the answers in one breath, for a list that has no room for five lines. null when the
   customer has told us nothing. */
export function learnedSummary(facts) {
  if (facts.wrongNumber) return null;
  const area = facts.inArea === true ? ', in your area' : facts.inArea === false ? ', outside your area' : '';
  const parts = [facts.need, facts.zip ? `${facts.zip}${area}` : null, urgencyWords(facts.urgency)].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/* ── many leads ─────────────────────────────────────────── */

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/* the two ways in the offer names. anything else that reaches the log is still a lead on the
   jobs screen; it is only not one of these two cards. */
export const HANDLING_SOURCES = ['missed_call', 'web_form'];

/** counts over a list of facts: per way in, then what the questions found. */
export function summariseFacts(list) {
  const way = (source) => {
    const rows = list.filter((facts) => facts.source === source);
    const sent = rows.filter((facts) => facts.texted);
    const times = sent.map((facts) => facts.speedMs).filter((ms) => typeof ms === 'number');
    return {
      in: rows.length,
      texted: sent.length,
      failed: rows.filter((facts) => facts.textFailed).length,
      timed: times.length,
      medianMs: median(times),
      slowestMs: times.length > 0 ? Math.max(...times) : null,
    };
  };

  const read = list.filter((facts) => facts.read && !facts.wrongNumber);
  return {
    total: list.length,
    bySource: Object.fromEntries(HANDLING_SOURCES.map((source) => [source, way(source)])),
    questions: {
      replied: list.filter((facts) => facts.replied).length,
      read: read.length,
      inArea: read.filter((facts) => facts.inArea === true).length,
      outside: read.filter((facts) => facts.inArea === false).length,
      /* a zip was given and nothing checked it: the area has no zip codes to check against. */
      unchecked: read.filter((facts) => facts.zip && facts.inArea === null).length,
      urgent: read.filter((facts) => urgencyWords(facts.urgency) === URGENCY_WORDS.emergency).length,
      handed: list.filter((facts) => facts.handoff).length,
    },
  };
}

/**
 * the same counts over a workspace's leads, for the last thirty days. `now` is a luxon
 * DateTime or a millisecond clock. run over every lead in `buildDashboardData`, not the
 * capped list a page is handed, so these cannot disagree with the counts beside them.
 */
export function summariseHandling(leads, now, days = HANDLING_WINDOW_DAYS) {
  const at = typeof now === 'number' ? now : now.toMillis();
  const cutoff = at - days * DAY_MS;
  const inWindow = (leads ?? []).filter((lead) => {
    const started = Date.parse(lead.startedAt);
    return Number.isFinite(started) && started >= cutoff && started <= at + 1000;
  });
  return { ...summariseFacts(inWindow.map(leadHandlingFacts)), windowDays: days };
}

/* ── the three cards ────────────────────────────────────── */

const figure = (label, value, note = null) => ({ label, value, note, available: value !== null && value !== undefined });

const EXAMPLE_SPEED = 'not shown for examples — it is measured on a real phone line';

function wayFigures(way, nouns, { example, days }) {
  const typical = spokenDuration(way.medianMs);
  let why = null;
  if (typical === null) {
    if (example) why = EXAMPLE_SPEED;
    else if (way.in === 0) why = `no ${nouns.one} in the last ${days} days`;
    else if (way.texted === 0) why = 'no text has gone out';
    else why = 'the time was not measured';
  }

  return [
    figure(`${nouns.many} in`, way.in, way.in === 0 && !example ? nouns.none : null),
    figure('texted back', way.texted, way.failed > 0 ? `${way.failed} did not send` : null),
    figure(
      'typical time to the text',
      typical,
      why ?? (way.timed > 1 ? `the slowest took ${spokenDuration(way.slowestMs)}` : 'one text measured so far'),
    ),
  ];
}

function questionFigures(q, { example }) {
  const unread = q.read === 0 ? (q.replied === 0 ? 'nobody has replied yet' : 'no reply has been read yet') : null;
  const checked = (value) => (unread && !example ? null : value);
  return [
    figure('customers who answered', q.replied),
    figure(
      'in your area',
      checked(q.inArea),
      unread ?? (q.unchecked > 0 ? `${q.unchecked} not checked — your area has no zip codes set` : null),
    ),
    figure('outside your area', checked(q.outside), unread),
    figure('handed to a person', q.handed, q.urgent > 0 ? `${q.urgent} said it was an emergency` : null),
  ];
}

const NOUNS = {
  missed_call: {
    one: 'missed call',
    many: 'missed calls',
    none: null,
  },
  web_form: {
    one: 'website request',
    many: 'website requests',
    none: 'a request can only arrive once the form is on your website',
  },
};

/* which of the offer's three lines each card is. the names and the sentence under each are
   the homepage's own (`site.leaks.covers`), handed in so there is one copy of the words. */
const CARD_SOURCE = { 'missed-call': 'missed_call', 'web-request': 'web_form', questions: null };

/**
 * the three cards: for each line of the offer, what it is and what the record shows.
 *
 *   example   true when counted from the written examples
 *   steps     [{ key, name, what, source, figures: [{ label, value, note, available }] }]
 */
export function ownerHandling(data, { covers = [] } = {}) {
  const example = Boolean(data?.proofLedger);
  const module = data?.availability?.lead_capture ?? null;
  const live = example || module?.state === 'live';
  const notLive = module?.awaiting ?? 'your phone line is not connected yet';

  const summary = example
    ? (data.proofLedger.handling ?? null)
    : (data?.handling ?? summariseHandling(data?.threads ?? [], Date.parse(data?.generatedFor ?? '') || Date.now()));
  const days = summary?.windowDays ?? HANDLING_WINDOW_DAYS;

  const steps = covers
    .filter((item) => item.key in CARD_SOURCE)
    .map((item) => {
      const source = CARD_SOURCE[item.key];
      let figures;
      if (!live || !summary) {
        const labels = source
          ? [`${NOUNS[source].many} in`, 'texted back', 'typical time to the text']
          : ['customers who answered', 'in your area', 'outside your area', 'handed to a person'];
        figures = labels.map((label) => figure(label, null, live ? 'this could not be read' : notLive));
      } else if (source) {
        figures = wayFigures(summary.bySource[source], NOUNS[source], { example, days });
      } else {
        figures = questionFigures(summary.questions, { example });
      }
      return { key: item.key, name: item.name, what: item.what, source, figures };
    });

  return { example, window: example ? 'the seven examples' : `last ${days} days`, steps };
}
