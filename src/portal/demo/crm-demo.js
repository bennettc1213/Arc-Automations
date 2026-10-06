/* the demo's lead inbox: generated records for the fictional company the rest of /demo shows.
 *
 * the same CrmWorkspace component reads these through the same calls a client's dashboard
 * makes — the shapes are the database's own rows — so the demo is the real screen pointed at a
 * different source. it is read-only: every write is refused with a sentence that says so,
 * rather than pretending to save something that disappears on reload. */

import { isUnread } from '../../../supabase/functions/_shared/communications/model.ts';
import { addDays, availableSlots, localDate, weekdayOf } from '../../../supabase/functions/_shared/booking/model.ts';
import { instantFor } from '../../../supabase/functions/_shared/engine/hours.ts';

const TENANT = { id: '8f1c2d34-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Halstead Restoration', timezone: 'America/New_York' };
const OWNER = '0d000000-0000-4000-8000-000000000001';
const STAFF = '0d000000-0000-4000-8000-000000000002';
const PIPELINE = '0d000000-0000-4000-8000-0000000000a0';

const hex = (n) => n.toString(16).padStart(12, '0');
const id = (kind, n) => `0d00000${kind}-0000-4000-8000-${hex(n)}`;

const STAGES = [
  ['new', 'New', 'open', 'us', false],
  ['contacted', 'Contacted', 'open', 'us', false],
  ['qualified', 'Qualified', 'open', 'us', true],
  ['estimate_sent', 'Estimate sent', 'open', 'customer', false],
  ['won', 'Won', 'won', 'us', false],
  ['lost', 'Lost', 'lost', 'us', false],
].map(([key, name, kind, waits_on, marks_qualified], i) => ({
  id: id(1, i + 1), tenant_id: TENANT.id, pipeline_id: PIPELINE, key, name, position: (i + 1) * 10,
  kind, waits_on, marks_qualified, archived_at: null, created_at: '2026-06-01T12:00:00Z',
}));
const stageOf = (key) => STAGES.find((s) => s.key === key);

/* [name, phone, title, source, stage, owner, priority, hours ago, task: [title, hours from now] | null] */
const PEOPLE = [
  ['Maria Delgado', '+16145550112', 'Water in basement after storm', 'web_form', 'new', null, 'urgent', 1, null],
  ['Tom Reilly', '+16145550147', 'Ceiling stain under bathroom', 'missed_call', 'new', null, 'high', 3, null],
  ['Priya Nair', '+16145550163', 'Mold smell in crawlspace', 'web_form', 'new', STAFF, 'normal', 7, ['Call back about access', 2]],
  ['Gene Whitfield', '+16145550188', 'Burst pipe — kitchen', 'missed_call', 'contacted', STAFF, 'urgent', 20, ['Send moisture readings', -3]],
  ['Alicia Brandt', '+16145550191', 'Smoke damage, back bedroom', 'manual', 'contacted', OWNER, 'high', 30, ['Site visit', 26]],
  ['Devon Clarke', '+16145550124', 'Insurance claim walkthrough', 'referral', 'qualified', OWNER, 'normal', 52, ['Book adjuster meeting', 50]],
  ['Rosa Martins', '+16145550135', 'Sump pump failure', 'web_form', 'qualified', null, 'normal', 60, null],
  ['Kenji Watanabe', '+16145550176', 'Hardwood cupping, living room', 'import', 'estimate_sent', STAFF, 'normal', 96, null],
  ['Laura Okafor', '+16145550158', 'Roof leak repair + drywall', 'web_form', 'estimate_sent', OWNER, 'high', 120, ['Follow up on estimate', -20]],
  ['Sam Whitaker', '+16145550199', 'Full basement dry-out', 'missed_call', 'won', OWNER, 'normal', 200, null],
  ['Hannah Iverson', '+16145550103', 'Attic mold remediation', 'web_form', 'won', STAFF, 'normal', 260, null],
  ['Victor Pell', '+16145550119', 'Small leak under sink', 'missed_call', 'lost', STAFF, 'low', 300, null],
  ['Nadia Kerr', '+16145550142', 'Flooded laundry room', 'web_form', 'contacted', null, 'normal', 40, null],
];

function build(now) {
  const at = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const contacts = [];
  const leads = [];
  const tasks = [];
  PEOPLE.forEach(([name, phone, title, source, stage, owner, priority, ago, task], i) => {
    const contactId = id(2, i + 1);
    const leadId = id(3, i + 1);
    const s = stageOf(stage);
    contacts.push({
      id: contactId, tenant_id: TENANT.id, display_name: name, first_name: name.split(' ')[0], last_name: name.split(' ')[1],
      phone, email: `${name.split(' ')[0].toLowerCase()}@example.com`, preferred_channel: 'sms',
      address_line1: null, address_line2: null, city: 'Columbus', region: 'OH', postal_code: '43215', country: 'US',
      owner_user_id: null, merged_into_id: null, archived_at: null, created_at: at(ago), updated_at: at(ago),
    });
    leads.push({
      id: leadId, tenant_id: TENANT.id, contact_id: contactId, title, summary: null, source, source_event_id: null,
      service_id: null, pipeline_id: PIPELINE, stage_id: s.id, status: s.kind, owner_user_id: owner, priority,
      estimated_value_cents: null, estimated_value_source: null, qualified_at: null,
      closed_at: s.kind === 'open' ? null : at(ago - 48), closed_reason: s.kind === 'lost' ? 'Went with a plumber' : null,
      recovery_lead_id: null, archived_at: null, created_at: at(ago), updated_at: at(Math.max(ago - 6, 0)),
    });
    if (task) {
      tasks.push({
        id: id(4, i + 1), tenant_id: TENANT.id, lead_id: leadId, contact_id: null, kind: 'follow_up', title: task[0], detail: null,
        due_at: new Date(now + task[1] * 3_600_000).toISOString(), status: 'open', assigned_user_id: owner,
        completed_at: null, created_at: at(ago), updated_at: at(ago),
      });
    }
  });
  return { contacts, leads, tasks };
}

const POLICIES = Object.fromEntries(['contact', 'lead', 'task', 'note', 'location', 'service'].map((type) => [type, { objectType: type, authority: 'arc', connectorKey: null, fieldOwners: {} }]));
const PEOPLE_LIST = [
  { user_id: OWNER, label: 'owner@halstead.example', role: 'owner', assignable: true },
  { user_id: STAFF, label: 'office@halstead.example', role: 'staff', assignable: true },
];
const VIEWER = { kind: 'client_user', user_id: OWNER, role: 'owner', may: { record: true, sensitive: true, business: true } };

function refuse() {
  return Promise.reject(new Error('this is the demo — nothing here is saved. sign in to work your own leads.'));
}

/* ── conversations (ARC-370) ───────────────────────────────
   a few generated threads, in the database's own row shapes: what lead recovery texted on
   its own (its record, shown by reference), what the customer wrote back, and what a person
   on the team sent. every delivery state on screen here is one the real screen can show. */

/* contact index → [who, hours ago, body, state?]. who: 'lr' lead recovery · 'in' the customer · a user id */
const TALK = {
  3: [
    ['lr', 20, 'Sorry we missed your call — this is Halstead Restoration. What can we help with?', 'delivered'],
    ['in', 19.8, 'Pipe burst under the kitchen sink, water everywhere'],
    [STAFF, 19.5, 'Shut the main valve if you can reach it. A crew is 25 minutes out.', 'read'],
    ['in', 19.4, 'Valve is off. Thank you'],
    [STAFF, 3, 'Moisture readings are in — sending them over this afternoon.', 'delivered'],
  ],
  4: [
    [OWNER, 28, 'Hi Alicia, this is Halstead. Does Thursday at 10 work for the site visit?', 'delivered'],
    ['in', 26, 'Thursday works. Park in the back'],
  ],
  8: [
    ['in', 121, 'Did you get the photos of the ceiling?'],
    [OWNER, 120, 'Got them. Your estimate is attached to the email I just sent.', 'sent'],
  ],
  6: [
    ['in', 60, 'Our sump pump failed overnight. Can someone come look?'],
  ],
  12: [
    ['lr', 40, 'Thanks for getting in touch with Halstead Restoration. What can we help with?', 'delivered'],
    ['in', 39, 'STOP'],
  ],
};

function conversationsFor(data, now, blocks) {
  const at = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const out = new Map();
  for (const [index, lines] of Object.entries(TALK)) {
    const contact = data.contacts[Number(index)];
    const lead = data.leads[Number(index)];
    const conversationId = id(5, Number(index) + 1);
    const messages = [];
    const recovery = [];
    lines.forEach(([who, hours, body, state], n) => {
      if (who === 'lr') {
        recovery.push({ id: `${conversationId}-r${n}`, direction: 'outbound', body, status: state ?? 'delivered', error_class: null, occurred_at: at(hours) });
        return;
      }
      const inbound = who === 'in';
      messages.push({
        id: id(6, Number(index) * 10 + n), tenant_id: TENANT.id, conversation_id: conversationId, channel: 'sms', address: contact.phone,
        direction: inbound ? 'inbound' : 'outbound', origin: inbound ? 'provider' : 'manual', body, body_withheld: false,
        contact_id: contact.id, lead_id: lead.id, author_type: inbound ? 'customer' : 'client_user', author_id: inbound ? null : who,
        connector_key: null, external_id: null, connection_id: null, status: inbound ? 'received' : state ?? 'sent', status_code: null, status_detail: null,
        consent_basis: inbound ? null : 'inbound_message', safety_acknowledged: [], attachments: [], run_id: null, action_id: null,
        occurred_at: at(hours), created_at: at(hours),
      });
    });
    const inbound = lines.filter(([who]) => who === 'in').map(([, hours]) => hours);
    const outbound = lines.filter(([who]) => who !== 'in').map(([, hours]) => hours);
    const last = Math.min(...lines.map(([, hours]) => hours));
    out.set(contact.id, {
      contact,
      messages,
      recovery,
      conversation: {
        id: conversationId, tenant_id: TENANT.id, channel: 'sms', address: contact.phone, assigned_user_id: lead.owner_user_id,
        last_message_at: at(last), last_inbound_at: inbound.length ? at(Math.min(...inbound)) : null,
        last_outbound_at: outbound.length ? at(Math.min(...outbound)) : null,
        /* read up to the last thing the team sent: a later reply from the customer is unread. */
        last_read_at: outbound.length ? at(Math.min(...outbound)) : null, last_read_by: lead.owner_user_id,
        created_at: at(Math.max(...lines.map(([, hours]) => hours))),
      },
      block: blocks[contact.id] ? { reason: 'opt_out', since: at(39) } : null,
    });
  }
  return out;
}

/* ── appointments (ARC-380) ────────────────────────────────
   a week of generated bookings in the database's own row shapes: one a customer asked for on
   the booking page and nobody has answered, two in the calendar, one that is over and can be
   closed, one already marked done. the times offered are the real `availableSlots` over these. */

const WEEKDAYS = { open: '08:00', close: '17:00' };
const DEMO_RULES = {
  timezone: TENANT.timezone,
  hours_source: 'business_hours',
  hours: { mon: [WEEKDAYS], tue: [WEEKDAYS], wed: [WEEKDAYS], thu: [WEEKDAYS], fri: [WEEKDAYS], sat: [{ open: '09:00', close: '13:00' }] },
  closed_dates: [],
  slot_step_minutes: 30,
  min_lead_minutes: 120,
  max_days_ahead: 30,
  buffer_before_minutes: 0,
  buffer_after_minutes: 30,
  capacity: 1,
  customer_may_cancel: true,
  customer_may_reschedule: true,
  customer_change_cutoff_minutes: 240,
  enforce_service_area: false,
  authority: { authority: 'arc', connector_key: null, time_owner: 'arc', status_owner: 'arc' },
};
const DEMO_TYPES = [
  ['site_visit', 'Site visit', 60, true],
  ['moisture_check', 'Moisture check', 30, false],
].map(([key, name, duration_minutes, requires_approval], i) => ({
  id: id(8, i + 1), tenant_id: TENANT.id, key, name, description: null, service_id: null, duration_minutes,
  buffer_before_minutes: null, buffer_after_minutes: null, requires_approval, is_public: true, archived_at: null, created_at: '2026-06-01T12:00:00Z',
}));

/* [contact index, type index, open days from today, time, status, source, who has it] */
const BOOKED = [
  [0, 0, 1, '09:00', 'requested', 'booking_page', null],
  [4, 0, 1, '13:00', 'confirmed', 'staff', OWNER],
  [5, 0, 2, '10:00', 'confirmed', 'staff', OWNER],
  [3, 1, -1, '14:00', 'confirmed', 'staff', STAFF],
  [9, 0, -4, '10:00', 'completed', 'staff', OWNER],
];

/** the business day `steps` open days from `date`, forwards or back. */
function openDay(date, steps) {
  let day = date;
  for (let left = Math.abs(steps); left > 0;) {
    day = addDays(day, Math.sign(steps));
    if (DEMO_RULES.hours[weekdayOf(day)]) left -= 1;
  }
  return day;
}

function appointmentsFor(data, now) {
  const today = localDate(new Date(now), TENANT.timezone);
  const stamp = (ms) => new Date(ms).toISOString();
  return BOOKED.map(([index, typeIndex, days, time, status, source, assigned], n) => {
    const type = DEMO_TYPES[typeIndex];
    const starts = instantFor(openDay(today, days), time, TENANT.timezone).getTime();
    const ends = starts + type.duration_minutes * 60_000;
    const made = stamp(Math.min(now, starts) - 20 * 3_600_000);
    return {
      id: id(9, n + 1), tenant_id: TENANT.id, contact_id: data.contacts[index].id, lead_id: data.leads[index].id, appointment_type_id: type.id,
      title: type.name, service_id: null, location_id: null, status, starts_at: stamp(starts), ends_at: stamp(ends),
      busy_from: stamp(starts), busy_until: stamp(ends + DEMO_RULES.buffer_after_minutes * 60_000), timezone: TENANT.timezone,
      address_line1: null, city: 'Columbus', region: 'OH', postal_code: '43215',
      customer_note: source === 'booking_page' ? 'Water is still coming in near the stairs.' : null,
      source, booking_page_id: null, requires_approval: source === 'booking_page', assigned_user_id: assigned, reschedule_count: 0, cancel_reason: null,
      confirmed_at: status === 'requested' ? null : made, closed_at: status === 'completed' ? stamp(ends) : null,
      sync_state: 'local', sync_detail: {}, last_synced_at: null, changed_via: source === 'booking_page' ? 'booking_page' : 'workspace',
      created_at: made, updated_at: made,
    };
  });
}

/** what happened to a generated appointment: how it was made, and that it was closed. */
function appointmentEvents(a) {
  const online = a.source === 'booking_page';
  return [
    {
      id: `${a.id}-e1`, tenant_id: TENANT.id, appointment_id: a.id, event_type: online ? 'requested' : 'confirmed',
      actor_type: online ? 'system' : 'client_user', actor_id: online ? null : a.assigned_user_id, detail: { via: a.changed_via }, occurred_at: a.created_at,
    },
    ...(a.status === 'completed'
      ? [{ id: `${a.id}-e2`, tenant_id: TENANT.id, appointment_id: a.id, event_type: 'completed', actor_type: 'client_user', actor_id: a.assigned_user_id, detail: { via: 'workspace' }, occurred_at: a.closed_at }]
      : []),
  ];
}

const BOOKING_VIEWER = { kind: 'client_user', user_id: OWNER, may: { book: true, setup: true, reconcile: true } };

const DEMO_SNIPPETS = [
  { id: id(7, 1), key: 'on_our_way', name: 'On our way', channel: 'sms', body: 'Hi {first_name}, {business_name} is on the way.', archived_at: null },
];
const DEMO_BLOCK = { code: 'demo', detail: 'this is the demo — nothing here is sent.' };

export function demoCrmApi() {
  /* "now" rounded to the hour, so the generated ages are stable while somebody looks. */
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const data = build(now);
  /* one opted-out customer, so the blocked queue has something real to show. */
  const blocks = { [data.contacts[12].id]: [{ channel: 'sms', reason: 'opt_out', created_at: new Date(now - 30 * 3_600_000).toISOString(), expires_at: null }] };
  const talks = conversationsFor(data, now, blocks);
  const appointments = appointmentsFor(data, now);
  const holding = appointments.filter((a) => a.status === 'requested' || a.status === 'confirmed');
  const workspace = {
    tenant: TENANT,
    viewer: VIEWER,
    route: 'native',
    policies: POLICIES,
    pipelines: [{ id: PIPELINE, tenant_id: TENANT.id, key: 'sales', name: 'Sales', is_default: true, archived_at: null, stages: STAGES }],
    leads: data.leads,
    contacts: data.contacts,
    tasks: data.tasks,
    blocks,
    recovery: {},
    people: PEOPLE_LIST,
    services: [],
    appointments: holding.map((a) => ({ id: a.id, lead_id: a.lead_id, status: a.status, title: a.title, starts_at: a.starts_at, sync_state: a.sync_state })),
    truncated: { open: false, closed: false },
    read_at: new Date(now).toISOString(),
  };

  const timelineFor = (lead) => [
    { id: `${lead.id}-t1`, activity_type: 'lead_created', actor_type: 'system', actor_id: null, summary: 'Lead created', detail: { source: lead.source }, occurred_at: lead.created_at },
    ...(lead.stage_id !== STAGES[0].id
      ? [{ id: `${lead.id}-t2`, activity_type: 'lead_stage_changed', actor_type: 'client_user', actor_id: lead.owner_user_id ?? STAFF, summary: 'Stage changed', detail: { from: 'new', to: STAGES.find((s) => s.id === lead.stage_id).key }, occurred_at: lead.updated_at }]
      : []),
  ].reverse();

  return {
    door: 'demo',
    readOnly: true,
    workspace: async () => workspace,
    leadView: async (leadId) => {
      const lead = data.leads.find((l) => l.id === leadId);
      if (!lead) throw new Error('no such lead');
      const contact = data.contacts.find((c) => c.id === lead.contact_id);
      return {
        lead, contact, stage: STAGES.find((s) => s.id === lead.stage_id),
        notes: lead.owner_user_id ? [{ id: `${lead.id}-n1`, body: 'Customer prefers a text before anyone arrives.', author_type: 'client_user', author_id: lead.owner_user_id, created_at: lead.updated_at }] : [],
        tasks: data.tasks.filter((t) => t.lead_id === lead.id),
        mappings: [],
        timeline: timelineFor(lead),
        source: {
          event: { id: `${lead.id}-s`, source: lead.source, received_at: lead.created_at, external_ref: null },
          door: { kind: lead.source === 'web_form' ? 'form' : lead.source === 'import' ? 'import' : lead.source === 'manual' ? 'manual' : 'other', name: lead.source === 'web_form' ? 'Website form' : lead.source === 'import' ? 'spring-leads.csv' : null },
          claimed: lead.source === 'web_form' ? { utm_source: 'google', utm_campaign: 'storm-season' } : {},
          consent: lead.source === 'web_form' ? [{ channel: 'sms', address: contact.phone, granted: true, disclosure: 'Text me about my request.', captured_at: lead.created_at }] : [],
        },
        safety: [{ channel: 'sms', address: contact.phone, suppressed: Boolean(blocks[contact.id]), reason: blocks[contact.id] ? 'opt_out' : null, since: null }],
        recovery: null,
        people: PEOPLE_LIST,
        pipeline: workspace.pipelines[0],
        policies: POLICIES,
        viewer: VIEWER,
      };
    },
    contactView: async (contactId) => {
      const contact = data.contacts.find((c) => c.id === contactId);
      if (!contact) throw new Error('no such customer');
      const leads = data.leads.filter((l) => l.contact_id === contactId);
      return {
        contact, leads, notes: [], tasks: data.tasks.filter((t) => leads.some((l) => l.id === t.lead_id)), mappings: [],
        timeline: leads.flatMap(timelineFor),
        safety: [{ channel: 'sms', address: contact.phone, suppressed: Boolean(blocks[contact.id]), reason: blocks[contact.id] ? 'opt_out' : null, since: null }],
        people: PEOPLE_LIST, viewer: VIEWER, policies: POLICIES,
      };
    },
    updateLead: refuse, bulk: refuse, archiveLead: refuse, restoreLead: refuse, quickAdd: refuse, updateContact: refuse,
    addNote: refuse, archiveNote: refuse, createTask: refuse, updateTask: refuse, saveStages: refuse,

    thread: async ({ contact_id: contactId }) => {
      const contact = data.contacts.find((c) => c.id === contactId);
      if (!contact) throw new Error('no such customer');
      const talk = talks.get(contactId);
      return {
        contact,
        threads: [{
          channel: 'sms',
          address: contact.phone,
          conversation: talk?.conversation ?? null,
          unread: talk ? isUnread(talk.conversation) : false,
          shared_by: 1,
          messages: talk?.messages ?? [],
          actions: {},
          recovery: talk?.recovery ?? [],
          do_not_contact: talk?.block ?? null,
          compose: { can_send: false, block: DEMO_BLOCK, needs_acknowledgement: [], consent_basis: talk?.messages.some((m) => m.direction === 'inbound') ? 'inbound_message' : 'none_on_file', through: null },
          truncated: false,
        }],
        snippets: DEMO_SNIPPETS,
        people: PEOPLE_LIST,
        viewer: { kind: 'client_user', user_id: OWNER, may: { send: true, suppress: true, assign: true, reconcile: false, snippets: true } },
        read_at: new Date(now).toISOString(),
      };
    },
    conversations: async () => ({
      conversations: [...talks.values()]
        .map((talk) => {
          const last = [...talk.messages].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] ?? null;
          return {
            conversation: talk.conversation,
            unread: isUnread(talk.conversation),
            contacts: [{ id: talk.contact.id, display_name: talk.contact.display_name }],
            last: last ? { body: last.body, direction: last.direction, at: last.occurred_at } : null,
          };
        })
        .sort((a, b) => Number(b.unread) - Number(a.unread) || Date.parse(b.conversation.last_message_at) - Date.parse(a.conversation.last_message_at)),
      truncated: false,
    }),
    sendMessage: refuse, cancelMessage: refuse, reconcileMessage: refuse, flushMessages: refuse, markRead: refuse,
    assignConversation: refuse, doNotContact: refuse, saveSnippet: refuse,

    booking: async () => ({
      tenant: TENANT, rules: DEMO_RULES, mode: 'slots', unavailable: null, types: DEMO_TYPES, pages: [],
      appointments: [...appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      contacts: data.contacts.filter((c) => appointments.some((a) => a.contact_id === c.id)).map((c) => ({ id: c.id, display_name: c.display_name, phone: c.phone, email: c.email })),
      people: PEOPLE_LIST, services: [], viewer: BOOKING_VIEWER, truncated: false, read_at: new Date(now).toISOString(),
    }),
    bookingRecord: async ({ lead_id: leadId, contact_id: contactId }) => {
      const mine = appointments.filter((a) => (leadId ? a.lead_id === leadId : a.contact_id === contactId)).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
      return {
        rules: DEMO_RULES, mode: 'slots', unavailable: null, types: DEMO_TYPES, appointments: mine, events: mine.flatMap(appointmentEvents),
        people: PEOPLE_LIST, viewer: BOOKING_VIEWER, read_at: new Date(now).toISOString(),
      };
    },
    bookingSlots: async ({ appointment_type_id: typeId, appointment_id: appointmentId, from, days = 1 }) => {
      const moving = appointments.find((a) => a.id === appointmentId);
      const type = moving
        ? { duration_minutes: (Date.parse(moving.ends_at) - Date.parse(moving.starts_at)) / 60_000, buffer_before_minutes: 0, buffer_after_minutes: DEMO_RULES.buffer_after_minutes }
        : DEMO_TYPES.find((t) => t.id === typeId) ?? DEMO_TYPES[0];
      const day = from ?? localDate(new Date(), TENANT.timezone);
      return {
        mode: 'slots', timezone: TENANT.timezone, from: day, days, unavailable: null,
        slots: availableSlots({ rules: DEMO_RULES, type, held: holding, now: new Date(), from: day, days, excludeId: moving?.id ?? null }),
      };
    },
    bookAppointment: refuse, changeAppointment: refuse, reconcileAppointment: refuse, saveBookingSettings: refuse,
    saveAppointmentType: refuse, saveBookingPage: refuse, setBookingPageStatus: refuse,
  };
}
