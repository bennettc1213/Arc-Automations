/**
 * ARC-130 — the production adapter: provider connections through 0016's service-role-only
 * RPCs, and `SupabaseVaultCredentialStore`, the credential store for production and
 * staging.
 *
 * Every write is one RPC; the request travels as a JSON object and the secret, where one
 * is involved, as its own parameter — never inside the object, never in a column. The
 * database's refusals arrive as `arc_connection:<code>: …` and become `ConnectionError`;
 * any other database error becomes `secret_storage_failed` with NO database text attached,
 * because a constraint message can quote a value.
 *
 * Reads select named safe columns; the refresh lease is never read back, and no Vault
 * reference exists anywhere this adapter can see.
 */

import { type ConnectorCatalog, REGISTRY_CATALOG } from './catalog.ts';
import type { CommitRefreshInput, CredentialStore, CredentialUseContext, RefreshLease, ResolvedCredential } from './credential-store.ts';
import {
  ConnectionError,
  type ConnectionEventRow,
  type ConnectionFact,
  type ConnectionRow,
  type CredentialMetadata,
  factOf,
  parseConnectionStoreError,
} from './model.ts';
import { SecretValue } from './redact.ts';
import { PRODUCTION_CAPABLE, type RuntimeEnvironment } from './runtime-env.ts';
import type {
  BeganAuthorization,
  BeginAuthorizationInput,
  ClaimedAuthorization,
  CompleteAuthorizationInput,
  ConnectionMutation,
  ConnectionStore,
  EndConnectionInput,
  RecordEventInput,
  StoreApiKeyInput,
} from './store.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

export const CONNECTION_COLUMNS = [
  'id', 'tenant_id', 'connector_key', 'connector_version', 'auth_method', 'status', 'status_version',
  'external_account_id', 'external_account_label', 'display_metadata', 'granted_scopes', 'verified_capabilities',
  'credential_version', 'credential_hint', 'access_expires_at', 'refreshable', 'last_verified_at',
  'last_refresh_attempt_at', 'last_refresh_result', 'health_status', 'health_reason', 'health_checked_at',
  'connected_by', 'created_at', 'updated_at', 'ended_at',
].join(', ');

function raise(error: { message?: string } | null): never {
  throw parseConnectionStoreError(error?.message);
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

// deno-lint-ignore no-explicit-any
export function toConnection(row: any): ConnectionRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectorKey: row.connector_key,
    connectorVersion: Number(row.connector_version),
    authMethod: row.auth_method,
    status: row.status,
    statusVersion: Number(row.status_version),
    externalAccountId: row.external_account_id ?? null,
    externalAccountLabel: row.external_account_label ?? null,
    displayMetadata: row.display_metadata && typeof row.display_metadata === 'object' ? row.display_metadata : {},
    grantedScopes: list(row.granted_scopes),
    verifiedCapabilities: list(row.verified_capabilities),
    credentialVersion: Number(row.credential_version ?? 0),
    credentialHint: row.credential_hint ?? null,
    accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null,
    refreshable: row.refreshable === true,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    lastRefreshAttemptAt: row.last_refresh_attempt_at ? new Date(row.last_refresh_attempt_at).toISOString() : null,
    lastRefreshResult: row.last_refresh_result ?? null,
    healthStatus: row.health_status,
    healthReason: row.health_reason ?? null,
    healthCheckedAt: row.health_checked_at ? new Date(row.health_checked_at).toISOString() : null,
    connectedBy: row.connected_by ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
  };
}

// deno-lint-ignore no-explicit-any
function toEvent(row: any): ConnectionEventRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id ?? null,
    sessionId: row.session_id ?? null,
    eventType: row.event_type,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status ?? null,
    statusVersion: row.status_version === null || row.status_version === undefined ? null : Number(row.status_version),
    actorType: row.actor_type,
    actorId: row.actor_id ?? null,
    reasonCode: row.reason_code,
    correlationId: row.correlation_id ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// deno-lint-ignore no-explicit-any
function toCredential(row: any): CredentialMetadata | null {
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    version: Number(row.version),
    kind: row.kind,
    status: row.status,
    hint: row.hint ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
  };
}

// deno-lint-ignore no-explicit-any
function toMutation(data: any): ConnectionMutation {
  if (!data || !data.connection) throw new ConnectionError('secret_storage_failed', 'the connection store returned no connection');
  return { replayed: data.replayed === true, connection: toConnection(data.connection), credential: toCredential(data.credential) };
}

async function call(db: Db, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) raise(error);
  return data;
}

/* ── the credential store ───────────────────────────────── */

export class SupabaseVaultCredentialStore implements CredentialStore {
  readonly mechanism = 'supabase_vault' as const;
  private readonly db: Db;
  private readonly environment: RuntimeEnvironment;
  /**
   * `environment` defaults to production. Only an environment that says, in so many words,
   * development or test will accept the PGlite harness's Vault double as available.
   */
  constructor(db: Db, options: { environment?: RuntimeEnvironment } = {}) {
    this.db = db;
    this.environment = options.environment ?? 'production';
  }

  /** Vault, and only real Vault: the harness's double reports `test_double` and is refused outside tests. */
  async availability() {
    const { data, error } = await this.db.rpc('connection_credential_store_status');
    if (error || !data) return { available: false, code: 'status_unreadable' };
    const acceptable = data.mechanism === 'supabase_vault'
      || (data.mechanism === 'test_double' && !PRODUCTION_CAPABLE.includes(this.environment));
    if (!acceptable) return { available: false, code: `mechanism_${String(data.mechanism)}` };
    return { available: data.vault === true, code: data.vault === true ? null : 'vault_missing' };
  }

  async resolveCredential(ctx: CredentialUseContext): Promise<ResolvedCredential> {
    const data = await call(this.db, 'connection_resolve_credential', {
      p_request: {
        tenant_id: ctx.tenantId,
        connection_id: ctx.connectionId,
        connector_key: ctx.connectorKey,
        operation: ctx.operation,
        capability: ctx.capability,
      },
    });
    if (!data || typeof data.secret !== 'string') throw new ConnectionError('credential_unavailable', 'no credential was returned');
    return {
      secret: new SecretValue(data.secret),
      credentialVersion: Number(data.credential_version),
      accessExpiresAt: data.access_expires_at ? new Date(data.access_expires_at).toISOString() : null,
    };
  }

  async beginRefresh(input: { tenantId: string; connectionId: string; connectorKey: string; expectedCredentialVersion: number; leaseSeconds: number }): Promise<RefreshLease> {
    const data = await call(this.db, 'connection_begin_refresh', {
      p_request: {
        tenant_id: input.tenantId,
        connection_id: input.connectionId,
        connector_key: input.connectorKey,
        expected_credential_version: input.expectedCredentialVersion,
        lease_seconds: input.leaseSeconds,
      },
    });
    return { leaseToken: data.lease_token, credentialVersion: Number(data.credential_version) };
  }

  async commitRefresh(input: CommitRefreshInput): Promise<ConnectionMutation> {
    return toMutation(await call(this.db, 'connection_commit_refresh', {
      p_request: {
        tenant_id: input.tenantId,
        connection_id: input.connectionId,
        connector_key: input.connectorKey,
        lease_token: input.leaseToken,
        expected_credential_version: input.expectedCredentialVersion,
        access_expires_at: input.accessExpiresAt,
        ...(input.grantedScopes ? { granted_scopes: input.grantedScopes } : {}),
        refreshable: input.refreshable,
        rotated: input.rotated,
        idempotency_key: input.idempotencyKey,
        correlation_id: input.correlationId,
      },
      p_secret: input.secret.reveal(),
    }));
  }

  async releaseRefresh(input: { tenantId: string; connectionId: string; leaseToken: string; result: string }): Promise<void> {
    await call(this.db, 'connection_release_refresh', {
      p_request: { tenant_id: input.tenantId, connection_id: input.connectionId, lease_token: input.leaseToken, result: input.result },
    });
  }

  async purgeRetired(input: { tenantId: string; connectionId: string }) {
    const data = await call(this.db, 'connection_purge_retired', {
      p_request: { tenant_id: input.tenantId, connection_id: input.connectionId },
    });
    return { purged: Number(data?.purged ?? 0), failed: Number(data?.failed ?? 0) };
  }

  async listCredentialMetadata(tenantId: string, connectionId: string): Promise<CredentialMetadata[]> {
    const data = await call(this.db, 'connection_credential_metadata', { p_request: { tenant_id: tenantId, connection_id: connectionId } });
    return (Array.isArray(data) ? data : []).map((r) => toCredential(r)!);
  }
}

/* ── the connection store ───────────────────────────────── */

export function supabaseConnectionStore(
  db: Db,
  options: { catalog?: ConnectorCatalog; credentials?: CredentialStore; environment?: RuntimeEnvironment } = {},
): ConnectionStore {
  const credentials = options.credentials ?? new SupabaseVaultCredentialStore(db, { environment: options.environment });
  return {
    connectorCatalog: options.catalog ?? REGISTRY_CATALOG,
    credentials,

    async getConnection(tenantId, connectionId) {
      const { data, error } = await db.from('provider_connections').select(CONNECTION_COLUMNS)
        .eq('tenant_id', tenantId).eq('id', connectionId).maybeSingle();
      if (error) raise(error);
      return data ? toConnection(data) : null;
    },

    async listConnections(tenantId) {
      const { data, error } = await db.from('provider_connections').select(CONNECTION_COLUMNS)
        .eq('tenant_id', tenantId).order('created_at', { ascending: true });
      if (error) raise(error);
      return (data ?? []).map(toConnection);
    },

    async listConnectionEvents(tenantId, connectionId, limit) {
      let query = db.from('provider_connection_events').select('*').eq('tenant_id', tenantId);
      if (connectionId) query = query.eq('connection_id', connectionId);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 200)));
      if (error) raise(error);
      return (data ?? []).map(toEvent);
    },

    async listConnectionFacts(tenantId): Promise<ConnectionFact[]> {
      return (await this.listConnections(tenantId)).map(factOf);
    },

    async isConnectionManager(tenantId, actorId) {
      const [admin, owner] = await Promise.all([
        db.from('arc_admins').select('user_id').eq('user_id', actorId).maybeSingle(),
        db.from('tenant_members').select('user_id').eq('tenant_id', tenantId).eq('user_id', actorId).eq('role', 'owner').maybeSingle(),
      ]);
      return Boolean(admin.data) || Boolean(owner.data);
    },

    async beginAuthorization(input: BeginAuthorizationInput): Promise<BeganAuthorization> {
      const data = await call(db, 'connection_begin_authorization', {
        p_request: {
          tenant_id: input.tenantId,
          actor_id: input.actor.id,
          connector_key: input.connectorKey,
          connector_version: input.connectorVersion,
          auth_method: 'oauth2',
          purpose: input.purpose,
          target_connection_id: input.targetConnectionId,
          expected_status_version: input.expectedStatusVersion,
          state_digest: input.stateDigest,
          nonce_digest: input.nonceDigest,
          pkce_method: input.pkceMethod,
          requested_scopes: input.requestedScopes,
          requested_capabilities: input.requestedCapabilities,
          redirect_uri: input.redirectUri,
          return_path: input.returnPath,
          ttl_seconds: input.ttlSeconds,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
        },
        p_pkce_verifier: input.pkceVerifier ? input.pkceVerifier.reveal() : null,
      });
      return { replayed: data.replayed === true, sessionId: data.session_id, connectionId: data.connection_id, expiresAt: new Date(data.expires_at).toISOString() };
    },

    async claimAuthorization(input): Promise<ClaimedAuthorization> {
      const data = await call(db, 'connection_claim_authorization', { p_request: { state_digest: input.stateDigest, actor_id: input.actorId } });
      if (!data) throw new ConnectionError('invalid_state', 'no authorisation matches this state');
      if (data.refused) {
        const code = parseConnectionStoreError(`arc_connection:${data.refused}: ${data.message ?? ''}`);
        throw code;
      }
      return {
        sessionId: data.session_id,
        tenantId: data.tenant_id,
        connectionId: data.connection_id,
        connectorKey: data.connector_key,
        connectorVersion: Number(data.connector_version),
        purpose: data.purpose,
        requestedScopes: list(data.requested_scopes),
        requestedCapabilities: list(data.requested_capabilities),
        redirectUri: data.redirect_uri ?? '',
        returnPath: data.return_path,
        nonceDigest: data.nonce_digest ?? null,
        verifier: typeof data.verifier === 'string' ? new SecretValue(data.verifier) : null,
        alreadyCompleted: data.already_completed === true,
      };
    },

    async completeAuthorization(input: CompleteAuthorizationInput) {
      return toMutation(await call(db, 'connection_complete_authorization', {
        p_request: {
          session_id: input.sessionId,
          tenant_id: input.tenantId,
          actor_id: input.actorId,
          external_account_id: input.identity.accountId,
          external_account_label: input.identity.label,
          display_metadata: input.identity.metadata,
          granted_scopes: input.grantedScopes,
          access_expires_at: input.accessExpiresAt,
          refreshable: input.refreshable,
          confirm_account_replacement: input.confirmAccountReplacement,
          correlation_id: input.correlationId,
        },
        p_secret: input.secret.reveal(),
      }));
    },

    async failAuthorization(input) {
      await call(db, 'connection_fail_authorization', {
        p_request: { session_id: input.sessionId, tenant_id: input.tenantId, actor_id: input.actorId, code: input.code },
      });
    },

    async storeApiKey(input: StoreApiKeyInput) {
      return toMutation(await call(db, 'connection_store_api_key', {
        p_request: {
          tenant_id: input.tenantId,
          actor_id: input.actor.id,
          connection_id: input.connectionId,
          connector_key: input.connectorKey,
          connector_version: input.connectorVersion,
          expected_status_version: input.expectedStatusVersion,
          expected_credential_version: input.expectedCredentialVersion,
          hint: input.hint,
          verified: input.verification !== null,
          external_account_id: input.verification?.accountId ?? null,
          external_account_label: input.verification?.label ?? null,
          display_metadata: input.verification?.metadata ?? {},
          verified_capabilities: input.verification?.verifiedCapabilities ?? [],
          confirm_account_replacement: input.confirmAccountReplacement,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
        },
        p_secret: input.secret.reveal(),
      }));
    },

    async recordConnectionEvent(input: RecordEventInput) {
      return toMutation(await call(db, 'connection_record_event', {
        p_request: {
          tenant_id: input.tenantId,
          connection_id: input.connectionId,
          event: input.event,
          actor_type: input.actor.type,
          actor_id: input.actor.id,
          expected_status_version: input.expectedStatusVersion,
          reason_code: input.reasonCode,
          verification: input.verification
            ? {
              account_id: input.verification.accountId,
              label: input.verification.label,
              granted_scopes: input.verification.grantedScopes,
              verified_capabilities: input.verification.verifiedCapabilities,
            }
            : null,
          health: input.health ?? null,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
          metadata: input.metadata ?? {},
        },
      }));
    },

    async endConnection(input: EndConnectionInput) {
      const data = await call(db, 'connection_end', {
        p_request: {
          tenant_id: input.tenantId,
          connection_id: input.connectionId,
          event: input.event,
          actor_type: input.actor.type,
          actor_id: input.actor.id,
          expected_status_version: input.expectedStatusVersion,
          provider_revocation: input.providerRevocation,
          reason_code: input.reasonCode,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
        },
      });
      return toMutation(data);
    },
  };
}
