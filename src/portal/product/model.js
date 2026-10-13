// UI contracts only. Execution authorization remains in the existing server.
export const KINDS = {
  missed: { name: 'Missed Call Text Back', source: 'phone', purpose: 'Give an eligible missed caller a way to continue the conversation.' },
  inbound: { name: 'New Lead Response', source: 'form', purpose: 'Respond to an eligible inquiry, then learn what they need.' },
  followup: { name: 'Outreach & Follow-Up', source: 'existing', purpose: 'Continue an eligible conversation or reconnect with an existing contact.' },
};
export const QUESTIONS = [
  { key: 'service', text: 'What service can we help you with?', required: true },
  { key: 'location', text: 'What ZIP code is the property in?', required: true },
  { key: 'urgency', text: 'When would you like help?', required: false },
  { key: 'timing', text: 'What is a good time for the owner to contact you?', required: false },
];
export const SETUP_STEPS = ['Business details', 'First campaign', 'Connections', 'Preview', 'Readiness'];
export function blankBusiness(tenant = {}) {
  return { name: tenant.name || '', trade: '', services: '', area: '', timezone: tenant.timezone || 'America/Los_Angeles', open: '08:00', close: '17:00', days: 'Monday–Friday', alerts: 'Inbox only', ownerPhone: '' };
}
export function validateBusiness(b) {
  const errors = {};
  for (const key of ['name', 'trade', 'services', 'area', 'days', 'alerts']) if (!b[key]?.trim()) errors[key] = 'Please fill this in.';
  try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }).format(); } catch { errors.timezone = 'Choose a valid timezone.'; }
  if (!/^\d{2}:\d{2}$/.test(b.open) || !/^\d{2}:\d{2}$/.test(b.close) || b.open >= b.close) errors.close = 'Closing time must be after opening time.';
  if (b.ownerPhone && !/^\+[1-9]\d{7,14}$/.test(b.ownerPhone)) errors.ownerPhone = 'Include country code, for example +15551234567.';
  return errors;
}
export function newCampaign(kind = 'missed', tenantId = null, id = 'draft') {
  return { id, tenantId, kind, name: KINDS[kind].name, source: KINDS[kind].source, channel: 'sms', version: 1, runtime: 'draft', createdAt: null, updatedAt: null,
    audience: kind === 'followup' ? 'incomplete' : 'inquiry', message: kind === 'missed' ? 'Hi {{first_name}}, this is {{business}}. Sorry we missed your call. How can we help? Reply STOP to opt out.' : 'Hi {{first_name}}, this is {{business}}. Thanks for reaching out. How can we help? Reply STOP to opt out.',
    questions: QUESTIONS.map(q => ({ ...q })), cooldown: 24, delay: 1, followupHours: 24, maxContacts: 2, afterHours: 'next_open', handoff: 'Inbox and owner text', approval: 'review', tone: 'Friendly and direct', cta: 'Reply with the service you need', offer: '', summary: '', followup: 'Just checking whether you still need help. Reply STOP to opt out.' };
}
export function previewMessage(message, business, lead = { name: 'Alex Morgan' }) {
  const facts = { first_name: lead.name?.split(' ')[0], business: business.name, service: lead.service };
  const missing = [];
  const text = message.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
    if (!facts[key]) { missing.push(key); return `[missing ${key}]`; }
    return facts[key];
  });
  return { text, missing: [...new Set(missing)], facts };
}
export function validateCampaign(c, business) {
  const errors = [];
  if (!c.name.trim()) errors.push('Name your campaign.');
  if (!c.message.trim()) errors.push('Add a first message.');
  if (!c.message.includes('{{business}}') || !/\bstop\b/i.test(c.message)) errors.push('Your message needs {{business}} in it and the line “Reply STOP to opt out”.');
  const missing = previewMessage(c.message, business).missing;
  if (missing.length) errors.push(`ARC has nothing to put in place of ${missing.map(m => `{{${m}}}`).join(', ')}. Take it out of your message.`);
  if (!Number.isFinite(c.cooldown) || c.cooldown < 1 || c.cooldown > 720) errors.push('Contact cooldown must be 1–720 hours.');
  if (!Number.isFinite(c.delay) || c.delay < 0 || c.delay > 60) errors.push('Response delay must be 0–60 minutes.');
  if (!Number.isFinite(c.followupHours) || c.followupHours < 24) errors.push('Leave at least 24 hours before a follow-up.');
  if (!Number.isInteger(c.maxContacts) || c.maxContacts < 1 || c.maxContacts > 3) errors.push('Choose 1–3 contacts across campaigns.');
  if (c.questions.some(q => !q.text.trim())) errors.push('Fill in or remove empty qualification questions.');
  return errors;
}
export function eligibility(lead, campaign, now) {
  if (lead.suppressed) return { ok: false, reason: 'Opted out. No further messages.' };
  if (!lead.phone || !/^\+[1-9]\d{7,14}$/.test(lead.phone)) return { ok: false, reason: 'A usable SMS number is missing.' };
  if (!lead.permission?.evidence || lead.permission.channel !== campaign.channel || !lead.permission.scopes?.includes(campaign.audience === 'reactivation' ? 'reactivation' : 'inquiry')) return { ok: false, reason: 'Permission for this use is unverified. Review source evidence.' };
  if (lead.deliveryFailed) return { ok: false, reason: 'Delivery failed. Ask the owner to review another permitted channel.' };
  if (lead.ownerTakeover || lead.booked) return { ok: false, reason: 'Owner takeover or a reported booking stops automation.' };
  if ((lead.contactCount || 0) >= campaign.maxContacts) return { ok: false, reason: 'The contact limit across campaigns has been reached.' };
  if (lead.lastSentAt && now - Date.parse(lead.lastSentAt) < campaign.cooldown * 3600000) return { ok: false, reason: 'Contact cooldown is still in effect.' };
  return { ok: true, reason: 'Recorded permission covers this inquiry response.' };
}
const ASKED = { service: 'what they need', location: 'where the job is', urgency: 'how soon', timing: 'when to reach them' };
export function qualify(answers, business, questions = QUESTIONS) {
  const list = text => text.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (answers.urgency && /urgent|emergency|gas|smoke/i.test(answers.urgency)) return { state: 'Needs Owner Review', reason: 'They said it is urgent, so this comes straight to you. ARC does not judge emergencies.' };
  if (answers.location && !list(business.area).includes(answers.location.trim().toLowerCase())) return { state: 'Outside Service Area', reason: `${answers.location} is outside your service area.` };
  if (answers.service && !list(business.services).includes(answers.service.trim().toLowerCase())) return { state: 'Unsupported Service', reason: `${answers.service} is not on your list of services.` };
  const missing = questions.filter(q => q.required && !answers[q.key]);
  if (missing.length) return { state: 'Needs Information', reason: `Still waiting to hear: ${missing.map(q => ASKED[q.key] || q.key).join(', ')}.` };
  if (!answers.service || !answers.location) return { state: 'Needs Owner Review', reason: 'ARC could not confirm the service or the area, so this one is yours to check.' };
  return { state: 'Qualified', reason: 'They want a service you offer, in your area.' };
}
export function followupDecision(lead, campaign, business, now) {
  if (lead.suppressed) return { ok: false, reason: 'Opt-out suppression: no message.' };
  if (lead.followupStopped || lead.messages?.some(m => m.author === 'Customer')) return { ok: false, reason: 'A reply or owner action stopped no-response follow-ups.' };
  if (campaign.runtime === 'paused') return { ok: false, reason: 'Campaign paused: no message.' };
  const gate = eligibility(lead, campaign, now);
  if (!gate.ok) return gate;
  if (!lead.lastSentAt || now - Date.parse(lead.lastSentAt) < campaign.followupHours * 3600000) return { ok: false, reason: 'Follow-up spacing has not elapsed.' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:business.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  const closed = business.days === 'Monday–Friday' && ['Sat','Sun'].includes(parts.weekday) || business.days === 'Monday–Saturday' && parts.weekday === 'Sun';
  if (closed || time < business.open || time >= business.close) return { ok: false, reason: campaign.afterHours === 'hold' ? 'Outside business hours: held for owner review.' : 'Quiet hours: wait until the next business window.' };
  return { ok: true, reason: campaign.approval === 'review' ? 'Eligible, but owner approval is required. Message remains a draft.' : 'Eligible for a reviewed-template sample follow-up.' };
}
export function readiness(campaign, state) {
  const blockers = validateCampaign(campaign, state.business);
  if (Object.keys(validateBusiness(state.business)).length) blockers.push('Complete business details.');
  const source = state.connections.find(c => c.id === campaign.source);
  if (!source || source.state !== 'connected') blockers.push('Verify the source connection.');
  if (campaign.kind === 'missed' && !source?.routingTested) blockers.push('Test unanswered calls, answered calls and voicemail routing.');
  if (!state.connections.find(c => c.id === 'messaging' && c.state === 'connected')) blockers.push('Complete sender registration and messaging approval.');
  if (state.mode !== 'demo') blockers.push('Publishing a campaign to your live business is not available yet. Your draft is saved.');
  return blockers;
}
export function summary(c) {
  return c.summary || `When an eligible ${c.source === 'phone' ? 'missed call' : c.source === 'form' ? 'website inquiry' : 'existing contact'} arrives, send the reviewed response, ask ${c.questions.length} short questions, and notify the owner when a person is needed.`;
}
// These metrics take evidence events, never owner-edited lifecycle fields.
export function metrics(state) {
  const end = Date.parse(state.asOf), start = end - 30 * 86400000;
  const events = state.events.filter(e => Date.parse(e.at) >= start && Date.parse(e.at) <= end && !e.excluded);
  const unique = type => [...new Set(events.filter(e => e.type === type).map(e => e.leadId))];
  const arrivals = [...new Map(events.filter(e => e.type === 'eligible_inquiry').sort((a,b)=>b.at.localeCompare(a.at)).map(e=>[e.leadId,e])).values()];
  const times = arrivals.flatMap(a => {
    const sent = events.filter(e => e.type === 'sent' && e.leadId === a.leadId && e.at >= a.at).sort((a,b) => a.at.localeCompare(b.at))[0];
    return sent ? [(Date.parse(sent.at) - Date.parse(a.at)) / 1000] : [];
  }).sort((a,b) => a-b);
  const middle = Math.floor(times.length / 2);
  const median = times.length ? (times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2) : null;
  const missed = new Set(events.filter(e => e.type === 'missed_call').map(e => e.leadId));
  const observed = state.evidenceComplete && events.length > 0;
  return [
    { label: 'Eligible inquiries', value: observed && state.eligibilityComplete !== false ? unique('eligible_inquiry').length : null, filter: 'eligible', detail: 'Distinct inbound inquiries with recorded channel permission. Imports, prospects, duplicates and test events excluded.' },
    { label: 'First response', value: median === null ? null : `${Math.round(median)}s`, filter: 'sent', detail: `Median arrival-to-first-sent time, across ${times.length} inquiries with both events. Accepted, queued, failed and unanswered inquiries excluded; delivery is a separate event.` },
    { label: 'Engaged missed callers', value: observed ? unique('replied').filter(id => missed.has(id)).length : null, filter: 'engaged', detail: 'Distinct missed callers with an inbound reply. This is engagement, not a recovered job or booking.' },
    { label: 'Qualified leads', value: observed ? unique('qualified').length : null, filter: 'qualified', detail: 'Distinct leads with a qualification evidence event. Manual lifecycle labels and owner-reported bookings are excluded.' },
  ];
}
export function filterLeads(state, query = '', filter = 'all') {
  const support = type => new Set(state.events.filter(e => e.type === type && !e.excluded && Date.parse(e.at) >= Date.parse(state.asOf) - 30 * 86400000 && Date.parse(e.at) <= Date.parse(state.asOf)).map(e => e.leadId));
  const eligible = support('eligible_inquiry'), sent = support('sent'), replied = support('replied'), qualified = support('qualified');
  return state.leads.filter(l => `${l.name} ${l.service || ''} ${l.source}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === 'all' || filter === l.source || (filter === 'attention' && l.needsOwner) || (filter === 'suppressed' && l.suppressed) || (filter === 'eligible' && eligible.has(l.id)) || (filter === 'sent' && sent.has(l.id)) || (filter === 'engaged' && l.source === 'phone' && replied.has(l.id)) || (filter === 'qualified' && qualified.has(l.id))));
}
