#!/usr/bin/env node
// =============================================================================
// Post-migration verification hook — run a migration's own checks, don't read them.
// =============================================================================
// A migration that needs the predecessor stopped usually also knows how to tell
// whether it was. Until now those queries lived in the migration's comment block,
// numbered and explained and never executed: two separate branches (o3d-2sm1 and
// o3d-xnwu r8) each wrote "the cutover fails unless both of these return zero" into
// a file that nothing runs. This is where they get run.
//
// HOW A MIGRATION DECLARES A CHECK
//
//   prisma/migrations/<migration_name>/verify.sql
//
// Prisma reads only `migration.sql` from a migration directory, so this file is
// invisible to `prisma migrate deploy` and carries no checksum risk.
//
// THE CONTRACT
//
//   * The file contains one or more SQL statements. Every statement must return
//     EXACTLY ONE ROW with EXACTLY the columns `check_name` (text) and `violations`
//     (an integer count).
//   * Every `violations` must be 0. Anything else fails the deploy.
//   * The checks are read-only. They run with nothing serving, after the schema has
//     moved and BEFORE the new build is started, so they cannot depend on the new
//     code having run.
//   * They must stay true afterwards, because they run on every subsequent deploy
//     too. A check that is only meaningful for one cutover ("did the old binary
//     write rows during the window") is exactly the right shape: it returns zero for
//     ever after, and the day it does not, something restarted a predecessor.
//
// EXAMPLE
//
//   -- rows the predecessor created without the new discriminator
//   SELECT 'shopping_sync_logs missing recordKind' AS check_name,
//          count(*)                                AS violations
//     FROM shopping_sync_logs
//    WHERE "recordKind" IS NULL
//      AND connector = 'woocommerce';
//
// WHAT THIS CANNOT DO, stated because the branches that asked for it said so first:
// verification catches a predecessor that CREATED rows. It cannot catch one that
// OVERWROTE an already-correct row — both of o3d-xnwu's queries return zero while
// that damage stands. Stopping the writer first is the only defence against that,
// and that is deploy.sh's job, not this file's. This hook is the second line.
// =============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

export const VERIFY_FILENAME = 'verify.sql'

/**
 * Pure: given the migration directory names present on disk and the set recorded as
 * applied, decide which verification files should run.
 *
 * A verify.sql whose migration is NOT applied is reported rather than silently
 * skipped — it means `prisma migrate deploy` did not do what this run assumed.
 */
export function selectVerificationFiles(directoriesWithVerify, appliedMigrationNames) {
  const applied = new Set(appliedMigrationNames)
  const runnable = []
  const unapplied = []
  for (const name of [...directoriesWithVerify].sort()) {
    if (applied.has(name)) runnable.push(name)
    else unapplied.push(name)
  }
  return { runnable, unapplied }
}

/**
 * Pure: check one file's results against the contract and collect its checks.
 * `results` is what `pg` returns for a multi-statement simple query: one Result per
 * statement (pg returns a bare Result when the file holds a single statement).
 */
export function evaluateFileResults(migrationName, results) {
  const list = Array.isArray(results) ? results : [results]
  const checks = []
  const errors = []

  const meaningful = list.filter((result) => result && Array.isArray(result.rows))
  if (meaningful.length === 0) {
    errors.push(`${migrationName}/${VERIFY_FILENAME} declares no checks (no statement returned a result set).`)
    return { checks, errors }
  }

  meaningful.forEach((result, index) => {
    const position = `${migrationName}/${VERIFY_FILENAME} statement ${index + 1}`

    if (result.rows.length !== 1) {
      errors.push(`${position} returned ${result.rows.length} rows; the contract is exactly one row of (check_name, violations).`)
      return
    }

    const row = result.rows[0]
    const keys = Object.keys(row)
    if (!keys.includes('check_name') || !keys.includes('violations')) {
      errors.push(`${position} returned columns [${keys.join(', ')}]; the contract is (check_name, violations).`)
      return
    }

    const violations = Number(row.violations)
    if (!Number.isFinite(violations) || !Number.isInteger(violations) || violations < 0) {
      errors.push(`${position} returned violations=${String(row.violations)}, which is not a non-negative integer count.`)
      return
    }

    checks.push({
      migration: migrationName,
      name: String(row.check_name),
      violations,
      passed: violations === 0,
    })
  })

  return { checks, errors }
}

/** Pure: the deploy may continue only if every declared check returned zero. */
export function verdict(checks, errors) {
  const failed = checks.filter((check) => !check.passed)
  return {
    ok: failed.length === 0 && errors.length === 0,
    failed,
    errors,
    total: checks.length,
  }
}

export function findMigrationsWithVerify(migrationsDir) {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(migrationsDir, name, VERIFY_FILENAME)))
    .sort()
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const migrationsDir = process.env.PRISMA_MIGRATIONS_DIR ?? 'prisma/migrations'
  const withVerify = findMigrationsWithVerify(migrationsDir)

  if (withVerify.length === 0) {
    console.log(`No migration declares ${VERIFY_FILENAME}; nothing to verify.`)
    return
  }

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set — cannot run the migrations\' verification checks.')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString })
  await client.connect()

  const allChecks = []
  const allErrors = []

  try {
    const applied = await client.query(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )
    const { runnable, unapplied } = selectVerificationFiles(
      withVerify,
      applied.rows.map((row) => row.migration_name),
    )

    for (const name of unapplied) {
      allErrors.push(`${name} declares ${VERIFY_FILENAME} but is not recorded as applied — the migration step did not do what this run assumed.`)
    }

    for (const name of runnable) {
      const sql = readFileSync(join(migrationsDir, name, VERIFY_FILENAME), 'utf8')
      let results
      try {
        results = await client.query(sql)
      } catch (error) {
        allErrors.push(`${name}/${VERIFY_FILENAME} failed to execute: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const evaluated = evaluateFileResults(name, results)
      allChecks.push(...evaluated.checks)
      allErrors.push(...evaluated.errors)
    }
  } finally {
    await client.end()
  }

  for (const check of allChecks) {
    const label = check.passed ? 'ok  ' : 'FAIL'
    console.log(`  [${label}] ${check.migration}: ${check.name} = ${check.violations}`)
  }

  const result = verdict(allChecks, allErrors)
  if (result.ok) {
    console.log(`All ${result.total} declared migration verification check(s) returned zero.`)
    return
  }

  console.error('\nPost-migration verification FAILED. The new build must not be started.')
  for (const failure of result.failed) {
    console.error(`  - ${failure.migration}: ${failure.name} = ${failure.violations} (expected 0)`)
  }
  for (const error of result.errors) {
    console.error(`  - ${error}`)
  }
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Migration verification hook crashed: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Treating that as a failed verification — the new build must not be started.')
    process.exit(1)
  })
}
