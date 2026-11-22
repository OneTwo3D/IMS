import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-0syfq — THE REFUND DELETE'S VOID WORKER FENCES THE RETURNED STOCK, against a real PostgreSQL.
 *
 * Phase 1 (the delete request on a refund whose credit note was posted) queues the void and leaves the refund, its returned stock and its cost
 * layers in place. The worker used to void the credit note in the ledger first and then try phase 2, which refused if another order had drawn
 * on those layers meanwhile: Xero lost the credit note while IMS kept the refund. Now the worker takes the order, stock-level and cost-layer
 * locks, re-decides under them, and only then lets the void out, with phase 2 committing under the same locks.
 *
 *  - stock moved while the void waited: the ledger is never asked (the void spy is not called); refund and credit note both stand.
 *  - THE RACE: a FIFO consumer arriving while the worker is inside the ledger call is PARKED behind the worker's lock (asserted from
 *    pg_blocking_pids, never a sleep), and once released finds the returned layer gone with the refund, never half of each.
 *  - the worker's phase 2 re-reserves the order, as the server action does.
 *
 * The ledger is a spy; nothing leaves the process. Fixtures are unique per test and removed afterwards. Gated: `npm run test:concurrency`.
 */

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }), requireAuth: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }) },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
const allocationCalls: Array<{ orderId: string; options: Record<string, unknown> | undefined }> = []
let allocationAnswer: { success: boolean; error?: string; failed?: boolean; refused?: boolean } = { success: true }
mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async (orderId: string, options?: Record<string, unknown>) => { allocationCalls.push({ orderId, options }); return allocationAnswer },
  },
})

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ Prisma, PrismaClient }, { PrismaPg }, refundService, deleteService, { db: appDb }, custody, costLayers] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/domain/sales/refund-delete-service'),
    import('@/lib/db'),
    import('@/lib/domain/accounting/money-attempt-provenance'),
    import('@/lib/cost-layers'),
  ])
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 6 }) })
  return { Prisma, db, appDb, refundService, deleteService, custody: custody.stampingCustodyOnCreate, consumeFifoLayers: costLayers.consumeFifoLayers }
}
type Rig = Awaited<ReturnType<typeof openRig>>

const SETTINGS: Array<[string, string]> = [
  ['plugin_xero_enabled', 'true'],
  ['xero_sync_enabled', 'true'],
  ['xero_sync_credit_note', 'submitted'],
  ['xero_sync_cogs_reversal', 'submitted'],
  ['refund_delete_enabled', 'true'],
]

type World = { productId: string; returnsId: string; orderId: string; lineId: string; prefix: string; cleanup: () => Promise<void> }

/** A shipped order of 2 x GBP 100 whose units cost 45, with a returns warehouse (the refund-delete suite's world). */
async function buildWorld(rig: Rig): Promise<World> {
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const product = await db.product.create({ data: { sku: `RVF-${suffix}`, name: 'rvf', type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `VM${suffix.slice(0, 8)}`, name: 'rvf main' }, select: { id: true } })
  const returns = await db.warehouse.create({ data: { code: `VR${suffix.slice(0, 8)}`, name: 'rvf returns' }, select: { id: true } })
  const layer = await db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: D('2'), remainingQty: D('0'), unitCostBase: D('45') }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `RVF-${suffix.slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('200'), totalForeign: D('200'), subtotalBase: D('200'), taxBase: D('0'), totalBase: D('200'), paidAt: new Date(),
      lines: { create: [{ productId: product.id, description: 'rvf', qty: D('2'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('200'), totalBase: D('200') }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0]!.id
  await db.shipment.create({
    data: { orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(), cogsBatchAmount: D('90'), lines: { create: [{ lineId, productId: product.id, qty: D('2'), costLayerSnapshot: [{ costLayerId: layer.id, qty: '2', unitCostBase: '45' }] }] } },
  })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  return {
    productId: product.id, returnsId: returns.id, orderId: order.id, lineId, prefix: `VF${suffix.slice(0, 6)}-`,
    cleanup: async () => {
      const oid = order.id
      const refundIds = (await db.salesOrderRefund.findMany({ where: { orderId: oid }, select: { id: true } })).map((r) => r.id)
      await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: { in: refundIds } }, { referenceId: oid }] } }).catch(() => {})
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: refundIds } } }).catch(() => {})
      await db.integrationOutbox.deleteMany({ where: { payloadJson: { path: ['orderId'], equals: oid } } }).catch(() => {})
      await db.cogsSubledgerMovement.deleteMany({ where: { sourceRef: { in: refundIds } } }).catch(() => {})
      await db.activityLog.deleteMany({ where: { entityId: oid } }).catch(() => {})
      await db.wmsOperatorTask.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderRefundDeletion.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: oid } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId: oid } } }).catch(() => {})
      await db.shipment.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.orderAllocation.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: oid } }).catch(() => {})
      await db.cogsEntry.deleteMany({ where: { costLayer: { productId: product.id } } }).catch(() => {})
      await db.stockMovement.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.costLayer.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.stockLevel.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.warehouse.deleteMany({ where: { id: { in: [main.id, returns.id] } } }).catch(() => {})
      await db.product.delete({ where: { id: product.id } }).catch(() => {})
    },
  }
}

/** A refund returning one unit to the returns warehouse, its credit note posted in the ledger, and phase 1 of its delete (the queued void). */
async function refundWithQueuedVoid(rig: Rig, w: World): Promise<{ refundId: string; voidRowId: string }> {
  const refund = await rig.refundService.createSalesOrderRefund(rig.db, {
    orderId: w.orderId, lines: [{ lineId: w.lineId, productId: w.productId, description: 'rvf', qty: 1, totalBase: 100 }],
    reason: 'Customer return', returnWarehouseId: w.returnsId, creditNotePrefix: w.prefix,
  })
  assert.equal(refund.success, true, refund.success ? '' : refund.error)
  const refundId = refund.success ? refund.createdRefund.id : ''
  const ledgerId = `LEDGER-CN-${randomUUID()}`
  const cn = await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId }, select: { creditNoteNumber: true } })
  await rig.db.accountingSyncLog.create({
    data: { type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: refundId, externalTransactionId: ledgerId, payload: { date: new Date().toISOString().slice(0, 10), creditNoteNumber: cn.creditNoteNumber }, ...rig.custody() },
  })
  await rig.db.salesOrderRefund.update({ where: { id: refundId }, data: { accountingCreditNoteId: ledgerId, accountingCreditNoteConnector: 'xero' } })
  // The refund's own COGS reversal is not modelled here (no row): the delete has nothing to retire or counter for it.
  const phase1 = await rig.deleteService.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: 'recorded in error' })
  assert.ok(phase1.success && phase1.pending, JSON.stringify(phase1))
  const voidRow = await rig.db.accountingSyncLog.findFirstOrThrow({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId }, select: { id: true } })
  return { refundId, voidRowId: voidRow.id }
}

/** A fake ledger holding one credit note. `voidInLedger` reads it first, as voidCreditNote does: already voided is a success without a write. */
function fakeLedger(over: { onVoid?: (state: { status: string; writes: number }) => Promise<void> } = {}) {
  const state = { status: 'AUTHORISED', writes: 0, reads: 0, voidCalls: 0, bounds: [] as number[] }
  const ledger = {
    voidInLedger: async (bounded: { timeoutMs: number }) => {
      state.voidCalls++
      state.bounds.push(bounded.timeoutMs)
      if (state.status === 'VOIDED') return { success: true }
      state.status = 'VOIDED'
      state.writes++
      if (over.onVoid) await over.onVoid(state)
      return { success: true }
    },
    readCreditNoteStatus: async () => { state.reads++; return state.status },
  }
  return { state, ledger }
}
const spyLedger = (fn: () => Promise<{ success: boolean; error?: string }>) => ({ voidInLedger: async () => fn(), readCreditNoteStatus: async () => 'AUTHORISED' })

const returnsStock = async (rig: Rig, w: World) => Number((await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })).quantity)

test('STOCK MOVED WHILE THE VOID WAITED: re-decided under the locks, the ledger is never asked; the refund, its stock and its credit note all stand', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    // Another order drew the returned unit (as a FIFO consumption leaves it: the layer used, the stock gone).
    const layer = await rig.db.costLayer.findFirstOrThrow({ where: { productId: w.productId, warehouseId: w.returnsId } })
    await rig.db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 0 } })
    await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: 0 } })
    let voidCalls = 0
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { voidCalls++; return { success: true } }))
    assert.equal(voidCalls, 0, 'the void never reached the ledger')
    assert.ok(!result.ok && result.voided === false, JSON.stringify(result))
    assert.match(result.ok ? '' : result.error, /not voided/)
    const refund = await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId }, select: { deletedAt: true } })
    assert.equal(refund.deletedAt, null, 'IMS keeps the refund, as the ledger keeps its credit note')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 0)

    // The switch turned off after the request: the same answer (before, the void went out and phase 2 then refused).
    await rig.db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 1 } })
    await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: 1 } })
    await rig.db.setting.update({ where: { key: 'refund_delete_enabled' }, data: { value: 'false' } })
    const off = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { voidCalls++; return { success: true } }))
    assert.equal(voidCalls, 0)
    assert.ok(!off.ok && off.voided === false)
    await rig.db.setting.update({ where: { key: 'refund_delete_enabled' }, data: { value: 'true' } })

    // Cleared: the void goes out once and phase 2 commits with it.
    const done = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { voidCalls++; return { success: true } }))
    assert.ok(done.ok, JSON.stringify(done))
    assert.equal(voidCalls, 1)
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 1)
    assert.equal(await returnsStock(rig, w), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('THE RACE: a FIFO consumer arriving while the worker is inside the ledger void is parked behind the worker\'s lock, then finds the returned layer gone with the refund', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    let reached!: () => void
    const insideVoid = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let voidCalls = 0
    const worker = rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => {
      voidCalls++
      reached()
      await gate // the ledger call in flight
      return { success: true }
    }))
    await insideVoid

    // Another order's despatch: the stock level lock, then FIFO over the returns warehouse.
    let consumerPid!: (pid: number) => void
    const pidKnown = new Promise<number>((resolve) => { consumerPid = resolve })
    const consumer = rig.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
      consumerPid(Number(rows[0]!.pid))
      await tx.$queryRaw`SELECT id FROM stock_levels WHERE "productId" = ${w.productId} AND "warehouseId" = ${w.returnsId} FOR UPDATE`
      const level = await tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, select: { quantity: true } })
      const fifo = await rig.consumeFifoLayers(tx as never, w.productId, w.returnsId, 1)
      return { quantityUnderLock: Number(level.quantity), consumed: fifo.consumed.length }
    }, { timeout: 25_000, maxWait: 10_000 })

    // THE BARRIER, asserted: the consumer is blocked (by the worker's transaction) on the stock level row while the void is in flight.
    const pid = await pidKnown
    const deadline = Date.now() + 10_000
    let blockedBy: number[] = []
    let waitingQuery = ''
    while (Date.now() < deadline) {
      const rows = await rig.appDb.$queryRaw<Array<{ blockers: number[]; query: string; wait: string | null }>>`
        SELECT pg_blocking_pids(${pid}::int) AS blockers, a.query AS query, a.wait_event_type AS wait FROM pg_stat_activity a WHERE a.pid = ${pid}::int`
      blockedBy = rows[0]?.blockers ?? []
      waitingQuery = String(rows[0]?.query ?? '')
      if (blockedBy.length > 0 && rows[0]?.wait === 'Lock') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blockedBy.length > 0, `the consumer must be parked behind the worker while the void is in flight (last statement: ${waitingQuery.slice(0, 120)})`)
    assert.match(waitingQuery, /stock_levels/i)

    release()
    const result = await worker
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(voidCalls, 1)
    const seen = await consumer
    assert.deepEqual(seen, { quantityUnderLock: 0, consumed: 0 }, 'the consumer ran after phase 2: no returned unit and no return layer left to draw')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 1, 'the refund was deleted with the void')
    assert.equal(await rig.db.costLayer.count({ where: { productId: w.productId, warehouseId: w.returnsId } }), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('THE WORKER RE-RESERVES THE ORDER after phase 2, as the server action does; a failed re-reservation is reported, the delete stands', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    await rig.db.salesOrder.update({ where: { id: w.orderId }, data: { status: 'PROCESSING' } })
    allocationCalls.length = 0
    allocationAnswer = { success: false, failed: true, error: 'stock is short' }
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => ({ success: true })))
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(allocationCalls.length, 1, 'the order was re-reserved once')
    assert.equal(allocationCalls[0]!.orderId, w.orderId)
    assert.equal(allocationCalls[0]!.options?.refuseIfShipmentsExist, true)
    assert.deepEqual(allocationCalls[0]!.options?.requireStatusUnderLock, ['PROCESSING', 'ALLOCATED'])
    assert.match(String(result.ok && result.reallocationWarning), /could not be re-reserved automatically \(stock is short\)/)
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 1, 'the committed delete is not undone by the follow-up')

    // A retry of the entry finds the refund deleted: nothing is sent and nothing is re-reserved twice.
    const again = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => ({ success: true })))
    assert.ok(again.ok && again.alreadyDeleted)
    assert.equal(allocationCalls.length, 1)
  } finally {
    allocationAnswer = { success: true }
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('REVIEW HIGH-1 THE DEADLINE: with too little of the transaction left for the bounded void, it is not started; nothing reaches the ledger and IMS is unchanged', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const { state, ledger } = fakeLedger()
    const t0 = Date.now()
    let reads = 0
    // The lock waits took 60 s of the 90 s: 30 s left, below the void's worst case.
    const clock = () => (reads++ === 0 ? t0 : t0 + 60_000)
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null, clock }, ledger)
    assert.ok(!result.ok && result.voided === false, JSON.stringify(result))
    assert.match(result.ok ? '' : result.error, /void was not started/)
    assert.equal(state.voidCalls, 0, 'the void was never started')
    assert.equal(state.status, 'AUTHORISED')
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null, 'the unwind rolled back with the refusal')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 0)
    assert.equal(await returnsStock(rig, w), 1)
    // With the time, the same entry completes, and the void went out bounded.
    const done = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(done.ok, JSON.stringify(done))
    assert.deepEqual(state.bounds, [rig.deleteService.REFUND_DELETE_VOID_CALL_TIMEOUT_MS])
    assert.ok(rig.deleteService.REFUND_DELETE_VOID_WORST_CASE_MS < rig.deleteService.REFUND_DELETE_VOID_TX_TIMEOUT_MS)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('REVIEW HIGH-2 THE UNWIND FIRST: phase 2 refusing (the COGS reversal counter-journal declined, the type switched off since phase 1) means the void is never called', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    // A POSTED COGS reversal: the unwind must queue its counter-journal, and the type is now switched off.
    await rig.db.accountingSyncLog.create({
      data: {
        type: 'COGS_REVERSAL', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: refundId, externalTransactionId: `LEDGER-J-${randomUUID()}`,
        payload: { date: new Date().toISOString().slice(0, 10), _cogsReversalBase: 45, lines: [{ accountCode: '1200', description: 'COGS reversal', debit: 45 }, { accountCode: '5000', description: 'COGS reversal', credit: 45 }] }, ...rig.custody(),
      },
    })
    await rig.db.setting.update({ where: { key: 'xero_sync_cogs_reversal' }, data: { value: 'off' } })
    const { state, ledger } = fakeLedger()
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(!result.ok && result.voided === false, JSON.stringify(result))
    assert.equal(state.voidCalls, 0, 'the void was never called: the unwind refused first')
    assert.equal(state.status, 'AUTHORISED', 'Xero keeps the credit note')
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null)
    assert.equal(await returnsStock(rig, w), 1, 'the unwind\'s stock writes rolled back')
    assert.equal(await rig.db.costLayer.count({ where: { productId: w.productId, warehouseId: w.returnsId } }), 1)
  } finally {
    await rig.db.setting.update({ where: { key: 'xero_sync_cogs_reversal' }, data: { value: 'submitted' } }).catch(() => {})
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('REVIEW HIGH-1 (c) A CRASH AFTER XERO\'S 200, BEFORE THE COMMIT: reported as unknown (never "not voided"); the retry reads VOIDED and completes the unwind', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const crash = fakeLedger({ onVoid: async () => { throw new Error('the process died after Xero answered 200') } })
    const lost = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
    assert.ok(!lost.ok, JSON.stringify(lost))
    assert.notEqual(lost.ok ? null : lost.voided, false, 'a void that may have reached Xero is never reported as not voided')
    assert.equal(crash.state.status, 'VOIDED', 'Xero did void it')
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null, 'nothing committed in IMS')
    // The processor records the failed attempt, then retries the entry against the same ledger.
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: { increment: 1 } } })
    const retried = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
    assert.ok(retried.ok, JSON.stringify(retried))
    assert.equal(crash.state.writes, 1, 'the retry found it voided and wrote nothing to Xero')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 1)
    assert.equal(await returnsStock(rig, w), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('REVIEW HIGH-1 (c) VOIDED IN XERO, THE UNWIND REFUSES: the retry reads Xero, raises the operator task "voided in Xero, IMS refund stands" once, and never says "not voided"', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const crash = fakeLedger({ onVoid: async () => { throw new Error('the process died after Xero answered 200') } })
    await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: { increment: 1 } } })
    // Before the retry, another order drew the returned unit: the unwind now refuses under the locks.
    const layer = await rig.db.costLayer.findFirstOrThrow({ where: { productId: w.productId, warehouseId: w.returnsId } })
    await rig.db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 0 } })
    await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: 0 } })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
      assert.ok(!result.ok && result.voided === true, JSON.stringify(result))
      assert.match(result.ok ? '' : result.error, /voided in Xero, but the IMS refund still stands/)
      assert.doesNotMatch(result.ok ? '' : result.error, /not voided/)
    }
    assert.ok(crash.state.reads >= 1, 'Xero was read before IMS said anything about the void')
    assert.equal(crash.state.writes, 1)
    const tasks = await rig.db.wmsOperatorTask.findMany({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOIDED_NOT_UNWOUND' } })
    assert.equal(tasks.length, 1, 'one task however often the entry is retried')
    assert.match(tasks[0]!.queryText, /is voided in Xero, but the IMS refund still stands/)
    assert.equal(tasks[0]!.status, 'OPEN')
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})
