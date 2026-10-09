import { useState } from 'react';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Disclosure, Fact, Field, Notice, SelectInput, TextInput } from './ops-ui';
import { formatCount, formatMoney, formatStamp, maskPhone } from '../lib/format';
import { disputePattern, disputeReasonWords } from '../lib/ledger';
import { recordJobOutcome, recordPilotTerms, settleJobDispute } from '../lib/ops';
import { OWNER_ANSWERS } from '../../../supabase/functions/_shared/ledger/model.ts';

/**
 * ARC-MK-220 — the proof ledger, from the operator's side.
 *
 * What counts for this client, what the owner disputed and what is waiting on them, read off
 * the same dashboard object the client sees: every figure here is the ledger rule's
 * (`lib/ledger.js`), so this panel and the owner's four screens cannot disagree. It keeps no
 * status of its own.
 *
 * Three things an operator does here, each appending one row of evidence through `ops` and
 * nothing else:
 *
 *   - settle a dispute — accept it (not billed) or reject it with a note saying what the
 *     record shows (it counts). The owner sees the result and the reason on their jobs screen;
 *   - record an answer the owner gave some other way, marked as the operator's entry;
 *   - record the pilot terms. Without them there is no fee, and the owner is never asked.
 *
 * The dispute pattern is a prompt for a conversation. It changes no status and bills nothing.
 */

const dash = (reason) => (
  <>
    <span aria-hidden="true">—</span>
    <span className="ws-sr">not available. </span> <span className="ops-muted">{reason}</span>
  </>
);

/* the six answers, flattened to one list: an answer with several reasons is one row each. */
const ANSWER_OPTIONS = OWNER_ANSWERS.flatMap((answer) =>
  answer.reasons.length <= 1
    ? [{ value: `${answer.outcome}:${answer.reasons[0] ?? ''}`, label: answer.label }]
    : answer.reasons.map((reason) => ({ value: `${answer.outcome}:${reason}`, label: `${answer.label} — ${disputeReasonWords(reason)}` })),
);

const who = (lead) => lead.name ?? (lead.phone ? maskPhone(lead.phone) : 'unknown caller');
const visit = (lead, tz) => (lead.ledger?.appointmentAt ? formatStamp(lead.ledger.appointmentAt, tz) : 'no visit time on record');

function Dispute({ lead, tenant, reload }) {
  const [note, setNote] = useState('');
  const settle = (decision) => async () => {
    await settleJobDispute(tenant.id, { correlationId: lead.id }, { decision, disputeId: lead.ledger.answer.id, note: note.trim() || null });
    await reload();
    return decision === 'accepted' ? 'accepted — not billed' : 'rejected — it counts';
  };

  return (
    <li>
      <p>
        <b>{who(lead)}</b> · visit {visit(lead, tenant.timezone)}{' '}
        <Pill tone={lead.ledger.lateDispute ? 'neutral' : 'warn'}>{lead.ledger.lateDispute ? 'late dispute — still counts' : 'disputed'}</Pill>
      </p>
      <p className="ops-muted">
        the owner said: {disputeReasonWords(lead.ledger.answer.reason)}
        {lead.ledger.answer.at ? ` · ${formatStamp(lead.ledger.answer.at, tenant.timezone)}` : ''}
        {lead.ledger.answer.by === 'operator' ? ' · entered by an operator' : ''}
      </p>
      <Field label="what the record shows" hint="required to reject. the owner reads the outcome, not this note.">
        <TextInput value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div className="ops-rowactions">
        <ActionButton
          onRun={settle('accepted')}
          confirm="accept this dispute? the job stops counting and is not billed."
        >
          accept the dispute
        </ActionButton>
        <ActionButton
          onRun={settle('rejected')}
          disabled={note.trim() === ''}
          confirm="reject this dispute? the job counts and is billed in the month you settle it."
        >
          reject the dispute
        </ActionButton>
      </div>
    </li>
  );
}

function Waiting({ lead, tenant, reload }) {
  const [choice, setChoice] = useState(ANSWER_OPTIONS[0].value);
  const record = async () => {
    const [outcome, reason] = choice.split(':');
    const result = await recordJobOutcome(tenant.id, { correlationId: lead.id }, {
      outcome,
      reason: reason || null,
      answeredBy: 'operator',
      replaces: lead.ledger.answer?.id ?? null,
    });
    await reload();
    return result.written === false ? 'already on record' : 'recorded';
  };

  return (
    <li>
      <p>
        <b>{who(lead)}</b> · visit {visit(lead, tenant.timezone)}{' '}
        <span className="ops-muted">
          {lead.ledger.asked
            ? lead.ledger.windowEndsAt
              ? `· asked — counts by itself after ${formatStamp(lead.ledger.windowEndsAt, tenant.timezone)}`
              : '· asked'
            : '· not asked yet — the owner has not opened the question'}
        </span>
      </p>
      <div className="ops-rowactions">
        <SelectInput options={ANSWER_OPTIONS} value={choice} onChange={(event) => setChoice(event.target.value)} aria-label="what the owner told you" />
        <ActionButton
          onRun={record}
          confirm="record this as what the owner told you? it is written to their ledger as an operator's entry, and they see it."
        >
          record the owner’s answer
        </ActionButton>
      </div>
    </li>
  );
}

const dollars = (cents) => (typeof cents === 'number' ? String(cents / 100) : '');
const toCents = (text) => (text.trim() === '' || Number.isNaN(Number(text)) ? null : Math.round(Number(text) * 100));

function Terms({ terms, tenant, reload }) {
  const [form, setForm] = useState({
    base: dollars(terms?.baseCents),
    perJob: dollars(terms?.perJobCents),
    cap: dollars(terms?.capCents),
    days: terms?.disputeWindowDays ? String(terms.disputeWindowDays) : '',
  });
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const ready = toCents(form.base) !== null && toCents(form.perJob) !== null && /^\d+$/.test(form.days.trim());

  const save = async () => {
    await recordPilotTerms(tenant.id, {
      baseCents: toCents(form.base),
      perJobCents: toCents(form.perJob),
      capCents: toCents(form.cap),
      disputeWindowDays: Number(form.days),
      replaces: terms?.id ?? null,
    });
    await reload();
    return 'recorded';
  };

  return (
    <Disclosure title="pilot terms" summary={terms ? `on record since ${formatStamp(terms.recordedAt, tenant.timezone)}` : 'none on record — no fee, and the owner is not asked'}>
      <p className="ops-muted">
        what the fee is worked out from: the monthly base, plus the fee for each job that counts, held at the cap. a
        change is a new row; the earlier terms stay on the record. the numbers live in this client’s event log and
        nowhere else.
      </p>
      <div className="ops-form">
        <Field label="monthly base ($)" required>
          <TextInput mono inputMode="decimal" value={form.base} onChange={set('base')} />
        </Field>
        <Field label="per job that counts ($)" required>
          <TextInput mono inputMode="decimal" value={form.perJob} onChange={set('perJob')} />
        </Field>
        <Field label="most a month can cost ($)" hint="leave empty for no cap">
          <TextInput mono inputMode="decimal" value={form.cap} onChange={set('cap')} />
        </Field>
        <Field label="days to dispute" required hint="counted from when the owner is first shown the question">
          <TextInput mono inputMode="numeric" value={form.days} onChange={set('days')} />
        </Field>
      </div>
      <ActionButton
        onRun={save}
        disabled={!ready}
        confirm="record these terms? this client’s fee is worked out from them from now on, and their owner starts being asked about past visits."
      >
        record the terms
      </ActionButton>
    </Disclosure>
  );
}

export default function LedgerPanel({ data, tenant, reload, readOnly = false }) {
  const ledger = data.ledger;
  if (!ledger) return null;

  const threads = data.threads ?? [];
  const disputes = threads.filter((lead) => lead.ledger?.answer?.id && (lead.ledger.status === 'disputed' || (lead.ledger.lateDispute && !lead.ledger.settlement)));
  const waiting = threads.filter((lead) => lead.ledger?.status === 'needs_owner');
  const pattern = disputePattern(ledger.disputes);
  const { totals, month } = ledger;

  return (
    <Panel title="proof ledger" note="what counts for this client, read off their event log">
      <dl className="ws-facts">
        <Fact label="counts" note="every step on record, and confirmed or past the window">
          <span className="mono">{formatCount(totals.billed)}</span>
        </Fact>
        <Fact label="disputed" note="the owner said it should not count, and nobody has settled it">
          <span className="mono">{formatCount(totals.disputed)}</span>
        </Fact>
        <Fact label="waiting on the owner" note="the visit has passed and nobody has answered">
          <span className="mono">{formatCount(totals.needs_owner)}</span>
        </Fact>
        <Fact label="handed to a person" note="never billed">
          <span className="mono">{formatCount(totals.handed_off)}</span>
        </Fact>
        <Fact label={`counted in ${month.label}`}>
          <span className="mono">{formatCount(month.billed)}</span>
        </Fact>
        <Fact label="fee owed this month" note={month.capped ? 'held at the cap' : undefined}>
          {month.feeCents === null ? dash('no pilot terms on record') : <span className="mono">{formatMoney(month.feeCents)}</span>}
        </Fact>
      </dl>

      {pattern.flagged ? (
        <Notice tone="warn" title="this owner disputes most of the good leads they answer about">
          {pattern.reason} {ledger.disputes.accepted} accepted, {ledger.disputes.rejected} rejected, {ledger.disputes.open} open,{' '}
          {ledger.disputes.late} after the window. either the leads are wrong or the answers are — look at the records before the next
          invoice conversation. this changes no status.
        </Notice>
      ) : (
        <p className="ops-muted">disputes: {pattern.reason}</p>
      )}

      <div className="ops-lr__sub">
        <b>disputes to settle</b>
      {disputes.length === 0 ? (
        <Empty title="no open disputes">when an owner says a job should not count, it lands here with their reason.</Empty>
      ) : (
        <ul className="ops-lr__list">
          {disputes.map((lead) =>
            readOnly ? (
              <li key={lead.id}>
                <b>{who(lead)}</b> · {disputeReasonWords(lead.ledger.answer.reason)}
              </li>
            ) : (
              <Dispute key={lead.id} lead={lead} tenant={tenant} reload={reload} />
            ),
          )}
        </ul>
      )}

      </div>

      <div className="ops-lr__sub">
        <b>waiting on the owner</b>
      {waiting.length === 0 ? (
        <p className="ops-muted">no visit is waiting for an answer.</p>
      ) : (
        <ul className="ops-lr__list">
          {waiting.map((lead) =>
            readOnly ? (
              <li key={lead.id}>
                <b>{who(lead)}</b> · visit {visit(lead, tenant.timezone)}
              </li>
            ) : (
              <Waiting key={lead.id} lead={lead} tenant={tenant} reload={reload} />
            ),
          )}
        </ul>
      )}
      {data.threadTotal > threads.length && (
        <p className="ops-muted">
          the lists show the newest {formatCount(threads.length)} of {formatCount(data.threadTotal)} leads. the counts above are over all of them.
        </p>
      )}

      </div>

      {!readOnly && <Terms terms={ledger.terms} tenant={tenant} reload={reload} />}
    </Panel>
  );
}
