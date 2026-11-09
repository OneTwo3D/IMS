import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE VERIFICATION RUNNER RECORDS AND REVOKES PASSES, END TO END AGAINST A REAL POSTGRES.
 *
 * Runs scripts/run-migration-verifications.mjs as a subprocess over a throwaway migrations directory holding one
 * probe migration (recorded as applied in _prisma_migrations for the duration of the test). The probe names are
 * unique per run and removed afterwards. What it proves:
 *
 *   all checks zero                       -> a pass is recorded
 *   a later run with a non-zero check     -> the pass is removed
 *   a later run whose verify.sql errors   -> the pass is removed
 *   a later run that breaks the contract (two rows from one statement) -> the pass is removed
 *   a required migration whose verify.sql has gone missing -> the pass is removed (no file declares checks at all)
 *   an artifact with no verification-required.txt -> a recorded pass the run did not execute is removed, the executed one is kept
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

test('the runner records a pass, and removes it when the checks fail, error or disappear', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const name = `99990101000000_runner_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'runner-probe-'))
  const migrationDir = path.join(dir, name)
  mkdirSync(migrationDir)
  const verify = path.join(migrationDir, 'verify.sql')

  function runRunner(): number {
    const result = spawnSync(process.execPath, ['scripts/run-migration-verifications.mjs'], {
      env: { ...process.env, PRISMA_MIGRATIONS_DIR: dir, IMS_VERIFY_COVERAGE_STRICT: '' },
      encoding: 'utf8',
    })
    return result.status ?? -1
  }
  async function passRows(): Promise<number> {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM migration_verification_passes WHERE migration_name = ${name}`
    return Number(rows[0]!.n)
  }

  await db.$executeRaw`
    INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
    VALUES (${randomUUID()}, 'probe', now(), ${name}, now(), 1)`
  try {
    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations;\n")
    assert.equal(runRunner(), 0)
    assert.equal(await passRows(), 1, 'all checks zero records a pass')

    writeFileSync(verify, "SELECT 'probe check' AS check_name, 1 AS violations;\n")
    assert.notEqual(runRunner(), 0)
    assert.equal(await passRows(), 0, 'a non-zero check removes the pass')

    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations;\n")
    assert.equal(runRunner(), 0)
    assert.equal(await passRows(), 1)
    writeFileSync(verify, 'SELECT * FROM a_table_that_does_not_exist;\n')
    assert.notEqual(runRunner(), 0)
    assert.equal(await passRows(), 0, 'a verify.sql that fails to run removes the pass')

    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations;\n")
    assert.equal(runRunner(), 0)
    assert.equal(await passRows(), 1)
    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations UNION ALL SELECT 'second row', 0;\n")
    assert.notEqual(runRunner(), 0)
    assert.equal(await passRows(), 0, 'a statement that breaks the one-row contract removes the pass')

    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations;\n")
    assert.equal(runRunner(), 0)
    assert.equal(await passRows(), 1)
    rmSync(verify)
    writeFileSync(path.join(dir, 'verification-required.txt'), `${name}\n`)
    runRunner()
    assert.equal(await passRows(), 0, 'a required migration whose verify.sql is missing loses its pass')

    // An artifact that lost verification-required.txt reads as "nothing required"; recorded passes this run cannot
    // match to a present, executed declaration must not stay trusted. The executed probe keeps / gets its pass.
    const stranger = `${name}_stranger`
    rmSync(path.join(dir, 'verification-required.txt'))
    writeFileSync(verify, "SELECT 'probe check' AS check_name, 0 AS violations;\n")
    await db.$executeRaw`INSERT INTO migration_verification_passes (migration_name, checks_passed) VALUES (${stranger}, 1)`
    try {
      assert.equal(runRunner(), 0)
      assert.equal(await passRows(), 1, 'the executed declaration is recorded')
      const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM migration_verification_passes WHERE migration_name = ${stranger}`
      assert.equal(Number(left[0]!.n), 0, 'a recorded pass with no present, executed declaration is revoked when the required list is absent')
    } finally {
      await db.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${stranger}`
    }
    // And the same when no declaration exists at all (the early path), with the required list absent.
    rmSync(verify)
    await db.$executeRaw`INSERT INTO migration_verification_passes (migration_name, checks_passed) VALUES (${stranger}, 1)`
    try {
      runRunner()
      const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM migration_verification_passes WHERE migration_name IN (${stranger}, ${name})`
      assert.equal(Number(left[0]!.n), 0, 'with no declaration and no required list, no recorded pass survives')
  
    // A required list that is present but EMPTY, with no verify.sql, executes zero declarations: still nothing
    // vouches for a recorded pass, so it is revoked.
    writeFileSync(path.join(dir, 'verification-required.txt'), '')
    await db.$executeRaw`INSERT INTO migration_verification_passes (migration_name, checks_passed) VALUES (${stranger}, 1)`
    try {
      runRunner()
      const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM migration_verification_passes WHERE migration_name = ${stranger}`
      assert.equal(Number(left[0]!.n), 0, 'a present but empty required list with no declarations still revokes recorded passes')
    } finally {
      await db.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${stranger}`
    }
  } finally {
      await db.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${stranger}`
    }
  } finally {
    await db.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${name}`
    await db.$executeRaw`DELETE FROM _prisma_migrations WHERE migration_name = ${name}`
    rmSync(dir, { recursive: true, force: true })
  }
})
