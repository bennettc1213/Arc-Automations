# ARC CRM Workspace: Lead Inbox, Pipeline, Tasks

Status: built, tested and deployed (`ARC-360`). Migration `0025_crm_workspace.sql`, the `crm`
edge function and the redeployed `ops` function are on the live project.

## What it is

The day-to-day screen over ARC-340's records and ARC-350's intake: a business opens ARC and
works its leads. One component (`CrmWorkspace.jsx`) is drawn in three places:

| Where | Door | Actor |
| --- | --- | --- |
| Client dashboard, `/portal/dashboard/inbox` | the `crm` function | the signed-in member (`client_user`, owner or staff) |
| Ops console, `/ops/console/clients/:id/crm` | the `ops` function | the operator |
| Demo, `/demo/inbox` | none: generated rows, read-only | none |

Both functions run one action table (`_shared/crm/actions.ts`), so the two sides cannot
disagree about what a button does.

## What it is not

- **Not evidence.** No figure reads these rows. A lead in a `won` stage is what a person set;
  it writes no `events` row and is never counted as a result.
- **Not a second way to change a record.** Every write is ARC-340's own service call, or
  ARC-350's `createManualLead` for a quick-add. The timeline is still written by 0023's triggers.
- **Not a booking screen, and it starts no automation.** The conversation with a customer is
  ARC-370's (`ARC_COMMUNICATIONS_HUB.md`): a message a person writes there is one durable
  action on the queue, never something this screen sends itself.

## The inbox

`_shared/crm/inbox.ts` (portal-safe, shared with the tests) reads each lead's state off its rows.
Nothing is stored.

| Question | Answer |
| --- | --- |
| What needs attention? | Open, and blocked, or a task overdue, or (unless it is waiting on the customer) not contacted or with no next step |
| Who owns it? | `owner_user_id`; "no owner" is its own queue |
| Not contacted? | Still in the pipeline's first open stage. Never guessed from notes |
| Next task? | The open task due first; undated after dated |
| Waiting on the customer? | The stage says so (`waits_on = 'customer'`), never the stage's name |
| Booked or closed? | A won or lost stage |
| Blocked? | An address on the suppression list, or Lead Recovery handed the lead to a person or flagged it, with the reason |

Search (name, email, title, a phone by its digits), filters (queue, stage, owner, source,
priority) and sorts run over the rows one read returned: the newest 500 open and 200 closed
leads. The screen says when a limit was reached.

## What 0025 adds

- `crm_pipeline_stages.waits_on` (`us` | `customer`). The default pipeline's `estimate_sent`
  waits on the customer.
- A stage keeps its `key` and its `kind`. A lead's status is its stage's kind, so changing a
  kind would close or reopen leads nobody moved. A stage with open leads cannot be retired.
- `crm_save_stages`: a pipeline's whole ordered stage list in one transaction (rename,
  reorder, add, retire). The account owner or an operator. Every save is kept whole in
  `crm_pipeline_revisions`; an operator's is also in `admin_actions`.

## Who may do what

ARC-340's `can`, unchanged, checked again in SQL.

| | Read | Move, edit, notes, tasks, quick-add | Hand over, archive | Change stages |
| --- | --- | --- | --- | --- |
| Operator | yes | yes | yes | yes |
| Client owner | own client | yes | yes | yes |
| Client staff | own client | yes | no | no |

The `crm` function takes the role from `tenant_members`, never from the request. A client sees
their own team by sign-in address and an operator only as "ARC team".

A bulk change is each lead's own `updateLead`, one at a time: its own permission check, stage
rules and timeline entry, with each refusal reported per lead.

## Source of truth

`crm-workspace` returns the client's source policies. `lockedFields` gives the fields the
client's own system owns; the screen disables them and names the system, and `writeDecision`
refuses them on the server regardless. Where leads are created externally, "add a lead" is off.

## Code

- `supabase/migrations/0025_crm_workspace.sql`
- `supabase/functions/_shared/crm/inbox.ts`: the derivation, search, filter, sort, locks
- `supabase/functions/_shared/crm/workspace.ts`: the reads, bulk change, stage save
- `supabase/functions/_shared/crm/actions.ts`: the action table for both doors
- `supabase/functions/crm/index.ts`: the client door
- `src/portal/components/CrmWorkspace.jsx`, `CrmRecord.jsx`; `src/portal/lib/crm.js`
- `src/portal/pages/dash/Inbox.jsx`, `src/portal/pages/ops/ClientCrm.jsx`, `src/portal/demo/crm-demo.js`

## Tests

- `tests/crm-workspace.test.js`: the derivation and the rendered screen, no database.
- `tests/crm-workspace-db.test.js`: 0025 applied to real Postgres (PGlite), the service and
  the action table as an owner, staff, an operator and another client's user.

## Not built here

Saved views (the queues are the built-in ones; filters are not stored), merging contacts from
the client side, and booking (ARC-380). Conversations were added by ARC-370: a lead and a
customer each show theirs, and the workspace has a `conversations` tab. See
`ARC_COMMUNICATIONS_HUB.md`.
