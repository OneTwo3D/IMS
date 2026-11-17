import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-ngmt.22 — deleting a refund recorded in error, against a real Postgres.
 *
 * Offline: the delete only writes PENDING sync-log / outbox rows; no connector is called (and tests/no-outbound-network.cjs would throw
 * if one were). Gated behind RUN_DB_CONCURRENCY_TESTS=1.
 */

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }), requireAuth: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }) },
})

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ Prisma, PrismaClient }, { PrismaPg }, refundService, deleteService, { db: appDb }, alloc, custody] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/domain/sales/refund-delete-service'),
    import('@/lib/db'),
    import('@/lib/domain/sales/allocation-service'),
    import('@/lib/domain/accounting/money-attempt-provenance'),
  ])
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 6 }) })
  return { Prisma, db, appDb, createSalesOrderRefund: refundService.createSalesOrderRefund, deleteSalesOrderRefund: deleteService.deleteSalesOrderRefund, evaluateRefundDeletion: deleteService.evaluateRefundDeletion, lockSalesOrder: alloc.lockSalesOrder, custody: custody.stampingCustodyOnCreate }
}
type Rig = Awaited<ReturnType<typeof openRig>>

const SETTINGS: Array<[string, string]> = [
  ['plugin_xero_enabled', 'true'],
  ['xero_sync_enabled', 'true'],
  ['xero_sync_credit_note', 'submitted'],
  ['xero_sync_cogs_reversal', 'submitted'],
]

type World = { suffix: string; productId: string; mainId: string; returnsId: string; orderId: string; lineId: string; prefix: string; cleanup: () => Promise<void> }

/** A shipped order of 2 x GBP 100 whose units cost 45, with a returns warehouse. */
async function buildWorld(rig: Rig, opts: { orderOver?: Record<string, unknown> } = {}): Promise<World> {
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const product = await db.product.create({ data: { sku: `RD-${suffix}`, name: 'rd', type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `RM${suffix.slice(0, 8)}`, name: 'rd main' }, select: { id: true } })
  const returns = await db.warehouse.create({ data: { code: `RR${suffix.slice(0, 8)}`, name: 'rd returns' }, select: { id: true } })
  const layer = await db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: D('2'), remainingQty: D('0'), unitCostBase: D('45') }, select: { id: true } })
  const snapshot = [{ costLayerId: layer.id, qty: '2', unitCostBase: '45' }]
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `RD-${suffix.slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('200'), totalForeign: D('200'), subtotalBase: D('200'), taxBase: D('0'), totalBase: D('200'), paidAt: new Date(),
      lines: { create: [{ productId: product.id, description: 'rd', qty: D('2'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('200'), totalBase: D('200') }] },
      ...(opts.orderOver ?? {}),
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.shipment.create({
    data: { orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(), cogsBatchAmount: D('90'), lines: { create: [{ lineId, productId: product.id, qty: D('2'), costLayerSnapshot: snapshot }] } },
  })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  const world: World = {
    suffix, productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId, prefix: `RD${suffix.slice(0, 6)}-`,
    cleanup: async () => {
      const oid = order.id
      const refundIds = (await db.salesOrderRefund.findMany({ where: { orderId: oid }, select: { id: true } })).map((r) => r.id)
      const allRefundIds = [...refundIds, ...(await db.salesOrderRefundDeletion.findMany({ where: { orderId: oid }, select: { refundId: true } })).map((r) => r.refundId)]
      await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: { in: allRefundIds } }, { referenceId: oid }] } }).catch(() => {})
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: allRefundIds } } }).catch(() => {})
      await db.integrationOutbox.deleteMany({ where: { OR: [{ payloadJson: { path: ['orderId'], equals: oid } }, { payloadJson: { path: ['accountingSyncLogId'], string_contains: '' } }] } }).catch(() => {})
      await db.cogsSubledgerMovement.deleteMany({ where: { sourceRef: { in: allRefundIds } } }).catch(() => {})
      await db.activityLog.deleteMany({ where: { entityId: oid } }).catch(() => {})
      await db.wmsOperatorTask.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.payment.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderRefundDeletion.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: oid } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId: oid } } }).catch(() => {})
      await db.shipment.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.orderAllocation.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: oid } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: oid } }).catch(() => {})
      await db.stockMovement.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId: product.id } } }).catch(() => {})
      await db.costLayer.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.stockLevel.deleteMany({ where: { productId: product.id } }).catch(() => {})
      await db.warehouse.deleteMany({ where: { id: { in: [main.id, returns.id] } } }).catch(() => {})
      await db.product.delete({ where: { id: product.id } }).catch(() => {})
      await db.setting.deleteMany({ where: { key: { in: ['refund_delete_enabled', 'xero_books_lock_date'] } } }).catch(() => {})
    },
  }
  return world
}

async function recordRefund(rig: Rig, w: World, qty = 1) {
  const refund = await rig.createSalesOrderRefund(rig.db, {
    orderId: w.orderId,
    lines: [{ lineId: w.lineId, productId: w.productId, description: 'rd', qty, totalBase: 100 * qty }],
    reason: 'Customer return', returnWarehouseId: w.returnsId, creditNotePrefix: w.prefix,
  })
  assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
  return refund.success ? refund.createdRefund.id : ''
}

/** What the hand-off after a refund would have queued, written directly: a credit note posted in the ledger and a COGS reversal not yet sent. */
async function seedPostedCreditNote(rig: Rig, refundId: string, over: { status?: 'SYNCED' | 'PENDING' | 'FAILED' | 'PROCESSING'; id?: string | null; date?: string } = {}) {
  const { db } = rig
  const refund = await db.salesOrderRefund.findUniqueOrThrow({ where: { id: refundId }, select: { creditNoteNumber: true } })
  const status = over.status ?? 'SYNCED'
  const ledgerId = over.id === undefined ? 'LEDGER-CN-1' : over.id
  const row = await db.accountingSyncLog.create({
    data: { type: 'CREDIT_NOTE', status, referenceType: 'SalesOrderRefund', referenceId: refundId, externalTransactionId: ledgerId, payload: { date: over.date ?? new Date().toISOString().slice(0, 10), creditNoteNumber: refund.creditNoteNumber }, ...rig.custody() },
    select: { id: true },
  })
  if (status === 'SYNCED' && ledgerId) await db.salesOrderRefund.update({ where: { id: refundId }, data: { accountingCreditNoteId: ledgerId, accountingCreditNoteConnector: 'xero' } })
  return row.id
}

async function seedCogsReversal(rig: Rig, refundId: string, status: 'PENDING' | 'SYNCED' = 'PENDING') {
  const { db } = rig
  const today = new Date().toISOString().slice(0, 10)
  const row = await db.accountingSyncLog.create({
    data: {
      type: 'COGS_REVERSAL', status, referenceType: 'SalesOrderRefund', referenceId: refundId, externalTransactionId: status === 'SYNCED' ? 'LEDGER-J-1' : null,
      payload: { date: today, _cogsReversalBase: 45, lines: [{ accountCode: '1200', description: 'COGS reversal', debit: 45 }, { accountCode: '5000', description: 'COGS reversal', credit: 45 }] }, ...rig.custody(),
    },
    select: { id: true },
  })
  await db.cogsSubledgerMovement.create({ data: { sourceType: 'REFUND_REVERSAL', sourceRef: refundId, idempotencyKey: `sales-order-refund:${refundId}:cogs-reversal`, baseDelta: '-45', journalDate: new Date(`${today}T00:00:00.000Z`) } })
  return row.id
}

const enable = (rig: Rig) => rig.db.setting.upsert({ where: { key: 'refund_delete_enabled' }, create: { key: 'refund_delete_enabled', value: 'true' }, update: { value: 'true' } })
const subledgerNet = async (rig: Rig, refundId: string) => (await rig.db.cogsSubledgerMovement.findMany({ where: { sourceRef: refundId } })).reduce((s, r) => s + Number(r.baseDelta), 0)

test('an eligible IMS refund is deleted: stock, layers, the COGS sub-ledger and the order status net back; the credit note void is queued, nothing is sent', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w)
    const stockBefore = await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })
    assert.equal(Number(stockBefore.quantity), 1, 'the refund returned one unit')
    const layers = await rig.db.costLayer.findMany({ where: { productId: w.productId, warehouseId: w.returnsId } })
    assert.equal(layers.length, 1)
    assert.ok(layers[0].returnMovementId, 'the return layer is tagged with the movement that created it')
    const cnSync = await seedPostedCreditNote(rig, refundId)
    const cogsSync = await seedCogsReversal(rig, refundId)
    assert.equal(await subledgerNet(rig, refundId), -45)
    // The "Refund in WooCommerce" task an IMS refund on a storefront order raises (the person is told to pay the customer back in the shop).
    const shopTask = await rig.db.wmsOperatorTask.create({ data: { connector: 'woocommerce', orderId: w.orderId, externalOrderId: refundId, reason: 'SHOP_REFUND_DUE', queryText: 'Please refund', contentHash: `h-${refundId}` }, select: { id: true } })

    const verdict = await rig.evaluateRefundDeletion(rig.db, refundId)
    assert.deepEqual(verdict.refusals, [], 'eligible')

    const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: 'entered twice' })
    assert.equal(result.success, true, result.success ? '' : result.error)
    assert.ok(result.success && result.voidQueued)

    // The record is gone; the tombstone remembers it.
    assert.equal(await rig.db.salesOrderRefund.count({ where: { id: refundId } }), 0)
    assert.equal(await rig.db.salesOrderRefundLine.count({ where: { refundId } }), 0)
    const tomb = await rig.db.salesOrderRefundDeletion.findUniqueOrThrow({ where: { refundId } })
    assert.equal(tomb.accountingCreditNoteId, 'LEDGER-CN-1')
    assert.equal(tomb.reason, 'entered twice')
    assert.equal(Number(tomb.totalBase), 100)
    // Stock: exactly what the return recorded goes back out.
    const stockAfter = await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })
    assert.equal(Number(stockAfter.quantity), 0)
    assert.equal(await rig.db.costLayer.count({ where: { productId: w.productId, warehouseId: w.returnsId } }), 0)
    assert.equal(await rig.db.stockMovement.count({ where: { productId: w.productId, type: 'RETURN_INBOUND' } }), 0)
    // The sub-ledger nets back to the pre-refund state, at the amount the refund recorded.
    assert.equal(await subledgerNet(rig, refundId), 0)
    // The unsent COGS reversal is retired, proven never sent.
    const cogs = await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: cogsSync } })
    assert.equal(cogs.status, 'CANCELLED')
    assert.equal(cogs.abandonedBeforeRemoteCall, true)
    // The credit note void is queued through the outbox, PENDING: nothing was sent and nothing was claimed.
    const voidRows = await rig.db.accountingSyncLog.findMany({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId } })
    assert.equal(voidRows.length, 1)
    assert.equal(voidRows[0].status, 'PENDING')
    assert.equal(voidRows[0].referenceType, 'SalesOrderRefundDeletion')
    assert.equal((voidRows[0].payload as Record<string, unknown>).creditNoteId, 'LEDGER-CN-1')
    assert.equal(tomb.voidSyncLogId, voidRows[0].id)
    const outbox = await rig.db.integrationOutbox.findMany({ where: { connector: 'xero', payloadJson: { path: ['accountingSyncLogId'], equals: voidRows[0].id } } })
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].status, 'PENDING')
    // The posted credit note row itself is left as the record of what was posted (the void row undoes it in the ledger).
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: cnSync } })).status, 'SYNCED')
    // The task that would have told someone to refund the customer in the shop for a refund that is gone is closed.
    assert.equal((await rig.db.wmsOperatorTask.findUniqueOrThrow({ where: { id: shopTask.id } })).status, 'DONE')
    // The order's refund status is recomputed from what remains.
    assert.equal((await rig.db.salesOrder.findUniqueOrThrow({ where: { id: w.orderId } })).refundStatus, 'NONE')
    // Audit and activity.
    const activity = await rig.db.activityLog.findMany({ where: { entityId: w.orderId, action: 'refund_deleted' } })
    assert.equal(activity.length, 1)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('a posted COGS reversal is countered, not edited: a swapped journal is queued and the sub-ledger gets the exact opposite', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w)
    await seedCogsReversal(rig, refundId, 'SYNCED')
    const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(result.success, true, result.success ? '' : result.error)
    assert.ok(result.success && result.counterJournalQueued)
    const counter = await rig.db.accountingSyncLog.findMany({ where: { type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefundDeletion', referenceId: refundId } })
    assert.equal(counter.length, 1)
    const lines = (counter[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
    assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? null, l.credit ?? null]), [['1200', null, 45], ['5000', 45, null]], 'debit and credit swapped, at the recorded amount')
    assert.equal(await subledgerNet(rig, refundId), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('an unsent credit note is retired instead of voided, and no void is queued', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w)
    const cn = await seedPostedCreditNote(rig, refundId, { status: 'PENDING', id: null })
    const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(result.success, true, result.success ? '' : result.error)
    assert.ok(result.success && !result.voidQueued)
    assert.equal((await rig.db.accountingSyncLog.findUniqueOrThrow({ where: { id: cn } })).status, 'CANCELLED')
    assert.equal(await rig.db.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId } }), 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('setting off: the delete is refused and changes nothing', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    const refundId = await recordRefund(rig, w)
    await rig.db.setting.deleteMany({ where: { key: 'refund_delete_enabled' } })
    const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(result.success, false)
    assert.ok(!result.success && result.refusals.some((r) => r.code === 'setting_off'))
    assert.equal(await rig.db.salesOrderRefund.count({ where: { id: refundId } }), 1)
    assert.equal(await rig.db.stockMovement.count({ where: { productId: w.productId, type: 'RETURN_INBOUND' } }), 1)
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 0)
    await rig.db.setting.upsert({ where: { key: 'refund_delete_enabled' }, create: { key: 'refund_delete_enabled', value: 'false' }, update: { value: 'false' } })
    const off = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(off.success, false)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

type Refusal = { name: string; code: string; arrange: (rig: Rig, w: World, refundId: string) => Promise<void>; world?: Record<string, unknown> }

const REFUSALS: Refusal[] = [
  { name: 'a WooCommerce-originated refund', code: 'woocommerce_origin', arrange: async (rig, _w, id) => { await rig.db.salesOrderRefund.update({ where: { id }, data: { externalRefundId: 7000000 + Math.floor(Math.random() * 1000000), source: 'WOO_SYNC' } }) } },
  { name: 'an automatic (chargeback) refund', code: 'automatic_origin', arrange: async (rig, _w, id) => { await rig.db.salesOrderRefund.update({ where: { id }, data: { source: 'CHARGEBACK_POLLER' } }) } },
  { name: 'a credit note with a payment against it', code: 'credit_note_settled', arrange: async (rig, w, id) => { await rig.db.payment.create({ data: { orderId: w.orderId, refundId: id, amount: '-100', currency: 'GBP' } }) } },
  { name: 'a credit note dated on or before the books lock date', code: 'books_locked', arrange: async (rig, _w, id) => { await seedPostedCreditNote(rig, id); const day = new Date().toISOString().slice(0, 10); await rig.db.setting.upsert({ where: { key: 'xero_books_lock_date' }, create: { key: 'xero_books_lock_date', value: day }, update: { value: day } }) } },
  { name: 'returned stock that was since consumed', code: 'stock_moved', arrange: async (rig, w) => { await rig.db.costLayer.updateMany({ where: { productId: w.productId, warehouseId: w.returnsId }, data: { remainingQty: '0' } }) } },
  { name: 'returned stock that was since reserved', code: 'stock_moved', arrange: async (rig, w) => { await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { reservedQty: '1' } }) } },
  { name: 'returned stock that was since moved out', code: 'stock_moved', arrange: async (rig, w) => { await rig.db.stockLevel.update({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } }, data: { quantity: '0' } }) } },
  { name: 'a return whose layers IMS did not tag', code: 'stock_untraceable', arrange: async (rig, w) => { await rig.db.costLayer.updateMany({ where: { productId: w.productId, warehouseId: w.returnsId }, data: { returnMovementId: null } }) } },
  { name: 'an order carrying store credit', code: 'store_credit_order', arrange: async (rig, w) => { await rig.db.salesOrder.update({ where: { id: w.orderId }, data: { storeCreditForeign: '5' } }) } },
  { name: 'an erased order', code: 'order_erased', arrange: async (rig, w) => { await rig.db.salesOrder.update({ where: { id: w.orderId }, data: { erasedAt: new Date() } }) } },
  { name: 'a credit note being sent right now', code: 'accounting_in_flight', arrange: async (rig, _w, id) => { await seedPostedCreditNote(rig, id, { status: 'PROCESSING', id: null }) } },
  { name: 'a refund that routed goods in transit', code: 'in_transit_return', arrange: async (rig, _w, id) => { await rig.db.salesOrderRefund.update({ where: { id }, data: { returnInTransit: true } }) } },
  { name: 'a refund whose accounting still needs a retry', code: 'accounting_unfinished', arrange: async (rig, _w, id) => { await rig.db.salesOrderRefund.update({ where: { id }, data: { accountingRetryRequired: true } }) } },
  { name: 'a refund that moved unearned revenue', code: 'journal_unsupported', arrange: async (rig, _w, id) => { await rig.db.accountingSyncLog.create({ data: { type: 'UNEARNED_REV_REVERSAL', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: id, externalTransactionId: 'LEDGER-U-1', payload: {}, ...rig.custody() } }) } },
]

for (const refusal of REFUSALS) {
  test(`refused: ${refusal.name}`, { skip }, async () => {
    const rig = await openRig()
    const w = await buildWorld(rig)
    try {
      await enable(rig)
      const refundId = await recordRefund(rig, w)
      await refusal.arrange(rig, w, refundId)
      const before = {
        stock: Number((await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })).quantity),
        movements: await rig.db.stockMovement.count({ where: { productId: w.productId } }),
        layers: await rig.db.costLayer.count({ where: { productId: w.productId } }),
        syncs: await rig.db.accountingSyncLog.count({ where: { referenceId: refundId } }),
      }
      const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
      assert.equal(result.success, false, `${refusal.name} must be refused`)
      assert.ok(!result.success && result.refusals.some((r) => r.code === refusal.code), `expected ${refusal.code}, got ${!result.success ? result.refusals.map((r) => r.code).join(',') : 'success'}`)
      assert.ok(!result.success && result.error.length > 40, 'operator wording')
      // Nothing moved.
      assert.equal(await rig.db.salesOrderRefund.count({ where: { id: refundId } }), 1)
      assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 0)
      assert.equal(await rig.db.stockMovement.count({ where: { productId: w.productId } }), before.movements)
      assert.equal(await rig.db.costLayer.count({ where: { productId: w.productId } }), before.layers)
      assert.equal(await rig.db.accountingSyncLog.count({ where: { referenceId: refundId } }), before.syncs)
      assert.equal(await rig.db.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId } }), 0)
      void before.stock
    } finally {
      await w.cleanup()
      await rig.db.$disconnect()
      await rig.appDb.$disconnect()
    }
  })
}

test('an idempotent retry reports success and does nothing twice; a crash before commit leaves nothing and the resume completes once', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w)
    await seedPostedCreditNote(rig, refundId)
    await seedCogsReversal(rig, refundId)

    // A crash AFTER every write and BEFORE the commit: the whole delete rolls back.
    const crashing = { $transaction: async (fn: (tx: never) => Promise<unknown>, opts?: unknown) => rig.db.$transaction(async (tx) => { await fn(tx as never); throw new Error('simulated crash before commit') }, opts as never) } as never
    await assert.rejects(() => rig.deleteSalesOrderRefund(crashing, { refundId, actorUserId: null, reason: null }), /simulated crash/)
    assert.equal(await rig.db.salesOrderRefund.count({ where: { id: refundId } }), 1, 'the refund is still there')
    assert.equal(await rig.db.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId } }), 0, 'no void was queued')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 0)
    assert.equal(await subledgerNet(rig, refundId), -45, 'the sub-ledger is untouched')
    assert.equal(Number((await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })).quantity), 1)

    // The resume.
    const first = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(first.success && !first.alreadyDeleted, true)
    // The retry (a double click, a replay): success, and nothing is done a second time.
    const again = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(again.success && again.alreadyDeleted, true)
    assert.equal(await rig.db.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE_VOID', referenceId: refundId } }), 1, 'one void')
    assert.equal(await rig.db.salesOrderRefundDeletion.count({ where: { refundId } }), 1, 'one tombstone')
    assert.equal(await subledgerNet(rig, refundId), 0)
    assert.equal(Number((await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })).quantity), 0, 'stock went out once')
    assert.equal(await rig.db.activityLog.count({ where: { entityId: w.orderId, action: 'refund_deleted' } }), 1)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('concurrency: the delete waits for the order lock a shipment holds, and runs a second refund alongside without losing either', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w, 1)

    // 1. A shipment (anything holding the order lock) is mid-flight: the delete must not get past the lock until it commits.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding!: () => void
    const holdingStarted = new Promise<void>((resolve) => { holding = resolve })
    const shipment = rig.db.$transaction(async (tx) => {
      await rig.lockSalesOrder(tx, w.orderId)
      holding()
      await held
    }, { timeout: 20000 })
    await holdingStarted
    let finished = false
    const deleting = rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null }).then((r) => { finished = true; return r })
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(finished, false, 'the delete is parked behind the order lock')
    release()
    await shipment
    const result = await deleting
    assert.equal(result.success, true, result.success ? '' : result.error)

    // 2. A second refund recorded while another is being deleted: both orders of arrival leave a coherent order.
    const a = await recordRefund(rig, w, 1)
    const [deleted, created] = await Promise.all([
      rig.deleteSalesOrderRefund(rig.db, { refundId: a, actorUserId: null, reason: null }),
      rig.createSalesOrderRefund(rig.db, { orderId: w.orderId, lines: [{ lineId: w.lineId, productId: w.productId, description: 'rd', qty: 1, totalBase: 100 }], reason: 'second', returnWarehouseId: w.returnsId, creditNotePrefix: w.prefix }),
    ])
    assert.equal(deleted.success, true, deleted.success ? '' : deleted.error)
    assert.equal(created.success, true, created.success ? '' : created.error)
    const remaining = await rig.db.salesOrderRefund.findMany({ where: { orderId: w.orderId }, select: { totalBase: true } })
    assert.equal(remaining.length, 1, 'exactly the second refund remains')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: w.orderId }, select: { refundStatus: true } })
    assert.equal(order.refundStatus, 'PARTIAL', 'status follows the refunds that remain (one of two units)')
    const stock = await rig.db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.returnsId } } })
    assert.equal(Number(stock.quantity), 1, 'only the surviving refund\'s unit is on hand')
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})

test('analytics: the Returns report and the figure reads exclude the deleted refund', { skip }, async () => {
  const rig = await openRig()
  const w = await buildWorld(rig)
  try {
    await enable(rig)
    const refundId = await recordRefund(rig, w)
    const { getRefundStats } = await import('@/app/actions/sales-stats')
    const mine = async () => (await getRefundStats()).filter((row) => row.orderId === w.orderId)
    assert.equal((await mine()).length, 1, 'the refund is in the Returns report')
    const result = await rig.deleteSalesOrderRefund(rig.db, { refundId, actorUserId: null, reason: null })
    assert.equal(result.success, true, result.success ? '' : result.error)
    assert.equal((await mine()).length, 0, 'and is gone from it once deleted')
    const aggregate = await rig.db.salesOrderRefund.aggregate({ where: { orderId: w.orderId }, _sum: { totalBase: true }, _count: true })
    assert.equal(aggregate._count, 0)
  } finally {
    await w.cleanup()
    await rig.db.$disconnect()
    await rig.appDb.$disconnect()
  }
})
