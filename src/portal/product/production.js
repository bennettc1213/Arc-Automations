import { blankBusiness } from './model.js';

const OUTCOMES = { qualified: 'Qualified', needs_info: 'Needs Information', out_of_area: 'Outside Service Area',
  unsupported_service: 'Unsupported Service', human_review: 'Needs Owner Review' };

function projectLead(tenantId, thread, row, runtime) {
  const q = thread?.qualification;
  const outcome = OUTCOMES[q?.outcome] || (row?.status === 'qualified' ? 'Qualified'
    : row?.status === 'handoff_required' || row?.status === 'handed_off' ? 'Needs Owner Review'
      : q?.outcome?.replaceAll('_', ' ') || 'Unknown');
  const conversation = runtime?.conversations?.find(item => item.lead_id === row?.id);
  const messages = (runtime?.messages || []).filter(item => item.conversation_id === conversation?.id)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map(item => ({ id: item.id, author: item.direction === 'inbound' ? 'Customer' : 'ARC automation',
      body: item.body || '', state: item.status, at: item.occurred_at }));
  const handoff = runtime?.handoffs?.find(item => item.lead_id === row?.id && item.status === 'open');
  const evidence = row?.permission_evidence;
  const permission = row?.consent_sms && evidence?.affirmative === true
    ? { evidence: `${evidence.disclosure_version || 'Recorded disclosure'} · ${evidence.source || 'form'}`,
      channel: 'sms', scopes: ['inquiry'], capturedAt: row.consent_at }
    : row?.consent_sms && row?.consent_source === 'inbound_call'
      ? { evidence: 'Called this business and was not answered', channel: 'sms', scopes: ['inquiry'], capturedAt: row.consent_at }
      : null;
  const id = row?.id || thread?.id;
  const started = row?.created_at || thread?.startedAt;
  return { id, tenantId, createdAt: started, name: row?.customer_name || thread?.name || 'Unknown contact',
    phone: row?.phone || thread?.phone || null, service: row?.service_request || q?.jobType || thread?.lossType || null,
    source: (row?.source || thread?.source) === 'missed_call' ? 'phone' : (row?.source || thread?.source) === 'web_form' ? 'form' : row?.source || thread?.source || 'unknown',
    state: row?.status || thread?.state || 'unknown', qualification: outcome,
    qualificationReason: q ? `Recorded qualification: ${outcome}. ${q.inServiceArea === false ? 'The supplied location was outside the service area.' : q.inServiceArea === true ? 'The supplied location was in the service area.' : 'Area fit is unknown.'}` : 'No qualification answer recorded.',
    permission, suppressed: row?.status === 'suppressed' || Boolean(thread?.suppressionReason),
    deliveryFailed: Boolean(thread?.deliveryFailed || messages.some(item => ['undelivered', 'failed'].includes(item.state))),
    answers: Object.fromEntries(Object.entries({ service: q?.jobType, location: q?.zip || row?.location_zip,
      urgency: q?.urgency || row?.urgency, timing: q?.preferredTime }).filter(([, value]) => value)),
    campaignId: null, needsOwner: Boolean(handoff || thread?.handoff && !thread.handoff.resolvedAt || thread?.unacknowledged),
    ownerTakeover: row?.status === 'handed_off', handoffReason: handoff?.reason || null,
    lastActivity: messages.at(-1)?.at || row?.updated_at || thread?.steps?.at(-1)?.at || started,
    messages, steps: thread?.steps || [] };
}

/** 0033's `self_service_readiness`, in the order an account gets through them. */
export const READINESS_CHECKS = ['configuration', 'source', 'sender', 'routing', 'test', 'subscription', 'active'];

export function productionState(data) {
  const runtime = data.leadRecovery;
  const form = data.product?.form || { available: false };
  const moduleActive = form.module_state === 'active';
  const health = form.module_health;
  /* the database's own answers (0033). without them a connection is never drawn as
     connected: unknown is not ready. */
  const answered = data.product?.readiness?.available ? data.product.readiness : null;
  /* the owner's own pause (0035) is a second true thing about whether ARC is texting: with
     it on, "switched on for your business" is not the whole answer, so the last check says so. */
  const sending = data.product?.sending?.available ? data.product.sending : null;
  const ready = answered && sending?.paused ? { ...answered, active: { ok: false, code: 'paused_by_owner' } } : answered;
  const passed = key => ready?.[key]?.ok === true;
  const unhealthy = ['failing', 'blocking'].includes(health);
  const rows = runtime?.available ? runtime.leads : [];
  const byCorrelation = new Map(rows.map(row => [row.correlation_id, row]));
  const seen = new Set();
  const leads = data.threads.map(thread => {
    const row = byCorrelation.get(thread.id);
    if (row) seen.add(row.id);
    return projectLead(data.tenant.id, thread, row, runtime);
  });
  for (const row of rows) if (!seen.has(row.id)) leads.push(projectLead(data.tenant.id, null, row, runtime));
  return { schema: 1, mode: 'production', tenantId: data.tenant.id, asOf: data.generatedFor,
    business: data.product?.business || blankBusiness(data.tenant),
    setupStep: data.product?.step ?? 0, setupRevision: data.product?.setupRevision ?? null,
    setupAvailable: data.product?.available === true, setupError: data.product?.error || null,
    billing: data.product?.billing || { available: false, error: 'Billing has not loaded' },
    setupComplete: Boolean(ready) && READINESS_CHECKS.every(passed), runtimeAvailable: runtime?.available === true, runtimeError: runtime?.error || null,
    evidenceComplete: (data.threadTotal ?? data.threads.length) <= data.threads.length,
    eligibilityComplete: false, totalLeadCount: Math.max(data.threadTotal ?? data.threads.length, leads.length),
    campaigns: data.product?.campaigns || [],
    form,
    connections: [
      { id: 'form', name: 'Website inquiries', state: !form.available ? 'unavailable'
        : !form.public_key ? 'not_connected' : form.last_used_at ? 'connected' : 'in_progress',
        detail: !form.available ? form.error || 'Form status unavailable' : !form.public_key
          ? 'Choose your website origin to create a form key.' : form.last_used_at
          ? 'An inquiry has reached this form.' : 'Form key created. Publish the snippet and send a test inquiry.' },
      { id: 'messaging', name: 'Business messaging', state: !form.available ? 'unavailable'
        : unhealthy ? 'needs_attention' : passed('sender') && passed('test') ? 'connected'
          : passed('sender') ? 'in_progress' : !moduleActive ? 'pending_review' : 'in_progress',
        detail: !form.available ? 'Messaging status unavailable.'
          : unhealthy ? `ARC found a problem with texting on this account. Health: ${health}.`
            : passed('sender') && passed('test') ? 'Your number is approved for texting and a test message ran end to end.'
              : passed('sender') ? 'Your number is approved for texting. ARC still has to run a test message.'
                : `ARC review and sender testing are required. Module: ${form.module_state}.` },
      { id: 'phone', name: 'Business phone', routingTested: passed('routing'), state: !form.available ? 'unavailable'
        : unhealthy ? 'needs_attention' : passed('sender') && passed('routing') ? 'connected'
          : !moduleActive ? 'pending_review' : 'in_progress',
        detail: !form.available ? 'Phone status unavailable.'
          : unhealthy ? `ARC found a problem with this phone line. Health: ${health}.`
            : passed('sender') && passed('routing') ? 'Call forwarding was tested: a test call was answered and the line responded correctly.'
              : 'ARC must verify the number and test call forwarding with you.' },
    ], leads,
    readiness: ready,
    sending,
    readinessError: ready ? null : data.product?.readiness?.error || null,
    events: data.threads.flatMap(thread => (thread.steps || []).map((event, index) => ({
      id: `${thread.id}-${index}`, tenantId: data.tenant.id,
      leadId: byCorrelation.get(thread.id)?.id || thread.id, at: event.at,
      type: ({ sms_sent: 'sent', sms_delivered: 'delivered', reply_received: 'replied', call_missed: 'missed_call',
        ...(thread.qualified ? { lead_qualified: 'qualified' } : {}) })[event.type] || event.type,
      excluded: event.status === 'failure',
    }))),
  };
}
