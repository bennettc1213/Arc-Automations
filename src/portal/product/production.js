import { blankBusiness } from './model.js';
// Read-only projection of the existing authenticated dashboard. No fixture import, storage,
// client-authorized execution, or new persistence layer belongs here.
export function productionState(data) {
  return { schema: 1, mode: 'production', tenantId: data.tenant.id, asOf: data.generatedFor, business: blankBusiness(data.tenant), setupStep: 0, setupComplete: false,
    evidenceComplete: (data.threadTotal ?? data.threads.length) <= data.threads.length, eligibilityComplete: false, totalLeadCount: data.threadTotal ?? data.threads.length, campaigns: [], connections: [],
    leads: data.threads.map(t => {
      const q = t.qualification;
      const outcome = ({qualified:'Qualified',needs_info:'Needs Information',out_of_area:'Outside Service Area',unsupported_service:'Unsupported Service',human_review:'Needs Owner Review'})[q?.outcome] || (q?.outcome ? q.outcome.replaceAll('_',' ') : 'Unknown');
      return { id: t.id, tenantId: data.tenant.id, createdAt: t.startedAt, name: t.name || 'Unknown contact', phone: t.phone, service: q?.jobType || t.lossType, source: t.source === 'missed_call' ? 'phone' : t.source === 'web_form' ? 'form' : t.source || 'unknown', state: t.state, qualification: outcome, qualificationReason: q ? `Recorded qualification: ${outcome}. ${q.inServiceArea === false ? 'The supplied location was outside the service area.' : q.inServiceArea === true ? 'The supplied location was in the service area.' : 'Area fit is unknown.'}` : 'No qualification answer recorded.', permission: null, suppressed: Boolean(t.suppressionReason), deliveryFailed: t.deliveryFailed, answers: Object.fromEntries(Object.entries({service:q?.jobType,location:q?.zip,urgency:q?.urgency,timing:q?.preferredTime}).filter(([,v])=>v)), campaignId: null, needsOwner: Boolean(t.handoff && !t.handoff.resolvedAt) || Boolean(t.unacknowledged), lastActivity: t.steps?.at(-1)?.at || t.startedAt, messages: [], steps: t.steps || [] };
    }),
    events: data.threads.flatMap(t => (t.steps || []).map((e, i) => ({ id: `${t.id}-${i}`, tenantId: data.tenant.id, leadId: t.id, at: e.at, type: ({ sms_sent: 'sent', sms_delivered:'delivered', reply_received: 'replied', call_missed: 'missed_call', ...(t.qualified ? {lead_qualified:'qualified'} : {}) })[e.type] || e.type, excluded: e.status === 'failure' }))),
  };
}
