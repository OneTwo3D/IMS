#!/usr/bin/env node
// Docs-required gate (see "Documentation Updates" in docs/development.md).
//
// A pull request that changes behaviour-bearing code must change documentation in the same PR, or carry
// an explicit, reasoned opt-out. Code is the source of truth: the docs follow it in the same change.
//
// - Behaviour-bearing paths, documentation paths and the narrow exclusions are the tables below. Each
//   entry carries the reason it is there, and the failure message prints the paths that triggered it.
// - The opt-out is a line in a changelog.d fragment ADDED by this PR (a `+` line of the diff, so an older
//   fragment's marker cannot be reused):
//       Docs: none — <reason of at least 20 characters>
//   The separator may be an em dash, an en dash, `-`, `--` or `:`. It sits in the reviewed diff, next to the
//   change it excuses, and the release cut carries it into CHANGELOG.md, so it stays auditable. A bare
//   `Docs: none`, or a placeholder reason, fails. The check prints every reason it accepted.
// - The comparison is merge-base(base, head)..head, as in check-migration-conventions.mjs: a pull request
//   compares against origin/<base branch>; a push compares the event's `before` SHA. In CI an empty range
//   (base == head) fails loudly instead of passing without looking at anything.
//
// Node built-ins only, so the CI job needs no `npm ci`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MIN_REASON_LENGTH = 20

/** Paths whose change can alter what the system does. */
export const BEHAVIOUR_PATHS = [
  { re: /^app\//, why: 'Next.js routes, pages, API handlers and Server Actions' },
  { re: /^lib\//, why: 'domain logic, connectors, jobs' },
  { re: /^components\//, why: 'UI: what users see and can do' },
  { re: /^prisma\/schema\.prisma$/, why: 'the data model' },
  { re: /^prisma\/migrations\//, why: 'database changes that ship' },
  { re: /^scripts\//, why: 'operator CLIs, install/update/deploy and one-off scripts that ship (tooling excluded below)' },
  { re: /^deploy\//, why: 'host deploy scripts, systemd units, nginx and env templates' },
  { re: /^(proxy|next\.config|instrumentation|instrumentation-client)\.ts$/, why: 'request proxy, Next config and startup hooks' },
]

/** Narrow exclusions from BEHAVIOUR_PATHS. Nothing else is excluded. */
export const BEHAVIOUR_EXCLUSIONS = [
  { re: /\.(test|spec)\.[cm]?[jt]sx?$/, why: 'test files' },
  { re: /(^|\/)__(tests|mocks)__\//, why: 'test and mock directories' },
  { re: /^deploy\/tests\//, why: 'deploy script tests and their stubs' },
  { re: /\.d\.[cm]?ts$/, why: 'type-only declarations' },
  { re: /\.md$/, why: 'Markdown next to code is documentation, not behaviour' },
  { re: /^lib\/releases\.ts$/, why: 'release notes data, written by the release cut' },
  { re: /^scripts\/check-[^/]+$/, why: 'CI guard scripts (repo tooling)' },
  { re: /^scripts\/[^/]+-declarations\.(ts|mjs)$/, why: 'guard declaration tables (repo tooling)' },
  { re: /^scripts\/(decimal-boundary-targets\.json|documented-env-var-allowlist\.json|archive-sealed-manifest\.tsv)$/, why: 'guard data files (repo tooling)' },
  { re: /^scripts\/[^/]+-e2e-fixture\.ts$/, why: 'e2e test fixtures' },
  { re: /^scripts\/(validate-local\.sh|validate-db\.sh|e2e-select\.mjs)$/, why: 'local validation and test-selection tooling' },
]

/** Paths that count as a documentation change. */
export const DOC_PATHS = [
  { re: /^docs\//, why: 'developer, operator and architecture docs' },
  { re: /^help-docs\//, why: 'user help pages' },
  { re: /^README\.md$/, why: 'top-level setup and feature overview' },
  { re: /^deploy\/README\.md$/, why: 'deploy runbook' },
]

/** Under docs/ but not documentation of current behaviour: plans, notes and archives. */
export const DOC_EXCLUSIONS = [
  { re: /^docs\/(scratch|todo|completed|archive)\//, why: 'design notes, plans and archived documents' },
]

const PLACEHOLDER_REASON_RE = /^(<[^>]*>|n\/?a|none|tbd|todo|nothing|no docs?|-+|\.+)$/i
const MARKER_PREFIX_RE = /^\s*(?:[-*]\s+)?docs\s*:\s*none\b/i
const MARKER_RE = /^\s*(?:[-*]\s+)?docs\s*:\s*none\s*(?:—|–|--|-|:)\s*(.*?)\s*$/i
const FRAGMENT_RE = /^changelog\.d\/[^/]+\.md$/

const matches = (table, path) => table.some(({ re }) => re.test(path))

export function isBehaviourPath(path) {
  return matches(BEHAVIOUR_PATHS, path) && !matches(BEHAVIOUR_EXCLUSIONS, path)
}

export function isDocPath(path) {
  return matches(DOC_PATHS, path) && !matches(DOC_EXCLUSIONS, path)
}

export function isFragmentPath(path) {
  return FRAGMENT_RE.test(path) && path !== 'changelog.d/README.md'
}

/**
 * The lines a unified diff ADDS, with the file each belongs to. Input is `git diff -U0` output; `+++ b/<path>`
 * names the file (`+++ /dev/null` is a deletion and adds nothing).
 */
export function parseAddedLines(patch) {
  const added = []
  let file = null
  let inHeader = false
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null
      inHeader = true
    } else if (inHeader && line.startsWith('+++ ')) {
      const target = line.slice(4)
      file = target === '/dev/null' ? null : target.replace(/^b\//, '')
    } else if (line.startsWith('@@')) {
      inHeader = false
    } else if (file && !inHeader && line.startsWith('+')) {
      added.push({ file, line: line.slice(1) })
    }
  }
  return added
}

/** Opt-out markers among added fragment lines: accepted ones, and malformed ones (always an error). */
export function findOptOuts(addedLines) {
  const accepted = []
  const errors = []
  for (const { file, line } of addedLines) {
    if (!isFragmentPath(file) || !MARKER_PREFIX_RE.test(line)) continue
    const m = MARKER_RE.exec(line)
    const reason = m ? m[1].trim() : ''
    if (!m || !reason) {
      errors.push(`${file}: "${line.trim()}" has no reason. Write "Docs: none — <why this change needs no documentation>".`)
    } else if (PLACEHOLDER_REASON_RE.test(reason) || reason.length < MIN_REASON_LENGTH) {
      errors.push(`${file}: "${line.trim()}" needs a real reason of at least ${MIN_REASON_LENGTH} characters, not a placeholder.`)
    } else {
      accepted.push({ file, reason })
    }
  }
  return { accepted, errors }
}

/** The decision. Pure: the changed paths and the added lines in, a verdict and its explanation out. */
export function evaluateDocsRequired({ changedFiles, addedLines }) {
  const behaviour = changedFiles.filter(isBehaviourPath)
  const docs = changedFiles.filter(isDocPath)
  const { accepted, errors } = findOptOuts(addedLines)
  const lines = []
  if (errors.length > 0) {
    lines.push('Malformed docs opt-out marker(s):', ...errors.map((e) => `  ${e}`))
    return { ok: false, behaviour, docs, accepted, lines }
  }
  if (behaviour.length === 0) {
    lines.push(`Docs-required check passed: no behaviour-bearing path changed (${changedFiles.length} changed file(s)).`)
    return { ok: true, behaviour, docs, accepted, lines }
  }
  if (docs.length > 0) {
    lines.push(`Docs-required check passed: ${behaviour.length} behaviour-bearing file(s) changed with ${docs.length} documentation file(s):`)
    lines.push(...docs.map((d) => `  ${d}`))
    for (const a of accepted) lines.push(`(Also carries an opt-out in ${a.file}: ${a.reason})`)
    return { ok: true, behaviour, docs, accepted, lines }
  }
  if (accepted.length > 0) {
    lines.push(`Docs-required check passed by opt-out: ${behaviour.length} behaviour-bearing file(s) changed and no documentation file.`)
    for (const a of accepted) lines.push(`Accepted reason (${a.file}): ${a.reason}`)
    return { ok: true, behaviour, docs, accepted, lines }
  }
  lines.push(
    `Docs-required check FAILED: ${behaviour.length} behaviour-bearing file(s) changed, but no file under docs/ or help-docs/ (or README.md, deploy/README.md):`,
    ...behaviour.slice(0, 40).map((b) => `  ${b}`),
    ...(behaviour.length > 40 ? [`  ... and ${behaviour.length - 40} more`] : []),
    'Update every doc this change makes stale (docs/development.md, "Documentation Updates", lists them).',
    'If the change truly needs no documentation, add a line to this PR\'s changelog.d fragment:',
    '  Docs: none — <why this change needs no documentation>',
  )
  return { ok: false, behaviour, docs, accepted, lines }
}

// --- git plumbing (not unit-tested in isolation; tests/scripts/check-docs-required.test.ts drives it in a temp repo)

function git(args) {
  // Every option that could hide or rewrite a path is set explicitly (quotePath, renames, external diff).
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

export function baseFromGithubEvent(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || !env.GITHUB_EVENT_PATH) return undefined
  try {
    const before = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.before
    return typeof before === 'string' && before ? before : undefined
  } catch {
    return undefined
  }
}

function resolveRange(baseRef, headRef, { ci }) {
  let base = baseRef
  if (/^0{7,40}$/.test(base)) {
    base = `${headRef}^`
    console.warn(`Base ref is the all-zero SHA (new branch or force push); comparing against ${base}.`)
  }
  let baseCommit = ''
  let headCommit = ''
  try {
    baseCommit = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim()
    headCommit = git(['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`]).trim()
  } catch {
    baseCommit = ''
  }
  if (!baseCommit || !headCommit) fail(`Cannot resolve the comparison range ${base}..${headRef}; refusing to pass without comparing anything.`)
  if (ci && baseCommit === headCommit) {
    fail(`The comparison range ${base}..${headRef} is empty (both are ${baseCommit}); nothing would be examined. On a push event pass the event's before SHA via DOCS_REQUIRED_BASE_REF.`)
  }
  let mergeBase
  try {
    mergeBase = git(['merge-base', base, headRef]).trim()
  } catch (error) {
    fail(`Unable to compute merge-base between ${base} and ${headRef}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { base, mergeBase }
}

function main() {
  const baseRef =
    process.argv[2]
    ?? process.env.DOCS_REQUIRED_BASE_REF
    ?? baseFromGithubEvent()
    ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/development')
  const headRef = process.argv[3] ?? process.env.DOCS_REQUIRED_HEAD_REF ?? 'HEAD'
  const { base, mergeBase } = resolveRange(baseRef, headRef, { ci: Boolean(process.env.CI) })

  const common = ['--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', mergeBase, headRef]
  const changedFiles = git(['diff', '--name-only', '-z', ...common]).split('\0').filter(Boolean)
  const patch = git(['diff', '-U0', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...common, '--', 'changelog.d/'])
  const result = evaluateDocsRequired({ changedFiles, addedLines: parseAddedLines(patch) })

  const out = [...result.lines, `(Compared merge-base(${base}, ${headRef}) = ${mergeBase.slice(0, 12)}..${headRef}.)`].join('\n')
  if (!result.ok) fail(out)
  console.log(out)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
