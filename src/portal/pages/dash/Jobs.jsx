import { Link, useSearchParams } from 'react-router-dom';
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
 *
 * since ARC-MK-230 each card also shows what arc asked and who it told (`lib/handling.js`),
 * and the list can be narrowed to missed calls or website requests.
 */
/* which way the lead came in (ARC-MK-230). the two ways the offer names, and everything. */
const WAYS = [
  { key: 'all', label: 'all' },
  { key: 'missed_call', label: 'missed calls' },
  { key: 'web_form', label: 'website requests' },
];

export default function Jobs(props) {
  if (props.data.proofLedger) return <ProofLedger {...props} />;
  return <OwnJobs {...props} />;
}

function OwnJobs({ data, base }) {
  const { jobs: every, tally, of } = ownerJobs(data);

  /* in the address, so "see these jobs" on this month can open the list already narrowed. */
  const [params, setParams] = useSearchParams();
  const asked = params.get('from');
  const way = WAYS.some((option) => option.key === asked) ? asked : 'all';
  const jobs = way === 'all' ? every : every.filter((job) => job.source === way);
  const choose = (key) => {
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('from');
    else next.set('from', key);
    setParams(next, { replace: true });
  };

  return (
    <div className="pl">
      <Panel title="how to read this" note="your leads, from the record">
        <p className="pl-rule">{site.price.counts}</p>
        <p className="pl-sub">
          each lead below shows what is on record, in order, and why it counts or does not. a
          missing step is marked, never hidden. a job counts only when every step is there.
        </p>
        <p className="pl-sub">
          under those steps is what arc asked and who it told: how long the text took, what the
          customer needs, where they are and how soon. none of that decides whether a job
          counts — it is there so you know the job before you call back.
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

      {every.length > 0 && (
        <div className="pl-filter" role="group" aria-label="show leads by how they came in">
          {WAYS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`ws-chip${way === option.key ? ' is-on' : ''}`}
              aria-pressed={way === option.key}
              onClick={() => choose(option.key)}
            >
              {option.label} ·{' '}
              {formatCount(option.key === 'all' ? every.length : every.filter((job) => job.source === option.key).length)}
            </button>
          ))}
        </div>
      )}

      {every.length === 0 ? (
        <Panel>
          <Empty title="no leads yet">
            the first call your line misses will appear here, step by step.
          </Empty>
        </Panel>
      ) : jobs.length === 0 ? (
        <Panel>
          <Empty title="none came in that way">
            {way === 'web_form'
              ? 'no website request is on record. one can only arrive once the request form is on your website.'
              : 'no missed call is on record yet.'}
          </Empty>
        </Panel>
      ) : (
        <div className="pl-leads">
          {jobs.map((job, index) => (
            <LedgerCard lead={job} index={index} total={jobs.length} noun="lead" timezone={data.tenant?.timezone ?? 'UTC'} key={job.key} />
          ))}
        </div>
      )}

      {of > every.length && (
        <p className="pl-sub">
          showing the newest {formatCount(every.length)} of {formatCount(of)}.{' '}
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
