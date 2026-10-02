import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty } from '../../components/ui';
import ActivationPanel from '../../components/ActivationPanel';
import { moduleCatalog } from '../../../../supabase/functions/_shared/tenants/model.ts';

/**
 * ARC-320 — one client's modules on their way to live: connections, readiness, tests,
 * activation, pause and resume, one tab per module the registry lets a client have.
 *
 * The module is in the path, not a query string, because this page is also where an OAuth
 * authorisation returns to — and ARC-130 accepts a return path, never a query (oauth.ts).
 * A deboarded client's page is read-only: everything is shown, nothing can be pressed.
 */
export default function ClientActivation({ allClients, base }) {
  const { tenantId, moduleKey } = useParams();
  const client = allClients.find((entry) => entry.tenant.id === tenantId);

  if (!client) {
    return (
      <Empty title="no such client">
        that account is not in the roster.{' '}
        <Link className="ops-inline-link" to={`${base}/clients`}>
          back to the list
        </Link>
        .
      </Empty>
    );
  }

  const { tenant } = client;
  const modules = moduleCatalog().filter((module) => module.selectable);
  const active = modules.find((module) => module.key === moduleKey) ?? modules[0];

  return (
    <>
      <div className="ops-row" style={{ marginBottom: 12 }}>
        <Link className="ws-btn" to={`${base}/clients/${tenant.id}`}>
          <Icon name="back" size={13} />
          {tenant.name}
        </Link>
        <Link className="ws-btn" to={`${base}/clients/${tenant.id}/settings${active ? `?tab=${active.key}` : ''}`}>
          <Icon name="edit" size={13} />
          settings
        </Link>
      </div>

      {modules.length > 1 && (
        <nav className="cfg-tabs" aria-label="modules">
          {modules.map((module) => (
            <Link
              key={module.key}
              className={`ws-btn${module.key === active.key ? ' ws-btn--primary' : ''}`}
              aria-current={module.key === active.key ? 'page' : undefined}
              to={`${base}/clients/${tenant.id}/activation/${module.key}`}
            >
              {module.name}
            </Link>
          ))}
        </nav>
      )}

      {active ? (
        <ActivationPanel
          key={active.key}
          tenantId={tenant.id}
          moduleKey={active.key}
          timezone={tenant.timezone}
          readOnly={tenant.status === 'archived'}
          returnPath={`${base}/clients/${tenant.id}/activation/${active.key}`}
        />
      ) : (
        <Empty title="no module can be given to a client yet">the registry has no selectable module.</Empty>
      )}
    </>
  );
}
