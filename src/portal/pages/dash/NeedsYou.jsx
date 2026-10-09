import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { Link } from 'react-router-dom';
import { Empty, Panel, Pill } from '../../components/ui';
import { site } from '../../../data/site';
import { isNotDeployed, ledgerApi } from '../../lib/crm';
import { formatRelative } from '../../lib/format';
import { disputeReasonWords } from '../../lib/ledger';
import { ownerNeeds } from '../../lib/owner';
import { OWNER_ANSWERS } from '../../../../supabase/functions/_shared/ledger/model.ts';
import './Owner.css';

/**
 * ARC-MK-200 — needs you: what do I have to do?
 *
 * everything waiting on the owner, in four kinds: an outcome question for a visit whose
 * time has passed, a customer who wrote back and has no visit on record yet (ARC-GO-310 —
 * the owner puts the agreed time in here, which is what lets the job count), a lead arc
 * stopped on and handed to a person, and anything that did not go the usual way. the list is derived on every read (`ownerNeeds`) — nothing is stored,
 * so nothing here can go stale.
 *
 * ARC-MK-220 — the question is answered here, with one tap. the six answers are the
 * ledger's own list (`OWNER_ANSWERS`), and the tap goes to the `ledger` function, which
 * reads who is answering off the sign-in and appends one row of evidence. this page decides
 * nothing: after the tap it reloads, and the job's status is whatever the ledger's rule then
 * reads. an answer given in the last day can be changed from the same screen; the earlier
 * one stays on the record.
 *
 * a signed-in account whose answers cannot be recorded yet is told so and given the mailbox,
 * and the demo's buttons say what the tap would do and save nothing — no button here does
 * nothing, and none pretends.
 */

const KIND_TONE = { outcome: 'warn', visit: 'warn', handoff: 'fail', other: 'neutral' };

/* what the owner is told before the tap. words only: whether it counts is the ledger's. */
const WHAT_HAPPENS = {
  true: 'this job counts.',
  false: 'this job is not billed while we look at what you said.',
};

/**
 * the six answers for one booked visit. an answer with more than one reason asks which
 * before anything is sent. `send` resolves to the sentence shown afterwards, or throws.
 */
function AnswerButtons({ send, lead, changing = false }) {
  const [picked, setPicked] = useState(null);
  const [state, setState] = useState({ kind: 'idle' });
  const busy = state.kind === 'busy';

  async function submit(answer, reason = null) {
    setState({ kind: 'busy' });
    try {
      const message = await send(answer, reason);
      setState({ kind: 'done', message });
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }

  if (state.kind === 'done') {
    return (
      <p className="ow-answer__done" role="status">
        {state.message}
      </p>
    );
  }

  return (
    <div className="ow-answer">
      <p className="ow-answer__ask" id={`ask-${lead}`}>
        {changing ? 'what should it say instead?' : 'did the job happen?'}
      </p>
      <div className="ow-answer__choices" role="group" aria-labelledby={`ask-${lead}`}>
        {OWNER_ANSWERS.map((answer) => (
          <button
            type="button"
            key={answer.key}
            className={`ws-btn ow-tap${picked?.key === answer.key ? ' ws-btn--primary' : ''}`}
            disabled={busy}
            aria-pressed={answer.reasons.length > 1 ? picked?.key === answer.key : undefined}
            onClick={() => (answer.reasons.length > 1 ? setPicked(answer) : submit(answer))}
          >
            {answer.label}
          </button>
        ))}
      </div>

      {picked && (
        <div className="ow-answer__choices" role="group" aria-label={`${picked.label} — which one?`}>
          {picked.reasons.map((reason) => (
            <button type="button" key={reason} className="ws-btn ow-tap" disabled={busy} onClick={() => submit(picked, reason)}>
              {disputeReasonWords(reason)}
            </button>
          ))}
        </div>
      )}

      <p className="ow-answer__note">
        the first two count. any other answer means the job is not billed while we look at it.
      </p>
      {busy && <p className="ow-answer__note" role="status">recording your answer…</p>}
      {state.kind === 'error' && (
        <p className="ow-answer__error" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * ARC-GO-310 — "we agreed a visit for tuesday at two". a date, a time and one button.
 *
 * the time typed is the business's own clock, whatever the phone's is set to: it is read in
 * the business's timezone and sent as an instant. the page decides nothing — whether the
 * time is acceptable is the server's, and after the tap it reloads.
 */
function VisitForm({ send, lead, timezone }) {
  const [when, setWhen] = useState('');
  const [state, setState] = useState({ kind: 'idle' });
  const busy = state.kind === 'busy';

  async function submit(event) {
    event.preventDefault();
    const at = DateTime.fromISO(when, { zone: timezone });
    if (!when || !at.isValid) {
      setState({ kind: 'error', message: 'pick the day and the time of the visit first.' });
      return;
    }
    setState({ kind: 'busy' });
    try {
      const message = await send(at.toUTC().toISO());
      setState({ kind: 'done', message });
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }

  if (state.kind === 'done') {
    return (
      <p className="ow-answer__done" role="status">
        {state.message}
      </p>
    );
  }

  return (
    <form className="ow-answer" onSubmit={submit}>
      <label className="ow-answer__ask" htmlFor={`visit-${lead}`}>
        when is the visit?
      </label>
      <input
        id={`visit-${lead}`}
        className="ow-visit__when"
        type="datetime-local"
        value={when}
        disabled={busy}
        onChange={(event) => setWhen(event.target.value)}
      />
      <button type="submit" className="ws-btn ws-btn--primary ow-tap" disabled={busy}>
        save the visit time
      </button>
      <p className="ow-answer__note">
        arc stops texting this customer once a visit is saved. after the visit, we ask you one question: did the job happen?
      </p>
      {busy && <p className="ow-answer__note" role="status">saving the visit…</p>}
      {state.kind === 'error' && (
        <p className="ow-answer__error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

export default function NeedsYou({ data, base, live, onChanged }) {
  const needs = ownerNeeds(data);
  const tz = data.tenant?.timezone ?? 'UTC';
  const subject = encodeURIComponent(`an answer for arc — ${data.tenant?.name ?? ''}`);
  const tenantId = data.tenant?.id ?? null;
  /* a signed-in account can answer; the demo and a preview say what a tap would do. */
  const canWrite = Boolean(live && !needs.example && tenantId);
  const [off, setOff] = useState(false);

  /* showing the question to a signed-in person is the asking. said once per lead, and the
     server refuses it until there are terms on record and the visit has passed. a failure
     here costs nothing: the question is still on the screen. */
  const unaskedKey = needs.groups
    .flatMap((group) => group.items)
    .filter((item) => item.kind === 'outcome' && item.lead && !item.asked)
    .map((item) => item.lead)
    .join('|');
  const hasTerms = Boolean(data.ledger?.terms);
  useEffect(() => {
    if (!canWrite || !hasTerms || unaskedKey === '') return undefined;
    let cancelled = false;
    ledgerApi(tenantId)
      .asked(unaskedKey.split('|'))
      .then((result) => {
        if (!cancelled && result?.asked > 0) onChanged?.();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canWrite, hasTerms, unaskedKey, tenantId, onChanged]);

  const sender = (item) => async (answer, reason) => {
    if (!canWrite) {
      const what = needs.example ? 'an example' : 'a preview';
      return `this is ${what}, so nothing was saved. on your own account that tap is recorded, and ${WHAT_HAPPENS[answer.counts]}`;
    }
    try {
      await ledgerApi(tenantId).answer(item.lead, { answer: answer.key, reason, replaces: item.replaces });
    } catch (error) {
      if (isNotDeployed(error)) {
        setOff(true);
        throw new Error('answering from this screen is not switched on for your account yet. email your answer and we record it for you.');
      }
      throw error;
    }
    /* the reload is what changes the screen: the status is read off the log again. */
    await onChanged?.();
    return `recorded. ${WHAT_HAPPENS[answer.counts]}`;
  };

  const visitSender = (item) => async (appointmentAt) => {
    if (!canWrite) {
      const what = needs.example ? 'an example' : 'a preview';
      return `this is ${what}, so nothing was saved. on your own account the visit time is recorded, and arc stops texting that customer.`;
    }
    try {
      await ledgerApi(tenantId).visit(item.lead, appointmentAt);
    } catch (error) {
      if (isNotDeployed(error)) {
        setOff(true);
        throw new Error('saving a visit from this screen is not switched on for your account yet. email us the time and we record it for you.');
      }
      throw error;
    }
    await onChanged?.();
    return 'saved. after the visit, we ask you whether the job happened.';
  };

  if (needs.total === 0 && needs.answered.length === 0) {
    return (
      <div className="ow">
        <Panel>
          <Empty title="nothing needs you">
            every lead is either handled or still moving on its own. this list fills itself
            when that changes.
          </Empty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="ow">
      {needs.example && <p className="ow-example">example leads for a made-up company.</p>}

      {needs.groups.map((group) => (
        <Panel title={group.label} note={`${group.items.length} waiting`} key={group.key}>
          <p className="ow-sub">{group.blurb}</p>
          <ul className="ow-needs">
            {group.items.map((item) => (
              <li key={item.key} className={`ow-need ow-need--${group.key}`}>
                <div className="ow-need__head">
                  <Pill tone={KIND_TONE[group.key]}>{group.label}</Pill>
                  {item.openedAt && <span className="ow-need__age mono">{formatRelative(item.openedAt, tz)}</span>}
                </div>
                <p className="ow-need__title">{item.title}</p>
                {item.detail && <p className="ow-need__detail">{item.detail}</p>}
                <p className="ow-need__reason">{item.reason}</p>
                {item.countsAt && (
                  <p className="ow-need__reason">if nobody answers, it counts by itself after {item.countsAt}.</p>
                )}
                {group.key === 'outcome' && <AnswerButtons send={sender(item)} lead={item.key} />}
                {group.key === 'visit' && <VisitForm send={visitSender(item)} lead={item.key} timezone={tz} />}
                {item.to && (
                  <Link className="ws-btn ow-tap" to={`${base}/${item.to}`}>
                    see the record
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ))}

      {needs.answered.length > 0 && (
        <Panel title="you answered" note="in the last day">
          <p className="ow-sub">a wrong tap can be put right here. the earlier answer stays on the record.</p>
          <ul className="ow-needs">
            {needs.answered.map((item) => (
              <li key={item.key} className="ow-need">
                <p className="ow-need__title">{item.title}</p>
                {item.detail && <p className="ow-need__detail">{item.detail}</p>}
                <p className="ow-need__reason">
                  you said {item.said}. it reads “{item.status}”.
                </p>
                <details className="ow-answer__change">
                  <summary className="ws-btn ow-tap">change my answer</summary>
                  <AnswerButtons send={sender(item)} lead={item.key} changing />
                </details>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(off || (!canWrite && !needs.example)) && (
        <Panel title="how to answer">
          <p className="ow-sub">
            answering from this screen is not switched on for this account yet. for now, tell us
            and we record it for you — the lead stays here until it is settled.
          </p>
          <a className="ws-btn ws-btn--primary ow-tap" href={`mailto:${site.email}?subject=${subject}`}>
            email your answer
          </a>
        </Panel>
      )}
    </div>
  );
}
