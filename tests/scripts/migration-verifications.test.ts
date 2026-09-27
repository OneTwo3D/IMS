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

test('o3d-j625 r28: no migration that exists on the trunk has been deleted from this branch', () => {
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

  const onTrunk = dirsAt(base)
  const onBranch = dirsAt('HEAD')
  assert.ok(onTrunk.size > 50, `PRECONDITION: the walk must actually see the trunk's migrations, saw ${onTrunk.size}`)

  const deleted = [...onTrunk].filter((dir) => !onBranch.has(dir))
  assert.deepEqual(deleted, [],
    'A migration on the trunk has been deleted from this branch. Deleting an applied migration does not remove '
    + 'anything from a database that already ran it: `migrate deploy` then has no step that undoes it and drift '
    + 'rejects the leftover object. Restore it and add a LATER migration that reverses it (o3d-j625 r28).')

  // AND ON DISK, which is the check that fires BEFORE the deletion is committed. The comparison above reads
  // `git ls-tree`, so it is blind to a working tree the author has already emptied — the first draft of this
  // test passed with a trunk migration moved aside, which is precisely the moment an author wants to be told.
  const missingOnDisk = [...onTrunk].filter(
    (dir) => !existsSync(join(root, 'prisma', 'migrations', dir, 'migration.sql')),
  )
  assert.deepEqual(missingOnDisk, [],
    'A migration that exists on the trunk is missing from the working tree. Same rule, caught before the '
    + 'commit: restore it and reverse it with a later migration instead (o3d-j625 r28).')
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
  assert.ok(dropped.has('accounting_hand_post_claim_revisions'),
    'PRECONDITION: the r28 drop migration must be among those parsed, or this test is not exercising the case it exists for')

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
