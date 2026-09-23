#!/usr/bin/env node
// Auto-ship: `track` records every file a Claude session edits (PostToolUse
// hook); `ship` runs when the turn ends (Stop hook) and, if `npm test` passes,
// commits and pushes ONLY those files to main. Pushing main is the deploy:
// .github/workflows/deploy.yml publishes to GitHub Pages on every push.
//
// Scoped on purpose. Several sessions edit this checkout at once, so a blanket
// `git add -A` would publish another session's half-finished work.
//
//   AUTOSHIP_DRY_RUN=1  run everything except add / commit / push.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATE_DIR = path.join(ROOT, '.claude', 'autoship')
const BRANCH = 'main'
const DRY = process.env.AUTOSHIP_DRY_RUN === '1'

// The repo is public and every push is live: never stage these, even if edited.
const NEVER = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)n8n\.env(\/|$)/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(PORTAL_CONTEXT|ARC_FIX_CHECKLIST)\.md$/,
]

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function git(args, timeout = 30_000) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function say(message) {
  process.stdout.write(JSON.stringify({ systemMessage: `autoship: ${message}` }))
}

function tail(text, lines) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n')
}

function stateFile(input) {
  const sid = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_')
  return path.join(STATE_DIR, `${sid}.txt`)
}

function track(input) {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  if (!target) return
  mkdirSync(STATE_DIR, { recursive: true })
  appendFileSync(stateFile(input), `${target}\n`)
}

function shippable(recorded) {
  const seen = new Set()
  for (const raw of recorded) {
    const rel = path.relative(ROOT, path.resolve(ROOT, raw)).split(path.sep).join('/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (NEVER.some((re) => re.test(rel))) continue
    if (git(['check-ignore', '-q', '--', rel]).status === 0) continue
    seen.add(rel)
  }
  return [...seen]
}

function changedAmong(paths) {
  const list = (args) =>
    git(args).stdout.split('\0').filter(Boolean)
  const tracked = list(['diff', '-z', '--name-only', 'HEAD', '--', ...paths])
  const untracked = list(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])
  return [...new Set([...tracked, ...untracked])]
}

function commitMessage(files) {
  const names = files.map((f) => path.posix.basename(f))
  let subject = files.length <= 3 ? `Update ${names.join(', ')}` : `Update ${files.length} files`
  if (subject.length > 72) subject = `Update ${files.length} files`
  return [
    subject,
    files.map((f) => `- ${f}`).join('\n'),
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ]
}

function ship(input) {
  const file = stateFile(input)
  if (!existsSync(file)) return

  const recorded = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const paths = shippable(recorded)
  const files = paths.length ? changedAmong(paths) : []
  if (!files.length) {
    rmSync(file, { force: true })
    return
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  if (branch !== BRANCH) {
    say(`not shipping ${files.length} file(s): on "${branch}", and only ${BRANCH} deploys.`)
    return
  }

  const tests = spawnSync('npm test', {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (tests.status !== 0) {
    say(
      `NOT pushed. npm test failed, so ${files.length} file(s) stay local. Fix and finish another prompt to ship.\n` +
        tail(`${tests.stdout}\n${tests.stderr}`, 15),
    )
    return
  }

  if (DRY) {
    say(`dry run: tests pass; would commit and push ${files.length} file(s):\n${files.join('\n')}`)
    return
  }

  const add = git(['add', '--', ...files])
  if (add.status !== 0) return say(`git add failed, nothing shipped.\n${tail(add.stderr, 8)}`)

  const [subject, body, trailer] = commitMessage(files)
  const commit = git(['commit', '-m', subject, '-m', body, '-m', trailer, '--', ...files], 120_000)
  if (commit.status !== 0) {
    return say(`git commit failed, nothing shipped.\n${tail(`${commit.stdout}\n${commit.stderr}`, 10)}`)
  }
  const sha = git(['rev-parse', '--short', 'HEAD']).stdout.trim()

  const push = git(['push', 'origin', BRANCH], 90_000)
  if (push.status !== 0) {
    return say(
      `committed ${sha} locally but the push FAILED (${files.length} file(s) not live yet). ` +
        `The next successful ship pushes it.\n${tail(push.stderr, 8)}`,
    )
  }

  rmSync(file, { force: true })
  const remote = git(['remote', 'get-url', 'origin']).stdout.trim().replace(/\.git$/, '')
  say(`shipped ${files.length} file(s) as ${sha}. GitHub Pages is deploying: ${remote}/actions`)
}

const input = readInput()
const mode = process.argv[2]
if (mode === 'track') track(input)
else if (mode === 'ship') ship(input)
else {
  console.error('usage: autoship.mjs track|ship  (hook JSON on stdin)')
  process.exit(2)
}
