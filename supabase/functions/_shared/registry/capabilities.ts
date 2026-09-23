/**
 * The capability vocabulary.
 *
 * A capability is a thing ARC's adapter code can actually do with a provider — not a
 * thing the provider's API theoretically offers. `send_sms` means "ARC has a tested
 * adapter that sends an SMS and reports what happened", which is why the list below
 * is short and why most of it is Twilio.
 *
 * Modules depend on capabilities, never on provider brands. That is the whole point:
 * Lead Recovery needs "something that can receive a missed call and something that
 * can send a text", and whether that is Twilio or a future provider is a connector
 * question, not a module question.
 *
 * Two things a capability declaration is **not**:
 *
 *   - It is not a claim that any tenant has connected that provider. ARC-130 owns
 *     tenant connection records; this file describes adapter functionality only.
 *   - It is not a claim that a connection is healthy or authorised right now.
 *     ARC-120 owns that, and it reads live state rather than this table.
 */

export const CAPABILITY_CATEGORIES = [
  'telephony',
  'messaging',
  'intake',
  'crm',
  'calendar',
  'ai',
] as const;
export type CapabilityCategory = typeof CAPABILITY_CATEGORIES[number];

/** Which way the data or the effect flows, from ARC's point of view. */
export const CAPABILITY_DIRECTIONS = ['read', 'write', 'receive', 'send'] as const;
export type CapabilityDirection = typeof CAPABILITY_DIRECTIONS[number];

/**
 * How much damage a mistake here does.
 *
 * `high` is reserved for capabilities that reach a member of the public. It is what
 * ARC-120 will key "this needs shadow mode and a canary before activation" off.
 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

export const LIFECYCLE_STATUSES = [
  'planned',
  'internal',
  'pilot',
  'available',
  'deprecated',
  'retired',
] as const;
export type LifecycleStatus = typeof LIFECYCLE_STATUSES[number];

/** Statuses a tenant may actually be given. Everything else is roadmap or history. */
export const SELECTABLE_STATUSES: LifecycleStatus[] = ['pilot', 'available'];

export interface CapabilityDefinition {
  key: string;
  description: string;
  category: CapabilityCategory;
  direction: CapabilityDirection;
  risk: RiskLevel;
  /** true when exercising this reaches something outside ARC — a handset, a CRM row. */
  externalSideEffect: boolean;
  /** true when the law or the opt-out list has an opinion about using it. */
  consentRelevant: boolean;
  /**
   * true when an outcome can be ambiguous and has to be settled afterwards.
   *
   * ARC-015 built exactly this for `send_sms`: a provider that does not answer leaves
   * an attempt in `reconciliation_required` rather than being retried.
   */
  reconciliationRequired: boolean;
  status: LifecycleStatus;
  deprecatedBy?: string;
}

/**
 * Every capability ARC recognises.
 *
 * Adding one here is a claim that adapter code exists for it somewhere. A capability
 * with no connector declaring it is caught by the drift tests as dead vocabulary.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  {
    key: 'receive_calls',
    description: 'Accept an inbound voice webhook and answer it with call-routing instructions.',
    category: 'telephony',
    direction: 'receive',
    risk: 'medium',
    externalSideEffect: true,   // it forwards a live call to a human being
    consentRelevant: false,
    reconciliationRequired: false,
    status: 'available',
  },
  {
    key: 'receive_call_status',
    description: 'Accept the dial-result callback that says whether a forwarded call was answered.',
    category: 'telephony',
    direction: 'receive',
    risk: 'low',
    externalSideEffect: false,
    consentRelevant: false,
    reconciliationRequired: false,
    status: 'available',
  },
  {
    key: 'send_sms',
    description: 'Send an SMS to a member of the public and report whether the provider accepted it.',
    category: 'messaging',
    direction: 'send',
    risk: 'high',
    externalSideEffect: true,
    consentRelevant: true,
    reconciliationRequired: true,
    status: 'available',
  },
  {
    key: 'receive_sms',
    description: 'Accept an inbound SMS webhook, including STOP and other opt-out keywords.',
    category: 'messaging',
    direction: 'receive',
    risk: 'low',
    externalSideEffect: false,
    consentRelevant: true,
    reconciliationRequired: false,
    status: 'available',
  },
  {
    key: 'receive_delivery_status',
    description: 'Accept the delivery callback that settles whether a sent message arrived.',
    category: 'messaging',
    direction: 'receive',
    risk: 'low',
    externalSideEffect: false,
    consentRelevant: false,
    reconciliationRequired: false,
    status: 'available',
  },
  {
    key: 'receive_web_leads',
    description: 'Accept a lead submitted from a form on the client’s own website.',
    category: 'intake',
    direction: 'receive',
    risk: 'medium',
    externalSideEffect: false,
    consentRelevant: true,
    reconciliationRequired: false,
    status: 'available',
  },
  {
    key: 'classify_text',
    description: 'Classify free text with a model, within ARC’s deterministic safety fence.',
    category: 'ai',
    direction: 'read',
    risk: 'medium',
    /* a classifier never writes a customer-facing message — it can only add caution to
       what the deterministic rules already decided (`_shared/engine/rules.ts`). */
    externalSideEffect: false,
    consentRelevant: false,
    reconciliationRequired: false,
    status: 'available',
  },
]);

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

export const CAPABILITY_KEYS: readonly string[] = Object.freeze(CAPABILITIES.map((c) => c.key));

export function getCapability(key: string): CapabilityDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** Unknown capability keys must fail loudly rather than being treated as unmet. */
export function assertKnownCapabilities(keys: readonly string[], context: string): void {
  const unknown = keys.filter((k) => !BY_KEY.has(k));
  if (unknown.length > 0) {
    throw new Error(`${context} references unknown capabilities: ${unknown.join(', ')}`);
  }
}
