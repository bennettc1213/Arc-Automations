# ARC Native Lead Capture

Status: built and tested locally (`ARC-350`). Migration `0024_native_intake.sql` is **not
applied to any hosted database** and the `native-intake` function is **not deployed** until an
operator does both. Until then the hosted form page says "This form is not available" and the
console's lead capture page says what is missing.

## What it is

How a lead gets into the CRM core (`ARC_CRM_CORE.md`) when the business has no lead platform
of its own. There are four doors, and they all end in the same place.

| Door | Who is acting | Source |
| --- | --- | --- |
| A form ARC hosts, at `/form/<key>`, or the same page framed on their site | nobody signed in (`system`) | `web_form` |
| An API post from the client's own system, with a bearer token | `system` | `webhook` |
| A lead typed in | an operator or a client user | `manual` |
| A CSV file | an operator or the account owner | `import` |

Every door calls `crm_intake_arrival` (0024). In one transaction, behind one lock per client,
it writes the source record, finds or creates the contact, creates the lead (or links the
arrival to the lead that person already has), and writes the consent rows.

## What it is not

- **Not Lead Recovery.** Nothing here sends a message, starts a run or writes `leads` (0010).
  `lead-intake` is still that engine's own door and is unchanged.
- **Not evidence for a figure.** Nothing here writes `events`. `lead_received` is still written
  only by the engine, so a lead that Lead Recovery later picks up is counted once.
- **Not safety truth.** A consent record is what a person was shown and what they chose.
  Whether an address may be messaged is still `suppressions` and the engine's rules.
- **Not a form engine.** A form is a list of questions. It cannot hold a condition, a pattern,
  a script or markup.

## Outcomes

`crm_intake_arrival` returns one of three outcomes.

| Outcome | Meaning |
| --- | --- |
| `created` | A new lead, on a new contact or on the one this person already had. |
| `duplicate` | This person has an open lead inside the window. The arrival is recorded and linked to that lead. No second lead is made. |
| `replayed` | This idempotency key was seen before. Nothing is written. |

Rules it applies:

- **An existing contact is never edited.** An arrival may add a customer. It never overwrites
  one, on any door, including an import.
- **Matching is by phone or email**, in the one spelling the rest of ARC uses. One match is
  used. Several matches are not guessed between, with one exception: a single contact that has
  both the phone and the email.
- **Several matches** are refused on the two doors where a person is present (a typed-in lead
  returns the candidates; an import row is marked `failed`). On the two unattended doors the
  lead is kept on a new contact and a task, "Check for a duplicate contact", is left on it.
- **The window** is the form's `dedupe_minutes`, the import's, or 1440 for an API post and a
  typed-in lead. `0` turns it off. A typed-in lead can pass `allow_duplicate`.

## Forms

`crm_intake_forms` holds a form: a public key, a name, a status, a version and a definition.

- The **public key** (`arcf_` and 32 random characters) is the only thing a browser is given. It
  is not the client's id. An unknown, draft or archived key gets the same 404.
- **Status** is `draft`, `published` or `archived`. Only a published form takes submissions.
  An archived form is restored as a draft, never straight to published.
- The **version** goes up when the definition changes. A source record and a consent record
  say which version the person saw. The link does not change.
- The **definition** is checked by `parseFormDefinition`. It allows ten standard fields with
  fixed meanings (`name`, `phone`, `email`, `service`, `address`, `city`, `region`,
  `postal_code`, `message`, `preferred_time`) and the business's own questions (`q_…`) of five
  types: `text`, `textarea`, `select`, `checkbox`, `number`. Any other key is refused. A form
  must ask for a phone number or an email address.
- A **service** question lists the business's bookable services. With none, it is left off.

The hosted page (`src/portal/pages/PublicForm.jsx`) is the only renderer. The embed is an
`<iframe>` around it (`embedSnippet`): no script runs on the business's site and the snippet
holds no key, token or endpoint. In a frame, the campaign parameters of the host page are not
visible to the form; the referrer is.

## Public intake safety

In order, on the two unauthenticated routes:

1. **The key.** 32 random characters.
2. **The origin.** A submission is accepted only from ARC's own site (`ARC_SITE_URL`, plus
   `ARC_FORM_ORIGINS`). No origin configured means refuse.
3. **Rate limits.** Per address and per form in the function instance. Per form per hour in
   the database (`hourly_cap`), which holds across instances.
4. **Honeypot and dwell time.** Silent: answered exactly like a real submission.
5. **Validation.** `parseSubmission`, against the form's own definition. A key the form does
   not have is ignored. Text over its length is refused, not cut.

Free text is kept as text. Control and invisible characters are removed; markup is not
rewritten, because no page renders it as markup. An answer that looks like a credential is
replaced whole, so a pasted password neither loses the customer's enquiry nor is stored.

A stranger is told `{ ok: true, received: true }` and nothing else.

## Attribution

Two kinds, never mixed.

- **What ARC knows**: `crm_source_events.form_id`, `endpoint_id` or `import_id` (at most one),
  the source, and for an import the file name and row.
- **What a browser claimed**: under `detail.claimed`. The page and referrer without their
  query strings, the five `utm_` parameters, and which ad click identifiers were present (the
  identifiers themselves are not kept). None of it is used to decide anything.

## API intake

`crm_intake_endpoints` holds an endpoint: a name, and the SHA-256 of a token
(`arci_` and 48 random characters). The token is returned once by `intake-endpoint-create`.

`POST /functions/v1/native-intake/hook` with `Authorization: Bearer <token>`:

```json
{
  "event_id": "their-id-0001",
  "contact": { "name": "Dana Reyes", "phone": "614 555 0137", "email": "dana@example.com" },
  "lead": { "summary": "Furnace is rattling", "service": "furnace", "priority": "high" },
  "attribution": { "page": "https://example.com/quote?utm_source=facebook" },
  "consent": { "sms": { "granted": true, "disclosure": "Text me about my quote." } }
}
```

- The tenant is the endpoint's. A key the payload does not define is refused with 422.
- `event_id` (or an `Idempotency-Key` header) is required. A redelivery answers 200
  `replayed` with the same lead.
- A wrong, malformed or revoked token is one 401. A revoked endpoint is never revived.

## Import

1. `intake-import-inspect` reads the headings and suggests a mapping. It writes nothing.
2. `intake-import-preview` stores the file as `crm_import_rows` and says what each row would
   become: `ready`, `invalid` (with the field and the reason, never the value) or
   `duplicate_in_file`. For ready rows it also says whether the person is a new contact, an
   existing one, or shared by several.
3. `intake-import-commit` imports the next 200 ready rows and returns how many are left. The
   console calls it until none are. A refused row is marked `failed` and the rest carry on.

Limits: 2000 rows, 60 columns, 1,000,000 characters. Comma, semicolon or tab. Nothing in a
cell is evaluated.

The import does not use the ARC-200 scheduler. The rows are stored, so an interrupted import
continues from the row it reached, and no work runs without the operator's page asking for it.

## Who may do what

| Action | Operator | Client owner | Client staff |
| --- | --- | --- | --- |
| Read forms, imports, arrivals | yes | own tenant | own tenant |
| Create, change, publish a form | yes | yes | no |
| Type in a lead | yes | yes | yes |
| Import a file | yes | yes | no |
| Make or revoke an API endpoint | yes | no | no |

Only the operator surface exists today (`ops` actions `intake-*`). The service takes ARC-340's
actor, so a client-facing surface needs no new rules. Where a client's own system is the
authority for leads or contacts (`crm_source_policies`), a typed-in lead and an import are
refused; ARC's own intake still records the arrival.

## Code

- `supabase/migrations/0024_native_intake.sql` — tables, guards, `crm_intake_arrival`, the
  import functions, RLS.
- `supabase/functions/_shared/intake/model.ts` — the form schema, submission, CSV, mapping,
  API payload and attribution parsers. Portal-safe.
- `supabase/functions/_shared/intake/service.ts` — every operation.
- `supabase/functions/_shared/intake/public.ts` — the public routes as a plain function.
- `supabase/functions/_shared/intake/supabase-intake-store.ts` — the store.
- `supabase/functions/native-intake/index.ts` — the Deno wrapper.
- `supabase/functions/ops/intake.ts` — the operator actions, listed in its header.
- `src/portal/pages/PublicForm.jsx` — the hosted form.
- `src/portal/components/IntakePanel.jsx`, `pages/ops/ClientIntake.jsx` — the console page.

## Tests

- `tests/intake.test.js` — the model, with no database.
- `tests/intake-db.test.js` — 0024 applied to real Postgres (PGlite): the public handler, the
  service and the `ops` handler over it. Skipped, and reported as skipped, without PGlite.

## Before it is live

1. Apply `0024_native_intake.sql` (after `0023`).
2. Redeploy `ops`.
3. `supabase functions deploy native-intake --no-verify-jwt`.
4. Set `ARC_SITE_URL=https://arcautomation.site` on `native-intake`.
5. Create a form for a test client, publish it, submit it from the hosted page, and check the
   lead, the source record and the consent row.
