import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assessCoverage,
  evaluateFileResults,
  findMigrationsWithVerify,
  listMigrationDirectories,
  parseRequiredList,
  parseViolationCount,
  readRequiredList,
  selectVerificationFiles,
  verdict,
} from '@/scripts/run-migration-verifications.mjs'
import { summariseWriters } from '@/scripts/check-db-writers.mjs'

// o3d-2sm1.1 — the hook that lets a migration DECLARE the checks that must return
// zero before the new build starts. Both of today's migrations wrote their
// verification queries into their own comment blocks, where nothing could run them.

function result(rows: Array<Record<string, unknown>>) {
  return { rows }
}

test('a passing check is one row of (check_name, violations) equal to zero', () => {
  const evaluated = evaluateFileResults('20260822120000_shopping_sync_log_record_kind', [
    result([{ check_name: 'shopping_sync_logs missing recordKind', violations: 0 }]),
    result([{ check_name: 'parks overwritten by a hold payload', violations: '0' }]),
  ])

  assert.deepEqual(evaluated.errors, [])
  assert.equal(evaluated.checks.length, 2)
  assert.ok(evaluated.checks.every((check) => check.passed))
  assert.equal(verdict(evaluated.checks, evaluated.errors).ok, true)
})

test('a non-zero violation count fails the deploy and names the check', () => {
  const evaluated = evaluateFileResults('20260822090000_refund_reversal_staging_state', [
    result([{ check_name: 'refunds with an undecidable staging state', violations: 3 }]),
  ])

  const decision = verdict(evaluated.checks, evaluated.errors)
  assert.equal(decision.ok, false)
  assert.equal(decision.failed.length, 1)
  assert.equal(decision.failed[0].name, 'refunds with an undecidable staging state')
  assert.equal(decision.failed[0].violations, 3)
})

test('pg returns a bare result for a single-statement file', () => {
  const evaluated = evaluateFileResults('m', result([{ check_name: 'only check', violations: 0 }]))
  assert.deepEqual(evaluated.errors, [])
  assert.equal(evaluated.checks.length, 1)
})

test('a statement that breaks the contract fails loudly rather than being ignored', () => {
  const wrongColumns = evaluateFileResults('m', [result([{ count: 0 }])])
  assert.equal(wrongColumns.checks.length, 0)
  assert.match(wrongColumns.errors[0], /the contract is \(check_name, violations\)/)

  const manyRows = evaluateFileResults('m', [
    result([
      { check_name: 'a', violations: 0 },
      { check_name: 'b', violations: 0 },
    ]),
  ])
  assert.match(manyRows.errors[0], /returned 2 rows/)

  const notACount = evaluateFileResults('m', [result([{ check_name: 'a', violations: 'many' }])])
  assert.match(notACount.errors[0], /not a non-negative integer count/)

  const nothing = evaluateFileResults('m', [])
  assert.match(nothing.errors[0], /declares no checks/)
})

test('any contract error blocks the start even when every check that did run passed', () => {
  const decision = verdict(
    [{ migration: 'm', name: 'a', violations: 0, passed: true }],
    ['m/verify.sql failed to execute: relation "nope" does not exist'],
  )
  assert.equal(decision.ok, false)
})

test('a verify.sql whose migration is not applied is reported, never silently skipped', () => {
  const { runnable, unapplied } = selectVerificationFiles(
    ['20260822090000_a', '20260822120000_b'],
    ['20260822090000_a'],
  )
  assert.deepEqual(runnable, ['20260822090000_a'])
  assert.deepEqual(unapplied, ['20260822120000_b'])
})

test('quiescence means no other client backend at all — idle counts', () => {
  assert.equal(summariseWriters([]).quiescent, true)

  const busy = summariseWriters([
    {
      pid: 4242,
      application_name: '',
      usename: 'ims',
      client_addr: 'local',
      state: 'idle',
      backend_start: '2026-08-22T23:00:00',
      query: 'SELECT 1',
    },
  ])
  assert.equal(busy.quiescent, false)
  assert.equal(busy.count, 1)
  assert.match(busy.lines[0], /pid 4242/)
  assert.match(busy.lines[0], /state=idle/)
})

// ---------------------------------------------------------------------------
// o3d-2sm1.2 — the hook used to exit 0 the moment no verify.sql existed, and this
// repository contains none, so CI and the deploy both reported success having
// executed nothing. A hook that silently passes is worse than no hook, because it is
// believed. Coverage is therefore DECLARED, and an absent declaration is visible.
// ---------------------------------------------------------------------------

test('the required list ignores comments and blank lines', () => {
  assert.deepEqual(
    parseRequiredList('# why this exists\n\n  20260822090000_a  \n20260101000000_b # trailing\n'),
    ['20260101000000_b', '20260822090000_a'],
  )
  assert.deepEqual(parseRequiredList(''), [])
})

test('a required migration that declares nothing is a coverage gap, not a pass', () => {
  const coverage = assessCoverage(
    ['20260822090000_a', '20260822120000_b'],
    ['20260822120000_b'],
    ['20260822090000_a'],
  )
  assert.deepEqual(coverage.missing, ['20260822090000_a'])
  assert.deepEqual(coverage.stale, [])
  assert.equal(coverage.satisfied, false)
})

test('a required name that is not a migration at all is reported separately', () => {
  // A stale list and a missing file are different defects: one means the list rotted,
  // the other means the cover was never written. Collapsing them hides the first.
  const coverage = assessCoverage(['20260822090000_a'], ['20260822090000_a'], ['20260101000000_renamed'])
  assert.deepEqual(coverage.missing, [])
  assert.deepEqual(coverage.stale, ['20260101000000_renamed'])
  assert.equal(coverage.satisfied, false)
})

test('coverage is satisfied only when every required migration declares its checks', () => {
  const coverage = assessCoverage(['m1', 'm2'], ['m1'], ['m1'])
  assert.equal(coverage.satisfied, true)
  assert.deepEqual(coverage.missing, [])
})

test('this repository names at least one migration that must declare checks', () => {
  // The point of the assertion is that it is not vacuous. An empty required list would
  // make the coverage report a second hook that always passes — the exact shape the
  // finding condemned.
  const required = readRequiredList(join(process.cwd(), 'prisma', 'migrations'))
  assert.ok(required.length > 0, 'prisma/migrations/verification-required.txt must name the cutover-critical migrations')

  const onDisk = listMigrationDirectories(join(process.cwd(), 'prisma', 'migrations'))
  const coverage = assessCoverage(onDisk, findMigrationsWithVerify(join(process.cwd(), 'prisma', 'migrations')), required)
  assert.deepEqual(coverage.stale, [], 'every name in the required list must be a migration that exists')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.3 (Codex r2, MEDIUM) — A NULL COUNT WAS COERCED INTO A PASSING ZERO.
//
// `Number(null)` and `Number('')` are both 0, so a check whose count came back NULL was
// RECORDED AS PASSING — and the counts most likely to be null are exactly the ones from
// a check that found nothing to aggregate over (SUM/MAX over an empty input, a scalar
// subquery that matched no row). A check that cannot fail is the hook's original defect
// one level in.
// ---------------------------------------------------------------------------

test('a null or empty violation count is an ERROR, never a pass', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const parsed = parseViolationCount(raw)
    assert.equal(parsed.ok, false, `${JSON.stringify(raw)} must not parse as a count`)
  }
  assert.match(String(parseViolationCount(null).reason), /null/i)
})

test('only a non-negative integer counts, whatever its wire type', () => {
  assert.deepEqual(parseViolationCount(0), { ok: true, value: 0 })
  assert.deepEqual(parseViolationCount('7'), { ok: true, value: 7 })
  assert.deepEqual(parseViolationCount(' 7 '), { ok: true, value: 7 })
  assert.deepEqual(parseViolationCount(BigInt(12)), { ok: true, value: 12 })

  for (const raw of [-1, '-1', 1.5, '1.5', 'many', true, false, {}, Number.NaN]) {
    assert.equal(parseViolationCount(raw).ok, false, `${String(raw)} must be refused`)
  }
})

test('a check whose count is null blocks the start rather than reporting zero violations', () => {
  const evaluated = evaluateFileResults('m', [result([{ check_name: 'sum over an empty set', violations: null }])])
  assert.equal(evaluated.checks.length, 0, 'it must not be recorded as a passing check')
  assert.match(evaluated.errors[0], /never a pass/)
  assert.equal(verdict(evaluated.checks, evaluated.errors).ok, false)
})

test('the migration this repository requires to declare checks now declares them', () => {
  // The coverage file has named 20260822090000_refund_reversal_staging_state since
  // o3d-2sm1.2 and nothing satisfied it, so the CI command was red by design. A
  // mandatory gate that is intentionally failing teaches everyone to ignore it.
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations')
  const coverage = assessCoverage(
    listMigrationDirectories(migrationsDir),
    findMigrationsWithVerify(migrationsDir),
    readRequiredList(migrationsDir),
  )
  assert.deepEqual(coverage.missing, [], 'every required migration must ship a verify.sql')
  assert.deepEqual(coverage.stale, [])
  assert.equal(coverage.satisfied, true, 'node scripts/run-migration-verifications.mjs --strict must be able to pass')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// o3d-j625 r28 (Codex round 27, HIGH 2) — A MIGRATION THAT HAS BEEN APPLIED SOMEWHERE IS FOREVER.
//
// r26 removed a table by DELETING its migration. A fresh database never applies the deleted migration,
// so every tier of a fully green gate passed; a database that HAD applied it was left with a table no
// migration drops and `db:schema:drift` rejecting the extra table. The upgrade path is the one path CI
// never walks, which is why this needs a rule in the repo rather than care from the next author.
//
// `scripts/check-migration-conventions.mjs` cannot catch it: it diffs with `--diff-filter=ACMR`, which
// excludes deletions by construction. So the rule lives here.
//
// WHAT WOULD STILL PASS THESE TESTS: renaming a migration directory in the same commit that created it
// (no ref has it yet, so nothing was applied anywhere); editing the BODY of an already-shipped migration,
// which is a different defect with a different fix; and a table created and dropped by migrations that
// PRISMA never modelled in the first place. Neither test says anything about column-level changes.

/**
 * o3d-ec4c0 — THE PROTECTED SET, AS A FUNCTION, so its property can be asserted without a branch that happens to
 * add SQL.
 *
 * Trunk's migrations at the merge base, PLUS every migration a commit on this branch introduced. Both halves
 * matter and r29 is the reason the second one exists: a branch's migrations reach real databases — stage, a
 * colleague's checkout, every scratch database a review gates on — long before the branch merges, so deleting one
 * afterwards leaves a database with history the repo no longer contains.
 */
export function buildProtectedMigrationSet(input: {
  onTrunk: Iterable<string>
  introducedOnBranch: Iterable<string>
}): Set<string> {
  return new Set([...input.onTrunk, ...input.introducedOnBranch])
}

/**
 * o3d-ec4c0 r2 (adversarial review, HIGH) — THE SAME FACT, DERIVED TWICE, REQUIRED TO AGREE.
 *
 * Skipping the contribution assertion when `introducedOnBranch` is empty closed the trunk failure and opened a
 * quieter hole: an empty set means either "this branch genuinely adds no migration" OR "the git derivation
 * produced nothing because it is broken", and the skip treats both as fine. r30 treated both as failure, which is
 * what reddened trunk. Neither behaviour distinguishes them, in opposite directions.
 *
 * `onBranch \ onTrunk` is a SECOND, independent derivation of "migrations this branch added" — a set difference
 * between two `git ls-tree` reads, rather than `--diff-filter=A` over the `merge-base..HEAD` commit RANGE. The
 * two cannot both be broken by the same mistake, so requiring them to agree turns the disclosure into a check.
 *
 * ONE-DIRECTIONAL, DELIBERATELY. Returns the directories the set difference found while the commit range found
 * nothing — that combination can only mean a broken derivation. The converse is NOT asserted, because
 * `introducedOnBranch` non-empty with an empty difference is legitimate: a migration this branch added that has
 * since landed on trunk appears in the range but not in the difference. Asserting set equality would fail on an
 * ordinary up-to-date branch.
 *
 * SHALLOW CLONES ARE NOT THIS FUNCTION'S PROBLEM, and the layering is the point rather than an omission. With no
 * usable merge base `onTrunk` is empty or tiny, so the difference becomes "every migration in the repo" and this
 * check would fire with a misleading message. Its CALLER asserts `onTrunk.size > 50` FIRST, so that case is
 * reported as what it is — a checkout this test cannot reason about — before ever reaching here. Adding a second
 * guard inside this function would duplicate that precondition and give two different messages for one cause.
 */
export function branchMigrationDerivationsDisagree(input: {
  introducedOnBranch: Iterable<string>
  onBranch: Iterable<string>
  onTrunk: Iterable<string>
}): string[] {
  // The legitimate asymmetric case, and the ordinary one: the range found something. Nothing to cross-check.
  if (new Set(input.introducedOnBranch).size > 0) return []
  const onTrunk = new Set(input.onTrunk)
  return [...new Set(input.onBranch)].filter((dir) => !onTrunk.has(dir)).sort()
}

/**
 * o3d-ec4c0 — R29'S FINDING, CARRIED ON EVERY BRANCH INCLUDING TRUNK.
 *
 * The deletion check below can only show this property when the current branch happens to have added a
 * migration; on trunk, and on any branch that adds none, there is nothing to demonstrate it with. That is what
 * made r30's precondition fail everywhere. Asserted here over synthetic inputs instead, so the guarantee holds
 * wherever the suite runs.
 *
 * WHAT WOULD STILL PASS IT: any implementation that unions the two inputs, however written. It says nothing about
 * how the two inputs are DERIVED from git — that is the deletion check's job, and its `onTrunk.size > 50`
 * precondition is what keeps it honest.
 */
test('o3d-ec4c0: the protected set never collapses to trunk-only, nor to branch-only', () => {
  const onTrunk = ['20240101000000_a', '20240102000000_b']
  const introducedOnBranch = ['20260301000000_added_on_this_branch']
  const set = buildProtectedMigrationSet({ onTrunk, introducedOnBranch })

  // THE r29 PROPERTY: a migration this branch introduced is protected even though trunk has never seen it.
  assert.ok(set.has('20260301000000_added_on_this_branch'),
    'a migration introduced on this branch MUST be protected. Dropping it is r29\'s finding: the guard then '
    + 'protects only trunk, while the migration whose deletion caused the incident is the branch\'s own.')
  // ...and the trunk half is not lost in the process.
  for (const dir of onTrunk) {
    assert.ok(set.has(dir), `trunk's ${dir} must stay protected`)
  }
  assert.equal(set.size, 3, 'and nothing else is invented')

  // Each input alone still produces a protected set, so neither half is load-bearing for the other. This is the
  // case that matters on trunk, where the branch side is empty by construction.
  assert.deepEqual([...buildProtectedMigrationSet({ onTrunk, introducedOnBranch: [] })].sort(), [...onTrunk].sort(),
    'on trunk (no branch contribution) the set is exactly trunk\'s migrations — not empty, which would make the '
    + 'deletion check below inert on the one branch everybody merges into')
  assert.deepEqual(
    [...buildProtectedMigrationSet({ onTrunk: [], introducedOnBranch })],
    [...introducedOnBranch],
    'and a branch-only set is still protected, so a shallow clone with no trunk ref cannot silently protect nothing',
  )
})

/**
 * o3d-ec4c0 r2 (adversarial review, HIGH) — THE CROSS-CHECK, DRIVEN DIRECTLY.
 *
 * The consistency check can only fire for real on a branch that HAS added a migration, so on trunk — and on this
 * branch — the live test cannot demonstrate it. Same technique as `buildProtectedMigrationSet`: assert the
 * function over synthetic inputs so the guarantee holds wherever the suite runs.
 *
 * WHAT WOULD STILL PASS IT: any implementation computing the one-directional difference, however written. It says
 * nothing about `onTrunk` being correctly populated — that is the caller's `onTrunk.size > 50` precondition, and
 * deliberately not duplicated here.
 */
test('o3d-ec4c0: a broken branch-migration derivation is caught by the second derivation', () => {
  const onTrunk = ['20240101000000_a', '20240102000000_b']
  const added = '20260401000000_added_here'

  // 1. THE REGRESSION THE REVIEW IS ABOUT: the commit range found nothing, the trees disagree.
  assert.deepEqual(
    branchMigrationDerivationsDisagree({ introducedOnBranch: [], onBranch: [...onTrunk, added], onTrunk }),
    [added],
    'a migration present on HEAD and absent from the merge base, with an EMPTY commit-range derivation, must be '
    + 'reported: that combination can only mean the derivation is broken, and the skip would otherwise disable '
    + 'branch-migration protection silently',
  )

  // 2. THE TRUNK CASE, which must NOT fail — it is what reddened trunk under r30.
  assert.deepEqual(
    branchMigrationDerivationsDisagree({ introducedOnBranch: [], onBranch: onTrunk, onTrunk }),
    [],
    'both derivations empty is a branch that genuinely adds nothing, including trunk itself; this must be silent',
  )

  // 3. BOTH NON-EMPTY: ordinary branch that added a migration. Nothing to report.
  assert.deepEqual(
    branchMigrationDerivationsDisagree({ introducedOnBranch: [added], onBranch: [...onTrunk, added], onTrunk }),
    [],
    'both derivations agreeing is the ordinary case',
  )

  // 4. THE LEGITIMATE ASYMMETRY, which is why set equality is NOT asserted: a migration this branch added has
  //    since landed on trunk, so the commit range still names it while the tree difference no longer does.
  assert.deepEqual(
    branchMigrationDerivationsDisagree({
      introducedOnBranch: [added],
      onBranch: [...onTrunk, added],
      onTrunk: [...onTrunk, added],
    }),
    [],
    'a branch migration that has since landed on trunk appears in the commit range but not in the difference. '
    + 'Asserting equality of the two sets would fail on any up-to-date branch, which is why the implication is '
    + 'one-directional',
  )

  // ...and several at once are all reported, sorted, so the message names every directory the difference found.
  assert.deepEqual(
    branchMigrationDerivationsDisagree({
      introducedOnBranch: [],
      onBranch: ['20260501000000_z', ...onTrunk, '20260402000000_y'],
      onTrunk,
    }),
    ['20260402000000_y', '20260501000000_z'],
    'every directory the second derivation found is named, in a stable order',
  )
})

test('o3d-j625 r30: no migration this branch has ever had may be deleted from HEAD or the working tree', () => {
  const root = process.cwd()
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

  let base: string
  try {
    base = git(['merge-base', 'origin/development', 'HEAD'])
  } catch {
    // No trunk ref in this checkout (a shallow CI clone). Say so rather than passing quietly.
    assert.fail('PRECONDITION: origin/development must be fetched for this check to mean anything')
  }

  const dirsAt = (ref: string) => new Set(
    git(['ls-tree', '-r', '--name-only', ref, 'prisma/migrations/'])
      .split('\n')
      .filter((line) => line.endsWith('/migration.sql'))
      .map((line) => line.split('/')[2]),
  )

  /**
   * o3d-j625 r30 (Codex round 29, HIGH 2) — THE PROTECTED SET IS TRUNK'S MIGRATIONS **PLUS THIS BRANCH'S OWN**.
   *
   * r28 derived it from the merge base alone, which protects an adjacent property: it guards trunk's
   * migrations while the migration whose deletion caused the whole incident —
   * 20260926213000_accounting_hand_post_claim_revision — exists ONLY on this branch. Deleting it again, from
   * HEAD or from the working tree, passed both of r28's checks; the table scan passed too, because the later
   * DROP survives and the scan only asks whether a created table is dropped or modelled. The guard written to
   * prevent this exact failure did not prevent this exact failure.
   *
   * So a migration introduced by a commit ON THIS BRANCH is protected from the moment that commit exists. The
   * reason is the same one the whole finding rests on: a branch's migrations get applied to real databases
   * (stage, a colleague's checkout, every scratch database this issue has gated on) long before the branch
   * merges, and from then on deleting one leaves a database with history the repo no longer contains.
   *
   * WHAT THIS FORBIDS, stated plainly: renaming or removing a migration you added in an EARLIER commit on
   * this branch. That is deliberate, and the escape hatch is not a flag — it is to make the claim true. Either
   * reverse it with a LATER migration (the same advice as for trunk's), or rewrite the branch history with an
   * amend or a rebase so that no commit ever carried it. The second only works when it really was never
   * applied anywhere, which is exactly the condition under which it is safe.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════
   * THE LIMIT OF THIS GUARD, STATED (o3d-j625 r32, Codex round 31 HIGH 2 — strengthening filed as o3d-bm8es)
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════
   *
   * It protects trunk's migrations and those introduced by commits CURRENTLY REACHABLE in `merge-base..HEAD`.
   * A history rewrite — squash, amend, rebase, force-push — that removes a migration's introducing commit also
   * removes it from the protected set, and the non-empty precondition below still passes because the branch's
   * other migrations remain. Closing that needs a record outside rewriteable branch history; this guard does
   * not have one.
   *
   * Said here rather than left to be inferred, because a guard that states its own reach is worth more than one
   * that implies a reach it lacks (o3d-bddq).
   *
   * WHAT WOULD STILL PASS IT: adding a migration and deleting it again WITHOUT COMMITTING in between — no
   * commit ever had it, so nothing could have applied it from this branch; changing the BODY of a shipped
   * migration, which is a different defect with a different fix; and any change to a migration's directory
   * that keeps `migration.sql` present under the same directory name. It says nothing about column-level
   * conventions, which check-migration-conventions.mjs owns.
   */
  const introducedOnBranch = new Set(
    git(['log', '--diff-filter=A', '--name-only', '--pretty=format:', `${base}..HEAD`, '--', 'prisma/migrations/'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('/migration.sql'))
      .map((line) => line.split('/')[2]),
  )
  const onTrunk = dirsAt(base)
  const protectedDirs = buildProtectedMigrationSet({ onTrunk, introducedOnBranch })
  const onBranch = dirsAt('HEAD')

  assert.ok(onTrunk.size > 50, `PRECONDITION: the walk must actually see the trunk's migrations, saw ${onTrunk.size}`)
  // AND the branch's own must actually be in the protected set, or this test has quietly reverted to r28's.
  // Asserted as a non-empty INTERSECTION with what HEAD has, so it cannot be satisfied by a stale name.
  //
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════
  // o3d-ec4c0 — THIS PRECONDITION REDDENED TRUNK, AND THE FIX IS NOT TO DELETE IT
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════
  //
  // r30 asserted, unconditionally, that this branch contributes at least one migration to the protected set —
  // aimed at `protectedDirs` itself (r32) so that a silent collapse back to trunk-only could not pass. The aim
  // was right and the placement was wrong: `introducedOnBranch` comes from `merge-base..HEAD`, so a branch that
  // adds no migration contributes none and the PRECONDITION fails before the real deletion check ever runs. On
  // trunk the range is empty by construction, so it fails there too. The guard could only pass on the branch
  // that wrote it, which happened to add five migrations — a check whose precondition is satisfied only by its
  // author's branch is not a check.
  //
  // So the property moves OFF the current branch's contents and ONTO the code: `buildProtectedMigrationSet` is
  // asserted directly, with synthetic inputs, by the test below this one. That carries r29's finding on EVERY
  // branch — including trunk, and including branches that add no SQL, which are exactly the branches where a
  // deletion would otherwise go unnoticed. Here, where there is genuinely nothing to exercise, the assertion is
  // SKIPPED rather than failed; where the branch does add a migration it still runs, because a real example is
  // worth having when one exists.
  //
  // o3d-ec4c0 r2 (adversarial review, HIGH) — AND THE SKIP IS NOW EARNED RATHER THAN ASSUMED.
  //
  // An empty `introducedOnBranch` means either "this branch adds no migration" or "the derivation is broken", and
  // skipping on it treated both as fine — which stops protecting branch migrations the moment the derivation
  // regresses. So the same fact is derived a SECOND way, by set difference between the two `ls-tree` reads, and
  // the two must agree before the skip is allowed. Reached only after `onTrunk.size > 50` above, which is what
  // covers the shallow-clone case where the difference would be the whole repo.
  const derivationDisagreement = branchMigrationDerivationsDisagree({ introducedOnBranch, onBranch, onTrunk })
  assert.deepEqual(derivationDisagreement, [],
    'THE TWO DERIVATIONS OF "migrations this branch added" DISAGREE. `git log --diff-filter=A` over '
    + `\`${base}..HEAD\` found NOTHING, while comparing the trees directly found `
    + `${derivationDisagreement.length} migration(s) present on HEAD and absent from the merge base: `
    + `${derivationDisagreement.join(', ')}. The commit-range derivation is therefore broken, and with it the `
    + 'protection of every migration this branch added — silently, which is what this cross-check exists to stop '
    + '(o3d-ec4c0 round 2).')

  if (introducedOnBranch.size > 0) {
    const branchOwnProtected = [...introducedOnBranch].filter((dir) => onBranch.has(dir) && protectedDirs.has(dir))
    assert.ok(branchOwnProtected.length > 0,
      'this branch introduced a migration, so it must appear in the PROTECTED SET; if it does not, the set has '
      + 'collapsed back to trunk-only, which is the r29 finding')
  }

  const deleted = [...protectedDirs].filter((dir) => !onBranch.has(dir))
  assert.deepEqual(deleted, [],
    'A migration that this branch or the trunk has already committed is missing from HEAD. Deleting an applied '
    + 'migration removes nothing from a database that already ran it: `migrate deploy` then has no step that '
    + 'undoes it and drift rejects the leftover object. Restore it and add a LATER migration that reverses it, '
    + 'or rewrite history so no commit ever carried it (o3d-j625 r30).')

  // AND ON DISK, which is the check that fires BEFORE the deletion is committed. The comparison above reads
  // `git ls-tree`, so it is blind to a working tree the author has already emptied — r28's first draft passed
  // with a trunk migration moved aside, which is precisely the moment an author wants to be told.
  const missingOnDisk = [...protectedDirs].filter(
    (dir) => !existsSync(join(root, 'prisma', 'migrations', dir, 'migration.sql')),
  )
  assert.deepEqual(missingOnDisk, [],
    'A protected migration is missing from the working tree. Same rule, caught before the commit: restore it '
    + 'and reverse it with a later migration instead (o3d-j625 r30).')
})

test('o3d-j625 r28: every table a migration creates is either modelled or dropped by a later migration', () => {
  const root = process.cwd()
  const migrationsDir = join(root, 'prisma', 'migrations')
  const dirs = readdirSync(migrationsDir).filter((d: string) => /^\d{14}_/.test(d)).sort()
  assert.ok(dirs.length > 50, `PRECONDITION: the walk must reach the migrations, saw ${dirs.length}`)

  const created = new Map<string, string>()
  const dropped = new Set<string>()
  for (const dir of dirs) {
    let sql: string
    try {
      sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    } catch {
      continue
    }
    const body = sql.split('\n').filter((line: string) => !line.trimStart().startsWith('--')).join('\n')
    for (const m of body.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) created.set(m[1], dir)
    for (const m of body.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi)) dropped.add(m[1])
  }
  assert.ok(created.size > 50, `PRECONDITION: CREATE TABLE statements must be found, saw ${created.size}`)
  // o3d-ec4c0: the GENERAL form. r28 named one specific migration here, which made this precondition a hostage
  // to that directory continuing to exist — the same shape of fragility that reddened trunk one test above. What
  // it needs to know is that the DROP-parsing path is exercised at all.
  assert.ok(dropped.size > 0,
    'PRECONDITION: at least one DROP TABLE must be parsed (e.g. accounting_hand_post_claim_revisions), or this '
    + 'test is not exercising the case it exists for')

  const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8')
  const modelled = new Set<string>()
  for (const m of schema.matchAll(/@@map\("([^"]+)"\)/g)) modelled.add(m[1])
  assert.ok(modelled.size > 50, `PRECONDITION: schema.prisma @@map names must be found, saw ${modelled.size}`)

  const orphans = [...created.keys()].filter((t) => !modelled.has(t) && !dropped.has(t))
  assert.deepEqual(orphans, [],
    'These tables are created by a migration, are not in schema.prisma, and no migration drops them. Every '
    + 'database that ran the migration will fail db:schema:drift. Add a migration that drops the table '
    + '(o3d-j625 r28).')
})
