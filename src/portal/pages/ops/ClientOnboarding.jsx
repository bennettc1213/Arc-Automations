import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty } from '../../components/ui';
import OnboardingPanel from '../../components/OnboardingPanel';

/**
 * ARC-390 — putting one client on a route: what they have today, who provides each thing a
 * business does, where each kind of record is kept, and what is still missing before the
 * hand-over to activation.
 *
 * A deboarded client's page is read-only: what was decided is shown, and nothing can be
 * saved, applied or set up.
 */
export default function ClientOnboarding({ allClients, base }) {
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
      <OnboardingPanel tenantId={tenant.id} base={base} timezone={tenant.timezone} readOnly={tenant.status === 'archived'} />
    </>
  );
}
