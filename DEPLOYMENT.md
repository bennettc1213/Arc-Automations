# Deploying Arc

Everything needed to take this repository from a clone to a contractor
receiving a text back from a call they missed. Written for whoever is doing the
deploy, which is currently one person.

Companion to [PORTAL_CONTEXT.md](PORTAL_CONTEXT.md) (what each piece *is*) and
[EVENT_CONTRACT.md](EVENT_CONTRACT.md) (what an event means).

Order matters in exactly one place, and it is called out where it does.

---

## 1. The static site

```bash
npm install
npm run dev        # http://localhost:5199
npm run build      # → dist/
npm run preview    # serve the built bundle
```

Published to GitHub Pages by `.github/workflows/deploy.yml` on every push to
`main`, and on a nightly cron at 09:00 UTC — the demo data is generated at
*build* time, so a repo that sits still for a week publishes a demo that reads
as abandoned.

Two build-time variables, both browser-safe (row level security is what
constrains the anon key):

| variable | where | notes |
|---|---|---|
| `VITE_SUPABASE_URL` | GitHub Actions secret, and `.env.local` for dev | |
| `VITE_SUPABASE_ANON_KEY` | GitHub Actions secret, and `.env.local` for dev | **the service-role key is never here.** This repo is public. |

---

## 2. Migrations

Apply `supabase/migrations/0001` … `0010` **in order**. Nothing in 0010 is
destructive, nothing is backfilled, and no existing table is altered.

```bash
supabase db push
```

Deploy order between the migration and the bundle does not matter: a browser
carrying this release against a database without 0010 gets a 501 from the
console's Lead Recovery panel naming the migration, and every other page is
unaffected.

To roll 0010 back, the exact statements are in a comment block at the top of
the file.

### 0014 — versioned configuration (ARC-110): the order matters

0014 moves configuration out of `module_configs.config` into published versions
(docs/architecture/ARC_VERSIONED_TENANT_CONFIGURATION_ENGINE.md). It copies each
existing configuration into **drafts** — it cannot validate them in SQL, so it
publishes nothing — and freezes the old column. Until the import below runs, a
tenant configured the old way has **no published configuration**, and the new
functions fail closed for it: leads are recorded with no run, and an inbound
call to its number hears "not configured". So do these together:

1. `supabase db push` (applies 0014).
2. Deploy `ops`, `twilio`, `lead-intake` and `dispatch` from this release.
3. As an operator, run the import and read its report:

   ```json
   { "action": "config-import-legacy" }
   ```

   `imported` — published as version 1, same effective behaviour as before.
   `quarantined` — left as open drafts with field errors; fix through the Lead
   Recovery panel's save button (or `config-draft-update` + `config-publish`).
   `failed` — usually `number_claimed`: two tenants held the same Twilio number.
4. Press **run a synthetic canary** for each imported tenant and confirm
   `passed: true`, state `awaiting_reply`.

Running the import twice is harmless. Nothing in 0014 rewrites an existing
snapshot, run or action.

### 0015 — the module lifecycle (ARC-120): previously live clients pause

0015 gives every tenant module one lifecycle record and makes
`module_configs.enabled` a mirror of it
(docs/architecture/ARC_TENANT_MODULE_LIFECYCLE.md). The old switch never recorded
which configuration it was turned on for, so the migration **does not carry an
activation over**: a client that was switched on becomes **paused**, needing a
retest, a review and a reactivation, and its switch turns off. A client that was
configured but off becomes *configuring*. Nothing is activated and nobody is
contacted. Apply it **with 0014**, in the same sitting:

1. `supabase db push` (applies 0014 and 0015).
2. Deploy `ops`, `twilio`, `lead-intake` and `dispatch` from this release.
3. Run `config-import-legacy` (above). Each import is also evaluated by the
   lifecycle; the first published configuration sets its baseline.
4. For each client that was live: open the Lead Recovery panel, press **run a
   synthetic canary** (a pass is recorded as evidence for exactly the published
   versions), then **activate** — for a paused module that is a resumption, with
   every gate re-checked. It refuses with every reason at once if anything is
   missing.

Until step 4, a previously live client records its leads and sends nothing, exactly
as between steps 2 and 3 of 0014. Any legacy run still in flight cannot act (it was
never authorised by a lifecycle); its handoffs and closes still run, and the
customer's next contact starts a properly authorised run.

### 0016 — provider connections (ARC-130): Vault first, and a canary before production

0016 stores tenant provider credentials in **Supabase Vault** and nowhere else
(decision: ADR ARC-010 §20a; design: docs/architecture/ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md).
It creates `provider_connections`, their append-only events and transition rules, and a
non-exposed `arc_private` schema holding credential versions and OAuth sessions. It
revokes every API role's access to `vault` and `arc_private`, and then **asserts** the
result (`public.credential_isolation_problems()`, re-runnable as a query). The migration
**fails** in three cases:
- `anon` or `authenticated` can still reach either schema;
- any API role, `service_role` included, can still reach `arc_private`;
- the database shows the Data API exposing either schema.

`service_role` keeps the Vault grants Supabase itself makes, which a project cannot revoke
(ADR ARC-010 §20a, amended 2026-09-28), so the Data API's **Exposed schemas** must stay
`public` and `graphql_public`. It also fails on a database without Vault.

It changes no existing table, creates no connection, migrates no credential (there are
none to migrate) and activates nothing.

1. **Staging first.** `supabase db push` on a non-production project, then run the
   hosted Vault checklist (ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md §15) with a synthetic
   canary. Record the results there. Do not continue to production until every item passes.
2. Set `ARC_ENVIRONMENT`, `ARC_SITE_URL` and `ARC_OAUTH_REDIRECT_URL` on the
   `connections` function (§4 below).
3. `supabase db push` on production, then `supabase functions deploy connections`.
4. Redeploy `ops`, `twilio`, `lead-intake` and `dispatch`: their shared code now reads
   connection evidence for ARC-120 readiness. With no tenant connections this changes
   no decision, because Lead Recovery's providers are ARC-managed.

If the migration stops with `arc_connection:vault_unavailable: <role> can still …` or
`… the Data API serves vault or arc_private`, a browser role, or anything touching
`arc_private`, is not locked out on that project. Do not work around it: that is the
"permissions cannot be safely restricted" stop condition, and it needs Supabase support or an
ADR revisit. (`service_role`'s own Vault grants were such a stop, and were decided in that
ADR amendment.)

### 0017 — durable runs, actions and scheduling (ARC-200): after 0016

0017 makes the 0010 queue the platform's: a reviewed vocabulary of action types
(`automation_action_types`), runs that are not lead conversations, an attempt history
(`automation_action_attempts`), stored lease expiries, a claim-time gate (lifecycle,
tenant, run and connection state) and the scheduler's service-role functions. It
references `provider_connections`, so it applies **after 0016** — and therefore not
before the hosted Vault checklist that gates 0016.

What changes for Lead Recovery, which shares the tables:

- its claim takes only its own seven action types (the only ones that exist today), and
  every claim now writes an attempt row that its completion settles;
- a module pause still cancels its queued contact exactly as before; only the new
  scheduler types are held instead of cancelled.

Nothing is sent, activated or backfilled beyond typing the existing rows. No function
calls the scheduler yet — its runner arrives with ARC-210 — so after `supabase db push`
the only functions to redeploy are the ones 0016 already required.

### 0018 — the runner bridge's ledger (ARC-220): after 0017, staging only for now

0018 adds `runner_dispatches`, `runner_nonces` and `runner_bridge_log` and seven
service-role functions. It creates no rows and changes nothing existing. The n8n runner
and the `runner-bridge` function **refuse production** (ADR ARC-010 §26) until written
licensing confirmation from n8n is on record and the check is deliberately changed, so in
production 0018 is inert. Apply it, and deploy `runner-bridge`, on staging to prove the
bridge end to end (ARC-OPS-520).

### 0019 — workflow manifest, deployments and assignments (ARC-230): after 0018

0019 adds `runner_workflow_versions`, `runner_workflow_deployments` (the only place an
n8n workflow id is kept, per environment) and `runner_workflow_assignments`, records on
every dispatch which workflow version and checksum it ran, and replaces 0018's
`record_runner_dispatch` with one that takes an assignment. It creates no rows. Nothing can
be dispatched until an operator registers a version from `n8n/manifest.json`, approves it,
records its staging deployment and assigns it — and nothing can be assigned to Lead
Recovery v1, which the registry marks `direct` and n8n-`prohibited`. Deployments to
`production` are refused by a check constraint until the ADR §26 gate closes.

### 0020 — failure reports from the shared error handler (ARC-240): after 0019

0020 adds `resolve_runner_failure` — which dispatch a failed n8n execution was, checked
against the failed workflow's deployment and the reporting handler — an index to find it,
and the `failure` route in the bridge's nonce ledger and log. It creates no rows and changes
no existing one. Redeploy `runner-bridge` with it: the function gains `/failure`, and every
inbound request is now checked as n8n's JWT (ADR §18 as amended), so 0020 and the function go
together.

**Setting up the shared workflows in a staging n8n — only when Ben authorises a hosted sync.**
Nothing here has been done against a real n8n yet.

1. In n8n, create two **JWT** credentials (passphrase, HS256), named exactly:
   `ARC dispatch` — the value of `ARC_RUNNER_DISPATCH_SECRET` — and `ARC bridge signing` —
   the value of `ARC_RUNNER_CALLBACK_SECRET`. Nothing else: a shared workflow holds no other
   credential, and never a tenant's.
2. `node scripts/n8n-manifest.mjs` — every export valid and matching its checksum.
3. Import `n8n/workflows/arc-runner-error-handler-v1@1.0.0.json`. In its **ARC environment**
   node, replace the placeholder with this environment's
   `https://<ref>.supabase.co/functions/v1/runner-bridge`. Change nothing else — the checksum
   leaves only that value out, and the sync check (`bridgeUrl`) compares it.
4. Register, approve and record the staging deployment (0019) with its n8n id, then run the
   sync check. There is no action workflow to assign until a module version may use n8n.

### 0021 — creating a client through ops (ARC-300): after 0015, with `ops` redeployed

0021 adds `create_tenant` — the tenant, each chosen module selected through 0015's
transition function (configuring, never active), the `tenant created` onboarding step, a
`tenant_creations` record and an `admin_actions` row, in one transaction — and **drops the
browser insert policy on `tenants`**, so a client can only be created that way. Redeploy
`ops` in the same sitting: until both are done, **add a client** in the console either uses
the old browser insert (old function, no 0021 — it says so on the page, and nothing is
audited or selected) or is refused (0021 applied, old function). It creates no rows itself
and changes no existing tenant.

Check afterwards: create a throwaway client with no module, confirm one `tenant.created` row
in the audit log, then delete it (0022).

### 0022 — deleting a test client: after 0021, with `ops` redeployed

0022 adds `purge_test_tenant` and the `tenant_purges` record, and re-creates the seven
append-only guards of 0014/0015 as an insert/update trigger plus a delete trigger that makes
one exception: inside that function, for the client it has just recorded. A client with any
real history — events, leads, conversations, runs (even a canary), queued actions, attempts,
dispatches, connections, OAuth sessions, opt-outs, a used ingest token — is refused, and is
deboarded instead. The console's **delete this test client** panel is at the bottom of every
client page.

### 0023 — the CRM core and business profile (ARC-340): after 0022, with `ops` redeployed

0023 adds the `crm_*` and `business_*` tables, their guards and history triggers, and
re-creates `purge_test_tenant` with three more reasons to refuse (customers, CRM leads, source
records). It alters no existing table. Redeploy `ops` afterwards so the `crm-*` actions exist;
before 0023 is applied they answer 501 and say so. Nothing in the console calls them yet.
See docs/architecture/ARC_CRM_CORE.md.

### Trying the ops console against staging (no production involved)

The live site talks to the live project, so staging is tried from a local copy of the site.
Ops sign-in is a password, so nothing in staging's auth settings needs changing.

1. Apply and deploy to staging (the repo's link must point at `czpwusgfxknnayurwmeb`):
   `npx supabase migration list` (confirm), `npx supabase db push`,
   `npx supabase functions deploy ops`.
2. Make yourself a staging operator: Supabase dashboard → arc-staging → **Authentication →
   Users → Add user** (email + password, auto-confirm). Then **SQL Editor**:
   `insert into public.arc_admins (user_id) select id from auth.users where email = 'you@…';`
3. Create `.env.staging.local` in the repo root (gitignored) with staging's
   `VITE_SUPABASE_URL=https://czpwusgfxknnayurwmeb.supabase.co` and `VITE_SUPABASE_ANON_KEY=`
   (dashboard → **Project Settings → API**, the anon/publishable key).
4. `npx vite --mode staging`, open `http://localhost:5173/ops`, sign in with the user from 2.
5. The checks: **add a client** with Lead Recovery ticked → its page shows the **modules**
   panel with Lead Recovery *configuring* and "tenant created" ticked; **audit log** shows
   `tenant.created`. Then **delete this test client**, type its handle → it disappears and the
   audit log shows `tenant.purged`. A client given an event first
   (`insert into events (tenant_id, event_type, occurred_at) values ('<id>', 'lead_received', now());`)
   is refused with "has real activity".

---

## 3. Edge functions

```bash
# the public boundary — authenticates with its own bearer token, not a JWT
supabase functions deploy ingest --no-verify-jwt

# the client's sign-in door — the caller is by definition signed out
supabase functions deploy client-login --no-verify-jwt

# the operator surface — JWT verification ON, every caller is signed in
supabase functions deploy ops

# the execution layer (0010)
supabase functions deploy twilio      --no-verify-jwt   # the HMAC is the gate
supabase functions deploy lead-intake --no-verify-jwt   # the intake key is the gate
supabase functions deploy dispatch    --no-verify-jwt   # a shared secret, or an admin JWT

# provider connections (0016) — JWT verification ON; only after the hosted Vault checklist
supabase functions deploy connections

# the n8n runner bridge (0018) — staging only; answers 503 in production (ADR §26)
supabase functions deploy runner-bridge --no-verify-jwt   # n8n's own JWT over the body is the gate
```

`ingest` must be **redeployed** for 0010 even though its own code barely
changed: the six new event types live in `_shared/event-validation.ts`, and
until it is redeployed they are rejected at the door with a 400 naming them.

---

## 4. Secrets

Set on the Supabase project, never in this repository.

| secret | needed by | what happens without it |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | every function | provided by the platform |
| `ARC_SITE_URL` | `client-login`, `ops`, `twilio`, `lead-intake`, `dispatch` | magic-link redirects fall back to the platform default; console links are omitted from staff alerts |
| `ARC_AUTH_REDIRECT` | `client-login` | optional override of the callback path |
| `N8N_API_URL`, `N8N_API_KEY` | `ops` | the live pipeline check still tests ingest, tokens, events and `/healthz`, and reports the workflow rows as "could not be asked" |
| **`TWILIO_ACCOUNT_SID`** | `twilio`, `lead-intake`, `dispatch`, `ops` | nothing can send |
| **`TWILIO_AUTH_TOKEN`** | the same four | **every webhook is rejected with 403.** An empty token never validates a signature |
| **`ARC_PUBLIC_FUNCTIONS_URL`** | `twilio`, `lead-intake`, `ops`, `dispatch` | falls back to `${SUPABASE_URL}/functions/v1`. Set it explicitly if anything sits in front of the functions — signatures are computed over this string |
| **`ARC_DISPATCH_KEY`** | `dispatch` | the scheduler cannot authenticate; an operator can still run the queue by hand |
| `ANTHROPIC_API_KEY` | `twilio`, `dispatch`, `ops` | **optional.** Without it every lead is handed to a person with the reason stated — the designed degradation, not a failure |
| **`ARC_ENVIRONMENT`** | `connections` | `production`, `staging`, `development` or `test`. **Unset is treated as production**, which is safe: only Vault and the real registry are ever used |
| **`ARC_OAUTH_REDIRECT_URL`** | `connections` | OAuth cannot begin. It must be exactly the redirect URI registered with each provider, on `ARC_SITE_URL`'s origin, https |
| `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET` | `connections` | that provider cannot be connected. The names come from the registry's `clientIdEnv`/`clientSecretEnv`; none are registered yet |
| `ARC_RUNNER_CALLBACK_SECRET` | `runner-bridge` (staging) | every envelope, callback and failure request is answered 503 `bridge_unconfigured`. ≥ 32 characters; the same value is n8n's `ARC bridge signing` JWT credential, which the shared workflows sign with. `ARC_ENVIRONMENT` must also be set to a non-production value, or the bridge answers 503 |
| `ARC_RUNNER_DISPATCH_SECRET` | the worker that runs `N8nRunner` (staging; none deployed yet) | nothing can be dispatched to n8n. ≥ 32 characters, **different** from the callback secret; the same value is n8n's `ARC dispatch` JWT credential on its webhooks |

Tenant credentials are **never** function secrets. They live in Supabase Vault, written
and read only through 0016's service-role functions (ARC-130).

```bash
supabase secrets set \
  ARC_SITE_URL=https://bennettc1213.github.io/Arc-Automations \
  ARC_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  ARC_DISPATCH_KEY=$(openssl rand -hex 32) \
  ANTHROPIC_API_KEY=sk-ant-...
```

The Twilio account SID and auth token are **Arc's, one pair for the whole
platform**. Tenant separation is the phone number and `tenant_id` on every row
— never a second credential. A tenant's subaccount SID, messaging service SID
and phone number are non-secret identifiers and live in
`module_configs.config.twilio`; the config validator refuses anything that
looks like a credential, including a bare 32-character hex string, which is
exactly what a Twilio auth token looks like.

---

## 5. The dispatcher's schedule

Everything the engine will do in the future is a row in `scheduled_actions`.
The first response is normally sent by the webhook's own dispatch call; the
schedule exists for follow-ups, closes and retries, none of which are
second-sensitive. Once a minute is right.

Enable `pg_cron` and `pg_net`, then in the SQL editor:

```sql
select cron.schedule('arc-lead-recovery-dispatch', '* * * * *', $$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/dispatch',
    headers := '{"content-type":"application/json","x-arc-dispatch-key":"<ARC_DISPATCH_KEY>"}'::jsonb,
    body    := '{"limit":25}'::jsonb
  );
$$);
```

Overlapping runs are safe: `claim_scheduled_actions()` hands a row to exactly
one caller under `for update skip locked`.

---

## 6. Twilio, per tenant

Buy the number in the Twilio console. **Nothing in Arc provisions a Twilio
resource**, deliberately: it is billable and externally visible, so a person
does it and records the reference.

### The exact webhook URLs

With the project at `https://<ref>.supabase.co`:

| where in the Twilio console | method | URL |
|---|---|---|
| Phone Numbers → *the number* → Voice → **A call comes in** | `HTTP POST` | `https://<ref>.supabase.co/functions/v1/twilio/voice` |
| Phone Numbers → *the number* → Messaging → **A message comes in** | `HTTP POST` | `https://<ref>.supabase.co/functions/v1/twilio/sms` |
| Messaging → Services → *the service* → Integration → **Delivery Status Callback** | `HTTP POST` | `https://<ref>.supabase.co/functions/v1/twilio/message-status` |

There is **no fourth field to fill in**. The dial-result callback
(`…/twilio/dial-status`) is set by the TwiML that `…/twilio/voice` returns, not
in the console — which is why an operator cannot get it wrong and why it is
always in step with the deployment.

The console's **test phone routing** button prints all four URLs for the tenant
you are looking at, alongside the TwiML that would be returned. Use that rather
than transcribing from here.

### How a webhook finds its tenant

**The number that was called owns the request.** `To` on a voice or SMS webhook
is matched against `twilio.phone_number` in each tenant's **current published**
Lead Recovery configuration (0014), and that is the entire routing rule.
Publishing a number another tenant's current version already holds is refused.

There is no tenant id in the URL, no subaccount in a header and no query
parameter, because every one of those is something a caller could change. A
number claimed by two tenants is **refused** rather than guessed at — routing
one company's calls to another is worse than dropping them. The delivery-status
callback carries no reliable `To`, so it resolves through the `messages` row we
wrote when we sent it.

### Compliance

Register the brand and the A2P campaign before activating anything. Arc refuses
to send on a campaign whose `compliance.status` is not `approved`, and
activation refuses to switch the module on. Both are fail-closed with no
override.

---

## 7. Onboarding a client

**Add a client** (`/ops/console/clients/new`) creates the account and, if you tick
it under *which modules*, selects Lead Recovery in the same step (ARC-300, 0021).
Selecting never activates. A client created without it gets it from the **modules**
panel on their page, or the lead recovery panel's own select button.

In `/ops/console/clients/:tenantId`, the **lead recovery** panel. If the module
is not selected yet, press **select lead recovery for this client** first —
selection is an explicit, audited operator act (ARC-120), and nothing can be
tested or activated before it. Then eleven steps, eight required, in the order
they are actually done:

1. **tenant created** — the client exists and has a client ID. Ticked for you
   when the module was chosen at creation.
2. **business rules completed** — hours, services, service area, forwarding
   destination, templates. Ticks itself when a valid config saves. These can also
   be edited on the client's **settings** page (ARC-310; needs `ops` redeployed),
   which shows each change's consequences before publishing and keeps the history. A save
   publishes the changed parts as new versions (tenant settings, then Lead
   Recovery); a form loaded before somebody else saved is refused — reload it.
3. **staff destination verified** — somebody answered a test call on the
   forwarding number.
4. **Twilio resources connected** — number and messaging service recorded.
5. **phone routing tested** — press *test phone routing*. No call is placed.
6. website origin configured *(not required)* — issue an intake key naming the
   origins the form may post from.
7. **message templates approved** — the client has read the exact words.
8. **consent process recorded** — how consent is captured, written down.
9. **messaging compliance approved** — brand and campaign registered.
10. **synthetic tests passed** — press *run a synthetic canary*. It goes end to
    end with a recording sender, addressed to Twilio's reserved test number. The
    first press begins *testing*; a pass is recorded as evidence bound to exactly
    the published configuration versions it ran against.
11. module activated — ticked by activation itself.

Then press **activate**. It authorises exactly the configuration versions the
canary passed on. If it refuses it prints every reason at once; there is no
override.

To pause, press **pause**: new sequences stop and everything already queued that
would reach somebody is cancelled (a handoff still opens, silently). Calls keep
forwarding — switching a client's module off must never stop their phone ringing.

**After a configuration change on a live client**, the save's response says what
the lifecycle made of it. A change with no consequence (services, holidays,
company name) stays live. A retest change (templates, hours, forwarding, staff
alerts) keeps the module active but holds new leads until a canary passes on the
new versions — in-flight sequences keep their approved words. A compliance,
number or safety change pauses the module: canary (and for safety, shadow mode
and a review), then activate.

### The website form

Issuing an intake key returns a snippet:

```html
<div data-arc-lead-form></div>
<script defer src="https://<ref>.supabase.co/functions/v1/lead-intake/embed.js?key=arcw_..."></script>
```

The key is public by construction — it is printed in their HTML. What protects
the endpoint is the origin allowlist (an **empty** list refuses, it does not
allow-all), a honeypot, a minimum dwell time and per-key and per-IP rate limits.
Rotating revokes the old key immediately, so replace the snippet in the same
sitting.

---

## 8. Testing locally

```bash
npm test          # node's own runner, zero dependencies
npm run build     # proves the bundle compiles
npm run smoke     # renders every public page in a real browser
```

The configuration engine's database suites (`tests/config-db.test.js`) apply
every migration to real Postgres — PGlite, in-process, no Docker — and test RLS,
the publish functions and the production adapter against it. They run when
PGlite can be found and are reported `# SKIP` otherwise. Install it **outside**
this checkout (an `npm i --no-save` here would prune `playwright-core`):

```bash
npm i --prefix ../pglite @electric-sql/pglite
ARC_PGLITE_DIR=../pglite npm test
```

`npm test` runs the portal's derivations **and** the whole Lead Recovery engine
— intake, replies, the dispatcher, retries, suppression, canaries, tenancy,
versioned configuration — against `MemoryStore` and recording senders. It
touches no network, no Twilio and no model, and no database unless PGlite is
provided as above. `node --test` strips the TypeScript natively,
which is why `supabase/functions/_shared/**` carries no `jsr:` imports.

`npm run smoke` needs a browser and `playwright-core`:

```bash
npm i --no-save playwright-core && npm run build && npm run smoke
```

It walks the twelve workspace pages plus both public doors at 1440px and 390px
and fails on an uncaught error, a blank `#root`, a console error or a layout
that scrolls sideways. Without `playwright-core` it exits 0 with a notice, so
it can sit in a pipeline that does not have it.

`/ops/console` is **not** covered by the smoke test — it only renders for a
signed-in `arc_admins` user. Render it locally with a throwaway Vite harness in
`node_modules/.cache/ops-preview/` (gitignored); see the notes in
[PORTAL_CONTEXT.md](PORTAL_CONTEXT.md) §7.

### Exercising the webhooks without Twilio

Every webhook verifies its signature first, so a hand-rolled `curl` is rejected
— correctly. To drive the engine, use the tests, or the console's *test phone
routing* and *run a synthetic canary* buttons, which exercise the real code
paths with senders that record instead of sending.

---

## 9. What has not been verified against a live Twilio account

Stated plainly, because it is the difference between "implemented" and
"working":

- The signature verifier is checked against Twilio's own published example
  vector in the test suite. It has **not** been exercised against a real
  inbound webhook from a real Twilio account.
- No number has been purchased, no call forwarded, no SMS sent. Every test and
  every operator control in the console uses a recording sender.
- `AnthropicClassifier` is covered by the strict output parser's tests; it has
  not been run against the live API from this deployment.

All three need credentials that only exist outside this repository.
