/**
 * ARC-130 in memory — `MemoryStore`'s half of 0016, and the test credential store.
 *
 * Every rule here is one 0016 enforces, named after the function that enforces it, so a
 * test that passes against this store is a test about behaviour Postgres also guarantees:
 *
 *   beginAuthorization      arc_private.begin_authorization
 *   claimAuthorization      arc_private.claim_authorization
 *   completeAuthorization   arc_private.complete_authorization
 *   failAuthorization       arc_private.fail_authorization
 *   storeApiKey             arc_private.store_api_key
 *   recordConnectionEvent   arc_private.record_connection_event
 *   endConnection           arc_private.end_connection
 *   resolveCredential …     arc_private.resolve_credential, begin/commit/release_refresh,
 *                           purge_retired, credential_metadata (TestCredentialStore)
 *
 * Each operation is atomic: the tables are snapshotted first and restored if anything
 * throws, as a transaction would be. `tests/connections-db.test.js` runs the same
 * promises against real SQL where PGlite is available.
 *
 * `TestCredentialStore` is the approved local stand-in for Vault (ADR ARC-010 §20a): the
 * same contract, secrets in a private Map, no cryptography — and a constructor that
 * refuses to run in production or staging.
 */

import { MemoryConfigStore } from '../config/memory.ts';
import { type ConnectorCatalog, REGISTRY_CATALOG } from './catalog.ts';
import type { CommitRefreshInput, CredentialStore, CredentialUseContext, RefreshLease, ResolvedCredential } from './credential-store.ts';
import {
  type ConnectionActorType,
  ConnectionError,
  type ConnectionErrorCode,
  type ConnectionEventRow,
  type ConnectionFact,
  type ConnectionRow,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialVersionStatus,
  factOf,
  legalConnectionTransition,
  parseConnectionStatus,
} from './model.ts';
import { SecretValue } from './redact.ts';
import { assertTestDoubleAllowed, type RuntimeEnvironment } from './runtime-env.ts';
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

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const refuse = (code: ConnectionErrorCode, message: string): never => {
  throw new ConnectionError(code, message);
};
const TERMINAL_OR_FAILED = ['revoked', 'disconnected', 'failed'];
const METADATA_SECRETS = /(access_?token|refresh_?token|id_?token|code_?verifier|client_?secret|api[_-]?key|password|bearer |eyJ[A-Za-z0-9_-]{8,}\.|vault)/i;
const DISPLAY_SECRETS = /(access_?token|refresh_?token|id_?token|api[_-]?key|secret|password|bearer |eyJ[A-Za-z0-9_-]{8,}\.)/i;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RETURN_PATH = /^\/(portal\/dashboard|ops\/console)(\/[A-Za-z0-9._~-]{1,64}){0,6}\/?$/;

export interface TenantMemberRow {
  tenantId: string;
  userId: string;
  role: 'owner' | 'staff';
}

interface SessionRow {
  id: string;
  tenantId: string;
  connectionId: string;
  connectorKey: string;
  connectorVersion: number;
  purpose: BeginAuthorizationInput['purpose'];
  initiatedBy: string;
  stateDigest: string;
  nonceDigest: string | null;
  pkceMethod: 'S256' | null;
  pkceVerifierRef: string | null;
  requestedScopes: string[];
  requestedCapabilities: string[];
  redirectUri: string;
  returnPath: string;
  expectedStatusVersion: number;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  outcome: 'pending' | 'exchanging' | 'completed' | 'denied' | 'expired' | 'failed';
  failureCode: string | null;
  idempotencyKey: string;
  correlationId: string | null;
}

interface CredentialVersionRow {
  id: string;
  connectionId: string;
  tenantId: string;
  version: number;
  kind: CredentialKind;
  status: CredentialVersionStatus;
  /** the opaque reference into the secret Map — never leaves this file. */
  secretRef: string | null;
  hint: string | null;
  createdAt: string;
  retiredAt: string | null;
  retireReason: string | null;
  purgedAt: string | null;
}

/**
 * The tables, and the in-memory "Vault". Shared by `MemoryConnectionStore` (the
 * connection operations) and `TestCredentialStore` (the credential operations), as 0016's
 * functions share one database.
 */
export class ConnectionTables {
  connections: ConnectionRow[] = [];
  connectionEvents: ConnectionEventRow[] = [];
  sessions: SessionRow[] = [];
  credentialVersions: CredentialVersionRow[] = [];
  tenantMembers: TenantMemberRow[] = [];
  /** the double's secrets. private to this module: nothing outside reads it. */
  readonly #secrets = new Map<string, string>();
  /** make the next secret write fail, as a Vault outage would. */
  failNextSecretWrite = false;
  /** make every secret deletion fail, to prove a purge failure never undoes a retirement. */
  failSecretDeletes = false;
  clock: () => Date = () => new Date();
  /** refresh leases (0016 keeps them on the row, out of the browser's column grant). */
  leases = new Map<string, { token: string; until: number }>();

  readonly operatorsOf: () => string[];
  constructor(operatorsOf: () => string[]) {
    this.operatorsOf = operatorsOf;
  }

  now(): string { return this.clock().toISOString(); }

  /* ── the double's Vault ── */
  putSecret(value: string, _name: string): string {
    if (this.failNextSecretWrite) {
      this.failNextSecretWrite = false;
      refuse('secret_storage_failed', 'the credential store refused the write');
    }
    const ref = crypto.randomUUID();
    this.#secrets.set(ref, value);
    return ref;
  }
  readSecret(ref: string): string | null { return this.#secrets.get(ref) ?? null; }
  dropSecret(ref: string): void {
    if (this.failSecretDeletes) throw new Error('secret deletion failed');
    this.#secrets.delete(ref);
  }
  /** how many secrets the double holds — for tests proving purges happen. */
  secretCount(): number { return this.#secrets.size; }
  /** every value held — ONLY for tests proving a sentinel reached the store and nowhere else. */
  secretValuesForTest(): string[] { return [...this.#secrets.values()]; }

  /** a transaction: everything, including the double's Vault, back as it was on a throw. */
  atomic<T>(fn: () => T): T {
    const before = {
      connections: clone(this.connections),
      connectionEvents: clone(this.connectionEvents),
      sessions: clone(this.sessions),
      credentialVersions: clone(this.credentialVersions),
      secrets: new Map(this.#secrets),
      leases: new Map(this.leases),
    };
    try {
      return fn();
    } catch (error) {
      this.connections = before.connections;
      this.connectionEvents = before.connectionEvents;
      this.sessions = before.sessions;
      this.credentialVersions = before.credentialVersions;
      this.leases = before.leases;
      this.#secrets.clear();
      for (const [k, v] of before.secrets) this.#secrets.set(k, v);
      throw error;
    }
  }

  /* ── helpers 0016 has too ── */

  requireManager(tenantId: string, actorId: string | null): void {
    if (!actorId || !(
      this.operatorsOf().includes(actorId)
      || this.tenantMembers.some((m) => m.tenantId === tenantId && m.userId === actorId && m.role === 'owner')
    )) {
      refuse('forbidden', 'managing this client\'s connections needs an operator or the client\'s owner');
    }
  }

  legalStatus(event: string, from: string, actor: ConnectionActorType): ConnectionRow['status'] {
    const parsed = parseConnectionStatus(from);
    const legal = legalConnectionTransition(event, parsed, actor);
    if (!legal.ok) refuse(legal.code, legal.message);
    return (legal as { to: ConnectionRow['status'] }).to;
  }

  recordEvent(row: Omit<ConnectionEventRow, 'id' | 'createdAt'>): void {
    if (METADATA_SECRETS.test(JSON.stringify(row.metadata))) refuse('invalid_request', 'event metadata may not carry anything secret-shaped');
    if (row.idempotencyKey && this.connectionEvents.some((e) => e.tenantId === row.tenantId && e.idempotencyKey === row.idempotencyKey)) {
      refuse('idempotency_conflict', 'this idempotency key was already used');
    }
    this.connectionEvents.push({ ...clone(row), id: crypto.randomUUID(), createdAt: this.now() });
  }

  findByKey(tenantId: string, key: string): ConnectionEventRow | null {
    return this.connectionEvents.find((e) => e.tenantId === tenantId && e.idempotencyKey === key) ?? null;
  }

  connection(tenantId: string, id: string): ConnectionRow | null {
    return this.connections.find((c) => c.id === id && c.tenantId === tenantId) ?? null;
  }

  /** the provider_connections_guard: every change advances the lock by one, terminal stays terminal. */
  update(row: ConnectionRow, patch: Partial<ConnectionRow>, bump: boolean): ConnectionRow {
    const next = { ...row, ...patch };
    if (TERMINAL_OR_FAILED.slice(0, 2).includes(row.status) && next.status !== row.status) {
      refuse('illegal_transition', `${row.status} is terminal — reconnect as a new connection`);
    }
    if (DISPLAY_SECRETS.test(JSON.stringify(next.displayMetadata))) refuse('invalid_request', 'display metadata may not carry anything secret-shaped');
    if (bump) next.statusVersion = row.statusVersion + 1;
    next.updatedAt = this.now();
    if (['revoked', 'disconnected'].includes(next.status) !== (next.endedAt !== null)) refuse('illegal_transition', 'an ended connection has an end');
    Object.assign(row, next);
    return row;
  }

  mutation(row: ConnectionRow, replayed = false): ConnectionMutation {
    return { replayed, connection: clone(row), credential: this.activeCredential(row.id) };
  }

  activeCredential(connectionId: string): CredentialMetadata | null {
    const v = this.credentialVersions.find((x) => x.connectionId === connectionId && x.status === 'active');
    return v ? metadataOf(v) : null;
  }

  replayed(tenantId: string, key: string): ConnectionMutation | null {
    const event = this.findByKey(tenantId, key);
    if (!event) return null;
    const row = event.connectionId ? this.connection(tenantId, event.connectionId) : null;
    if (!row) return null;
    return this.mutation(row, true);
  }

  /** arc_private.store_secret: new secret FIRST, then retire the old version, then the new row. */
  storeSecret(row: ConnectionRow, kind: CredentialKind, secret: string, hint: string | null, reason: string): number {
    if (!secret || secret.length > 16384) refuse('invalid_credential', 'the credential is empty or too large');
    const version = Math.max(0, ...this.credentialVersions.filter((v) => v.connectionId === row.id).map((v) => v.version)) + 1;
    const ref = this.putSecret(secret, `arc130:${row.id}:v${version}`);
    for (const v of this.credentialVersions) {
      if (v.connectionId === row.id && v.status === 'active') Object.assign(v, { status: 'retired', retiredAt: this.now(), retireReason: reason });
    }
    this.credentialVersions.push({
      id: crypto.randomUUID(), connectionId: row.id, tenantId: row.tenantId, version, kind, status: 'active',
      secretRef: ref, hint, createdAt: this.now(), retiredAt: null, retireReason: null, purgedAt: null,
    });
    return version;
  }

  /** arc_private.purge_retired: each deletion on its own; a failure is recorded, never undoes a retirement. */
  purgeRetired(tenantId: string, connectionId: string): { purged: number; failed: number } {
    let purged = 0;
    let failed = 0;
    for (const v of this.credentialVersions) {
      if (v.connectionId !== connectionId || v.tenantId !== tenantId || !['retired', 'purge_failed'].includes(v.status) || !v.secretRef) continue;
      try {
        this.dropSecret(v.secretRef);
        Object.assign(v, { status: 'purged', secretRef: null, purgedAt: this.now() });
        purged += 1;
      } catch {
        v.status = 'purge_failed';
        this.recordEvent(eventOf(tenantId, connectionId, null, 'credential_purge_failed', null, null, null, 'system', null, 'purge_failed', null, null, { credential_version: v.version }));
        failed += 1;
      }
    }
    if (purged > 0) {
      this.recordEvent(eventOf(tenantId, connectionId, null, 'credential_purged', null, null, null, 'system', null, 'retired_credentials_purged', null, null, { purged }));
    }
    return { purged, failed };
  }
}

function metadataOf(v: CredentialVersionRow): CredentialMetadata {
  return { connectionId: v.connectionId, version: v.version, kind: v.kind, status: v.status, hint: v.hint, createdAt: v.createdAt, retiredAt: v.retiredAt };
}

function eventOf(
  tenantId: string, connectionId: string | null, sessionId: string | null, eventType: string,
  fromStatus: string | null, toStatus: string | null, statusVersion: number | null,
  actorType: ConnectionActorType, actorId: string | null, reasonCode: string,
  correlationId: string | null, idempotencyKey: string | null, metadata: Record<string, unknown>,
): Omit<ConnectionEventRow, 'id' | 'createdAt'> {
  return { tenantId, connectionId, sessionId, eventType, fromStatus, toStatus, statusVersion, actorType, actorId, reasonCode, correlationId, idempotencyKey, metadata };
}

/* ── the credential half ────────────────────────────────── */

export class TestCredentialStore implements CredentialStore {
  readonly mechanism = 'test_double' as const;

  private readonly t: ConnectionTables;
  constructor(t: ConnectionTables, environment: RuntimeEnvironment) {
    assertTestDoubleAllowed(environment, 'the test credential store');
    this.t = t;
  }

  // deno-lint-ignore require-await
  async availability() {
    return { available: true, code: null };
  }

  // deno-lint-ignore require-await
  async resolveCredential(ctx: CredentialUseContext): Promise<ResolvedCredential> {
    const t = this.t;
    if (!['provider_operation', 'verify', 'refresh', 'revoke'].includes(ctx.operation)) {
      refuse('operation_not_permitted', 'a credential is resolved only for a named operation');
    }
    const row = t.connection(ctx.tenantId, ctx.connectionId);
    if (!row || row.connectorKey !== ctx.connectorKey) refuse('not_found', 'no such connection for this client');
    const status = parseConnectionStatus(row!.status);
    if (!status) refuse('connection_status_unknown', 'the stored connection status is not one this build knows');
    if (ctx.operation === 'provider_operation') {
      if (!['verified', 'degraded'].includes(status!)) refuse('credential_unavailable', `the connection is ${status} — nothing may use it`);
      if (!ctx.capability || !row!.verifiedCapabilities.includes(ctx.capability)) {
        refuse('operation_not_permitted', 'the connection is not verified for that capability');
      }
    } else if (ctx.operation === 'verify' || ctx.operation === 'refresh') {
      if (!['connected_unverified', 'verified', 'degraded'].includes(status!)) refuse('credential_unavailable', `the connection is ${status}`);
    } else if (['revoked', 'disconnected', 'failed', 'authorization_pending'].includes(status!)) {
      refuse('credential_unavailable', `the connection is ${status}`);
    }
    const version = t.credentialVersions.find((v) => v.connectionId === row!.id && v.tenantId === ctx.tenantId && v.status === 'active');
    if (!version || version.version !== row!.credentialVersion || !version.secretRef) {
      refuse('credential_unavailable', 'no active credential is stored for this connection');
    }
    const secret = t.readSecret(version!.secretRef!);
    if (secret === null) refuse('credential_unavailable', 'the stored credential could not be read');
    return { secret: new SecretValue(secret!), credentialVersion: version!.version, accessExpiresAt: row!.accessExpiresAt };
  }

  // deno-lint-ignore require-await
  async beginRefresh(input: { tenantId: string; connectionId: string; connectorKey: string; expectedCredentialVersion: number; leaseSeconds: number }): Promise<RefreshLease> {
    const t = this.t;
    return t.atomic(() => {
      if (!(input.leaseSeconds >= 5 && input.leaseSeconds <= 120)) refuse('invalid_request', 'a refresh lease is 5 to 120 seconds');
      const row = t.connection(input.tenantId, input.connectionId);
      if (!row || row.connectorKey !== input.connectorKey) refuse('not_found', 'no such connection for this client');
      if (!['connected_unverified', 'verified', 'degraded'].includes(row!.status) || !row!.refreshable) {
        refuse('credential_unavailable', 'this connection cannot be refreshed');
      }
      if (row!.credentialVersion !== input.expectedCredentialVersion) refuse('stale_version', 'the credential was already rotated — use the current one');
      const lease = t.leases.get(row!.id);
      if (lease && lease.until > t.clock().getTime()) refuse('refresh_in_progress', 'another refresh of this connection is in progress');
      const token = crypto.randomUUID();
      t.leases.set(row!.id, { token, until: t.clock().getTime() + input.leaseSeconds * 1000 });
      t.update(row!, { lastRefreshAttemptAt: t.now() }, false);
      return { leaseToken: token, credentialVersion: row!.credentialVersion };
    });
  }

  // deno-lint-ignore require-await
  async commitRefresh(input: CommitRefreshInput): Promise<ConnectionMutation> {
    const t = this.t;
    return t.atomic(() => {
      const replay = t.replayed(input.tenantId, input.idempotencyKey);
      if (replay) return replay;
      const row = t.connection(input.tenantId, input.connectionId);
      if (!row || row.connectorKey !== input.connectorKey) refuse('not_found', 'no such connection for this client');
      const lease = t.leases.get(row!.id);
      if (!lease || lease.token !== input.leaseToken || lease.until <= t.clock().getTime()) {
        refuse('refresh_in_progress', 'this refresh no longer holds the lease — its result is discarded');
      }
      if (row!.credentialVersion !== input.expectedCredentialVersion) refuse('stale_version', 'the credential was rotated by someone else');
      const to = t.legalStatus('credential_rotated', row!.status, 'system');
      const version = t.storeSecret(row!, 'oauth_tokens', input.secret.reveal() as string, null, 'refreshed');
      t.leases.delete(row!.id);
      t.update(row!, {
        credentialVersion: version,
        accessExpiresAt: input.accessExpiresAt,
        grantedScopes: input.grantedScopes ? [...new Set(input.grantedScopes)].sort() : row!.grantedScopes,
        refreshable: input.refreshable,
        lastRefreshResult: input.rotated ? 'rotated' : 'succeeded',
      }, true);
      t.recordEvent(eventOf(input.tenantId, row!.id, null, 'credential_rotated', to, to, row!.statusVersion, 'system', null,
        input.rotated ? 'refresh_token_rotated' : 'access_token_refreshed', input.correlationId, input.idempotencyKey,
        { credential_version: version, rotated: input.rotated }));
      t.purgeRetired(input.tenantId, row!.id);
      return t.mutation(row!);
    });
  }

  // deno-lint-ignore require-await
  async releaseRefresh(input: { tenantId: string; connectionId: string; leaseToken: string; result: string }): Promise<void> {
    const t = this.t;
    if (!['temporary_failure', 'permanent_failure', 'storage_failed', 'incomplete_response', 'abandoned'].includes(input.result)) {
      refuse('invalid_request', 'not a refresh result');
    }
    const row = t.connection(input.tenantId, input.connectionId);
    const lease = row ? t.leases.get(row.id) : null;
    if (!row || !lease || lease.token !== input.leaseToken) return;
    t.leases.delete(row.id);
    t.update(row, { lastRefreshResult: input.result }, false);
    t.recordEvent(eventOf(input.tenantId, row.id, null, 'refresh_failed', null, null, null, 'system', null, input.result, null, null, {}));
  }

  // deno-lint-ignore require-await
  async purgeRetired(input: { tenantId: string; connectionId: string }) {
    return this.t.purgeRetired(input.tenantId, input.connectionId);
  }

  // deno-lint-ignore require-await
  async listCredentialMetadata(tenantId: string, connectionId: string): Promise<CredentialMetadata[]> {
    return this.t.credentialVersions
      .filter((v) => v.tenantId === tenantId && v.connectionId === connectionId)
      .sort((a, b) => a.version - b.version)
      .map(metadataOf);
  }
}


/* ── the connection half ────────────────────────────────── */

export class MemoryConnectionStore extends MemoryConfigStore implements ConnectionStore {
  readonly connectionTables: ConnectionTables = new ConnectionTables(() => this.operators);
  connectorCatalog: ConnectorCatalog = REGISTRY_CATALOG;
  credentials: CredentialStore = new TestCredentialStore(this.connectionTables, 'test');

  /* convenient aliases for tests */
  get tenantMembers() { return this.connectionTables.tenantMembers; }
  get providerConnections() { return this.connectionTables.connections; }
  get connectionEvents() { return this.connectionTables.connectionEvents; }

  // deno-lint-ignore require-await
  async getConnection(tenantId: string, connectionId: string) {
    const row = this.connectionTables.connection(tenantId, connectionId);
    return row ? clone(row) : null;
  }

  // deno-lint-ignore require-await
  async listConnections(tenantId: string) {
    return this.connectionTables.connections.filter((c) => c.tenantId === tenantId).map(clone);
  }

  // deno-lint-ignore require-await
  async listConnectionEvents(tenantId: string, connectionId: string | null, limit: number) {
    return this.connectionTables.connectionEvents
      .filter((e) => e.tenantId === tenantId && (connectionId === null || e.connectionId === connectionId))
      .slice()
      .reverse()
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map(clone);
  }

  // deno-lint-ignore require-await
  async listConnectionFacts(tenantId: string): Promise<ConnectionFact[]> {
    return this.connectionTables.connections.filter((c) => c.tenantId === tenantId).map(factOf);
  }

  // deno-lint-ignore require-await
  async isConnectionManager(tenantId: string, actorId: string) {
    try {
      this.connectionTables.requireManager(tenantId, actorId);
      return true;
    } catch {
      return false;
    }
  }

  // deno-lint-ignore require-await
  async beginAuthorization(input: BeginAuthorizationInput): Promise<BeganAuthorization> {
    const t = this.connectionTables;
    return t.atomic(() => {
      t.requireManager(input.tenantId, input.actor.id);
      if (!['connect', 'reauthorize', 'replace'].includes(input.purpose)) refuse('invalid_request', 'purpose is connect, reauthorize or replace');
      if (!(input.ttlSeconds >= 60 && input.ttlSeconds <= 900)) refuse('invalid_request', 'an authorisation session lives between one and fifteen minutes');
      if (input.pkceMethod !== null && input.pkceMethod !== 'S256') refuse('pkce_failed', 'only S256 PKCE is accepted');
      if ((input.pkceMethod === null) !== (input.pkceVerifier === null)) refuse('pkce_failed', 'a PKCE method and verifier come together or not at all');
      if (input.pkceVerifier && !VERIFIER.test(input.pkceVerifier.reveal())) refuse('pkce_failed', 'the PKCE verifier is malformed');
      if (!DIGEST.test(input.stateDigest) || (input.nonceDigest !== null && !DIGEST.test(input.nonceDigest))) {
        refuse('invalid_request', 'state and nonce are stored as SHA-256 digests only');
      }
      if (!RETURN_PATH.test(input.returnPath)) refuse('invalid_request', 'return_path is not an internal path');

      const existing = t.sessions.find((s) => s.tenantId === input.tenantId && s.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.connectorKey !== input.connectorKey || existing.initiatedBy !== input.actor.id || existing.stateDigest !== input.stateDigest) {
          refuse('idempotency_conflict', 'this idempotency key was used for a different authorisation');
        }
        return { replayed: true, sessionId: existing.id, connectionId: existing.connectionId, expiresAt: existing.expiresAt };
      }

      const now = t.clock().getTime();
      if (t.sessions.filter((s) => s.tenantId === input.tenantId && s.consumedAt === null && Date.parse(s.expiresAt) > now).length >= 5) {
        refuse('rate_limited', 'too many authorisations are already open for this client — finish or wait for one');
      }

      let row: ConnectionRow | null;
      if (input.purpose === 'connect') {
        if (input.targetConnectionId) refuse('invalid_request', 'a new connection names no target');
        row = t.connections.find((c) => c.tenantId === input.tenantId && c.connectorKey === input.connectorKey && !TERMINAL_OR_FAILED.includes(c.status)) ?? null;
        if (row && row.status !== 'authorization_pending') {
          refuse('connection_exists', 'this client already has that provider connected — reauthorise or replace it');
        }
        if (!row) {
          row = newConnection(t, input.tenantId, input.connectorKey, input.connectorVersion, 'oauth2', input.actor.id);
          t.recordEvent(eventOf(input.tenantId, row.id, null, 'begin_authorization', null, 'authorization_pending', row.statusVersion, 'manager', input.actor.id, 'connection_started', input.correlationId, null, {}));
        }
      } else {
        if (!input.targetConnectionId || input.expectedStatusVersion === null) {
          refuse('invalid_request', 'reauthorising or replacing names the connection and the version read');
        }
        row = t.connection(input.tenantId, input.targetConnectionId!);
        if (!row) refuse('not_found', 'no such connection for this client');
        if (row!.connectorKey !== input.connectorKey) refuse('session_binding_mismatch', 'the connection is for another provider');
        if (row!.statusVersion !== input.expectedStatusVersion) {
          refuse('stale_version', `the connection is at version ${row!.statusVersion}, not ${input.expectedStatusVersion} — reload before acting`);
        }
      }

      const to = t.legalStatus('begin_authorization', row!.status, 'manager');
      if (to !== row!.status) t.update(row!, { status: to }, true);

      const verifierRef = input.pkceVerifier ? t.putSecret(input.pkceVerifier.reveal(), `arc130:pkce:${input.stateDigest}`) : null;
      const expiresAt = new Date(now + input.ttlSeconds * 1000).toISOString();
      const session: SessionRow = {
        id: crypto.randomUUID(), tenantId: input.tenantId, connectionId: row!.id, connectorKey: input.connectorKey,
        connectorVersion: input.connectorVersion, purpose: input.purpose, initiatedBy: input.actor.id,
        stateDigest: input.stateDigest, nonceDigest: input.nonceDigest, pkceMethod: input.pkceMethod,
        pkceVerifierRef: verifierRef, requestedScopes: [...new Set(input.requestedScopes)].sort(),
        requestedCapabilities: [...new Set(input.requestedCapabilities)].sort(), redirectUri: input.redirectUri,
        returnPath: input.returnPath, expectedStatusVersion: row!.statusVersion, createdAt: t.now(), expiresAt,
        consumedAt: null, outcome: 'pending', failureCode: null, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
      };
      if (t.sessions.some((s) => s.stateDigest === session.stateDigest)) refuse('invalid_request', 'that state was already issued');
      t.sessions.push(session);
      t.recordEvent(eventOf(input.tenantId, row!.id, session.id, 'authorization_initiated', row!.status, row!.status, row!.statusVersion,
        'manager', input.actor.id, input.purpose, input.correlationId, null,
        { purpose: input.purpose, scopes: session.requestedScopes, pkce: input.pkceMethod ?? 'none' }));
      return { replayed: false, sessionId: session.id, connectionId: row!.id, expiresAt };
    });
  }

  // deno-lint-ignore require-await
  async claimAuthorization(input: { stateDigest: string; actorId: string }): Promise<ClaimedAuthorization> {
    const t = this.connectionTables;
    /* refusals that are security events are recorded, then thrown — the record stays. */
    let refusal: ConnectionError | null = null;
    const result = t.atomic((): ClaimedAuthorization | null => {
      if (!DIGEST.test(input.stateDigest)) refuse('invalid_state', 'the authorisation state is malformed');
      const s = t.sessions.find((x) => x.stateDigest === input.stateDigest);
      if (!s) {
        refusal = new ConnectionError('invalid_state', 'no authorisation matches this state — start again');
        return null;
      }
      const binding = (extra: Partial<ClaimedAuthorization>): ClaimedAuthorization => ({
        sessionId: s.id, tenantId: s.tenantId, connectionId: s.connectionId, connectorKey: s.connectorKey,
        connectorVersion: s.connectorVersion, purpose: s.purpose, requestedScopes: [...s.requestedScopes],
        requestedCapabilities: [...s.requestedCapabilities], redirectUri: s.redirectUri, returnPath: s.returnPath,
        nonceDigest: s.nonceDigest, verifier: null, alreadyCompleted: false, ...extra,
      });
      if (s.consumedAt !== null) {
        if (s.outcome === 'completed' && s.initiatedBy === input.actorId) return binding({ alreadyCompleted: true });
        t.recordEvent(eventOf(s.tenantId, s.connectionId, s.id, 'authorization_replayed', null, null, null, 'manager', input.actorId, 'state_replayed', s.correlationId, null, {}));
        refusal = new ConnectionError('state_replayed', 'this authorisation was already used — start again');
        return null;
      }
      if (s.initiatedBy !== input.actorId) {
        t.recordEvent(eventOf(s.tenantId, s.connectionId, s.id, 'security_denial', null, null, null, 'manager', input.actorId, 'session_binding_mismatch', s.correlationId, null, {}));
        refusal = new ConnectionError('session_binding_mismatch', 'this authorisation was started by someone else');
        return null;
      }
      if (Date.parse(s.expiresAt) <= t.clock().getTime()) {
        if (s.pkceVerifierRef) t.dropSecret(s.pkceVerifierRef);
        Object.assign(s, { consumedAt: t.now(), outcome: 'expired', failureCode: 'state_expired', pkceVerifierRef: null });
        const row = t.connection(s.tenantId, s.connectionId)!;
        const from = row.status;
        const to = t.legalStatus('authorization_failed', from, 'system');
        if (to !== from) t.update(row, { status: to }, true);
        t.recordEvent(eventOf(s.tenantId, s.connectionId, s.id, 'authorization_expired', from, to, null, 'system', null, 'state_expired', s.correlationId, null, {}));
        refusal = new ConnectionError('state_expired', 'this authorisation took too long — start again');
        return null;
      }
      try {
        t.requireManager(s.tenantId, input.actorId);
      } catch {
        t.recordEvent(eventOf(s.tenantId, s.connectionId, s.id, 'security_denial', null, null, null, 'manager', input.actorId, 'forbidden', s.correlationId, null, {}));
        refusal = new ConnectionError('forbidden', 'you can no longer manage this client\'s connections');
        return null;
      }
      let verifier: SecretValue | null = null;
      if (s.pkceVerifierRef) {
        const value = t.readSecret(s.pkceVerifierRef);
        if (value === null) refuse('pkce_failed', 'the PKCE verifier for this authorisation is gone');
        verifier = new SecretValue(value!);
        t.dropSecret(s.pkceVerifierRef);
      }
      Object.assign(s, { consumedAt: t.now(), outcome: 'exchanging', pkceVerifierRef: null });
      return binding({ verifier });
    });
    if (refusal) throw refusal;
    return result!;
  }

  // deno-lint-ignore require-await
  async completeAuthorization(input: CompleteAuthorizationInput): Promise<ConnectionMutation> {
    const t = this.connectionTables;
    return t.atomic(() => {
      const key = `oauth:complete:${input.sessionId}`;
      const replay = t.replayed(input.tenantId, key);
      if (replay) return replay;
      const s = t.sessions.find((x) => x.id === input.sessionId);
      if (!s || s.tenantId !== input.tenantId) refuse('invalid_state', 'no such authorisation for this client');
      if (s!.initiatedBy !== input.actorId) refuse('session_binding_mismatch', 'this authorisation was started by someone else');
      if (s!.outcome !== 'exchanging') refuse('state_replayed', 'this authorisation is not awaiting completion');
      t.requireManager(input.tenantId, input.actorId);
      const row = t.connection(input.tenantId, s!.connectionId)!;
      if (row.statusVersion !== s!.expectedStatusVersion) refuse('stale_version', 'the connection changed while this authorisation was open — start again');
      let replaced = false;
      if (row.externalAccountId !== null && row.externalAccountId !== input.identity.accountId) {
        if (s!.purpose !== 'replace') refuse('account_mismatch', 'a different account was authorised than the one this connection belongs to');
        if (!input.confirmAccountReplacement) refuse('account_replacement_unconfirmed', 'replacing the connected account needs explicit confirmation');
        replaced = true;
      }
      const from = row.status;
      const to = t.legalStatus('complete_authorization', from, 'manager');
      const version = t.storeSecret(row, 'oauth_tokens', input.secret.reveal() as string, null, 'reauthorized');
      t.update(row, {
        status: to,
        externalAccountId: input.identity.accountId,
        externalAccountLabel: input.identity.label,
        displayMetadata: { ...input.identity.metadata },
        grantedScopes: [...new Set(input.grantedScopes)].sort(),
        verifiedCapabilities: [],
        credentialVersion: version,
        credentialHint: null,
        accessExpiresAt: input.accessExpiresAt,
        refreshable: input.refreshable,
        healthStatus: 'unverified',
        healthReason: null,
        connectedBy: row.connectedBy ?? input.actorId,
      }, true);
      t.leases.delete(row.id);
      s!.outcome = 'completed';
      if (replaced) {
        t.recordEvent(eventOf(input.tenantId, row.id, s!.id, 'connection_replaced', null, null, row.statusVersion, 'manager', input.actorId, 'account_replaced', input.correlationId, null, { explicitly_confirmed: true }));
      }
      t.recordEvent(eventOf(input.tenantId, row.id, s!.id, 'complete_authorization', from, to, row.statusVersion, 'manager', input.actorId,
        'authorization_completed', input.correlationId, key, { credential_version: version, scopes: row.grantedScopes, purpose: s!.purpose }));
      return t.mutation(row);
    });
  }

  // deno-lint-ignore require-await
  async failAuthorization(input: { sessionId: string; tenantId: string; actorId: string | null; code: string }): Promise<void> {
    const t = this.connectionTables;
    t.atomic(() => {
      if (!/^[a-z][a-z0-9_]{1,60}$/.test(input.code)) refuse('invalid_request', 'code is not a code');
      const s = t.sessions.find((x) => x.id === input.sessionId && x.tenantId === input.tenantId);
      if (!s) refuse('not_found', 'no such authorisation for this client');
      if (['completed', 'denied', 'expired', 'failed'].includes(s!.outcome)) return;
      if (input.actorId !== null && s!.initiatedBy !== input.actorId) refuse('session_binding_mismatch', 'this authorisation was started by someone else');
      if (s!.pkceVerifierRef) t.dropSecret(s!.pkceVerifierRef);
      Object.assign(s!, {
        consumedAt: s!.consumedAt ?? t.now(), pkceVerifierRef: null,
        outcome: input.code === 'provider_denied' ? 'denied' : 'failed', failureCode: input.code,
      });
      const row = t.connection(input.tenantId, s!.connectionId)!;
      const to = t.legalStatus('authorization_failed', row.status, 'system');
      if (to !== row.status) t.update(row, { status: to }, true);
      t.recordEvent(eventOf(input.tenantId, row.id, s!.id, input.code === 'provider_denied' ? 'authorization_denied' : 'authorization_failed',
        null, to, row.statusVersion, input.actorId === null ? 'system' : 'manager', input.actorId, input.code, s!.correlationId, null, {}));
    });
  }

  // deno-lint-ignore require-await
  async storeApiKey(input: StoreApiKeyInput): Promise<ConnectionMutation> {
    const t = this.connectionTables;
    return t.atomic(() => {
      t.requireManager(input.tenantId, input.actor.id);
      const replay = t.replayed(input.tenantId, input.idempotencyKey);
      if (replay) return replay;
      const verified = input.verification !== null;
      let row: ConnectionRow;
      let from: string | null;
      let event: 'complete_authorization' | 'credential_rotated';
      if (input.connectionId === null) {
        if (t.connections.some((c) => c.tenantId === input.tenantId && c.connectorKey === input.connectorKey && !TERMINAL_OR_FAILED.includes(c.status))) {
          refuse('connection_exists', 'this client already has that provider connected — rotate its key instead');
        }
        row = newConnection(t, input.tenantId, input.connectorKey, input.connectorVersion, 'api_key', input.actor.id);
        from = null;
        event = 'complete_authorization';
      } else {
        const found = t.connection(input.tenantId, input.connectionId);
        if (!found || found.connectorKey !== input.connectorKey) refuse('not_found', 'no such connection for this client');
        row = found!;
        if (row.authMethod !== 'api_key') refuse('unsupported_auth_method', 'this connection is not an API-key connection');
        if (input.expectedStatusVersion === null || input.expectedCredentialVersion === null
          || row.statusVersion !== input.expectedStatusVersion || row.credentialVersion !== input.expectedCredentialVersion) {
          refuse('stale_version', 'the connection changed since it was read — reload before rotating');
        }
        from = row.status;
        event = ['verified', 'degraded', 'connected_unverified'].includes(row.status) ? 'credential_rotated' : 'complete_authorization';
        if (event === 'credential_rotated' && ['verified', 'degraded'].includes(row.status) && !verified) {
          refuse('invalid_credential', 'a working key is replaced only by one the provider has accepted');
        }
        if (row.externalAccountId !== null && input.verification && input.verification.accountId !== row.externalAccountId && !input.confirmAccountReplacement) {
          refuse('account_replacement_unconfirmed', 'the new key belongs to a different account — confirm the replacement explicitly');
        }
      }
      const to = t.legalStatus(event, row.status, 'manager');
      const version = t.storeSecret(row, 'api_key', input.secret.reveal() as string, input.hint, 'rotated');
      t.update(row, {
        status: to,
        externalAccountId: input.verification?.accountId ?? row.externalAccountId,
        externalAccountLabel: input.verification?.label ?? row.externalAccountLabel,
        verifiedCapabilities: verified && to === 'verified' ? row.verifiedCapabilities : [],
        credentialVersion: version,
        credentialHint: input.hint,
        healthStatus: verified && to === 'verified' ? row.healthStatus : 'unverified',
      }, true);
      t.recordEvent(eventOf(input.tenantId, row.id, null, event, from, row.status, row.statusVersion, 'manager', input.actor.id,
        input.connectionId === null ? 'api_key_stored' : 'api_key_rotated', input.correlationId, input.idempotencyKey,
        { credential_version: version, verified }));
      if (input.verification) {
        const vFrom = row.status;
        const vTo = t.legalStatus('verification_succeeded', vFrom, 'manager');
        t.update(row, {
          status: vTo,
          displayMetadata: { ...input.verification.metadata },
          verifiedCapabilities: [...new Set(input.verification.verifiedCapabilities)].sort(),
          lastVerifiedAt: t.now(),
          healthStatus: 'healthy',
          healthReason: null,
          healthCheckedAt: t.now(),
        }, true);
        t.recordEvent(eventOf(input.tenantId, row.id, null, 'verification_succeeded', vFrom, vTo, row.statusVersion, 'manager', input.actor.id,
          'api_key_verified', input.correlationId, null, { capabilities: row.verifiedCapabilities }));
      }
      t.purgeRetired(input.tenantId, row.id);
      return t.mutation(row);
    });
  }

  // deno-lint-ignore require-await
  async recordConnectionEvent(input: RecordEventInput): Promise<ConnectionMutation> {
    const t = this.connectionTables;
    return t.atomic(() => {
      if (!['verification_succeeded', 'verification_failed', 'provider_degraded', 'reauthorization_required'].includes(input.event)) {
        refuse('illegal_transition', `${input.event} is not recorded this way`);
      }
      if (input.actor.type === 'manager') {
        t.requireManager(input.tenantId, input.actor.id);
        if (input.expectedStatusVersion === null) refuse('stale_version', 'expected_status_version is required for a person\'s change');
      }
      const replay = t.replayed(input.tenantId, input.idempotencyKey);
      if (replay) return replay;
      const row = t.connection(input.tenantId, input.connectionId);
      if (!row) refuse('not_found', 'no such connection for this client');
      if (input.expectedStatusVersion !== null && row!.statusVersion !== input.expectedStatusVersion) {
        refuse('stale_version', `the connection is at version ${row!.statusVersion}, not ${input.expectedStatusVersion} — reload before acting`);
      }
      const from = row!.status;
      let event: string = input.event;
      let to = t.legalStatus(event, from, input.actor.type);
      let reason = input.reasonCode;
      if (event === 'verification_succeeded' || event === 'verification_failed') {
        const v = input.verification;
        if (!v) refuse('invalid_request', 'a verification result is required');
        if (row!.externalAccountId !== null && v!.accountId !== row!.externalAccountId) {
          t.recordEvent(eventOf(input.tenantId, row!.id, null, 'security_denial', from, from, row!.statusVersion, input.actor.type, input.actor.id, 'account_mismatch', input.correlationId, null, {}));
          event = 'verification_failed';
          to = t.legalStatus('verification_failed', from, input.actor.type);
          reason = 'account_mismatch';
        }
        const ok = event === 'verification_succeeded';
        t.update(row!, {
          status: to,
          grantedScopes: [...new Set(v!.grantedScopes)].sort(),
          verifiedCapabilities: ok ? [...new Set(v!.verifiedCapabilities)].sort() : [],
          externalAccountLabel: v!.label ?? row!.externalAccountLabel,
          lastVerifiedAt: ok ? t.now() : row!.lastVerifiedAt,
          healthStatus: ok ? 'healthy' : 'failing',
          healthReason: ok ? null : reason,
          healthCheckedAt: t.now(),
        }, true);
      } else {
        const status = input.health?.status && ['degraded', 'failing'].includes(input.health.status)
          ? input.health.status
          : event === 'provider_degraded' ? 'degraded' : 'failing';
        t.update(row!, {
          status: to,
          verifiedCapabilities: to === 'reauthorization_required' ? [] : row!.verifiedCapabilities,
          healthStatus: status,
          healthReason: reason,
          healthCheckedAt: t.now(),
        }, true);
        if (to === 'reauthorization_required') t.leases.delete(row!.id);
      }
      t.recordEvent(eventOf(input.tenantId, row!.id, null, event, from, to, row!.statusVersion, input.actor.type, input.actor.id,
        reason, input.correlationId, input.idempotencyKey, input.metadata ?? {}));
      return t.mutation(row!);
    });
  }

  // deno-lint-ignore require-await
  async endConnection(input: EndConnectionInput): Promise<ConnectionMutation> {
    const t = this.connectionTables;
    return t.atomic(() => {
      if (!['revoked', 'unsupported', 'ambiguous', 'not_attempted'].includes(input.providerRevocation)) {
        refuse('invalid_request', 'provider_revocation is revoked, unsupported, ambiguous or not_attempted');
      }
      if (input.actor.type === 'manager') {
        t.requireManager(input.tenantId, input.actor.id);
        if (input.expectedStatusVersion === null) refuse('stale_version', 'expected_status_version is required to end a connection');
      }
      const replay = t.replayed(input.tenantId, input.idempotencyKey);
      if (replay) return replay;
      const row = t.connection(input.tenantId, input.connectionId);
      if (!row) refuse('not_found', 'no such connection for this client');
      if (input.expectedStatusVersion !== null && row!.statusVersion !== input.expectedStatusVersion) {
        refuse('stale_version', `the connection is at version ${row!.statusVersion}, not ${input.expectedStatusVersion} — reload before acting`);
      }
      const from = row!.status;
      const to = t.legalStatus(input.event, from, input.actor.type);
      let retired = 0;
      for (const v of t.credentialVersions) {
        if (v.connectionId === row!.id && v.status === 'active') {
          Object.assign(v, { status: 'retired', retiredAt: t.now(), retireReason: input.event });
          retired += 1;
        }
      }
      t.leases.delete(row!.id);
      t.update(row!, {
        status: to, endedAt: t.now(), verifiedCapabilities: [], healthStatus: 'failing', healthReason: input.event, healthCheckedAt: t.now(),
      }, true);
      for (const s of t.sessions) {
        if (s.connectionId === row!.id && s.consumedAt === null) Object.assign(s, { consumedAt: t.now(), outcome: 'failed', failureCode: 'connection_ended' });
      }
      t.recordEvent(eventOf(input.tenantId, row!.id, null, input.event, from, to, row!.statusVersion, input.actor.type, input.actor.id,
        input.reasonCode, input.correlationId, input.idempotencyKey, { provider_revocation: input.providerRevocation }));
      if (retired > 0) {
        t.recordEvent(eventOf(input.tenantId, row!.id, null, 'credential_retired', null, null, row!.statusVersion, input.actor.type, input.actor.id, input.event, input.correlationId, null, { retired }));
      }
      t.purgeRetired(input.tenantId, row!.id);
      return { replayed: false, connection: clone(row!), credential: null };
    });
  }
}

function newConnection(t: ConnectionTables, tenantId: string, connectorKey: string, connectorVersion: number, authMethod: ConnectionRow['authMethod'], actorId: string): ConnectionRow {
  const now = t.now();
  const row: ConnectionRow = {
    id: crypto.randomUUID(), tenantId, connectorKey, connectorVersion, authMethod, status: 'authorization_pending', statusVersion: 1,
    externalAccountId: null, externalAccountLabel: null, displayMetadata: {}, grantedScopes: [], verifiedCapabilities: [],
    credentialVersion: 0, credentialHint: null, accessExpiresAt: null, refreshable: false, lastVerifiedAt: null,
    lastRefreshAttemptAt: null, lastRefreshResult: null, healthStatus: 'unverified', healthReason: null, healthCheckedAt: null,
    connectedBy: actorId, createdAt: now, updatedAt: now, endedAt: null,
  };
  t.connections.push(row);
  return row;
}
