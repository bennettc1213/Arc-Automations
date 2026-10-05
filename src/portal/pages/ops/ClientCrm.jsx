import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty } from '../../components/ui';
import CrmWorkspace from '../../components/CrmWorkspace';
import { crmApi } from '../../lib/crm';

/**
 * ARC-360 — one client's lead inbox and pipeline, as an operator: the same workspace the
 * client's own team uses, through `ops`, with the operator as the actor in every history entry.
 *
 * A deboarded client's workspace is read-only.
 */
export default function ClientCrm({ allClients, base }) {
  const { tenantId } = useParams();
  const client = allClients.find((entry) => entry.tenant.id === tenantId);
  const api = useMemo(() => crmApi('ops', tenantId), [tenantId]);

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
      <CrmWorkspace api={api} timezone={tenant.timezone} readOnly={tenant.status === 'archived'} />
    </>
  );
}
