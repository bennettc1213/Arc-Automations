// The scene observes ARC's evidence. It never dispatches work or invents a result.
export const AGENT = { id: 'damon-reid', name: 'Damon Reid', role: 'Lead Recovery Agent' };
export const MEMORY_FOLDER = 'Damon Read Memory';
export const STATIONS = [
  {
    id: 'signal',
    code: '01',
    name: 'Signal Dock',
    tool: 'CALLS + FORMS',
    color: '#69d8ee',
    x: -10,
    z: -7,
    description: 'Missed calls and form leads enter the recovery loop.',
    steps: [
      'Open client intake to connect an approved lead source.',
      'Verify phone forwarding in Lead Recovery.',
      'Look for lead_received or call_missed evidence.',
    ],
    destination: 'intake',
  },
  {
    id: 'qualification',
    code: '02',
    name: 'Qualification Lab',
    tool: 'ARC CLASSIFIER',
    color: '#91b8ff',
    x: 0,
    z: -10,
    description: 'Service area, intent and urgency, with human review when uncertain.',
    steps: [
      'Review service area and business rules in client settings.',
      'Publish a reviewed configuration.',
      'Run the activation checks before enabling recovery.',
    ],
    destination: 'settings',
  },
  {
    id: 'comms',
    code: '03',
    name: 'Recovery Comms',
    tool: 'TWILIO',
    color: '#fc9873',
    x: 10,
    z: -7,
    description: 'Text-back, replies and provider delivery receipts.',
    steps: [
      'Record the Twilio number and messaging service on the client page.',
      'Finish consent, messaging compliance and approved templates.',
      'Test routing, run a canary, then activate through the existing gate.',
    ],
    destination: '',
  },
  {
    id: 'booking',
    code: '04',
    name: 'Booking Bridge',
    tool: 'BOOKING + HANDOFF',
    color: '#8edcb6',
    x: 13,
    z: 3,
    description: 'A booking or dispatcher handoff needs its own evidence.',
    steps: [
      'Open the client CRM to inspect leads and bookings.',
      'Check the appointment or owner handoff.',
      'A booking alone does not prove a completed, billable job.',
    ],
    destination: 'crm',
  },
  {
    id: 'proof',
    code: '05',
    name: 'Proof Vault',
    tool: 'EVENT LEDGER',
    color: '#deb97e',
    x: 8,
    z: 12,
    description: 'Source, response, reply and outcome, linked to the original event.',
    steps: [
      'Inspect the event and its correlation ID.',
      'Review the lead in the client page.',
      'Confirm outcomes through the existing Lead Recovery controls.',
    ],
    destination: '',
  },
  {
    id: 'safety',
    code: '06',
    name: 'Safety Airlock',
    tool: 'POLICY + HUMAN REVIEW',
    color: '#ef8895',
    x: -2,
    z: 13,
    description: 'Opt-outs, unsafe requests and human takeover remain hard stops.',
    steps: [
      'Inspect the stop reason and original event.',
      'Review the handoff on the client page.',
      'Use the activation console for safe pause and recovery.',
    ],
    destination: 'activation/lead_recovery',
  },
  {
    id: 'memory',
    code: '07',
    name: 'Memory Archive',
    tool: 'OBSIDIAN',
    color: '#bc9afa',
    x: -12,
    z: 9,
    description: 'A local, tenant-separated Markdown record of observed decisions and outcomes.',
    steps: [
      'Open or create your Obsidian vault.',
      'Connect that vault folder below.',
      'Keep this page open for automatic journal updates, or use the background bridge.',
    ],
    destination: null,
  },
  {
    id: 'n8n',
    code: '08',
    name: 'Workflow Relay',
    tool: 'N8N',
    color: '#e795b6',
    x: -14,
    z: -1,
    description: 'Monitor recorded workflow evidence. Lead Recovery v1 runs directly in ARC.',
    steps: [
      'Inspect existing connections in OPS.',
      'Register and verify only supported workflows.',
      'The n8n production runner remains gated; wiring a station does not enable execution.',
    ],
    destination: 'connections',
  },
  {
    id: 'business',
    code: '09',
    name: 'Business Console',
    tool: 'CLIENT CONFIG',
    color: '#9fbbb8',
    x: -5,
    z: -1,
    description: 'One company, its rules, and its approved configuration versions.',
    steps: [
      'Open client settings to edit hours, service area or filters.',
      'Preview the change and its effect.',
      'Publish through the versioned editor and retest when requested.',
    ],
    destination: 'settings',
  },
  {
    id: 'voice',
    code: '10',
    name: 'Voice Pod',
    tool: 'FUTURE EXPANSION',
    color: '#727c94',
    x: 6,
    z: 3,
    description: 'Reserved for controlled AI callbacks. Outbound AI calling is not implemented.',
    steps: [
      'Keep this station disabled for the missed-call pilot.',
      'A future voice adapter needs consent, provider readiness and a safe stop path.',
    ],
    destination: null,
  },
  {
    id: 'command',
    code: '00',
    name: 'Command Deck',
    tool: 'DAMON REID',
    color: '#ff984f',
    x: 0,
    z: 4,
    description: 'Damon visualizes backend events. Idle means waiting for evidence.',
    steps: [
      'Select a client.',
      'Watch new events arrive or inspect historical evidence.',
      'Use the replay client to explore without contacting anybody.',
    ],
    destination: '',
  },
];
export const STATION_BY_ID = Object.fromEntries(STATIONS.map((s) => [s.id, s]));
const MAP = {
  lead_received: ['signal', 'Lead received', 'Listening'],
  call_missed: ['signal', 'Missed call recorded', 'Inspecting'],
  lead_qualified: ['qualification', 'Qualification recorded', 'Qualifying'],
  sms_sent: ['comms', 'Message accepted by provider', 'Waiting for reply'],
  reply_received: ['comms', 'Customer reply received', 'Inspecting'],
  message_delivered: ['comms', 'Delivery confirmed', 'Listening'],
  message_failed: ['comms', 'Message delivery failed', 'Blocked'],
  routed: ['booking', 'Lead handed to the business', 'Handoff'],
  lead_booked: ['booking', 'Booking recorded · outcome still needs proof', 'Handoff'],
  lead_suppressed: ['safety', 'Contact suppressed', 'Blocked'],
  handoff_requested: ['safety', 'Human review requested', 'Escalating'],
  automation_completed: ['proof', 'Recovery run completed · not a billing claim', 'Verifying proof'],
  automation_failed: ['command', 'Recovery run failed', 'Blocked'],
  task_opened: ['safety', 'Operator task opened', 'Escalating'],
  task_resolved: ['proof', 'Operator task resolved', 'Verifying proof'],
  canary_check: ['command', 'Synthetic health check', 'Inspecting'],
  schema_assert: ['command', 'Schema check', 'Inspecting'],
  watermark_check: ['command', 'Event watermark check', 'Inspecting'],
  canary_expectation: ['command', 'Canary expectation', 'Inspecting'],
};
// Deliberately closed, scalar metadata. No raw prompts, contact details or credentials.
const META_KEYS = [
  'reason_code',
  'stop_reason',
  'intent',
  'urgency',
  'service_type',
  'outcome',
  'channel',
  'error_code',
  'error_class',
  'source',
];
export function safeScalar(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).slice(0, 160);
  if (
    /bearer\s|eyJ[\w-]+\.|(?:sk|pk)[_-][\w-]{12,}|(?:token|secret|password|api.?key)\s*[:=]|https?:|@|\+?\d[\d ()-]{8,}\d/i.test(
      text,
    )
  )
    return '[withheld]';
  return text.replace(/[<>\[\]`\r\n]/g, ' ');
}
export function adaptEvent(raw, tenantId) {
  const own = raw.tenantId ?? raw.tenant_id;
  if (!tenantId || own !== tenantId) return null;
  const type = raw.eventType ?? raw.event_type;
  const mapped = MAP[type] ?? ['command', 'Recorded ARC event', 'Inspecting'];
  const payload = raw.payload ?? {};
  const meta = Object.fromEntries(
    META_KEYS.map((k) => [k, safeScalar(payload[k])]).filter(([, v]) => v !== null),
  );
  const failed = raw.status === 'failure' || raw.status === 'failed' || /_failed$/.test(type);
  return {
    id: String(raw.id),
    tenantId: own,
    type,
    station:
      (raw.workflowId ?? raw.workflow_id) && (!MAP[type] || type === 'automation_failed') ? 'n8n' : mapped[0],
    summary: mapped[1],
    action: failed ? 'Blocked' : mapped[2],
    status: failed
      ? 'error'
      : /suppressed|handoff_requested|task_opened/.test(type)
        ? 'attention'
        : 'recorded',
    timestamp: raw.occurredAt ?? raw.occurred_at,
    recordedAt: raw.recordedAt ?? raw.created_at,
    correlationId: raw.correlationId ?? raw.correlation_id ?? null,
    isCanary: Boolean(raw.isCanary ?? raw.is_canary),
    meta,
  };
}
export function mergeEvents(current, incoming, tenantId, limit = 300) {
  const rows = new Map();
  for (const e of [...current, ...incoming]) if (e?.tenantId === tenantId) rows.set(e.id, e);
  return [...rows.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id))
    .slice(0, limit);
}
export function stationState(
  station,
  events,
  { demo = false, memory = false, providerError = null, providers = [] } = {},
) {
  if (station.id === 'voice') return { tone: 'muted', label: 'Not enabled', detail: station.description };
  if (station.id === 'memory')
    return {
      tone: memory ? 'ok' : 'muted',
      label: memory ? 'Vault connected' : 'Connect vault',
      detail: 'Local journal; automatic sync requires this tab or the bridge to remain running.',
    };
  const latest = events.find((e) => e.station === station.id && !e.isCanary);
  if (latest?.status === 'error') return { tone: 'error', label: 'Error recorded', detail: latest.summary };
  if (latest?.status === 'attention') return { tone: 'warn', label: 'Needs review', detail: latest.summary };
  if (station.id === 'n8n') return { tone: 'muted', label: 'Runner gated', detail: station.description };
  if (station.id === 'comms' && !demo) {
    const twilio = providers.find((p) => /twilio/.test(p.connector_key));
    if (twilio && ['failed', 'reauthorization_required', 'degraded'].includes(twilio.status))
      return {
        tone: 'error',
        label: twilio.status.replaceAll('_', ' '),
        detail: 'Open activation to inspect the provider connection.',
      };
    return {
      tone: 'muted',
      label: latest ? 'Evidence received' : 'Readiness unverified',
      detail:
        providerError ||
        (twilio
          ? `Provider: ${twilio.status}. ARC activation remains the authority.`
          : 'ARC-managed Twilio readiness is checked in client activation.'),
    };
  }
  return latest
    ? { tone: 'ok', label: demo ? 'Demo evidence' : 'Evidence received', detail: latest.summary }
    : {
        tone: 'muted',
        label: 'Awaiting evidence',
        detail: 'No matching event in the loaded window. This is not a health check.',
      };
}
export const DEMO_TENANT = {
  id: 'demo-hvac',
  name: 'Summit Air & Heat',
  company: 'Summit Air & Heat',
  timezone: 'America/Denver',
};
export function demoSequence(scenario = 'recovery', start = Date.now()) {
  const types =
    scenario === 'safety'
      ? ['call_missed', 'lead_received', 'handoff_requested', 'lead_suppressed']
      : scenario === 'failure'
        ? ['call_missed', 'lead_received', 'lead_qualified', 'message_failed', 'handoff_requested']
        : [
            'call_missed',
            'lead_received',
            'lead_qualified',
            'sms_sent',
            'message_delivered',
            'reply_received',
            'routed',
            'lead_booked',
            'automation_completed',
          ];
  return types.map((event_type, i) =>
    adaptEvent(
      {
        id: `demo-${scenario}-${i}`,
        tenant_id: DEMO_TENANT.id,
        event_type,
        occurred_at: new Date(start + i * 4000).toISOString(),
        correlation_id: `demo-${scenario}`,
        payload:
          event_type === 'lead_suppressed'
            ? { reason_code: 'opt_out' }
            : event_type === 'message_failed'
              ? { error_code: '30007' }
              : {},
        status: event_type === 'message_failed' ? 'failure' : 'success',
      },
      DEMO_TENANT.id,
    ),
  );
}
export function memoryNote(event) {
  // JSON strings are valid YAML scalars and cannot inject new frontmatter properties.
  const q = (v) => JSON.stringify(String(v ?? ''));
  return `---\nagent: ${q(AGENT.name)}\ntenant_id: ${q(event.tenantId)}\nevent_id: ${q(event.id)}\nevent_type: ${q(event.type)}\noccurred_at: ${q(event.timestamp)}\nstation: ${q(event.station)}\nsynthetic: ${event.isCanary || event.tenantId === DEMO_TENANT.id}\n---\n\n# ${safeScalar(event.summary)}\n\nRecorded workflow evidence, not private model reasoning.\n\n- Status: ${q(event.status)}\n- Correlation: ${q(safeScalar(event.correlationId) ?? 'none')}\n- Source event: ${q(event.id)}\n\n## Decision / outcome metadata\n\n${
    Object.entries(event.meta)
      .map(([k, v]) => `- ${k}: ${q(v)}`)
      .join('\n') || 'No structured decision metadata was recorded.'
  }\n\n[[Context]] · [[Index]]\n`;
}
export function safeFilePart(value) {
  const s = String(value);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(s)) throw new Error('Invalid memory path identifier');
  return s;
}
