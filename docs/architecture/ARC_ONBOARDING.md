# ARC Onboarding: Routes, Capabilities, Authority

Status: built and tested (`ARC-390`). Migration `0028_onboarding.sql`, four `onboarding-*`
actions on `ops`, and the console page `/ops/console/clients/:id/onboarding`. See "Before it is
live" for what a deployment needs.

## What it is

The part that puts a real company on one of the three routes (`ARC-330`, `routes/model.ts`):
what it has today, who provides each thing a business does from now on, where each kind of
record is kept, and what is still missing before the hand-over to activation.

One page, seven tabs (`OnboardingPanel.jsx`):

| Tab | What it does | Writes |
|---|---|---|
| where it stands | The steps, each read off what exists, and how many capabilities nobody provides yet | nothing |
| what they have | The current-stack questionnaire, and the plan those answers point to | the answers |
| the plan | A route, and for each capability: ARC, their own system, or not part of this setup | the plan |
| route & records | What applying the plan will change, counted, and the button that applies it | the route and the authorities |
| business | Opening hours, public contact details, services | `ARC-340`'s own actions |
| set up & hand over | The ARC pieces the plan asks for, lead sources, and the way to activation | drafts only |
| history | Every answer saved, plan saved and change applied, with who | nothing |

Onboarding needs no workflow editor, no database access and no per-client copy of anything. A
client is still configuration.

## What it is not

- **Not activation.** Nothing here selects a module, moves one through its lifecycle or lets
  one run. Selecting is the client page's panel; testing, shadow and going live are the
  activation page's, and `ARC-120`'s gate decides.
- **Not a connection.** A provider is connected on the activation page, through the
  `connections` function. Onboarding names the system and reports whether ARC can reach it.
- **Not evidence.** Nothing here writes `events`, and no figure reads these tables.
- **Not stored progress.** There is no ticked checklist. See "The steps".
- **Not a sync.** Handing a kind of record to their system changes who may edit it. Moving
  data between the two systems is `ARC-395`'s.

## Three things, kept apart

| | What it is | Where |
|---|---|---|
| **Answers** | What the business said it has. Evidence of a conversation; it decides nothing. | `tenant_onboarding.answers` |
| **The plan** | An operator's decision: a route, and a source for each capability. | `tenant_onboarding.plan` |
| **The matrix** | What is actually so, derived on every read from the plan and the live rows. | nowhere |

`recommendPlan` turns answers into a suggested plan. It is a pure function that returns data;
the page computes it from the answers on screen and copies it into the plan only when somebody
presses "start the plan from this". Saving that plan is a separate act, and saving a plan
writes the plan and one history line — `tests/onboarding-db.test.js` holds that a module's
lifecycle, the route on record, the source-of-truth policies and every ARC piece are exactly
as they were afterwards.

## Capabilities

A capability is something a business does, never a product
(`_shared/onboarding/model.ts`, `CAPABILITIES`):

| Capability | ARC provides | Decides who keeps |
|---|---|---|
| Customer records | yes | `contact` |
| Lead intake | yes | — |
| Lead pipeline | yes | `lead` |
| Website form | yes | — |
| Text messaging | yes | — |
| Email | yes | — |
| Calendar | yes | `appointment` |
| Online booking | yes | — |
| Field-service management | no | — |
| Accounting | no | — |

A CRM is not a capability. It is one kind of provider that can hold customer records and the
lead pipeline, and a company with none has both from ARC.

These are not the registry's capabilities (`registry/capabilities.ts`), which describe what an
adapter can do (`send_sms`). A business capability names the kinds of provider that could be
its other side; a product enters only as the registry connector an `external` choice names, or
as what the business calls a tool ARC has no connector entry for.

### What a capability can be

An operator chooses one of three sources. The matrix reports one of four states, or that
nobody has decided:

| State | Meaning |
|---|---|
| `arc` | The plan gives it to ARC **and** the ARC piece exists: a pipeline, a published form, opening hours, a published booking page. |
| `external` | The plan leaves it with their system **and** ARC can reach that system — or nothing ARC does depends on it. |
| `not_needed` | Left out on purpose. |
| `blocked` | Somebody was named and it does not work yet. The reason is printed, and the step that closes it. |
| `undecided` | Nobody has said. |

`blocked` is never chosen; it is found. `blocked` and `undecided` are the gaps, and every
capability is always listed — none is dropped to make the table look finished.

What makes an `external` capability reachable:

- **A record-owning capability** needs a connector entry, the authority handed over (below),
  and a verified connection (`ARC-130`: only `verified` or `degraded` count; a token is not
  readiness).
- **Lead intake and a website form** can also reach ARC with no connector at all: their system
  posts to an `ARC-350` endpoint.
- **Field service and accounting** are simply theirs. ARC does not read or write them, so an
  unconnected one is `external`, not `blocked`.

Today the registry holds no provider a client connects with their own credential, so a
record-owning capability left with their system is honestly `blocked` ("ARC has no connection
to … yet"), and the page says what ARC does meanwhile: it keeps its own copy and cannot read
or change the records there. ARC's own accounts (its telephony, its intake door) are refused
as "their system" — on those, the answer is ARC.

Text and email given to ARC are `blocked` until a channel adapter exists (`ARC-370`'s
`PRODUCTION_CHANNEL_ADAPTERS` is empty). The reason says that automated follow-up texts still
go out through ARC's number once that module is live.

## Route rules

`parsePlanInput` holds them, and 0028's `onboarding_plan_problem` holds the ones that protect
data again:

- **ARC Native** keeps every record in ARC. No record-owning capability may be `external`. A
  tool that owns no ARC record (their accounting) can still be kept.
- **ARC Connected** keeps the customer list in their system. It may not be ARC's, or left out;
  it may be undecided while the plan is being filled in.
- **ARC Hybrid** names at least one system they keep, once every capability is decided —
  otherwise it is Native by another name.

## Where each record is kept

The route (`business_profiles.route`) and who owns each kind of record
(`crm_source_policies`) are `ARC-340`'s, and change in exactly one place:
`onboarding_apply_authority`.

1. `onboarding_authority_pending` works out what the plan asks for that is not yet so: the
   route, and the authority for `contact`, `lead` and `appointment`. Each change carries how
   many records ARC holds and how many of them are linked to the other system. The answer has
   a `digest`.
2. The page prints that change in sentences (`impactLines`) before the button.
3. The apply call sends the digest back. 0028 works the change out again under the row's lock
   and refuses with `impact_changed` if it is no longer that change — a customer arrived, a
   mapping was made, the plan moved. What is applied is what was read.
4. The writes are the 0023 tables' own, through their own guards and audit triggers, in the
   order those guards need: the route first when leaving Native, last when arriving.

Rules:

- Their system becomes the authority only where the plan names a connector the registry has.
  A tool with no entry cannot be handed anything.
- A capability nobody has decided makes no claim — except on Native, where every record is
  ARC's.
- A field-by-field split an operator already made with that same system (`hybrid`, through
  `crm-policy-set`) satisfies `external` and is left alone.
- **Nothing is deleted.** Handing records to their system leaves ARC's copy where it is, and
  `writeDecision` then refuses an ARC-side edit of the fields they own. Taking them back
  leaves every mapping as history, and refuses their side instead.
- An operator's act, on every route, in the audit log twice: `onboarding.route_changed` /
  `onboarding.authority_changed`, and 0023's own `crm.route.recorded` /
  `crm.source_policy.set`.

Changing route later is the same act: save a different plan, read what it will change, apply.

## The steps

`onboardingSteps` reads each step off 0028's `onboarding_facts`, which counts the tables that
hold the thing:

| Step | Done when |
|---|---|
| What they have today | every question is answered |
| Route | the route on record is the plan's |
| Who provides what | no capability is undecided |
| Business profile, hours and services | opening hours and at least one service exist |
| Where each record is kept | nothing is pending |
| Connect the systems they keep | each is connected (not needed on Native; blocked while ARC has no adapter) |
| Link existing records | every record ARC holds is mapped to its counterpart |
| Lead sources and forms | intake, pipeline and form are each provided |
| Bring in their customer list | an import completed (only when they said the list is in a file) |
| Calendar and booking | calendar and booking are each provided |
| What ARC runs for them | a module is selected |
| Test, shadow and go live | everything selected is active |

Nothing is ticked by hand, so closing the page loses nothing and reopening it cannot show a
stale tick. `ready_for_handoff` means none of this page's steps is outstanding. It says
nothing about whether a module may go live.

`onboarding-enable` makes the ARC piece behind a capability the plan gives to ARC — the
pipeline, a draft form, an appointment type and a draft booking page — each through the service
that owns it (`ARC-340`, `ARC-350`, `ARC-380`). A draft is never published by onboarding, and
asking twice makes it once.

## Who may do what

Everything here is an operator's: `can(actor, 'policy')` in the service, `arc_admins` again in
0028. A client's own account owner is refused, and the client's `crm` door is not given
onboarding at all. Both tables are readable by operators only and writable by no browser role.

A save carries the revision the page was drawn from; a stale one is `409 stale`, never merged.
An archived client's onboarding can be read and not changed.

## Code

| | |
|---|---|
| `supabase/migrations/0028_onboarding.sql` | the two tables, the plan guard, facts, pending and apply |
| `_shared/onboarding/model.ts` | portal-safe: capabilities, parsing, recommendation, matrix, steps, impact wording |
| `_shared/onboarding/service.ts` | the read and the three writes |
| `_shared/onboarding/supabase-onboarding-store.ts` | the store |
| `ops/onboarding.ts` | the four actions |
| `src/portal/components/OnboardingPanel.jsx` | the page |

## Tests

- `tests/onboarding.test.js` — the model: recommendations for each route, the route rules, the
  matrix states, the steps, the wording of a change, and that no line names a product or a
  workflow runner.
- `tests/onboarding-db.test.js` — 0028 as written (RLS, grants, vocabularies drift-tested
  against the model, what each function may touch), and 0028 applied on PGlite through the real
  `ops` handler: Native end to end with no other system, Hybrid, Connected, a route changed
  back with every record kept, the stale digest, permissions, audit, isolation between
  clients, and resuming.

## Before it is live

1. Apply `0028_onboarding.sql`. It needs `0023` to `0027`.
2. Redeploy the `ops` function.

No new secret, and no new public function.

## Not built here

- **A client-facing view.** A client does not see their own onboarding yet.
- **A provider a client can connect.** Until the registry has one, every record-owning
  capability left with their system stays `blocked`.
- **Bulk linking.** A record is mapped one at a time (`crm-mapping-add`); the step counts what
  is left. Bulk mapping and synchronisation are `ARC-395`'s.
- **Splitting a record field by field** from this page. That stays `crm-policy-set`.
- **Service areas and locations** on the business tab. Their actions exist (`ARC-340`); this
  page edits hours, contact details and services.
