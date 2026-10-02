# ARC-320: Connections, readiness, testing and activation

> Status: **implemented and tested locally.** The `ops` function was deployed to staging on
> 2026-10-01. Connecting a real provider still waits on ARC-130's hosted Vault checklist
> (ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md §15) and on a real provider adapter.

This is the operator's page for taking one module of one client from configured to live,
and keeping it there: `/ops/console/clients/:tenantId/activation/:moduleKey`.

**The page decides nothing.** Each answer is an existing authority, and each button is an
existing server action with its own gate:

| On the page | Decided by |
|---|---|
| State, effective status, transitions offered, readiness, history | ARC-120 `getLifecycleStatus` / `evaluateActivation` (`lifecycle/`) |
| Activate, resume, pause, shadow, review, health report | ARC-120's `module-*` actions (`ops/lifecycle.ts`), unchanged |
| Each connection and its status | ARC-130's `summarize()`, then `connectionDisplay` (`activation/model.ts`) |
| Connect, reauthorise, disconnect, store a key | The `connections` function (ARC-130), unchanged |
| The module's synthetic test | The module's own action (Lead Recovery: `lead-recovery-canary`) |
| A connection test | ARC-200's queue and ARC-210's orchestrator (below) |

## The pieces

| Piece | Where |
|---|---|
| Shared vocabulary, readiness checklist, impact of going live, test verdict (portal-safe) | `supabase/functions/_shared/activation/model.ts` |
| Durable connection test, the runner, the console's pass, the test log | `_shared/activation/connection-test.ts` |
| The overview read: requirements → capabilities → providers → connection | `_shared/activation/overview.ts` |
| `ops` actions `activation-overview`, `connection-test` | `supabase/functions/ops/activation.ts` |
| The page and the panel | `src/portal/pages/ops/ClientActivation.jsx`, `src/portal/components/ActivationPanel.jsx` |
| OAuth return | `src/portal/pages/ConnectionCallback.jsx` at `/portal/dashboard/connections/callback` |

## The two new `ops` actions

**`activation-overview` `{ tenant_id, module_key }`** is read-only. It returns:
- ARC-120's status;
- each requirement group's capabilities, with ARC-120's verdict on each;
- every provider that could serve each capability. Each is either ARC-managed (proven by
  configuration and attestation) or tenant-connected (the client's connection, as a safe
  summary, plus `display`, a ≤4-character `hint` and its `latest_test`);
- the module's test and shadow evidence;
- the version numbers behind the heads and the authorised and tested pairs.

**`connection-test` `{ tenant_id, module_key, connection_id, idempotency_key? }`** runs in
this order:
1. **Refuse before writing anything** when:
   - there is no operator;
   - the connection is another client's, or does not exist;
   - the connection is revoked or disconnected (`connection_ended`), or still authorising;
   - the module does not use that provider (`connection_not_used`);
   - the module is not in testing, shadow, active or paused (`module_not_testing`), which is
     0015's own rule for a test run.
2. Snapshot the current published configuration.
3. Record a `connector_test` run in `test` mode, pinned to that snapshot, and a
   `test_connection` action naming the connection by reference. The payload holds no
   credential; 0017 refuses one.
4. Write the audit row `connection.test_requested`.
5. Run the console's pass (below), then return the test as ARC's rows now record it.

## Who executes a connection test

**`ConnectionTestRunner`** (kind `arc_connection_test`) is ARC's own in-process runner.
- It executes only `test_connection`, and only in `test` mode.
- It calls ARC-130's `verifyConnection` as the system actor. The credential is resolved
  inside that service, for that one verification, through the provider's registered
  adapter.
- The runner holds no credential and writes nothing. The connection's new status is
  written by ARC-130.
- A transient provider failure is retryable. A rejected grant is not, and ARC-130 marks
  that connection `reauthorization_required`.
- It passes `tests/runner-contract.js`.

Tests hand the same queue to `FakeTestRunner`, which contacts nothing.

**The console's pass** claims by tenant. A worker that claims an action it cannot run fails
that action as unsupported, so the pass runs only when every due action of a
scheduler-dispatched type for this client is one its runners execute. Otherwise it defers,
says why, and leaves the test queued for the scheduler worker. The Lead Recovery engine's
own action types are never claimed by this path, so they never cause a deferral.

**Limit:** a lease that expired on someone else's action can still be swept up by the
claim. Nothing creates scheduler actions in production today except this test. The
scheduler worker removes the edge.

## Secrets

- Connections leave the server only as `summarize()` output. The panel renders the status,
  the capabilities, the last-verified time and the hint, and nothing else of the
  connection: no metadata and no scopes.
- A key typed into the connect form goes to the `connections` function once and is cleared
  from the form at once.
- The OAuth callback strips `code` and `state` from the URL in its first render, before
  `getSupabase()` can run. That client is configured with `detectSessionInUrl` and would
  otherwise try to spend the `code` as its own sign-in.
- A test's evidence and message are what 0017 accepted. It refuses credential-shaped
  evidence and replaces a credential-shaped message (`scheduler_safe_text`).

## Hosted steps

Per project:
- `supabase secrets set ARC_ENVIRONMENT=<staging|production>`. Unset counts as production.
- `supabase secrets set ARC_OAUTH_REDIRECT_URL=https://<site>/portal/dashboard/connections/callback`.
  It must be on `ARC_SITE_URL`'s origin, and is needed only once a real OAuth provider exists.
- `supabase functions deploy ops`.

The page needs 0015, 0016 and 0017 applied, and says which one is missing if it is not.

## Tests

| Suite | What it proves |
|---|---|
| `tests/activation-console.test.js` (32) | The vocabulary. A missing and a revoked connection each block activation, and the page says which capability and provider. Activation needs an operator: no one and a stranger are both refused, and nothing moves. No credential in the overview or the render, even when one is planted in a field the panel has no business showing. The runner contract, a passing verification, an outage and a revoked grant. The rendered panel: loading, not selected, blocked reasons, enabled resume, latest test, shadow, health, history, read-only. The callback stripping the URL |
| `tests/activation-db.test.js` (7, PGlite) | The durable run and action pinned to the current versions. A passing test settling the attempt and run and shown by the overview. A failing one with a credential-shaped message replaced. A revoked connection refused before any write. Deferral leaving others' work untouched. Pause from the console holding live work at the claim, a paused module still testable, and resume releasing the work |
