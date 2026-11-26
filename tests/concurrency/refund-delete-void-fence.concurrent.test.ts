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
    voidInLedger: async (bounded: { timeoutMs: number; beforePost?: () => Promise<string | null> }) => {
      state.voidCalls++
      state.bounds.push(bounded.timeoutMs)
      if (state.status === 'VOIDED') return { success: true }
      // As voidCreditNote does: the caller's check (and attempt stamp) immediately before the POST.
      const refusal = bounded.beforePost ? await bounded.beforePost() : null
      if (refusal) return { success: false, notSent: true, error: refusal }
      state.status = 'VOIDED'
      state.writes++
      if (over.onVoid) await over.onVoid(state)
      return { success: true }
    },
    readCreditNoteStatus: async () => { state.reads++; return state.status },
  }
  return { state, ledger }
}
const spyLedger = (fn: () => Promise<{ success: boolean; error?: string; notSent?: boolean }>) => ({
  voidInLedger: async (bounded: { beforePost?: () => Promise<string | null> }) => {
    const refusal = bounded.beforePost ? await bounded.beforePost() : null
    if (refusal) return { success: false, notSent: true, error: refusal }
    return fn()
  },
  readCreditNoteStatus: async () => 'AUTHORISED',
})

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

// ---------------------------------------------------------------------------------------------------------------------------
// #1132 review follow-ups (round 1 MED-2 / MED-3 / LOW-3 / round 2 R2-MED-2 / R2-LOW-4 / R2-LOW-5)
// ---------------------------------------------------------------------------------------------------------------------------

/** Model the processor's claim of the void row (PROCESSING at `claimedAt`, revision 1), as the runner leaves it before processEntry. */
async function claimVoidRow(rig: Rig, voidRowId: string): Promise<{ claimedAt: Date; attemptRevision: number }> {
  const claimedAt = new Date()
  await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { status: 'PROCESSING', processingStartedAt: claimedAt, attemptRevision: 1 } })
  return { claimedAt, attemptRevision: 1 }
}

const drawReturnedUnit = async (rig: Rig, w: World) => {
  const layer = await rig.db.costLayer.findFirstOrThrow({ where: { productId: w.productId, warehouseId: w.returnsId } })
  await rig.db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 0 } })
  await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: 0 } })
  return async () => {
    await rig.db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 1 } })
    await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: 1 } })
  }
}

test('#1132 MED-2 A CRASH AFTER PHASE 2 COMMITTED, BEFORE ITS FOLLOW-UPS: the retry finds the refund deleted and runs them from the tombstone, once', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    await rig.db.salesOrder.update({ where: { id: w.orderId }, data: { status: 'PROCESSING' } })
    // Phase 2 committed (the void confirmed), and the worker stopped there: no re-reservation, no stock push.
    const committed = await rig.deleteService.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null, voidConfirmed: { syncLogId: voidRowId } })
    assert.ok(committed.success && !committed.alreadyDeleted, JSON.stringify(committed))
    assert.equal((await rig.db.salesOrderRefundDeletion.findUniqueOrThrow({ where: { refundId } })).followUpsDoneAt, null, 'the tombstone says the follow-ups are owed')
    allocationCalls.length = 0
    allocationAnswer = { success: true }
    let voidCalls = 0
    const retried = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { voidCalls++; return { success: true } }))
    assert.ok(retried.ok && retried.alreadyDeleted && retried.followUpsRan, JSON.stringify(retried))
    assert.equal(voidCalls, 0, 'nothing more is sent for a finished delete')
    assert.equal(allocationCalls.length, 1, 'THE FIX: the order is re-reserved on the retry (before, it never was)')
    assert.equal(allocationCalls[0]!.orderId, w.orderId)
    assert.deepEqual(retried.ok ? retried.productIds : [], [w.productId], 'the stock push is rebuilt from the tombstone')
    assert.notEqual((await rig.db.salesOrderRefundDeletion.findUniqueOrThrow({ where: { refundId } })).followUpsDoneAt, null)
    const again = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { voidCalls++; return { success: true } }))
    assert.ok(again.ok && again.alreadyDeleted && !again.followUpsRan)
    assert.equal(allocationCalls.length, 1, 'once')
  } finally {
    allocationAnswer = { success: true }
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 MED-3 A REFUSAL UNDER THE LOCKS IS TERMINAL: the void row is closed CANCELLED, proven never sent, with a WARNING; a new request queues a fresh void', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const claim = await claimVoidRow(rig, voidRowId)
    const restore = await drawReturnedUnit(rig, w)
    const { state, ledger } = fakeLedger()
    const refused = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(!refused.ok && refused.voided === false && refused.refusedUnderLocks && refused.provenNeverSent === true && refused.notSent, JSON.stringify(refused))
    assert.equal(state.voidCalls, 0)
    assert.equal(state.reads, 1, 'o3d-2gv2g MED-1: Xero is read before a row is closed as never sent, whatever the row\'s facts say')
    assert.equal(refused.ok ? null : refused.ledgerStatus, 'AUTHORISED')

    // Without Xero's word, nothing is closed.
    assert.equal(await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: 'x', ledgerStatus: null }), false)
    const retired = await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: refused.ok ? '' : refused.error, ledgerStatus: refused.ok ? null : refused.ledgerStatus })
    assert.equal(retired, true)
    const row = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })
    assert.equal(row.status, 'CANCELLED')
    assert.equal(row.abandonedBeforeRemoteCall, true)
    assert.equal(row.attemptRevision, 2, 'the claim is fenced off')
    const { ledgerStanding } = await import('@/lib/domain/accounting/ledger-standing')
    assert.equal(ledgerStanding(row), 'PROVEN_NOT_POSTED')
    const warning = await rig.db.activityLog.findFirst({ where: { entityId: w.orderId, action: 'refund_delete_void_cancelled' } })
    assert.equal(warning?.level, 'WARNING')
    assert.match(String(warning?.description), /Nothing was sent to Xero/)
    // A second retirement (a replayed attempt) changes nothing.
    assert.equal(await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: 'again', ledgerStatus: 'AUTHORISED' }), false)

    // THE CLEAN RE-REQUEST: the delete no longer waits on the closed row, and asking again queues a fresh void under the same key.
    await restore()
    const evaluated = await rig.deleteService.evaluateRefundDeletion(rig.db, refundId)
    assert.equal(evaluated.plan?.voidRow, null, 'the closed row is not a void the delete waits on')
    const again = await rig.deleteService.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: 'asked again' })
    assert.ok(again.success && again.pending, JSON.stringify(again))
    const voids = await rig.db.accountingSyncLog.findMany({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId }, select: { id: true, status: true } })
    assert.equal(voids.length, 2)
    assert.ok(voids.some((v) => v.id !== voidRowId && v.status === 'PENDING'), 'a fresh void row was queued')
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 MED-3 THE PROOF: a void row an attempt stamped (it reached the POST) is never closed as never sent; the refusal reads Xero first', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    // An attempt that reached the POST and whose reply was lost: the stamp is written outside the transaction, so it survives the rollback.
    const lost = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, spyLedger(async () => { throw new Error('reply lost') }))
    assert.ok(!lost.ok && lost.voided === 'unknown' && !lost.notSent, JSON.stringify(lost))
    assert.notEqual((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).remoteAttemptedAt, null, 'the attempt was stamped before the POST')
    const claim = await claimVoidRow(rig, voidRowId)
    await drawReturnedUnit(rig, w)
    const { state, ledger } = fakeLedger()
    const refused = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(!refused.ok && refused.refusedUnderLocks && refused.provenNeverSent === false, JSON.stringify(refused))
    assert.equal(state.reads, 1, 'an attempt may have voided it: Xero is read before IMS says anything')
    assert.equal(await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: 'x', ledgerStatus: 'AUTHORISED' }), false)
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).status, 'PROCESSING', 'left for the retries')
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 R2-MED-2 THE RACE: a lock wait that runs out (another writer holds the returned stock) sends nothing and says so: notSent, not "unknown"', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const { state, ledger } = fakeLedger()
    let workerResult: Awaited<ReturnType<typeof rig.deleteService.voidCreditNoteThenCompleteRefundDeletion>> | null = null
    let parked = false
    await rig.db.$transaction(async (holder) => {
      // Another order's despatch holds the returned stock level, longer than the worker's lock_timeout.
      await holder.$queryRaw`SELECT id FROM stock_levels WHERE "productId" = ${w.productId} AND "warehouseId" = ${w.returnsId} FOR UPDATE`
      const holderPid = Number((await holder.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid)
      const worker = rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
      // THE BARRIER: the worker is observed parked behind this holder on the stock level row.
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline && !parked) {
        const rows = await rig.appDb.$queryRaw<Array<{ query: string }>>`
          SELECT a.query AS query FROM pg_stat_activity a WHERE ${holderPid}::int = ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type = 'Lock'`
        parked = rows.some((row) => /stock_levels/i.test(row.query))
        if (!parked) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      workerResult = await worker
    }, { timeout: 25_000, maxWait: 10_000 })
    assert.ok(parked, 'the worker was parked behind the holder')
    const result = workerResult as unknown as Awaited<ReturnType<typeof rig.deleteService.voidCreditNoteThenCompleteRefundDeletion>>
    assert.ok(!result.ok, JSON.stringify(result))
    assert.equal(result.ok ? null : result.notSent, true, 'THE FIX: a lock wait is a not-sent attempt (handed back, no retry spent), not an unknown outcome')
    assert.equal(result.ok ? null : result.voided, false)
    assert.match(result.ok ? '' : result.error, /was not started: a row it needs stayed locked/)
    assert.equal(state.voidCalls, 0)
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).remoteAttemptedAt, null, 'no attempt stamp: nothing was sent')
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 LOW-3 THE LOCK DATE MOVED PAST THE CREDIT NOTE\'S DAY SINCE PHASE 1: re-checked before the void is posted; refused, nothing sent, no stamp', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  const { XERO_BOOKS_LOCK_DATE_KEY } = await import('@/lib/connectors/xero/books-lock-date')
  const prior = await rig.db.setting.findUnique({ where: { key: XERO_BOOKS_LOCK_DATE_KEY } })
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await rig.db.setting.upsert({ where: { key: XERO_BOOKS_LOCK_DATE_KEY }, create: { key: XERO_BOOKS_LOCK_DATE_KEY, value: future }, update: { value: future } })
    const { state, ledger } = fakeLedger()
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(!result.ok && result.refusedUnderLocks && result.voided === false, JSON.stringify(result))
    assert.match(result.ok ? '' : result.error, /lock/i)
    assert.equal(state.writes, 0, 'THE FIX: the void was not posted into a locked period')
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).remoteAttemptedAt, null)
    assert.equal((await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt, null)
    // A credit note an earlier attempt already voided is not posted again, so the moved lock does not stop the unwind.
    state.status = 'VOIDED'
    const done = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(done.ok, JSON.stringify(done))
  } finally {
    if (prior) await rig.db.setting.update({ where: { key: XERO_BOOKS_LOCK_DATE_KEY }, data: { value: prior.value } }).catch(() => {})
    else await rig.db.setting.deleteMany({ where: { key: XERO_BOOKS_LOCK_DATE_KEY } }).catch(() => {})
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 R2-LOW-4 / R2-LOW-5: the voided-not-unwound ERROR row is written once with its task, and a later unwind closes the task', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const crash = fakeLedger({ onVoid: async () => { throw new Error('the process died after Xero answered 200') } })
    await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
    const restore = await drawReturnedUnit(rig, w)
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
      assert.ok(!result.ok && result.voided === true)
    }
    assert.equal(await rig.db.activityLog.count({ where: { entityId: w.orderId, action: 'refund_delete_voided_not_unwound' } }), 1, 'THE FIX (R2-LOW-4): one ERROR row, not one per retry')
    const task = await rig.db.wmsOperatorTask.findFirstOrThrow({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOIDED_NOT_UNWOUND' } })
    assert.equal(task.status, 'OPEN')
    // The cause is cleared; the entry is retried and the refund is deleted.
    await restore()
    const done = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, crash.ledger)
    assert.ok(done.ok && !done.alreadyDeleted, JSON.stringify(done))
    assert.equal((await rig.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: task.id } })).status, 'DONE', 'THE FIX (R2-LOW-5): the task closes with the unwind')
    const tombstone = await rig.db.salesOrderRefundDeletion.findUniqueOrThrow({ where: { refundId } })
    assert.equal((tombstone.reversal as { refundDeleteTasksClosed?: number }).refundDeleteTasksClosed, 1)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('#1132 R2-MED-2 THE PROCESSOR\'S MAPPING: not sent is a wait (no retry spent) up to its cap since the last failure; refused and proven never sent closes the row only on Xero\'s word', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  let systemRowsFor = '-'
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    systemRowsFor = voidRowId
    const processor = await import('@/lib/connectors/xero/sync-processor')
    const claim = await claimVoidRow(rig, voidRowId)
    const lease = { heldFrom: () => claim.claimedAt } as never
    const attempt = { id: voidRowId, attemptRevision: claim.attemptRevision }
    const notSent = { ok: false as const, voided: false, notSent: true as const, error: 'The credit note void was not started: a row it needs stayed locked by other work for over 5s' }
    const waited = await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt, lease, finished: notSent, refundDelete: rig.deleteService })
    assert.equal(waited.notPosted?.reason, 'refund-delete-deferred', 'a wait, handed back without spending a retry')
    assert.equal(waited.notPosted?.retryDelayMs, processor.REFUND_DELETE_DEFER_DELAY_MS)
    assert.equal(processor.handsBackUnsentWithoutAttempt('refund-delete-deferred'), true)
    assert.equal(waited.notPosted?.evidenceMetadata?.waitRetryCount, 0, 'o3d-2gv2g LOW-3: the wait records the retry count it was taken at')
    // Past the cap of waits (at the row's current retry count), it fails like anything else.
    await rig.db.activityLog.createMany({ data: Array.from({ length: processor.REFUND_DELETE_MAX_DEFERRALS }, () => ({ entityType: 'SYSTEM', entityId: voidRowId, action: 'xero_sync_refund_delete_deferred_before_post', tag: 'sync', level: 'INFO', description: 'wait', metadata: { waitRetryCount: 0 } })) })
    const capped = await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt, lease, finished: notSent, refundDelete: rig.deleteService })
    assert.equal(capped.notPosted, undefined)
    assert.equal(capped.success, false)
    // o3d-2gv2g LOW-3: once a failure has moved the retry count, the waits before it no longer count: it waits again.
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: 1 } })
    const afterFailure = await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt, lease, finished: notSent, refundDelete: rig.deleteService })
    assert.equal(afterFailure.notPosted?.reason, 'refund-delete-deferred', 'THE FIX (LOW-3): the counter counts since the last failure, not over the row\'s life')
    // o3d-2gv2g LOW-2: refundDeleteVoidFailure itself no longer raises the stuck task (from an unfenced read of the count): the fenced failure write does.
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: 4 } })
    const failure = { ok: false as const, voided: 'unknown' as const, error: 'The credit note void did not complete: HTTP 500' }
    for (let i = 0; i < 2; i++) await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt, lease, finished: failure, refundDelete: rig.deleteService })
    assert.equal(await rig.db.wmsOperatorTask.count({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOID_STUCK' } }), 0)
    // Refused under the locks and proven never sent, but no Xero read in hand: not closed (o3d-2gv2g MED-1).
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: 0 } })
    const unread = await processor.refundDeleteVoidFailure({
      entryId: voidRowId, referenceId: refundId, attempt, lease, refundDelete: rig.deleteService,
      finished: { ok: false, voided: false, notSent: true, refusedUnderLocks: true, provenNeverSent: true, error: 'The credit note was not voided: stock moved.' },
    })
    assert.notDeepEqual(unread, { success: true, skipped: true })
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).status, 'PROCESSING')
    // With Xero's word that it stands: the row is closed for good and the entry is a resolved no-op.
    const terminal = await processor.refundDeleteVoidFailure({
      entryId: voidRowId, referenceId: refundId, attempt, lease, refundDelete: rig.deleteService,
      finished: { ok: false, voided: false, notSent: true, refusedUnderLocks: true, provenNeverSent: true, ledgerStatus: 'AUTHORISED', error: 'The credit note was not voided: stock moved.' },
    })
    assert.deepEqual(terminal, { success: true, skipped: true })
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })).status, 'CANCELLED')
  } finally {
    await rig.db.activityLog.deleteMany({ where: { entityId: systemRowsFor } }).catch(() => {})
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

// ---------------------------------------------------------------------------------------------------------------------------
// o3d-2gv2g: the #1136 review follow-ups (MED-1, LOW-1, LOW-2)
// ---------------------------------------------------------------------------------------------------------------------------

test('o3d-2gv2g MED-1 THE ROLLBACK CASE: a row under custody with no stamp, whose credit note an older build voided unstamped, is never closed CANCELLED; Xero is read and the voided-not-unwound task is raised', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    // A rolled-back (or deploy-overlap) build claimed the row several times, which re-asserts custody, and POSTed the void without stamping it.
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: 2, attemptRevision: 4 } })
    const claimedAt = new Date()
    // (A claim re-asserts stamping custody; that is what makes the unstamped row read as "never sent".)
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { status: 'PROCESSING', processingStartedAt: claimedAt, attemptRevision: 5, attemptStampingCustodyAt: claimedAt } })
    const claim = { claimedAt, attemptRevision: 5 }
    const facts = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId }, select: { retryCount: true, attemptRevision: true, remoteAttemptedAt: true, createDispatchedAt: true, attemptStampingCustodyAt: true, payload: true } })
    assert.notEqual(facts.attemptStampingCustodyAt, null, 'the row is under custody')
    assert.equal((facts.payload as { _refundDelete?: Record<string, unknown> })._refundDelete?.[rig.deleteService.REFUND_DELETE_VOID_STAMPS_ATTEMPTS], true, 'queued by a build that stamps')
    assert.equal(facts.remoteAttemptedAt, null, 'and carries no attempt stamp')
    assert.equal(rig.deleteService.voidRowProvenNeverSent(facts), true, 'the row\'s facts alone say "never sent": the defect the fix closes')
    const { state, ledger } = fakeLedger()
    state.status = 'VOIDED' // what the older build's unstamped POST left in Xero
    await drawReturnedUnit(rig, w)
    const refused = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, ledger)
    assert.ok(!refused.ok, JSON.stringify(refused))
    assert.equal(state.reads, 1, 'THE FIX: Xero is read before anything is decided')
    assert.equal(refused.ok ? null : refused.voided, true)
    assert.equal(refused.ok ? null : refused.provenNeverSent, false)
    assert.match(refused.ok ? '' : refused.error, /voided in Xero, but the IMS refund still stands/)
    // The processor's mapping: nothing is retired.
    const processor = await import('@/lib/connectors/xero/sync-processor')
    const mapped = await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt: { id: voidRowId, attemptRevision: claim.attemptRevision }, lease: { heldFrom: () => claim.claimedAt } as never, finished: refused as never, refundDelete: rig.deleteService })
    assert.notDeepEqual(mapped, { success: true, skipped: true })
    // And the retirement refuses Xero's VOIDED outright, whatever the caller claims.
    assert.equal(await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: 'x', ledgerStatus: 'VOIDED' }), false)
    assert.equal(await rig.deleteService.retireRefusedRefundDeleteVoid(rig.appDb, { voidSyncLogId: voidRowId, attemptRevision: claim.attemptRevision, claimedAt: claim.claimedAt, refundId, why: 'x', ledgerStatus: 'DELETED' }), false)
    const row = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })
    assert.notEqual(row.status, 'CANCELLED', 'THE FIX: never closed as never sent while Xero holds the credit note voided')
    assert.notEqual(row.abandonedBeforeRemoteCall, true)
    const task = await rig.db.wmsOperatorTask.findFirst({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOIDED_NOT_UNWOUND' } })
    assert.equal(task?.status, 'OPEN', 'a person is told Xero holds it voided while the IMS refund stands')
    assert.equal(await rig.db.activityLog.count({ where: { entityId: w.orderId, action: 'refund_delete_void_cancelled' } }), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('o3d-2gv2g MED-1 NEVER CLOSED ON AN UNREAD: a refusal on a row whose facts say never sent, with Xero unreadable, waits (no retry spent) and stays open', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  let systemRowsFor = '-'
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    systemRowsFor = voidRowId
    const claim = await claimVoidRow(rig, voidRowId)
    await drawReturnedUnit(rig, w)
    let reads = 0
    const unreadable = { voidInLedger: async () => ({ success: true }), readCreditNoteStatus: async () => { reads++; return null } }
    const refused = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, unreadable)
    assert.equal(reads, 1)
    assert.ok(!refused.ok && refused.refusedUnderLocks && refused.ledgerUnread === true && refused.provenNeverSent === false && refused.voided === 'unknown', JSON.stringify(refused))
    const processor = await import('@/lib/connectors/xero/sync-processor')
    const mapped = await processor.refundDeleteVoidFailure({ entryId: voidRowId, referenceId: refundId, attempt: { id: voidRowId, attemptRevision: claim.attemptRevision }, lease: { heldFrom: () => claim.claimedAt } as never, finished: refused as never, refundDelete: rig.deleteService })
    assert.equal(mapped.notPosted?.reason, 'refund-delete-deferred', 'a wait: no retry spent, read again next time')
    const row = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })
    assert.equal(row.status, 'PROCESSING', 'not closed')
    assert.equal(row.retryCount, 0)
    // A read that throws is the same as one that returned nothing.
    const throwing = { voidInLedger: async () => ({ success: true }), readCreditNoteStatus: async () => { throw new Error('budget spent') } }
    const again = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null }, throwing)
    assert.ok(!again.ok && again.ledgerUnread === true && !again.provenNeverSent, JSON.stringify(again))
  } finally {
    await rig.db.activityLog.deleteMany({ where: { entityId: systemRowsFor } }).catch(() => {})
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('o3d-2gv2g LOW-1: an attempt refused before its void (no time) does not read Xero, even on a row an earlier attempt stamped; it says nothing of what Xero holds', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { remoteAttemptedAt: new Date(Date.now() - 60_000) } })
    const { state, ledger } = fakeLedger()
    const t0 = Date.now()
    let ticks = 0
    const clock = () => (ticks++ === 0 ? t0 : t0 + 60_000)
    const result = await rig.deleteService.voidCreditNoteThenCompleteRefundDeletion(rig.db as never, { refundId, voidSyncLogId: voidRowId, actorUserId: null, reason: null, clock }, ledger)
    assert.ok(!result.ok && result.notSent === true && !result.refusedUnderLocks, JSON.stringify(result))
    assert.equal(state.reads, 0, 'THE FIX: no GET for a wait')
    assert.equal(state.voidCalls, 0)
    assert.equal(result.ok ? null : result.voided, 'unknown', 'an earlier attempt was stamped: whether it voided is not claimed')
    assert.match(result.ok ? '' : result.error, /void was not started/)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('o3d-2gv2g LOW-2 THE RACE: two failure writes of one give-up race; the loser is parked behind the winner, and the stuck task is raised once, by the fenced write that made the row FAILED', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const processor = await import('@/lib/connectors/xero/sync-processor')
    const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
    const claim = await claimVoidRow(rig, voidRowId)
    await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { retryCount: 4 } })
    const entry = { retryCount: 4, type: 'CREDIT_NOTE_VOID' as const, referenceType: 'SalesOrderRefund', referenceId: refundId }
    const attempt = { id: voidRowId, attemptRevision: claim.attemptRevision }
    const held = claimHeldFrom(claim.claimedAt)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let wrote!: () => void
    const written = new Promise<void>((resolve) => { wrote = resolve })
    const winner = rig.appDb.$transaction(async (tx) => {
      const outcome = await processor.applyMainSyncFailureRetry(tx, attempt, entry, 'HTTP 500', {}, held)
      wrote()
      await gate // the winner's commit is held open
      return outcome
    }, { timeout: 25_000, maxWait: 10_000 })
    await written
    let loserPid!: (pid: number) => void
    const pidKnown = new Promise<number>((resolve) => { loserPid = resolve })
    const loser = rig.db.$transaction(async (tx) => {
      loserPid(Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid))
      return processor.applyMainSyncFailureRetry(tx, attempt, entry, 'HTTP 500', {}, held)
    }, { timeout: 25_000, maxWait: 10_000 })
    // THE BARRIER, asserted: the loser is blocked behind the winner's open transaction.
    const pid = await pidKnown
    const deadline = Date.now() + 10_000
    let blocked = false
    while (Date.now() < deadline && !blocked) {
      const rows = await rig.db.$queryRaw<Array<{ blockers: number[]; wait: string | null }>>`
        SELECT pg_blocking_pids(${pid}::int) AS blockers, a.wait_event_type AS wait FROM pg_stat_activity a WHERE a.pid = ${pid}::int`
      blocked = (rows[0]?.blockers ?? []).length > 0 && rows[0]?.wait === 'Lock'
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'the second failure write was parked behind the first')
    release()
    const [a, b] = await Promise.all([winner, loser])
    assert.equal(a.finalFailure, true)
    assert.equal(b.finalFailure, true, 'the loser reports the persisted state')
    const row = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: voidRowId } })
    assert.equal(row.status, 'FAILED')
    assert.equal(row.retryCount, 5, 'one failure recorded')
    const tasks = await rig.db.wmsOperatorTask.findMany({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOID_STUCK' } })
    assert.equal(tasks.length, 1, 'one task, from the write that won')
    assert.equal(await rig.db.activityLog.count({ where: { entityId: w.orderId, action: 'refund_delete_void_stuck' } }), 1)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('o3d-2gv2g LOW-2: once per give-up: an operator retry that gives up again after the task was done is told again; not while a task is open; not for a failure that is not the last', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const { refundId, voidRowId } = await refundWithQueuedVoid(rig, w)
    const processor = await import('@/lib/connectors/xero/sync-processor')
    const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
    const giveUp = async (revision: number, retryCount = 4) => {
      const claimedAt = new Date(Date.now() + revision)
      await rig.db.accountingSyncLog.update({ where: { id: voidRowId }, data: { status: 'PROCESSING', processingStartedAt: claimedAt, attemptRevision: revision, retryCount } })
      return rig.appDb.$transaction((tx) => processor.applyMainSyncFailureRetry(tx, { id: voidRowId, attemptRevision: revision }, { retryCount, type: 'CREDIT_NOTE_VOID', referenceType: 'SalesOrderRefund', referenceId: refundId }, `HTTP 500 (${revision})`, {}, claimHeldFrom(claimedAt)))
    }
    const stuck = () => rig.db.wmsOperatorTask.findMany({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOID_STUCK' }, orderBy: { createdAt: 'asc' } })
    assert.equal((await giveUp(1, 2)).finalFailure, false)
    assert.equal((await stuck()).length, 0, 'not the last failure: no task')
    assert.equal((await giveUp(2)).finalFailure, true)
    assert.equal((await stuck()).length, 1)
    // The operator retries (the row back to 0) while the task is still open, and it gives up again: the open task already says it.
    assert.equal((await giveUp(3)).finalFailure, true)
    assert.equal((await stuck()).length, 1, 'not while a task is open')
    // The task is marked done; a later give-up is a new fact and is told again (before, the dedupe key matched the DONE task for ever).
    await rig.db.wmsOperatorTask.updateMany({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOID_STUCK' }, data: { status: 'DONE', doneAt: new Date() } })
    assert.equal((await giveUp(4)).finalFailure, true)
    const after = await stuck()
    assert.equal(after.length, 2, 'THE FIX: raised again after the operator\'s retry')
    assert.equal(after[1]!.status, 'OPEN')
    // A voided-not-unwound task open for the refund already says what to do: no stuck task beside it.
    await rig.db.wmsOperatorTask.updateMany({ where: { orderId: w.orderId, reason: 'REFUND_DELETE_VOID_STUCK' }, data: { status: 'DONE', doneAt: new Date() } })
    await rig.db.wmsOperatorTask.create({ data: { connector: 'xero', orderId: w.orderId, externalOrderId: refundId, reason: 'REFUND_DELETE_VOIDED_NOT_UNWOUND', queryText: 'voided', contentHash: `v-${refundId}` } })
    assert.equal((await giveUp(5)).finalFailure, true)
    assert.equal((await stuck()).length, 2)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})
