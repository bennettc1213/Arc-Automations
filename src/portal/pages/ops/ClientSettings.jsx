import { Link, useParams, useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Empty } from '../../components/ui';
import ConfigEditor from '../../components/ConfigEditor';
import { moduleCatalog } from '../../../../supabase/functions/_shared/tenants/model.ts';

/**
 * ARC-310 — a client's settings, one tab per configuration scope.
 *
 * The first tab is the client-wide settings every module reads (company name, timezone); then
 * one per registered module that has a configuration schema. The tabs are read off the
 * registry, so a module that gains a schema gains a tab here without this page changing.
 * Each tab is a `ConfigEditor`: fields from the registry, a draft, a review, a publish, and the
 * version history — every rule of which is ARC-110's, on the server.
 *
 * A deboarded client's settings are read-only.
 */
export default function ClientSettings({ allClients, base }) {
  const { tenantId } = useParams();
  const [params, setParams] = useSearchParams();
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
  const tabs = [
    { key: 'tenant', label: 'client settings', scope: 'tenant', moduleKey: null },
    ...moduleCatalog()
      .filter((module) => module.configSchemaKey)
      .map((module) => ({ key: module.key, label: module.name, scope: 'module', moduleKey: module.key })),
  ];
  const active = tabs.find((tab) => tab.key === params.get('tab')) ?? tabs[0];

  return (
    <>
      <div className="ops-row" style={{ marginBottom: 12 }}>
        <Link className="ws-btn" to={`${base}/clients/${tenant.id}`}>
          <Icon name="back" size={13} />
          {tenant.name}
        </Link>
      </div>

      <nav className="cfg-tabs" aria-label="settings sections">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`ws-btn${tab.key === active.key ? ' ws-btn--primary' : ''}`}
            aria-pressed={tab.key === active.key}
            onClick={() => setParams({ tab: tab.key })}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <ConfigEditor
        key={active.key}
        tenantId={tenant.id}
        scope={active.scope}
        moduleKey={active.moduleKey}
        timezone={tenant.timezone}
        readOnly={tenant.status === 'archived'}
      />
    </>
  );
}
