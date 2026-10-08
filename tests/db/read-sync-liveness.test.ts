import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { runReadSyncLivenessAlarm, type ReadSyncAlarmDb, type ReadSyncAlarmTx } from '../../lib/ops/read-sync-liveness-alarm'
import {
  READ_SYNC_FIRST_EVALUATED_SETTING,
  READ_SYNC_STREAM_IDS,
  readSyncAlertedSettingKey,
  XERO_TAX_RATE_LAST_SUCCESS_SETTING,
} from '../../lib/ops/read-sync-liveness-constants'
import { assembleReadSyncReport, readReadSyncInputs } from '../../lib/ops/read-sync-status'

/**
 * READ-SYNC LIVENESS AGAINST A REAL DATABASE.
 *
 * The doubles in tests/ops prove the rule. What they cannot show is the SQL: that `readReadSyncInputs`
 * asks the schema for columns and enum values that exist (the binding `stockSyncMode` filter, the
 * DISPATCH_SYNC job type, the settings keys), and that the alarm's claim-and-deliver runs against real
 * `settings` and `notifications` tables with the watchdog's own delivery (`notifyActiveAdmins`).
 * The write arm runs inside a transaction that is ROLLED BACK, ALWAYS.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/read-sync-liveness.test.ts would have been skipped in an environment that '
    + 'promised a migrated database. Fix the invocation (npm run test:db).',
  )
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb()
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

test('the reader\'s queries run against the real schema and the report names every stream', { skip }, async () => {
  const db = await getDb()
  const inputs = await readReadSyncInputs()
  const report = assembleReadSyncReport(inputs, new Date())
  const seen = new Set(report.entries.map((entry) => entry.stream))
  console.log(`precondition: real reader returned ${report.entries.length} entries over ${seen.size} streams; bindings=${inputs.bindings.length}; counts=${JSON.stringify(report.counts)}`)
  for (const id of READ_SYNC_STREAM_IDS) assert.ok(seen.has(id), `the real report ignores ${id}`)
  assert.equal(inputs.settings instanceof Map, true)
  await db.$disconnect()
})

test('the alarm fires against real tables: stamp and notification commit together, and roll back together', { skip }, async () => {
  const outcome = await withRollback(async (tx: Tx) => {
    const adminEmail = `liveness-${randomUUID()}@example.test`
    const admin = await tx.user.create({
      data: { email: adminEmail, name: 'Liveness fixture admin', role: 'ADMIN', active: true, passwordHash: 'x' },
      select: { id: true },
    })
    // The fixture world: Xero tax rates last read ten days ago; every other stream switched off, so
    // exactly one stream can alarm and the test examines exactly that.
    await tx.setting.upsert({
      where: { key: XERO_TAX_RATE_LAST_SUCCESS_SETTING },
      create: { key: XERO_TAX_RATE_LAST_SUCCESS_SETTING, value: new Date(Date.now() - 10 * 86_400_000).toISOString() },
      update: { value: new Date(Date.now() - 10 * 86_400_000).toISOString() },
    })
    await tx.setting.deleteMany({ where: { key: { in: [READ_SYNC_FIRST_EVALUATED_SETTING, readSyncAlertedSettingKey('xero-tax-rates')] } } })

    const nested: ReadSyncAlarmDb = {
      setting: tx.setting,
      // Already inside the fixture transaction: the alarm's own transaction is this one.
      $transaction: async <T>(fn: (inner: ReadSyncAlarmTx) => Promise<T>) => fn(tx as ReadSyncAlarmTx),
    }
    const { notifyActiveAdmins } = await import('../../lib/domain/wms/watchdog-sweep')
    const warnings: string[] = []
    const real = await readReadSyncInputs()
    const inputs = {
      ...real,
      settings: new Map([...real.settings, [XERO_TAX_RATE_LAST_SUCCESS_SETTING, (await tx.setting.findUnique({ where: { key: XERO_TAX_RATE_LAST_SUCCESS_SETTING } })).value as string]]),
      pluginEnabled: { woocommerce: false, mintsoft: false, xero: true },
      xeroConnected: true,
      cronEnabled: { ...real.cronEnabled, 'xero-tax-rate-drift': true, 'account-balance-snapshot': false },
    }
    const first = await runReadSyncLivenessAlarm({
      db: nested,
      now: new Date(),
      readInputs: async () => inputs,
      notifyAdmins: (inner, title, message, actionUrl) => notifyActiveAdmins(inner as never, title, message, actionUrl),
      logWarning: async (inner, entry) => {
        warnings.push(entry.description)
        await (inner as Tx).activityLog.create({ data: { entityType: 'SYNC', action: 'read_sync_stream_stale', tag: 'sync', level: 'WARNING', description: entry.description } })
      },
    })
    const mine = await tx.notification.findMany({ where: { userId: admin.id }, select: { title: true, message: true, type: true, actionUrl: true } })
    const stamp = await tx.setting.findUnique({ where: { key: readSyncAlertedSettingKey('xero-tax-rates') } })
    const second = await runReadSyncLivenessAlarm({
      db: nested,
      now: new Date(),
      readInputs: async () => inputs,
      notifyAdmins: (inner, title, message, actionUrl) => notifyActiveAdmins(inner as never, title, message, actionUrl),
      logWarning: async () => undefined,
    })
    return { first, second, mine, stamp, warnings }
  })
  console.log(`precondition: first=${JSON.stringify(outcome.first)} notifications for the fixture admin=${outcome.mine.length}`)
  assert.deepEqual(outcome.first.alerted, ['xero-tax-rates'])
  assert.equal(outcome.mine.length, 1)
  assert.equal(outcome.mine[0]!.type, 'warning')
  assert.match(outcome.mine[0]!.title, /Xero tax-rate read/)
  assert.ok(outcome.stamp, 'the dedupe stamp was written in the same transaction')
  assert.deepEqual(outcome.second.alerted, [], 'a second run over the same breach does not repeat')
  assert.equal(outcome.warnings.length, 1)

  // ROLLED BACK: nothing the fixture wrote survives.
  const db = await getDb()
  assert.equal(await db.setting.findUnique({ where: { key: readSyncAlertedSettingKey('xero-tax-rates') } }), null)
  await db.$disconnect()
})

test('the order-status sweep\'s unresolved-snapshot filters are valid against the real schema', { skip }, async () => {
  const db = await getDb()
  const { UNRESOLVED_SNAPSHOT_WHERE } = await import('../../lib/domain/wms/order-status-sweep')
  const snapshots = await db.wmsOrderStatusSnapshot.count({ where: UNRESOLVED_SNAPSHOT_WHERE })
  const orders = await db.salesOrder.count({
    where: {
      status: { notIn: ['COMPLETED', 'DELIVERED', 'CANCELLED'] },
      shoppingLinks: { some: { externalOrderNumber: { not: null } } },
      wmsOrderStatus: { is: UNRESOLVED_SNAPSHOT_WHERE },
    },
  })
  console.log(`precondition: the sweep's selection and stamp-guard queries ran on the real schema (snapshots=${snapshots}, orders=${orders})`)
  assert.ok(Number.isInteger(snapshots) && Number.isInteger(orders))
  await db.$disconnect()
})
