import { useMemo } from 'react';
import CrmWorkspace from '../../components/CrmWorkspace';
import { crmApi } from '../../lib/crm';
import { demoCrmApi } from '../../demo/crm-demo';

/**
 * ARC-360 — the lead inbox: the business's own leads, worked from here.
 *
 * the one page in this workspace that is not read off the event log, and says so: these are
 * the records the team keeps — who owns a lead, what stage it is in, what is due — not proof
 * of what happened. the proof stays on lead capture and reports.
 *
 * signed in, it goes through the `crm` function as the person signed in. the demo draws the
 * same component over generated leads, read-only.
 */
export default function Inbox({ data, live }) {
  const api = useMemo(() => (live ? crmApi('crm', data.tenant.id) : demoCrmApi()), [live, data.tenant.id]);
  return <CrmWorkspace api={api} timezone={data.tenant.timezone} />;
}
