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
 *     from the event log, each showing only what the log proves, with the verdict the same
 *     rule gave it.
 *   - `ownerMonth` and `ownerNeeds` are counted from those jobs and from the attention
 *     queue. nothing here keeps a number of its own.
 *
 * what it does NOT do, on purpose: decide that a job counts. that is the ledger's rule
 * (`ledger.js`, ARC-MK-210), read off the event log once in `buildDashboardData`; each lead
 * arrives here already carrying its verdict, and this file only words it. the fee is the
 * ledger's arithmetic too. a figure that cannot be shown is null with its reason, and the
 * page prints a dash, never a zero.
 */

import { formatStamp, maskPhone } from './format.js';
import { LEDGER_STATUS, disputeReasonWords } from './ledger.js';

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

/* a lead whose verdict did not arrive. it should not happen — every lead is run through
   the ledger — so it is said plainly rather than dressed as a status. */
export const NO_VERDICT = 'this lead’s record could not be read, so nothing about it is counted.';

const verdict = (status, reason) => ({ status, ...LEDGER_STATUS[status], reason });

/* a real lead, as the same seven lines the examples show. each line states only what the
   event log holds: `held` true when the step is on record, false when it is the gap, null
   when it does not apply. no message text is shown — we do not keep a customer's words. */
function liveJob(lead, timezone) {
  const isCall = lead.source === 'missed_call';
  const texted = lead.latencyMs !== null && lead.latencyMs !== undefined && !lead.failed;
  const ledger = lead.ledger ?? null;
  const when = ledger?.appointmentAt ? formatStamp(ledger.appointmentAt, timezone) : null;
  const cancelled = ledger?.answer?.outcome === 'not_counted' && ledger.answer.beforeVisit;

  const text = lead.failed
    ? ['arc tried, and the text did not send', false]
    : texted
      ? [lead.deliveredAt ? 'sent, and delivered to their phone' : 'sent', true]
      : ['none sent', false];

  let booking;
  if (lead.handoff) booking = [`handed to you${lead.handoff.reason ? ` — ${lead.handoff.reason}` : ''}. arc stopped texting.`, null];
  else if (lead.booked && cancelled) booking = [`booked${when ? ` for ${when}` : ''}, then ruled out — ${disputeReasonWords(ledger.answer.reason)}`, false];
  else if (lead.booked) booking = when ? [`booked for ${when}`, true] : ['booked, with no visit time on record', false];
  else booking = ['none', lead.replied ? false : null];

  let owner = ['nothing to confirm', null];
  if (lead.booked && !lead.handoff && !cancelled) {
    const answer = ledger?.answer ?? null;
    if (answer?.outcome === 'happened') owner = ['you said the job happened', true];
    else if (answer?.outcome === 'quoted') owner = ['you said the visit happened, and the quote is open', true];
    else if (answer?.outcome === 'not_counted') owner = [`you said it should not count — ${disputeReasonWords(answer.reason)}`, false];
    else if (ledger?.visit === 'ahead') owner = ['not asked yet — the visit is still ahead', null];
    else if (ledger?.visit === 'passed') owner = [ledger.asked ? 'asked, not answered yet' : 'not answered yet', false];
  }

  const record = [
    { label: 'came in from', value: lead.sourceLabel ?? 'a lead', held: true },
    { label: 'arrived', value: formatStamp(lead.startedAt, timezone), held: true },
    { label: 'did you answer', value: isCall ? 'no — it rang out' : 'not a call', held: true },
    { label: 'arc’s first text', value: text[0], held: text[1] },
    { label: 'the customer’s reply', value: lead.replied ? 'they replied' : 'no reply', held: Boolean(lead.replied) },
    { label: 'booking or handoff', value: booking[0], held: booking[1] },
    { label: 'your confirmation', value: owner[0], held: owner[1] },
  ];

  return {
    key: lead.id,
    title: lead.name ?? (lead.phone ? maskPhone(lead.phone) : 'unknown caller'),
    record,
    verdict: ledger ? verdict(ledger.status, ledger.reason) : verdict('unverified', NO_VERDICT),
  };
}

/**
 * the jobs screen's list.
 *
 *   example   true when these are the written examples, so the page can say so
 *   jobs      [{ key, title, record: [{ label, value, held }], verdict }]
 *   tally     counted from the ledger's totals over every lead, not the capped list
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
  const count = (status) => data?.ledger?.totals?.[status] ?? jobs.filter((job) => job.verdict.status === status).length;
  const billed = data?.ledger?.totals?.billed ?? jobs.filter((job) => job.verdict.billed).length;
  const total = data?.ledger?.totals?.total ?? jobs.length;
  return {
    example: false,
    jobs,
    tally: {
      total,
      counts: billed,
      needsYou: count('needs_owner') + count('handed_off'),
      notBilled: total - billed,
    },
    /* the true count behind a capped list, so the page can say "150 of 412". */
    of: data?.threadTotal ?? jobs.length,
  };
}

/* ── needs you ──────────────────────────────────────────── */

export const NEED_KINDS = [
  { key: 'outcome', label: 'did the job happen?', blurb: 'one question for each visit whose time has passed.' },
  { key: 'visit', label: 'book the visit', blurb: 'these customers wrote back. when you have agreed a time with one, put it here.' },
  { key: 'handoff', label: 'handed to you', blurb: 'arc stopped texting. a person needs to take these.' },
  { key: 'other', label: 'worth a look', blurb: 'leads that did not go the usual way.' },
];

const HANDOFF_REASONS = new Set(['safety', 'handoff']);

/* how long a reply with no visit against it stays on the needs-you screen. after that it is
   still on the jobs screen; it is only no longer something waiting on the owner. */
export const VISIT_WINDOW_DAYS = 14;

/**
 * ARC-GO-310 — the customers who wrote back and have no visit on record yet. the owner
 * agrees a time with them and records it here; until somebody does, the job cannot count.
 * read off each lead on every load: recording the visit, the customer opting out or the
 * window passing takes it off the list with nothing stored. a lead arc handed to a person
 * is in its own group and never billed, so it is not asked for a visit time here.
 */
function awaitingVisit(data, timezone) {
  const now = Date.parse(data?.generatedFor ?? '') || Date.now();
  return (data?.threads ?? [])
    .filter((lead) => {
      if (!lead.replied || lead.booked || lead.handoff || lead.suppressed) return false;
      const age = now - Date.parse(lead.repliedAt ?? lead.startedAt);
      return age >= 0 && age <= VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    })
    .map((lead) => ({
      key: `visit-${lead.id}`,
      kind: 'visit',
      title: lead.name ?? (lead.phone ? maskPhone(lead.phone) : 'a customer who wrote back'),
      detail: `wrote back ${formatStamp(lead.repliedAt ?? lead.startedAt, timezone)}`,
      reason: 'no visit is on record for this customer yet, so this job cannot count.',
      openedAt: lead.repliedAt ?? lead.startedAt,
      to: 'jobs',
      lead: lead.id,
    }));
}

/**
 * everything waiting on the owner, in four kinds. derived on every read: an item that
 * stops needing a person is not in the next list, with no write anywhere.
 */
export function ownerNeeds(data) {
  let items;

  if (data?.proofLedger) {
    items = data.proofLedger.leads
      .filter((lead) => lead.verdict.status === 'needs_owner' || lead.verdict.status === 'handed_off')
      .map((lead) =>
        lead.verdict.status === 'handed_off'
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
    const timezone = data?.tenant?.timezone ?? 'UTC';
    /* the one question the ledger is waiting on, first: a visit whose time has passed and
       that nobody has answered about. read off each lead's verdict, so answering it — or
       the window closing — takes it off this list with nothing stored. */
    const questions = (data?.threads ?? [])
      .filter((lead) => lead.ledger?.status === 'needs_owner')
      .map((lead) => ({
        key: `outcome-${lead.id}`,
        kind: 'outcome',
        title: `the visit booked for ${formatStamp(lead.ledger.appointmentAt, timezone)}`,
        detail: lead.name ?? (lead.phone ? maskPhone(lead.phone) : null),
        reason: lead.ledger.reason,
        openedAt: lead.ledger.appointmentAt,
        to: 'jobs',
        /* what the answer buttons send: the lead, and the answer being replaced (none). */
        lead: lead.id,
        replaces: null,
        asked: Boolean(lead.ledger.asked),
        /* when it counts by itself if nobody answers. null until arc has asked under terms. */
        countsAt: lead.ledger.windowEndsAt ? formatStamp(lead.ledger.windowEndsAt, timezone) : null,
      }));
    items = questions.concat(awaitingVisit(data, timezone), (data?.attention?.items ?? []).map((item) => ({
      key: item.key,
      kind: HANDOFF_REASONS.has(item.reasonKey) ? 'handoff' : 'other',
      title: item.customer,
      detail: item.detail ?? null,
      reason: item.reason,
      openedAt: item.openedAt ?? null,
      to: item.to ?? null,
    })));
  }

  return {
    example: Boolean(data?.proofLedger),
    total: items.length,
    groups: NEED_KINDS.map((kind) => ({ ...kind, items: items.filter((item) => item.kind === kind.key) })).filter(
      (group) => group.items.length > 0,
    ),
    /* not waiting on anyone, so not in the total: what the owner said in the last day, where
       a wrong tap can still be put right. */
    answered: data?.proofLedger ? [] : ownerAnswered(data),
  };
}

/* how long an answer stays on the needs-you screen to be changed. after that it is still on
   the jobs screen, and changing it is a conversation. */
export const CHANGE_WINDOW_HOURS = 24;

const SAID = { happened: 'the job happened', quoted: 'the visit happened, and the quote is open' };

/**
 * the owner's own answers from the last day that nobody has settled. read off each lead's
 * verdict and the time the data was built for — nothing remembers that a tap happened.
 */
export function ownerAnswered(data) {
  const timezone = data?.tenant?.timezone ?? 'UTC';
  const now = Date.parse(data?.generatedFor ?? '') || Date.now();
  return (data?.threads ?? [])
    .filter((lead) => {
      const answer = lead.ledger?.answer;
      if (!answer?.id || answer.by !== 'owner' || lead.ledger.settlement) return false;
      const age = now - Date.parse(answer.at);
      return age >= 0 && age <= CHANGE_WINDOW_HOURS * 60 * 60 * 1000;
    })
    .map((lead) => ({
      key: `answered-${lead.id}`,
      title: lead.ledger.appointmentAt ? `the visit booked for ${formatStamp(lead.ledger.appointmentAt, timezone)}` : (lead.name ?? 'a booked visit'),
      detail: lead.name ?? (lead.phone ? maskPhone(lead.phone) : null),
      said: SAID[lead.ledger.answer.outcome] ?? `it should not count — ${disputeReasonWords(lead.ledger.answer.reason)}`,
      status: lead.ledger.label,
      reason: lead.ledger.reason,
      lead: lead.id,
      replaces: lead.ledger.answer.id,
    }));
}

/* ── this month ─────────────────────────────────────────── */

const figure = (key, label, value, note, kind = 'count') => ({ key, label, value, note, kind, available: value !== null && value !== undefined });

/**
 * the three figures at the top, the smaller counts under them, and one card per leak.
 *
 * `value: null` is "cannot be shown", and `note` is then the reason. the fee is the
 * ledger's arithmetic over the jobs that became billable this month and the terms on
 * record; with no terms recorded there is nothing to multiply, and it is null — never a
 * zero. the written examples carry no dates and no terms, so the demo's fee is null too.
 */
export function ownerMonth(data, { leaks = [] } = {}) {
  const jobs = ownerJobs(data);
  const needs = ownerNeeds(data);
  const example = jobs.example;
  const module = data?.availability?.[LAUNCH_MODULE] ?? null;
  const live = example || module?.state === 'live';
  const notLive = module?.awaiting ?? 'your phone line is not connected yet';

  const month = example ? null : (data?.ledger?.month ?? null);
  const fee = month?.feeCents ?? null;

  let broughtBack;
  if (example) broughtBack = figure('brought_back', 'jobs brought back', jobs.tally.counts, 'every step on record, and you said it happened');
  else if (!live) broughtBack = figure('brought_back', 'jobs brought back', null, notLive);
  else if (!month) broughtBack = figure('brought_back', 'jobs brought back', null, 'this month’s count could not be read');
  else broughtBack = figure('brought_back', 'jobs brought back', month.billed, `counted in ${month.label}, every step on record`);

  const figures = [
    broughtBack,
    live
      ? figure('waiting', 'waiting on you', needs.total, needs.total === 0 ? 'nothing needs you right now' : 'open “needs you” to see them')
      : figure('waiting', 'waiting on you', null, notLive),
    fee === null || !live
      ? figure('fee', 'fee owed', null, !example && !live ? notLive : 'your pilot terms are not entered yet', 'money')
      : figure(
          'fee',
          'fee owed',
          fee,
          month.capped ? 'held at the most a month can cost' : 'your monthly base, plus each job that counts this month',
          'money',
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
    /* only once the line has reported one: a line whose answered calls are not being
       recorded has not answered zero calls. */
    if (typeof data.ledger?.callsAnswered === 'number') {
      proven.unshift({ label: 'calls you answered yourself', value: data.ledger.callsAnswered });
    }
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
