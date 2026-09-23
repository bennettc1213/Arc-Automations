#!/usr/bin/env node
// Site impact: "if these files ship, does anyone see it on arcautomation.site,
// or is it backend code?" Used by the autoship Stop hook (its message ends with
// this verdict) and by hand:
//
//   node scripts/site-impact.mjs [--state=preview|shipped|held] <file>...
//
// Folder names cannot answer this. `src/portal/lib/modules.js` imports
// `supabase/functions/_shared/registry/modules.ts`, so a file under supabase/ is
// sometimes part of the website, and package.json is too (the /ops door prints its
// version). So the answer is read off the import graph, the way Vite builds it:
// walk imports from index.html, and from each route's page, and see what is
// reached. The same walk from each edge function says which ones a shared file
// would need redeploying to.
//
// Zero dependencies, and it never throws for a file it cannot parse: it guesses
// nothing and says "not reachable" instead.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE_URL = 'https://arcautomation.site'
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Each page's entry file, so a change can say where to look. This is data on purpose:
// a route added to App.jsx that is missing here still reads as "site-wide", never as
// "not visible". Access says whether a stranger can open it.
export const ROUTES = [
  { path: '/', access: 'public', entry: 'src/Site.jsx' },
  { path: '/portal', access: 'public', entry: 'src/portal/pages/PortalHome.jsx' },
  { path: '/portal/dashboard', access: 'client sign-in', entry: 'src/portal/pages/Portal.jsx' },
  { path: '/login', access: 'public', entry: 'src/portal/pages/Login.jsx' },
  { path: '/auth/callback', access: 'public', entry: 'src/portal/pages/AuthCallback.jsx' },
  { path: '/demo', access: 'public', entry: 'src/portal/pages/Demo.jsx' },
  { path: '/ops', access: 'public', entry: 'src/portal/pages/OpsHome.jsx' },
  { path: '/ops/console', access: 'operator sign-in', entry: 'src/portal/pages/Ops.jsx' },
]

// Runs at build time to generate the demo data that /demo and the /portal preview ship.
const DEMO_BUILDER = 'scripts/build-demo-data.mjs'
// Changes how the site is built or deployed, not what a page says.
const BUILD_FILES = [
  /^vite\.config\.[cm]?js$/,
  /^package-lock\.json$/,
  /^scripts\/(spa-fallback|build-demo-data)\.mjs$/,
  /^\.github\/workflows\//,
]

const SCRIPT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs'])
const RESOLVE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.css']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-smoke'])
const BACKEND_EXT = /\.(sql|ts|js|json|toml)$/

const posix = (p) => p.split(path.sep).join('/')
const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function walk(dir) {
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return names.flatMap((d) => {
    if (SKIP_DIRS.has(d.name)) return []
    const full = path.join(dir, d.name)
    return d.isDirectory() ? walk(full) : [full]
  })
}

// ---- import scanning ------------------------------------------------------------

const FROM = /\bfrom\s*['"]([^'"\n]+)['"]/g
const SIDE_EFFECT = /\bimport\s*['"]([^'"\n]+)['"]/g
const DYNAMIC = /\bimport\(\s*['"]([^'"\n]+)['"]\s*[,)]/g
const GLOB_CALL = /import\.meta\.glob(?:Eager)?\(\s*(\[[^\]]*\]|['"][^'"]+['"])/g

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1')
}

function matches(re, text) {
  return [...text.matchAll(re)].map((m) => m[1])
}

// what a file pulls in: relative/absolute specifiers, plus import.meta.glob patterns
// (read from the raw text, because "**/*" inside a pattern looks like a comment)
function scan(file) {
  const ext = path.extname(file).toLowerCase()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { specs: [], globs: [] }
  }
  if (ext === '.html') {
    return {
      specs: [
        ...matches(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi, text),
        ...matches(/<link\b[^>]*\shref=["']([^"']+)["']/gi, text),
      ],
      globs: [],
    }
  }
  if (ext === '.css') {
    return {
      specs: [
        ...matches(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g, text),
        ...matches(/url\(\s*['"]?([^'")\s]+)/g, text),
      ],
      globs: [],
    }
  }
  if (!SCRIPT_EXT.has(ext)) return { specs: [], globs: [] }
  const globs = matches(GLOB_CALL, text).flatMap((arg) => matches(/['"]([^'"]+)['"]/g, arg))
  const code = stripComments(text)
  return {
    specs: [...matches(FROM, code), ...matches(SIDE_EFFECT, code), ...matches(DYNAMIC, code)],
    globs,
  }
}

function resolveSpec(root, importer, spec) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(spec)) return null
  let base
  if (spec.startsWith('/')) base = path.join(root, spec)
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(importer), spec)
  else return null // a package: it is in node_modules, not ours
  const bare = base.replace(/[?#].*$/, '')
  const candidates = [
    bare,
    ...RESOLVE_EXT.map((e) => bare + e),
    ...RESOLVE_EXT.map((e) => path.join(bare, `index${e}`)),
  ]
  return candidates.find(isFile) ?? null
}

function expandGlob(root, importer, pattern) {
  if (!/^[./]/.test(pattern)) return []
  const abs = pattern.startsWith('/') ? path.join(root, pattern) : path.resolve(path.dirname(importer), pattern)
  const p = posix(abs)
  const star = p.search(/[*?[{]/)
  const base = star === -1 ? p : p.slice(0, p.lastIndexOf('/', star))
  const re = new RegExp(
    '^' +
      p
        .replace(/[.+^$()|\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?') +
      '$',
  )
  return walk(base).filter((f) => re.test(posix(f)))
}

// every file reachable from the entries, as absolute paths
function reach(root, entries) {
  const seen = new Set()
  const stack = entries.filter(isFile)
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const { specs, globs } = scan(file)
    for (const spec of specs) {
      const hit = resolveSpec(root, file, spec)
      if (hit) stack.push(hit)
    }
    for (const pattern of globs) stack.push(...expandGlob(root, file, pattern))
  }
  return seen
}

function buildGraph(root, routes) {
  const rel = (f) => posix(path.relative(root, f))
  const reachRel = (entries) => new Set([...reach(root, entries.map((e) => path.join(root, e)))].map(rel))
  const fnRoot = path.join(root, 'supabase', 'functions')
  let fnNames = []
  try {
    fnNames = readdirSync(fnRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
  } catch {
    // no edge functions in this tree
  }
  return {
    site: reachRel(['index.html']),
    demo: reachRel([DEMO_BUILDER]),
    routes: routes.map((r) => ({ ...r, files: reachRel([r.entry]) })),
    fns: new Map(fnNames.map((n) => [n, reachRel([`supabase/functions/${n}/index.ts`])])),
  }
}

// ---- classification -------------------------------------------------------------

function normalize(root, raw) {
  const rel = posix(path.isAbsolute(raw) ? path.relative(root, raw) : path.normalize(raw))
  return !rel || rel.startsWith('..') ? null : rel
}

// Sorts each file into what it means for the live site:
//   visible     part of the built site, with the pages it appears on
//   backend     a migration or edge-function file, with what has to be deployed
//   build       build/deploy config: rebuilds the site, no page changes
//   unreachable a src/ file nothing imports
//   other       tests, docs, tooling
// A file can be both visible and backend (a shared module the site imports).
export function siteImpact(input, { root = DEFAULT_ROOT, routes = ROUTES } = {}) {
  const graph = buildGraph(root, routes)
  const out = { visible: [], backend: [], build: [], unreachable: [], other: [] }

  for (const raw of new Set(input)) {
    const file = normalize(root, raw)
    if (!file) continue

    const onSite = graph.site.has(file) || file.startsWith('public/')
    const feedsDemo = graph.demo.has(file) && file !== DEMO_BUILDER
    let placed = false

    if (onSite || feedsDemo) {
      const where = graph.routes.filter((r) => r.files.has(file)).map(({ path: p, access }) => ({ path: p, access }))
      // the demo's numbers are computed at build time by code the /demo page never
      // imports, so a change to that code shows up there without being in its bundle
      if (feedsDemo && !where.some((w) => w.path === '/demo')) where.push({ path: '/demo', access: 'public' })
      if (!where.length) where.push({ path: 'every page', access: 'public' })
      out.visible.push({ file, routes: where })
      placed = true
    }

    if (file.startsWith('supabase/') && BACKEND_EXT.test(file)) {
      if (file.startsWith('supabase/migrations/')) {
        out.backend.push({ file, kind: 'migration', functions: [] })
      } else {
        const own = /^supabase\/functions\/([^/_][^/]*)\//.exec(file)?.[1]
        const functions = [...graph.fns].filter(([, set]) => set.has(file)).map(([name]) => name)
        if (own && !functions.includes(own)) functions.push(own)
        functions.sort()
        out.backend.push({ file, kind: file.startsWith('supabase/functions/') ? 'function' : 'config', functions })
      }
      placed = true
    }

    if (placed) continue
    if (BUILD_FILES.some((re) => re.test(file))) out.build.push(file)
    else if (/^src\/.+\.(jsx?|tsx?|css)$/.test(file)) out.unreachable.push(file)
    else out.other.push(file)
  }
  return out
}

// ---- wording --------------------------------------------------------------------

const short = (file) => file.split('/').slice(-2).join('/')
const list = (files, n = 4) => {
  const names = files.map(short)
  return names.length > n ? `${names.slice(0, n).join(', ')} +${names.length - n} more` : names.join(', ')
}

// state: 'shipped' (pushed), 'held' (not pushed), 'preview' (not yet decided).
export function describeImpact(input, { state = 'preview', root, routes } = {}) {
  const r = siteImpact(input, { root, routes })
  const lines = []
  const pushed =
    state === 'shipped' ? 'Pushed to GitHub' : state === 'held' ? 'Not pushed yet' : 'Goes to GitHub when it ships'

  if (r.visible.length) {
    lines.push(
      state === 'shipped'
        ? `arcautomation.site: VISIBLE. Live once GitHub Pages finishes, about 2 minutes.`
        : state === 'held'
          ? `arcautomation.site: would be VISIBLE, but nothing is pushed, so the site has not changed.`
          : `arcautomation.site: VISIBLE once shipped (pushed after the tests pass, then about 2 minutes).`,
    )
    const byRoute = new Map()
    for (const { file, routes: where } of r.visible) {
      for (const { path: p, access } of where) {
        const key = access === 'public' ? p : `${p} (${access})`
        byRoute.set(key, [...(byRoute.get(key) ?? []), file])
      }
    }
    for (const [key, files] of [...byRoute].slice(0, 6)) lines.push(`  ${SITE_URL}${key.startsWith('/') ? key : ` ${key}`}: ${list(files, 3)}`)
    if (byRoute.size > 6) lines.push(`  +${byRoute.size - 6} more pages`)
  } else if (r.backend.length) {
    lines.push(`arcautomation.site: NO VISIBLE CHANGE. This is backend code.`)
  } else if (r.build.length) {
    lines.push(`arcautomation.site: NO PAGE CHANGE. Build/deploy config only: ${list(r.build)}.`)
  } else {
    lines.push(`arcautomation.site: NO CHANGE. Tests, docs or tooling only, not part of the site or the backend.`)
  }

  if (r.backend.length) {
    const migrations = r.backend.filter((b) => b.kind === 'migration').map((b) => b.file)
    const fns = [...new Set(r.backend.flatMap((b) => b.functions))].sort()
    const orphans = r.backend.filter((b) => b.kind !== 'migration' && !b.functions.length).map((b) => b.file)
    lines.push(
      `${r.visible.length ? 'Also backend' : pushed}: the live database and edge functions only change when you deploy them.`,
    )
    if (migrations.length) lines.push(`  database: ${list(migrations)}  ->  supabase db push`)
    if (fns.length) lines.push(`  edge functions to redeploy: ${fns.join(', ')} (DEPLOYMENT.md)`)
    if (orphans.length) lines.push(`  not imported by any function: ${list(orphans)}`)
  }
  if (r.visible.length && r.build.length) lines.push(`Build config too: ${list(r.build)}.`)
  if (r.unreachable.length) lines.push(`Not imported by any page, so invisible: ${list(r.unreachable)}.`)
  if ((r.visible.length || r.backend.length) && r.other.length) {
    lines.push(`${r.other.length} test/doc/tooling file(s), not part of the site.`)
  }
  return lines.join('\n')
}

// ---- CLI ------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const state = args.find((a) => a.startsWith('--state='))?.slice(8) ?? 'preview'
  const json = args.includes('--json')
  const files = args.filter((a) => !a.startsWith('--'))
  if (!files.length) {
    console.error('usage: site-impact.mjs [--state=preview|shipped|held] [--json] <file>...')
    process.exit(2)
  }
  const missing = files.filter((f) => !existsSync(path.resolve(f)))
  if (missing.length) console.error(`note: not on disk (classified by path only): ${missing.join(', ')}`)
  console.log(json ? JSON.stringify(siteImpact(files), null, 2) : describeImpact(files, { state }))
}
