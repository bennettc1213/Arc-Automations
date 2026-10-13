/** `CampaignStore` over the service-role client. Reads two tables and calls one function. */

import type { CampaignRow, CampaignStore } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = any;

export function supabaseCampaignStore(db: Db): CampaignStore {
  return {
    async getCampaign(tenantId, campaignId) {
      const { data, error } = await db.from('customer_campaign_drafts')
        .select('id,tenant_id,kind,revision,config,published_revision,published_version')
        .eq('tenant_id', tenantId).eq('id', campaignId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const row: CampaignRow = {
        id: data.id, tenantId: data.tenant_id, kind: data.kind, revision: Number(data.revision),
        config: data.config ?? {},
        publishedRevision: data.published_revision == null ? null : Number(data.published_revision),
        publishedVersion: data.published_version == null ? null : Number(data.published_version),
      };
      return row;
    },
    async markPublished({ tenantId, campaignId, revision, version, actorId }) {
      const { error } = await db.rpc('self_service_mark_campaign_published', {
        p_tenant: tenantId, p_campaign: campaignId, p_revision: revision, p_version: version, p_actor: actorId,
      });
      if (error) throw new Error(error.message);
    },
    async moduleState(tenantId) {
      const { data, error } = await db.from('tenant_modules')
        .select('state,pending_requirements').eq('tenant_id', tenantId).eq('module_key', 'lead_recovery').maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { state: String(data.state), pending: data.pending_requirements ?? [] } : null;
    },
  };
}
