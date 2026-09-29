# ARC-130 — Secure Provider Connections and OAuth

> Status: **implemented and verified locally; hosted Vault verification pending** (§15).
> Not production-ready until that checklist passes. No secret value appears in this
> document, in the tests' fixtures, or in any migration.

A client connects an external provider — an OAuth account, or an API key — to ARC once.
Every module whose requirements that provider's capabilities satisfy can then use the
connection. The credential lives in **Supabase Vault** (ADR ARC-010 §20a, accepted
2026-09-25). Every other table holds metadata and nothing a browser, a log, a runner or n8n
could replay.

| Piece | Where |
|---|---|
| Vocabulary, legal transitions, typed errors | `supabase/functions/_shared/connections/model.ts` |
| Registry view (ARC-100), provider resolution | `connections/catalog.ts`, `registry/connectors.ts` (`TenantConnectionSpec`) |
| Adapters, guarded transport, OIDC | `connections/adapter.ts` |
| State, PKCE, nonce, redirect, return path | `connections/oauth.ts` |
| Credential store (the one abstraction) | `connections/credential-store.ts` |
| Production adapter + `SupabaseVaultCredentialStore` | `connections/supabase-connection-store.ts` |
| Test double + in-memory mirror of 0016 | `connections/memory.ts` (`TestCredentialStore`, `MemoryConnectionStore`) |
| Service (OAuth, keys, refresh, verify, end) | `connections/service.ts` |
| ARC-120 readiness evidence | `connections/readiness.ts` → `lifecycle/readiness.ts` |
| Lifecycle effects of loss and recovery | `connections/lifecycle-effects.ts` |
| Connector gateway seam, n8n boundary | `connections/gateway.ts` |
| Redaction, `SecretValue`, the only logger | `connections/redact.ts` |
| Environment guard | `connections/runtime-env.ts` |
| Synthetic providers (tests only) | `connections/synthetic.ts`, `tests/synthetic-provider.js` |
| HTTP surface | `supabase/functions/connections/` (`handler.ts`, `index.ts`) |
| Schema, Vault access, RLS, grants | `supabase/migrations/0016_provider_connections.sql` |

---

## 1. What exists today (credential inventory)

These are locations and patterns only. No values were read.

| What | Where it lives | Status after ARC-130 |
|---|---|---|
| ARC's own platform secrets (Twilio account, Anthropic key, n8n API key, dispatch key, service role) | Supabase function secrets | Unchanged. These are ARC's secrets, not a tenant's; `arc_managed` connectors do not get tenant connections |
| Tenant Twilio subaccount / messaging service / number | Published Lead Recovery configuration (`twilio`) | Unchanged. Non-secret identifiers |
| Tenant intake keys | `intake_keys` stores a SHA-256 hash only (`0001` `token_hash`) | Unchanged |
| `connections.credential_hint` / `credential_location` (0003/0006) | A ≤4-character hint, and a label saying where a key lives | Unchanged, never a secret. The console's `integrations.js` still labels providers `keyStore: 'n8n credentials'`. That is a label, not a stored credential, and it is reworded in ARC-320 (§16) |
| Tenant OAuth tokens / API keys | **None exist.** Every tenant-connected provider in the registry is `planned`, with no adapter | ARC-130 provides the only place they may ever be stored |
| Secrets in configuration, snapshots, runs, actions | Refused by check constraints since 0010/0011/0014 | Unchanged. Tests prove no ARC-130 secret reaches them |
| Browser storage | Only the Supabase anon key and the user's session | Unchanged. No provider credential ever reaches a browser |

## 2. Threat model

| Threat | Control | Proven by |
|---|---|---|
| Cross-tenant connection access | Every lookup is `(tenant, connection)`; another tenant's id returns `not_found`, the same as no connection. RLS limits reads to members and operators. SQL re-checks the actor | `connections-*`: cross-tenant tests; DB RLS tests |
| Callback CSRF / login CSRF | The redirect lands on the portal. The SPA posts `state` and `code` with the user's **bearer JWT**, never a cookie, so a cross-site form cannot complete a flow. The session is bound to the initiating actor | `session_binding_mismatch` tests (memory and SQL) |
| Account linking / connection swapping | The state is bound to the actor who began the flow. PKCE binds the code to that flow's verifier, so an injected code fails the exchange. A different account on an existing connection is refused unless the flow was a `replace` **and** confirmation was explicit | account-mismatch / replacement tests |
| State replay | Single-use claim under a row lock; a second claim is `state_replayed` and recorded | replay tests (memory and SQL) |
| Authorisation-code replay | The code is exchanged once, server-side, with the verifier; the synthetic provider refuses reuse, and ARC never exchanges twice (a duplicate callback replays the stored result) | duplicate-callback test |
| PKCE verifier theft | The verifier lives in Vault for at most 15 minutes, never in a browser or log, and is deleted when the session is claimed, expires or fails | verifier-deleted tests |
| Open redirect | The redirect URI is server config: same origin as `ARC_SITE_URL`, https, no query. The return path is a bounded internal path under `/portal/dashboard` or `/ops/console` | open-redirect tests |
| Provider-endpoint SSRF | Endpoints come only from the registry: https, on the connector's host allowlist, validated at load. Every adapter call goes through `guardedTransport`. Request bodies naming an endpoint or URL are refused | SSRF tests |
| Scope escalation | Scopes are derived from registered capabilities; a request cannot name a scope. Unknown capabilities are refused. Scopes a provider adds unasked are not recorded | scope tests |
| Token leakage (APIs, logs, errors, traces) | `SecretValue` cannot serialise. `safeLog` redacts names, shapes and URL queries. Errors are ARC's own sentences; provider bodies never leave adapters. Unexpected errors return only a correlation id | sentinel tests over rows, events, responses and logs |
| Refresh races / rotation loss | Single-flight lease per connection; the new credential is stored before the old is retired, atomically. A stale lease commits nothing | concurrency tests (memory and SQL) |
| Stale or revoked credentials | Readiness requires a fresh verification (`reverifyAfterHours`). `invalid_grant` → `reauthorization_required`. End = retire + purge in the same transaction | refresh / lifecycle tests |
| Unauthorised replacement | Only an operator or the tenant's owner manages connections (checked in the service **and** SQL); replacement needs `expected_status_version` and explicit confirmation | forbidden / replacement tests |
| Browser access to long-lived credentials | No Vault or `arc_private` privilege for any API role; column grant hides the refresh lease; no API returns a credential or reference | DB grant tests, response tests |
| n8n access to refresh tokens | The gateway contract has no credential field and refuses one; credentials are resolved inside ARC after ARC-120 allows the effect | gateway tests |
| Service-role bypass of domain authorisation | The service role cannot write connection tables or reach Vault; wrappers re-check the actor (`require_manager`) and refuse JWT impersonation | DB service-role tests |
| Accidental live provider calls in tests | Synthetic providers on `.invalid` hosts (RFC 2606), in-process transport, `NO_NETWORK` default; synthetic catalog refuses production | environment tests |

## 3. Data model (0016)

**`public.provider_connections`** holds one row per connection:
- identity: `tenant_id`, `connector_key@connector_version`, `auth_method`;
- status, with `status_version` as the optimistic lock;
- the verified `external_account_id` and a safe label and metadata;
- `granted_scopes`, `verified_capabilities`, `credential_version` and an optional 4-character `credential_hint`;
- `access_expires_at` and `refreshable`;
- verification, refresh and health evidence, `connected_by`, and timestamps.

It holds no secret and no reference. Constraints:
- `unique (id, tenant_id)`, for composite foreign keys;
- one live connection per `(tenant, connector)`;
- terminal status ⇔ `ended_at`;
- display metadata refuses anything secret-shaped.

**`public.provider_connection_events`** is append-only, even for the owner. It records every transition and security event:
- `authorization_initiated`, `authorization_completed` (as `complete_authorization`), `authorization_denied`, `authorization_expired`, `authorization_replayed`;
- `verification_succeeded` / `verification_failed`;
- `credential_rotated`, `refresh_failed`, `credential_retired`, `credential_purged`, `credential_purge_failed`;
- `reauthorization_required`, `revoke`, `disconnect`, `connection_replaced`;
- `security_denial`.

It is idempotent on `(tenant, idempotency_key)`, and its metadata refuses anything secret-shaped.

**`public.connection_transition_rules`** holds the legal matrix. It is immutable and drift-tested against `model.ts`.

**`arc_private.credential_versions`** holds one row per credential version: `kind`, `status` (`active → retired → purged | purge_failed`), `vault_secret_id`, `hint` and timestamps. Constraints:
- one active version per connection;
- a composite foreign key to the connection's tenant;
- rows are never deleted.

**`arc_private.authorization_sessions`**:
- the SHA-256 of `state` and `nonce`, and the Vault id of the PKCE verifier;
- the allowlisted scopes and capabilities, the server-derived redirect and the bounded return path;
- the expected status version of the target;
- `expires_at`, which is at most 15 minutes after creation;
- one-time consumption (`pending → exchanging → completed | denied | expired | failed`);
- an idempotency key and a correlation id.

## 4. Connection lifecycle

```
                 begin (new)                complete                 verify ok
  (none) ───────────────▶ authorization_pending ──────▶ connected_unverified ──────▶ verified ◀──┐
                              │  ▲ begin                    │ verify failed          │  │        │ verify ok
               expired/denied │  │                          ▼                        │  ▼        │
                              ▼  │               reauthorization_required ◀──────────┤ degraded ─┘
                            failed               ▲ invalid_grant / scope loss        │ (transient)
                                                 └───────────────────────────────────┘
  every non-terminal status ── disconnect (person) ──▶ disconnected   (terminal)
  every non-terminal status ── revoke (person/system) ─▶ revoked      (terminal)
```

The complete matrix, and the one the database seeds, is `CONNECTION_TRANSITIONS`:

| Event | From | To | Who |
|---|---|---|---|
| `begin_authorization` | authorization_pending, failed | authorization_pending | manager |
| `begin_authorization` | connected_unverified, verified, degraded, reauthorization_required | same (reauthorising keeps the current grant working) | manager |
| `complete_authorization` | pending, failed, unverified, verified, degraded, reauth | connected_unverified | manager |
| `authorization_failed` | authorization_pending | failed | manager, system |
| `authorization_failed` | unverified, verified, degraded, reauth, failed | same | manager, system |
| `verification_succeeded` | connected_unverified, verified, degraded | verified | manager, system |
| `verification_failed` | connected_unverified, verified, degraded | reauthorization_required | manager, system |
| `provider_degraded` | verified, degraded | degraded | system |
| `credential_rotated` | connected_unverified, verified, degraded | same | manager, system |
| `reauthorization_required` | unverified, verified, degraded, reauth | reauthorization_required | manager, system |
| `disconnect` | every non-terminal | disconnected | manager |
| `revoke` | every non-terminal | revoked | manager, system |

Rules the code keeps:
- A token is not readiness: only `verified` or `degraded` serves a provider operation.
- A transient outage (`provider_degraded`) is not a revocation (`reauthorization_required`).
- Terminal means terminal: reconnecting creates a new connection with a new id.
- An unknown stored status fails closed everywhere (`connection_status_unknown`).
- Every change advances `status_version` by exactly one; a trigger enforces this even for the table owner.

## 5. OAuth Authorization Code flow

**Begin** (`oauth-begin`, operator or tenant owner):
1. Check the actor, then check that Vault is available.
2. Resolve `connector_key` from the registry to a selectable, tenant-credentialed `oauth2` version that has an adapter.
3. Take the capabilities from the request, or default to all of the provider's. Derive scopes as `baseScopes ∪ capabilityScopes[c]`. A request that names scopes, endpoints or URLs is refused.
4. Generate 32-byte random values for state, the S256 PKCE verifier and, for OIDC, the nonce.
5. Store the state and nonce only as SHA-256 digests; store the verifier in Vault.
6. Take the redirect URI from `ARC_OAUTH_REDIRECT_URL` (same origin as `ARC_SITE_URL`, https). Validate the return path.
7. Create the session: 10 minutes, at most 5 open per client, bound to the actor.
8. Build the authorization URL from registered endpoints and return it once to the requester. It is logged only in redacted form.

**Callback** (`oauth-callback`). The provider redirects to the portal route, and the SPA posts `state`, `code` or `error` with the user's JWT.
1. Parse the state. Claim it by digest, atomically and once, for exactly the actor who began it; refusals are recorded, not raised. An expired state destroys the verifier. A duplicate from the same person replays the result; from anyone else it is `state_replayed`.
2. Take the tenant, connection, provider, version, scopes, redirect and nonce digest from the session. The callback can only confirm the provider, not choose it.
3. If the provider sent `error`, record `provider_denied`. A missing code is refused.
4. Exchange the code server-side with the verifier and the client secret (`client_secret_basic` or `client_secret_post`). Validate `token_type`, the tokens' shape and length, `expires_in`, and a refresh token where the provider must issue one.
5. Verify identity. For OIDC: RS256 via the registered JWKS, `iss`, `aud` (and `azp`), `exp`/`iat`, `nonce` against the stored digest, and `sub`. Otherwise use the registered userinfo endpoint.
6. Store the credential in Vault and the metadata, in one transaction. A different account is refused unless the session is a `replace` and confirmation was explicit. A stale connection version is refused.
7. Verify capabilities from the granted scopes as a separate recorded step. A missing scope leaves the connection `reauthorization_required` with the typed error `scope_mismatch`.
8. Purge retired secrets, report health recovery (never state), and return a safe summary and the return path.

If an exchange's grant cannot be kept (a store failure or account mismatch), ARC tries to revoke it at the provider before failing.

## 6. Secret storage (Vault)

- **Where:** `vault.create_secret` and `vault.decrypted_secrets` are reached only by functions in `arc_private`. Each is `search_path = ''` with fully-qualified objects, is not `SECURITY DEFINER`, and is executable by no API role.
- **How the service reaches them:** fourteen `public.connection_*` wrappers, the Data API's only way in. Each is `SECURITY DEFINER`, `search_path = ''`, a one-line call, and granted to `service_role` alone. Supabase's Data API cannot see `arc_private`, and the harness proves it (`PGRST202`).
- **Revocation:** 0016 revokes `vault` and `arc_private` from `PUBLIC`, `anon`, `authenticated` and `service_role`, then **asserts** it. If any API role can still use either schema, read a table or execute a function there, the migration fails.
- **No generic getter:** `resolve_credential` needs the tenant, connection, provider and a named operation. The connection must belong to that tenant, and its status must allow the operation now:
  - `provider_operation` needs `verified` or `degraded` and the capability verified;
  - `verify` and `refresh` need a non-terminal status holding a grant;
  - `revoke` needs a live one.

  Only the single active version resolves.
- **Writes:** secrets travel as their own RPC parameter (`p_secret`, `p_pkce_verifier`), never inside the JSON request, which is what logs and errors could show. A test holds the adapter to this.
- **In memory:** a resolved secret is a `SecretValue`, used by one adapter call and never returned.
- **Browsers:** `authenticated` may select only the listed safe columns of its own tenant's rows (RLS plus a column grant). The refresh lease is excluded, and no reference exists anywhere a browser can see.

## 7. Refresh, rotation, revocation

- **On demand, no scheduler.** `withProviderCredential` refreshes when the token is within the provider's `refreshSkewSeconds` of expiry (300 for the synthetic provider). `refreshAccessToken({force})` is the internal seam a future ARC-200 scheduler calls. Nothing retries here.
- **Single flight:** `begin_refresh` takes a 30-second lease on the row, if the credential version is still the one read. A concurrent caller gets `refresh_in_progress` (temporary); a caller that lost the race gets the already-rotated credential.
- **Commit:** `commit_refresh` requires the live lease and the same credential version. It writes the new Vault secret first, then retires and purges the old one, in one transaction. A rotated refresh token is kept; one the provider did not rotate is carried forward.
- **Failure:**

  | Case | What happens |
  |---|---|
  | Provider 5xx / 429 / timeout | `temporary_failure`, connection `degraded`, old credential kept |
  | `invalid_grant` / 401 | `permanent_failure`, `reauthorization_required`, dependent modules paused |
  | Incomplete body | `incomplete_response`, old kept |
  | Vault write fails | `storage_failed`, old kept, the transaction rolls back entirely |
  | Refreshed scopes lost a capability | `verification_failed` |

  Known risk: if the provider rotated the refresh token and ARC then failed to store it, the old refresh token may already be dead. The next refresh gets `invalid_grant` and the connection requires reauthorisation. That fails closed, never open.
- **Revocation / disconnection:**
  - Operator or tenant owner, with `expected_status_version`.
  - ARC asks the provider to revoke (RFC 7009) and records `revoked`, `unsupported`, `ambiguous` or `not_attempted`, but **never waits on it**. Credentials are retired in the same transaction as the status change, open sessions are closed, and retired secrets are purged. A purge failure is recorded (`credential_purge_failed`) and never reactivates anything.
  - `systemRevoke` is the compromise path: the system revokes without asking anyone.
  - A later reconnect is a new connection and never resumes a module.

## 8. Provider adapter interface

`ProviderAdapter` (adapter.ts) exposes:
- `key` and `authMethods`;
- `authorizationUrl`, `exchangeCode`, `refresh` and `revoke`;
- `identity` (OIDC or userinfo);
- `normalizeScopes`, which drops scopes ARC never asked for;
- `verifyCapabilities`;
- `verifyApiKey`.

Endpoints, PKCE support, scopes and client-credential variable names come from the registry version's `connection.oauth`, never from the adapter's caller. Provider responses are classified inside the adapter into `ConnectionErrorCode`s, and only an allowlisted RFC 6749 error word is kept, as detail.

Adapters today:
- **`oauth2_generic`** (production): Authorization Code with PKCE and OIDC. There is no implicit grant or password grant; neither is implemented, so neither can be selected.
- **`synthetic_api_key`** (tests only).

No real provider adapter was added: every tenant-connected provider is still `planned`, and adding one is its own phase (the registry rule "a capability means adapter code and a test").

## 9. Vault root key versus provider credential rotation

- **Provider credentials** rotate through ARC, as in §7: new stored first, activated atomically, old kept until the new is proven (API keys are verified with the provider before they are stored), then retired and purged.
- **Vault's root key** is infrastructure. It is not initiated by application code, not reachable by tenants or the portal, and never read, exported or rotated by ARC. Rotating it is a controlled procedure by an authorised operator. It needs:
  - an inventory of the secrets that exist (`select count(*) from vault.secrets`, no values);
  - a backup plan;
  - Supabase's re-encryption path;
  - a verification plan (resolve a canary through `connection_resolve_credential`);
  - a rollback plan.

  It must allow for the possibility that old ciphertext becomes unreadable. The response to that is reauthorising affected connections, never a plaintext export.

## 10. Scope and capability mapping

`OAuthSpec.baseScopes` are always requested. `capabilityScopes[capability]` is the whole allowlist per capability, and every key must be a capability the version declares (validated at load). A connection is verified for exactly the capabilities whose scopes are all granted. Readiness asks for the capability, never a scope.

## 11. Non-OAuth credentials

A write-only API key is accepted only by `api-key-store`.
- **Shape:** the credential must be an object with exactly the provider's declared `credentialFields`, each matching its pattern and length bounds. An unknown field, an endpoint or URL, a bare string, or a wrong format is refused before anything is stored.
- **Verification:** the key is checked with the provider **before** it is stored. A first key the provider could not be asked about is stored `connected_unverified`. A rotation of a working key needs the provider's acceptance and the status and credential versions read.
- **Responses:** they echo nothing but a `hint` (the last four characters, only where the provider spec says it is safe).
- **Removal:** disconnect retires and purges.

## 12. ARC-100, ARC-110, ARC-120

- **ARC-100:** `ConnectorVersion.connection` (a `TenantConnectionSpec`) is validated by `validateTenantConnectionSpec`: it is required for a selectable tenant-credentialed version and forbidden for ARC-managed ones. `REGISTRY_CATALOG` is a view of `CONNECTORS`, not a second list. Unknown providers, methods, capabilities and scopes fail closed.
- **ARC-110:** configuration holds no credential; this is already refused by the 0010/0011/0014 check constraints, and tests prove ARC-130 adds none. A module's requirements name capabilities, and the tenant's connection for the provider is resolved at use, so rotating a credential changes no configuration. Switching to a different account is an explicit, confirmed `replace` that re-verifies and, through the lifecycle effects, pauses dependants. Restoring or republishing a configuration version brings back no credential and does not revive a revoked connection (tested).
- **ARC-120:**
  - `capabilityEvidence` now proves a tenant-credentialed capability only from a connection that is `verified`/`degraded`, verified for that exact capability, fresh, holding a credential, with a known health, and not expired without a way to refresh.
  - The authorizer (start, continue and effect), `evaluateActivation` and `connectionContext` all read this live evidence.
  - Losing a connection (revoked, disconnected, reauthorisation required, scope lost) system-pauses each **active** module that can no longer prove its connection readiness, adds `reactivation` to what it requires, and reports its health `failing` with the capabilities. A degraded connection reports `degraded` health and pauses nothing.
  - Recovery reports health `healthy` again, and **never** changes state: a paused module needs an operator's `resume`, which re-checks readiness.
  - Pinned runs keep their snapshot, resolve the *current* credential at use, and are refused the moment the connection is unusable. Consent, suppression, STOP, reply, takeover, safety and send-once stay in the module's own effect gate, unchanged.

## 13. The n8n credential boundary and the gateway

`performConnectorOperation` (gateway.ts) is the seam ARC-220 will put behind a signed bridge.
- **Request:** exactly `tenant_id`, `module_key`, `run_id`, `capability`, `operation` and `idempotency_key`. Any credential-, endpoint- or URL-shaped field is refused before anything is read.
- **Order of work:**
  1. ARC reloads the run, its lead and its pinned snapshot;
  2. asks `authorizeModuleExecution` (kind `effect`); a refusal resolves no credential;
  3. refuses anything but a live run;
  4. picks the connection verified for the capability;
  5. runs one approved operation through `withProviderCredential`.
- **Result:** identifiers and status only.

n8n never stores a customer refresh token and never receives a long-lived credential. There is no code path today that sends one to n8n, so nothing had to be migrated.

## 14. HTTP surface

`POST /functions/v1/connections` takes `{ action, … }`, and requires `Authorization: Bearer <user JWT>` and `Content-Type: application/json`.

| Action | Fields |
|---|---|
| `connections-list` | `tenant_id` |
| `connection-get` | `tenant_id`, `connection_id` (metadata, credential versions' safe metadata, recent events) |
| `oauth-begin` | `tenant_id`, `connector_key`, `purpose?`, `connection_id?`, `expected_status_version?`, `capabilities?`, `return_path?` |
| `oauth-callback` | `state`, `code` \| `error`, `connector_key?`, `confirm_account_replacement?` |
| `api-key-store` | `tenant_id`, `connector_key`, `credential`, and for rotation `connection_id`, `expected_status_version`, `expected_credential_version`; `confirm_account_replacement?`, `idempotency_key?` |
| `connection-verify` | `tenant_id`, `connection_id`, `expected_status_version` |
| `connection-reauthorize` | `tenant_id`, `connection_id`, `expected_status_version`, `idempotency_key?` |
| `connection-disconnect` / `connection-revoke` | `tenant_id`, `connection_id`, `expected_status_version`, `idempotency_key?` |

- **Fields:** any field not listed is refused. Scope- and endpoint-shaped ones get a specific error.
- **Rate limits:** per person and action, 10 a minute, on `oauth-begin`, `oauth-callback`, `api-key-store` and `connection-verify`; plus the 5-open-sessions cap per client in SQL.
- **Errors:** stable `ConnectionErrorCode`s with fixed HTTP statuses. An unexpected error returns only `{error: 'internal', message, correlation_id}`.
- **Headers:** CORS allows only the `ARC_SITE_URL` origin. Responses are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## 15. Hosted Vault verification: required before production

**Not executed. It must be run by an authorised operator in a non-production Supabase project.** Record each result with a date and name; any "no" stops the deployment.

| # | Check | How (no secret values in any output) | Result |
|---|---|---|---|
| 1 | Vault extension installation succeeds | `select extname, extversion from pg_extension where extname = 'supabase_vault'` | pending |
| 2 | ARC migrations apply | `supabase db push` through 0016; the §10 assertion passes. It fails the migration if `anon`/`authenticated` can reach `vault` or `arc_private`, if any API role can reach `arc_private`, or if the database shows the Data API exposing either. `service_role` keeps Supabase's own Vault grants (ADR ARC-010 §20a, amended 2026-09-28) | pending |
| 2a | The Data API exposes neither `vault` nor `arc_private` | Dashboard → Project Settings → Data API → Exposed schemas: `public`, `graphql_public` only | staging: verified by Ben, 2026-09-28 |
| 3 | A synthetic canary secret can be created | Store a synthetic canary with an obviously fake value through `connection_store_api_key` (a scratch tenant, the `synthetic_api_key` shape, a staging-only test registry, or `vault.create_secret` as `postgres`) | pending |
| 4 | Its ordinary-table form is encrypted | `select secret <> '<canary>' as encrypted from vault.secrets where name like 'arc130:%'` → true | pending |
| 5 | ARC's trusted backend can resolve it | `connection_resolve_credential` as `service_role` returns it for the right tenant, connection, operation and capability | pending |
| 6 | `anon` cannot access it | `set role anon; select * from vault.decrypted_secrets` → permission denied; same for `arc_private.*` and `connection_*` | pending |
| 7 | `authenticated` cannot access it | As 6, with a real signed-in JWT through PostgREST | pending |
| 8 | An unrelated tenant cannot access it | `connection_resolve_credential` with tenant B's id → `not_found` | pending |
| 9 | Direct Data API access cannot retrieve it | `GET /rest/v1/rpc/resolve_credential`, `/rest/v1/credential_versions` → not found; `POST /rest/v1/rpc/connection_resolve_credential` with the anon key → 401/403 | pending |
| 10 | Browser APIs never return the reference or the value | Call every `connections` action; grep the responses for the canary value and for `vault` | pending |
| 11 | Rotation safely replaces the credential | Rotate the canary; old version `purged`, new `active`, resolve returns the new one | pending |
| 12 | Retirement blocks the old version | Resolving after rotation or disconnect never returns the old value | pending |
| 13 | Deletion / revocation works as designed | `connection-disconnect` → `vault.secrets` no longer holds the canary's id | pending |
| 14 | Logs and traces contain no canary value | Search Postgres, PostgREST, Edge Function and API gateway logs for the canary and the `arc130:` names' values. Confirm `log_statement` is not `all` and `pgaudit` does not capture RPC parameters | pending |
| 15 | Backup, restore and project migration | Confirm with Supabase: backups hold Vault ciphertext and not the root key; a restore into the **same** project decrypts; a restore into a new project needs Supabase's key-migration path, or every connection reauthorised. Document the answer here | pending |
| 16 | The canary is removed | Disconnect it; confirm zero rows in `vault.secrets` for it and zero `active` versions | pending |

Also confirm:
- **Privileges:** after a platform upgrade, `select * from public.credential_isolation_problems()` returns no rows, and the exposed schemas are unchanged.
- **Environment:** `ARC_ENVIRONMENT` is set explicitly on each project.
- **Function config:** `connections` is deployed with JWT verification on.

## 16. Legacy credential migration

There is nothing to move. No tenant OAuth token or API key exists anywhere: not in the database, not in configuration history, not in the frontend, and not in n8n on ARC's behalf. Every tenant-connected provider is `planned`. 0016 creates no connection rows, changes no existing table, and leaves `public.connections` exactly as it was (tested).

Controlled procedure for the first real provider (future phase):
1. Add its registry version with `connection` and an adapter.
2. Have the client connect through `oauth-begin`/`api-key-store`. Never copy a key from n8n or a spreadsheet into SQL.
3. Once verified, delete the provider's credential from wherever it lived before, including n8n credentials.
4. Reword the console's `keyStore: 'n8n credentials'` labels (ARC-320).

No configuration version is published and no module is activated by this procedure. If a credential is ever found in an immutable configuration version, it is **not** edited: rotate it at the provider, reconnect it through ARC, and record the finding.

## 17. Environment and provider registration

| Setting | Where | Note |
|---|---|---|
| `ARC_ENVIRONMENT` | `connections` function secret | `production` \| `staging` \| `development` \| `test`; unset = production |
| `ARC_SITE_URL` | function secret | e.g. `https://arcautomation.site` |
| `ARC_OAUTH_REDIRECT_URL` | function secret | e.g. `https://arcautomation.site/portal/dashboard/connections/callback`. Must be on `ARC_SITE_URL`'s origin |
| `<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` | function secrets named by the registry's `clientIdEnv`/`clientSecretEnv` | Per environment. The secret never leaves the function |

At each provider's developer console, register:
- exactly `ARC_OAUTH_REDIRECT_URL` for that environment, with no wildcards;
- the Authorization Code grant only;
- PKCE required where the provider allows it;
- the smallest scope set in the registry.

Use separate provider apps (client ids) for staging and production.

## 18. Secret compromise and revocation

1. `systemRevoke` (or `connection-revoke` by an operator) each affected connection. Local use stops in that transaction, and ARC-120 pauses dependants.
2. Revoke the grant at the provider's own console. ARC's revocation attempt may have been `ambiguous`.
3. If a provider client secret leaked, rotate it at the provider, update the function secret, and redeploy `connections`. Existing grants are unaffected unless the provider says otherwise.
4. If the service-role key leaked, rotate it in Supabase. With Vault direct access revoked, the service role can still call `connection_resolve_credential`, so treat every connection as exposed: revoke, then reconnect.
5. Reconnect as new connections; an operator resumes modules after checking readiness.
6. Root-key concerns go to §9's controlled procedure.

## 19. Logging

- Only `safeLog` logs, and it redacts secret-named keys, secret-shaped strings (bearer, JWT, common key prefixes) and every URL query value.
- A test captures every line of a full flow and asserts that no code, state, nonce, challenge, verifier, client secret or issued token appears.
- Secrets are RPC parameters, not SQL text; the migration contains no literal secret.

To verify on the hosted project (§15 item 14), without changing global logging from this task: `log_statement`, `log_min_duration_statement` with parameter logging, `pgaudit` settings, PostgREST request logging, and the Edge Function log drain.

## 20. Running it locally

```
npm test                                        # everything; the DB suites SKIP without PGlite
ARC_PGLITE_DIR=<dir with @electric-sql/pglite> npm test
node --test tests/connections-oauth.test.js tests/connections-credentials.test.js tests/connections-db.test.js
```

The synthetic providers are in-process on `.invalid` hosts. No test can reach a network: adapters get the synthetic transport or `NO_NETWORK`, and `guardedTransport` refuses unregistered hosts.

## 21. Boundaries

| Phase | What ARC-130 leaves for it |
|---|---|
| ARC-200 | Proactive refresh scheduling (call `refreshAccessToken({force})`), durable operation queues and retry policy |
| ARC-210 | `AutomationRunner` and the fake runner. The gateway is written to be called by one |
| ARC-220 | The signed n8n dispatch/callback bridge in front of `performConnectorOperation` |
| ARC-320 | The portal's connection pages: the OAuth callback route (strip `code`/`state` from history immediately, `no-referrer`), key entry, reauthorise/disconnect buttons, rewording `integrations.js` |
| ARC-LR-4xx | Real provider adapters and their registry versions |

## 22. Tests

| Suite | What it proves |
|---|---|
| `tests/connections-oauth.test.js` (62) | The matrix and its drift against 0016; fail-closed statuses; registry specs (host allowlist, https, scope↔capability, env-named secrets); production guards; the full flow; PKCE; state digest and TTL; invalid, expired and replayed state; duplicate callback; actor, provider and tenant binding; denial; missing code; bad token body; outage; missing refresh token; five OIDC claim failures; a signature from another key; open redirect; redirect URI; scope injection; SSRF; log redaction; manager checks; session cap; reauthorise and replace; HTTP field allowlist, rate limits, sanitised errors, no-secret responses |
| `tests/connections-credentials.test.js` (58) | No raw credential anywhere ordinary; resolution needs tenant, provider, capability and operation; failed rotation keeps the old; retired unusable and purged; purge failure; refresh skew, single flight, rotation, non-rotation, temporary, `invalid_grant`, incomplete, storage failure, scope loss; every status; terminal; idempotency; stale versions; unknown status; cross-tenant; write-only keys (schema, endpoint, rotation, removal, account change); ARC-120 readiness, just-in-time denial, pinned runs, pause on loss, no reactivation on recovery, no pause when another connector serves; publication cannot revive a credential; gateway contract, a refusal resolves nothing (including a lifecycle refusal over a healthy connection), shadow reaches nothing; the credential-store contract against `TestCredentialStore` |
| `tests/connections-db.test.js` (6 text + 29 database) | 0016 as written (Vault only, no browser grants, empty `search_path`, definer only for wrappers, no literal secret, forward-only, secret-as-parameter); **applied**: refuses without Vault and with an undeclared double; every API role kept out of Vault and `arc_private`; wrapper grants; Data API cannot reach `arc_private`; rules = matrix; production refuses the double; legacy table untouched; full flow through the production adapter with no secret in any public or `arc_private` row; RLS and column grant; no direct writes, even by the service role; append-only; tenant-consistency foreign keys; one live connection; single-use expiring sessions; the SQL session cap; an unverified key cannot replace a working one; manager re-check and anti-impersonation; locking and idempotency; disconnect purges Vault; a Vault failure mid-refresh rolls back; write-only keys; the credential-store contract against `SupabaseVaultCredentialStore` |

Mutation testing is recorded in §23.

## 23. Mutation testing

Each mutation reintroduces one defect in a scratch copy of the repository. It counts as
caught only if the suites named for it were green first and fail with the defect in place.
**20 of 20 caught.**

| # | Defect | Caught by |
|---|---|---|
| 0 / 1 | A callback from another person is accepted (memory / SQL) | binding tests |
| 2 | An unusable connection still resolves for provider operations (memory) | resolution and lifecycle tests |
| 3 | SQL resolves a credential for a capability never verified | contract over SQL |
| 4 | The PKCE verifier is not sent at exchange | every OAuth flow (60 failing) |
| 5 | The transport reaches any host | SSRF test |
| 6 | The OIDC nonce is not checked | nonce test |
| 7 | Readiness accepts an unverified capability | ARC-120 readiness test |
| 8 | Ending a connection leaves its credentials active (SQL) | disconnect/purge tests over SQL |
| 9 | Open sessions are not capped (SQL) | SQL session-cap test |
| 10 | The handler accepts smuggled fields | scope, SSRF and endpoint tests |
| 11 | A lost connection does not pause its module | lifecycle-effect tests |
| 12 | A refresh without the lease is committed (SQL) | contract over SQL |
| 13 | The gateway ignores an ARC-120 refusal | lifecycle refusal over a healthy connection |
| 14 | A different account can reauthorise a connection (memory) | replacement test |
| 15 | Any return path is accepted | open-redirect test |
| 16 | Secret-named fields are logged | log-redaction tests |
| 17 | SQL lets an unverified key replace a working one | direct RPC test |
| 18 | `service_role` keeps Vault access | 0016's own assertion; every DB test |
| 19 | An unset environment is not treated as production | environment tests |

The first run caught 17. Nos. 9, 13 and 17 were each hidden behind a second layer that
refused first: the memory store's cap, connection selection after a revocation, and the
service verifying before storing. A test now isolates each, and all three are caught.

## 24. Known limitations

- Real Vault encryption, Supabase's own grants and hosted logging are verified only by §15, which is pending.
- No real provider adapter exists; `oauth2_generic` has been exercised only against the synthetic provider.
- OIDC signature checking supports RS256 only. JWKS responses are fetched per verification, not cached.
- The in-process rate limiter is per function instance; the SQL session cap is the durable limit.
- Readiness reads the freshest connection per provider. Choosing between two connections of one provider is not modelled, because the schema allows only one live connection per provider.
- The console has no connection pages yet (ARC-320), so the function is backend-only until then.
