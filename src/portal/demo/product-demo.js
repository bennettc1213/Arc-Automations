import { blankBusiness, newCampaign, qualify, eligibility, previewMessage, readiness, followupDecision } from '../product/model.js';

const TENANT = 'demo-halstead';
const START = '2026-10-11T16:00:00.000Z';
const record = (id, rest) => ({ id, tenantId: TENANT, createdAt: START, ...rest });
const connection = (id, name, state, detail) => record(id, { name, state, detail, updatedAt: START });
export function demoState(empty = false) {
  const business = empty ? blankBusiness() : { ...blankBusiness(), name: 'Halstead Heating & Air', trade: 'HVAC', services: 'Heating repair, AC repair, Maintenance', area: '43215, 43220, Columbus', timezone: 'America/New_York' };
  const campaigns = empty ? [] : ['missed', 'inbound', 'followup'].map((kind, i) => ({ ...newCampaign(kind, TENANT, `campaign-${i+1}`), runtime: i === 2 ? 'draft' : 'simulated', createdAt: START, updatedAt: START }));
  const state = { schema: 1, mode: 'demo', scenario: empty ? 'new' : 'populated', tenantId: TENANT, asOf: START, business, setupStep: empty ? 0 : 4, setupComplete: !empty, evidenceComplete: true, campaigns, leads: [], events: [],
    connections: [connection('phone', 'Business phone', empty ? 'not_connected' : 'connected', 'Calls you do not answer forward to an ARC number, which texts the caller back.'), connection('form', 'Website inquiries', empty ? 'not_connected' : 'connected', 'The ARC form on your website sends each inquiry here, with a record of what the customer agreed to.'), connection('messaging', 'Business messaging', empty ? 'pending_review' : 'connected', 'Phone carriers must approve a business before it can text customers. ARC handles the registration.'), connection('existing', 'Existing contacts', 'needs_attention', 'This list needs a record that each person agreed to hear from you. A phone number on its own is not enough.')].map(c => ({ ...c, routingTested: !empty && c.id === 'phone' })),
  };
  if (empty) return state;
  const people = [
    ['Alex Morgan', 'phone', 'Heating repair', '43215', false],
    ['Jamie Chen', 'form', 'AC repair', '43220', false],
    ['Sam Rivera', 'form', null, null, false],
    ['Taylor Brooks', 'existing', 'Maintenance', 'Columbus', true],
  ];
  state.leads = people.map(([name, source, service, location, suppressed], i) => {
    const id = `lead-${i+1}`;
    const answers = Object.fromEntries(Object.entries({ service, location }).filter(([,v]) => v));
    const q = qualify(answers, business);
    return record(id, { name, phone: `+161455501${String(10+i)}`, source, service, state: suppressed ? 'Suppressed' : i < 2 ? 'Engaged' : 'Awaiting reply', qualification: q.state, qualificationReason: q.reason, answers, suppressed, permission: source === 'existing' ? null : { channel: 'sms', scopes: ['inquiry'], evidence: 'Sample record: agreed to texts about this inquiry', capturedAt: '2026-10-11T15:00:00.000Z', source }, campaignId: source === 'phone' ? 'campaign-1' : 'campaign-2', needsOwner: i < 2, unread: i < 2, contactCount: 1, followupStopped: i < 2, lastActivity: START, messages: suppressed ? [] : [record(`message-${i}-1`, { author: 'ARC automation', body: `Hi ${name.split(' ')[0]}, this is Halstead Heating & Air. How can we help? Reply STOP to opt out.`, state: 'delivered', at: '2026-10-11T15:01:00.000Z' }), ...(service ? [record(`message-${i}-2`, { author: 'Customer', body: `${service} in ${location}, please.`, state: 'received', at: '2026-10-11T15:03:00.000Z' })] : [])] });
  });
  state.events = state.leads.flatMap((l, i) => l.suppressed ? [record(`event-${i}-stop`, { leadId: l.id, type: 'suppressed', at: START })] : [
    ...(l.source === 'phone' ? [record(`event-${i}-call`, { leadId: l.id, type: 'missed_call', at: '2026-10-11T15:00:00.000Z' })] : []),
    record(`event-${i}-in`, { leadId: l.id, type: 'eligible_inquiry', at: '2026-10-11T15:00:00.000Z' }),
    record(`event-${i}-sent`, { leadId: l.id, type: 'sent', at: '2026-10-11T15:01:00.000Z' }),
    record(`event-${i}-delivered`, { leadId: l.id, type: 'delivered', at: '2026-10-11T15:01:02.000Z' }),
    ...(i < 2 ? [record(`event-${i}-reply`, { leadId: l.id, type: 'replied', at: '2026-10-11T15:03:00.000Z' }), record(`event-${i}-qualified`, { leadId: l.id, type: 'qualified', at: '2026-10-11T15:03:01.000Z' }), record(`event-${i}-handoff`, { leadId: l.id, type: 'owner_notified', at: '2026-10-11T15:03:02.000Z' })] : []),
  ]);
  return state;
}

// A pure, isolated reducer. It cannot import a production adapter or issue network calls.
export function demoAction(previous, action) {
  if (previous.mode !== 'demo' || previous.tenantId !== TENANT) throw new Error('Demo actions require a synthetic tenant.');
  if (action.type === 'reset') return demoState(action.empty);
  const s = structuredClone(previous);
  const at = new Date(Date.parse(s.asOf) + 60000).toISOString();
  s.asOf = at;
  const addEvent = (leadId, type, detail) => s.events.push(record(`event-${s.events.length+1}`, { leadId, type, detail, at }));
  const lead = s.leads.find(l => l.id === action.id);
  const message = (l, author, body, status) => { l.messages.push(record(`message-${l.id}-${l.messages.length+1}`, { author, body, state: status, at })); l.lastActivity = at; };
  if (action.type === 'business') s.business = { ...action.business };
  if (action.type === 'setup') { s.setupStep = action.step; s.setupComplete = Boolean(action.complete); }
  if (action.type === 'connection') {
    const c = s.connections.find(c => c.id === action.id);
    if (!c) throw new Error('Unknown sample connection.');
    c.state = action.state; c.routingTested = c.id === 'phone' && action.state === 'connected'; c.updatedAt = at;
  }
  if (action.type === 'saveCampaign') {
    const old = s.campaigns.find(c => c.id === action.campaign.id);
    const id = action.duplicate || !old ? `campaign-${s.campaigns.length+1}` : old.id;
    // An edit of a simulated/live version is a new draft, never a silent runtime change.
    const edited = { ...action.campaign, id: old?.runtime === 'simulated' && !action.duplicate ? `campaign-${s.campaigns.length+1}` : id, tenantId: TENANT, runtime: 'draft', version: action.duplicate ? 1 : (old?.version || 0)+1, createdAt: old?.createdAt || at, updatedAt: at };
    if (old?.runtime === 'simulated') edited.name += ' · proposed change';
    if (action.duplicate) edited.name += ' · copy';
    s.campaigns = s.campaigns.filter(c => c.id !== edited.id).concat(edited);
  }
  if (action.type === 'runtime') {
    const c = s.campaigns.find(c => c.id === action.id);
    if (!c) throw new Error('Unknown sample campaign.');
    if (action.runtime === 'simulated' && readiness(c, s).length) throw new Error('Resolve readiness blockers before running a simulation.');
    c.runtime = action.runtime; c.updatedAt = at;
  }
  if (action.type === 'scenario') {
    const c = s.campaigns.find(c => c.id === action.campaignId);
    if (!c) throw new Error('Save the sample draft first.');
    if (readiness(c, s).length) throw new Error('Resolve readiness blockers before testing this campaign.');
    const outcomes = { answered: 'You answered the call, so ARC sent nothing.', repeated: `Same caller again: ARC already texted them and will not text twice within ${c.cooldown} hours.`, unknown: 'The caller hid their number, so there is nobody to text. It comes to you instead.', unavailable: 'That number cannot receive texts. Nothing was sent and you were alerted.', failed: 'The connection was down, so nothing was sent. It shows under Connections as needing attention.', incomplete: 'The inquiry had no phone number, so there is nobody to text. It comes to you instead.', blocked: 'There is no record that this person agreed to texts, so ARC sent nothing.', duplicate: 'The same inquiry arrived twice. ARC treated it as one and did not text again.', quiet: 'It arrived outside your hours, so the text waits until you open.' };
    if (outcomes[action.scenario]) { s.lastSimulation = outcomes[action.scenario]; return s; }
    const id = `lead-${s.leads.length+1}`;
    const l = record(id, { name: 'Casey Ellis', phone: '+16145550180', source: c.source, service: null, state: 'Awaiting reply', qualification: 'Needs Information', qualificationReason: 'Still waiting to hear: what they need, where the job is.', answers: {}, permission: { channel: 'sms', scopes: ['inquiry', ...(c.audience === 'reactivation' ? ['reactivation'] : [])], evidence: 'Sample record: agreed to texts about this inquiry', capturedAt: at }, campaignId: c.id, contactCount: 0, messages: [], lastActivity: at, unread: false });
    const gate = eligibility(l, c, Date.parse(at));
    if (!gate.ok) throw new Error(gate.reason);
    s.leads.unshift(l);
    if (c.source === 'phone') addEvent(id, 'missed_call');
    addEvent(id, c.source === 'existing' ? 'eligible_contact' : 'eligible_inquiry'); addEvent(id, 'accepted');
    const sendAt = new Date(Date.parse(at) + Math.max(1, c.delay * 60) * 1000).toISOString();
    message(l, 'ARC automation', previewMessage(c.message, s.business, l).text, 'delivered');
    l.messages[0].at = sendAt; l.lastActivity = sendAt;
    addEvent(id, 'sent'); s.events.at(-1).at = sendAt;
    addEvent(id, 'delivered'); s.events.at(-1).at = sendAt;
    s.asOf = sendAt; l.lastSentAt = sendAt; l.contactCount++;
    s.lastSimulation = 'ARC sent the first text. Open the conversation to play the customer.';
    s.lastLeadId = id;
  }
  if (action.type === 'read' && lead) lead.unread = false;
  if (action.type === 'followup' && lead) {
    const c = s.campaigns.find(c=>c.id===lead.campaignId);
    if (!c) throw new Error('Campaign not found.');
    const checkAt = Date.parse(s.asOf) + Math.max(c.followupHours,c.cooldown) * 3600000;
    const decision = followupDecision(lead,c,s.business,checkAt);
    s.lastSimulation = decision.reason;
    if (decision.ok && c.approval === 'template') { const future=new Date(checkAt).toISOString(); message(lead,'ARC automation',c.followup,'simulated');lead.messages.at(-1).at=future;lead.lastActivity=future;lead.contactCount++;lead.lastSentAt=future;s.asOf=future;addEvent(lead.id,'sample_followup');s.events.at(-1).at=future; }
    else addEvent(lead.id,'followup_held',decision.reason);
  }
  if (action.type === 'takeover' && lead) { lead.ownerTakeover = true; lead.needsOwner = true; lead.followupStopped = true; addEvent(lead.id, 'owner_takeover', 'Demo owner paused automation.'); }
  if (action.type === 'resume' && lead) { if (lead.suppressed || lead.booked) throw new Error('Suppressed or booked contacts cannot resume.'); lead.ownerTakeover = false; lead.needsOwner = false; addEvent(lead.id, 'owner_resumed', 'Demo owner resumed conversation assistance. No-response follow-ups remain stopped after a reply.'); }
  if (action.type === 'booked' && lead) { lead.booked = true; lead.ownerTakeover = true; lead.followupStopped = true; lead.state = 'Owner-reported booking'; addEvent(lead.id, 'owner_reported_booking', 'Reported by Demo owner; not verified booking or revenue evidence.'); }
  if (action.type === 'ownerReply' && lead) {
    if (!lead.ownerTakeover || lead.suppressed || !lead.permission?.evidence) throw new Error('Take over an eligible conversation before replying.');
    if (!action.body.trim()) throw new Error('Write a reply.');
    message(lead, 'Demo owner', action.body.slice(0, 1600), 'simulated'); addEvent(lead.id, 'owner_message');
  }
  if (action.type === 'reply' && lead) {
    const c = s.campaigns.find(c => c.id === lead.campaignId);
    if (!c) throw new Error('Campaign not found.');
    if (lead.suppressed) throw new Error('This contact has opted out.');
    message(lead, 'Customer', action.body, 'received'); addEvent(lead.id, 'replied'); lead.followupStopped = true; lead.unread = true;
    if (/^stop$/i.test(action.body.trim())) { lead.suppressed = true; lead.state = 'Suppressed'; addEvent(lead.id, 'suppressed'); return s; }
    if (action.key) lead.answers[action.key] = action.body;
    lead.service = lead.answers.service || null;
    const q = qualify(lead.answers, s.business, c.questions); lead.qualification = q.state; lead.qualificationReason = q.reason;
    if (lead.ownerTakeover || c.runtime === 'paused') return s;
    const next = c.questions.find(q => !lead.answers[q.key]);
    if (next && ['Needs Information', 'Qualified'].includes(q.state)) message(lead, 'ARC automation', next.text, 'simulated');
    else { lead.needsOwner = true; lead.state = 'Needs owner'; addEvent(lead.id, 'owner_notified', `${lead.name}: ${Object.values(lead.answers).join(' · ')}. ${q.reason}`); }
    if (q.state === 'Qualified' && !s.events.some(e => e.leadId === lead.id && e.type === 'qualified')) addEvent(lead.id, 'qualified');
  }
  return s;
}

// Only known fictional business values, campaign kinds, connection enums and progress
// survive reload. Free text, imported contacts and messages always remain in memory.
const KEY = 'arc.portal.demo.progress.v1';
export function readDemoSession(storage) {
  try {
    const p = JSON.parse(storage?.getItem(KEY) || 'null');
    const s = demoState(p?.scenario === 'new');
    if (!p) return s;
    const known = demoState().business;
    for (const key of Object.keys(known)) if (p.business?.[key] === known[key]) s.business[key] = known[key];
    s.setupStep = Math.max(0, Math.min(4, Number(p.step) || 0));
    s.setupComplete = p.complete === true;
    for (const c of s.connections) if (['not_connected','pending_review','connected','needs_attention'].includes(p.connections?.[c.id])) { c.state = p.connections[c.id]; c.routingTested = c.id === 'phone' && c.state === 'connected'; }
    if (Array.isArray(p.campaignKinds)) s.campaigns = p.campaignKinds.slice(0,30).filter(k=>['missed','inbound','followup'].includes(k)).map((kind,i)=>({...newCampaign(kind,TENANT,`campaign-${i+1}`),createdAt:START,updatedAt:START}));
    return s;
  } catch { return demoState(); }
}
export function saveDemoSession(storage, state) {
  const known = demoState().business;
  const business = Object.fromEntries(Object.entries(state.business).filter(([k,v])=>v === known[k]));
  try { storage?.setItem(KEY, JSON.stringify({ scenario: state.scenario, step: state.setupStep, complete: state.setupComplete, business, connections: Object.fromEntries(state.connections.map(c=>[c.id,c.state])), campaignKinds:state.campaigns.map(c=>c.kind) })); } catch { /* In-memory demo remains usable with storage disabled. */ }
}
