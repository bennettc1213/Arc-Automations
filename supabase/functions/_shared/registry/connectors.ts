/**
 * The connector registry.
 *
 * A connector definition describes a **supported provider adapter type**. It is not a
 * tenant's connected account, and it says nothing about whether any particular
 * connection is authorised or healthy — ARC-130 owns tenant connections, ARC-120 owns
 * their live state.
 *
 * The rule this file is written to obey: **a capability listed here means ARC has
 * adapter code that does it and a test that proves it.** Twilio's API can do a great
 * many things; `twilio@1` declares the five ARC actually implements
 * (`_shared/twilio.ts`, `functions/twilio/index.ts`). Everything else is `planned`
 * with no capabilities at all, because a planned connector that claimed capabilities
 * would let a future module version resolve as satisfiable when nothing can serve it.
 *
 * No credential, token, secret, endpoint or environment-specific URL appears here.
 * The registry describes *types*; secrets live in function environment variables and,
 * later, in ARC-130's connector boundary.
 */

import {
  assertKnownCapabilities,
  type LifecycleStatus,
  SELECTABLE_STATUSES,
} from './capabilities.ts';

/** Who the account belongs to. Drives who is asked to reconnect it when it breaks. */
export const CONNECTION_OWNERS = ['arc', 'tenant'] as const;
export type ConnectionOwner = typeof CONNECTION_OWNERS[number];

export const AUTH_TYPES = [
  'arc_managed',   // ARC's own platform credential; the tenant connects nothing
  'oauth2',
  'api_key',
  'signed_webhook',
  'none',
] as const;
export type AuthType = typeof AUTH_TYPES[number];

export const PROVIDER_CATEGORIES = [
  'telephony',
  'messaging',
  'intake',
  'crm',
  'fsm',
  'calendar',
  'accounting',
  'ai',
] as const;
export type ProviderCategory = typeof PROVIDER_CATEGORIES[number];

export interface ConnectorVersion {
  connectorKey: string;
  version: number;
  status: LifecycleStatus;
  /** capability keys this adapter version implements and verifies. */
  capabilities: readonly string[];

  auth: {
    type: AuthType;
    owner: ConnectionOwner;
    supportsReauthorization: boolean;
    expectsRefreshToken: boolean;
  };

  behaviour: {
    /** how ARC proves an inbound webhook really came from the provider. */
    webhookSignature: 'hmac_sha1_twilio' | 'shared_key' | 'none';
    healthCheck: 'provider_api' | 'inbound_only' | 'none';
    tokenRefresh: 'not_applicable' | 'automatic' | 'manual';
    rateLimit: string | null;
    /** whether ARC can ask the provider what happened to an ambiguous request. */
    supportsReconciliation: boolean;
    /** whether the provider honours an idempotency key ARC supplies. */
    supportsIdempotencyKey: boolean;
  };

  deprecatedBy?: { connectorKey: string; version: number };
  /** why this is not `available`, in words an operator can act on. */
  limitation?: string;
}

export interface ConnectorDefinition {
  key: string;
  displayName: string;
  category: ProviderCategory;
  status: LifecycleStatus;
  description: string;
  versions: readonly ConnectorVersion[];
}

export const CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([
  {
    key: 'twilio',
    displayName: 'Twilio',
    category: 'telephony',
    status: 'available',
    description: 'The number that forwards a call and texts the caller back.',
    versions: [
      {
        connectorKey: 'twilio',
        version: 1,
        status: 'available',
        /* each of these five is implemented and tested: voice + dial-status in
           `functions/twilio/index.ts`, send in `TwilioRestSender`, inbound SMS and
           message-status in the same webhook. */
        capabilities: [
          'receive_calls',
          'receive_call_status',
          'send_sms',
          'receive_sms',
          'receive_delivery_status',
        ],
        auth: {
          /* one Arc platform account. a tenant's subaccount SID, messaging service SID
             and number are non-secret identifiers in `module_configs.config.twilio`. */
          type: 'arc_managed',
          owner: 'arc',
          supportsReauthorization: false,
          expectsRefreshToken: false,
        },
        behaviour: {
          webhookSignature: 'hmac_sha1_twilio',
          healthCheck: 'provider_api',
          tokenRefresh: 'not_applicable',
          rateLimit: 'provider-enforced; ARC applies bounded backoff',
          /* ARC-015 left the interface and the quarantine state; the poller is ARC-200,
             so this is honestly false until that lands. */
          supportsReconciliation: false,
          supportsIdempotencyKey: false,
        },
        limitation: 'Reconciliation of an ambiguous send is manual until ARC-200.',
      },
    ],
  },
  {
    key: 'arc_web_intake',
    displayName: 'ARC website intake',
    category: 'intake',
    status: 'available',
    description: 'A form on the client’s own site posting leads into ARC.',
    versions: [
      {
        connectorKey: 'arc_web_intake',
        version: 1,
        status: 'available',
        capabilities: ['receive_web_leads'],
        auth: {
          type: 'signed_webhook',
          owner: 'arc',
          supportsReauthorization: true,   // an intake key can be reissued
          expectsRefreshToken: false,
        },
        behaviour: {
          webhookSignature: 'shared_key',
          healthCheck: 'inbound_only',
          tokenRefresh: 'not_applicable',
          rateLimit: 'per-key and per-IP, in-process per instance',
          supportsReconciliation: false,
          supportsIdempotencyKey: true,   // deterministic correlation id at intake
        },
        limitation:
          'Origin, honeypot and dwell checks are client-controlled; server-verifiable anti-abuse is still open (audit G-C5).',
      },
    ],
  },
  {
    key: 'anthropic',
    displayName: 'Anthropic',
    category: 'ai',
    status: 'available',
    description: 'Optional reply classification, inside ARC’s deterministic safety fence.',
    versions: [
      {
        connectorKey: 'anthropic',
        version: 1,
        status: 'available',
        capabilities: ['classify_text'],
        auth: {
          type: 'api_key',
          owner: 'arc',
          supportsReauthorization: false,
          expectsRefreshToken: false,
        },
        behaviour: {
          webhookSignature: 'none',
          healthCheck: 'none',
          tokenRefresh: 'not_applicable',
          rateLimit: 'provider-enforced; 8s client timeout',
          supportsReconciliation: false,
          supportsIdempotencyKey: false,
        },
      },
    ],
  },

  /* ── planned. no capabilities, deliberately. ──────────────
     A planned connector that declared capabilities would let a module version resolve
     as satisfiable when no adapter exists to serve it. These rows exist so the roadmap
     has stable keys, and for nothing else. */
  {
    key: 'google_calendar',
    displayName: 'Google Calendar',
    category: 'calendar',
    status: 'planned',
    description: 'Booking into a connected calendar. No adapter exists yet.',
    versions: [],
  },
  {
    key: 'jobber',
    displayName: 'Jobber',
    category: 'fsm',
    status: 'planned',
    description: 'Field-service management. No adapter exists yet.',
    versions: [],
  },
  {
    key: 'housecall_pro',
    displayName: 'Housecall Pro',
    category: 'fsm',
    status: 'planned',
    description: 'Field-service management. No adapter exists yet.',
    versions: [],
  },
  {
    key: 'servicetitan',
    displayName: 'ServiceTitan',
    category: 'fsm',
    status: 'planned',
    description: 'Field-service management. No adapter exists yet.',
    versions: [],
  },
  {
    key: 'gohighlevel',
    displayName: 'GoHighLevel',
    category: 'crm',
    status: 'planned',
    description: 'CRM and pipelines. No adapter exists yet.',
    versions: [],
  },
]);

const BY_KEY = new Map(CONNECTORS.map((c) => [c.key, c]));

export function getConnector(key: string): ConnectorDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** Resolve one exact version. Deprecated and retired versions still resolve. */
export function getConnectorVersion(key: string, version: number): ConnectorVersion | null {
  return BY_KEY.get(key)?.versions.find((v) => v.version === version) ?? null;
}

/** The newest version a tenant could actually be given. */
export function latestSelectableConnectorVersion(key: string): ConnectorVersion | null {
  const versions = (BY_KEY.get(key)?.versions ?? [])
    .filter((v) => SELECTABLE_STATUSES.includes(v.status))
    .sort((a, b) => b.version - a.version);
  return versions[0] ?? null;
}

/** Every capability any currently-selectable connector version provides. */
export function availableCapabilities(): string[] {
  const keys = new Set<string>();
  for (const connector of CONNECTORS) {
    for (const version of connector.versions) {
      if (!SELECTABLE_STATUSES.includes(version.status)) continue;
      for (const capability of version.capabilities) keys.add(capability);
    }
  }
  return [...keys].sort();
}

/**
 * Which connector versions could satisfy a capability.
 *
 * "Could", not "does": this answers a design question, never an operational one. It
 * does not know whether a tenant has connected anything.
 */
export function connectorsProviding(capability: string): ConnectorVersion[] {
  const out: ConnectorVersion[] = [];
  for (const connector of CONNECTORS) {
    for (const version of connector.versions) {
      if (version.capabilities.includes(capability)) out.push(version);
    }
  }
  return out;
}

/** Called by the drift tests: every declared capability must be a real one. */
export function validateConnectorRegistry(): void {
  const seen = new Set<string>();
  for (const connector of CONNECTORS) {
    if (seen.has(connector.key)) throw new Error(`duplicate connector key: ${connector.key}`);
    seen.add(connector.key);

    const versions = new Set<number>();
    for (const version of connector.versions) {
      if (versions.has(version.version)) {
        throw new Error(`duplicate version ${version.version} for connector ${connector.key}`);
      }
      versions.add(version.version);

      if (version.connectorKey !== connector.key) {
        throw new Error(`connector version ${connector.key}@${version.version} carries the wrong key`);
      }
      assertKnownCapabilities(version.capabilities, `connector ${connector.key}@${version.version}`);

      /* the invariant that keeps the roadmap honest. */
      if (!SELECTABLE_STATUSES.includes(version.status) && version.capabilities.length > 0) {
        throw new Error(
          `connector ${connector.key}@${version.version} is ${version.status} but claims capabilities`,
        );
      }
    }

    if (SELECTABLE_STATUSES.includes(connector.status) && connector.versions.length === 0) {
      throw new Error(`connector ${connector.key} is ${connector.status} but has no versions`);
    }
  }
}
