# Draft workflows

Four n8n workflow exports for Lead Recovery, written on 2026-10-13. They are drafts: none is
registered, none can be assigned, and none sends anything. Launch still runs on ARC's own
dispatcher (`ARC_PRODUCT_SCOPE.md` §5.1).

| File | The job it is for | Scheduler action type |
| --- | --- | --- |
| `arc-lead-inquiry-v1@0.1.0.json` | A newly accepted website inquiry | `send_message` |
| `arc-lead-reply-v1@0.1.0.json` | An inbound reply and what follows it | `evaluate_reply` |
| `arc-missed-call-v1@0.1.0.json` | A confirmed missed call | `send_message` |
| `arc-lead-followup-v1@0.1.0.json` | Follow-up work that has come due | `schedule_follow_up` |

The fifth workflow in the brief, reporting a failed execution to ARC, is already built and
registered: `../workflows/arc-runner-error-handler-v1@1.0.0.json`.

## What a draft does

Each is the reviewed frame from ARC-240 around one step:

1. n8n verifies ARC's signed dispatch at the webhook and answers with the execution id.
2. The workflow asks ARC for its envelope. ARC re-checks everything before it answers.
3. The step checks the work is its own kind. Anything else is refused, and the shared error
   handler reports the execution to ARC.
4. The workflow reports back to ARC with a signed callback.

What it reports is `skipped`, with `performed: false`. A shared workflow holds no credential
and decides nothing, so its step is to ask ARC's connector gateway to perform the operation
the job authorises (ADR ARC-010 §15 step 9, §20). The bridge has no route for that request
yet. A draft never reports work as done.

## What has to exist before one can run for a client

In this order. Each is its own decision or piece of work, and none was done here.

1. **The licensing decision, recorded.** ADR ARC-010 §26: written confirmation from n8n for
   ARC's backend use, the plan on record, and the exchange archived. Until then the bridge
   refuses production. This is Bennett's to record, and reporting an authorisation in a prompt
   is not the record.
2. **A Lead Recovery version that permits n8n.** Version 1 is registered `direct` with n8n
   `prohibited`, and an action workflow may only serve a version that permits it
   (`tests/n8n-workflows.test.js`). A new version is a registry change and a new activation.
3. **The connector gateway route.** A route on `runner-bridge` that takes a workflow's signed
   request for one operation, re-reads live state, performs it through the engine's own send
   gate and answers with safe data only. The step in each draft becomes that request.
4. **Registration.** Move the export to `../workflows/`, add its manifest entry, then register,
   approve, deploy per environment and assign it (ARC-230).
5. **A real n8n.** Import, set the bridge URL in the one environment node, attach the two
   ARC JWT credentials, and run the conformance check. Nothing here has been imported into
   an n8n instance.

## Editing

The files are built by `scripts/n8n-drafts.mjs` from the reference frame in
`tests/fixtures/n8n/`, so the frame cannot drift from the one the frame check holds.

```
node scripts/n8n-drafts.mjs            # check
node scripts/n8n-drafts.mjs --write    # rebuild after changing the script
```

`tests/n8n-drafts.test.js` runs each draft in the local simulator against ARC's real
verifiers: the signed dispatch, the envelope, a refusal for work of another kind, and the
callback. That proves the contract. It does not prove a real n8n imports or runs them.
