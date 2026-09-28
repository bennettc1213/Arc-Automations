/**
 * ARC-130 — the credential store: the one abstraction through which a secret is stored,
 * used, rotated, retired or deleted. Decision: ADR ARC-010 §20a (Supabase Vault, accepted
 * 2026-09-25).
 *
 *   SupabaseVaultCredentialStore   production and staging. Every operation is one
 *                                  service-role-only RPC of 0016; Vault itself is reached
 *                                  only by SECURITY DEFINER functions in `arc_private`,
 *                                  which no API role can see.
 *   TestCredentialStore            local tests only. The same behavioural contract, no
 *                                  cryptography, and a constructor that refuses to run
 *                                  anywhere production-capable.
 *
 * What the interface cannot do, on purpose: list secrets, fetch one by a Vault id, act on
 * a connection without naming its tenant and provider, resolve for anything but a named
 * operation on a connection whose status allows it, or hand back anything a browser
 * could be given. A resolved secret is a `SecretValue`, used immediately and dropped.
 */

import {
  ConnectionError,
  type CredentialMetadata,
  type CredentialOperation,
} from './model.ts';
import type { SecretValue } from './redact.ts';
import { assertTestDoubleAllowed, PRODUCTION_CAPABLE, type RuntimeEnvironment } from './runtime-env.ts';

export type CredentialMechanism = 'supabase_vault' | 'test_double';

export interface CredentialUseContext {
  tenantId: string;
  connectionId: string;
  connectorKey: string;
  operation: CredentialOperation;
  /** for `provider_operation`: the capability the operation exercises. */
  capability: string | null;
  /** a correlation id for the audit trail of the use. */
  correlationId: string | null;
}

export interface ResolvedCredential {
  secret: SecretValue;
  credentialVersion: number;
  accessExpiresAt: string | null;
}

export interface RefreshLease {
  leaseToken: string;
  credentialVersion: number;
}

export interface CommitRefreshInput {
  tenantId: string;
  connectionId: string;
  connectorKey: string;
  leaseToken: string;
  expectedCredentialVersion: number;
  secret: SecretValue;
  accessExpiresAt: string | null;
  /** the scopes the refreshed grant carries, when the provider said. */
  grantedScopes: string[] | null;
  /** whether the stored bundle still holds a refresh token. */
  refreshable: boolean;
  /** whether the provider issued a new refresh token (rotation). */
  rotated: boolean;
  idempotencyKey: string;
  correlationId: string | null;
}

export interface CredentialStore {
  readonly mechanism: CredentialMechanism;
  /** whether the mechanism can be used at all. Production fails closed on `false`. */
  availability(): Promise<{ available: boolean; code: string | null }>;
  /** resolve for one authorised internal operation. Refuses unless the connection allows it now. */
  resolveCredential(context: CredentialUseContext): Promise<ResolvedCredential>;
  /** single-flight: one lease per connection; refused while another is live or if the version moved. */
  beginRefresh(input: { tenantId: string; connectionId: string; connectorKey: string; expectedCredentialVersion: number; leaseSeconds: number }): Promise<RefreshLease>;
  /** persist the refreshed credential, then retire the old one — in that order, atomically. */
  commitRefresh(input: CommitRefreshInput): Promise<import('./store.ts').ConnectionMutation>;
  /** release a lease without a new credential, recording the (sanitised) result. */
  releaseRefresh(input: { tenantId: string; connectionId: string; leaseToken: string; result: string }): Promise<void>;
  /** delete retired secrets from the store; failures are recorded, never thrown with a value. */
  purgeRetired(input: { tenantId: string; connectionId: string }): Promise<{ purged: number; failed: number }>;
  /** safe metadata only: versions, kinds, statuses, hints. */
  listCredentialMetadata(tenantId: string, connectionId: string): Promise<CredentialMetadata[]>;
}

/**
 * The one place a credential store is chosen. Production-capable environments (and an
 * unset environment, which counts as production) get Vault or an error — never the test
 * double, whatever else is passed.
 */
export function selectCredentialStore(input: {
  environment: RuntimeEnvironment;
  vault: () => CredentialStore;
  testDouble?: (() => CredentialStore) | null;
}): CredentialStore {
  if (PRODUCTION_CAPABLE.includes(input.environment)) {
    const store = input.vault();
    if (store.mechanism !== 'supabase_vault') {
      throw new ConnectionError('environment_forbidden', `${input.environment} must use Supabase Vault`);
    }
    return store;
  }
  if (input.testDouble) {
    assertTestDoubleAllowed(input.environment, 'the test credential store');
    return input.testDouble();
  }
  return input.vault();
}

/** Production code calls this before relying on a store: an unavailable Vault is an error, not a fallback. */
export async function requireAvailable(store: CredentialStore): Promise<void> {
  const { available, code } = await store.availability();
  if (!available) {
    throw new ConnectionError('vault_unavailable', `the credential store is unavailable${code ? ` (${code})` : ''} — nothing was stored or used`);
  }
}
