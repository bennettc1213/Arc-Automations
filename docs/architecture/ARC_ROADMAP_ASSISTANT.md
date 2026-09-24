# ARC Roadmap Assistant

A small chat panel in the ops console that answers questions about the current ARC
implementation roadmap. It answers from one file, and says so when that file has no answer.
It can't change anything.

## The canonical roadmap

**`docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md`**

This is the assistant's only knowledge base. No roadmap facts are written into code: a test
(`tests/roadmap-assistant.test.js`, "no prompt identifier appears anywhere in its code") fails
if an `ARC-nnn` identifier appears anywhere in the assistant's source.

The file was installed from `ARC_N8N_IMPLEMENTATION_HANDOFF_2026-09-23_UPDATED.md` without
changes (sha256 `18baed92…`). That was the newest revision found. The `…_UPDATED(2).md`
successor wasn't available when the assistant was built, so any detail that exists only in it,
such as a per-prompt breakdown of `ARC-LR-400` through `ARC-LR-450`, isn't known yet. To fix
that, replace the file with the new revision.

## Updating the roadmap

1. Replace the contents of `docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md` with the new
   revision. Keep the path; a new filename is a new file the assistant never reads.
2. Push `main`. Pushing `main` is the deploy here, and the autoship hook does it at the end of a
   Claude session.

There's no second step. The `ops` function reads the file from `main` when a question arrives,
at `raw.githubusercontent.com/bennettc1213/Arc-Automations/main/…`. It keeps a copy for up to
60 seconds per function instance, and GitHub's CDN can serve the previous version for a few
minutes after a push. There's no upload, no vector store and no generated index to keep in
step. The digest shown in the panel ("Roadmap source updated: September 23, 2026 ·
18baed92e367") is computed from the bytes that were read, so it always names the version
that answered.

The revision date comes from the file's header line (`**Roadmap revision date:** …`). A
roadmap without one still works; the panel shows only the digest.

## Who can use it

Only ARC operators, meaning users in `public.arc_admins`.

- The panel is mounted only in `/ops/console`, which renders only for an `arc_admins` session.
- That's convenience, not security. The `ops` edge function checks every request against
  `is_arc_admin()` with the caller's own JWT (`supabase/functions/_shared/operator-gate.ts`).
  With no session it returns `401`, and for a non-operator it returns `403`, before the
  roadmap is read or a model is called.

## What it can't do

It answers questions. It has no way to edit the roadmap, create or publish configuration,
activate, pause or roll back modules, trigger n8n, deploy, research the web, or read client
data. Its two actions, `roadmap-status` and `roadmap-ask`, read the roadmap and the operator's
question, and nothing else. They run before the function creates its service-role database
client.

## How an answer is made

`supabase/functions/_shared/roadmap/`:

| File | Job |
| --- | --- |
| `markdown-index.ts` | Cuts the file at its headings. Each section is cited by its own heading ("§4 Revised canonical implementation sequence"), and a section over 4,500 characters is split into its subsections ("§7 … › Lead supply"). Scores sections against the question by keyword relevance (BM25, light stemming), with `ARC-…` identifiers weighted as exact keys, spans ("ARC-OPT-460 through ARC-OPT-480") expanded, and identifiers the roadmap never names reported back. |
| `answer.ts` | Sends the model the **current-state sections** (the file's first section plus any heading naming the execution position, the next task or the implementation sequence) and up to five of the best-scoring sections, never the whole file. Checks the reply before anyone sees it. |
| `model.ts` | Calls Anthropic over plain `fetch` (the pattern `_shared/classifier.ts` uses) with structured JSON output. |
| `source.ts` | Reads, caches and fingerprints the file. |

The check in `answer.ts` is deterministic. An answer is **withheld**, and the operator is told
it couldn't be verified, if any of these is true:

- it cites no section it was given;
- it names a prompt identifier that isn't in those sections, unless it's saying the roadmap
  lacks it;
- it states a date that isn't in those sections.

This catches invented identifiers and dates, including ones planted by prompt injection. It's
a safety net under the prompt, not a proof of every sentence.

Two kinds of question never reach a model: one whose words appear nowhere in the roadmap, and
one that only names identifiers the roadmap never mentions. Both get "I can't find that in the
current roadmap."

## Configuration

Set on the `ops` function (`supabase secrets set …`). Values are never returned to the browser.

| Secret | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | The key Lead Recovery already uses. Without it, the panel says the assistant is unconfigured, and nothing is guessed. |
| `ARC_ROADMAP_MODEL` | no | Model id. Default `claude-opus-5`. |
| `ARC_ROADMAP_SOURCE_URL` | no | Where to read the roadmap. Default: the file on `main`, as above. |
| `ARC_ROADMAP_CACHE_SECONDS` | no | How long an instance reuses the file before revalidating. Default `60`; `0` in local development. |

To deploy the new actions, run `supabase functions deploy ops` once. Until then the panel says
the ops function predates the assistant. After that, roadmap edits need no redeploy.

## Limits and logging

- **Rate limit:** 8 questions a minute and 60 an hour per operator, per function instance. It
  follows the same in-process convention as `lead-intake`: it stops a runaway loop, not a
  determined caller, and only operators can reach it.
- **Nothing is stored.** The conversation lives in the browser tab and is lost on reload. Each
  question is answered from the roadmap again, so a fresh page still gets current answers. Up
  to six recent turns go with a question so that a follow-up like "and after that?" makes sense.
- **Logs** hold one metadata line per question in the function logs: the operator id, the
  roadmap digest, the section ids used, the outcome and the timing. They never hold the
  question or the answer. Asking is read-only, so it isn't written to `admin_actions`.

## Local development

To see which sections a question retrieves, run this. It reads the working-tree file fresh on
every run, so a saved roadmap edit changes the next run, and nothing leaves the machine:

```
npm run roadmap:ask -- "When do we deploy?"
```

To get the whole answer, add `--live`. This uses your own `ANTHROPIC_API_KEY`:

```
npm run roadmap:ask -- --live "When do we deploy?"
```

To run the function locally against your working tree, start `npm run dev`, then serve `ops`
with the roadmap pointed at the Vite dev server. The dev server serves the file as saved;
production builds don't include it.

```
ARC_ROADMAP_SOURCE_URL=http://host.docker.internal:5199/docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md
ARC_ROADMAP_CACHE_SECONDS=0
```

## Tests

```
node --test tests/roadmap-assistant.test.js tests/roadmap-ui.test.js
```

Both run as part of `npm test`. No test calls a model or the network.

- **Golden questions** use a frozen copy of the 2026-09-23 revision
  (`tests/fixtures/roadmap-golden.md`), so editing the canonical roadmap never breaks them.
- **Tests on the canonical file** check only properties that hold whatever it says: it parses,
  it has a current position, and every identifier in it can be retrieved.
- **The UI tests** render the real component to markup, check the keyboard and ARIA contract,
  and use the site's import graph (`scripts/site-impact.mjs`) to prove that the roadmap, the
  retrieval code and the model key never reach the browser bundle.

## Things to know

- **This repository is public.** The roadmap isn't in the site bundle and isn't returned by the
  API, but the file itself can be read on GitHub, like the other documents in this folder.
- Retrieval uses keywords, not semantic search. A question phrased entirely in words the
  roadmap doesn't use relies on the current-state sections, which are always sent.
- Answers quote the roadmap, and the roadmap is a plan. "Reported complete locally" in the file
  means that, and the assistant is told not to turn it into "deployed".
