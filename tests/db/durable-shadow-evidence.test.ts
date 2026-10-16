import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE DURABLE SHADOW RECORD AGAINST A REAL DATABASE: RETENTION DELETES THE SYNC ROW, THE SHADOW REMAINS, THE DELETE STAYS BLOCKED.
 *
 * A shadowed Xero posting is a CANCELLED / HELD_SHADOW sync row (no ledger claim, so retention lets it expire) plus an
 * outbound_shadow_writes record (persists). A shadow does not say the document is absent from the ledger, so the order
 * hard-delete guard must still refuse once the sync row is gone. Drives the REAL enqueue, the REAL retention (purgeExpiredData)
 * and the REAL guard (findSalesOrderDeleteBlocker) and the REAL shadow-store statement (prefix and exact subject matches).
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db). Fixtures are unique per run and removed afterwards.
 *
 * Named mutations (restored from a copy, md5-verified):
 *  a  ignore-durable-shadow    findSalesOrderDeleteBlocker stops asking the shadow store: the "retention deleted the row" arm goes red
 *  b  shadow-expires-with-row  the shadow record is deleted together with the sync row: ISOLATING arm shows the guard then allows it
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/durable-shadow-evidence.test.ts would have been skipped.')
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const SETTINGS = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true']] as const
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

const STAMPS: Record<string, unknown> & Parameters<typeof import('../../lib/domain/sales/order-delete-guard.ts').findSalesOrderDeleteBlocker>[2] = {
  revenueDeferredDate: null, inventoryAllocatedDate: null, revenueDeferredBatchRef: null, inventoryAllocatedBatchRef: null,
  allocationBatchSyncLogId: null, allocationBatchPasses: null,
}

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, { createAccountingSyncLogRow }, guard, retention, record] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
    import('../../lib/domain/sales/order-delete-guard.ts'),
    import('../../lib/data-retention.ts'),
    import('../../lib/domain/outbound-shadow/record.ts'),
  ])
  return { db, createAccountingSyncLogRow, guard, retention, record }
}

async function withHold<T>(fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  try { return await fn() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

async function withSettings<T>(db: Awaited<ReturnType<typeof deps>>['db'], fn: () => Promise<T>): Promise<T> {
  const before = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } } })
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try { return await fn() } finally {
    for (const [key] of SETTINGS) {
      const prior = before.find((row: { key: string }) => row.key === key)
      if (prior) await db.setting.update({ where: { key }, data: { value: prior.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  }
}

async function blockerFor(d: Awaited<ReturnType<typeof deps>>, orderId: string, stamps = STAMPS) {
  return d.db.$transaction(async (tx: Tx) => d.guard.findSalesOrderDeleteBlocker(tx, orderId, stamps))
}

test('RETENTION deletes the shadow sync row; the shadow record remains; the order delete is STILL blocked (and is not once the record is gone)', { skip }, async (t) => {
  const d = await deps()
  const orderId = `DSE-order-${randomUUID()}`
  const otherOrderId = `DSE-other-${randomUUID()}`
  t.after(async () => {
    await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { in: [orderId, otherOrderId] } } })
    await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [orderId, otherOrderId] } } })
  })
  await withSettings(d.db, async () => {
    // The REAL sync-log primitive (the one every queued posting goes through), asked while the hold is enforced and nothing is granted.
    const outcome = await withHold(async () => {
      let created: { shadowed?: unknown } | null = null
      await d.db.$transaction(async (tx: Tx) => {
        created = await d.createAccountingSyncLogRow(tx, {
          connector: 'xero', type: 'SALES_INVOICE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: orderId,
          payload: { invoiceDate: '2026-06-01', narration: `durable shadow probe ${orderId}`, lines: [] },
        })
      }, { timeout: 60_000, maxWait: 30_000 })
      return { reason: created && (created as { shadowed?: unknown }).shadowed ? 'shadowed' : 'not-shadowed' }
    })
    assert.equal(outcome.reason, 'shadowed', 'PRECONDITION: the enqueue produced a shadow')

    const before = {
      rows: await d.db.accountingSyncLog.findMany({ where: { referenceId: orderId }, select: { id: true, status: true, settlementBasis: true } }),
      shadows: await d.db.outboundShadowWrite.count({ where: { subjectId: orderId } }),
    }
    console.log(`# before retention: sync rows=${JSON.stringify(before.rows.map((r) => [r.status, r.settlementBasis]))} shadow records=${before.shadows}`)
    assert.deepEqual(before.rows.map((r) => [r.status, r.settlementBasis]), [['CANCELLED', 'HELD_SHADOW']])
    assert.equal(before.shadows, 1)
    const whileRetained = await blockerFor(d, orderId)
    assert.equal(whileRetained?.code, 'accounting_sync_live', 'while the sync row stands it is the sync row that blocks')

    // AGE the row past the retention window and run the REAL retention.
    const old = new Date(Date.now() - 800 * 24 * 3600 * 1000)
    await d.db.accountingSyncLog.updateMany({ where: { referenceId: orderId }, data: { createdAt: old } })
    const purged = await d.retention.purgeExpiredData()
    const after = {
      rows: await d.db.accountingSyncLog.count({ where: { referenceId: orderId } }),
      shadows: await d.db.outboundShadowWrite.count({ where: { subjectId: orderId } }),
    }
    console.log(`# after retention (syncLogsDeleted=${purged.syncLogsDeleted}): sync rows=${after.rows} shadow records=${after.shadows}`)
    assert.equal(after.rows, 0, 'PRECONDITION: retention deleted the shadow sync row (a shadow holds no ledger claim)')
    assert.equal(after.shadows, 1, 'PRECONDITION: the shadow record survived')

    const blocked = await blockerFor(d, orderId)
    console.log(`# guard after retention: ${blocked?.code}`)
    assert.equal(blocked?.code, 'accounting_shadow_recorded', 'the durable record still blocks the irreversible delete')
    assert.match(blocked!.message, /UNPROVEN/)
    assert.equal(await blockerFor(d, otherOrderId), null, 'ISOLATING: an order with no shadow is deletable by the same guard')

    // ISOLATING ARM: with the record gone as well, nothing blocks, so the record is what blocked above.
    await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: orderId } })
    assert.equal(await blockerFor(d, orderId), null)
  })
})

test('the shadow-store statement itself: the staged-batch PREFIX and the persisted reference match; another day and another group do not', { skip }, async (t) => {
  const d = await deps()
  const tag = randomUUID().slice(0, 8)
  const batchRef = `A2-2026-07-20-${tag}`
  t.after(() => d.db.outboundShadowWrite.deleteMany({ where: { subjectId: batchRef } }))
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'xeroom', phase: 'P1', cutoff: null, grant: 'absent' } as never
  await d.record.recordOutboundShadow(d.db, { destination: 'xero', operation: 'inventory.journals', subjectType: 'DailyBatch', subjectId: batchRef, payload: { tag }, decision })
  const staged = new Date('2026-07-20T23:15:00.000Z')
  console.log('# precondition: one DailyBatch shadow recorded')
  // persisted reference (exact)
  assert.equal((await blockerFor(d, `DSE-none-${tag}`, { ...STAMPS, inventoryAllocatedDate: staged, inventoryAllocatedBatchRef: batchRef }))?.code, 'accounting_shadow_recorded')
  // staged date only (prefix `A2-2026-07-20-`)
  assert.equal((await blockerFor(d, `DSE-none-${tag}`, { ...STAMPS, inventoryAllocatedDate: staged }))?.code, 'accounting_shadow_recorded')
  // another day: nothing
  assert.equal(await blockerFor(d, `DSE-none-${tag}`, { ...STAMPS, inventoryAllocatedDate: new Date('2026-07-19T10:00:00.000Z') }), null)
  // a different group on the same day: nothing (A1 is not A2)
  assert.equal(await blockerFor(d, `DSE-none-${tag}`, { ...STAMPS, revenueDeferredDate: staged }), null)
})
