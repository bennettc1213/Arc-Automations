/* ARC-MK-120 — the proof ledger, as seven example leads.
 *
 * the demo's front page. it sells the ledger rather than the machine: for each lead, what
 * is on record, and why that makes it count or not. an owner who has read the seven should
 * be able to explain every status without us in the room.
 *
 * two things kept apart on purpose:
 *
 *   - `PROOF_LEDGER_LEADS` states only what happened to each lead. no lead carries its own
 *     verdict.
 *   - `ledgerVerdict` reads the verdict off those facts with the ledger's own rule
 *     (`lib/ledger.js`, ARC-MK-210) — the one a client's real leads go through, and the one
 *     the homepage prints (`site.price.counts`): the call, the text, the reply, the booking
 *     and the visit all on record, and the owner saying the job happened.
 *
 * so a lead cannot be labelled "counts" by hand — remove a link and it stops counting.
 *
 * these are written examples, not generated events, and nothing here is read by a figure
 * on any other page. what they are is the rule shown on seven stories; what a real job's
 * evidence is, is the event log's to say.
 *
 * deterministic: the same seven every build. arrivals are a weekday and a clock time, not
 * a date, so the page never goes stale. no step after the arrival carries a time — how fast
 * the text goes out is a number we publish once it has been measured on a real line.
 */

import { LEDGER_STATUS, ledgerStatus } from '../lib/ledger.js';

export const PROOF_LEDGER_COMPANY = 'Halstead Heating & Air';

const FIRST_TEXT = `Hi, this is ${PROOF_LEDGER_COMPANY} — sorry we missed your call. Reply here with what you need and your ZIP and we'll get right back to you. Reply STOP to opt out.`;
const FORM_TEXT = `Hi, this is ${PROOF_LEDGER_COMPANY} — thanks for getting in touch. Reply here with what you need and your ZIP and we'll get right back to you. Reply STOP to opt out.`;

/* what happened, and nothing else.
 *
 *   source     'missed_call' | 'web_form'
 *   answered   did a person at the company pick up. a form has nobody to pick up: null.
 *   text       arc's first text, or null if none went out
 *   reply      the customer's words, or null
 *   ruledOut   a reply that ends it: 'wrong_number'
 *   handoff    why arc stopped and gave it to a person, or null
 *   booking    { when } or null
 *   visit      'ahead' | 'done' | 'cancelled' | null
 *   owner      the owner's answer to "did the job happen?": 'happened' | 'did_not_happen' | null
 */
export const PROOF_LEDGER_LEADS = [
  {
    key: 'confirmed',
    title: 'booked, and you confirmed it',
    source: 'missed_call',
    arrived: 'tuesday · 7:42 pm',
    answered: false,
    text: FIRST_TEXT,
    reply: 'ac is blowing warm air. 43214',
    ruledOut: null,
    handoff: null,
    booking: { when: 'wednesday · 9:00 am' },
    visit: 'done',
    owner: 'happened',
  },
  {
    key: 'booked',
    title: 'brought back and booked',
    source: 'missed_call',
    arrived: 'thursday · 12:17 pm',
    answered: false,
    text: FIRST_TEXT,
    reply: 'furnace keeps shutting off. 43202',
    ruledOut: null,
    handoff: null,
    booking: { when: 'friday · 2:00 pm' },
    visit: 'ahead',
    owner: null,
  },
  {
    key: 'unconfirmed',
    title: 'booked, waiting on your answer',
    source: 'missed_call',
    arrived: 'monday · 6:05 am',
    answered: false,
    text: FIRST_TEXT,
    reply: 'no heat this morning. 43221',
    ruledOut: null,
    handoff: null,
    booking: { when: 'monday · 1:30 pm' },
    visit: 'done',
    owner: null,
  },
  {
    key: 'no-reply',
    title: 'texted, no reply',
    source: 'missed_call',
    arrived: 'saturday · 3:28 pm',
    answered: false,
    text: FIRST_TEXT,
    reply: null,
    ruledOut: null,
    handoff: null,
    booking: null,
    visit: null,
    owner: null,
  },
  {
    key: 'wrong-number',
    title: 'wrong number',
    source: 'missed_call',
    arrived: 'wednesday · 10:51 am',
    answered: false,
    text: FIRST_TEXT,
    reply: 'sorry, wrong number',
    ruledOut: 'wrong_number',
    handoff: null,
    booking: null,
    visit: null,
    owner: null,
  },
  {
    key: 'cancelled',
    title: 'booked, then the customer cancelled',
    source: 'web_form',
    arrived: 'sunday · 9:14 pm',
    answered: null,
    text: FORM_TEXT,
    reply: 'need a tune-up before winter. 43085',
    ruledOut: null,
    handoff: null,
    booking: { when: 'tuesday · 11:00 am' },
    visit: 'cancelled',
    owner: null,
  },
  {
    key: 'handoff',
    title: 'handed to a person',
    source: 'missed_call',
    arrived: 'monday · 11:36 pm',
    answered: false,
    text: FIRST_TEXT,
    reply: 'i smell gas near the furnace',
    ruledOut: null,
    handoff: 'the reply sounded unsafe',
    booking: null,
    visit: null,
    owner: null,
  },
];

/* the statuses and the rule are the ledger's own (ARC-MK-210, `lib/ledger.js`) — the same
   lines a real lead goes through. re-exported so the page and its tests have one name. */
export { LEDGER_STATUS };

/* a written example, as the facts the rule reads. an example has no dates, so the visit is
   stated ('ahead' / 'done') rather than worked out from a clock, and nobody has been asked
   yet: a job nobody answered about is waiting on the owner. */
export function ledgerFacts(lead) {
  const cancelled = lead.visit === 'cancelled';
  let answer = null;
  if (cancelled) answer = { outcome: 'not_counted', reason: 'customer_cancelled', beforeVisit: true, late: false };
  else if (lead.owner === 'happened') answer = { outcome: 'happened', reason: null, beforeVisit: false, late: false };
  else if (lead.owner === 'did_not_happen') answer = { outcome: 'not_counted', reason: 'did_not_happen', beforeVisit: false, late: false };

  return {
    answered: lead.answered,
    texted: Boolean(lead.text),
    textFailed: false,
    replied: Boolean(lead.reply),
    booked: Boolean(lead.booking),
    outOfOrder: null,
    ruledOut: lead.ruledOut ?? null,
    handoff: Boolean(lead.handoff),
    visit: !lead.booking ? null : lead.visit === 'ahead' ? 'ahead' : 'passed',
    answer,
    settlement: null,
    asked: false,
    windowClosed: false,
  };
}

/* the chain, in order. the first missing link is the reason. only what the page prints is
   kept: an example has no date for a fee to read. */
export function ledgerVerdict(lead) {
  const { status, label, tone, billed, reason } = ledgerStatus(ledgerFacts(lead));
  return { status, label, tone, billed, reason };
}

const SOURCE = {
  missed_call: 'a missed call to your main line',
  web_form: 'the form on your website',
};

/* the seven lines every lead shows, in the order they happened; its status is the eighth.
   each is a label, a value and `held`: true when that step is on record, false when it is
   the gap, null when the step does not apply to this lead. */
export function ledgerRecord(lead) {
  const answered =
    lead.answered === null
      ? ['not a call — it was sent after the office closed', true]
      : lead.answered
        ? ['yes', false]
        : ['no — it rang out', true];

  const reply = lead.reply ? [`“${lead.reply}”`, lead.ruledOut !== 'wrong_number'] : ['no reply', false];

  let booking;
  if (lead.handoff) booking = [`handed to you — ${lead.handoff}. arc stopped texting and alerted you.`, null];
  else if (lead.ruledOut === 'wrong_number') booking = ['none — arc stopped texting', null];
  else if (lead.booking && lead.visit === 'cancelled') {
    booking = [`booked for ${lead.booking.when}, then cancelled by the customer`, false];
  } else if (lead.booking) booking = [`booked for ${lead.booking.when}`, true];
  else booking = ['none', lead.reply ? false : null];

  let owner;
  if (lead.owner === 'happened') owner = ['you said the visit happened', true];
  else if (lead.owner === 'did_not_happen') owner = ['you said the job did not happen', false];
  else if (lead.booking && lead.visit === 'done') owner = ['not answered yet', false];
  else if (lead.booking && lead.visit === 'ahead') owner = ['not asked yet — the visit is still ahead', null];
  else owner = ['nothing to confirm', null];

  return [
    { label: 'came in from', value: SOURCE[lead.source], held: true },
    { label: 'arrived', value: lead.arrived, held: true },
    { label: 'did you answer', value: answered[0], held: answered[1] },
    { label: 'arc’s first text', value: lead.text ? `“${lead.text}”` : 'none sent', held: Boolean(lead.text) },
    { label: 'the customer’s reply', value: reply[0], held: reply[1] },
    { label: 'booking or handoff', value: booking[0], held: booking[1] },
    { label: 'your confirmation', value: owner[0], held: owner[1] },
  ];
}

/* the page's data: each lead with its record and verdict, and the tally the heading prints.
   the tally is counted from the verdicts, never typed. */
export function buildProofLedger(leads = PROOF_LEDGER_LEADS) {
  const rows = leads.map((lead) => ({ ...lead, record: ledgerRecord(lead), verdict: ledgerVerdict(lead) }));
  const count = (status) => rows.filter((row) => row.verdict.status === status).length;
  return {
    company: PROOF_LEDGER_COMPANY,
    leads: rows,
    tally: {
      total: rows.length,
      counts: rows.filter((row) => row.verdict.billed).length,
      needsYou: count('needs_owner'),
      notBilled: rows.filter((row) => !row.verdict.billed).length,
    },
  };
}
