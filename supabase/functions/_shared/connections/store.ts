/**
 * ARC-130 — the seam between the connection service and the database.
 *
 * Each method is ONE function of 0016, in one transaction: the connection row, its
 * credential version, the Vault secret, the authorisation session and the append-only
 * event, or none of them. Two implementations, as for ARC-110 and ARC-120: the in-memory
 * `MemoryConnectionStore` (which mirrors every refusal 0016 makes, named after it) and the
 * production `supabaseConnectionStore`, which calls the service-role-only RPCs.
 *
 * The credential half of this interface is `CredentialStore` (credential-store.ts) — the
 * only way anything reaches a secret. Nothing here returns a secret reference, and only
 * `claimAuthorization` and `resolveCredential` return secret material at all, each as a
 * `SecretValue`.
 */

import type { ConnectorCatalog } from './catalog.ts';
import type { CredentialStore } from './credential-store.ts';
import type {
  AuthorizationPurpose,
  ConnectionActor,
  ConnectionEvent,
  ConnectionEventRow,
  ConnectionFact,
  ConnectionRow,
  CredentialMetadata,
} from './model.ts';
import type { SecretValue } from './redact.ts';

export interface VerificationFacts {
  accountId: string;
  label: string | null;
  metadata: Record<string, string>;
  grantedScopes: string[];
  verifiedCapabilities: string[];
}

export interface ConnectionMutation {
  /** true when this idempotency key had already been applied — nothing changed now. */
  replayed: boolean;
  connection: ConnectionRow;
  credential: CredentialMetadata | null;
}

export interface BeginAuthorizationInput {
  tenantId: string;
  actor: ConnectionActor & { type: 'manager' };
  connectorKey: string;
  connectorVersion: number;
  purpose: AuthorizationPurpose;
  /** for reauthorize/replace: the connection it will land on, and the version the caller read. */
  targetConnectionId: string | null;
  expectedStatusVersion: number | null;
  stateDigest: string;
  nonceDigest: string | null;
  pkceVerifier: SecretValue | null;
  pkceMethod: 'S256' | null;
  requestedScopes: string[];
  requestedCapabilities: string[];
  redirectUri: string;
  returnPath: string;
  ttlSeconds: number;
  idempotencyKey: string;
  correlationId: string | null;
}

export interface BeganAuthorization {
  replayed: boolean;
  sessionId: string;
  connectionId: string;
  expiresAt: string;
}

export interface ClaimedAuthorization {
  sessionId: string;
  tenantId: string;
  connectionId: string;
  connectorKey: string;
  connectorVersion: number;
  purpose: AuthorizationPurpose;
  requestedScopes: string[];
  requestedCapabilities: string[];
  redirectUri: string;
  returnPath: string;
  nonceDigest: string | null;
  /** the PKCE verifier, read from Vault and deleted from it by this claim. */
  verifier: SecretValue | null;
  /** a duplicate callback of an authorisation this actor already completed. */
  alreadyCompleted: boolean;
}

export interface CompleteAuthorizationInput {
  sessionId: string;
  tenantId: string;
  actorId: string;
  /** the token bundle, serialised — goes to Vault and nowhere else. */
  secret: SecretValue;
  identity: { accountId: string; label: string | null; metadata: Record<string, string> };
  grantedScopes: string[];
  accessExpiresAt: string | null;
  refreshable: boolean;
  /** a different external account on an existing connection is refused unless this is set on a `replace` session. */
  confirmAccountReplacement: boolean;
  correlationId: string | null;
}

export interface StoreApiKeyInput {
  tenantId: string;
  actor: ConnectionActor & { type: 'manager' };
  /** null creates a connection; otherwise rotates this one. */
  connectionId: string | null;
  connectorKey: string;
  connectorVersion: number;
  expectedStatusVersion: number | null;
  expectedCredentialVersion: number | null;
  secret: SecretValue;
  hint: string | null;
  /** the provider already accepted this key; null when it could not be asked (stored unverified). */
  verification: VerificationFacts | null;
  confirmAccountReplacement: boolean;
  idempotencyKey: string;
  correlationId: string | null;
}

export interface RecordEventInput {
  tenantId: string;
  connectionId: string;
  event: Exclude<ConnectionEvent, 'begin_authorization' | 'complete_authorization' | 'disconnect' | 'revoke' | 'credential_rotated'>;
  actor: ConnectionActor;
  /** required for a person's request; the system passes null and is checked on the status instead. */
  expectedStatusVersion: number | null;
  reasonCode: string;
  verification?: VerificationFacts | null;
  health?: { status: ConnectionRow['healthStatus']; reason: string | null } | null;
  idempotencyKey: string;
  correlationId: string | null;
  metadata?: Record<string, unknown>;
}

export interface EndConnectionInput {
  tenantId: string;
  connectionId: string;
  event: 'disconnect' | 'revoke';
  actor: ConnectionActor;
  expectedStatusVersion: number | null;
  providerRevocation: 'revoked' | 'unsupported' | 'ambiguous' | 'not_attempted';
  reasonCode: string;
  idempotencyKey: string;
  correlationId: string | null;
}

export interface ConnectionStore {
  /** the connectors this runtime serves (catalog.ts). */
  readonly connectorCatalog: ConnectorCatalog;
  /** the credential half: Vault in production, the test double in tests. */
  readonly credentials: CredentialStore;

  getConnection(tenantId: string, connectionId: string): Promise<ConnectionRow | null>;
  listConnections(tenantId: string): Promise<ConnectionRow[]>;
  /** newest first. */
  listConnectionEvents(tenantId: string, connectionId: string | null, limit: number): Promise<ConnectionEventRow[]>;
  /** what ARC-120's readiness reads. */
  listConnectionFacts(tenantId: string): Promise<ConnectionFact[]>;
  /** whether `actorId` may manage this tenant's connections (an operator, or the tenant's owner). */
  isConnectionManager(tenantId: string, actorId: string): Promise<boolean>;

  beginAuthorization(input: BeginAuthorizationInput): Promise<BeganAuthorization>;
  /** atomic and one-time: the first claim of a state digest wins; every later one is refused or replayed. */
  claimAuthorization(input: { stateDigest: string; actorId: string }): Promise<ClaimedAuthorization>;
  completeAuthorization(input: CompleteAuthorizationInput): Promise<ConnectionMutation>;
  failAuthorization(input: { sessionId: string; tenantId: string; actorId: string | null; code: string }): Promise<void>;
  storeApiKey(input: StoreApiKeyInput): Promise<ConnectionMutation>;
  recordConnectionEvent(input: RecordEventInput): Promise<ConnectionMutation>;
  endConnection(input: EndConnectionInput): Promise<ConnectionMutation>;
}
