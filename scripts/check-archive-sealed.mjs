#!/usr/bin/env node
// =============================================================================
// THE ARCHIVE IS SEALED, AND THIS IS THE ONLY THING THAT CAN SEE IT (o3d-bddq)
// =============================================================================
// #698 archived the QuickBooks, Shopify and ShipHero connectors as RENAMES:
// `lib/connectors/quickbooks/... -> archive/connectors/quickbooks/...`. Any branch that had
// modified one of those files gets its hunks auto-merged INTO the archived copy by git's rename
// detection, WITH NO CONFLICT MARKER. It happened twice within a day: o3d-c08y took +5/-10 into
// archive/connectors/quickbooks/daily-sync.ts, and o3d-j625 took +178/-42 across nine files.
//
// NOTHING ELSE IN THE TOOLCHAIN CAN SEE IT. `archive/` is excluded from tsconfig, from eslint, from
// the `tests/**/*.test.ts` glob and from all four `check:*` SCAN_ROOTS, which is the whole point of
// archiving — so tsc, lint, every test tier, `npm run validate` and CI are all blind to a hybrid by
// construction. The existing archive walk in tests/security/server-action-guard-coverage.test.ts
// checks the OPPOSITE arrow (that nothing live imports FROM archive/).
//
// AND THE OBVIOUS CHECK DOES NOT WORK. `git diff --name-only <sealing-commit>...HEAD -- archive/`
// returns ZERO LINES while nine files are hybridised, because during an in-progress merge HEAD is
// still the PRE-merge commit and the three-dot form compares against a merge base. It reports the
// truth only after the merge is committed, by which point the hybrid is in history. Both branches
// above ran that form and were told they were clean.
//
// THE FIRST VERSION OF THIS FILE HAD THAT SAME BLINDNESS, which is worth recording rather than
// quietly deleting. It pinned the invariant to a committed manifest — correctly — but then read the
// tree with `git ls-tree HEAD`, and `HEAD` during an in-progress merge is the PRE-merge commit for
// exactly the reason spelled out two paragraphs above. The hybrid lives in the INDEX and the
// WORKING TREE at the moment you could still stop it; the check looked past both at the committed
// tree and reported the count of paths it had examined, all of them the sealed versions. The guard
// reproduced the defect it was written to catch. Codex found it on PR #707 (HIGH).
//
// SO THE SUBJECT IS THE INDEX AND THE WORKING TREE BY DEFAULT, and a ref only when one is asked for
// explicitly. `git ls-files -s -- archive/` reads the INDEX, which is where a mid-merge hybrid
// actually sits; `git diff` against the working tree then catches an edit that has not been `git
// add`ed yet, because the next `git add -A` would commit it. An unresolved conflict inside
// `archive/` (index stages 1/2/3 instead of stage 0) is refused outright: the archive is not
// something you resolve a conflict in, and merging a conflicted archive is precisely the event
// this exists to stop. CI checks out the merge commit, where HEAD is the right subject, and can
// still ask for it with `ARCHIVE_SEAL_REF=HEAD` — but the DEFAULT is the one that catches the
// hazard, because the default is what everybody runs.
//
// THE INVARIANT IS PINNED TO A COMMITTED MANIFEST, not to a commit and not to a diff. Every path
// under `archive/` and its blob hash are recorded in the manifest; this check reads the subject and
// requires an exact match. That holds during a merge, in a shallow clone, and without the sealing
// commit present — and changing anything under `archive/` becomes a DELIBERATE, REVIEWABLE edit to
// the manifest rather than something a rename heuristic can do silently.
//
// FAILS CLOSED, INCLUDING ON ITS OWN ABSENCE. A missing manifest, an empty manifest, or an empty
// `archive/` subject is a failure, not a pass: "it printed nothing" is exactly how this defect
// travelled. The count examined is printed on success so a future reader can see the check had
// something to look at.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// Positional arguments only, so a flag can never be read as a ref: the first draft of this script
// took `process.argv[2]` and dutifully ran `git ls-tree -r --write`, which is the same class of
// mistake as everything else this file exists to catch.
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const MANIFEST = process.env.ARCHIVE_SEAL_MANIFEST ?? positional[1] ?? 'scripts/archive-sealed-manifest.tsv'
// NO DEFAULT. An absent ref means "the index and working tree", which is the subject that can see a
// hybrid while it is still stoppable. A ref is an explicit opt-in and never a fallback — the
// fallback is what a mid-merge branch gets, and it must be the safe one.
const EXPLICIT_REF = process.env.ARCHIVE_SEAL_REF ?? positional[0] ?? null

function fail(message) {
  console.error(`archive seal: ${message}`)
  process.exit(1)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function treeEntries(ref) {
  // `ls-tree -r` carries the BLOB HASH, so this compares contents and not merely which paths exist.
  const out = git(['ls-tree', '-r', ref, '--', 'archive/'])
  const entries = new Map()
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    // <mode> <type> <sha>\t<path>
    const [meta, path] = line.split('\t')
    const parts = meta.split(/\s+/)
    if (parts.length < 3 || !path) fail(`could not parse ls-tree line: ${line}`)
    entries.set(path, `${parts[0]} ${parts[2]}`)
  }
  return entries
}

function indexEntries() {
  // `ls-files -s` carries the BLOB HASH and the STAGE, and it reads the INDEX — the one place a
  // half-merged archive/ exists before anyone commits it.
  const out = git(['ls-files', '-s', '--', 'archive/'])
  const entries = new Map()
  const conflicted = new Set()
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    // <mode> <sha> <stage>\t<path>
    const [meta, path] = line.split('\t')
    const parts = meta.split(/\s+/)
    if (parts.length < 3 || !path) fail(`could not parse ls-files line: ${line}`)
    const [mode, sha, stage] = parts
    if (stage !== '0') {
      // Stages 1/2/3 are an UNRESOLVED merge conflict. There is no blob to compare and no version
      // of "resolving it" that leaves the seal intact, so this is a refusal on its own terms.
      conflicted.add(path)
      continue
    }
    entries.set(path, `${mode} ${sha}`)
  }
  if (conflicted.size > 0) {
    fail(
      `${conflicted.size} path(s) under archive/ are in an UNRESOLVED MERGE CONFLICT:\n`
      + [...conflicted].sort().map((p) => `  CONFLICT  ${p}`).join('\n')
      + '\n\narchive/ is a sealed record, not code to merge. Do not resolve the conflict here:\n'
      + '    git checkout <the sealing commit> -- archive/\n'
      + 'and decide whether the change belongs on the LIVE side at all.',
    )
  }
  return entries
}

function worktreeDeviations() {
  // The index is not the whole story: a file edited and not yet staged is still a file the next
  // `git add -A` commits. `git diff` (worktree vs index) sees exactly that, and `ls-files --others`
  // sees a file that was dropped into archive/ and never added.
  const modified = git(['diff', '--no-ext-diff', '--name-only', '--', 'archive/'])
    .split('\n')
    .filter((line) => line.trim() !== '')
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'archive/'])
    .split('\n')
    .filter((line) => line.trim() !== '')
  return [
    ...modified.map((p) => `UNSTAGED  ${p}  (edited in the working tree; the next \`git add\` commits it)`),
    ...untracked.map((p) => `UNTRACKED ${p}  (present in the working tree and not in the index)`),
  ]
}

function manifestEntries(file) {
  if (!existsSync(file)) {
    fail(
      `the manifest ${file} is missing. It is the only record of what archive/ is supposed to contain, `
      + 'and its absence cannot be read as "nothing to check" — regenerate it deliberately with '
      + '`node scripts/check-archive-sealed.mjs --write` and review the diff.',
    )
  }
  const entries = new Map()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const [path, mode, sha] = line.split('\t')
    if (!path || !mode || !sha) fail(`could not parse manifest line: ${line}`)
    entries.set(path, `${mode} ${sha}`)
  }
  return entries
}

const SUBJECT = EXPLICIT_REF === null ? 'the index and working tree' : `ref ${EXPLICIT_REF}`

function subjectEntries() {
  return EXPLICIT_REF === null ? indexEntries() : treeEntries(EXPLICIT_REF)
}

if (process.argv.includes('--write')) {
  const subject = subjectEntries()
  if (subject.size === 0) fail(`refusing to write a manifest for an EMPTY archive/ at ${SUBJECT}`)
  const lines = [...subject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, meta]) => {
      const [mode, sha] = meta.split(' ')
      return `${path}\t${mode}\t${sha}`
    })
  process.stdout.write(
    '# archive/ is sealed: every path and blob below must match the tree exactly (o3d-bddq).\n'
    + '# Regenerate ONLY as a deliberate act, and review the diff — a rename heuristic can change\n'
    + '# archive/ with no conflict marker, and no other gate in this repository can see it.\n'
    + `${lines.join('\n')}\n`,
  )
  process.exit(0)
}

const subject = subjectEntries()
const manifest = manifestEntries(MANIFEST)

if (manifest.size === 0) {
  fail(`the manifest ${MANIFEST} lists no paths. An empty manifest would pass for any tree.`)
}
if (subject.size === 0) {
  fail(
    `archive/ is EMPTY at ${SUBJECT} while the manifest lists ${manifest.size} paths. `
    + 'The archive is not optional: it is the only copy of the retired connectors.',
  )
}

const problems = []
for (const [path, meta] of manifest) {
  if (!subject.has(path)) {
    problems.push(`REMOVED   ${path}`)
  } else if (subject.get(path) !== meta) {
    problems.push(`CHANGED   ${path}  (manifest ${meta}, ${SUBJECT} ${subject.get(path)})`)
  }
}
for (const path of subject.keys()) {
  if (!manifest.has(path)) problems.push(`ADDED     ${path}`)
}
// Only meaningful when the subject IS the working tree; a ref has no unstaged state.
if (EXPLICIT_REF === null) problems.push(...worktreeDeviations())

if (problems.length > 0) {
  console.error(
    `archive seal: ${problems.length} path(s) under archive/ do not match ${MANIFEST}:\n`
    + problems.map((p) => `  ${p}`).join('\n')
    + '\n\nIf a MERGE put them there, that is the o3d-bddq hazard: git rename detection can merge a\n'
    + 'branch\'s edits into an archived file with no conflict marker, and nothing else in this\n'
    + 'repository can see it. Restore the paths to their archived state:\n'
    + '    git checkout <the sealing commit> -- archive/\n'
    + 'and then decide whether the change you made needs to exist on the LIVE side at all.\n'
    + 'If you are deliberately archiving or unarchiving code, regenerate the manifest with\n'
    + '    node scripts/check-archive-sealed.mjs --write > scripts/archive-sealed-manifest.tsv\n'
    + 'and let the reviewer see that diff.',
  )
  process.exit(1)
}

console.log(`archive seal: ${subject.size} archived path(s) match ${MANIFEST} exactly at ${SUBJECT}.`)
