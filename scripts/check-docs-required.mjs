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
//   `Docs: none`, or a placeholder or junk reason, fails. Only a fragment the PR ADDS counts (an edit of an
//   older fragment cannot carry one). `Docs: none — revert of #<n>` is accepted as is, and a range whose every
//   commit is a git revert (`Revert "…"`) passes. The check prints every reason it accepted.
// - The comparison is merge-base(base, head)..head, as in check-migration-conventions.mjs: a pull request
//   compares against origin/<base branch>; a push compares the event's `before` SHA (or HEAD^, with a
//   warning, when that SHA is not in the clone). In CI an empty range (base == head, or a head that is an
//   ancestor of the base, as after a backwards force-push) fails loudly instead of passing without looking at
//   anything. Outside CI the uncommitted working tree is included, and a missing base or a shallow clone is
//   warned about and skipped rather than failing `check:all`.
//
// Node built-ins only, so the CI job needs no `npm ci`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MIN_REASON_LENGTH = 20
export const MIN_REASON_WORDS = 3

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
  { re: /^sentry\.[^/]+\.config\.ts$/, why: 'error-reporting configuration that runs in the app' },
  { re: /^prisma\.config\.ts$/, why: 'Prisma CLI configuration used by migrate deploy' },
  { re: /^prisma\/seed\.ts$/, why: 'database seed data' },
  { re: /^Dockerfile$/, why: 'the container image that ships' },
]

/**
 * The guard scripts that run ONLY as repo tooling: each backs a `check:*` package script that a workflow runs,
 * and no shipped shell script (scripts/deploy.sh, update.sh, install.sh, deploy/**) references it. Other
 * `scripts/check-*` files ship and stay behaviour: check-db-writers, check-app-db-object-access,
 * check-prisma-drift and check-wms-push-state-enum run on production hosts during install/update/deploy;
 * check-so and check-bom-recipe-consistency are operator CLIs; check-prisma-schema-scope and
 * check-stock-quantity-constraints back no `check:*` script. tests/scripts/check-docs-required.test.ts derives
 * this list from package.json, the workflows and the shipped shell scripts and fails when it drifts.
 */
export const CI_ONLY_GUARDS = [
  'check-archive-sealed.mjs',
  'check-changelog-fragments.mjs',
  'check-connector-fetch-boundaries.mjs',
  'check-docs-required.mjs',
  'check-documented-env-vars.mjs',
  'check-domain-decimal-boundaries.mjs',
  'check-fulfillment-requirement-seam.mjs',
  'check-ledger-standing-readers.mjs',
  'check-migration-conventions.mjs',
  'check-producer-census.ts',
  'check-server-action-auth-bypass.mjs',
  'check-shadow-readers.ts',
  'check-system-import-capability.mjs',
  'check-wc-sync-row-predicates.mjs',
  'check-wms-connector-boundary.mjs',
]
const CI_ONLY_GUARD_RE = new RegExp(`^scripts/(${CI_ONLY_GUARDS.map((f) => f.replace(/[.]/g, '\\.')).join('|')})$`)

/** Narrow exclusions from BEHAVIOUR_PATHS. Nothing else is excluded. */
export const BEHAVIOUR_EXCLUSIONS = [
  { re: /\.(test|spec)\.[cm]?[jt]sx?$/, why: 'test files' },
  { re: /(^|\/)__(tests|mocks)__\//, why: 'test and mock directories' },
  { re: /^deploy\/tests\//, why: 'deploy script tests and their stubs' },
  { re: /\.d\.[cm]?ts$/, why: 'type-only declarations' },
  { re: /(^|\/)README\.md$|(^|\/)docs\/.+\.md$/, why: 'a README.md or a docs/ page next to code is documentation, not behaviour (other Markdown may be read at run time)' },
  { re: /^lib\/releases\.ts$/, why: 'release notes data, written by the release cut' },
  { re: CI_ONLY_GUARD_RE, why: 'CI-only guard scripts (repo tooling; see CI_ONLY_GUARDS)' },
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
  { re: /^\.env\.example$/, why: 'the configuration template' },
]

/** Under docs/ but not documentation of current behaviour: plans, notes and archives. */
export const DOC_EXCLUSIONS = [
  { re: /^docs\/(scratch|todo|completed|archive)\//, why: 'design notes, plans and archived documents' },
]

const PLACEHOLDER_REASON_RE = /^(<[^>]*>|n\/?a|none|tbd|todo|nothing|no docs?|-+|\.+)$/i
/** A run of five or more of the same character ("xxxxx", "....."): filler, not a reason. */
const REPEATED_RUN_RE = /(\S)\1{4,}/
/** `Docs: none — revert of #123`: a revert restores the docs of the change it undoes. */
const REVERT_REASON_RE = /^revert of #\d+$/i
/** A git revert's default subject. */
const REVERT_SUBJECT_RE = /^Revert "/
// A marker is `Docs: none` followed by a separator or the end of the line, so prose such as "Docs: none of the
// help pages changed" is not mistaken for a malformed marker.
const MARKER_PREFIX_RE = /^\s*(?:[-*]\s+)?docs\s*:\s*none\s*(?:[—–:-]|$)/i
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
 * The lines a unified diff ADDS, with the file each belongs to and whether that file is new in the diff. Input is
 * `git diff -U0` output; `+++ b/<path>` names the file (`+++ /dev/null` is a deletion and adds nothing), and
 * `--- /dev/null` marks a file the diff adds.
 */
export function parseAddedLines(patch) {
  const added = []
  let file = null
  let newFile = false
  let inHeader = false
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null
      newFile = false
      inHeader = true
    } else if (inHeader && line.startsWith('--- ')) {
      newFile = line.slice(4) === '/dev/null'
    } else if (inHeader && line.startsWith('+++ ')) {
      const target = line.slice(4)
      file = target === '/dev/null' ? null : target.replace(/^b\//, '')
    } else if (line.startsWith('@@')) {
      inHeader = false
    } else if (file && !inHeader && line.startsWith('+')) {
      added.push({ file, line: line.slice(1), newFile })
    }
  }
  return added
}

/** Why a reason is not acceptable, or null. A revert reference is accepted whatever its length. */
export function reasonProblem(reason) {
  if (REVERT_REASON_RE.test(reason)) return null
  if (PLACEHOLDER_REASON_RE.test(reason) || reason.length < MIN_REASON_LENGTH) {
    return `needs a real reason of at least ${MIN_REASON_LENGTH} characters, not a placeholder`
  }
  if (reason.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length < MIN_REASON_WORDS) {
    return `needs a reason of at least ${MIN_REASON_WORDS} words`
  }
  if (REPEATED_RUN_RE.test(reason)) return 'needs a real reason, not a run of repeated characters'
  return null
}

/** Opt-out markers among added fragment lines: accepted ones, and malformed ones (always an error). */
export function findOptOuts(addedLines) {
  const accepted = []
  const errors = []
  for (const { file, line, newFile } of addedLines) {
    // Only a fragment this change ADDS carries an opt-out: a line added to an older fragment does not.
    if (newFile === false) continue
    if (!isFragmentPath(file) || !MARKER_PREFIX_RE.test(line)) continue
    const m = MARKER_RE.exec(line)
    const reason = m ? m[1].trim() : ''
    const problem = m && reason ? reasonProblem(reason) : null
    if (!m || !reason) {
      errors.push(`${file}: "${line.trim()}" has no reason. Write "Docs: none — <why this change needs no documentation>".`)
    } else if (problem) {
      errors.push(`${file}: "${line.trim()}" ${problem}.`)
    } else {
      accepted.push({ file, reason })
    }
  }
  return { accepted, errors }
}

/** Every commit of the range is a git revert (`Revert "…"`): it restores the documentation of what it undoes. */
export function isRevertOnly(commitSubjects) {
  return Array.isArray(commitSubjects) && commitSubjects.length > 0 && commitSubjects.every((s) => REVERT_SUBJECT_RE.test(s))
}

/**
 * The decision. Pure: the changed paths, the added lines and (optionally) the commit subjects in, a verdict and its explanation out.
 * @param {{ changedFiles: string[], addedLines: Array<{ file: string, line: string, newFile?: boolean }>, commitSubjects?: string[] }} input
 */
export function evaluateDocsRequired({ changedFiles, addedLines, commitSubjects = [] }) {
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
  if (isRevertOnly(commitSubjects)) {
    lines.push(`Docs-required check passed: every commit is a revert (${commitSubjects.length}); a revert restores the documentation of what it undoes.`)
    return { ok: true, behaviour, docs, accepted, lines }
  }
  lines.push(
    `Docs-required check FAILED: ${behaviour.length} behaviour-bearing file(s) changed, but no file under docs/ or help-docs/ (or README.md, deploy/README.md, .env.example):`,
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

/** Outside CI only: say why nothing was compared and pass, so a local `check:all` is not blocked by the clone. */
function skipLocally(message) {
  console.warn(`Docs-required check SKIPPED (not in CI): ${message}`)
  process.exit(0)
}

function resolves(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
  } catch {
    return ''
  }
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

function resolveRange(baseRef, headRef, { ci, pushEvent }) {
  let base = baseRef
  if (/^0{7,40}$/.test(base)) {
    base = `${headRef}^`
    console.warn(`Base ref is the all-zero SHA (new branch or force push); comparing against ${base}.`)
  }
  if (!ci) {
    let shallow = false
    try {
      shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
    } catch {
      shallow = false
    }
    if (shallow) skipLocally('this is a shallow clone, so the merge-base cannot be computed. Run `git fetch --unshallow origin` to check.')
    if (!resolves(base)) skipLocally(`the base ${base} is not in this clone. Run \`git fetch origin\` (or pass the base as the first argument) to check.`)
  }
  let baseCommit = resolves(base)
  const headCommit = resolves(headRef)
  if (!baseCommit && headCommit && pushEvent && base !== `${headRef}^`) {
    // The push's `before` SHA is not in the clone (a force push dropped it): compare the pushed commit alone.
    console.warn(`The push's before SHA ${base} is not in this clone (force push?); comparing against ${headRef}^ instead.`)
    base = `${headRef}^`
    baseCommit = resolves(base)
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
  if (ci && mergeBase === headCommit) {
    fail(`The comparison range merge-base(${base}, ${headRef})..${headRef} is empty: ${headRef} is an ancestor of ${base} (a backwards force push?), so nothing would be examined.`)
  }
  return { base, mergeBase }
}

/** Untracked files outside .gitignore (a local run includes them). */
function untrackedFiles() {
  return git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
}

function main() {
  const ci = Boolean(process.env.CI)
  const baseRef =
    process.argv[2]
    ?? process.env.DOCS_REQUIRED_BASE_REF
    ?? baseFromGithubEvent()
    ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/development')
  const explicitHead = process.argv[3] ?? process.env.DOCS_REQUIRED_HEAD_REF
  const headRef = explicitHead ?? 'HEAD'
  const { base, mergeBase } = resolveRange(baseRef, headRef, { ci, pushEvent: process.env.GITHUB_EVENT_NAME === 'push' })

  // Outside CI, with no explicit head, the uncommitted working tree is part of the change: tracked edits are compared
  // against the working tree (`git diff <merge-base>`), and untracked files are added on top.
  const local = !ci && explicitHead === undefined
  const target = local ? [mergeBase] : [mergeBase, headRef]
  const common = ['--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', ...target]
  const changedFiles = git(['diff', '--name-only', '-z', ...common]).split('\0').filter(Boolean)
  let addedLines = parseAddedLines(git(['diff', '-U0', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...common, '--', 'changelog.d/']))
  if (local) {
    const untracked = untrackedFiles()
    for (const file of untracked) if (!changedFiles.includes(file)) changedFiles.push(file)
    for (const file of untracked.filter(isFragmentPath)) {
      addedLines = addedLines.concat(readFileSync(file, 'utf8').split(/\r?\n/).map((line) => ({ file, line, newFile: true })))
    }
  }
  const commitSubjects = git(['log', '--no-merges', '--format=%s', `${mergeBase}..${headRef}`]).split(/\r?\n/).filter(Boolean)
  const result = evaluateDocsRequired({ changedFiles, addedLines, commitSubjects })

  const range = local ? `${mergeBase.slice(0, 12)}..working tree (uncommitted and untracked files included)` : `${mergeBase.slice(0, 12)}..${headRef}`
  const out = [...result.lines, `(Compared merge-base(${base}, ${headRef}) = ${range}.)`].join('\n')
  if (!result.ok) fail(out)
  console.log(out)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
