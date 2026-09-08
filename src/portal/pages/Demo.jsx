import { Link } from 'react-router-dom';
import Workspace from '../components/Workspace';
import demoData from '../demo/demo-data.json';

/**
 * the public demo.
 *
 * renders the same Workspace the signed-in route does, against generated data for a
 * fictional restoration company. every page, every filter, every export works — it is the
 * product, pointed at a different dataset.
 *
 * the banner says so plainly and permanently. a demo that lets a visitor believe these are
 * real client numbers is fabricated social proof, which is the one unrecoverable mistake for
 * a product sold on "only numbers we can prove".
 */
export default function Demo() {
  return (
    <Workspace
      data={demoData}
      base="/demo"
      live={false}
      banner={
        <div className="pt-banner">
          <span className="pt-banner__tag">demo</span>
          <p>
            generated data for a fictional company. this is the real portal running the real
            metric code — no client's numbers appear here.{' '}
            <Link to="/login" style={{ color: 'var(--accent)' }}>
              sign in to yours
            </Link>
          </p>
        </div>
      }
    />
  );
}
