/* ARC-MK-200 — the owner portal: four screens, read off what the workspace already holds.
 *
 * a launch client is sold one thing — missed calls texted back — and reads it on a phone.
 * thirteen pages that explain the machine are the wrong answer to "is it working?", so that
 * client gets four: this month, jobs, needs you, account. nothing is deleted to get there;
 * every other page keeps its address and is reached from account, under "details".
 *
 * this file decides what the four screens say, and derives all of it:
 *
 *   - `isLaunchClient` reads who gets the four screens off module availability. it is not
 *     a setting anybody types.
 *   - `ownerJobs` is the one list the jobs screen, the tally and the export all read. where
 *     the workspace was handed a proof ledger (the demo's seven written examples) the jobs
 *     are those, already carrying their verdicts. otherwise they are the client's own leads
 *     from the event log, each showing only what the log proves.
 *   - `ownerMonth` and `ownerNeeds` are counted from those jobs and from the attention
 *     queue. nothing here keeps a number of its own.
 *
 * what it does NOT do, on purpose: decide that a real job counts. the evidence a job needs
 * is ARC-MK-210's to define, so a real lead here is never "counts" — it is shown, with the
 * reason it is not counted yet. and the fee is never worked out here: a figure that cannot
 * be shown is null with its reason, and the page prints a dash, never a zero.
 */

import { formatStamp, maskPhone } from './format.js';
import { LEDGER_STATUS } from '../demo/proof-ledger.js';

/* ── who gets the four screens ──────────────────────────── */

export const LAUNCH_MODULE = 'lead_capture';

/**
 * a launch client has lead capture and nothing else: every other module is not part of
 * their plan. read off availability, so a client who later buys a second service gets the
 * full workspace back on the next load with nobody flipping anything.
 */
export function isLaunchClient(availability) {
  if (!availability || typeof availability !== 'object') return false;
  const own = availability[LAUNCH_MODULE];
  if (!own || own.state === 'unavailable') return false;
  return Object.entries(availability).every(([key, module]) => key === LAUNCH_MODULE || module?.state === 'unavailable');
}

/* ── jobs ───────────────────────────────────────────────── */

export const NOT_COUNTED_YET =
  'the rules that decide whether a job counts are not switched on for your account yet. shown, never billed.';

const verdict = (status, reason) => ({ status, ...LEDGER_STATUS[status], reason });

/* a real lead, as the same seven lines the examples show. each line states only what the
   event log holds: `held` true when the step is on record, false when it is the gap, null
   when it does not apply. no message text is shown — we do not keep a customer's words. */
function liveJob(lead, timezone) {
  const isCall = lead.source === 'missed_call';
  const texted = lead.latencyMs !== null && lead.latencyMs !== undefined && !lead.failed;

  const text = lead.failed
    ? ['arc tried, and the text did not send', false]
    : texted
      ? [lead.deliveredAt ? 'sent, and delivered to their phone' : 'sent', true]
      : ['none sent', false];

  let booking;
  if (lead.handoff) booking = [`handed to you${lead.handoff.reason ? ` — ${lead.handoff.reason}` : ''}. arc stopped texting.`, null];
  else if (lead.booked) booking = ['booked', true];
  else booking = ['none', lead.replied ? false : null];

  const record = [
    { label: 'came in from', value: lead.sourceLabel ?? 'a lead', held: true },
    { label: 'arrived', value: formatStamp(lead.startedAt, timezone), held: true },
    { label: 'did you answer', value: isCall ? 'no — it rang out' : 'not a call', held: true },
    { label: 'arc’s first text', value: text[0], held: text[1] },
    { label: 'the customer’s reply', value: lead.replied ? 'they replied' : 'no reply', held: Boolean(lead.replied) },
    { label: 'booking or handoff', value: booking[0], held: booking[1] },
    { label: 'your confirmation', value: 'not asked yet', held: null },
  ];

  return {
    key: lead.id,
    title: lead.name ?? (lead.phone ? maskPhone(lead.phone) : 'unknown caller'),
    record,
    verdict: lead.handoff
      ? verdict('handed', 'arc stopped texting and handed this to a person. a handoff is never billed.')
      : verdict('pending', NOT_COUNTED_YET),
  };
}

/**
 * the jobs screen's list.
 *
 *   example   true when these are the written examples, so the page can say so
 *   jobs      [{ key, title, record: [{ label, value, held }], verdict }]
 *   tally     total and waiting are counts; `counts` is null when nothing may be counted yet
 */
export function ownerJobs(data) {
  if (data?.proofLedger) {
    const { leads, tally } = data.proofLedger;
    return {
      example: true,
      jobs: leads.map((lead) => ({ key: lead.key, title: lead.title, record: lead.record, verdict: lead.verdict })),
      tally: { total: tally.total, counts: tally.counts, needsYou: tally.needsYou, notBilled: tally.notBilled },
      of: tally.total,
    };
  }

  const jobs = (data?.threads ?? []).map((lead) => liveJob(lead, data.tenant?.timezone ?? 'UTC'));
  return {
    example: false,
    jobs,
    tally: {
      total: jobs.length,
      counts: null,
      needsYou: jobs.filter((job) => job.verdict.status === 'handed').length,
      notBilled: jobs.length,
    },
    /* the true count behind a capped list, so the page can say "150 of 412". */
    of: data?.threadTotal ?? jobs.length,
  };
}

/* ── needs you ──────────────────────────────────────────── */

export const NEED_KINDS = [
  { key: 'outcome', label: 'did the job happen?', blurb: 'one question for each visit whose time has passed.' },
  { key: 'handoff', label: 'handed to you', blurb: 'arc stopped texting. a person needs to take these.' },
  { key: 'other', label: 'worth a look', blurb: 'leads that did not go the usual way.' },
];

const HANDOFF_REASONS = new Set(['safety', 'handoff']);

/**
 * everything waiting on the owner, in three kinds. derived on every read: an item that
 * stops needing a person is not in the next list, with no write anywhere.
 */
export function ownerNeeds(data) {
  let items;

  if (data?.proofLedger) {
    items = data.proofLedger.leads
      .filter((lead) => lead.verdict.status === 'needs_you' || lead.verdict.status === 'handed')
      .map((lead) =>
        lead.verdict.status === 'handed'
          ? {
              key: lead.key,
              kind: 'handoff',
              title: lead.reply ? `“${lead.reply}”` : lead.title,
              detail: `${lead.arrived} · ${lead.handoff}`,
              reason: lead.verdict.reason,
              to: 'jobs',
            }
          : {
              key: lead.key,
              kind: 'outcome',
              title: lead.booking ? `the visit booked for ${lead.booking.when}` : lead.title,
              detail: lead.reply ? `“${lead.reply}”` : null,
              reason: lead.verdict.reason,
              to: 'jobs',
            },
      );
  } else {
    items = (data?.attention?.items ?? []).map((item) => ({
      key: item.key,
      kind: HANDOFF_REASONS.has(item.reasonKey) ? 'handoff' : 'other',
      title: item.customer,
      detail: item.detail ?? null,
      reason: item.reason,
      openedAt: item.openedAt ?? null,
      to: item.to ?? null,
    }));
  }

  return {
    example: Boolean(data?.proofLedger),
    total: items.length,
    groups: NEED_KINDS.map((kind) => ({ ...kind, items: items.filter((item) => item.kind === kind.key) })).filter(
      (group) => group.items.length > 0,
    ),
  };
}

/* ── this month ─────────────────────────────────────────── */

const figure = (key, label, value, note) => ({ key, label, value, note, available: value !== null && value !== undefined });

const termsEntered = (terms) =>
  Boolean(terms) && ['monthlyBase', 'perRecoveredJob', 'monthlyCap'].every((key) => typeof terms[key] === 'number');

/**
 * the three figures at the top, the smaller counts under them, and one card per leak.
 *
 * `value: null` is "cannot be shown", and `note` is then the reason. the fee is always
 * null here: with no terms entered there is nothing to multiply, and with terms entered
 * the arithmetic still waits for the counting rules. it is never a zero.
 */
export function ownerMonth(data, { terms = null, leaks = [] } = {}) {
  const jobs = ownerJobs(data);
  const needs = ownerNeeds(data);
  const example = jobs.example;
  const module = data?.availability?.[LAUNCH_MODULE] ?? null;
  const live = example || module?.state === 'live';
  const notLive = module?.awaiting ?? 'your phone line is not connected yet';

  const figures = [
    jobs.tally.counts === null
      ? figure('brought_back', 'jobs brought back', null, live ? 'counted once the proof rules are switched on for your account' : notLive)
      : figure('brought_back', 'jobs brought back', jobs.tally.counts, 'every step on record, and you said it happened'),
    live
      ? figure('waiting', 'waiting on you', needs.total, needs.total === 0 ? 'nothing needs you right now' : 'open “needs you” to see them')
      : figure('waiting', 'waiting on you', null, notLive),
    figure(
      'fee',
      'fee owed',
      null,
      termsEntered(terms) ? 'worked out once the proof rules are switched on' : 'your pilot terms are not entered yet',
    ),
  ];

  /* what is provable today without any counting rule: things that happened. in the demo
     they are counted from the seven examples, so the page never mixes two datasets. */
  let proven = null;
  if (example) {
    const leads = data.proofLedger.leads;
    proven = [
      { label: 'calls and forms in', value: leads.length },
      { label: 'texted back', value: leads.filter((lead) => lead.text).length },
      { label: 'customers replied', value: leads.filter((lead) => lead.reply).length },
      { label: 'handed to a person', value: leads.filter((lead) => lead.handoff).length },
    ];
  } else if (live && data?.leadCapture?.metrics) {
    const m = data.leadCapture.metrics;
    proven = [
      { label: 'calls and forms in', value: m.opportunities },
      { label: 'texted back', value: m.answered },
      { label: 'customers replied', value: m.replied },
      { label: 'handed to a person', value: m.escalations },
    ];
  }

  return {
    example,
    figures,
    proven,
    provenWindow: example ? 'the seven examples' : 'last 30 days',
    /* one card per leak, in the homepage's own words and order. only the first can be
       running; the rest print their stage and no figure at all. */
    leaks: leaks.map((leak) => ({
      key: leak.key,
      name: leak.name,
      what: leak.what,
      stage: leak.stage,
      running: leak.stage === 'launch' && live,
      status: leak.stage === 'launch' ? (live ? 'running for you' : notLive) : leak.status,
    })),
  };
}

/* ── export my data ─────────────────────────────────────── */

/** the jobs screen as a table: one row per job, the seven lines, then the status and why. */
export function jobsTable(jobs) {
  const labels = jobs[0]?.record.map((line) => line.label) ?? [];
  return {
    columns: [
      { label: 'job', value: (job) => job.title },
      ...labels.map((label, index) => ({ label, value: (job) => job.record[index]?.value ?? '' })),
      { label: 'status', value: (job) => job.verdict.label },
      { label: 'billed', value: (job) => (job.verdict.billed ? 'yes' : 'no') },
      { label: 'why', value: (job) => job.verdict.reason },
    ],
    rows: jobs,
  };
}
