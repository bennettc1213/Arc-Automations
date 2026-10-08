import { anonKey, functionUrl, getSupabase } from './supabase';

/* ARC-360 — the CRM workspace's calls, through one of its two doors.
 *
 * a client's own team goes through the `crm` function; an operator through `ops`. both run
 * the same action table (`_shared/crm/actions.ts`), so this file is the same list of calls
 * pointed at a different function — the screen does not know, or need to know, which one.
 *
 * nothing here decides anything. who may move, hand over or retire what is the server's
 * answer, and a refusal comes back as an error carrying the server's own words and fields. */

async function call(door, body) {
  const supabase = getSupabase();
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : null;
  const response = await fetch(functionUrl(door), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey ?? '',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* an undeployed function answers with the gateway's html. */
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error ?? (response.status === 404 ? `the ${door} function is not deployed yet` : `${door} failed (${response.status})`),
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** the workspace's calls for one client, through `door` ('crm' for a client, 'ops' for an operator). */
export function crmApi(door, tenantId) {
  const run = (action, rest = {}) => call(door, { action, tenant_id: tenantId, ...rest });
  return {
    door,
    readOnly: false,
    workspace: async () => (await run('crm-workspace')).workspace,
    /* ARC-MK-200 — the client's own published settings and stop list, as a projection. a read. */
    accountSettings: async () => (await run('account-settings')).settings,
    leadView: async (leadId) => (await run('crm-lead-view', { lead_id: leadId })).view,
    contactView: async (contactId) => (await run('crm-contact-view', { contact_id: contactId })).view,
    updateLead: async (leadId, lead) => (await run('crm-lead-update', { lead_id: leadId, lead })).lead,
    bulk: async (leadIds, change) => (await run('crm-lead-bulk', { lead_ids: leadIds, change })).bulk,
    archiveLead: async (leadId) => (await run('crm-lead-archive', { lead_id: leadId })).lead,
    restoreLead: async (leadId) => (await run('crm-lead-restore', { lead_id: leadId })).lead,
    quickAdd: async (lead) => (await run('crm-lead-quick-add', { lead })).arrival,
    updateContact: async (contactId, contact) => (await run('crm-contact-update', { contact_id: contactId, contact })).contact,
    addNote: async (note) => (await run('crm-note-add', { note })).note,
    archiveNote: async (noteId) => (await run('crm-note-archive', { note_id: noteId })).note,
    createTask: async (task) => (await run('crm-task-create', { task })).task,
    updateTask: async (taskId, task) => (await run('crm-task-update', { task_id: taskId, task })).task,
    saveStages: async (pipelineId, stages) => (await run('crm-stages-save', { pipeline_id: pipelineId, stages })).saved,
    /* ARC-370 — the conversation with a customer. `by` is { contact_id } or { conversation_id }. */
    thread: async (by) => (await run('crm-thread', by)).thread,
    conversations: async () => (await run('crm-conversations')).inbox,
    sendMessage: async (message) => (await run('crm-message-send', { message })).sent,
    cancelMessage: async (messageId) => (await run('crm-message-cancel', { message_id: messageId })).message,
    reconcileMessage: async (messageId, resolution) => (await run('crm-message-reconcile', { message_id: messageId, resolution })).reconciled,
    flushMessages: async () => (await run('crm-messages-flush')).pass,
    markRead: async (conversationId) => (await run('crm-conversation-read', { conversation_id: conversationId })).conversation,
    assignConversation: async (conversationId, userId) => (await run('crm-conversation-assign', { conversation_id: conversationId, assigned_user_id: userId })).conversation,
    doNotContact: async (request) => (await run('crm-do-not-contact', { request })).listed,
    saveSnippet: async (snippet) => (await run('crm-snippet-save', { snippet })).snippet,
    /* ARC-380 — appointments. `by` is { lead_id } or { contact_id }; `ask` names a type, or an
       appointment that is being moved. */
    booking: async () => (await run('crm-booking')).booking,
    bookingRecord: async (by) => (await run('crm-booking-record', by)).record,
    bookingSlots: async (ask) => (await run('crm-booking-slots', ask)).availability,
    bookAppointment: async (booking) => (await run('crm-appointment-book', { booking })).booked,
    changeAppointment: async (appointmentId, change) => (await run('crm-appointment-change', { appointment_id: appointmentId, change })).appointment,
    reconcileAppointment: async (appointmentId, resolution) => (await run('crm-appointment-reconcile', { appointment_id: appointmentId, resolution })).appointment,
    saveBookingSettings: async (settings) => (await run('crm-booking-settings-save', { settings })).rules,
    saveAppointmentType: async (type, id) => (await run('crm-appointment-type-save', { type, ...(id ? { id } : {}) })).type,
    saveBookingPage: async (page, id) => (await run('crm-booking-page-save', { page, ...(id ? { id } : {}) })).page,
    setBookingPageStatus: async (id, status) => (await run('crm-booking-page-status', { id, status })).page,
  };
}

/** is this error "the backend for this page is not there yet", as opposed to a refusal. */
export function isNotDeployed(error) {
  return error?.status === 404 || error?.status === 501 || error?.payload?.error === 'unknown action';
}
