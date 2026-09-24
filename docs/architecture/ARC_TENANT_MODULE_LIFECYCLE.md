# ARC-120 — Tenant module lifecycle and activation

> **Handling notice.** `origin` is a **public** repository and `docs/architecture/` is not
> gitignored. This document describes control-plane machinery, not unfixed defects, but
> decide where the set of architecture documents lives before any is committed.

## 1. What changed, in one paragraph

Until ARC-120, "is this module live for this client" was one boolean,
`module_configs.enabled` (0010). An ops action set it after checking an onboarding
checklist, and the engine read it at intake and before each send. Nothing recorded
*which configuration* the switch was turned on for, so an operator could activate
Lead Recovery, publish a new sending number an hour later (ARC-110 made that a clean
publication), and the engine would text customers from the new number without anyone
re-approving it. ARC-120 gives every tenant module one lifecycle record. It keeps the
operator's decision (the **state**), what a published change has made necessary
(**requirements**), which exact configuration versions were **tested**, **shadowed** and
**authorised**, and a separate **health overlay**. One just-in-time authoriser decides,
immediately before each run starts, each action executes and each message is reserved,
whether that may happen. Migration `0015_tenant_module_lifecycle.sql`; code under
`supabase/functions/_shared/lifecycle/`.

The governing rule is unchanged: **a client is configuration, not an n8n workflow.** Nothing
here is per-tenant code, and n8n holds no lifecycle truth: Lead Recovery v1 is
`n8n: 'prohibited'`, and the lifecycle lives in ARC's Postgres.

## 2. Architectural authority

| Concern | Authority | Why |
|---|---|---|
| The legal transitions | `LIFECYCLE_TRANSITIONS` in `lifecycle/model.ts` | One list. The service reads it, 0015 seeds `lifecycle_transition_rules` from the same rows, and `tests/lifecycle-engine.test.js` fails the build on drift. Each history row carries a **foreign key** to its rule |
| What a change costs | The registry (`registry/schemas.ts`), as recorded on each version by ARC-110 (`change_impact`) | ARC-100 §9: trusted metadata, never inferred from a field name |
| What that cost means for a lifecycle | `CHANGE_IMPACT_POLICY` in `lifecycle/policy.ts` | One mapping, §7 |
| Gates (readiness, evidence) | `lifecycle/readiness.ts` + `lifecycle/engine.ts` | Evaluated from facts every time; the registry's validators cannot run in SQL (ARC-100 §2) |
| Structure the gates rest on | 0015's function and triggers | Holds even if application code is wrong, and binds the service role |
| May this run / action / effect happen now | `authorizeModuleExecution` in `lifecycle/authorize.ts` | One decision path, §10 |
| The effective configuration | ARC-110's resolver, unchanged | Readiness consumes it; the lifecycle never reads configuration any other way |

## 3. Lifecycle states

| State | Meaning | Live runs | Synthetic tests | Real leads |
|---|---|---|---|---|
| `unselected` | not part of this client's service (no row, or deselected) | no | no | recorded, no run |
| `configuring` | selected; being set up | no | no (the canary action begins testing first) | recorded, no run |
| `testing` | selected; being proven with synthetic runs | no | yes | recorded, no run |
| `shadow` | real traffic evaluated and recorded as "would have"; nothing sent | no | yes | shadow run, closed at once, observation recorded |
| `active` | live | yes, subject to requirements, health and authorised versions | yes | live run |
| `paused` | taken out of service by an operator or by a published change | no | yes | recorded, no run |

"Unavailable" is computed, not stored: a module the registry does not list as selectable
(`isSelectable`) cannot be selected, and a stored lifecycle for a module that stops being
selectable refuses to run (`module_unavailable`). A stored state this build does not know
(a legacy value, a typo) is `lifecycle_state_unknown`. Every transition and every run is
refused on top of it, and reconciliation leaves it alone.

**Selection storage.** `tenant_modules` is the one execution-side record of selection.
`module_configs.enabled` is now a **mirror** of `state = 'active'`, maintained inside the
transition function and refused by a trigger when anything else tries to write it
(an insert takes the lifecycle's value). `tenants.modules` (0009) is not a selection flag
for execution: it is the portal's reporting declaration of which event buckets a client
expects, with `lead_capture` always on and observation always winning. No execution path
reads it, so it cannot disagree with the lifecycle about whether anything runs. ARC-100
§26 listed replacing it; that is deliberately **not** done here, because it would change
what the client portal reports.

## 4. The legal-transition matrix

Every transition is operator-only unless marked *system*. There is no client actor: no
tenant role can reach any of this (§12).

| From | Transition | To | Role | Configuration | Connections | Evidence | Review | Side effects | Denial when refused |
|---|---|---|---|---|---|---|---|---|---|
| unselected | `select` | configuring | operator | — | — | — | — | switch row created **off**; current versions become the observed baseline | `module_unavailable`, `tenant_inactive` (archived) |
| configuring, paused | `begin_testing` | testing | operator | ready (§5) | — | — | — | — | `config_not_ready` (+ field errors), `tenant_inactive` |
| testing | `stop_testing` | configuring | operator | — | — | — | — | evidence kept | — |
| testing, paused | `enter_shadow` | shadow | operator | ready | ready | passing test of current versions | — | real leads now evaluated as shadow runs | `test_evidence_missing`, `connection_not_ready`, `config_not_ready`, `health_blocks_activation` (blocking), `tenant_inactive` |
| shadow | `exit_shadow` | testing | operator | — | — | — | — | observations kept | — |
| testing, shadow | `activate` | active | operator | ready + module checks | ready | passing test of current versions; shadow review if required | this act | authorised := current versions; switch **on**; `module_activated` step ticked | every blocker at once (§8) |
| active | `pause` | paused | operator | — | — | — | — | switch **off**; queued contact for live runs cancelled (handoffs and closes kept) | — |
| paused | `resume` | active | operator | as `activate` | as `activate` | as `activate` | this act | as `activate` | as `activate` |
| any selected | `deselect` | unselected | operator | — | — | — | — | switch off; queued contact cancelled; configuration, evidence, history kept | — |
| active | `system_pause` | paused | *system* | — | — | — | — | as `pause`; records the impact and cause | — |
| any selected | `apply_config_change` | same | *system* | — | — | — | — | baseline := new versions; requirements added; consequence-free change carries authorisation (§7) | — |
| testing, shadow, active, paused | `record_test` | same | operator | — | — | a synthetic **test-mode** run pinned to the versions claimed | — | evidence row; a pass for current versions clears `retest`; an active module with nothing else pending is authorised for them | `evidence_invalid` |
| shadow | `record_shadow_review` | same | operator | ready | — | ≥1 shadow observation of current versions | — | a pass clears `shadow` | `shadow_observations_missing` |
| any selected | `report_health` | same | operator or *system* | — | — | evidence naming its `source` | — | overlay only | `evidence_invalid` |
| unselected | `backfill_selected` / `backfill_paused` | configuring / paused | *system* | — | — | — | — | **migration only**; the function refuses them | `illegal_transition` |

Any (transition, from, actor) not in the table is refused: `illegal_transition`, or
`forbidden` when the transition exists but not for that actor. Only two rows lead into
`active`, both operator-authored: `activate` and `resume`. The system actor can pause,
evaluate a change and report health. It can never select, activate or resume.

**Concurrency.** Every request carries the `state_version` it read. The function locks
the lifecycle (`pg_advisory_xact_lock` + `select … for update`), compares, and refuses a
stale version with `stale_state` rather than overwriting. The guard requires each change
to move `state_version` by exactly one, with exactly one history row. **Idempotency:** a
repeated `idempotency_key` returns the first answer (`replayed: true`) and writes nothing.
The same key used for a different transition is `idempotency_conflict`. The canary's
evidence is keyed `test:<run id>`, a change evaluation `config:<module>:<tenant version>:<module version>`,
and a deboarding's deselection `deboard:<tenant>:<module>:<version>`.

## 5. Readiness, evaluated every time from facts

| Dimension | Evaluated from | Refusal codes |
|---|---|---|
| **Configuration** | ARC-110 `resolveEffectiveConfig`: both scopes' current **published** versions, composed and validated by the registered schema. A draft never counts; nothing is defaulted | `config_not_ready` with the resolver's code and field errors (paths and the validator's sentences, no values) |
| **Connections** | ARC-100 requirement groups (`any_of`, `all_of`, `optional`, `conditional`) via `evaluateCapabilities`, against the capabilities ARC holds **evidence** for today (`capabilityEvidence`) | `connection_not_ready`; per capability `ready`, `missing`, `invalid`, `expired` (reserved for ARC-130), `unhealthy`, `unsupported`, `unknown` |
| **Onboarding** | the registry's `activationTestKeys`, against the ticked checklist | `onboarding_incomplete` |
| **Module checks** | a per-module hook (`MODULE_ACTIVATION_CHECKS`). Lead Recovery: `canActivate`'s approved campaign, sending number, messaging service. The lifecycle engine itself knows nothing about Lead Recovery | `activation_checks_failed` |
| **Test evidence** | `tested_*` = the current versions, with `test_evidence_id` a **passing test-mode run pinned to exactly them** | `test_evidence_missing` ("ran against an earlier configuration" when stale) |
| **Shadow evidence** | when the registry version `requiresShadowMode` or `shadow` is pending: `shadow_*` = current versions, with a passing operator review | `shadow_evidence_missing`, `shadow_observations_missing` |

**Connection evidence before ARC-130** (the seam ARC-130 replaces). Twilio
capabilities: the effective configuration names a number and a messaging service, **and**
an operator attested `twilio_connected`; the voice capabilities also need `routing_tested`.
ARC web intake: an unrevoked intake key. Anthropic, and anything else: `unknown`. A
configured reference is never taken as proof of health. The health overlay can mark named
capabilities `unhealthy` (`health_evidence.capabilities`). Reopening an attestation
withdraws readiness at once, for activation and for new live runs.

## 6. The health overlay

`unverified` (the default) · `healthy` · `degraded` · `failing` · `blocking`. These are the portal's own words
(`lib/health.js`) where they exist. `unverified` means "no evidence", never healthy, plus
`blocking` for a condition that must stop execution outright. The overlay is separate data
(`health_status`, `health_reason`, `health_evidence`, `health_checked_at`). It changes only
by `report_health`, which requires evidence naming a `source`, and never changes the
lifecycle state. A recovery never reactivates anything.

`HEALTH_POLICY` (`lifecycle/policy.ts`), explicit per status and use:

| Status | activate | new live run | live continue / effect | test | shadow |
|---|---|---|---|---|---|
| unverified | ✅ | ✅ | ✅ | ✅ | ✅ |
| healthy | ✅ | ✅ | ✅ | ✅ | ✅ |
| degraded | ✅ | ✅ | ✅ | ✅ | ✅ |
| failing | ❌ | ❌ | ❌ (retried with backoff, not cancelled) | ✅ | ✅ |
| blocking | ❌ | ❌ | ❌ | ✅ | ❌ |
| anything else | ❌ | ❌ | ❌ | ✅ | ❌ |

**Why `unverified` does not stop live work.** Every live run already needs the operator's
activation evidence: a passing synthetic test of exactly the versions being run,
connection readiness proven, onboarding attested. Every effect re-reads consent,
suppression, replies, takeover and the send-once reservation immediately before it
happens. What `unverified` lacks is a *monitor*, which is ARC-LR-450's to add. When it
lands, flipping `unverified.live_start` to `false` is the whole change. `failing` and
`blocking` are negative evidence and always stop live work. A synthetic test is allowed
under any status, because it is how a person finds out what is wrong.

**Effective status** (`effectiveStatus`) explains both without merging them. An active
module with a failing dependency reads `active · new live runs held (health_blocks_execution)`,
never "paused", because the operator's decision and the system's observation are different facts.

## 7. Change impact → lifecycle

A publication (ARC-110 `publishDraft`, `rollbackConfig`, the panel's save, the legacy
import) calls `reconcileAfterPublication` in the same code path. It compares the version
the lifecycle last evaluated (`observed`) with the current published head, classifies
**every version in between** from the impact ARC-110 recorded on it, and records one
decision: an `apply_config_change` or a `system_pause` history row carrying the previous
and new version ids, the classifications, the per-version chain and the policy applied.
Evaluating the same heads twice is one decision (idempotency key). If the evaluation fails
or never runs, the version still stands. The lifecycle's authorised versions are then no
longer the head, so **no new live run can start** until a later reconciliation succeeds
(`authorization_stale`). A missed call site fails closed.

`CHANGE_IMPACT_POLICY`. The classifications are the registry's flags, plus the two
conservative catch-alls. Several at once combine by union of requirements and intersection of permissions:

| Classification | Registry source | Lead Recovery fields | Authorisation carries forward | Requires | Active may stay active | New live runs | In-flight runs |
|---|---|---|---|---|---|---|---|
| `no_consequence` | no flag | `company_name`, `holidays`, `services`, `service_area`, `booking_url` | **yes** | — | yes | continue, on the new versions | continue |
| `requires_retest` | `requiresRetest` | `timezone`, `business_hours`, `forwarding`, `staff_alerts`, `templates`, `after_hours`, `ai` | no | retest | **yes** (the operator's decision stands) | held until a passing test of the new versions; then resume automatically, **no reactivation** (the registry said none is needed) | continue under their pinned snapshots |
| `requires_shadow` | `requiresShadow` | `safety` (with retest + reactivation) | no | shadow, review | no → `system_pause` | held | stopped (module not active) |
| `requires_reactivation` | `requiresReactivation` | `compliance`, `twilio` (with retest) | no | review, reactivation | no → `system_pause` | held | stopped: "must block a live module until somebody re-approves" |
| `unknown_field` | a changed field the registry does not know | — | no | retest, shadow, review, reactivation | no → `system_pause` | held | stopped |
| `unclassified` | an impact that is missing, malformed, or of an unknown shape | — | no | retest, shadow, review, reactivation | no → `system_pause` | held | stopped |

For a tenant-settings version, a module that does not read the changed field
(`affected_modules`) sees `no_consequence`. In any state other than `active`, the
requirements are recorded against the lifecycle, so the next activation must meet them.
The first configuration a lifecycle ever sees sets the baseline without imposing its
impact, because there was nothing earlier to have been tested.

**What each requirement clears on.** `retest`: a passing test of the current versions.
`shadow`: a passing shadow review of the current versions. `review` and `reactivation`:
the operator's explicit `activate`/`resume`, which is the review. No operator-only
requirement can be satisfied by a tenant role, because no tenant role can reach any
transition. **Test evidence is always bound to exact versions.** Only live authorisation
carries forward, and only across a consequence-free change. Re-activating a paused module
therefore always needs a test of the versions it would authorise, even after a
consequence-free change.

**The database checks it too.** While a module stays active, `tenant_modules_guard` lets
its authorised versions move only to the current, evaluated heads, and only when:
(a) the system's `apply_config_change`, with every version in between classified
`no_consequence` by `lifecycle_impact_classes()`, SQL's reading of the same recorded
impact, parity-tested; or (b) an operator's `record_test`, with a passing test of the new
versions, nothing pending, and nothing in between beyond `requires_retest`. A forged
"consequence-free" decision across a compliance change is refused
(`requirements_pending`).

Publication never activates. A module under test stays under test, a paused one stays
paused, and no run or action is ever repinned: runs keep their snapshots.

## 8. Activation and reactivation

`activate` (from testing or shadow) and `resume` (from paused) are the same gate. It is
re-evaluated **now**, and every reason is returned at once:

1. registry: module selectable; lifecycle selected and in a known state; client not archived or paused;
2. configuration ready (resolver + registered validator);
3. module activation checks (Lead Recovery: approved campaign, number, messaging service);
4. the registry's required onboarding steps ticked;
5. connection readiness for every blocking requirement group;
6. a passing synthetic test of **exactly** the current versions;
7. shadow evidence of the current versions, if the registry version requires shadow mode or `shadow` is pending;
8. health permits activation (not `failing` or `blocking`);
9. any published change not yet evaluated is evaluated first. The operator is then sent
   back (`stale_state`) to review what it requires; nothing unexamined rides in on an
   activation.

On success, `authorized := current versions`, `pending := []`, the switch turns on, and
the history and audit rows are written in the same transaction. The database re-checks
the actor is an operator, authorised = observed = tested = current heads, the test
evidence is a passing test of them, nothing is pending, health allows it, and shadow
evidence exists where required. An activation missing any of these is refused even when
the service is bypassed.

## 9. Testing and shadow guarantees

**Testing.** A test is a synthetic lead (`is_canary`) run through the whole engine in run
mode `test`. `senderFor()` gives it the recording sender. The effect reservation refuses a
"synthetic" effect whose lead is not synthetic, and the run guard refuses a test run for a
real lead. The canary action records the result as evidence, reading the run back from the
database, never trusting the caller: its mode must be `test`, its lead synthetic, its
snapshot versioned. The evidence trigger requires the same. A failed test is recorded and
authorises nothing.

**Shadow.** In `shadow`, a real lead gets a run in mode `shadow` that is closed before
intake returns. The engine evaluates exactly what it would do live, using suppression,
the deterministic safety rules and the first-response decision under the pinned
configuration, and records a `shadow_observation`: simulated, version-bound, with
`would_have: send_first_response | handoff | nothing` and no names, numbers or bodies. It
is structurally incapable of an external effect:

- no sender is chosen, and nothing is queued (`scheduled_actions_lifecycle_guard` refuses
  an action against a shadow run);
- no effect can be reserved (the reservation requires `run_mode = 'live'` for a real lead);
- the authoriser answers `shadow_no_effects` to any continuation or effect;
- the lead's thread gets `automation_completed` with `stop_reason: not_permitted` and
  detail `shadow mode — would have …; nothing was sent`. That is the ending a lead gets
  when nothing is switched on. It is never `sms_sent`, `message_delivered`, `routed` or
  `lead_booked`. Evidence lives in `tenant_module_evidence`, which no portal figure reads,
  so a "would have" can never be counted as a message, a booking or revenue.

Shadow is intake-time evaluation. Simulating follow-ups and classification belongs to the
future fake runner, not here.

## 10. Just-in-time execution authorisation

One function, `authorizeModuleExecution(store, request)`, returns `allow` or `deny` with a
stable code, a sentence and a safe provenance: the checks passed, lifecycle id, state,
version, health, authorised pair, run, action and snapshot ids. It carries no configuration
values and no PII. It never writes, so a refusal reserves nothing.

**Decision order** (the first refusal wins):

1. **run mode.** `start`: the requested mode (`live` | `test` | `shadow`); missing or unknown → `invalid_run_mode`, never live. `continue`/`effect`: the run's own stored mode. A legacy run with none → `run_authorization_unproven`.
2. **identity and pins.** lead, run, action and snapshot all of this tenant and module (`identity_mismatch`); run and action pinned (`snapshot_missing`: a legacy unpinned action); action pin = run pin (`snapshot_mismatch`); snapshot readable for this tenant and module. Test ⇔ synthetic lead (`mode_not_permitted`). Shadow may only `start` (`shadow_no_effects`).
3. **tenant.** exists, not archived, not paused.
4. **registry.** module still selectable (`module_unavailable`).
5. **lifecycle.** a row in a known, selected state (`module_not_selected`, `lifecycle_state_unknown`).
6. **mode against state.** live needs `active` (`module_paused` / `module_not_active`); test needs testing, shadow, active or paused; shadow needs `shadow`.
7. **a new live run only.** nothing pending (`requirements_pending`); authorised versions = current heads = the versions it would be pinned to (`authorization_stale`).
8. **health.** `HEALTH_POLICY` for this mode and kind (`health_blocks_execution`, non-terminal).
9. **configuration**, for a new run: resolved (`config_not_ready`).
10. **connections**, for a live start (all blocking groups) or a live effect (its capability, e.g. `send_sms`): `connection_not_ready`.

The module's own effect gate, `authorizeLeadRecoveryEffect`, calls this first, then
applies Lead Recovery's live customer state. **Current safety state overrides pinned
behaviour:** consent (`no_consent`), suppression and STOP (`suppressed`), a reply
(`customer_replied`), human takeover and safety escalation (`handoff_open`), closure and
booking, and compliance on the pinned configuration. Only then does it reserve the effect,
and the reservation is the send-once guarantee (`already_attempted`, `ambiguous_outcome`).

| Entry point | Kind | What happens on refusal |
|---|---|---|
| `intakeLead`: missed call, web form, inbound SMS with no lead, the canary | `start` | lead and evidence recorded; **no run**; `automation_completed` `not_permitted`, `started: false`, detail `<code>: …`. The database's own refusal at the insert is handled the same way |
| `executeAction`: every claimed action, before anything else | `continue` | tenant stop → cancel the run's queue (as before); identity/pin → fail with the code; non-terminal (health) → backoff retry; lifecycle stop → cancel contact actions with the reason. `open_handoff` and `close_run` still run (bookkeeping), and their messages are refused at their own gate |
| `authorizeLeadRecoveryEffect`: first responses, follow-ups | `effect` | a lifecycle refusal cancels (an operator's pause is not a delivery failure); customer-state refusals as before |
| `notifyStaff`, handoff acknowledgement | `effect` | nothing sent; the handoff itself stands. An unfenced caller (no claimed action) reaches nobody |
| `reserve_lead_recovery_effect` (SQL) | the **transactional** re-check | under a share lock on the lifecycle: a live effect needs `active`, health not failing or blocking, and a live run. A synthetic effect needs a synthetic lead. A pause committed a millisecond before the reservation refuses it |
| `automation_runs` insert (SQL) | the **transactional** new-run check | a live run needs `active`, nothing pending, health allows, and a snapshot of exactly the authorised versions |

**New run versus existing run.** A new live run must be pinned to exactly the currently
authorised versions. An existing run keeps its immutable snapshot for everything it says
(templates, hours, forwarding). What is re-read for it is whether it may still act at all.
A retest-only change leaves in-flight runs speaking their pinned words. A change that
pauses the module stops them. Nothing is ever repinned.

**The voice webhook** still forwards a call whatever the lifecycle says. Forwarding is the
client's phone line, not the automation, and switching a module off must never stop their
calls reaching them (0010). What happens after an unanswered call goes through `intakeLead`.

## 11. Records and audit

| Table | Holds | Mutability |
|---|---|---|
| `tenant_modules` | state, `state_version`, `pending_requirements`, observed/authorised/tested/shadowed version pairs, evidence ids, health overlay | one row per (tenant, module); changes only through the function, one history row per change (`tenant_modules_guard` + a deferred constraint trigger); never deleted |
| `tenant_module_transitions` | from, to, transition, actor type and id, reason code and text, idempotency and correlation keys, version pair, previous pair, evidence id, impact, policy, pending before and after, health before and after, safe metadata, server timestamp | append-only for every role, including the service role; FK to its rule |
| `tenant_module_evidence` | test, shadow observation, shadow review: kind, outcome, run mode, version pair, config hash, capabilities, run id, safe summary, actor | append-only; `simulated` is always true; tied to the run it describes |
| `lifecycle_transition_rules` | the matrix | immutable; drift-tested |
| `automation_runs.run_mode` | `live` / `test` / `shadow`, fixed at creation | null only on pre-0015 runs, which may not act |
| `admin_actions` | `module.<transition>`: from, to, version, reason code, transition and evidence ids, pending, cancelled count; no configuration | written by the function, in the same transaction |

Every version reference is a composite foreign key through `(id, tenant_id[, module_key])`,
so no lifecycle, history or evidence row can point at another tenant's or module's version.
Free-text and JSON columns carry the no-secrets check. `safeSummary` drops anything shaped
like a phone number, an email address or a credential before it is stored.

## 12. Permissions

| Object | Operator (`is_arc_admin()`) | Tenant member | anon | Any browser write |
|---|---|---|---|---|
| `tenant_modules` | read all | read **own tenant's** rows | none | none |
| `tenant_module_transitions`, `tenant_module_evidence` | read | none (operator material, like configuration) | none | none |
| `lifecycle_transition_rules` | read | read | none | none |
| `apply_tenant_module_transition`, `reserve_lead_recovery_effect` | — | — | — | `permission denied` |

The actor is taken from the verified JWT by `ops`, never from a request body. It is checked
again inside the database against `arc_admins`, and a signed-in caller cannot name anyone but
itself. Service-role execution does not bypass domain authorisation: the service applies
every gate, and the triggers bind the service role for the structural ones. A direct
`update tenant_modules`, a forged history row, a forged activation, an edited evidence
row, and writing `module_configs.enabled` are all refused.

## 13. Backfill (0015)

| Before | After | Why |
|---|---|---|
| `module_configs` row, switched **on** | `paused`, pending `retest`, `review`, `reactivation`; switch turned **off**; history `backfill_paused` with `legacy_activation_unbound` and the steps that had been ticked | the old activation named no configuration version, so nothing proves what was approved. An existing active state is preserved only on trustworthy evidence, and there is none |
| `module_configs` row, off | `configuring` | it had been set up |
| no row | no lifecycle (unselected) | selection is explicit |

Nothing is activated and nobody is contacted by the migration. **This changes behaviour on
purpose**: after 0015, a client that was switched on sends nothing until an operator runs
the canary and presses activate (a resumption). See DEPLOYMENT.md §10. Production has in
any case been failing closed since the ARC-015B defect, and 0014's legacy import already
leaves a window with no published configuration.

## 14. Operator surface (backend contract only)

`ops` actions (`ops/lifecycle.ts`): `module-lifecycle-get`, `module-lifecycle-history`,
`module-select`, `module-begin-testing`, `module-stop-testing`, `module-enter-shadow`,
`module-exit-shadow`, `module-shadow-review`, `module-activate`, `module-pause`,
`module-resume`, `module-deselect`, `module-health-report`, `module-reconcile`. Mutations
take `expected_state_version` and an optional `idempotency_key`.

The existing Lead Recovery panel keeps working on the same contract:

- `lead-recovery-get` reports the lifecycle, and `enabled` is now its state;
- `lead-recovery-activate` is `activate` or `resume`;
- `lead-recovery-pause` is `pause`;
- `lead-recovery-canary` begins testing when the module is only configuring (the
  operator's explicit request to test), refuses an unselected module, and records
  version-bound evidence.

The panel gained one "select" button, the lifecycle headline and the state version it
sends back. Deboarding a client deselects its modules through the lifecycle. Shadow,
deselection, health and history have no controls yet: that is ARC-320's console.

## 15. Failure and recovery

| Situation | Behaviour | Recovery |
|---|---|---|
| A publication's lifecycle evaluation fails | the version stands; new live runs held (`authorization_stale`) | `module-reconcile`, or any later publication, or the next activation attempt evaluates it |
| A pause lands between the dispatcher's check and the send | the reservation refuses (`module_paused`); the action is cancelled, not failed; no handoff | none needed |
| Health reported `failing` | new runs and live effects refused (retried with backoff); lifecycle unchanged | report `healthy` or `unverified` with evidence; nothing reactivates by itself |
| A retest-only change on a live client | active, new runs held, in-flight continue | run the canary; a pass authorises the new versions |
| A reactivation change on a live client | system-paused; queued contact cancelled | canary (and shadow + review for safety changes), then resume |
| An unknown stored state | everything refused | an operator repairs it via a migration; nothing is guessed |
| A legacy (pre-0015) in-flight run | refused (`run_authorization_unproven`); handoffs and closes still run | the customer's next contact starts a properly authorised run |

## 16. Boundaries

- **ARC-130** owns real tenant connections, OAuth, credential storage and connection
  health checks. `capabilityEvidence` is the one function it replaces. `expired` is
  reserved for it.
- **ARC-200** owns the durable scheduler, the reconciliation poller and the DLQ.
  Lifecycle checks sit at the claim → execute → reserve boundary that exists today.
- **ARC-210** owns the `AutomationRunner` abstraction. The authoriser's decision is the
  unit a runner would carry. No fake runner is built here: shadow evaluates at intake only.
- **ARC-220–240** own n8n. n8n holds no lifecycle state and Lead Recovery v1 prohibits it.
- **ARC-300/310/320** own the portal and the lifecycle console. §14 is the backend contract they render.
- **ARC-LR-400–450** own Lead Recovery's later behaviour and its monitoring. The health
  overlay and `report_health` are the seam monitoring writes to, with the `unverified`
  policy row the one switch it flips.
- **ARC-OPT-460–480** (recommendations, experiments): nothing here. No recommender has any
  privilege: every configuration change goes through publication and is priced by §7, and
  no system actor can activate.

## 17. Principles, held by code

- Historical configuration versions are immutable (0014), and nothing in ARC-120 edits one.
- Restoration creates a new version (ARC-110 rollback), priced like any other change.
- Publishing configuration never activates or reactivates a module.
- Recommendations never change configuration or lifecycle state automatically.
- Current safety state overrides pinned behaviour.
- Existing run and action pins are never silently changed.
- n8n does not own tenant lifecycle truth.
- A client is configuration, not an n8n workflow.

## 18. Tests

| Suite | What it proves | Runs |
|---|---|---|
| `tests/lifecycle-engine.test.js` (169) | the matrix and its drift against 0015; every allowed and every refused (transition, from); selection, testing, shadow, activation, pause, resume, deselect; stale versions, idempotency, concurrent conflicts; unknown and legacy states; permissions; every change-impact classification with real registry fields; just-in-time refusals (29 kinds) and allowances; a pause landing between the dispatcher and the reservation; shadow sends nothing and counts nothing | always |
| `tests/lifecycle-adapter.test.js` (18) | the exact RPC arguments and payloads the production adapter sends; every column mapped back; typed errors; `run_mode` on the run insert; intake through the production adapter | always |
| `tests/lifecycle-db.test.js` (5 text + 33 database) | 0015 **applied** in PGlite: the conservative backfill over a real 0014 database, re-applying; rules = typed policy; SQL/TS impact-classification parity; FKs with the guard switched off; no path around the state machine (direct updates, forged history, forged activation, edited evidence, the switch mirror); actors, locks, keys, impersonation, concurrency; audit rows; the run insert and the reservation refusing on their own; pause cancelling atomically; shadow; change impact over real SQL; RLS for member, operator and anon | when PGlite is available; otherwise `# SKIP` |
| `tests/config-db.test.js` (+3) | the operator path to live, through the real function, before any live run; the panel's canary, activation and stale pause over real SQL | as above |

Existing suites changed only where they encoded the old switch. A refused lead now has
no run. Pausing and switching on go through the lifecycle. Contract tests create runs in
test mode on a module under test. `republish` runs the real reconciliation.

**Mutation-tested.** See §19.

## 19. Mutation testing

Each defect was mechanically reintroduced on a scratch copy (baseline green first) and the
relevant suites re-run. **20/20 caught.**

| # | Reintroduced defect | Layer | Caught by |
|---|---|---|---|
| 0 | a new live run is not bound to the authorised versions | authoriser | `stale activation evidence…`, `a run pinned to anything but the authorised versions` |
| 1 | pending requirements do not hold new live runs | authoriser | `a pending requirement…`, the retest policy test |
| 2 | a paused module may still run live | authoriser | `a paused module` |
| 3 | failing health never blocks | health policy | `failing or blocking health…` |
| 4 | a compliance change may stay live | impact policy | `requires reactivation (compliance)…` |
| 5 | every change carries authorisation forward | reconciler | the retest, reactivation and shadow policy tests |
| 6 | an unreadable impact reads as no consequence | classifier | `an unknown or unreadable impact…`, `an impact nobody can read…` |
| 7 | shadow mode runs live | intake | the five shadow tests |
| 8 | the effect gate skips the lifecycle | effect gate | `withdrawing the sending attestation stops the next message at the effect gate itself` |
| 9 | the in-memory reservation stops re-reading the lifecycle | memory store | `the reservation refuses a live effect…`, the pause-in-the-gap test |
| 10 | the in-memory run guard is skipped | memory store | `a synthetic lead is never shadow…` |
| 11 | the store accepts activation without test evidence | memory store | `the store refuses an activation without evidence…` |
| 12 | the store ignores a stale state version | memory store | the concurrency tests |
| 13 | the production adapter drops `run_mode` from the run insert | adapter | `a run insert names run_mode…`, and every live run over real SQL |
| 14 | SQL: activation without a passing test of the current versions | 0015 guard | `a forged activation — a legal history row, then the update…` |
| 15 | SQL: the reservation stops re-reading the lifecycle | 0015 reservation | `a live effect cannot be reserved while the module is paused…` |
| 16 | SQL: a live run need not match the authorised versions | 0015 run guard | `with nothing pending, a live run on anything but the authorised versions is still refused` |
| 17 | SQL: history becomes editable | 0015 history guard | `history is append-only…` |
| 18 | SQL: carrying authorisation ignores the recorded impact | 0015 guard | `the function itself refuses to carry authorisation across a change the registry says needs more` |
| 19 | SQL: members read every tenant's lifecycle | 0015 RLS | `a member reads their own tenant's lifecycle row…` |

On the first run four were **missed**: #8, #14, #16, #18. Each time a second layer had
refused first, so the layer under test was never reached. For #8 the reservation refused.
For #14 a data-modifying CTE hid the history row, so the guard refused as "history first".
For #16 a pending retest refused first. #18 was tested in memory only. Three more (#9, #10,
#13) did not apply, because the mutation script did not match the CRLF files. A test now
isolates each of the four layers, and all seven are caught.

## 20. Known limitations

1. `0015` has not been applied to the Supabase project; it has been applied to real
   Postgres (PGlite, Postgres 18.3) by the test suite, together with 0001–0014.
2. Connection readiness before ARC-130 rests on operator attestation (`twilio_connected`,
   `routing_tested`) plus configured references. It is evidence, but weaker evidence than
   a live check.
3. `unverified` health allows live work (§6) until ARC-LR-450 supplies a monitor.
4. Shadow evaluates intake only. Replies and follow-ups are not simulated.
5. Deboarding deselects modules after the deboarding transaction commits, as the login
   deletion does. A failure there is reported, not rolled back; the engine refuses an
   archived client regardless.
6. `tenants.modules` (portal reporting) is intentionally left separate (§3).
