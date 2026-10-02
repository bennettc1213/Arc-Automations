# ARC CRM Core and Business Profile

Status: built and tested locally (`ARC-340`, universal CRM core). Migration
`0023_crm_core.sql` is **not applied to any hosted database** until an operator applies it.
There is no screen for it yet; the workspace UI is a later prompt.

## What it is

One customer and lead model that every route uses.

| Route | What these rows are |
| --- | --- |
| ARC Native | The CRM. ARC is the authority for every record. |
| ARC Hybrid | ARC's working copy. Each kind of record, or each field, is owned by ARC or by the client's tool. |
| ARC Connected | ARC's normalised working copy of records that live in the client's CRM. |

There is no second contact model for any module. Lead Recovery's `leads` table (`0010`) stays
the engine's narrow operational row; a CRM lead can point at one (`crm_leads.recovery_lead_id`).

## What it is not

- **Not evidence.** `events` is still the only log a figure is derived from. No page counts
  these tables.
- **Not safety truth.** A contact has no consent or opt-out column. Whether an address may be
  messaged is `suppressions` and the engine's rules, read at the moment of sending.
  `contactSafety` reports it by reference.
- **Not a credential store.** Every free-text column refuses secret-shaped values, in the
  service (`secretProblem`) and again in the database (`crm_text_is_clean`).
- **Not a second name or timezone.** Those stay on `tenants` and in the published tenant
  settings. The business profile adds what no table held.

## Tables

| Table | Holds |
| --- | --- |
| `business_profiles` | Public phone, email, website, business hours, and the route an operator recorded. One row per client. |
| `business_locations` | The business's locations. One primary. |
| `business_service_areas` | Postal codes, cities, counties, regions, or a radius from a location. |
| `business_service_categories`, `business_services` | What the business sells, enough for intake and booking. |
| `crm_contacts` | A customer. Phone in E.164, email lowercased, an owner, and `merged_into_id` once merged. |
| `crm_pipelines`, `crm_pipeline_stages` | A client's pipelines. A stage is `open`, `won` or `lost`. |
| `crm_leads` | A lead or opportunity, always linked to a contact, in a stage of a pipeline. |
| `crm_notes` | Notes on a contact or a lead. Never edited; archived instead. |
| `crm_tasks` | Follow-up tasks on a contact or a lead. |
| `crm_activities` | The timeline. Append-only, written by triggers. |
| `crm_source_events` | One row per arrival (a call, a form post, an import line), with attribution. |
| `crm_external_mappings` | "This ARC record is that record in their system." |
| `crm_source_policies` | Who is the authority for each kind of record. |

Organisations and households are not modelled. Nothing in the repository needs them yet, and
two people sharing a phone number is handled by lookup returning both.

## Rules the database enforces

- **Tenant isolation.** Every table carries `tenant_id`, every cross-table reference is a
  composite foreign key that includes it, and RLS lets a client read only their own rows.
  No browser role has a write policy or may execute any function here.
- **The actor is checked again.** Every write names its actor (`operator`, `client_user`,
  `system`, `external`). The guards check an operator against `arc_admins` and a client user
  against `tenant_members` for that tenant.
- **History cannot be skipped.** `crm_activities` is written by triggers in the same
  statement as the change. It records the names of the fields that changed, never the values.
- **A lead's status is its stage's.** It is never typed. A stage must belong to the lead's
  pipeline and must not be retired. Closing a lead as lost needs a reason.
- **A value needs its source.** `estimated_value_cents` and `estimated_value_source` are
  both set or both empty. ARC never estimates a value on its own.
- **A merge is one transaction** (`crm_merge_contacts`). Leads, notes, tasks, source records
  and mappings move to the surviving contact. The merged contact stays as a read-only row
  pointing at it. A merge that would give one contact two records in the same external system
  is refused whole.
- **Mappings are unique both ways.** One live mapping per record per connector, and one ARC
  record per external id. A mapping is removed, never repointed.
- **The route and the policies cannot disagree.** ARC Native allows only ARC as the
  authority; a client with an external authority cannot be recorded as Native.
- **A client with customers is not a test client.** `purge_test_tenant` now refuses a client
  that has contacts, CRM leads or source records. Setup rows still go with a purged client.

## Source of truth

`crm_source_policies` holds one row per kind of record. No row means ARC.

| Authority | Meaning |
| --- | --- |
| `arc` | ARC owns the record. A sync from an external system cannot write it. |
| `external` | The named connector's system owns it. Nobody edits those fields in ARC. |
| `hybrid` | Split by field. A field not named belongs to ARC. |

`writeDecision` applies this before every write. The owning side writes; the other side is
refused, with the fields named. Nothing is merged and there is no "latest wins".

Two things stay ARC's on every route: who owns the record in ARC, and whether it is archived.
One exception is allowed and it is not an edit: ARC's own intake (`system`) may always
*create* a record, because a missed call on ARC's number is ARC's evidence whoever owns the
customer list.

Setting a policy or a route is an operator action and writes an `admin_actions` row.

## Who may do what

| Actor | Read | Record | Sensitive | Business | Policy | Mapping |
| --- | --- | --- | --- | --- | --- | --- |
| Operator | yes | yes | yes | yes | yes | yes |
| Client owner | own tenant | yes | yes | yes | no | no |
| Client staff | own tenant | yes | no | no | no | no |
| System (ARC intake) | no | yes | no | no | no | yes |
| External (a sync) | no | yes | no | no | no | yes |

"Sensitive" is merging, archiving, restoring and changing an owner. An operator's are also
written to `admin_actions`; a client owner's are in the timeline, which names them.

## Code

- `supabase/migrations/0023_crm_core.sql` — tables, guards, history triggers, RLS.
- `supabase/functions/_shared/crm/model.ts` — vocabularies, permissions, `writeDecision`,
  input parsing. Portal-safe.
- `supabase/functions/_shared/crm/service.ts` — every read and write.
- `supabase/functions/_shared/crm/supabase-crm-store.ts` — the store.
- `supabase/functions/ops/crm.ts` — the operator actions (`crm-*`), listed in its header.

## Tests

- `tests/crm.test.js` — the model, with no database.
- `tests/crm-db.test.js` — the migration applied to real Postgres (PGlite), the service and
  the `ops` handler over it. Skipped, and reported as skipped, without PGlite.

## Before it is live

1. Apply `0023_crm_core.sql` to staging, then production (after `0022`).
2. Redeploy the `ops` function so the `crm-*` actions exist.
3. Record each client's route and, for Hybrid and Connected clients, their source policies.
