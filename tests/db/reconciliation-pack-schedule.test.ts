import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { RECONCILIATION_PACK_SCHEDULE_LOCK_KEY } from '../../lib/db/advisory-locks'
import { DEFAULT_PACK_REPORT_DIR, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants'
import { PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_RECORD_ACTION } from '../../lib/reconciliation-pack/schedule-constants'
import { assertClosedRecord } from '../reconciliation-pack/schedule-helpers'

/**
 * THE SCHEDULED PACK OVER A REAL DATABASE: the real advisory lock, the real activity-log write, the real settings reader. The
 * child process is a double (a real `npm run reconcile:pack` needs a whole rig, and is covered by the command's own tests);
 * nothing here contacts a vendor, reads a crontab or opens a socket beyond the local database.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/reconciliation-pack-schedule.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

const RUN_ID = '20261023T030000Z-0123456789ab'
const dir = `${DEFAULT_PACK_REPORT_DIR}/${RUN_ID}`
const PUBLISHED = `Report: ${dir}/${PACK_REPORT_JSON}\nReport: ${dir}/${PACK_REPORT_MARKDOWN}\n`

test('two concurrent scheduled starts: one runs, one is refused; both leave exactly one closed record; the lock is released', { skip }, async () => {
  const db = await getDb()
  const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
  const settingKeys = [PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING]
  const existing = await db.setting.findMany({ where: { key: { in: settingKeys } } })
  const before = new Set((await db.activityLog.findMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION }, select: { id: true } })).map((row: { id: string }) => row.id))
  const runA = randomUUID()
  const runB = randomUUID()
  let release: () => void = () => undefined
  let first: Promise<unknown> | undefined
  try {
    await db.setting.upsert({ where: { key: PACK_SCHEDULE_ENABLED_SETTING }, create: { key: PACK_SCHEDULE_ENABLED_SETTING, value: 'true' }, update: { value: 'true' } })
    await db.setting.upsert({ where: { key: PACK_SCHEDULE_PHASE_SETTING }, create: { key: PACK_SCHEDULE_PHASE_SETTING, value: 'P1' }, update: { value: 'P1' } })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    let childRuns = 0
    const deps = {
      runChild: async () => { childRuns += 1; if (childRuns === 1) { started(); await gate }; return { exitCode: 5, stdout: '', stderr: PUBLISHED, timedOut: false } },
      readReport: () => JSON.stringify({ runId: RUN_ID, sequence: 3 }),
      env: { PATH: '/usr/bin', DATABASE_URL: 'postgresql://secret-user:secret-pw@127.0.0.1/x' },
    }
    first = runScheduledReconciliationPack(runA, deps)
    await running
    const second = await runScheduledReconciliationPack(runB, deps)
    assert.equal(second.record.code, 'ALREADY_RUNNING')
    assert.equal(second.recorded, true)
    assert.equal(childRuns, 1, 'the second start did not run the pack')
    // while the first runs, the lock is visible in pg_locks
    const held = await db.$queryRaw<Array<{ n: bigint }>>`select count(*)::bigint as n from pg_locks where locktype = 'advisory' and objid = ${RECONCILIATION_PACK_SCHEDULE_LOCK_KEY}`
    assert.equal(Number(held[0]!.n), 1)
    release()
    const firstOutcome = (await first) as Awaited<ReturnType<typeof runScheduledReconciliationPack>>
    assert.deepEqual([firstOutcome.record.outcome, firstOutcome.record.code, firstOutcome.record.sequence, firstOutcome.recorded], ['published', 'inconclusive', 3, true])
    const after = await db.$queryRaw<Array<{ n: bigint }>>`select count(*)::bigint as n from pg_locks where locktype = 'advisory' and objid = ${RECONCILIATION_PACK_SCHEDULE_LOCK_KEY}`
    assert.equal(Number(after[0]!.n), 0, 'released')

    const rows = (await db.activityLog.findMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION }, orderBy: { createdAt: 'asc' } })).filter((row: { id: string }) => !before.has(row.id))
    console.log(`# records written: ${rows.length}`)
    assert.equal(rows.length, 2)
    const byRun = new Map(rows.map((row: { metadata: unknown }) => [(row.metadata as { scheduleRunId: string }).scheduleRunId, row]))
    for (const [runId, code, level] of [[runA, 'inconclusive', 'WARNING'], [runB, 'ALREADY_RUNNING', 'INFO']] as const) {
      const row = byRun.get(runId) as { metadata: never; level: string; entityType: string; description: string } | undefined
      assert.ok(row, runId)
      assertClosedRecord(row.metadata)
      assert.equal((row.metadata as { code: string }).code, code)
      assert.equal(row.level, level)
      assert.equal(row.entityType, 'SYSTEM')
      const text = JSON.stringify(row)
      assert.ok(!text.includes('secret-pw') && !text.includes('secret-user') && !text.includes('postgresql://'), 'no credential in the record')
    }
  } finally {
    release()
    await Promise.resolve(first).catch(() => undefined)
    await db.activityLog.deleteMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION, id: { notIn: [...before] } } })
    await db.setting.deleteMany({ where: { key: { in: settingKeys } } })
    for (const row of existing as Array<{ key: string; value: string }>) await db.setting.create({ data: { key: row.key, value: row.value } })
  }
})

test('default settings in a real database: nothing set means a recorded refusal and no child', { skip }, async () => {
  const db = await getDb()
  const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
  const keys = [PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING]
  const existing = await db.setting.findMany({ where: { key: { in: keys } } })
  const before = new Set((await db.activityLog.findMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION }, select: { id: true } })).map((row: { id: string }) => row.id))
  try {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    let childRuns = 0
    const runChild = async () => { childRuns += 1; return { exitCode: 0, stdout: '', stderr: PUBLISHED, timedOut: false } }
    const off = await runScheduledReconciliationPack(randomUUID(), { runChild })
    assert.equal(off.record.code, 'SCHEDULE_DISABLED')
    await db.setting.create({ data: { key: PACK_SCHEDULE_ENABLED_SETTING, value: 'true' } })
    const noPhase = await runScheduledReconciliationPack(randomUUID(), { runChild })
    assert.equal(noPhase.record.code, 'PHASE_NOT_SET')
    assert.equal(childRuns, 0)
    const rows = (await db.activityLog.findMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION } })).filter((row: { id: string }) => !before.has(row.id))
    assert.equal(rows.length, 2)
  } finally {
    await db.activityLog.deleteMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION, id: { notIn: [...before] } } })
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of existing as Array<{ key: string; value: string }>) await db.setting.create({ data: { key: row.key, value: row.value } })
  }
})
