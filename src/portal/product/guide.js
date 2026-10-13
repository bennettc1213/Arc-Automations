// The campaign guide: one question at a time, each with a recommendation and its reason.
// Presentation only. It adds no field to a campaign — every answer writes a field the
// model already validates — and a recommendation is read off the business's own settings,
// never invented.
import { KINDS, QUESTIONS, newCampaign, validateBusiness, validateCampaign } from './model.js';

// Trades where a customer may be writing about something that cannot wait.
const URGENT_TRADE = /hvac|heat|cool|air|furnace|plumb|drain|electric|roof|restor|water|flood|lock|garage|tow|pest/i;

export const TRADES = {
  HVAC: ['Heating repair', 'AC repair', 'Maintenance', 'Installation'],
  Plumbing: ['Leak repair', 'Drain cleaning', 'Water heaters', 'Installation'],
  Electrical: ['Repairs', 'Panel upgrades', 'Lighting', 'EV chargers'],
  Roofing: ['Roof repair', 'Roof replacement', 'Inspections', 'Gutters'],
  Landscaping: ['Lawn care', 'Planting', 'Irrigation', 'Clean-ups'],
  Cleaning: ['House cleaning', 'Deep cleaning', 'Move-out cleaning', 'Office cleaning'],
  'Pest control': ['Inspections', 'Treatments', 'Prevention plans'],
  'Garage doors': ['Repairs', 'Openers', 'New doors'],
  Painting: ['Interior painting', 'Exterior painting', 'Cabinets'],
  Handyman: ['Repairs', 'Assembly', 'Small installs'],
};
export function suggestedServices(business) {
  const key = Object.keys(TRADES).find(t => t.toLowerCase() === String(business.trade || '').trim().toLowerCase());
  if (!key) return [];
  const have = String(business.services || '').toLowerCase().split(',').map(s => s.trim());
  return TRADES[key].filter(s => !have.includes(s.toLowerCase()));
}

// Written, reviewed wording. The first of each kind is the model's own default, so a
// draft that was never edited reads as that template.
export function messageTemplates(kind) {
  const base = newCampaign(kind).message;
  if (kind === 'missed') return [
    { id: 'no_name', label: 'Straight to the point', text: 'This is {{business}}. Sorry we missed your call. What can we help you with? Reply STOP to opt out.' },
    { id: 'callback', label: 'Offer a call back', text: 'This is {{business}}. Sorry we missed your call. Tell us what you need and we will call you back. Reply STOP to opt out.' },
    { id: 'friendly', label: 'Friendly, uses their name', text: base },
  ];
  if (kind === 'inbound') return [
    { id: 'friendly', label: 'Friendly, uses their name', text: base },
    { id: 'direct', label: 'Straight to the point', text: 'This is {{business}}. We got your request. What can we help you with? Reply STOP to opt out.' },
    { id: 'callback', label: 'Offer a call back', text: 'Hi {{first_name}}, this is {{business}}. Thanks for your request. Tell us a little more and we will call you back. Reply STOP to opt out.' },
  ];
  return [
    { id: 'friendly', label: 'Friendly, uses their name', text: base },
    { id: 'direct', label: 'Straight to the point', text: 'This is {{business}}. Do you still need help with your request? Reply STOP to opt out.' },
  ];
}
export function templateOf(campaign) {
  return messageTemplates(campaign.kind).find(t => t.text === campaign.message)?.id || 'custom';
}

const QUESTION_HELP = {
  service: { title: 'What they need', why: 'Checked against your list of services.' },
  location: { title: 'Where the job is', why: 'Checked against your service area.' },
  urgency: { title: 'How soon they need it', why: 'Anything urgent goes straight to you.' },
  timing: { title: 'When to reach them', why: 'So your call back lands at a good time.' },
};
export function questionHelp(key) { return QUESTION_HELP[key] || { title: key, why: '' }; }

const hoursLabel = b => `${b.days}, ${clock(b.open)} to ${clock(b.close)}`;
function clock(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(h)) return value || '';
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`;
}
export const businessHours = hoursLabel;

/** What ARC would pick for this business, and why. Every value is one the model accepts. */
export function recommend(kind, state) {
  const b = state.business;
  const urgent = URGENT_TRADE.test(`${b.trade} ${b.services}`);
  const hasServices = Boolean(b.services?.trim()), hasArea = Boolean(b.area?.trim());
  return {
    message: kind === 'missed'
      ? { value: 'no_name', reason: 'A missed call only gives you a number, so this wording does not need a name.' }
      : { value: 'friendly', reason: kind === 'inbound' ? 'Your form asks for a name, so the text can use it.' : 'You already know these contacts by name.' },
    questions: {
      service: { ask: true, required: true, reason: hasServices ? 'You listed your services, so ARC can tell you whether the job is one you do.' : 'Add your services in settings and ARC can check the job is one you do.' },
      location: { ask: true, required: true, reason: hasArea ? 'You set a service area, so ARC can flag jobs outside it.' : 'Add your service area in settings and ARC can flag jobs outside it.' },
      urgency: { ask: true, required: false, reason: urgent ? `${b.trade || 'Your trade'} jobs can be urgent. An urgent answer goes straight to you.` : 'Helps you decide who to call first. Optional for the customer.' },
      timing: { ask: true, required: false, reason: 'Saves a round of phone tag. Optional for the customer.' },
    },
    delay: kind === 'missed'
      ? { value: 1, reason: 'Quick enough that they have not called someone else, with a moment for you to ring back first.' }
      : { value: 0, reason: kind === 'inbound' ? 'They just asked for help. The sooner they hear from you, the better.' : 'There is nothing to wait for.' },
    afterHours: { value: 'next_open', reason: `Nobody gets a text at night. It goes out when you open (${hoursLabel(b)}).` },
    followupHours: { value: 24, reason: 'One day is long enough not to nag and short enough that they still need the work.' },
    approval: kind === 'followup'
      ? { value: 'review', reason: 'These are people you already know, so it is worth a look before each one goes.' }
      : { value: 'template', reason: 'The wording is fixed and you have already read it, so nothing unexpected goes out.' },
    limits: { cooldown: 24, maxContacts: 2, reason: 'One text and one check-in. Enough to be helpful without being a nuisance.' },
    audience: { value: 'incomplete', reason: 'They already asked you for help, so hearing back from you is expected.' },
  };
}

/** Which kind to start with. Only a connected source earns a recommendation. */
export function recommendKind(state) {
  const connected = id => state.connections.some(c => c.id === id && c.state === 'connected');
  if (connected('phone')) return { value: 'missed', reason: 'Your business phone is already connected.' };
  if (connected('form')) return { value: 'inbound', reason: 'Your website form is already connected.' };
  return { value: null, reason: '' };
}
export const KIND_HELP = {
  missed: { when: 'Best if most customers call you.', what: 'When you cannot pick up, the caller gets a text so the job does not go to whoever answers next.' },
  inbound: { when: 'Best if most customers use your website.', what: 'Someone fills in your form and hears from you while they are still looking.' },
  followup: { when: 'Best once one of the others is running.', what: 'Check in with people who went quiet, or contacts who have agreed to hear from you.' },
};

/** A campaign with every recommendation applied. Name, kind and source are kept. */
export function applyRecommended(campaign, state) {
  const r = recommend(campaign.kind, state);
  const template = messageTemplates(campaign.kind).find(t => t.id === r.message.value);
  return { ...campaign, message: template.text,
    questions: QUESTIONS.filter(q => r.questions[q.key].ask).map(q => ({ ...q, required: r.questions[q.key].required })),
    delay: r.delay.value, afterHours: r.afterHours.value, followupHours: r.followupHours.value,
    approval: r.approval.value, cooldown: r.limits.cooldown, maxContacts: r.limits.maxContacts };
}
export function isRecommended(campaign, state) {
  const want = applyRecommended(campaign, state);
  return ['message', 'delay', 'afterHours', 'followupHours', 'approval', 'cooldown', 'maxContacts'].every(k => want[k] === campaign[k])
    && JSON.stringify(want.questions.map(q => [q.key, q.required])) === JSON.stringify(campaign.questions.map(q => [q.key, q.required]));
}

/** One sentence for a list row. */
export function oneLine(campaign) {
  const who = { phone: 'a missed caller', form: 'someone who fills in your form', existing: 'a contact due a check-in' }[campaign.source] || 'a new inquiry';
  const n = campaign.questions.length;
  if (campaign.kind === 'followup') return `Checks in with ${campaign.audience === 'reactivation' ? 'past customers and contacts' : 'people who went quiet'}, asks ${n ? `${n} short question${n === 1 ? '' : 's'}` : 'no questions'}, then hands you the lead.`;
  return `Texts ${who} ${delayWords(campaign.delay).toLowerCase()}, asks ${n ? `${n} short question${n === 1 ? '' : 's'}` : 'no questions'}, then hands you the lead.`;
}

/** The questions the guide asks, in order. */
export function guideSteps(kind) {
  return [
    { id: 'goal', title: 'What should ARC take off your plate?', short: 'Goal' },
    ...(kind === 'followup' ? [{ id: 'audience', title: 'Who should hear from you?', short: 'Who' }] : []),
    { id: 'message', title: 'What should the first text say?', short: 'First text' },
    { id: 'questions', title: 'What do you need to know before you call back?', short: 'Questions' },
    { id: 'timing', title: 'When should the first text go out?', short: 'Timing' },
    { id: 'followup', title: 'What if they do not reply?', short: 'No reply' },
    { id: 'limits', title: 'How often can one person hear from you?', short: 'Limits' },
    { id: 'review', title: 'Here is what will happen', short: 'Review' },
  ];
}

const TRIGGER = { phone: 'A customer calls and nobody picks up', form: 'Someone fills in the form on your website', existing: 'A contact who agreed to hear from you is due a check-in' };
const delayWords = minutes => minutes === 0 ? 'Right away' : minutes === 1 ? 'About a minute later' : `About ${minutes} minutes later`;
const hoursWords = hours => hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`;
export { delayWords, hoursWords };

/** The campaign as the customer and the owner will live it, in order. */
export function journey(campaign, business) {
  const text = body => body.replace(/\{\{\s*business\s*\}\}/g, business.name || 'your business')
    .replace(/\{\{\s*first_name\s*\}\}/g, 'Alex').replace(/\{\{\s*service\s*\}\}/g, 'your request');
  const alert = business.alerts === 'Inbox and owner text' && business.ownerPhone ? 'in your inbox and by text' : 'in your inbox';
  return [
    { who: 'trigger', title: TRIGGER[campaign.source] || TRIGGER.form },
    { who: 'arc', title: `${delayWords(campaign.delay)}, ARC texts them`, body: text(campaign.message),
      note: campaign.afterHours === 'hold' ? 'Outside your hours it waits for you to look first.' : 'Outside your hours it waits until you open.' },
    ...(campaign.questions.length ? [{ who: 'arc', title: campaign.questions.length === 1 ? 'When they reply, ARC asks' : 'When they reply, ARC asks, one question at a time',
      items: campaign.questions.map(q => ({ body: q.text, note: q.required ? 'Needed for a fit' : 'Optional' })) }] : []),
    { who: 'owner', title: `You get the lead ${alert}`, note: 'With what they need, where, and when to reach them. Anything urgent or unclear comes to you sooner.' },
    ...(campaign.maxContacts > 1 ? [{ who: 'arc', title: `No reply after ${hoursWords(campaign.followupHours)}: a check-in`, body: text(campaign.followup),
      note: campaign.approval === 'review' ? 'It stays a draft until you approve it.' : 'Sent in your opening hours.' }] : []),
    { who: 'stop', title: 'It stops the moment they reply STOP, you take over, or the job is booked',
      note: `Never more than ${campaign.maxContacts} text${campaign.maxContacts === 1 ? '' : 's'} to one person without a reply.` },
  ];
}

/**
 * What stands between this campaign and going live, each with where to fix it.
 * The same checks as the model's `readiness`, said one at a time; a test holds them together.
 */
export function readinessItems(campaign, state) {
  const source = state.connections.find(c => c.id === campaign.source);
  const wording = validateCampaign(campaign, state.business);
  const items = [
    { id: 'wording', label: 'Your texts and questions are complete', todo: 'Fix the wording of your texts', done: wording.length === 0, detail: wording.join(' '), step: 'message', action: 'Fix wording' },
    { id: 'business', label: 'Your business details are filled in', todo: 'Finish your business details', done: Object.keys(validateBusiness(state.business)).length === 0, to: 'settings', action: 'Open settings' },
    { id: 'source', label: `${source?.name || KINDS[campaign.kind].name + ' source'} is connected`, todo: `Connect ${(source?.name || 'the source').toLowerCase()}`, done: source?.state === 'connected', to: 'connections', action: 'Open connections' },
    ...(campaign.kind === 'missed' ? [{ id: 'routing', label: 'Call forwarding is tested: answered, unanswered and voicemail', todo: 'Test call forwarding', done: Boolean(source?.routingTested), to: 'connections', action: 'Open connections' }] : []),
    { id: 'messaging', label: 'Texting is approved for your business number', todo: 'Get texting approved for your number', done: state.connections.some(c => c.id === 'messaging' && c.state === 'connected'), to: 'connections', action: 'Open connections' },
    /* a draft changes nothing ARC sends. only the version an owner switched on does, and an
       edit made since is a draft again until they switch it on (0034). */
    ...(state.mode !== 'demo' ? [{ id: 'publish', label: 'This campaign is switched on', todo: campaign.runtime === 'live_edited' ? 'Switch on your changes' : 'Switch this campaign on', done: campaign.runtime === 'live',
      detail: campaign.runtime === 'live_edited'
        ? 'ARC is still sending the version you switched on before. Your changes are saved and are not being used yet.'
        : 'Your draft is saved, and it changes nothing ARC sends until you switch it on from the campaigns page.' }] : []),
  ];
  return items;
}

/* ── account readiness (0033) ──
   What the database says is true for this account right now, said one line at a time. The
   codes are `self_service_readiness`'s closed list; a code this file does not know is shown
   as not done with a plain "ARC is checking this", never as done. An account with no
   readiness loaded gets an empty list, and the page says it could not be read. */
const READINESS_WORDS = {
  configuration: {
    label: 'Your business details and first campaign are saved', todo: 'Finish your business details and pick a campaign',
    to: 'setup', action: 'Open setup',
    codes: { business_details_missing: 'Your trade, services or service area are still blank.', no_campaign: 'No campaign has been saved yet.' },
  },
  source: {
    label: 'An inquiry has reached your website form', todo: 'Put the form on your website and send a test inquiry',
    to: 'connections', action: 'Open connections',
    codes: { no_form: 'You have not made a form yet.', awaiting_first_inquiry: 'The form exists, and nothing has come through it yet.' },
  },
  sender: {
    label: 'Your number is approved for texting', todo: 'Texting approval for your number',
    codes: { not_started: 'ARC has not started setting up your number yet.', pending_review: 'ARC is registering your number with the phone carriers. This is done for you and can take a few days.' },
  },
  routing: {
    label: 'Call forwarding is tested', todo: 'A call forwarding test with ARC',
    codes: { not_started: 'ARC has not started setting up your phone line yet.', not_tested: 'ARC still has to place a test call to your business with you.' },
  },
  test: {
    label: 'A test message ran from start to finish', todo: 'A test message',
    codes: { not_run: 'ARC has not run the test message yet.', retest_required: 'Something changed since the last test, so ARC is running it again.' },
  },
  subscription: {
    label: 'Your subscription is active', todo: 'Start your subscription',
    to: 'billing', action: 'Open billing',
    codes: {
      none: 'There is no subscription on this account yet.', period_ended: 'The period you paid for has ended.',
      usage_cap: 'You have used every text in this period. New inquiries still arrive here; no new texts go out until the next period.',
      past_due: 'A payment is overdue, so new texts are paused.', unpaid: 'A payment is overdue, so new texts are paused.',
      canceled: 'The subscription was cancelled.', paused: 'The subscription is paused.',
      incomplete: 'The first payment has not gone through yet.', incomplete_expired: 'The first payment did not go through. Start checkout again.',
    },
  },
  active: {
    label: 'ARC is switched on for your business', todo: 'ARC switching your account on',
    codes: {
      not_active: 'ARC switches your account on once the checks above pass.', paused: 'Your account is paused. No texts go out while it is.',
      held_for_review: 'A change is waiting for ARC to check it. New inquiries are kept, and no new texts go out until it has.',
      paused_by_owner: 'You paused your texts. New inquiries still arrive in your inbox, and nobody is texted until you resume.',
      sending_stopped: 'ARC has paused texting for every business while it fixes a problem. New inquiries are still recorded.',
    },
  },
};

export function accountReadinessItems(state) {
  if (!state.readiness) return [];
  return Object.entries(READINESS_WORDS).map(([id, words]) => {
    const answer = state.readiness[id];
    const done = answer?.ok === true;
    return {
      id: `account-${id}`, label: words.label, todo: words.todo, done,
      detail: done ? '' : words.codes[answer?.code] || 'ARC is checking this.',
      ...(words.to ? { to: words.to, action: words.action } : {}),
    };
  });
}

/** How close this period's texts are to the limit. Null when either number is unknown. */
export function usageWarning(used, cap) {
  if (used == null || cap == null || !(cap > 0)) return null;
  if (used >= cap) return { level: 'at', text: `You have used all ${cap} texts for this period. New inquiries still arrive in your inbox; ARC sends no new texts until the next period starts.` };
  if (used >= Math.ceil(cap * 0.8)) return { level: 'near', text: `You have used ${used} of ${cap} texts for this period. When they run out, new inquiries still arrive but ARC stops texting until the next period.` };
  return null;
}
