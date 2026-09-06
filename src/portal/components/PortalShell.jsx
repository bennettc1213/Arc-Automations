import { Link } from 'react-router-dom';

/**
 * the frame every portal surface renders inside.
 *
 * minimal on purpose: the header names whose data this is and then gets out of
 * the way. at this density there is no room for chrome that does not report
 * something.
 */
export default function PortalShell({ tenantName, onSignOut, children }) {
  return (
    <div className="portal">
      <header className="pt-head">
        <div className="pt-head__in">
          <Link to="/" className="pt-head__mark">
            arc<b>.</b>portal
          </Link>

          {tenantName && (
            <>
              <span className="pt-head__sep" aria-hidden="true" />
              <span className="pt-head__tenant">{tenantName}</span>
            </>
          )}

          <div className="pt-head__right">
            {onSignOut && (
              <button type="button" className="pt-head__link" onClick={onSignOut}>
                sign out
              </button>
            )}
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
