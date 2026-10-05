/* the demo's lead inbox: generated records for the fictional company the rest of /demo shows.
 *
 * the same CrmWorkspace component reads these through the same calls a client's dashboard
 * makes — the shapes are the database's own rows — so the demo is the real screen pointed at a
 * different source. it is read-only: every write is refused with a sentence that says so,
 * rather than pretending to save something that disappears on reload. */

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

export function demoCrmApi() {
  /* "now" rounded to the hour, so the generated ages are stable while somebody looks. */
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const data = build(now);
  /* one opted-out customer, so the blocked queue has something real to show. */
  const blocks = { [data.contacts[12].id]: [{ channel: 'sms', reason: 'opt_out', created_at: new Date(now - 30 * 3_600_000).toISOString(), expires_at: null }] };
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
  };
}
