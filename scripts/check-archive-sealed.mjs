#!/usr/bin/env node
// =============================================================================
// THE ARCHIVE SEAL — WHAT IT CATCHES, AND WHAT IT DOES NOT (o3d-bddq)
// =============================================================================
// WHAT THIS GUARD IS FOR, STATED AT ITS REACH AND NOT BEYOND IT.
//
// It catches an ACCIDENTAL RE-HYBRIDISATION of `archive/` — principally the silent rename-merge
// described below, and equally a stray edit, a stray file, or an unresolved conflict left inside
// `archive/`. It does NOT prevent a deliberate, committed modification of `archive/`. It cannot:
// the manifest of expected hashes lives in the same repository as the files it describes, so any
// commit that changes an archived file can change the manifest in the same breath and the seal will
// agree with itself. That is inherent to a self-hosted manifest, not a bug to be out-engineered.
//
// What this guard does about a deliberate change is make it DECLARE ITSELF: a diff that changes
// both the manifest and anything under `archive/` is REFUSED unless the commit message carries the
// trailer `Archive-Seal-Rewrite: <reason>`. That converts "silently legal" into "must be declared",
// which is the honest reachable property. It is not tamper-proofing, and the first two versions of
// this file were advertised as more than they were — which is how three rounds of review each found
// it blind in a different way.
//
// THE DEFECT IT EXISTS FOR. #698 archived the QuickBooks, Shopify and ShipHero connectors as
// RENAMES: `lib/connectors/quickbooks/... -> archive/connectors/quickbooks/...`. Any branch that had
// modified one of those files gets its hunks auto-merged INTO the archived copy by git's rename
// detection, WITH NO CONFLICT MARKER. It happened twice within a day: o3d-c08y took +5/-10 into
// archive/connectors/quickbooks/daily-sync.ts, and o3d-j625 took +178/-42 across nine files.
//
// NOTHING ELSE IN THE TOOLCHAIN CAN SEE IT. `archive/` is excluded from tsconfig, from eslint, from
// the `tests/**/*.test.ts` glob and from all four `check:*` SCAN_ROOTS, which is the whole point of
// archiving — so tsc, lint, every test tier and every other gate are blind to a hybrid by
// construction. The existing archive walk in tests/security/server-action-guard-coverage.test.ts
// checks the OPPOSITE arrow (that nothing live imports FROM archive/).
//
// AND THE OBVIOUS CHECK DOES NOT WORK. `git diff --name-only <sealing-commit>...HEAD -- archive/`
// returns ZERO LINES while nine files are hybridised, because during an in-progress merge HEAD is
// still the PRE-merge commit and the three-dot form compares against a merge base.
//
// THE SUBJECT IS EVERY PLACE THE HYBRID CAN SIT, AND EACH PROBLEM NAMES WHICH ONE.
// Round 1 of this file read only `git ls-tree HEAD`, and was blind mid-merge for exactly the reason
// above. Round 2 moved the subject to the INDEX and the working tree, and became blind to a change
// that was COMMITTED and then restored in the index — Codex reproduced it: HEAD and the index held
// different blobs and the check returned success. The answer was never "pick the right one". It is
// BOTH, compared separately, so the refusal says which subject is wrong:
//   HEAD      the committed tree (`ARCHIVE_SEAL_REF` substitutes another commit-ish for it)
//   INDEX     `git ls-files -s`, where a staged mid-merge hybrid actually sits
//   WORKTREE  `git diff` against the index — an edit the next `git add -A` would commit
//   UNTRACKED `git ls-files --others` — a file dropped into archive/ and never added
//   CONFLICT  index stages 1/2/3 — an unresolved merge inside archive/, refused on its own terms
//
// THE INVARIANT IS PINNED TO A COMMITTED MANIFEST, not to a commit and not to a diff. That holds
// during a merge, in a shallow clone, and without the sealing commit present.
//
// FAILS CLOSED, INCLUDING ON ITS OWN ABSENCE. A missing manifest, an empty manifest, an empty
// `archive/` subject, or an unresolvable HEAD is a failure, not a pass: "it printed nothing" is
// exactly how this defect travelled. The count examined is printed on success so a future reader can
// see the check had something to look at.
//
// IT RUNS UNCONDITIONALLY IN CI. `.github/workflows/archive-seal.yml` has no `paths:` filter and no
// job-level `if:`. The Production Readiness change classifier marks a diff as cheap when EVERY
// changed path matches `*.md`, `docs/*`, `.gitignore` or `CHANGELOG.md`, and skips the `validate` job
// that used to be this check's only CI home. `archive/` contains Markdown — 3 of its 50 sealed paths
// today, including the recovery instructions that assert the archive is what was archived — so a
// change to nothing but archived Markdown was classified cheap and the only gate that can see
// `archive/` did not run. Note that `paths-ignore: ["**/*.md"]` would be the same bug wearing
// different clothes here: an archived `.md` is the case that matters, so ignoring Markdown would
// re-open exactly this hole.
//
// ENVIRONMENT
//   ARCHIVE_SEAL_MANIFEST   the manifest to compare against (default scripts/archive-sealed-manifest.tsv)
//   ARCHIVE_SEAL_REF        a commit-ish to use as the COMMITTED subject instead of HEAD
//   ARCHIVE_SEAL_BASE_REF   the base for the BRANCH co-change locus (default: origin/development,
//                           then development; if neither resolves the locus is announced as NOT RUN)
//   ARCHIVE_SEAL_REWRITE=1  required by `--write`, so regenerating the manifest can never be a side
//                           effect of a routine command

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// Positional arguments only, so a flag can never be read as a ref: the first draft of this script
// took `process.argv[2]` and dutifully ran `git ls-tree -r --write`, which is the same class of
// mistake as everything else this file exists to catch.
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const DEFAULT_MANIFEST = 'scripts/archive-sealed-manifest.tsv'
const MANIFEST = process.env.ARCHIVE_SEAL_MANIFEST ?? positional[1] ?? DEFAULT_MANIFEST
const EXPLICIT_REF = process.env.ARCHIVE_SEAL_REF ?? positional[0] ?? null
const COMMITTED_REF = EXPLICIT_REF ?? 'HEAD'
const COMMITTED_SUBJECT = EXPLICIT_REF === null ? 'HEAD' : `ref ${EXPLICIT_REF}`
// The co-change locus tracks the manifest AS A TRACKED PATH. A manifest handed in as an absolute
// path (which is what the tests do) is not a repository path, so the locus watches the default.
const MANIFEST_PATH = MANIFEST.startsWith('/') ? DEFAULT_MANIFEST : MANIFEST
const REWRITE_TRAILER = /^Archive-Seal-Rewrite:[ \t]*\S/m

function fail(message) {
  console.error(`archive seal: ${message}`)
  process.exit(1)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function gitOrNull(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

function lines(out) {
  return (out ?? '').split('\n').filter((line) => line.trim() !== '')
}

function treeEntries(ref) {
  // `ls-tree -r` carries the BLOB HASH, so this compares contents and not merely which paths exist.
  const out = gitOrNull(['ls-tree', '-r', ref, '--', 'archive/'])
  if (out === null) {
    fail(
      `cannot resolve ${COMMITTED_SUBJECT} to a tree. The committed subject is not optional — a `
      + 'repository where the commit cannot be read is one where this check has not run.',
    )
  }
  const entries = new Map()
  for (const line of lines(out)) {
    // <mode> <type> <sha>\t<path>
    const [meta, path] = line.split('\t')
    const parts = (meta ?? '').split(/\s+/)
    if (parts.length < 3 || !path) fail(`could not parse ls-tree line: ${line}`)
    entries.set(path, `${parts[0]} ${parts[2]}`)
  }
  return entries
}

const CONFLICTED = new Set()

function indexEntries() {
  // `ls-files -s` carries the BLOB HASH and the STAGE, and it reads the INDEX — the one place a
  // half-merged archive/ exists before anyone commits it.
  const entries = new Map()
  for (const line of lines(git(['ls-files', '-s', '--', 'archive/']))) {
    // <mode> <sha> <stage>\t<path>
    const [meta, path] = line.split('\t')
    const parts = (meta ?? '').split(/\s+/)
    if (parts.length < 3 || !path) fail(`could not parse ls-files line: ${line}`)
    const [mode, sha, stage] = parts
    if (stage !== '0') {
      // Stages 1/2/3 are an UNRESOLVED merge conflict. There is no blob to compare and no version
      // of "resolving it" that leaves the seal intact.
      CONFLICTED.add(path)
      continue
    }
    entries.set(path, `${mode} ${sha}`)
  }
  return entries
}

function manifestEntries(file) {
  if (!existsSync(file)) {
    fail(
      `the manifest ${file} is missing. It is the only record of what archive/ is supposed to contain, `
      + 'and its absence cannot be read as "nothing to check" — regenerate it deliberately with '
      + '`ARCHIVE_SEAL_REWRITE=1 node scripts/check-archive-sealed.mjs --write` and review the diff.',
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

// -----------------------------------------------------------------------------
// --write: an EXPLICIT act, never a side effect
// -----------------------------------------------------------------------------
if (process.argv.includes('--write')) {
  if (process.env.ARCHIVE_SEAL_REWRITE !== '1') {
    fail(
      'refusing to regenerate the manifest without an explicit opt-in. Rewriting the manifest is the '
      + 'one operation that makes an archive change legal, so it must not be reachable as a side '
      + 'effect of a routine command:\n'
      + '    ARCHIVE_SEAL_REWRITE=1 node scripts/check-archive-sealed.mjs --write > '
      + `${DEFAULT_MANIFEST}\n`
      + 'and commit it with a trailer saying why:\n'
      + '    Archive-Seal-Rewrite: <what is being archived or unarchived, and why>',
    )
  }
  // The INDEX is the subject: a re-seal records what you are about to commit.
  const subject = indexEntries()
  if (CONFLICTED.size > 0) {
    fail(
      `refusing to write a manifest while ${CONFLICTED.size} path(s) under archive/ are in an `
      + 'UNRESOLVED MERGE CONFLICT. Sealing a conflicted archive would record the conflict as the '
      + 'archive.',
    )
  }
  if (subject.size === 0) fail('refusing to write a manifest for an EMPTY archive/ in the INDEX')
  const out = [...subject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, meta]) => {
      const [mode, sha] = meta.split(' ')
      return `${path}\t${mode}\t${sha}`
    })
  process.stdout.write(
    '# archive/ is sealed: every path and blob below must match the tree exactly (o3d-bddq).\n'
    + '# Regenerate ONLY as a deliberate act, and review the diff. This seal catches an ACCIDENTAL\n'
    + '# change to archive/ — a rename heuristic can make one with no conflict marker, and no other\n'
    + '# gate in this repository can see it. It does NOT prevent a deliberate committed change: a\n'
    + '# diff that touches both this file and archive/ must DECLARE itself with the commit trailer\n'
    + '#     Archive-Seal-Rewrite: <reason>\n'
    + `${out.join('\n')}\n`,
  )
  process.exit(0)
}

// -----------------------------------------------------------------------------
// The check
// -----------------------------------------------------------------------------
const manifest = manifestEntries(MANIFEST)
if (manifest.size === 0) {
  fail(`the manifest ${MANIFEST} lists no paths. An empty manifest would pass for any tree.`)
}

const committed = treeEntries(COMMITTED_REF)
const index = indexEntries()

const problems = []
const notices = []

/** Compare one blob-bearing subject against the manifest, naming the subject on every line. */
function compare(subjectName, entries) {
  if (entries.size === 0) {
    problems.push(
      `${subjectName}  archive/ is EMPTY at ${subjectName} while the manifest lists ${manifest.size} `
      + 'path(s). The archive is not optional: it is the only copy of the retired connectors.',
    )
    return
  }
  for (const [path, meta] of manifest) {
    if (!entries.has(path)) {
      problems.push(`${subjectName}  REMOVED   ${path}`)
    } else if (entries.get(path) !== meta) {
      problems.push(`${subjectName}  CHANGED   ${path}  (manifest ${meta}, ${subjectName} ${entries.get(path)})`)
    }
  }
  for (const path of entries.keys()) {
    if (!manifest.has(path)) problems.push(`${subjectName}  ADDED     ${path}`)
  }
}

compare(COMMITTED_SUBJECT, committed)
// An unresolved conflict means the index has no stage-0 blob for those paths, so comparing the index
// against the manifest would report them as REMOVED. Report the conflict instead — it is the real
// finding, and it is the event this check exists to stop.
if (CONFLICTED.size === 0) {
  compare('INDEX', index)
} else {
  for (const path of [...CONFLICTED].sort()) {
    problems.push(`CONFLICT  UNMERGED  ${path}  (index stages 1/2/3 — an UNRESOLVED MERGE CONFLICT)`)
  }
}

// The index is not the whole story: a file edited and not yet staged is still a file the next
// `git add -A` commits, and a file dropped into archive/ and never added is not in the index at all.
for (const path of lines(git(['diff', '--no-ext-diff', '--name-only', '--', 'archive/']))) {
  problems.push(`WORKTREE  MODIFIED  ${path}  (edited and not staged; the next \`git add\` commits it)`)
}
for (const path of lines(git(['ls-files', '--others', '--exclude-standard', '--', 'archive/']))) {
  problems.push(`UNTRACKED PRESENT   ${path}  (in the working tree and not in the index)`)
}

// -----------------------------------------------------------------------------
// THE CO-CHANGE LOCUS — the one thing that helps against a DELIBERATE change
// -----------------------------------------------------------------------------
// A manifest that lives in the same repository as the files it guards can always be rewritten by the
// same commit that changes them. So do not pretend to forbid it: require it to SAY SO. A diff that
// changes both the manifest and anything under archive/ is refused unless a commit message in that
// diff carries `Archive-Seal-Rewrite: <reason>`.
function touchesBoth(paths) {
  const manifestTouched = paths.includes(MANIFEST_PATH)
  const archiveTouched = paths.filter((p) => p.startsWith('archive/'))
  return manifestTouched && archiveTouched.length > 0 ? archiveTouched.sort() : null
}

function coChange(locusName, paths, messages, how) {
  const archiveTouched = touchesBoth(paths)
  if (archiveTouched === null) return
  if (REWRITE_TRAILER.test(messages)) return
  problems.push(
    `${locusName}  CO-CHANGE  ${MANIFEST_PATH} and ${archiveTouched.length} path(s) under archive/ `
    + `change in the same diff (${how}), with no \`Archive-Seal-Rewrite:\` trailer:\n`
    + archiveTouched.map((p) => `      ${p}`).join('\n'),
  )
}

// Locus 1 — the tip commit, always available.
// `-c` is the COMBINED diff: for a merge it lists only the paths that differ from EVERY parent, i.e.
// what this commit itself contributed. `--first-parent` would instead attribute everything a merge
// brought in from development to the merge — including a legitimate, trailered re-seal made there —
// and refuse it a second time on the branch that merged it.
const tipPaths = lines(gitOrNull(['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', COMMITTED_REF]))
coChange(COMMITTED_SUBJECT, tipPaths, gitOrNull(['log', '-1', '--format=%B', COMMITTED_REF]) ?? '', `the ${COMMITTED_SUBJECT} commit`)

// Locus 2 — the whole branch, which is what a pull request actually presents, and the locus that
// catches the same change split across two commits. Needs a base; a shallow clone may not have one,
// and that is ANNOUNCED rather than passed over in silence.
const BASE_CANDIDATES = process.env.ARCHIVE_SEAL_BASE_REF
  ? [process.env.ARCHIVE_SEAL_BASE_REF]
  : ['origin/development', 'development']
const base = BASE_CANDIDATES.find((ref) => gitOrNull(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) ?? null
if (base === null) {
  notices.push(
    `the BRANCH co-change locus did NOT RUN: none of ${BASE_CANDIDATES.join(', ')} resolves here, so `
    + 'there is no base to diff against. Set ARCHIVE_SEAL_BASE_REF, or fetch enough history. Only the '
    + `${COMMITTED_SUBJECT} commit was examined for a manifest/archive co-change.`,
  )
} else {
  const range = `${base}...${COMMITTED_REF}`
  const branchPaths = lines(gitOrNull(['diff', '--no-ext-diff', '--name-only', range]))
  coChange('BRANCH', branchPaths, gitOrNull(['log', '--format=%B', `${base}..${COMMITTED_REF}`]) ?? '', `git diff ${range}`)
}

for (const notice of notices) console.error(`archive seal: NOTICE: ${notice}`)

if (problems.length > 0) {
  console.error(
    `archive seal: ${problems.length} problem(s) against ${MANIFEST}:\n`
    + problems.map((p) => `  ${p}`).join('\n')
    + '\n\nEach line names the SUBJECT it was found in: HEAD (the committed tree), INDEX (staged),\n'
    + 'WORKTREE (edited, not staged), UNTRACKED, CONFLICT (an unresolved merge), or BRANCH (the whole\n'
    + 'diff against the base). A finding in HEAD only is already in history; a finding in INDEX or\n'
    + 'WORKTREE only can still be stopped.\n\n'
    + 'If a MERGE put them there, that is the o3d-bddq hazard: git rename detection can merge a\n'
    + 'branch\'s edits into an archived file with no conflict marker, and nothing else in this\n'
    + 'repository can see it. Restore the paths to their archived state:\n'
    + '    git checkout <the sealing commit> -- archive/\n'
    + 'and then decide whether the change you made needs to exist on the LIVE side at all. Do NOT\n'
    + 'resolve a conflict inside archive/: it is a sealed record, not code to merge.\n\n'
    + 'If you are DELIBERATELY archiving or unarchiving code, regenerate the manifest and say so:\n'
    + `    ARCHIVE_SEAL_REWRITE=1 node scripts/check-archive-sealed.mjs --write > ${DEFAULT_MANIFEST}\n`
    + '    git commit ... -m \'...\' -m \'Archive-Seal-Rewrite: <what and why>\'\n'
    + 'The trailer is the whole mechanism: this seal CANNOT stop a deliberate committed change, since\n'
    + 'the manifest lives beside the files it describes. It can only make that change declare itself.',
  )
  process.exit(1)
}

console.log(
  `archive seal: ${manifest.size} archived path(s) match ${MANIFEST} exactly at ${COMMITTED_SUBJECT}, `
  + `in the INDEX (${index.size}) and in the working tree.`,
)
