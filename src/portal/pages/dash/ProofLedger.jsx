import { Link } from 'react-router-dom';
import { Panel, Pill } from '../../components/ui';
import { site } from '../../../data/site';
import './ProofLedger.css';

/**
 * ARC-MK-120 — the proof ledger: seven example leads, and why each one counts or does not.
 *
 * the demo's front page, and the one page here written for somebody who has never seen the
 * product. it explains a bill, not a machine: every lead shows the same seven lines in the
 * order they happened, then its status and the reason in a sentence.
 *
 * the page decides nothing. each lead arrives with its record and its verdict already read
 * off what happened to it (`demo/proof-ledger.js`); this only prints them. the rule and the
 * reasons a job can be disputed are the homepage's own (`site.price`), so the two cannot
 * drift apart.
 *
 * it says "example" in the heading, on every lead's label and in the note under the tally.
 * nothing on it is a client's lead and nothing on it is a measurement.
 */

const HELD_GLYPH = { true: '■', false: '□', null: '·' };
const HELD_WORD = { true: 'on record', false: 'missing', null: 'does not apply' };

/* one lead's card: the seven lines, then its status and the reason. exported because the
   jobs screen (ARC-MK-200) draws a client's own leads with the same card — `noun` is the
   only thing that differs, so an example can never be mistaken for a real lead. */
export function LedgerCard({ lead, index, total, noun = 'example' }) {
  const { verdict, record } = lead;
  const headingId = `pl-lead-${lead.key}`;

  return (
    <article className={`pl-lead pl-lead--${verdict.tone}`} aria-labelledby={headingId}>
      <header className="pl-lead__head">
        <p className="pl-lead__n">{noun} {index + 1} of {total}</p>
        <h3 className="pl-lead__title" id={headingId}>
          {lead.title}
        </h3>
        <Pill tone={verdict.tone}>{verdict.label}</Pill>
      </header>

      <dl className="pl-record">
        {record.map((line) => (
          <div className={`pl-record__row pl-record__row--${String(line.held)}`} key={line.label}>
            <dt>
              <i aria-hidden="true">{HELD_GLYPH[String(line.held)]}</i>
              {line.label}
              <span className="pl-sr"> ({HELD_WORD[String(line.held)]})</span>
            </dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>

      <p className="pl-lead__verdict">
        <strong>{verdict.label}.</strong> {verdict.reason}
      </p>
    </article>
  );
}

export default function ProofLedger({ data, base }) {
  const ledger = data.proofLedger;
  if (!ledger) return null;

  const { tally } = ledger;
  const { counts, disputeLead, disputeReasons } = site.price;

  return (
    <div className="pl">
      <Panel title="how to read this" note="example leads — not real customers">
        <p className="pl-rule">{counts}</p>
        <p className="pl-sub">
          below are seven example leads for a made-up heating and cooling company. each shows what
          is on record, in order, and why it counts or does not. a missing step is marked, never
          hidden.
        </p>

        <ul className="pl-tally" aria-label="the seven examples, by status">
          <li>
            <b>{tally.total}</b>
            <span>example leads</span>
          </li>
          <li>
            <b>{tally.counts}</b>
            <span>counts</span>
          </li>
          <li>
            <b>{tally.needsYou}</b>
            <span>waiting on you</span>
          </li>
          <li>
            <b>{tally.notBilled}</b>
            <span>shown, not billed</span>
          </li>
        </ul>

        <p className="pl-key" aria-hidden="true">
          <span>■ on record</span>
          <span>□ missing</span>
          <span>· does not apply</span>
        </p>
      </Panel>

      <div className="pl-leads">
        {ledger.leads.map((lead, index) => (
          <LedgerCard lead={lead} index={index} total={tally.total} key={lead.key} />
        ))}
      </div>

      <div className="ws-two">
        <Panel title="if you disagree with one">
          <p className="pl-sub">{disputeLead}</p>
          <ul className="pl-reasons">
            {disputeReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Panel>

        <Panel title="what this page is not">
          <p className="pl-sub">
            these seven are written examples. no step after the arrival shows a clock time: how
            fast the text goes out is a number we publish after it has been measured on a real
            phone line, not before.
          </p>
          <p className="pl-sub">
            the rest of this demo is the full portal over made-up data for the same company.{' '}
            <Link to={`${base}/overview`}>open the overview</Link>
          </p>
        </Panel>
      </div>
    </div>
  );
}
