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
// NOTHING IN THE TOOLCHAIN CAN SEE IT. `archive/` is excluded from tsconfig, from eslint, from the
// `tests/**/*.test.ts` glob and from all four `check:*` SCAN_ROOTS, which is the whole point of
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
// SO THE INVARIANT IS PINNED TO A COMMITTED MANIFEST, not to a commit and not to a diff. Every path
// under `archive/` and its blob hash are recorded in the manifest; this check reads the tree and
// requires an exact match. That holds during a merge, in a shallow clone, and without the sealing
// commit present — and changing anything under `archive/` becomes a DELIBERATE, REVIEWABLE edit to
// the manifest rather than something a rename heuristic can do silently.
//
// FAILS CLOSED, INCLUDING ON ITS OWN ABSENCE. A missing manifest, an empty manifest, or an empty
// `archive/` tree is a failure, not a pass: "it printed nothing" is exactly how this defect
// travelled. The count examined is printed on success so a future reader can see the check had
// something to look at.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// Positional arguments only, so a flag can never be read as a ref: the first draft of this script
// took `process.argv[2]` and dutifully ran `git ls-tree -r --write`, which is the same class of
// mistake as everything else this file exists to catch.
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const MANIFEST = process.env.ARCHIVE_SEAL_MANIFEST ?? positional[1] ?? 'scripts/archive-sealed-manifest.tsv'
const REF = process.env.ARCHIVE_SEAL_REF ?? positional[0] ?? 'HEAD'

function fail(message) {
  console.error(`archive seal: ${message}`)
  process.exit(1)
}

function treeEntries(ref) {
  // `ls-tree -r` carries the BLOB HASH, so this compares contents and not merely which paths exist.
  const out = execFileSync('git', ['ls-tree', '-r', ref, '--', 'archive/'], { encoding: 'utf8' })
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

if (process.argv.includes('--write')) {
  const tree = treeEntries(REF)
  if (tree.size === 0) fail(`refusing to write a manifest for an EMPTY archive/ at ${REF}`)
  const lines = [...tree.entries()]
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

const tree = treeEntries(REF)
const manifest = manifestEntries(MANIFEST)

if (manifest.size === 0) {
  fail(`the manifest ${MANIFEST} lists no paths. An empty manifest would pass for any tree.`)
}
if (tree.size === 0) {
  fail(
    `archive/ is EMPTY at ${REF} while the manifest lists ${manifest.size} paths. `
    + 'The archive is not optional: it is the only copy of the retired connectors.',
  )
}

const problems = []
for (const [path, meta] of manifest) {
  if (!tree.has(path)) {
    problems.push(`REMOVED   ${path}`)
  } else if (tree.get(path) !== meta) {
    problems.push(`CHANGED   ${path}  (manifest ${meta}, tree ${tree.get(path)})`)
  }
}
for (const path of tree.keys()) {
  if (!manifest.has(path)) problems.push(`ADDED     ${path}`)
}

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

console.log(`archive seal: ${tree.size} archived path(s) match ${MANIFEST} exactly at ${REF}.`)
