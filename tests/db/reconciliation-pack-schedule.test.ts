import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { RECONCILIATION_PACK_SCHEDULE_LOCK_KEY } from '../../lib/db/advisory-locks'
import { DEFAULT_PACK_REPORT_DIR, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants'
import { lockPackScheduleSettings } from '../../lib/reconciliation-pack/schedule-lock'
import { PACK_SCHEDULE_VENDOR_READS_SETTING, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_RECORD_ACTION } from '../../lib/reconciliation-pack/schedule-constants'
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
      verifyReport: () => ({ sequence: 3 }),
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

// --- THE SETTINGS FENCE over a real database ---
const KEYS = [PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_VENDOR_READS_SETTING]

/** Run `body` with the three rows set as given and every row and record put back afterwards. */
async function withRows(rows: Record<string, string>, body: (db: Awaited<ReturnType<typeof getDb>>) => Promise<void>) {
  const db = await getDb()
  const existing = await db.setting.findMany({ where: { key: { in: KEYS } } })
  const before = new Set((await db.activityLog.findMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION }, select: { id: true } })).map((row: { id: string }) => row.id))
  try {
    await db.setting.deleteMany({ where: { key: { in: KEYS } } })
    for (const [key, value] of Object.entries(rows)) await db.setting.create({ data: { key, value } })
    await body(db)
  } finally {
    await db.activityLog.deleteMany({ where: { action: PACK_SCHEDULE_RECORD_ACTION, id: { notIn: [...before] } } })
    await db.setting.deleteMany({ where: { key: { in: KEYS } } })
    for (const row of existing as Array<{ key: string; value: string }>) await db.setting.create({ data: { key: row.key, value: row.value } })
  }
}

/** What a writer of the job's rows does: the fence first, then its rows, in one transaction (the shape app/actions/cron.ts has). */
async function save(db: Awaited<ReturnType<typeof getDb>>, rows: Record<string, string>, hold?: Promise<void>) {
  await db.$transaction(async (raw: unknown) => {
    const tx = raw as FenceTx
    await lockPackScheduleSettings(tx)
    for (const [key, value] of Object.entries(rows)) await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    if (hold) await hold
  })
}

type FenceTx = Parameters<typeof lockPackScheduleSettings>[0] & { setting: { upsert: (a: unknown) => Promise<unknown> } }
const ENV = { PATH: '/usr/bin', DATABASE_URL: 'postgresql://secret-user:secret-pw@127.0.0.1/x', SETTINGS_ENCRYPTION_KEY: 'k'.repeat(32), ENCRYPTION_KEY: 'e'.repeat(32) }
const ran = () => ({ exitCode: 5, stdout: '', stderr: PUBLISHED, timedOut: false })

test('a disable that commits while the run waits on the rate gate is honoured: no child, SCHEDULE_DISABLED recorded', { skip }, async () => {
  await withRows({ [PACK_SCHEDULE_ENABLED_SETTING]: 'true', [PACK_SCHEDULE_PHASE_SETTING]: 'P1', [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }, async (db) => {
    const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const children: Array<{ args?: readonly string[]; env: Record<string, string> }> = []
    const run = runScheduledReconciliationPack(randomUUID(), { env: ENV, vendorGate: async () => { entered(); await gate; return true }, runChild: async (spec) => { children.push(spec); return ran() }, verifyReport: () => ({ sequence: 1 }) })
    await waiting
    await save(db, { [PACK_SCHEDULE_ENABLED_SETTING]: 'false' })
    openGate()
    const outcome = await run
    assert.equal(outcome.record.code, 'SCHEDULE_DISABLED')
    assert.equal(children.length, 0)
  })
})

test('vendor reads turned off while the run waits on the rate gate: the child runs without the flag and without the key names', { skip }, async () => {
  await withRows({ [PACK_SCHEDULE_ENABLED_SETTING]: 'true', [PACK_SCHEDULE_PHASE_SETTING]: 'P1', [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'true' }, async (db) => {
    const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const children: Array<{ args?: readonly string[]; env: Record<string, string> }> = []
    const run = runScheduledReconciliationPack(randomUUID(), { env: ENV, vendorGate: async () => { entered(); await gate; return true }, runChild: async (spec) => { children.push(spec); return ran() }, verifyReport: () => ({ sequence: 1 }) })
    await waiting
    await save(db, { [PACK_SCHEDULE_VENDOR_READS_SETTING]: 'false' })
    openGate()
    const outcome = await run
    assert.equal(children.length, 1)
    assert.deepEqual(children[0]!.args, ['--phase', 'P1'])
    assert.ok(!('SETTINGS_ENCRYPTION_KEY' in children[0]!.env) && !('ENCRYPTION_KEY' in children[0]!.env))
    assert.equal(outcome.record.vendorReads, false)
  })
})

test('a disable that commits while the run waits for the lock is honoured (the lock is taken after the first read, before the final one)', { skip }, async () => {
  await withRows({ [PACK_SCHEDULE_ENABLED_SETTING]: 'true', [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }, async (db) => {
    const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
    let openLock!: () => void
    const lockGate = new Promise<void>((resolve) => { openLock = resolve })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let children = 0
    const run = runScheduledReconciliationPack(randomUUID(), { env: ENV, acquireLock: async () => { entered(); await lockGate; return { release: async () => undefined } }, runChild: async () => { children += 1; return ran() }, verifyReport: () => ({ sequence: 1 }) })
    await waiting
    await save(db, { [PACK_SCHEDULE_ENABLED_SETTING]: 'false' })
    openLock()
    assert.equal((await run).record.code, 'SCHEDULE_DISABLED')
    assert.equal(children, 0)
  })
})

test('the fence: a save in flight holds the final read until it commits, and the read then sees the committed disable', { skip }, async () => {
  await withRows({ [PACK_SCHEDULE_ENABLED_SETTING]: 'true', [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }, async (db) => {
    const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
    let commit!: () => void
    const hold = new Promise<void>((resolve) => { commit = resolve })
    let written!: () => void
    const wrote = new Promise<void>((resolve) => { written = resolve })
    // the writer: fence, row written (uncommitted), then it waits
    const writer = db.$transaction(async (raw: unknown) => {
      const tx = raw as FenceTx
      await lockPackScheduleSettings(tx)
      await tx.setting.upsert({ where: { key: PACK_SCHEDULE_ENABLED_SETTING }, create: { key: PACK_SCHEDULE_ENABLED_SETTING, value: 'false' }, update: { value: 'false' } })
      written()
      await hold
    })
    await wrote
    let children = 0
    let finished = false
    const run = runScheduledReconciliationPack(randomUUID(), { env: ENV, runChild: async () => { children += 1; return ran() }, verifyReport: () => ({ sequence: 1 }) }).then((outcome) => { finished = true; return outcome })
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(finished, false, 'the final read is waiting for the save, not reading around it')
    commit()
    await writer
    const outcome = await run
    assert.equal(outcome.record.code, 'SCHEDULE_DISABLED')
    assert.equal(children, 0)
  })
})

test('a settings save never waits for a running child', { skip }, async () => {
  await withRows({ [PACK_SCHEDULE_ENABLED_SETTING]: 'true', [PACK_SCHEDULE_PHASE_SETTING]: 'P1' }, async (db) => {
    const { runScheduledReconciliationPack } = await import('../../lib/ops/reconciliation-pack-schedule')
    let endChild!: () => void
    const childGate = new Promise<void>((resolve) => { endChild = resolve })
    let started!: () => void
    const childStarted = new Promise<void>((resolve) => { started = resolve })
    const run = runScheduledReconciliationPack(randomUUID(), { env: ENV, runChild: async () => { started(); await childGate; return ran() }, verifyReport: () => ({ sequence: 1 }) })
    await childStarted
    const t0 = Date.now()
    await save(db, { [PACK_SCHEDULE_ENABLED_SETTING]: 'false', [PACK_SCHEDULE_PHASE_SETTING]: 'P2' })
    const took = Date.now() - t0
    console.log(`# save while the child ran: ${took} ms`)
    assert.ok(took < 3000, `the save took ${took} ms`)
    endChild()
    assert.equal((await run).record.outcome, 'published')
  })
})
