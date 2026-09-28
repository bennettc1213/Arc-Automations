# ARC Master Implementation Roadmap From ARC-200

Generated: 2026-09-25

Purpose: this file lets Ben paste only a prompt ID into Claude Code in VS Code, such as `ARC-200`, and have Claude Code know what to inspect, implement, test, and report without needing a long pasted prompt each time.

This roadmap assumes the repository has already completed or locally completed:

- `ARC-000` - Repository Architecture Audit and Gap Map
- `ARC-010` - ARC-n8n Execution Boundary ADR
- `ARC-015` - Lead Recovery Safety and Configuration Pinning
- `ARC-015B` - Production Configuration Snapshot Pinning Repair
- `ARC-100` - Module and Connector Registry Foundation
- `ARC-110` - Versioned Tenant Configuration Engine
- `ARC-120` - Tenant Module Lifecycle and Activation State Machine
- `ARC-130` - Secure Provider Connection and OAuth Framework, with Supabase Vault recorded as the production credential store and hosted Vault verification still allowed to remain a separate hosted gate

The current prompt is `ARC-200`.

Important: this file is not a substitute for repository evidence. Claude Code must verify the repository state before each prompt. If the repo does not prove that a prerequisite is present, Claude Code must stop and report the exact missing prerequisite instead of guessing or building around it.

---

## How Ben Should Use This File

Put this file in the project root, or in a docs/handoff folder that Claude Code can read. Then use short prompts like:

```text
ARC-200
```

or:

```text
ARC-310
```

Claude Code should then:

1. Open this file.
2. Find the matching prompt ID.
3. Run the Universal Preflight.
4. Verify prerequisites from the repository.
5. Implement only that prompt's scope.
6. Run the required tests.
7. Stop with a completion report and the next prompt ID.

Ben does not need to paste the whole prompt card into chat unless Claude Code cannot find this file.

---

## Universal Preflight For Every Prompt

Before editing any file for any ARC prompt, Claude Code must do all of this:

1. Read the repository's project instructions.

   Check for files such as `CLAUDE.md`, `AGENTS.md`, `.claude/settings.local.json`, package scripts, migration docs, and any ARC ADR or audit docs already in the repository.

2. Check repository state.

   Run:

   ```bash
   git status --short
   git rev-parse --short HEAD
   git branch --show-current
   ```

   Report the branch, HEAD, and dirty files. Do not revert, delete, reset, checkout, or overwrite user changes unless Ben explicitly asks.

3. Verify autoship dry-run protection before editing.

   The repository previously had an autoship hook that could commit and push edited files to `main` after tests pass. For every prompt, confirm `.claude/settings.local.json` has:

   ```json
   {
     "env": {
       "AUTOSHIP_DRY_RUN": "1"
     }
   }
   ```

   If this protection is missing, stop before editing and say:

   ```text
   BLOCKED: autoship dry-run is not active, so file edits may commit or push to main. Please enable AUTOSHIP_DRY_RUN=1 before this ARC prompt.
   ```

   Do not bypass the hook by using untracked edit methods unless Ben explicitly authorizes that method for the current prompt.

4. No external side effects unless explicitly authorized.

   Do not push, commit, deploy, contact providers, send SMS, send email, rotate production credentials, run hosted migrations, or change production/staging systems unless the current prompt explicitly says that hosted action is allowed and Ben explicitly confirms it.

5. Respect the ARC-n8n boundary.

   ARC/Postgres owns tenant identity, permissions, module selection, versioned configuration, operational state, durable scheduled actions, consent/suppression, replies/takeover, safety, provider credentials, connector capability evidence, audit/evidence, health, workflow assignments, performance intelligence, and production reporting.

   n8n may own reusable module-level orchestration, approved stateless transformations, approved API-operation sequences, shared sub-workflows, and signed execution results returned to ARC.

   n8n must not own tenant configuration, client permissions, the only copy of scheduled actions, critical operational state, customer OAuth tokens, consent/suppression truth, per-client workflow copies, the client-facing workflow editor, performance conclusions, or recommendation authorization.

6. Use existing repo patterns.

   Inspect existing migrations, RLS policies, registry code, lifecycle code, test harnesses, UI patterns, and naming conventions. Extend the local style instead of inventing a separate framework.

7. Treat secrets as toxic.

   Never print secret values. Never read customer token plaintext except through approved security-definer code paths required by tests. Never store provider tokens in tenant config, browser-visible data, n8n credentials, plain tables, logs, or environment variables.

8. Keep migrations deterministic.

   Migrations must be ordered, reversible where the repo pattern expects it, and safe for repeated local test setup. Tests must run against real Postgres when existing suites do so.

9. Report blocked work correctly.

   If a required decision, credential store, provider account, hosted feature, or deployment authorization is missing, stop with:

   ```text
   BLOCKED: <short reason>
   Evidence checked:
   - <file/test/command>
   Required decision:
   - <what Ben must decide>
   Files changed:
   - none, unless changes were already safely made before the blocker became visible
   ```

10. Completion report format.

   Every ARC prompt must end with:

   ```text
   COMPLETE LOCALLY: <ARC-ID> <short title>

   What changed:
   - ...

   Tests:
   - ...

   Hosted or production gates still pending:
   - ...

   No commits, pushes, deploys, or provider contacts were performed.

   Next prompt:
   - <next ARC-ID>
   ```

---

## Non-Negotiable Product And Safety Rules

All remaining prompts must preserve these rules:

1. Build once, configure per company.
2. No copied n8n workflows per client.
3. No n8n node editing during onboarding.
4. No manual per-client database setup.
5. No unsupported integration improvised.
6. Only provable results.
7. Stop automation after a relevant reply.
8. Honor opt-outs immediately.
9. Human takeover blocks automation.
10. Distress, legal, medical, crisis, or safety-sensitive messages are handled by humans.
11. Current safety state overrides pinned behavioral configuration.
12. Pinned configuration makes run behavior deterministic.
13. Every external effect is durable and send-once.
14. Ambiguous provider outcomes are not automatically resent.
15. Critical state lives in ARC/Postgres.
16. n8n execution history is not operational state.
17. n8n is replaceable.
18. Historical published configs are immutable.
19. Rollback creates a new version; it does not mutate history.
20. Recommendations never silently change configuration.
21. Correlation is not causation.
22. Verified ARC, workflow, connector, or provider faults must be disclosed.
23. Insufficient evidence is a valid result.

---

## Canonical Remaining Sequence

| Order | Prompt ID | Title | Primary Surface | Status |
|---:|---|---|---|---|
| 1 | `ARC-200` | Durable Actions, Runs, and Scheduling Engine | Backend / database | Current |
| 2 | `ARC-210` | AutomationRunner Interface and Fake Test Runner | Backend / tests | Next |
| 3 | `ARC-220` | Secure n8n Runner Bridge | Backend / security / integration | Future |
| 4 | `ARC-230` | n8n Workflow Manifest, Versioning, and Synchronization | Backend / workflow governance | Future |
| 5 | `ARC-240` | Shared n8n Core Workflows and Error Handler | Workflow exports / backend | Future |
| 6 | `ARC-300` | ARC Ops Tenant Creation and Module Selection | Full stack / ops | Future |
| 7 | `ARC-310` | Schema-Driven Client Workflow Settings UI | Full stack / UI | Future |
| 8 | `ARC-320` | Connections, Readiness, Testing, and Activation UI | Full stack / UI / ops | Future |
| 9 | `ARC-LR-400` | Lead Recovery Intake, Identity, Consent, and Safety Foundation | Backend / module behavior | Future |
| 10 | `ARC-LR-410` | Lead Recovery Qualification, Messaging Policy, and Reply Handling | Backend / product behavior | Future |
| 11 | `ARC-LR-420` | Lead Recovery Provider Actions and Booking Coordination | Backend / connectors | Future |
| 12 | `ARC-LR-430` | Lead Recovery Follow-up Sequences, Scheduling, and Stop Conditions | Backend / scheduler / safety | Future |
| 13 | `ARC-LR-440` | Lead Recovery Operator Console, Evidence Timeline, and Manual Controls | Full stack / ops UI | Future |
| 14 | `ARC-LR-450` | Lead Recovery Outcome Proof, Reporting, Data Quality, and Health | Full stack / analytics | Future |
| 15 | `ARC-OPT-460` | Version-Aware Outcome Attribution and Anomaly Detection | Backend / analytics | Future |
| 16 | `ARC-OPT-470` | Evidence-Based Performance Diagnosis and Recommendation Engine | Backend / analytics / product | Future |
| 17 | `ARC-OPT-480` | Client Recommendations, Reminders, and Guided Configuration Experiments | Full stack / product | Future |
| 18 | `ARC-QA-500` | Security, RLS, Contract, and Idempotency Test Suite | Tests / security | Future |
| 19 | `ARC-QA-510` | Synthetic End-to-End and Failure-Scenario Validation | Tests / integration | Future |
| 20 | `ARC-OPS-520` | Deployment, Monitoring, and Incident Readiness | Ops / deployment | Future |
| 21 | `ARC-PILOT-530` | First HVAC Design-Partner Pilot | Product / ops / pilot | Future |

---

# Prompt Cards

## `ARC-200` - Durable Actions, Runs, and Scheduling Engine

### Intent

Build ARC's durable execution backbone. ARC must own runs, scheduled actions, attempts, idempotency, leases, retries, cancellation, and recovery. This is not an n8n workflow task. This is the database and service layer that guarantees ARC knows what should happen, what did happen, what is safe to retry, and what must never be duplicated.

### Prerequisites Claude Code Must Verify

- `ARC-015B` config snapshot pinning exists and run/action behavior can be tied to a tenant, module, and immutable published config snapshot.
- `ARC-100` registry exists and has module/connector metadata.
- `ARC-110` versioned tenant config exists, including immutable published versions and secret-shaped value rejection.
- `ARC-120` module lifecycle exists, including selection, readiness, testing, shadow, activation, pause/resume, transition history, health overlay, and just-in-time authorization checks.
- `ARC-130` connection framework exists locally, with Supabase Vault named as the production secret store and a local contract-compatible test store allowed only for local tests.

If any prerequisite is missing, stop and report the first missing gate.

### Scope

Implement database schema, RLS policies, service APIs, and tests for:

- Durable automation runs.
- Durable scheduled actions.
- Action attempts.
- Leases or claims for worker execution.
- Idempotency keys.
- Retry policy and backoff.
- Cancellation and pause interaction.
- Recovery after process crash.
- Action dependency on tenant/module/config snapshot readiness.
- Send-once protection for external effects.
- Dead-letter or terminal failure states.
- Scheduler visibility into future due work.

### Required Concepts

Runs represent a logical automation instance, such as a Lead Recovery conversation, a scheduled follow-up sequence, a connector readiness test, a future performance investigation, or an observation window.

Actions represent durable units of work. Examples:

- send message
- test connection
- call provider operation
- schedule follow-up
- record observation checkpoint
- evaluate reply
- request human review
- enqueue n8n runner execution

Attempts represent individual execution tries for an action.

The scheduler must be generic. It must not contain Lead Recovery-specific optimization logic. Later prompts may schedule observation windows and reminders through this engine, but this engine should only know durable timing, state, ownership, idempotency, and execution safety.

### State Model Requirements

Create or extend tables equivalent to these concepts, following repository naming conventions:

- `automation_runs`
- `automation_actions`
- `automation_action_attempts`
- optional `automation_action_leases` if the repo style prefers separate leases
- optional `automation_action_events` if history is not already represented elsewhere

Required run fields:

- id
- tenant id
- module key
- module version or registry reference when available
- published tenant config version or snapshot id
- lifecycle state at start
- runner kind requested or assigned, but not hard-coded to n8n
- status: pending, running, completed, failed, canceled, paused, blocked
- reason or terminal code
- correlation id
- created by actor/system
- created at, started at, completed at, updated at

Required action fields:

- id
- run id
- tenant id
- module key
- action type
- scheduled for timestamp
- status: pending, claimable, leased, running, succeeded, failed, canceled, skipped, blocked, dead_letter
- idempotency key
- attempt count
- max attempts
- next attempt at
- lease owner
- lease expires at
- provider/connector reference if applicable
- connection reference if applicable
- payload pointer or structured payload following repo conventions
- config snapshot reference
- current safety/lifecycle gate result
- created at, updated at

Required attempt fields:

- id
- action id
- attempt number
- runner kind
- started at, completed at
- status
- error code
- error message safe for logs
- provider request id or runner execution id when available
- ambiguous outcome boolean
- retryable boolean
- evidence reference

### Scheduling And Lease Rules

- A pending action becomes claimable only when `scheduled_for <= now`.
- A paused module or paused run blocks new claims unless the action type is explicitly allowed while paused.
- A connection-dependent action cannot be claimed if readiness has expired, authorization is missing, or the connection is revoked.
- Lease acquisition must be atomic.
- Only one worker can own an action lease at a time.
- Expired leases can be reclaimed safely.
- A worker must not complete an action if it no longer owns the lease.
- Retried actions must create new attempts and preserve prior attempts.
- Terminal states must not be claimable.
- Canceled actions must not run.
- Failed actions with ambiguous external provider outcome must not auto-resend external effects.

### Idempotency And External Effects

Every external effect must have a durable idempotency key before execution begins. This includes SMS, email, provider API mutation, booking request, CRM update, and any n8n-dispatched effect.

Idempotency keys must be stable across retries of the same logical action and unique across different logical actions.

If a provider outcome is unknown, mark the action ambiguous or blocked and require human or provider-specific reconciliation. Do not blindly retry an external effect that may have succeeded.

### RLS And Security Requirements

- Tenant users can only see their own tenant's runs/actions if the product surface exposes them.
- Service role or scheduler role can claim and execute actions.
- Operators can see cross-tenant operational state only through established ops permissions.
- Payloads must not contain secrets.
- Logs and error messages must be safe to display.
- Connection references must point to ARC connection metadata, not plaintext credentials.

### Service API Requirements

Implement local service functions matching repository style for:

- creating a run
- scheduling an action
- claiming due actions
- starting an attempt
- completing success
- completing failure
- rescheduling retry
- marking ambiguous outcome
- canceling a run
- canceling future actions for a run
- pausing or blocking run actions due to lifecycle/safety state
- listing due actions for workers
- listing run timeline for UI/debugging

### Tests Required

Add focused tests for:

- action creation pins tenant, module, and config snapshot
- secret-shaped payloads are rejected if the repo has a generic secret detector
- tenant isolation through RLS
- due action is claimable
- future action is not claimable
- two concurrent claims do not both win
- expired lease can be reclaimed
- non-owner cannot complete leased action
- success is terminal
- retry schedules next attempt with backoff
- max attempts moves to terminal failure or dead letter
- ambiguous provider outcome blocks auto-resend
- pause blocks claim
- resume permits claim
- cancel prevents claim
- idempotency key uniqueness is enforced
- scheduler can represent future observation windows/reminders without embedding optimization decisions

### Acceptance Criteria

- Full local tests pass.
- Existing ARC-015B, ARC-100, ARC-110, ARC-120, and ARC-130 tests still pass.
- No n8n-specific assumption is required to create, claim, retry, or complete actions.
- No provider is contacted.
- No commit, push, deploy, hosted migration, or production change occurs.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-200 Durable Actions, Runs, and Scheduling Engine
Next prompt: ARC-210
```

---

## `ARC-210` - AutomationRunner Interface and Fake Test Runner

### Intent

Introduce a replaceable runner interface so ARC can execute automation through multiple implementations without changing tenant config, lifecycle, scheduling, or UI behavior.

The first real implementation for this prompt is `FakeTestRunner`, used for deterministic tests and safe local development. This prompt does not build the n8n bridge yet.

### Prerequisites Claude Code Must Verify

- `ARC-200` durable runs/actions engine exists and tests pass.
- Actions can be claimed and completed through service APIs.
- Runs/actions are not hard-coded to n8n.

### Scope

Implement:

- `AutomationRunner` interface or equivalent local abstraction.
- `RunnerRequest` and `RunnerResult` types.
- Runner registry or factory.
- `FakeTestRunner`.
- Scheduler-to-runner orchestration for local tests.
- Contract tests proving runner interchangeability.

### Runner Interface Requirements

The runner request must include:

- run id
- action id
- tenant id
- module key
- action type
- pinned config snapshot reference
- connector/connection references as metadata only
- safe payload
- idempotency key
- attempt number
- correlation id
- execution mode: test, shadow, live, or dry run when repo semantics support it

The runner request must not include:

- plaintext customer tokens
- decrypted Vault values
- environment secrets
- browser-derived credentials
- unpinned mutable tenant config

The runner result must include:

- success/failure status
- retryable boolean
- ambiguous outcome boolean
- safe error code
- safe display message
- evidence reference or structured safe evidence
- external request id if available
- runner execution id
- resulting scheduled actions if the architecture allows runners to suggest them, subject to ARC validation

### FakeTestRunner Requirements

`FakeTestRunner` must be deterministic and scriptable in tests.

It should support:

- successful completion
- retryable failure
- non-retryable failure
- ambiguous provider outcome
- delayed completion if the repo has async worker tests
- safe evidence output
- assertion that secrets are absent from input
- assertion that config is pinned
- assertion that idempotency keys are present

It must not contact providers, n8n, Supabase hosted services, Twilio, email, CRM systems, calendars, or the network.

### Scheduler Integration Requirements

ARC should be able to:

- claim a due action
- construct a runner request
- dispatch it to a runner
- translate the result into action attempt completion
- schedule retry when allowed
- block ambiguous outcomes
- preserve evidence
- update run status when all required actions complete or fail

### Tests Required

Add tests for:

- `FakeTestRunner` receives no secrets
- runner request includes pinned config snapshot
- runner request includes durable idempotency key
- successful runner result completes action
- retryable runner result schedules retry
- non-retryable result fails action
- ambiguous outcome blocks resend
- unknown runner kind is rejected safely
- scheduler can run with FakeTestRunner only
- existing ARC-200 tests still pass

### Acceptance Criteria

- Runner abstraction exists and is not n8n-specific.
- Fake runner enables deterministic local end-to-end action execution.
- No customer tokens or provider credentials are passed into the runner request.
- No provider is contacted.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-210 AutomationRunner Interface and Fake Test Runner
Next prompt: ARC-220
```

---

## `ARC-220` - Secure n8n Runner Bridge

### Intent

Build the secure bridge between ARC and n8n as one replaceable runner implementation. ARC remains the system of record. n8n receives only the execution request needed for approved shared workflows and returns signed results.

### Prerequisites Claude Code Must Verify

- `ARC-200` exists.
- `ARC-210` exists.
- Runner abstraction supports multiple runner kinds.
- Credential framework from `ARC-130` prevents customer tokens from being stored in n8n.

### Scope

Implement:

- `N8nRunner` or equivalent runner implementation.
- Signed outbound requests from ARC to n8n.
- Signed inbound callbacks/results from n8n to ARC.
- Replay protection.
- Timeout handling.
- Result validation.
- Safe evidence capture.
- Tests with mocked n8n only.

### Security Requirements

- Use a dedicated bridge signing secret for ARC-to-n8n and/or n8n-to-ARC signatures, following repository secret conventions.
- Include timestamp, nonce, action id, attempt id, tenant id, and body digest in the signature base.
- Reject missing, invalid, expired, or replayed signatures.
- Store nonce or callback id to prevent replay.
- Never send customer tokens to n8n.
- Never rely on n8n to decide tenant authorization.
- Never rely on n8n execution history as operational truth.
- Validate that callback tenant id, run id, action id, and attempt id match the claimed action.
- Treat malformed callbacks as security events or safe failures.

### Request Payload Requirements

Outbound n8n request may include:

- run id
- action id
- attempt id
- tenant id
- module key
- workflow manifest id/version when available
- action type
- idempotency key
- safe config snapshot values
- connection metadata reference
- connector capability names
- safe payload
- callback URL
- correlation id

Outbound n8n request must not include:

- customer OAuth refresh token
- customer OAuth access token
- API key plaintext
- Vault decrypted secret
- Supabase service role secret
- n8n credentials for tenant providers
- full environment dump

### Callback Requirements

Inbound callback must support:

- success
- retryable failure
- non-retryable failure
- ambiguous provider outcome
- evidence references
- safe provider request identifiers
- elapsed duration
- workflow id/version executed
- node-level safe diagnostics when available

Callbacks must be idempotent. Duplicate callbacks must not create duplicate success/failure transitions or duplicate external effects.

### Timeout And Recovery

- If n8n does not return a callback before timeout, ARC marks the attempt timed out according to retry policy.
- If the action may have produced an external effect, timeout must be treated as ambiguous unless workflow/action metadata proves no external effect occurred.
- The bridge must preserve enough evidence for operator review.

### Tests Required

Add tests for:

- signed outbound request generation
- signature verification for inbound callback
- expired signature rejection
- replay rejection
- tenant/action mismatch rejection
- duplicate callback idempotency
- no secret fields in n8n payload
- success callback completes action
- retryable callback schedules retry
- ambiguous callback blocks auto-resend
- timeout behavior
- FakeTestRunner still works

### Acceptance Criteria

- n8n is one runner implementation, not the architecture center.
- n8n can be removed or replaced without changing tenant config or durable actions.
- No real n8n instance is contacted during local tests.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-220 Secure n8n Runner Bridge
Next prompt: ARC-230
```

---

## `ARC-230` - n8n Workflow Manifest, Versioning, and Synchronization

### Intent

Create source-controlled workflow manifest governance so ARC knows exactly which shared n8n workflow version is allowed to run each module action. This establishes workflow version attribution for future debugging, reporting, and optimization.

### Prerequisites Claude Code Must Verify

- `ARC-220` bridge exists.
- Runner requests can include workflow identity/version metadata.
- ARC registry and lifecycle modules exist.

### Scope

Implement:

- Workflow manifest schema.
- Manifest validation.
- Workflow assignment records in ARC.
- Workflow version/checksum attribution on runs/actions/attempts.
- Synchronization checks between repo manifest and n8n environment metadata, mocked locally.
- Compatibility checks between module version, action type, connector requirements, and workflow version.
- Tests.

### Manifest Requirements

Each workflow manifest entry should include:

- workflow key
- workflow display name
- module key
- action types supported
- runner kind
- n8n workflow id for environment-specific mapping if appropriate
- semantic version or repository version
- checksum/hash of exported workflow JSON
- required input schema version
- output schema version
- external effect classification
- connector capabilities required
- whether action can be retried automatically
- whether timeout is ambiguous
- error handler version
- owner/reviewer metadata if the repo uses it

### Assignment Requirements

ARC must know which workflow version is assigned to:

- module key
- module version or registry entry
- action type
- environment: local, staging, production if the repo models environments
- effective status: draft, approved, deprecated, disabled

Assignments must be auditable. Changing an assignment must not rewrite prior action history.

### Version Attribution Requirements

Every n8n-dispatched action attempt must record:

- workflow key
- workflow manifest version
- workflow checksum
- error handler version when applicable
- assignment id used

This attribution feeds future `ARC-OPT-460` anomaly detection. Do not postpone attribution to optimization work.

### Sync Requirements

Local tests should mock n8n metadata. The sync checker should be able to detect:

- manifest workflow missing in n8n
- n8n workflow checksum differs from source-controlled export
- assignment references disabled workflow
- workflow supports wrong action type
- workflow input/output schema mismatch
- workflow is not approved for environment

Do not contact real n8n unless Ben explicitly authorizes a hosted validation prompt.

### Tests Required

Add tests for:

- manifest schema validation
- invalid manifest rejected
- assignment creation
- disabled workflow cannot be used
- action type compatibility
- checksum mismatch detection
- attempt records workflow attribution
- historical attribution is immutable after assignment changes
- mocked sync reports missing/drifted workflow
- existing runner bridge tests still pass

### Acceptance Criteria

- Shared workflows are governed by manifest, not ad-hoc n8n edits.
- ARC can prove which workflow version ran an action.
- Local tests do not require real n8n.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-230 n8n Workflow Manifest, Versioning, and Synchronization
Next prompt: ARC-240
```

---

## `ARC-240` - Shared n8n Core Workflows and Error Handler

### Intent

Create the source-controlled shared n8n workflow exports and error handling pattern that the manifest in `ARC-230` governs. These workflows are reusable and module-level, not per-client copies.

### Prerequisites Claude Code Must Verify

- `ARC-220` bridge exists.
- `ARC-230` manifest/versioning exists.
- Repo has a known location for n8n workflow JSON exports or one must be created consistently.

### Scope

Implement source-controlled workflow assets and local validation for:

- core runner entry workflow
- module action dispatcher workflow or equivalent shared workflow pattern
- shared error handler workflow
- callback-to-ARC behavior
- safe evidence payload shape
- manifest entries for created workflows
- tests that validate workflow JSON structure without contacting n8n

### Workflow Rules

- No per-client workflow copies.
- No tenant secrets in n8n credentials.
- No customer OAuth/API token storage in n8n.
- No tenant configuration embedded in workflow nodes.
- No manual node editing during onboarding.
- Workflows must receive execution context from ARC and return signed results to ARC.
- Workflows must record safe diagnostics, not secrets.
- Workflows must distinguish retryable, non-retryable, and ambiguous outcomes.

### Error Handler Requirements

The shared error handler must normalize:

- provider timeout
- provider rate limit
- authorization failure
- validation failure
- unsupported capability
- ambiguous result
- n8n internal error
- unexpected exception

It must return a safe result contract that ARC can map onto action attempt outcomes.

### Local Validation Requirements

Add validation scripts or tests that check workflow JSON exports for:

- valid JSON
- workflow id/name metadata matching manifest
- required webhook/callback nodes
- no environment secret references for tenant credentials
- no hard-coded tenant ids
- no hard-coded provider tokens
- expected error handler linkage
- checksum matching manifest

### Hosted Gate

Do not import or update hosted n8n workflows unless Ben explicitly authorizes a hosted workflow sync. Local completion can say hosted import/sync remains pending.

### Tests Required

Add tests for:

- workflow export files exist
- workflow JSON parses
- manifest checksum matches export
- no obvious secret-shaped values in workflow exports
- required callback contract exists
- error handler result contract validates
- existing manifest/bridge tests still pass

### Acceptance Criteria

- Repo contains source-controlled shared n8n workflow exports.
- ARC manifest governs those exports.
- Error handler contract is testable locally.
- No hosted n8n contact occurs without authorization.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-240 Shared n8n Core Workflows and Error Handler
Next prompt: ARC-300
```

---

## `ARC-300` - ARC Ops Tenant Creation and Module Selection

### Intent

Build the operator-facing flow for creating tenants and selecting modules without manual database setup or n8n editing.

### Prerequisites Claude Code Must Verify

- `ARC-100` registry exists.
- `ARC-110` versioned config exists.
- `ARC-120` lifecycle exists.
- `ARC-200` durable runs/actions exists if tenant creation schedules setup checks.
- Existing portal/ops console patterns are understood.

### Scope

Implement backend and UI for:

- tenant creation
- tenant profile basics
- module selection from registry
- initial module lifecycle state
- required connector visibility
- readiness checklist initialization
- audit history
- operator permissions
- no manual per-client database setup

### Backend Requirements

Tenant creation must:

- create tenant records through service APIs, not manual SQL instructions
- initialize default module selection state
- create or expose required draft configuration slots
- initialize readiness/lifecycle records
- validate module exists in registry
- validate operator permission
- audit actor, timestamp, tenant id, and selected modules

Module selection must:

- use registry module keys
- support selecting, deselecting where allowed, and planned/unavailable states
- refuse unsupported connectors
- refuse activation before readiness gates
- preserve lifecycle transition history

### UI Requirements

Use existing ops console design patterns. The UI should be dense, operational, and clear.

Required views:

- tenant list or tenant creation entry point
- create tenant form
- module selection panel
- required connectors/readiness summary
- lifecycle status indicators
- audit/history summary or link
- error/empty/loading states

Do not build a marketing page. This is an ops tool.

### Tests Required

Add tests for:

- operator can create tenant
- unauthorized user cannot create tenant
- tenant initialization creates expected lifecycle records
- unsupported module key rejected
- module selection uses registry
- selecting module does not activate it
- UI renders tenant creation form
- UI handles validation errors
- existing lifecycle/config tests still pass

### Acceptance Criteria

- A new tenant can be created through ARC ops code path.
- Module selection is registry-backed.
- No n8n workflow copy is created per tenant.
- No manual DB instructions are needed for normal tenant creation.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-300 ARC Ops Tenant Creation and Module Selection
Next prompt: ARC-310
```

---

## `ARC-310` - Schema-Driven Client Workflow Settings UI

### Intent

Build the client/operator settings UI from module configuration schemas. Users should edit workflow behavior as validated ARC config, not by editing n8n nodes.

### Prerequisites Claude Code Must Verify

- `ARC-110` versioned tenant config exists.
- `ARC-100` module registry exposes config schema or can be extended to.
- `ARC-120` lifecycle can evaluate draft/published config and readiness.
- `ARC-300` tenant/module selection exists.

### Scope

Implement schema-driven UI and supporting APIs for:

- viewing current published config
- editing draft config
- field validation
- field-level permissions
- publish flow
- rollback/restore as new draft or new version
- version history
- version comparison
- impact summary before publish

### UI Requirements

Required views/components:

- module settings page
- field groups generated from schema
- input controls matched to field type
- validation messages close to fields
- draft vs published indicator
- publish button with confirmation and impact summary
- version history list
- version diff/compare view
- restore version action that creates a new draft or version according to existing ARC-110 rules
- read-only mode for users lacking permission
- clear loading/error/empty states

Do not expose secret fields. Config may reference a connection id or capability, but must never store plaintext credentials.

### Backend Requirements

- Config schemas must be authoritative from ARC registry or config engine.
- Draft saves must use optimistic concurrency.
- Publish must create immutable versions.
- Rollback must create a new version and never mutate historical published rows.
- Permission checks must apply per field or per config section according to existing ARC-110 design.
- Change impact should use ARC-120 lifecycle/change impact logic where available.

### Tests Required

Add tests for:

- schema renders correct field controls
- invalid draft values rejected
- secret-shaped values rejected
- unauthorized field edit rejected
- optimistic concurrency conflict shown
- publish creates immutable version
- version comparison works
- restore creates new draft/version without mutating old version
- UI loading/error states render
- existing config/lifecycle tests pass

### Acceptance Criteria

- Users configure module behavior through ARC UI, not n8n.
- Config history is visible and immutable.
- Version comparison and restore are supported.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-310 Schema-Driven Client Workflow Settings UI
Next prompt: ARC-320
```

---

## `ARC-320` - Connections, Readiness, Testing, and Activation UI

### Intent

Build the UI and service flow that lets operators manage provider connections, run readiness tests, review evidence, activate modules, pause/resume modules, and understand why a module is or is not live.

### Prerequisites Claude Code Must Verify

- `ARC-120` lifecycle/readiness exists.
- `ARC-130` connection framework exists.
- `ARC-200` durable actions can schedule tests.
- `ARC-210` FakeTestRunner exists.
- `ARC-300` and `ARC-310` provide tenant/module settings context.

### Scope

Implement:

- connections panel
- readiness evidence display
- test connection action
- activation flow
- shadow/test/live status visibility
- pause/resume controls
- blocked reason display
- just-in-time authorization prompt/status
- change impact before activation

### UI Requirements

Required panels:

- provider connections list by module
- connection status: missing, connected, needs reauth, revoked, expired, unsupported
- credential hint only, never token value
- readiness checklist
- latest test result with safe evidence
- run test button
- activate button gated by readiness
- pause/resume controls
- shadow mode indicator if present
- health overlay
- transition history
- blocked reason details

Activation must feel operational and trustworthy. It should not hide why a module cannot activate.

### Backend Requirements

- Test connection should create durable action/run records.
- Tests should use FakeTestRunner locally unless a mocked connector is already present.
- Real provider contact must not happen unless explicitly authorized.
- Activation must call lifecycle service and enforce readiness.
- Pause/resume must update lifecycle state and block scheduler claims as designed in ARC-200.
- UI APIs must not return secret values.

### Tests Required

Add tests for:

- missing connection blocks activation
- revoked connection blocks activation
- readiness test creates durable action
- successful readiness test updates evidence
- failed readiness test shows safe error
- activation requires operator permission
- pause blocks future claims
- resume permits claims
- UI never renders token plaintext
- UI displays blocked reason
- existing connection/lifecycle/scheduler tests pass

### Acceptance Criteria

- Operators can manage readiness and activation in ARC.
- No provider secrets are exposed.
- Activation cannot bypass lifecycle gates.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-320 Connections, Readiness, Testing, and Activation UI
Next prompt: ARC-LR-400
```

---

## `ARC-LR-400` - Lead Recovery Intake, Identity, Consent, and Safety Foundation

### Intent

Begin production Lead Recovery behavior by building the foundation for inbound leads, customer identity, consent/suppression, safety gating, and pinned configuration context.

### Prerequisites Claude Code Must Verify

- `ARC-015` safety/config pinning exists.
- `ARC-015B` snapshot pinning repair exists.
- `ARC-110` config versions exist.
- `ARC-120` lifecycle activation gates exist.
- `ARC-200` durable runs/actions exist.
- `ARC-320` activation/readiness UI exists or backend activation state is available.

### Scope

Implement Lead Recovery module foundations:

- lead intake normalization
- customer/contact identity matching
- consent and suppression checks
- STOP/opt-out handling entry points
- distress/safety handoff classification entry points
- run creation for eligible lead recovery cases
- pinned config snapshot at run start
- evidence timeline foundation

### Behavior Requirements

When a lead enters ARC:

- identify tenant and module
- verify Lead Recovery module is active or in allowed test/shadow state
- normalize contact information
- match or create customer/contact record according to repo conventions
- check suppression/opt-out before scheduling any outreach
- check takeover/human control state
- create durable run with pinned config
- create initial evidence entries
- refuse unsupported provider/source shapes
- avoid contacting external providers during local tests

### Consent And Safety Requirements

- Immediate opt-out must suppress future automation.
- Current suppression state overrides pinned behavioral config.
- Human takeover blocks automation.
- Distress/safety-sensitive signals must route to human review and block automation.
- Consent/suppression truth must live in ARC/Postgres, not n8n.

### Tests Required

Add tests for:

- valid lead intake creates run with pinned config
- inactive module refuses automation
- paused module refuses automation
- suppressed contact blocks outreach
- opt-out state blocks outreach
- takeover state blocks outreach
- distress classification blocks automation and creates human review evidence
- duplicate lead handling is idempotent
- unsupported source/provider rejected safely
- tenant isolation

### Acceptance Criteria

- Lead Recovery can intake a lead safely without sending messages yet.
- Consent/safety gates exist before outreach.
- Run evidence begins at intake.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-400 Lead Recovery Intake, Identity, Consent, and Safety Foundation
Next prompt: ARC-LR-410
```

---

## `ARC-LR-410` - Lead Recovery Qualification, Messaging Policy, and Reply Handling

### Intent

Implement the decision layer that decides whether, when, and how Lead Recovery should message a lead, plus the inbound reply handling that stops or reroutes automation correctly.

### Prerequisites Claude Code Must Verify

- `ARC-LR-400` intake foundation exists.
- Durable actions can schedule message actions.
- Safety/consent/takeover state can block action claims.

### Scope

Implement:

- lead qualification rules
- message eligibility
- message template/config selection from pinned config
- reply ingestion
- relevant reply detection
- opt-out reply handling
- takeover routing
- human review routing
- evidence timeline updates

### Messaging Policy Requirements

- Never send if contact is suppressed.
- Never send if human takeover is active.
- Never send if safety/distress state is active.
- Never send if module is paused unless explicitly in test/shadow mode and no external effect happens.
- Use pinned run config for behavior choices.
- Use current safety/consent state at execution time.
- Record why a message was or was not scheduled.

### Reply Handling Requirements

Inbound replies must:

- attach to tenant/contact/run when possible
- detect opt-out/STOP and suppress immediately
- detect relevant human reply and stop automation
- route ambiguous or safety-sensitive replies to human review
- update evidence timeline
- cancel future automation actions when required
- avoid relying on n8n as source of truth

### Tests Required

Add tests for:

- qualified lead schedules first message action
- unqualified lead does not schedule outreach
- pinned config chooses template/policy
- current opt-out blocks even if pinned config allowed messaging
- relevant reply cancels future actions
- STOP reply suppresses immediately
- takeover cancels or blocks automation
- distress reply routes human review
- ambiguous reply does not continue blindly
- evidence records decisions

### Acceptance Criteria

- Lead Recovery can decide safe outreach eligibility.
- Replies stop or reroute automation correctly.
- No real SMS/email/provider contact occurs locally.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-410 Lead Recovery Qualification, Messaging Policy, and Reply Handling
Next prompt: ARC-LR-420
```

---

## `ARC-LR-420` - Lead Recovery Provider Actions and Booking Coordination

### Intent

Connect Lead Recovery decisions to provider operations through ARC connectors and durable actions. This covers safe provider action orchestration such as checking availability, creating/updating CRM records, coordinating booking, or preparing tasks, depending on what connectors are registered and supported.

### Prerequisites Claude Code Must Verify

- `ARC-130` connection framework exists.
- `ARC-200` durable actions exists.
- `ARC-210` runner abstraction exists.
- `ARC-LR-400` and `ARC-LR-410` exist.
- Connector registry declares supported provider capabilities.

### Scope

Implement:

- provider action planning for Lead Recovery
- connector capability checks
- connection readiness checks
- durable provider action scheduling
- safe provider result handling
- booking/CRM coordination state
- unsupported-provider behavior
- evidence of provider actions

### Provider Rules

- No unsupported integration improvised.
- If connector capability is missing, mark blocked/unsupported with evidence.
- If connection is missing or revoked, block action and surface readiness issue.
- If provider outcome is ambiguous, do not auto-repeat mutation.
- Store provider request ids and safe evidence.
- Never store provider token plaintext.
- Never move credential truth into n8n.

### Booking Coordination Requirements

Depending on existing repo domain models, implement safe state for:

- appointment intent
- booking requested
- booking confirmed
- booking failed
- CRM/contact update planned
- CRM/contact update completed
- provider blocked/unsupported
- human follow-up required

Do not fake provider capabilities. Use registry capability evidence.

### Tests Required

Add tests for:

- supported connector capability schedules provider action
- unsupported capability blocks with evidence
- missing connection blocks with readiness reason
- revoked connection blocks
- provider success updates state
- provider retryable failure schedules retry
- provider ambiguous outcome blocks auto-resend
- booking/CRM state is tenant-isolated
- no secret values in provider action payload

### Acceptance Criteria

- Lead Recovery can safely coordinate provider actions through ARC abstractions.
- Unsupported integrations are explicit, not improvised.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-420 Lead Recovery Provider Actions and Booking Coordination
Next prompt: ARC-LR-430
```

---

## `ARC-LR-430` - Lead Recovery Follow-up Sequences, Scheduling, and Stop Conditions

### Intent

Implement the actual Lead Recovery follow-up sequence behavior using ARC durable scheduling. This is where multi-step recovery timing, retries, reminders, and stop conditions become production-shaped.

### Prerequisites Claude Code Must Verify

- `ARC-200` scheduler exists.
- `ARC-LR-400`, `ARC-LR-410`, and `ARC-LR-420` exist.
- Reply/opt-out/takeover cancellation paths exist.

### Scope

Implement:

- sequence plan generation from pinned config
- scheduled follow-up actions
- time window and quiet-hour handling if configured
- cancellation of future actions
- stop conditions
- sequence completion state
- evidence timeline events

### Sequence Rules

- Sequence behavior uses pinned config.
- Safety, consent, suppression, and takeover use current state at execution time.
- Do not send after relevant reply.
- Do not send after opt-out.
- Do not send after human takeover.
- Do not send after booking/conversion if config says to stop.
- Do not send outside allowed windows if quiet hours/business hours exist.
- Rescheduling must be durable.
- External sends must be send-once.

### Stop Conditions

Support stop conditions for:

- relevant reply
- STOP/opt-out
- human takeover
- distress/safety state
- booking confirmed
- sequence max attempts reached
- module paused
- tenant disabled
- contact suppressed
- provider unsupported/blocking error

### Tests Required

Add tests for:

- initial sequence schedules follow-ups
- follow-up respects scheduled time
- quiet hours defer action if applicable
- relevant reply cancels future follow-ups
- opt-out cancels future follow-ups
- takeover cancels future follow-ups
- booking confirmed cancels future follow-ups when configured
- max attempts completes sequence
- ambiguous send outcome blocks future unsafe resend
- paused module prevents claim
- evidence timeline records each scheduling decision

### Acceptance Criteria

- Lead Recovery sequences run through ARC durable scheduling.
- Stop conditions are enforced.
- No duplicate sends on retry.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-430 Lead Recovery Follow-up Sequences, Scheduling, and Stop Conditions
Next prompt: ARC-LR-440
```

---

## `ARC-LR-440` - Lead Recovery Operator Console, Evidence Timeline, and Manual Controls

### Intent

Give operators a clear operational UI for Lead Recovery conversations, evidence, blocked states, manual takeover, suppression, and recovery controls.

### Prerequisites Claude Code Must Verify

- Lead Recovery backend through `ARC-LR-430` exists.
- Ops UI patterns from `ARC-300` through `ARC-320` exist.
- Evidence timeline data exists.

### Scope

Implement UI and APIs for:

- Lead Recovery run list
- run detail page
- conversation/evidence timeline
- current status and stop reason
- manual takeover
- release takeover where allowed
- suppress/contact opt-out controls
- cancel future automation
- retry safe failed action where allowed
- mark human review outcome
- blocked reason and readiness links

### UI Requirements

The console should show:

- tenant/contact/lead summary
- module lifecycle state
- run status
- next scheduled action
- last message/reply state
- consent/suppression state
- takeover state
- evidence timeline
- provider action evidence
- workflow/runner attribution when available
- clear manual controls with permission checks

Do not display secrets. Do not expose provider tokens. Do not let operators bypass safety stops.

### Manual Control Rules

- Takeover blocks automation immediately.
- Suppression cancels future outreach.
- Retry is allowed only for safe retryable non-external or provider-proven-safe cases.
- Ambiguous external outcome must require reconciliation, not blind retry.
- Manual notes/actions are audited.

### Tests Required

Add tests for:

- run list renders
- run detail renders timeline
- takeover blocks future claims
- suppression cancels future messages
- unauthorized operator cannot control run
- retry button hidden/disabled for ambiguous external outcome
- blocked reason displayed
- UI never renders secret values
- manual actions audit actor/time/reason

### Acceptance Criteria

- Operators can understand and control Lead Recovery safely.
- Evidence is visible and useful.
- Manual controls cannot bypass safety.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-440 Lead Recovery Operator Console, Evidence Timeline, and Manual Controls
Next prompt: ARC-LR-450
```

---

## `ARC-LR-450` - Lead Recovery Outcome Proof, Reporting, Data Quality, and Health

### Intent

Complete Lead Recovery production behavior by proving outcomes, surfacing trustworthy reporting, detecting data quality issues, and feeding future optimization prompts with reliable evidence.

### Prerequisites Claude Code Must Verify

- Lead Recovery backend/UI through `ARC-LR-440` exists.
- Workflow attribution from `ARC-230` exists.
- Durable attempts/evidence from `ARC-200` exists.

### Scope

Implement:

- outcome model
- proof/evidence links
- reporting summaries
- data quality checks
- health metrics
- attribution dimensions
- export or dashboard support if existing UI has reporting patterns
- future optimization data contract for `ARC-OPT-460`

### Outcome Requirements

Track outcomes such as:

- lead received
- contacted
- replied
- opt-out
- booked
- not booked
- human takeover
- provider blocked
- unsupported integration
- failed due to readiness
- failed due to safety
- insufficient evidence

Each outcome must have evidence. Do not claim conversion or recovered revenue without proof.

### Reporting Requirements

Reports should distinguish:

- verified outcomes
- inferred outcomes
- insufficient evidence
- ARC/system faults
- workflow faults
- connector faults
- provider faults
- client configuration/readiness issues

Never hide verified faults. Never turn insufficient evidence into success.

### Attribution Dimensions

Store or expose dimensions needed by optimization:

- tenant
- module
- published config version
- workflow manifest version
- connector/provider
- connection status
- run/action/attempt ids
- message sequence step
- operator intervention
- safety/consent stop reason
- time window

### Health And Data Quality

Detect:

- missing outcome proof
- stale readiness evidence
- high ambiguous outcome rate
- provider failure spike
- reply ingestion failure
- scheduled action backlog
- stuck leases/actions
- unexpected drop in contact rate
- unsupported connector attempts

### Tests Required

Add tests for:

- outcome requires evidence
- insufficient evidence is valid and visible
- verified booking proof is reported
- ARC/workflow/connector/provider fault categories are preserved
- reporting respects tenant isolation
- attribution includes config and workflow versions
- data quality checks flag missing proof
- health checks flag stuck actions/backlog
- no overclaiming success without proof

### Acceptance Criteria

- Lead Recovery has trustworthy reporting and health.
- Future optimization has usable, version-aware data.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-LR-450 Lead Recovery Outcome Proof, Reporting, Data Quality, and Health
Next prompt: ARC-OPT-460
```

---

## `ARC-OPT-460` - Version-Aware Outcome Attribution and Anomaly Detection

### Intent

Build the first layer of performance intelligence. ARC should detect meaningful changes in outcomes using version-aware evidence, without jumping to unsupported conclusions.

### Prerequisites Claude Code Must Verify

- `ARC-LR-450` outcome proof and attribution exists.
- Config version attribution exists.
- Workflow version attribution exists.
- Connector/provider attribution exists.
- Durable run/action/attempt history exists.

### Scope

Implement:

- outcome attribution queries/services
- baseline windows
- anomaly detection for outcome changes
- fault-aware segmentation
- insufficient-data handling
- scheduled observation windows using ARC-200 scheduler
- operator-visible anomaly records

### Attribution Requirements

Anomaly analysis must be able to group by:

- tenant
- module
- config version
- workflow version
- connector/provider
- connection/readiness state
- message step
- source
- time window
- operator intervention

### Detection Rules

- Detect changes, do not diagnose causes yet.
- Distinguish data quality issues from performance changes.
- Do not compare incompatible populations without noting limitations.
- Mark insufficient sample size as insufficient evidence.
- Preserve confidence/uncertainty language.
- Never silently change customer configuration.

### Scheduler Use

Use `ARC-200` durable scheduler for:

- observation windows
- delayed post-change checks
- recurring anomaly scans if the repo supports scheduled jobs

The scheduler should not contain optimization logic. Optimization schedules jobs through it.

### Tests Required

Add tests for:

- attribution query includes config/workflow versions
- anomaly created for significant outcome change
- no anomaly when sample too small
- data quality issue separated from performance anomaly
- connector/provider fault spike categorized
- scheduled observation window is durable
- tenant isolation
- insufficient evidence result preserved

### Acceptance Criteria

- ARC can detect version-aware anomalies.
- Results are cautious and evidence-grounded.
- No recommendations or config changes happen yet.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-OPT-460 Version-Aware Outcome Attribution and Anomaly Detection
Next prompt: ARC-OPT-470
```

---

## `ARC-OPT-470` - Evidence-Based Performance Diagnosis and Recommendation Engine

### Intent

Build diagnosis and recommendation generation on top of anomaly detection. ARC should identify plausible evidence-backed explanations and propose safe recommendations, while preserving uncertainty and never changing config automatically.

### Prerequisites Claude Code Must Verify

- `ARC-OPT-460` anomaly detection exists.
- `ARC-LR-450` proof categories exist.
- Config schemas and field permissions exist.
- Scheduled reminders/observation windows can be created.

### Scope

Implement:

- diagnosis records
- recommendation records
- recommendation evidence links
- recommendation status workflow
- rule-based or evidence-based diagnosis engine
- confidence/limitations fields
- guardrails preventing automatic config mutation

### Diagnosis Requirements

Diagnoses may consider:

- config version change
- workflow version change
- connector/provider failure rate
- readiness decay
- message step drop-off
- opt-out spike
- reply ingestion issue
- booking provider failures
- data quality gaps
- tenant-specific changes

Each diagnosis must include evidence and limitations.

### Recommendation Requirements

Recommendations must include:

- target tenant/module
- proposed change type
- affected config fields or operational action
- evidence summary
- expected impact
- risk/limitations
- required permission
- whether human approval is required
- observation plan after approval

Recommendations must not:

- mutate config silently
- activate modules
- send messages
- change provider credentials
- override safety/consent rules
- overstate causality

### Tests Required

Add tests for:

- anomaly creates diagnosis candidate
- diagnosis preserves evidence links
- insufficient evidence prevents strong recommendation
- recommendation cannot mutate config directly
- recommendation references valid config fields
- provider fault recommendation points to readiness/provider action instead of template change
- status workflow: proposed, accepted, dismissed, applied, observing, resolved
- tenant isolation

### Acceptance Criteria

- ARC can propose evidence-backed recommendations.
- Recommendations are explicit, reviewable, and non-mutating.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-OPT-470 Evidence-Based Performance Diagnosis and Recommendation Engine
Next prompt: ARC-OPT-480
```

---

## `ARC-OPT-480` - Client Recommendations, Reminders, and Guided Configuration Experiments

### Intent

Expose recommendations to operators/clients and guide approved configuration experiments safely, with reminders and observation windows.

### Prerequisites Claude Code Must Verify

- `ARC-OPT-470` recommendation engine exists.
- `ARC-310` schema-driven config UI exists.
- `ARC-200` scheduler exists.
- `ARC-LR-450` reporting exists.

### Scope

Implement:

- recommendation UI
- recommendation detail with evidence
- accept/dismiss workflow
- guided config draft creation from recommendation
- reminder scheduling
- experiment/observation tracking
- post-change result summary

### UI Requirements

Recommendation UI should show:

- recommendation title
- affected tenant/module
- evidence summary
- limitations
- proposed config or operational change
- expected impact
- risk
- approve/apply path based on permissions
- dismiss with reason
- observation status
- reminders
- post-change outcome summary

The UI must not pretend recommendations are guaranteed. It should make uncertainty understandable.

### Guided Experiment Requirements

When a recommendation is accepted:

- create draft config change or operational checklist item
- require publish approval through existing config version flow
- schedule observation window
- schedule reminder if needed
- attribute future outcomes to new config/workflow versions
- compare after sufficient evidence

Do not silently publish config. Do not auto-activate modules.

### Tests Required

Add tests for:

- recommendations list renders
- evidence and limitations visible
- accept creates draft but does not publish
- dismiss requires/records reason if repo pattern supports it
- reminder scheduled through durable actions
- observation window scheduled
- post-change summary waits for sufficient evidence
- permissions enforced
- no recommendation bypasses field permissions

### Acceptance Criteria

- Users can act on recommendations safely.
- Config experiments are guided and observable.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-OPT-480 Client Recommendations, Reminders, and Guided Configuration Experiments
Next prompt: ARC-QA-500
```

---

## `ARC-QA-500` - Security, RLS, Contract, and Idempotency Test Suite

### Intent

Create a broad hardening test suite that proves the architecture's security, tenant isolation, runner contracts, credential boundaries, and idempotency guarantees before deployment work begins.

### Prerequisites Claude Code Must Verify

- All implementation prompts through `ARC-OPT-480` are locally complete or intentionally skipped by explicit Ben decision.
- Existing tests are passing before adding the QA suite.

### Scope

Implement tests for:

- RLS coverage
- security-definer function boundaries
- credential storage boundaries
- config immutability
- lifecycle gates
- scheduler idempotency
- runner contracts
- n8n bridge signatures
- workflow manifest attribution
- Lead Recovery safety
- optimization non-mutation

### Required Test Categories

Security:

- tenant A cannot read tenant B data
- browser/client cannot read secrets
- n8n payload contains no credentials
- Vault references cannot be decrypted by unauthorized roles
- unsafe functions revoked from public/client roles

RLS:

- tenant-scoped tables
- ops-only tables
- audit/history tables
- run/action/evidence/outcome tables
- recommendation tables

Contracts:

- runner request/result shape
- n8n callback shape
- workflow manifest schema
- connector capability schema
- config schema

Idempotency:

- duplicate lead intake
- duplicate reply
- duplicate callback
- duplicate scheduler claim
- duplicate provider result
- ambiguous external outcome handling

Safety:

- opt-out immediate block
- takeover block
- distress/human review block
- current safety overrides pinned behavior

Optimization:

- insufficient evidence remains insufficient
- recommendations do not mutate config
- observation windows are durable

### Acceptance Criteria

- QA suite runs locally.
- Tests are organized and named so failures identify the broken architecture rule.
- Full local test command passes.
- Any hosted-only checks are clearly listed for `ARC-OPS-520`.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-QA-500 Security, RLS, Contract, and Idempotency Test Suite
Next prompt: ARC-QA-510
```

---

## `ARC-QA-510` - Synthetic End-to-End and Failure-Scenario Validation

### Intent

Create synthetic end-to-end validation for the whole ARC Lead Recovery system and its failure modes before deployment readiness.

### Prerequisites Claude Code Must Verify

- `ARC-QA-500` hardening suite exists and passes.
- FakeTestRunner exists.
- n8n bridge can be mocked.
- Lead Recovery implementation exists.

### Scope

Implement synthetic scenarios for:

- happy path Lead Recovery
- opt-out path
- relevant reply stop path
- human takeover path
- provider failure path
- ambiguous external outcome path
- connection revoked path
- paused module path
- workflow version drift path
- recommendation observation path

### Scenario Requirements

Each synthetic test should:

- create tenant/module/config
- activate or intentionally block module
- create connections/readiness evidence
- intake lead
- run scheduler/runner
- process replies/provider results
- assert final outcome and evidence
- assert no secrets leaked
- assert expected run/action states

### Failure Scenarios

Include failure cases for:

- duplicate inbound lead
- duplicate inbound reply
- duplicate n8n callback
- expired lease
- stale readiness
- provider timeout
- provider ambiguous result
- invalid signature
- unsupported connector
- missing workflow assignment

### Acceptance Criteria

- Synthetic suite proves realistic behavior without contacting real providers.
- Failure cases produce safe terminal or blocked states.
- Full local tests pass.

### Completion Report Must Say

```text
COMPLETE LOCALLY: ARC-QA-510 Synthetic End-to-End and Failure-Scenario Validation
Next prompt: ARC-OPS-520
```

---

## `ARC-OPS-520` - Deployment, Monitoring, and Incident Readiness

### Intent

Prepare controlled deployment, monitoring, rollback, incident response, and hosted verification. This is the first prompt that may involve staging or production actions, but only with explicit Ben authorization for each hosted action.

### Prerequisites Claude Code Must Verify

- `ARC-QA-500` passes.
- `ARC-QA-510` passes.
- All local migrations and tests pass.
- Ben explicitly authorizes any hosted migration, deployment, n8n import, Vault canary, or production change.

### Scope

Prepare:

- deployment checklist
- migration plan
- rollback plan
- monitoring dashboards/checks
- incident runbooks
- hosted verification list
- staging validation plan
- production gate checklist

### Hosted Verification Gates

Hosted gates should include:

- Supabase Vault canary for `ARC-130`
- hosted migrations in staging
- RLS verification in staging
- n8n workflow import/sync in staging
- n8n signature/callback test in staging
- provider sandbox tests where available
- Twilio/email test only with explicit safe test numbers/accounts
- scheduler worker health check
- stuck lease/action monitor
- error rate monitor
- opt-out/takeover emergency stop verification

### Monitoring Requirements

Define or implement checks for:

- scheduled action backlog
- stuck leased actions
- retry/dead-letter rates
- ambiguous outcome rate
- provider authorization failures
- readiness staleness
- workflow drift
- n8n callback failures
- opt-out processing delay
- reply ingestion delay
- outcome proof missing rate
- recommendation observation backlog

### Incident Readiness

Runbooks must cover:

- disable a module
- pause a tenant
- stop all Lead Recovery sends
- revoke a connection
- respond to provider outage
- respond to n8n outage
- handle duplicate/ambiguous sends
- handle opt-out delay
- rollback config version
- rollback workflow assignment
- rollback code/deployment

### Production Rules

- Pushing code is not the same as deploying production.
- Do not deploy production until staging gates pass.
- Do not run production migrations without explicit approval.
- Do not enable live sending until pilot prompt authorizes it.
- Keep autoship dry-run active unless Ben explicitly removes it.

### Acceptance Criteria

- Deployment and rollback plan exists.
- Monitoring/incident coverage exists.
- Hosted gates are documented and, if authorized, staged results are recorded.
- No unauthorized production change occurs.

### Completion Report Must Say

```text
COMPLETE LOCALLY OR STAGED AS AUTHORIZED: ARC-OPS-520 Deployment, Monitoring, and Incident Readiness
Next prompt: ARC-PILOT-530
```

---

## `ARC-PILOT-530` - First HVAC Design-Partner Pilot

### Intent

Run the first controlled design-partner pilot for HVAC Lead Recovery with strict safety, monitoring, and rollback controls.

### Prerequisites Claude Code Must Verify

- `ARC-OPS-520` deployment readiness gates are complete.
- Ben has named the pilot tenant and explicitly authorized pilot setup.
- Required provider connections are approved and ready.
- Emergency stop and monitoring are verified.

### Scope

Prepare and support:

- pilot tenant readiness review
- module config review
- provider connection review
- safety/consent review
- initial shadow/test run
- limited live activation if explicitly authorized
- monitoring cadence
- evidence review
- issue log
- pilot outcome report

### Pilot Rules

- Start with the smallest safe scope.
- Prefer shadow/test verification before live sends.
- Use explicit test contacts before real customers.
- Use approved sending windows.
- Monitor opt-outs/replies closely.
- Keep human takeover path ready.
- Stop immediately on safety, consent, duplicate-send, or provider ambiguity issues.
- Do not broaden to additional tenants without a new authorization.

### Pilot Checklist

Before live:

- tenant exists
- Lead Recovery module selected
- config published
- connections ready
- readiness tests passed
- workflow assignment approved
- monitoring active
- rollback plan ready
- emergency stop tested
- operator trained on console
- Ben explicitly authorizes live pilot

During pilot:

- watch scheduled action backlog
- watch failed/ambiguous outcomes
- watch opt-outs
- watch replies
- watch provider errors
- review evidence timelines
- document issues

After pilot:

- summarize verified outcomes
- summarize insufficient evidence
- summarize faults by ARC/workflow/connector/provider/client config
- list recommended fixes
- decide whether to expand, pause, or revise

### Acceptance Criteria

- Pilot runs only under explicit authorization.
- Results are evidence-backed.
- Safety controls work.
- Expansion decision is documented.

### Completion Report Must Say

```text
COMPLETE AS AUTHORIZED: ARC-PILOT-530 First HVAC Design-Partner Pilot
Roadmap complete through first pilot.
```

---

# Quick Prompt Index For Claude Code

When Ben pastes a prompt ID, use this quick lookup:

- `ARC-200`: Build durable runs/actions/scheduler/idempotency.
- `ARC-210`: Add replaceable runner interface and FakeTestRunner.
- `ARC-220`: Add signed secure n8n runner bridge.
- `ARC-230`: Add workflow manifest/versioning/sync and workflow attribution.
- `ARC-240`: Add source-controlled shared n8n workflows and error handler contract.
- `ARC-300`: Build ops tenant creation and module selection.
- `ARC-310`: Build schema-driven settings UI with version compare/restore.
- `ARC-320`: Build connections/readiness/testing/activation UI.
- `ARC-LR-400`: Build Lead Recovery intake, identity, consent, and safety foundation.
- `ARC-LR-410`: Build qualification, messaging policy, and reply stop handling.
- `ARC-LR-420`: Build provider actions and booking/CRM coordination.
- `ARC-LR-430`: Build follow-up sequences and stop-condition scheduling.
- `ARC-LR-440`: Build operator console, evidence timeline, and manual controls.
- `ARC-LR-450`: Build outcome proof, reporting, data quality, and health.
- `ARC-OPT-460`: Build attribution and anomaly detection.
- `ARC-OPT-470`: Build diagnosis and recommendation engine.
- `ARC-OPT-480`: Build recommendation UI, reminders, and guided experiments.
- `ARC-QA-500`: Build security/RLS/contract/idempotency test suite.
- `ARC-QA-510`: Build synthetic E2E and failure-scenario validation.
- `ARC-OPS-520`: Prepare deployment, monitoring, hosted gates, and incident readiness.
- `ARC-PILOT-530`: Run the first HVAC design-partner pilot under explicit authorization.

---

# If Claude Code Is Unsure

If the prompt ID is known but repository state conflicts with this roadmap, Claude Code must stop and ask. Examples:

- The repo contains a newer ADR that renumbers prompts.
- A prerequisite is missing.
- Autoship dry-run is not active.
- Hosted credentials or provider access would be required.
- Tests cannot run because dependencies are missing.
- Existing dirty changes overlap the files that must be edited.

Do not silently reinterpret the roadmap. Do not skip safety gates. Do not commit or push.
