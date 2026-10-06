/**
 * ARC-360 — the lead inbox: what each open lead needs, read off the records as they are.
 *
 * **Portal-safe.** No database, no network, no Deno API. The workspace (`CrmWorkspace.jsx`)
 * runs this over the rows `crm-workspace` returns, and the tests run it over the same rows, so
 * "which leads need attention" has one definition and is never stored.
 *
 * It answers the questions a business opens the inbox with:
 *
 *   what new leads need attention?          `attention` — any reason below that a person must act on
 *   who owns each lead?                     `owner_user_id`, and `unowned`
 *   which leads have not been contacted?    `untouched` — still in the pipeline's entry stage
 *   what is the next task?                  `next_task` — the open task due first
 *   which are waiting on the customer?      `waiting` — the stage says so (0025's `waits_on`)
 *   which have booked or closed?            `closed` — a won or lost stage
 *   which are blocked?                      `blocked` — do-not-contact, or Lead Recovery handed
 *                                           it to a person / flagged it — with each reason
 *   which have a time booked?               `next_appointment` — an appointment still holding its
 *                                           time (ARC-380) is a next step; one still `requested`
 *                                           is waiting on the business (`booking_request`)
 *
 * What this is not: a figure. Nothing here is counted into a report, and a lead in a `won`
 * stage is a CRM state somebody set, not a verified outcome — that is still the `events` log.
 * "Untouched" is about the stage, never a guess from notes: a note saying "called, no answer"
 * leaves a lead where a person left it.
 */

import { fieldOwner, POLICY_FIELDS, type SourcePolicy } from './model.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** the inbox's queues, in the order the screen offers them. a lead can be in several. */
export const INBOX_QUEUES = ['attention', 'untouched', 'overdue', 'unowned', 'waiting', 'blocked', 'mine', 'open', 'closed'] as const;
export type InboxQueue = typeof INBOX_QUEUES[number];

export const QUEUE_WORDS: Readonly<Record<InboxQueue, string>> = Object.freeze({
  attention: 'needs attention',
  untouched: 'not contacted',
  overdue: 'overdue',
  unowned: 'no owner',
  waiting: 'waiting on customer',
  blocked: 'blocked',
  mine: 'mine',
  open: 'all open',
  closed: 'booked or closed',
});

/** why a lead is blocked. each is a reason a person, not the system, decides what happens next. */
export const BLOCK_REASONS = ['do_not_contact', 'handed_to_person', 'safety_flag'] as const;
export type BlockReason = typeof BLOCK_REASONS[number];

/* Lead Recovery's own statuses (0010) that mean a person has it, not the automation. */
const RECOVERY_HANDOFF = new Set(['handoff_required', 'handed_off', 'suppressed']);

export interface LeadState {
  lead: Row;
  contact: Row | null;
  stage: Row | null;
  /** the open task due first; undated tasks after dated ones. */
  next_task: Row | null;
  open_tasks: number;
  /** ARC-380: the appointment ahead of this lead that still holds its time, soonest first. */
  next_appointment: Row | null;
  /** a customer asked for a time and nobody has answered. */
  booking_request: boolean;
  overdue: boolean;
  untouched: boolean;
  unowned: boolean;
  waiting: boolean;
  closed: boolean;
  blocked: { reason: BlockReason; detail: string }[];
  /** open, not waiting on the customer, and something here is for a person to do. */
  attention: boolean;
  /** why it needs attention, in words, most pressing first. */
  reasons: string[];
}

export interface InboxInput {
  leads: Row[];
  contacts: Row[];
  pipelines: (Row & { stages: Row[] })[];
  tasks: Row[];
  /** contact id → the suppression rows for its addresses (read from `suppressions`). */
  blocks?: Record<string, Row[]>;
  /** recovery lead id → { status, safety_flags } from Lead Recovery's own row. */
  recovery?: Record<string, Row>;
  /** ARC-380: appointments still holding a time (requested or confirmed), by reference. */
  appointments?: Row[];
}

/** the stage a new lead lands in: the first open stage still in use. */
export function entryStage(pipeline: { stages: Row[] }): Row | null {
  return [...pipeline.stages]
    .filter((s) => s.kind === 'open' && !s.archived_at)
    .sort((a, b) => a.position - b.position)[0] ?? null;
}

const dueTime = (task: Row) => (task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY);

export function nextTask(tasks: Row[]): Row | null {
  return [...tasks]
    .filter((t) => t.status === 'open')
    .sort((a, b) => dueTime(a) - dueTime(b) || String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null;
}

/** a lead's state, from its own rows. `now` is a parameter so a test can fix it. */
export function leadState(input: InboxInput, lead: Row, now: Date = new Date()): LeadState {
  const pipeline = input.pipelines.find((p) => p.id === lead.pipeline_id);
  const stage = pipeline?.stages.find((s) => s.id === lead.stage_id) ?? null;
  const contact = input.contacts.find((c) => c.id === lead.contact_id) ?? null;
  const tasks = input.tasks.filter((t) => t.lead_id === lead.id);
  const open = lead.status === 'open';
  const next = nextTask(tasks);
  const overdue = open && tasks.some((t) => t.status === 'open' && t.due_at && Date.parse(t.due_at) < now.getTime());
  const entry = pipeline ? entryStage(pipeline) : null;
  const untouched = open && Boolean(entry) && lead.stage_id === entry!.id;
  const unowned = open && !lead.owner_user_id;
  const waiting = open && stage?.waits_on === 'customer';
  const held = (input.appointments ?? []).filter((a) => a.lead_id === lead.id && (a.status === 'requested' || a.status === 'confirmed'));
  const nextAppointment = [...held].filter((a) => Date.parse(a.starts_at) >= now.getTime())
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] ?? null;
  const bookingRequest = open && held.some((a) => a.status === 'requested');

  const blocked: LeadState['blocked'] = [];
  for (const row of input.blocks?.[lead.contact_id] ?? []) {
    if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) continue;
    blocked.push({ reason: 'do_not_contact', detail: `${row.channel === 'email' ? 'email' : 'texts'}: ${String(row.reason).replace(/_/g, ' ')}` });
  }
  const recovery = lead.recovery_lead_id ? input.recovery?.[lead.recovery_lead_id] : undefined;
  if (recovery && RECOVERY_HANDOFF.has(recovery.status)) {
    blocked.push({ reason: 'handed_to_person', detail: `lead recovery: ${String(recovery.status).replace(/_/g, ' ')}` });
  }
  if (recovery && Array.isArray(recovery.safety_flags) && recovery.safety_flags.length > 0) {
    blocked.push({ reason: 'safety_flag', detail: `flagged: ${recovery.safety_flags.join(', ').replace(/_/g, ' ')}` });
  }

  const reasons: string[] = [];
  if (open) {
    if (blocked.length > 0) reasons.push('blocked — a person decides what happens next');
    if (bookingRequest) reasons.push('a booking request is waiting for an answer');
    if (overdue) reasons.push('a task is overdue');
    if (untouched) reasons.push('not contacted yet');
    if (!waiting && !next && !nextAppointment) reasons.push('no next step');
    if (unowned) reasons.push('nobody owns it');
  }
  /* waiting on the customer is not ours to chase until a task says so. */
  const attention = open && (blocked.length > 0 || overdue || bookingRequest || (!waiting && (untouched || (!next && !nextAppointment))));

  return {
    lead, contact, stage, next_task: next, open_tasks: tasks.filter((t) => t.status === 'open').length,
    next_appointment: nextAppointment, booking_request: bookingRequest,
    overdue, untouched, unowned, waiting, closed: !open, blocked, attention, reasons,
  };
}

export function inboxStates(input: InboxInput, now: Date = new Date()): LeadState[] {
  return input.leads.filter((l) => !l.archived_at).map((lead) => leadState(input, lead, now));
}

export function inQueue(state: LeadState, queue: InboxQueue, viewerId: string | null): boolean {
  switch (queue) {
    case 'attention': return state.attention;
    case 'untouched': return state.untouched;
    case 'overdue': return state.overdue;
    case 'unowned': return state.unowned;
    case 'waiting': return state.waiting;
    case 'blocked': return !state.closed && state.blocked.length > 0;
    case 'mine': return !state.closed && Boolean(viewerId) && state.lead.owner_user_id === viewerId;
    case 'open': return !state.closed;
    case 'closed': return state.closed;
  }
}

export function queueCounts(states: LeadState[], viewerId: string | null): Record<InboxQueue, number> {
  const out = Object.fromEntries(INBOX_QUEUES.map((q) => [q, 0])) as Record<InboxQueue, number>;
  for (const state of states) for (const q of INBOX_QUEUES) if (inQueue(state, q, viewerId)) out[q] += 1;
  return out;
}

/* ── search, filter, sort ─────────────────────────────────── */

export interface LeadFilter {
  queue?: InboxQueue;
  text?: string;
  stage_id?: string | null;
  /** a user id, 'none', or empty for anybody. */
  owner?: string | null;
  source?: string | null;
  priority?: string | null;
}

export const SORTS = ['newest', 'oldest', 'next_due', 'priority', 'updated'] as const;
export type LeadSort = typeof SORTS[number];

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

/** does this lead match what was typed: a name, a phone (by its digits), an email, its title. */
export function matchesText(state: LeadState, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const c = state.contact ?? {};
  const haystack = [c.display_name, c.email, state.lead.title, state.lead.summary, c.city, c.postal_code]
    .filter(Boolean).join(' ').toLowerCase();
  if (haystack.includes(q)) return true;
  const typed = digits(q);
  return typed.length >= 3 && digits(c.phone).includes(typed);
}

export function filterLeads(states: LeadState[], filter: LeadFilter, viewerId: string | null): LeadState[] {
  return states.filter((s) =>
    (!filter.queue || inQueue(s, filter.queue, viewerId))
    && (!filter.stage_id || s.lead.stage_id === filter.stage_id)
    && (!filter.owner || (filter.owner === 'none' ? !s.lead.owner_user_id : s.lead.owner_user_id === filter.owner))
    && (!filter.source || s.lead.source === filter.source)
    && (!filter.priority || s.lead.priority === filter.priority)
    && matchesText(s, filter.text ?? ''));
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function sortLeads(states: LeadState[], sort: LeadSort): LeadState[] {
  const created = (s: LeadState) => Date.parse(s.lead.created_at);
  const by: Record<LeadSort, (a: LeadState, b: LeadState) => number> = {
    newest: (a, b) => created(b) - created(a),
    oldest: (a, b) => created(a) - created(b),
    next_due: (a, b) => (a.next_task ? dueTime(a.next_task) : Infinity) - (b.next_task ? dueTime(b.next_task) : Infinity) || created(b) - created(a),
    priority: (a, b) => (PRIORITY_RANK[a.lead.priority] ?? 9) - (PRIORITY_RANK[b.lead.priority] ?? 9) || created(b) - created(a),
    updated: (a, b) => Date.parse(b.lead.updated_at) - Date.parse(a.lead.updated_at),
  };
  return [...states].sort(by[sort]);
}

/* ── who may edit what ────────────────────────────────────── */

/**
 * The fields of a record this workspace may not change, because the client's own system is
 * the authority for them (ARC-340's source-of-truth policy). The screen disables them and
 * says where they are changed; `writeDecision` refuses them on the server regardless.
 */
export function lockedFields(policy: SourcePolicy | null | undefined): string[] {
  if (!policy) return [];
  return POLICY_FIELDS[policy.objectType].filter((field) => fieldOwner(policy, field) === 'external');
}

/** whether a whole kind of record is created elsewhere (an `external` authority). */
export function createdElsewhere(policy: SourcePolicy | null | undefined): boolean {
  return policy?.authority === 'external';
}

/* ── tasks across the workspace ───────────────────────────── */

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'undated' | 'done';

/** which list an open task belongs in, by its due time in the business's own timezone. */
export function taskBucket(task: Row, now: Date, timezone: string): TaskBucket {
  if (task.status !== 'open') return 'done';
  if (!task.due_at) return 'undated';
  const due = Date.parse(task.due_at);
  if (due < now.getTime()) return 'overdue';
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  return day(due) === day(now.getTime()) ? 'today' : 'upcoming';
}
