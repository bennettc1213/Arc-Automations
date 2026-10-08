import { Link } from 'react-router-dom';
import ProofLedger, { LedgerCard } from './ProofLedger';
import { Empty, Panel } from '../../components/ui';
import { site } from '../../../data/site';
import { formatCount } from '../../lib/format';
import { ownerJobs } from '../../lib/owner';
import './ProofLedger.css';
import './Owner.css';

/**
 * ARC-MK-200 — jobs: prove it.
 *
 * one card per lead, the same seven lines in the order they happened, then the status and
 * the reason. where the workspace was handed a proof ledger (the demo) this is that page,
 * unchanged. otherwise it is the client's own leads from the event log, drawn with the same
 * card, each with the status the ledger's rule gave it (ARC-MK-210) and the reason. the page
 * decides nothing: a lead counts here only because `ledger.js` found every link on record.
 */
export default function Jobs(props) {
  const { data, base } = props;
  if (data.proofLedger) return <ProofLedger {...props} />;

  const { jobs, tally, of } = ownerJobs(data);

  return (
    <div className="pl">
      <Panel title="how to read this" note="your leads, from the record">
        <p className="pl-rule">{site.price.counts}</p>
        <p className="pl-sub">
          each lead below shows what is on record, in order, and why it counts or does not. a
          missing step is marked, never hidden. a job counts only when every step is there.
        </p>

        <ul className="pl-tally" aria-label="your leads, by status">
          <li>
            <b>{formatCount(of)}</b>
            <span>leads on record</span>
          </li>
          <li>
            <b>{formatCount(tally.counts)}</b>
            <span>counts</span>
          </li>
          <li>
            <b>{formatCount(tally.needsYou)}</b>
            <span>waiting on you</span>
          </li>
          <li>
            <b>{formatCount(tally.notBilled)}</b>
            <span>shown, not billed</span>
          </li>
        </ul>

        <p className="pl-key" aria-hidden="true">
          <span>■ on record</span>
          <span>□ missing</span>
          <span>· does not apply</span>
        </p>
      </Panel>

      {jobs.length === 0 ? (
        <Panel>
          <Empty title="no leads yet">
            the first call your line misses will appear here, step by step.
          </Empty>
        </Panel>
      ) : (
        <div className="pl-leads">
          {jobs.map((job, index) => (
            <LedgerCard lead={job} index={index} total={jobs.length} noun="lead" key={job.key} />
          ))}
        </div>
      )}

      {of > jobs.length && (
        <p className="pl-sub">
          showing the newest {formatCount(jobs.length)} of {formatCount(of)}.{' '}
          <Link to={`${base}/leads`}>see every lead</Link>
        </p>
      )}

      <Panel title="if you disagree with one">
        <p className="pl-sub">{site.price.disputeLead}</p>
        <ul className="pl-reasons">
          {site.price.disputeReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
