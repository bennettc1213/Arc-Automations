#!/usr/bin/env node
// Ask the roadmap assistant a question from the terminal, against the roadmap file on disk.
//
// The same code the `ops` function runs — retrieval, the prompt, the grounding check — over
// the working-tree roadmap, read fresh on every run. Save an edit to the roadmap and the next
// run answers from it; nothing else needs to change.
//
//   npm run roadmap:ask -- "When do we deploy?"          which sections would be sent
//   npm run roadmap:ask -- --live "When do we deploy?"   and the answer (needs ANTHROPIC_API_KEY)
//   npm run roadmap:ask -- --file path/to/draft.md "…"   against a draft instead
//
// Without --live nothing leaves this machine.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { retrieve } from '../supabase/functions/_shared/roadmap/markdown-index.ts'
import { answerRoadmapQuestion } from '../supabase/functions/_shared/roadmap/answer.ts'
import { roadmapModelFor } from '../supabase/functions/_shared/roadmap/model.ts'
import { indexRoadmap, ROADMAP_PATH } from '../supabase/functions/_shared/roadmap/source.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const live = args.includes('--live')
const fileAt = args.indexOf('--file')
const file = fileAt >= 0 ? path.resolve(args[fileAt + 1] ?? '') : path.join(ROOT, ROADMAP_PATH)
const skip = new Set(fileAt >= 0 ? [fileAt, fileAt + 1] : [])
const question = args.filter((a, i) => !skip.has(i) && !a.startsWith('--')).join(' ').trim()

if (!question) {
  console.error('usage: npm run roadmap:ask -- [--live] [--file roadmap.md] "your question"')
  process.exit(2)
}

const index = await indexRoadmap(readFileSync(file, 'utf8'))
console.log(`roadmap  ${path.relative(ROOT, file) || file}`)
console.log(`         revised ${index.revised ?? '(no revision date)'} · ${index.sha256.slice(0, 12)} · ${index.sections.length} sections\n`)

const r = retrieve(index, question)
console.log('sent to the model:')
for (const e of r.excerpts) console.log(`  [${e.ref}] ${e.section.anchor ? 'current ' : '        '}${e.score.toFixed(2).padStart(6)}  ${e.section.label}`)
if (r.unknownIds.length) console.log(`  not in the roadmap: ${r.unknownIds.join(', ')}`)
for (const { id, range } of r.rangedIds) console.log(`  ${id} is not named; the roadmap mentions "${range.text}"`)
if (r.nothingMatched || r.onlyUnknownIds) console.log('  (answered "not in the roadmap" without asking a model)')

if (!live) {
  console.log('\nadd --live to ask the model (reads ANTHROPIC_API_KEY from your environment).')
  process.exit(0)
}

const model = roadmapModelFor({ anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, model: process.env.ARC_ROADMAP_MODEL ?? null })
try {
  const result = await answerRoadmapQuestion({ index, question, model })
  console.log(`\n${result.status}${result.model ? ` · ${result.model}` : ''}${result.ms ? ` · ${result.ms} ms` : ''}\n`)
  console.log(result.answer)
  if (result.missing) console.log(`\nopen in the roadmap: ${result.missing}`)
  for (const c of result.citations) console.log(`Source: ${c.label}`)
  if (result.withheld) console.log(`\n(withheld: ${result.withheld})`)
} catch (error) {
  console.error(`\nno answer: ${error.message}`)
  process.exit(1)
}
