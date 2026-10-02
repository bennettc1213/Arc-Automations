import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty } from '../../components/ui';
import IntakePanel from '../../components/IntakePanel';

/**
 * ARC-350 — one client's lead capture: their forms, a lead typed in, a file imported, the
 * endpoints their own systems post to, and what has arrived.
 *
 * A deboarded client's page is read-only: what was collected is shown, and nothing can be
 * made, published or imported.
 */
export default function ClientIntake({ allClients, base }) {
  const { tenantId } = useParams();
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
  return (
    <>
      <div className="ops-row" style={{ marginBottom: 12 }}>
        <Link className="ws-btn" to={`${base}/clients/${tenant.id}`}>
          <Icon name="back" size={13} />
          {tenant.name}
        </Link>
      </div>
      <IntakePanel tenantId={tenant.id} timezone={tenant.timezone} readOnly={tenant.status === 'archived'} />
    </>
  );
}
