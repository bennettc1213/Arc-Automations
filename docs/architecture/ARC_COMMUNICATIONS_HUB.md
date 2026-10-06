# ARC Communications Hub: Conversations, Messages, Delivery Evidence

Status: built and tested (`ARC-370`). Migration `0026_crm_communications.sql`. **No client can
send from it in production yet**, by design — see "What is live and what is not".

## What it is

The conversation with a customer, inside the CRM record: what was said, by whom, on which
channel, and what ARC knows about whether it arrived. One component (`CrmConversation.jsx`)
is drawn in a lead, in a customer, and under the workspace's own `conversations` tab, through
the same two doors as the rest of the workspace (`crm` for a client's team, `ops` for an
operator) and the same action table (`_shared/crm/actions.ts`).

## What it is not

- **Not evidence.** Nothing here writes `events`, and no figure reads these tables. A text a
  person sends from here is not a Lead Recovery outcome.
- **Not a second queue.** A message is one `send_message` action on ARC-200's queue.
- **Not a second message store for Lead Recovery.** Its `conversations` and `messages` (0010)
  stay the engine's. The timeline reads them by reference and never copies one.
- **Not Lead Recovery policy.** Qualification, sequences and reply handling are the later
  `ARC-LR-*` steps.
- **Not consent.** `consent_basis` records what was on file when a person sent. Whether an
  address may be contacted is still `suppressions`, read at the send.

## The model (0026)

| Table | Holds |
| --- | --- |
| `crm_conversations` | One thread per client, channel and address. Who has it, and the team's read mark. |
| `crm_messages` | One row per message, either direction. Its words never change; only where it has got to. |
| `crm_conversation_events` | Append-only: queued, sending, sent, delivered, read, failed, blocked, unknown, cancelled, reconciled, do-not-contact, assigned. Carries the provider's own id for a request or a report. |
| `crm_snippets` | A client's canned replies. |

**A thread belongs to an address, not to a contact row** — like `suppressions` and 0024's consent
records. Which customer it belongs to is read from the contacts that hold that address:

- exactly one: the thread is that customer's, and an arriving message is tied to them and to
  their one open lead;
- two or more: the thread is shown on each, says so, and an arriving message is tied to none.
  Nothing is guessed;
- none: the thread is listed as "nobody on file". Adding a lead with that address puts the
  conversation on that customer.

So merging two contacts moves nothing, and changing a phone number does not rewrite who was texted.

Internal notes are still `crm_notes` (0023). A note is a different table with no path to a
send: 0026 never reads it, and the conversation component has no way to write one.

## Sending

A message a person writes is queued by `crm_queue_message`, in **one transaction**: the message
row, a `crm_message` run and a `send_message` action — or none of them.

```
person presses send
  → resolveSendRoute        a verified connection for the channel's capability (ARC-130),
                            an adapter that can send through it, and an ACTIVE module whose
                            registry contract requires that capability (ARC-120)
  → crm_queue_message       gate · message · run (0013 pins it, 0015 refuses it unless the
                            module is active on its authorised versions) · action (0017)
  → the pass                ARC-210's orchestrator: claim → start (0017's gate re-read) →
     MessageSendRunner      crm_message_begin_send (the message's own gate, re-read under lock)
                            → channel gateway (ARC-130's withProviderCredential → adapter)
                            → crm_message_finish_send
  → settle                  0017 records the attempt; a run with nothing left is finished
```

The action's payload is `{ message_id }` and nothing else. The words and the address are on the
message row and are read again at the send.

### Which module

A run must belong to a module and be pinned to its authorised configuration (0013, 0015). The
service does not name one. It asks the registry for the selectable modules whose contract
**requires** the channel's send capability — the ones an operator cleared to reach a customer
that way when they activated them — and uses the one that is active for this client. Today that
resolves to Lead Recovery.

The consequence is deliberate: pausing that module holds a person's queued messages too (held,
visible, released by the resume — 0017's `hold` policy), and a change that needs a retest stops
new sends until it is retested. A module of its own for communications is a registry decision
for a later step; nothing here would need to change except what the registry answers.

### The gate, read twice

`crm_message_gate` answers the first reason an address may not be written to, from current
state. It is read when a message is queued and again, under the message's lock, immediately
before it is sent.

| Code | Means | Lifted by |
| --- | --- | --- |
| `do_not_contact` | The address is on `suppressions`. | Nothing in this workspace. |
| `consent_declined` | The latest consent evidence (0024) says no. | The customer writing to the business. |
| `automation_active` | Lead Recovery is still talking to this number. | A person taking the lead over, in Lead Recovery. |
| `safety_review` | Lead Recovery flagged the lead and the sender has not confirmed reading every flag. | Ticking each flag. A flag raised after queueing was not read, and blocks the send. |

`contact_unavailable`, `no_address`, `no_channel` and `module_not_ready` are refused before
anything is written. The thread view carries the answer (`compose.block`), so the reason is on
the page before anybody types.

### What a send can end as

| The channel says | Message | Action (0017) | Resent? |
| --- | --- | --- | --- |
| Took it, here is its id | `sent` | `done` | — |
| Refused it; nothing left | `failed` | `failed` | No |
| Try later; nothing left | back to `queued` | `pending`, after the type's backoff | Yes, same key |
| No clear answer | `unknown` | `blocked` / `ambiguous_outcome` | **Never**, until an operator reconciles it |
| The runner broke, or the worker vanished mid-send | `sending` | `blocked` / `ambiguous_outcome` | **Never**; the screen shows `unknown` |

`deliveryState` (portal-safe, in `communications/model.ts`) combines the message row with its
action so the screen shows one truth: where the queue knows more than the message, the queue wins.

An operator settles an unknown outcome after checking with the provider (`crm-message-reconcile`):
"it was sent" closes it, "it never left" puts it back for one more attempt. A client is not
offered either.

## Arriving

`ingestInboundMessage` is the inbound contract, and `crm_message_arrival` is where it lands. It
takes a provider's message (a `system` actor) or one the client's own system reports through
its connector (an `external` actor, either direction); a signed-in person cannot post one.

- **Once.** `(tenant, connector, external id)` is unique. A redelivery answers `duplicate`.
- **STOP is immediate.** The body is read by ARC's deterministic rules (`engine/rules.ts`), the
  same ones Lead Recovery uses and never a model. An opt-out or a wrong-number reply writes the
  suppression in the transaction that records the message, and blocks anything still queued on
  the thread.
- **Never refused for what a customer typed.** A credential-shaped body is kept with the body
  withheld.
- **Attachments are references** to the provider's own copy (`provider_media`, an id, a media
  type). A link or a file is refused: ARC has no approved store for one yet.

`recordDelivery` takes what a provider says happened to something that was sent. Every report is
kept; a message only moves forward (a late "delivered" does not undo a "read"). A carrier
opt-out adds to the do-not-contact list.

## The do-not-contact list

`suppressions` (0010) is still the only truth. 0026 writes to it from exactly one function
(`crm_apply_suppression`), for three callers: an inbound STOP, a carrier's report, and a person
at the screen (`crm-do-not-contact`, any member of the team — honouring an opt-out never waits
for the account owner). It only ever adds. A temporary block becomes permanent, and nothing in
this workspace takes an address off the list.

## Who may do what

| | Read | Send, cancel, mark read, opt out | Take a thread | Hand a thread over | Canned replies | Reconcile |
| --- | --- | --- | --- | --- | --- | --- |
| Operator | yes | yes | yes | yes | yes | yes |
| Client owner | own client | yes | yes | yes | yes | no |
| Client staff | own client | yes | yes | no | no | no |

ARC-340's `can`, checked again in SQL. RLS on all four tables: a member reads their own
client's rows, an operator reads everything, no browser role writes anything.

## What is live and what is not

- **Live in code:** the model, the gate, the queue path, the runner, the inbound contract, the
  delivery contract, the screen, and Lead Recovery's own texts shown in the timeline.
- **Not live:** sending, for any real client. `PRODUCTION_CHANNEL_ADAPTERS` is empty. Twilio is
  ARC's own platform account, so no client has a messaging connection of their own, and every
  other messaging provider is still `planned`. The screen says there is no channel to send
  through. It does not queue something that cannot leave.
- **Not built here:** a send through ARC's Twilio (a Lead Recovery provider action, `ARC-LR-420`);
  a provider's inbound door (a connector calls `ingestInboundMessage` when one exists); an
  always-on scheduler worker — a queued message is sent by the pass that follows a send, or by
  "send what is waiting" (`ARC-OPS-520`); lifting an opt-out; outbound attachments; sending email.

Tests prove the whole path with the synthetic provider on its `.invalid` host
(`synthetic-channel.ts`), which refuses production.

## Code

- `supabase/migrations/0026_crm_communications.sql`
- `supabase/functions/_shared/communications/model.ts`: vocabulary, parsing, `deliveryState`, `threadEntries` (portal-safe)
- `…/service.ts`: every read and write; `resolveSendRoute`
- `…/runner.ts`: `MessageSendRunner`
- `…/channels.ts`: the adapter contract and the gateway; `synthetic-channel.ts` for tests
- `…/supabase-communications-store.ts`, `…/wiring.ts`
- `supabase/functions/_shared/crm/actions.ts`: the action table both doors run
- `src/portal/components/CrmConversation.jsx`; `CrmRecord.jsx`, `CrmWorkspace.jsx`; `src/portal/lib/crm.js`; `src/portal/demo/crm-demo.js`

## Tests

- `tests/communications.test.js`: the model, the runner against the ARC-210 contract, the
  gateway over ARC-130's credential path, and the rendered screen. No database.
- `tests/communications-db.test.js`: 0026 applied to real Postgres (PGlite), with the real
  scheduler and orchestrator. Covers each of the roadmap card's required tests.
