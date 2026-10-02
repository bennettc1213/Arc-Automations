#!/usr/bin/env node
// Ask the roadmap assistant a question from the terminal, against the roadmap file on disk.
//
// The same code the `ops` function runs — retrieval, the prompt, the grounding check — over
// the working-tree roadmap, read fresh on every run. Save an edit to the roadmap and the next
// run answers from it; nothing else needs to change.
//
//   npm run roadmap:ask -- "When do we deploy?"          which sections would be sent, and the
//                                                        search-only answer (no model, no key)
//   npm run roadmap:ask -- --live "When do we deploy?"   and the answer (needs a key, below)
//   npm run roadmap:ask -- --file path/to/draft.md "…"   against a draft instead
//
// Without --live nothing leaves this machine. With it, the provider is chosen exactly as the
// function chooses it, from your environment:
//   Anthropic  ANTHROPIC_API_KEY                                  (the default)
//   OpenAI     OPENAI_API_KEY, ARC_ROADMAP_PROVIDER=openai, ARC_ROADMAP_MODEL=<a model name>
//   Gemini     GEMINI_API_KEY, ARC_ROADMAP_PROVIDER=google, ARC_ROADMAP_MODEL=<a model name>
//              (Google AI Studio's free tier; some accounts and regions are asked for
//              billing anyway despite it.)
//   Groq       GROQ_API_KEY, ARC_ROADMAP_PROVIDER=groq, ARC_ROADMAP_MODEL=<a model name>
//              (console.groq.com: free tier, no payment method asked for.)
//
// With no --file, the other docs/architecture/*.md files (corpus.ts) are read from disk too, the
// same context the deployed function has — a file that does not exist on disk is skipped, same
// as a 404 in production. --file replaces the roadmap alone, with no supplementary documents, to
// keep a draft's own answer easy to read in isolation.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { retrieve } from '../supabase/functions/_shared/roadmap/markdown-index.ts'
import { answerRoadmapQuestion } from '../supabase/functions/_shared/roadmap/answer.ts'
import { roadmapModelFor, SearchOnlyRoadmapModel } from '../supabase/functions/_shared/roadmap/model.ts'
import { searchRoadmap } from '../supabase/functions/_shared/roadmap/search.ts'
import { indexRoadmap, ROADMAP_PATH } from '../supabase/functions/_shared/roadmap/source.ts'
import { combineIndexes, CORPUS_DOCS } from '../supabase/functions/_shared/roadmap/corpus.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const live = args.includes('--live')
const fileAt = args.indexOf('--file')
const file = fileAt >= 0 ? path.resolve(args[fileAt + 1] ?? '') : path.join(ROOT, ROADMAP_PATH)
const skip = new Set(fileAt >= 0 ? [fileAt, fileAt + 1] : [])
const question = args.filter((a, i) => !skip.has(i) && !a.startsWith('--')).join(' ').trim()

// No process.exit() anywhere below: on Windows, Node 24 aborts with "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)" when it is called while a network connection is still
// closing. Set the exit code and let the script end on its own instead.
await main()

async function main() {
if (!question) {
  console.error('usage: npm run roadmap:ask -- [--live] [--file roadmap.md] "your question"')
  process.exitCode = 2
  return
}

const primary = await indexRoadmap(readFileSync(file, 'utf8'))
const others = []
if (fileAt < 0) {
  for (const doc of CORPUS_DOCS) {
    const onDisk = path.join(ROOT, doc.path)
    if (!existsSync(onDisk)) continue
    try {
      others.push({ doc, index: await indexRoadmap(readFileSync(onDisk, 'utf8')) })
    } catch {
      // a supplementary doc that fails to parse contributes nothing, same as a 404 in production.
    }
  }
}
const index = others.length ? await combineIndexes(primary, others) : primary

console.log(`roadmap  ${path.relative(ROOT, file) || file}`)
console.log(`         revised ${primary.revised ?? '(no revision date)'} · ${primary.sha256.slice(0, 12)} · ${primary.sections.length} sections`)
if (others.length) console.log(`         + ${others.map((o) => o.doc.key).join(', ')}`)
console.log()

const r = retrieve(index, question)
console.log('sent to the model:')
for (const e of r.excerpts) console.log(`  [${e.ref}] ${e.section.anchor ? 'current ' : '        '}${e.score.toFixed(2).padStart(6)}  ${e.section.label}`)
if (r.unknownIds.length) console.log(`  not in the roadmap: ${r.unknownIds.join(', ')}`)
for (const { id, range } of r.rangedIds) console.log(`  ${id} is not named; the roadmap mentions "${range.text}"`)
if (r.onlyUnknownIds) console.log('  (answered "not in the roadmap" without asking a model)')
else if (r.nothingMatched) console.log('  (no keyword matched: only the current-state sections are sent)')

// What the panel shows with no model, or when the model fails. No key, no network.
const showSearch = (mode, why) => {
  const found = searchRoadmap({ index, question, mode, why })
  console.log(`\n${found.answer}`)
  for (const c of found.citations) console.log(`Source: ${c.label}`)
}

if (!live) {
  // The same path the function takes with search chosen: a question that only names identifiers
  // the roadmap never mentions is answered "not in the roadmap"; anything else is searched.
  console.log('\nsearch-only answer (no model, no key):')
  try {
    const result = await answerRoadmapQuestion({ index, question, model: new SearchOnlyRoadmapModel() })
    console.log(`\n${result.answer}`)
  } catch (error) {
    if (error.kind !== 'unconfigured') throw error
    showSearch('chosen', null)
  }
  console.log('\nadd --live to ask a model instead (keys are read from your environment).')
  return
}

const model = roadmapModelFor({
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
  googleKey: process.env.GEMINI_API_KEY ?? null,
  groqKey: process.env.GROQ_API_KEY ?? null,
  provider: process.env.ARC_ROADMAP_PROVIDER ?? null,
  model: process.env.ARC_ROADMAP_MODEL ?? null,
})
try {
  const result = await answerRoadmapQuestion({ index, question, model })
  console.log(`\n${result.status}${result.model ? ` · ${result.model}` : ''}${result.ms ? ` · ${result.ms} ms` : ''}\n`)
  console.log(result.answer)
  if (result.missing) console.log(`\nopen in the roadmap: ${result.missing}`)
  for (const c of result.citations) console.log(`Source: ${c.label}`)
  if (result.withheld) console.log(`\n(withheld: ${result.withheld})`)
} catch (error) {
  console.error(`\nno answer: ${error.message}`)
  process.exitCode = 1
  if (error.kind && error.kind !== 'refused') {
    console.log('\nthe panel shows this instead:')
    showSearch(model.provider === 'search' ? 'chosen' : error.kind === 'unconfigured' ? 'unconfigured' : 'failed', error.message)
  }
}
}
