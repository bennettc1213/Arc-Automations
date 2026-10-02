# ARC Roadmap Assistant

A small chat panel in the ops console that answers questions about the ARC implementation
roadmap and the architecture docs around it. It answers from those files, and says so when
they have no answer. It can't change anything. With no AI model it still works: it shows the
matching documents' own passages for the question ([search-only
mode](#search-only-mode-no-model-no-key)).

## The canonical roadmap

**`docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md`**

This is the assistant's primary document — the one its current-position sections come from,
the one whose failure is the assistant's failure, and the one no roadmap fact is ever written
into code for: a test (`tests/roadmap-assistant.test.js`, "no prompt identifier appears
anywhere in its code") fails if an `ARC-nnn` identifier appears anywhere in the assistant's
source.

The file was installed from `ARC_N8N_IMPLEMENTATION_HANDOFF_2026-09-23_UPDATED.md` without
changes (sha256 `18baed92…`). That was the newest revision found. The `…_UPDATED(2).md`
successor wasn't available when the assistant was built, so any detail that exists only in it,
such as a per-prompt breakdown of `ARC-LR-400` through `ARC-LR-450`, isn't known yet. To fix
that, replace the file with the new revision.

## The rest of what it knows

Alongside the roadmap, every question is also searched against the other architecture docs
(`supabase/functions/_shared/roadmap/corpus.ts`, `CORPUS_DOCS`) — so "how are provider
credentials kept secret" or "what does the scheduler retry" gets a real, cited answer, not
just "not in the roadmap". Each is read from `main` the same way as the roadmap, and each is
**best-effort**: a document that 404s (renamed, not pushed yet), fails to parse, or times out
simply contributes nothing to that question. Only the roadmap's own failure is shown as an
error — a missing supplementary document never is. Today's list:

- `ARC_ROADMAP_ASSISTANT.md` — this document
- `ARC_LEAD_RECOVERY_SAFETY_AND_PINNING.md`
- `ARC_MODULE_AND_CONNECTOR_REGISTRIES.md`
- `ARC_TENANT_MODULE_LIFECYCLE.md`
- `ARC_VERSIONED_TENANT_CONFIGURATION_ENGINE.md`
- `ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md`
- `ARC_N8N_EXECUTION_BOUNDARY_ADR.md`
- `ARC_N8N_REPOSITORY_AUDIT.md`

To add another, add its path to `CORPUS_DOCS` — nothing else changes. A citation from one of
these reads "Document Title › Section", so "ARC-130 — Secure Provider Connections and OAuth ›
§7 Refresh, rotation, revocation" is unmistakably not the roadmap. Their sections are searched
exactly like the roadmap's own, are never a current-position anchor (that question is the
roadmap's to answer), and go through the same grounding check before anyone reads them. The
panel's source line says how many loaded: "· +6 docs".

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
| `markdown-index.ts` | Cuts a file at its headings. Each section is cited by its own heading ("§4 Revised canonical implementation sequence"), and a section over 4,500 characters is split into its subsections ("§7 … › Lead supply"). Scores sections against the question by keyword relevance (BM25, light stemming), with `ARC-…` identifiers weighted as exact keys, spans ("ARC-OPT-460 through ARC-OPT-480") expanded, and identifiers the roadmap never names reported back. |
| `corpus.ts` | Which other documents to fold in (`CORPUS_DOCS`), and `combineIndexes`: tags a supplementary document's sections with its title, keeps the roadmap's own sections exactly as `markdown-index.ts` made them, and recomputes relevance over the combined set. |
| `answer.ts` | Sends the model the **current-state sections** (the roadmap's first section plus any heading naming the execution position, the next task or the implementation sequence) and up to five of the best-scoring sections from the whole corpus, never a whole file. Checks the reply before anyone sees it. |
| `model.ts` | Calls Anthropic, OpenAI or Google over plain `fetch` (the pattern `_shared/classifier.ts` uses) with structured JSON output, whichever `ARC_ROADMAP_PROVIDER` and key select. |
| `search.ts` | The answer when no model can give one: the matching documents' own passages for the question, no model and no key. See below. |
| `source.ts` | Reads, caches and fingerprints the roadmap (`createRoadmapSource`) and the whole corpus (`createRoadmapCorpus`). |

The check in `answer.ts` is deterministic. An answer is **withheld**, and the operator is told
it couldn't be verified, if any of these is true:

- it cites no section it was given;
- it names a prompt identifier that isn't in those sections, unless it's saying the roadmap
  lacks it;
- it states a date that isn't in those sections.

This catches invented identifiers and dates, including ones planted by prompt injection. It's
a safety net under the prompt, not a proof of every sentence.

Only one kind of question skips the model: one that asks solely about a prompt identifier the
roadmap never mentions. It gets "I can't find that in the current roadmap." Everything else is
asked, even when no word of it appears in the roadmap. (With no model to ask, everything else is
searched instead: see below.) "Give me an overview" and "what should
I do today?" share no keyword with the file, yet the always-sent current-state sections
answer them. Deciding "not in the roadmap" from keywords alone rejected exactly those, so the
model makes that call and the check above is the safety net.

## Search-only mode (no model, no key)

A language model is what turns passages into a written answer, and it has to run somewhere,
which means a key and a bill. Without one the assistant still answers, in a plainer way: it
shows the passages of the roadmap that mention the question, each under its section's title,
with the sections cited. It never writes a sentence. It can't summarize, connect two sections
or reason about them, and the first line it prints says so. A test checks that every word it
shows is a word of the roadmap.

It is used in three cases, and always says which:

| Case | The first line says |
| --- | --- |
| No key is set on the `ops` function. | **No AI model is connected**, and why (for example `OPENAI_API_KEY is not set`). |
| `ARC_ROADMAP_PROVIDER=search` is set, on purpose. No model is called whatever keys exist, so it costs nothing. | **Search mode**. Nothing is reported as a fault. |
| A configured model fails: no credit (`429: insufficient_quota`), an outage or a timeout. | **The AI model couldn't answer**, followed by the provider's own reason. |

What it shows:

- The sections that match the question, best first (up to three, then any others named). Of
  each section it shows the paragraphs, list items or table rows that mention the question, not
  merely its opening. A long list or table is cut around the line asked about, so item 12 of a
  list is not reached by showing items 1 to 11, and it keeps the roadmap's own numbers.
- A question that names no prompt also gets the current-position sections, since "where are we?"
  is what such a question usually asks. A question that matches nothing says "No section of the
  roadmap matches those words." and shows them "in case it helps".
- The status is `excerpts`. It is not an answer and not "not in the roadmap"; it makes no claim
  about either.

Two things behave as before. A question that names only a prompt ID the roadmap lacks is answered
"I can't find that in the current roadmap" with no search. A model that declines a question is
reported as declining; it isn't answered with the roadmap's text.

Retrieval is by keyword, not meaning, so a question phrased in words the roadmap doesn't use finds
nothing, and "where are we on the build" finds sections that mention "build" before it finds the
position. The current-position sections are shown alongside for that reason. A model does better at
this; search-only mode is what you have without one.

To try it with no key: `npm run roadmap:ask -- "When do we deploy?"`.

## Configuration

Set on the `ops` function (`supabase secrets set …`). Values are never returned to the browser.

| Secret | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | no | The key Lead Recovery already uses. Without any key, the panel runs in search-only mode (above). |
| `OPENAI_API_KEY` | no | An OpenAI (ChatGPT API) key, used instead. See below. |
| `GEMINI_API_KEY` | no | A Google AI Studio (Gemini) key. Advertised as free-tier, though some accounts and regions are asked to add billing anyway. See below. |
| `GROQ_API_KEY` | no | A Groq key. Free tier, no payment method asked for at signup — the one of the three that has actually worked with no card. See below. |
| `ARC_ROADMAP_PROVIDER` | no | `anthropic`, `openai`, `google`, `groq` or `search`. Unset means whichever key exists, checked in that order (Anthropic first), and search-only if none do. `search` forces search-only mode and calls no model whatever keys exist. |
| `ARC_ROADMAP_MODEL` | Anthropic: no. Every other provider: **yes** | Model id. Anthropic defaults to `claude-opus-5`. The others have no default, because model names change often enough that one written here would be a guess. |
| `ARC_ROADMAP_SOURCE_URL` | no | Where to read the roadmap. Default: the file on `main`, as above. |
| `ARC_ROADMAP_CACHE_SECONDS` | no | How long an instance reuses a file before revalidating. Default `60`; `0` in local development. |

### Using Groq (free tier, no card) instead

The option that actually asks nothing up front, and the one verified working end to end
(2026-09-28): a real written answer, correctly cited, from a free key with no payment method.
Groq hosts open models at high speed; its free tier has its own rate limit rather than a bill.

1. At [console.groq.com](https://console.groq.com), sign up (email or Google account) — no
   payment method in the flow.
2. Under **API Keys**, click **Create API Key**.
3. Pick a current chat model from [console.groq.com/docs/structured-outputs](https://console.groq.com/docs/structured-outputs)
   — **not every model Groq hosts supports structured output**, and a couple of the larger,
   better-known ones (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) are Enterprise-tier
   only and come back `404: model_not_found` on a free account even though they're listed as
   current. `openai/gpt-oss-20b` is confirmed working on the free tier and is a reasonable
   first choice; `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` are the other two Groq lists as
   supporting strict mode as of that date, but check the page, since this list grows.
4. Set all three at once:

```
supabase secrets set GROQ_API_KEY=gsk_... ARC_ROADMAP_PROVIDER=groq ARC_ROADMAP_MODEL=openai/gpt-oss-20b --project-ref <ref>
```

### Using OpenAI (the ChatGPT API) instead

1. At platform.openai.com, add a payment method and buy prepaid credits under Billing. **A
   ChatGPT Plus or Pro subscription does not include API use.**
2. Create a key under API keys.
3. Pick a chat model that supports structured outputs from platform.openai.com/docs/models.
4. Set all three at once:

```
supabase secrets set OPENAI_API_KEY=sk-... ARC_ROADMAP_PROVIDER=openai ARC_ROADMAP_MODEL=gpt-4o-mini --project-ref <ref>
```

### Using Google Gemini instead

Advertised with a free tier for current models, and it is one for some accounts — but not a
reliable no-card option: Google has asked at least one account here to add billing before
issuing a key, despite the free-tier claim. Try Groq first if a card is what you're avoiding.

1. At [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with a Google
   account and click **Create API key**. If it asks for a payment method, that account doesn't
   qualify for the no-card tier — use Groq instead, or add the card if you're fine with it.
2. Pick a current chat model from [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
   — a "flash" model is the fast, free-tier-friendly tier; `gemini-2.5-flash` is a reasonable
   one to try first, but check the list, since names change.
3. Set all three at once:

```
supabase secrets set GEMINI_API_KEY=AIza... ARC_ROADMAP_PROVIDER=google ARC_ROADMAP_MODEL=gemini-2.5-flash --project-ref <ref>
```

Angle brackets in examples like `<ref>` mark where your own value goes. Don't type them. A model
name or key pasted with `< >` or quotes still around it is cleaned automatically, and one with
spaces or other junk in it is refused with a message naming the setting.

The same safeguards apply to all four providers: the same prompt, the same reply schema, and
the same check that withholds an answer citing nothing, or naming an ID or date the excerpts
lack. OpenAI and Groq share one adapter (`chatCompletionsComplete`) over the same Chat
Completions shape, since Groq's API is deliberately OpenAI-compatible; Gemini uses its own
provider's structured-output mode (`responseSchema`, translated once in `model.ts` from the
one reply schema every provider shares). Lead Recovery's classifier is unaffected and still
reads `ANTHROPIC_API_KEY` alone.

To deploy the new actions, run `supabase functions deploy ops` once. Until then the panel says
the ops function predates the assistant. After that, roadmap edits need no redeploy.

**Cost.** Each question sends the current-state sections plus the best matches across the whole
corpus (roughly 8,000–12,000 input tokens, more with several supplementary documents matching)
and returns a short answer. On Anthropic's default model that's an estimated 5 to 10 cents a
question; `ARC_ROADMAP_MODEL=claude-sonnet-5` should cost less than half as much. On Gemini's
free tier it's $0, up to the tier's own rate limit. A secret change applies on the next
request, without a redeploy.

**A deploy bundles the working tree, not `main`.** `supabase functions deploy ops` sends
whatever is on disk, including any other session's uncommitted files that `ops` imports.
Check `git status` first, and don't deploy while another feature's migration is unapplied.

## When a question fails

A failed model doesn't leave the panel empty: it shows the roadmap's own passages
([search-only mode](#search-only-mode-no-model-no-key)), and the first line names the reason in
the provider's own words, after "The AI model couldn't answer". The key is always removed from it.
The rows below are those reasons. A model that declines a question, or a request that can't reach
the function at all, is the only case that shows an error box instead.

| The reason says | Meaning | Fix |
| --- | --- | --- |
| `ANTHROPIC_API_KEY is not set` (or `OPENAI_API_KEY` / `GEMINI_API_KEY`), after "No AI model is connected" | No secret on the project for the chosen provider. | Set it (above), or leave it: search-only mode is a working setup. |
| `ARC_ROADMAP_MODEL is not set`, after "No AI model is connected" | OpenAI or Google is chosen, and it needs a model name. | Set `ARC_ROADMAP_MODEL`. |
| `the model answered 429: insufficient_quota` | OpenAI: no credit on the API account. A ChatGPT subscription doesn't cover the API. | Buy credits at platform.openai.com → Billing. |
| `the model answered 429: RESOURCE_EXHAUSTED` | Gemini: the free tier's rate limit for the moment. This is the free tier working as intended, not a broken key. | Wait a minute and retry, or set `ARC_ROADMAP_MODEL` to a model with a higher free-tier limit. |
| `the model answered 404: … model_not_found` (OpenAI, Groq) / `the model answered 404: NOT_FOUND` (Gemini) | That model name doesn't exist, was retired, or isn't open to this account. On Groq specifically, this also means an Enterprise-tier model on a free account (`llama-3.3-70b-versatile` is one) — the model is real, just not available on this key. | Set `ARC_ROADMAP_MODEL` to one listed on the provider's models page; for Groq, one from the structured-outputs page (above) that's confirmed free-tier. |
| `…does not look like a key` | The secret has spaces, quotes or a stray line break. Surrounding quotes and whitespace are stripped automatically, so this means something else is in it. | Set it again with just the key. |
| `the model answered 401: authentication_error` (Anthropic/OpenAI) / `the model answered 400: INVALID_ARGUMENT` mentioning the key (Gemini) | The key is wrong or revoked. | Create a new key and set it. |
| `the model answered 400: invalid_request_error — …credit balance…` | The API account has no prepaid credit. **A Claude.ai Pro or Max subscription is a different product and doesn't fund API keys**; the API is billed separately. The key may also belong to an organization other than the one you added credit to. | At console.anthropic.com → Settings → Billing, buy credits, and check the organization shown at the top left is the one the key was created in. |
| `the model answered 404: not_found_error` | The model id isn't available to this account. | Set `ARC_ROADMAP_MODEL` to one that is. |
| `the model answered 429` / `529` | Rate limited or overloaded. | Retry in a minute. |
| `the request to the model failed (TypeError: …)` | The request never left, or the reply wasn't JSON. The text after it says which. | Read that text. |

**To see the real error without deploying anything**, run the same code from your own terminal.
It uses your key from the environment, and nothing leaves your machine except the request to
the provider:

```
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run roadmap:ask -- --live "Where are we on the build"
```

For OpenAI, set `$env:OPENAI_API_KEY`, `$env:ARC_ROADMAP_PROVIDER = "openai"` and
`$env:ARC_ROADMAP_MODEL` instead. For Gemini, `$env:GEMINI_API_KEY`,
`$env:ARC_ROADMAP_PROVIDER = "google"` and `$env:ARC_ROADMAP_MODEL`.

It prints the answer, or `no answer:` and the reason, and then what the panel shows instead.

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

To see which sections a question retrieves, run this. It reads the working-tree roadmap and,
when `--file` is not given, every supplementary document that exists on disk, fresh on every
run — so a saved edit to any of them changes the next run, and nothing leaves the machine:

```
npm run roadmap:ask -- "When do we deploy?"
```

To get the whole answer, add `--live`. This uses your own `ANTHROPIC_API_KEY` (or
`OPENAI_API_KEY` / `GEMINI_API_KEY` with `ARC_ROADMAP_PROVIDER` set, as above):

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
- **Corpus tests** check that the roadmap's own sections come through `combineIndexes`
  untouched, a supplementary document's sections are namespaced and labelled with its title and
  never an anchor, a question only a supplementary document answers is found once combined, and
  a document that fails to load contributes nothing rather than failing the question.
- **The UI tests** render the real component to markup, check the keyboard and ARIA contract,
  and use the site's import graph (`scripts/site-impact.mjs`) to prove that the roadmap, the
  supplementary documents, the retrieval code and every provider's key never reach the browser
  bundle.

## Things to know

- **This repository is public.** None of these documents are in the site bundle or returned by
  the API, but each file can be read on GitHub, like the other documents in this folder.
- Retrieval uses keywords, not semantic search. A question phrased entirely in words none of
  the documents use relies on the roadmap's current-state sections, which are always sent.
- Answers quote the roadmap, and the roadmap is a plan. "Reported complete locally" in the file
  means that, and the assistant is told not to turn it into "deployed".
- A supplementary document is best-effort by design, not a bug when one is momentarily missing:
  a doc renamed, deleted or not yet pushed simply stops or starts contributing, and the roadmap
  itself still answers regardless.
