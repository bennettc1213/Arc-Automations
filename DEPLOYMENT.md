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
is matched against `module_configs.config.twilio.phone_number`, and that is the
entire routing rule.

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

In `/ops/console/clients/:tenantId`, the **lead recovery** panel. Eleven steps,
eight required, in the order they are actually done:

1. **tenant created** — the client exists and has a client ID.
2. **business rules completed** — hours, services, service area, forwarding
   destination, templates. Ticks itself when a valid config saves.
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
    end with a recording sender, addressed to Twilio's reserved test number.
11. module activated — ticked by activation itself.

Then press **activate**. If it refuses it prints every reason at once; there is
no override.

To pause, press **pause**: new sequences stop and everything already queued is
cancelled. Calls keep forwarding — switching a client's module off must never
stop their phone ringing.

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
npm test          # 252 tests, node's own runner, zero dependencies
npm run build     # proves the bundle compiles
npm run smoke     # renders every public page in a real browser
```

`npm test` runs the portal's derivations **and** the whole Lead Recovery engine
— intake, replies, the dispatcher, retries, suppression, canaries, tenancy —
against `MemoryStore` and recording senders. It touches no network, no
database, no Twilio and no model. `node --test` strips the TypeScript natively,
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
