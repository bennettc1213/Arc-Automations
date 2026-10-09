#!/usr/bin/env node
// The gate for ARC-GO-330: the whole test suite, on real SQL, with nothing skipped.
//
//   ARC_PGLITE_DIR=<a directory holding @electric-sql/pglite> npm run gate
//
// `npm test` is green without Postgres: every database suite reports itself as skipped and
// the run still passes. That is right for a quick check and wrong for a gate — a suite that
// only runs on real SQL is exactly where a stale assertion or a rule the in-memory store
// does not know about hides (ARC-GO-320 found one of each). So this refuses to pass unless
// PGlite is there, every test ran, and none failed.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { loadPglite, SKIP_REASON } = await import(pathToFileURL(path.join(ROOT, 'tests', 'pglite-harness.js')).href)
if (!(await loadPglite())) {
  console.error(`gate: NOT RUN. ${SKIP_REASON}`)
  process.exit(2)
}

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/**/*.test.js'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ARC_GATE: 'sql' },
  maxBuffer: 256 * 1024 * 1024,
})

const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
const figure = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? NaN)
const [tests, pass, fail, cancelled, skipped, todo] = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(figure)

if ([tests, pass, fail, skipped].some(Number.isNaN)) {
  console.error(output.trim().split('\n').slice(-30).join('\n'))
  console.error('gate: NOT PASSED. the test run did not report a summary.')
  process.exit(1)
}

/* a skipped suite prints as one `# SKIP` line with its reason; name them. */
const skips = [...output.matchAll(/^\s*ok \d+ - (.*?) # SKIP ?(.*)$/gm)].map((match) => `  ${match[1]}${match[2] ? ` — ${match[2]}` : ''}`)
const failures = [...output.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((match) => `  ${match[1]}`)

console.log(`gate: ${tests} tests · ${pass} passed · ${fail} failed · ${skipped} skipped · ${cancelled || 0} cancelled · ${todo || 0} todo`)
if (failures.length) console.log(`failed:\n${[...new Set(failures)].join('\n')}`)
if (skips.length) console.log(`skipped:\n${[...new Set(skips)].join('\n')}`)

const green = run.status === 0 && fail === 0 && skipped === 0 && !cancelled && !todo && skips.length === 0
console.log(green ? 'gate: PASSED, on real SQL, with nothing skipped.' : 'gate: NOT PASSED.')
process.exit(green ? 0 : 1)
