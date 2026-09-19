/**
 * The Lead Recovery state machine.
 *
 * Every automation is a set of timers until somebody writes down which order things are
 * allowed to happen in. Then it is a state machine, and the difference shows up the first
 * time a customer replies four seconds before a scheduled follow-up fires: with a state
 * machine that is an invalid transition and a stopped run, and without one it is a text
 * that arrives after the customer already answered.
 *
 * Two rules:
 *
 * 1. **A transition that is not on the map fails loudly.** It does not clamp to the nearest
 *    legal state and it does not no-op. A run that tried to go from `suppressed` back to
 *    `awaiting_reply` is a bug that would text somebody who opted out, and the only safe
 *    response to it is to stop and say so.
 *
 * 2. **Whether a message may be sent is a property of the state, asked once.** Not a
 *    condition assembled at each call site out of four booleans, because the fifth call
 *    site is the one that forgets one.
 *
 * The state list is duplicated as a check constraint on `automation_runs.state` in
 * migration 0010. That is deliberate belt-and-braces: an engine that invents a state should
 * fail at the write, not store it.
 */

export const STATES = [
  /* the lead exists; nothing has been decided. */
  'new',
  /* the first response is on the queue with a time against it. */
  'response_queued',
  /* it left. we are waiting on the customer. */
  'awaiting_reply',
  /* they answered and the classifier has it. */
  'qualifying',
  /* classified, in area, safe, confident — the contractor has it. */
  'qualified',
  /* a person must take this before anything else happens. */
  'handoff_required',
  /* a person has it. */
  'handed_off',
  /* it turned into work. */
  'booked',
  /* finished, for any ordinary reason. */
  'closed',
  /* this contact must not be messaged again. */
  'suppressed',
  /* the run could not complete — retries exhausted or a permanent error. */
  'failed',
] as const;

export type RunState = (typeof STATES)[number];

/**
 * The map. Read as "from → the states it may reach".
 *
 * `suppressed`, `failed` and `closed` reach nothing: once a customer has opted out, once a
 * run has exhausted its retries, once the lead is closed, there is no path back that does
 * not begin with a person creating a new lead. `booked` may still close, because closing is
 * bookkeeping rather than a change of outcome.
 */
export const TRANSITIONS: Record<RunState, RunState[]> = {
  /* `qualifying` is reachable from both of the first two states because a customer can
     text in before the automation has finished speaking: a web-form lead whose first
     response is still queued, or an inbound SMS that arrived with no prior contact at all.
     A reply always outranks a scheduled message. */
  new: ['response_queued', 'qualifying', 'handoff_required', 'suppressed', 'closed', 'failed'],
  response_queued: ['awaiting_reply', 'qualifying', 'handoff_required', 'suppressed', 'closed', 'failed'],
  awaiting_reply: ['qualifying', 'handoff_required', 'booked', 'suppressed', 'closed', 'failed'],
  qualifying: ['qualified', 'handoff_required', 'awaiting_reply', 'suppressed', 'closed', 'failed'],
  qualified: ['handed_off', 'handoff_required', 'booked', 'awaiting_reply', 'suppressed', 'closed', 'failed'],
  handoff_required: ['handed_off', 'booked', 'closed', 'suppressed'],
  handed_off: ['booked', 'closed', 'suppressed'],
  booked: ['closed'],
  closed: [],
  suppressed: [],
  failed: [],
};

/** Nothing further will happen on its own from here. */
export const TERMINAL_STATES: RunState[] = ['booked', 'closed', 'suppressed', 'failed'];

/**
 * The states in which the engine may put a message in front of a customer.
 *
 * Asked as one question in one place. `handoff_required` and `handed_off` are not on the
 * list and that is the entire point of them — once a person is involved, the automation's
 * job is to stop talking.
 */
export const SENDING_STATES: RunState[] = [
  'new',
  'response_queued',
  'awaiting_reply',
  'qualifying',
  'qualified',
];

export function isState(value: unknown): value is RunState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function maySend(state: RunState): boolean {
  return SENDING_STATES.includes(state);
}

export type TransitionResult =
  | { ok: true; from: RunState; to: RunState }
  | { ok: false; error: string };

/**
 * The only way a run changes state.
 *
 * A same-state transition is allowed and reported as such: the dispatcher re-recording
 * `awaiting_reply` after a retried send is not an error, and forcing every caller to check
 * first would just move the check somewhere less reliable.
 */
export function transition(from: unknown, to: unknown): TransitionResult {
  if (!isState(from)) return { ok: false, error: `"${String(from)}" is not a state this module has` };
  if (!isState(to)) return { ok: false, error: `"${String(to)}" is not a state this module has` };
  if (from === to) return { ok: true, from, to };

  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: isTerminal(from)
        ? `this run is ${from} and cannot move to ${to} — a finished run is finished`
        : `${from} → ${to} is not a transition this module allows (from ${from}: ${TRANSITIONS[from].join(', ')})`,
    };
  }

  return { ok: true, from, to };
}

/** Why a run stopped. Mirrors the check constraint on `automation_runs.stop_reason`. */
export const STOP_REASONS = [
  'opted_out',
  'human_takeover',
  'safety',
  'booked',
  'closed',
  'failed',
  'replaced',
  'not_permitted',
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/**
 * The five things that stop automation, and the state each one lands in.
 *
 * Kept as one table rather than five branches so the product promise — "automation stops
 * when the customer opts out, an employee takes over, a safety issue is detected, the lead
 * is booked, or the lead is closed" — is one readable object rather than a behaviour spread
 * across three files.
 */
export const STOP_LANDING: Record<StopReason, RunState> = {
  opted_out: 'suppressed',
  human_takeover: 'handed_off',
  safety: 'handoff_required',
  booked: 'booked',
  closed: 'closed',
  failed: 'failed',
  replaced: 'closed',
  not_permitted: 'closed',
};
