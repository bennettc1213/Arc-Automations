import { getSupabase } from '../lib/supabase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const daysForDb = value => String(value || '').replace(/\u2013/g, '-');
const daysForUi = value => String(value || '').replace(/-/g, '\u2013');

export async function loadProduct(tenant) {
  const client = getSupabase();
  const [setup, campaigns, billing, form, readiness, pause] = await Promise.all([
    client.from('tenant_setup_answers').select('*').eq('tenant_id', tenant.id).maybeSingle(),
    client.from('customer_campaign_drafts').select('*').eq('tenant_id', tenant.id).order('updated_at', { ascending: false }),
    client.from('saas_billing_accounts').select('*').eq('tenant_id', tenant.id).maybeSingle(),
    client.rpc('self_service_form_status', { p_tenant: tenant.id }),
    client.rpc('self_service_readiness', { p_tenant: tenant.id }),
    client.from('owner_sending_pauses').select('paused,changed_at').eq('tenant_id', tenant.id).maybeSingle(),
  ]);
  if (setup.error || campaigns.error) return { available: false, error: (setup.error || campaigns.error).message };
  const usage = billing.data?.period_start ? await client.from('saas_usage_actions')
    .select('effect_key', { count: 'exact', head: true }).eq('tenant_id', tenant.id)
    .eq('period_start', billing.data.period_start) : null;
  const row = setup.data;
  return {
    available: true,
    billing: billing.error ? { available: false, error: billing.error.message }
      : { available: true, ...billing.data, used: usage?.error ? null : usage?.count ?? 0 },
    form: form.error ? { available: false, error: form.error.message }
      : { available: true, ...form.data },
    /* the owner's own pause (0035). no row means never paused; an error means the switch is
       not available on this account, and the page offers no button it could not honour. */
    sending: pause.error ? { available: false } : { available: true, paused: pause.data?.paused === true, changedAt: pause.data?.changed_at ?? null },
    /* what the database says is true right now (0033). absent means unknown, never "ready". */
    readiness: readiness.error || !readiness.data ? { available: false, error: readiness.error?.message || 'Readiness has not loaded' }
      : { available: true, ...readiness.data },
    setupRevision: row?.revision ?? null,
    step: row?.step ?? 0,
    business: row ? {
      name: tenant.name, timezone: tenant.timezone, trade: row.business_type,
      services: (row.services || []).join(', '), area: (row.service_area || []).join(', '),
      days: daysForUi(row.working_days), open: String(row.opens_at).slice(0, 5),
      close: String(row.closes_at).slice(0, 5),
      alerts: row.handoff === 'inbox_and_text' ? 'Inbox and owner text' : 'Inbox only',
      ownerPhone: row.owner_phone || '',
    } : null,
    campaigns: (campaigns.data || []).map(row => ({ ...row.config, id: row.id, tenantId: tenant.id,
      kind: row.kind, revision: row.revision,
      /* live: this saved version is what ARC sends. live_edited: an earlier version of it is,
         and the edits since are not. a database from before 0034 has neither column. */
      runtime: row.published_revision == null ? 'draft' : row.published_revision === row.revision ? 'live' : 'live_edited',
      publishedAt: row.published_at ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at })),
  };
}

export async function configureForm(tenantId, origin) {
  const { data, error } = await getSupabase().rpc('self_service_configure_form',
    { p_tenant: tenantId, p_origin: origin });
  if (error) throw error;
  return data;
}

export async function billingSession(tenantId, action) {
  const { data, error } = await getSupabase().functions.invoke('billing', {
    body: { tenant_id: tenantId, action },
  });
  if (error || !data?.url) throw new Error(data?.error || error?.message || 'Billing session unavailable');
  return data.url;
}

export async function loadLeadRecovery(tenantId) {
  const client = getSupabase();
  const [leads, conversations, messages, handoffs] = await Promise.all([
    client.from('leads').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(500),
    client.from('conversations').select('*').eq('tenant_id', tenantId).limit(500),
    client.from('messages').select('*').eq('tenant_id', tenantId).order('occurred_at', { ascending: false }).limit(1000),
    client.from('handoffs').select('*').eq('tenant_id', tenantId).order('opened_at', { ascending: false }).limit(500),
  ]);
  const error = [leads, conversations, messages, handoffs].find(result => result.error)?.error;
  if (error) return { available: false, error: error.message, leads: [], conversations: [], messages: [], handoffs: [] };
  return { available: true, error: null, leads: leads.data || [], conversations: conversations.data || [],
    messages: messages.data || [], handoffs: handoffs.data || [] };
}

export async function saveBusiness(tenantId, revision, business, step) {
  const { data, error } = await getSupabase().rpc('self_service_save_setup', {
    p_tenant: tenantId, p_expected: revision,
    p_business: { ...business, days: daysForDb(business.days) }, p_step: step,
  });
  if (error) throw error;
  return data;
}

/* switching a campaign on (0034). the server reads the words from the saved campaign, so
   these send only which campaign and which versions the owner was looking at. */
async function campaignAction(action, tenantId, body) {
  const { data, error } = await getSupabase().functions.invoke('crm', { body: { action, tenant_id: tenantId, ...body } });
  let answer = data;
  /* supabase-js puts a non-2xx body on the error's response rather than in `data`. */
  if (error && !answer && typeof error.context?.json === 'function') {
    try { answer = await error.context.json(); } catch { answer = null; }
  }
  if (!answer?.ok) {
    const failure = new Error(answer?.error || 'This could not be done just now. Nothing was changed.');
    failure.code = answer?.code || null;
    failure.problems = answer?.problems || [];
    failure.preview = answer?.preview || null;
    throw failure;
  }
  return answer;
}

/** pause or resume ARC's texts to this business's customers. the owner's own switch (0035). */
export async function setSendingPaused(tenantId, paused) {
  const { data, error } = await getSupabase().rpc('self_service_set_sending_pause', { p_tenant: tenantId, p_paused: paused });
  if (error) throw error;
  return data;
}

export async function previewCampaign(tenantId, campaignId) {
  return (await campaignAction('campaign-preview', tenantId, { campaign_id: campaignId })).preview;
}

export async function publishCampaign(tenantId, preview) {
  return await campaignAction('campaign-publish', tenantId, {
    campaign_id: preview.campaign_id, expected_revision: preview.revision, expected_version: preview.version,
  });
}

export async function saveCampaign(tenantId, campaign) {
  const existing = UUID.test(campaign.id) ? campaign.id : null;
  const { data, error } = await getSupabase().rpc('self_service_save_campaign', {
    p_tenant: tenantId, p_id: existing, p_expected: existing ? campaign.revision : 0,
    /* `publishedAt` is this page's own note about the row; the save function takes a closed
       list of campaign fields and it is not one. */
    p_config: Object.fromEntries(Object.entries(campaign).filter(([key]) => key !== 'publishedAt')),
  });
  if (error) throw error;
  return data;
}
