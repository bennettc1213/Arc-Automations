import { Link } from 'react-router-dom';
import Workspace from '../components/Workspace';
import demoData from '../demo/demo-data.json';
import { buildProofLedger } from '../demo/proof-ledger';

/**
 * the public demo.
 *
 * opens on the proof ledger (ARC-MK-120): seven written example leads for a fictional
 * heating and cooling company, each showing why it counts or does not. behind it is the
 * same Workspace the signed-in route renders, against generated data for the same company
 * — every page, every filter, every export works. it is the product, pointed at a
 * different dataset.
 *
 * the banner says so plainly and permanently. a demo that lets a visitor believe these are
 * real client numbers is fabricated social proof, which is the one unrecoverable mistake for
 * a product sold on "only numbers we can prove".
 */

/* built once: the seven are the same on every visit. the ledger rides beside the generated
   dashboard rather than inside it, because it is not derived from the generated events. */
const data = { ...demoData, proofLedger: buildProofLedger() };

export default function Demo() {
  return (
    <Workspace
      data={data}
      base="/demo"
      live={false}
      banner={
        <div className="pt-banner">
          <span className="pt-banner__tag">demo</span>
          <p>
            example data for a made-up heating and cooling company. no client's leads or
            numbers appear here.{' '}
            <Link to="/login" style={{ color: 'var(--accent)' }}>
              sign in to yours
            </Link>
          </p>
        </div>
      }
    />
  );
}
