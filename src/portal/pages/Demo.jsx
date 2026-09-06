import { Link } from 'react-router-dom';
import PortalShell from '../components/PortalShell';
import Dashboard from '../components/Dashboard';
import demoData from '../demo/demo-data.json';

/**
 * the public demo.
 *
 * renders the same Dashboard component the signed-in route does, against
 * generated data for a fictional restoration company. the banner says so
 * plainly and permanently — a demo that lets a visitor believe these are real
 * client numbers is fabricated social proof, which is the one unrecoverable
 * mistake for a product sold on "only numbers we can prove".
 *
 * the headline uses the rolling 30-day figure rather than the calendar month.
 * a calendar month reads as near-zero for the first days of every month, which
 * is honest for a client looking at their own account and misleading on a
 * public page.
 */
export default function Demo() {
  return (
    <PortalShell tenantName={demoData.tenant.name}>
      <Dashboard
        data={demoData}
        live={false}
        leadWindow="rolling30"
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
    </PortalShell>
  );
}
