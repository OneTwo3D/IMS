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
//   * Every `violations` must be 0. Anything else fails the deploy — and "anything else" includes
//     a count that is NULL or is not an integer, which is an ERROR rather than a pass. See
//     `parseViolationCount`: `Number(null)` and `Number('')` are both 0, so a check aggregating
//     over an empty input used to be recorded as having passed.
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
// COVERAGE, AND WHY SILENCE IS NOT SUCCESS
//
// This hook used to exit 0 the moment no verify.sql existed anywhere, printing one
// line and executing nothing. CI and the deploy both reported success — and a hook
// that silently passes is worse than no hook, because it is believed. So:
//
//   * every run prints what ran AND what did not: how many migrations exist, how many
//     declare checks, which declarations were skipped because their migration is not
//     applied, and how many checks actually executed;
//   * a run that executed NO checks says so in a banner, and says that a zero exit
//     means nothing was checked rather than nothing was wrong;
//   * prisma/migrations/verification-required.txt names the migrations that MUST
//     declare a verify.sql. A named migration with no verify.sql is a coverage gap.
//
// Coverage gaps are FATAL under --strict and reported-but-not-fatal otherwise, and
// the split is deliberate. --strict is for CI, where a missing file is a repo-hygiene
// defect and the PR is the place to fix it. The deploy scripts run without it, because
// refusing to start a built and migrated application over a file that is absent from
// the repository would turn a documentation gap into an outage. What stops a cutover
// is a check that RAN and failed.
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
export const REQUIRED_FILENAME = 'verification-required.txt'

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
 * Pure: the violation count a statement returned, or a refusal.
 *
 * `Number(...)` was doing this job, and `Number(null)` and `Number('')` are both 0 — so a check
 * whose count came back NULL was RECORDED AS PASSING. That is the hook's original defect one level
 * in: `SUM(...)` over an empty input returns NULL, `MAX(...)` over no rows returns NULL, and a
 * scalar subquery that matched nothing returns NULL, so the counts most likely to be null are
 * exactly the ones from a check that found nothing to look at. A check that cannot fail is not a
 * check. `pg` hands back bigint as a decimal STRING, which is why a string is accepted at all — but
 * only one that is entirely digits, so 'many', '', '1.5' and NaN are refused rather than coerced.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: number, reason?: string }}
 */
export function parseViolationCount(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'NULL — a count that is null means the check produced no answer, not that it found nothing' }
  }
  if (typeof raw === 'boolean') {
    return { ok: false, reason: `${raw} — a boolean is not a count` }
  }
  if (typeof raw === 'bigint') {
    return raw < 0n
      ? { ok: false, reason: `${raw} — a count cannot be negative` }
      : { ok: true, value: Number(raw) }
  }
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0
      ? { ok: true, value: raw }
      : { ok: false, reason: `${raw} — not a non-negative integer count` }
  }
  if (typeof raw === 'string') {
    return /^\d+$/.test(raw.trim()) && raw.trim().length > 0
      ? { ok: true, value: Number(raw.trim()) }
      : { ok: false, reason: `${JSON.stringify(raw)} — not a non-negative integer count` }
  }
  return { ok: false, reason: `${String(raw)} — not a non-negative integer count` }
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

    const parsed = parseViolationCount(row.violations)
    if (!parsed.ok) {
      errors.push(`${position} returned violations=${parsed.reason}. Every check must return a non-negative integer count; a null one is an ERROR, never a pass.`)
      return
    }

    checks.push({
      migration: migrationName,
      name: String(row.check_name),
      violations: parsed.value,
      passed: parsed.value === 0,
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
  return listMigrationDirectories(migrationsDir).filter((name) =>
    existsSync(join(migrationsDir, name, VERIFY_FILENAME)),
  )
}

export function listMigrationDirectories(migrationsDir) {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Pure: the migration names a `verification-required.txt` names. Comments and blanks ignored. */
export function parseRequiredList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .sort()
}

export function readRequiredList(migrationsDir) {
  const file = join(migrationsDir, REQUIRED_FILENAME)
  if (!existsSync(file)) return []
  return parseRequiredList(readFileSync(file, 'utf8'))
}

/**
 * Pure: which required migrations declare nothing, and which required names have
 * rotted away. A name that is not on disk is reported separately from one that is on
 * disk without a verify.sql — the first is a stale list, the second is missing cover.
 */
export function assessCoverage(allMigrations, migrationsWithVerify, requiredNames) {
  const onDisk = new Set(allMigrations)
  const declared = new Set(migrationsWithVerify)
  const missing = []
  const stale = []
  for (const name of [...requiredNames].sort()) {
    if (!onDisk.has(name)) stale.push(name)
    else if (!declared.has(name)) missing.push(name)
  }
  return { required: [...requiredNames].sort(), missing, stale, satisfied: missing.length === 0 && stale.length === 0 }
}

/** What ran, what did not, and what was never declared. Printed on every run. */
function reportCoverage({ allMigrations, withVerify, coverage, strict, ran, skipped, checkCount }) {
  console.log('Post-migration verification coverage:')
  console.log(`  migrations on disk     : ${allMigrations.length}`)
  console.log(`  declaring ${VERIFY_FILENAME}   : ${withVerify.length}`)
  console.log(`  required to declare it : ${coverage.required.length}`)
  console.log(`  declarations executed  : ${ran.length}`)
  console.log(`  checks executed        : ${checkCount}`)

  for (const name of ran) console.log(`  [ran]     ${name}/${VERIFY_FILENAME}`)
  for (const name of skipped) console.log(`  [SKIPPED] ${name}/${VERIFY_FILENAME} — its migration is not recorded as applied`)
  for (const name of coverage.missing) {
    console.log(`  [MISSING] ${name} is required to declare ${VERIFY_FILENAME} and does not`)
  }
  for (const name of coverage.stale) {
    console.log(`  [STALE]   ${name} is listed in ${REQUIRED_FILENAME} but is not a migration in this tree`)
  }

  if (checkCount === 0) {
    console.log('')
    console.log('  ============================================================')
    console.log('  NOTHING WAS VERIFIED. This run executed zero checks.')
    console.log('  A zero exit here means nothing was CHECKED, not that nothing')
    console.log(`  is wrong. Declare checks in prisma/migrations/<name>/${VERIFY_FILENAME}.`)
    console.log('  ============================================================')
  }
  if (!coverage.satisfied && !strict) {
    console.log('')
    console.log(`  Coverage gaps above are reported, not fatal, outside --strict: a missing file`)
    console.log(`  in the repository must not stop a built and migrated application from starting.`)
    console.log(`  CI runs this hook with --strict, which is where they fail.`)
  }
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const strict = process.argv.includes('--strict') || process.env.IMS_VERIFY_COVERAGE_STRICT === '1'
  const migrationsDir = process.env.PRISMA_MIGRATIONS_DIR ?? 'prisma/migrations'
  const allMigrations = listMigrationDirectories(migrationsDir)
  const withVerify = findMigrationsWithVerify(migrationsDir)
  const coverage = assessCoverage(allMigrations, withVerify, readRequiredList(migrationsDir))

  if (withVerify.length === 0) {
    reportCoverage({ allMigrations, withVerify, coverage, strict, ran: [], skipped: [], checkCount: 0 })
    if (strict && !coverage.satisfied) {
      console.error('\nCoverage assertion FAILED: the migrations above are required to declare verification checks.')
      process.exitCode = 1
    }
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
  let runnable = []
  let unapplied = []

  try {
    const applied = await client.query(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )
    ;({ runnable, unapplied } = selectVerificationFiles(
      withVerify,
      applied.rows.map((row) => row.migration_name),
    ))

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

  reportCoverage({
    allMigrations,
    withVerify,
    coverage,
    strict,
    ran: runnable,
    skipped: unapplied,
    checkCount: allChecks.length,
  })

  if (strict && !coverage.satisfied) {
    allErrors.push(
      `coverage assertion: ${[...coverage.missing, ...coverage.stale].join(', ')} — see prisma/migrations/${REQUIRED_FILENAME}.`,
    )
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
