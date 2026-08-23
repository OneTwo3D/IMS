import assert from 'node:assert/strict'
import { test } from 'node:test'

import { join } from 'node:path'

import {
  assessCoverage,
  evaluateFileResults,
  findMigrationsWithVerify,
  listMigrationDirectories,
  parseRequiredList,
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
