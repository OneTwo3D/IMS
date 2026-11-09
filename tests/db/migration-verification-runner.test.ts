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
  } finally {
    await db.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${name}`
    await db.$executeRaw`DELETE FROM _prisma_migrations WHERE migration_name = ${name}`
    rmSync(dir, { recursive: true, force: true })
  }
})
