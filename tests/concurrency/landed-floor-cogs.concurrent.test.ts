import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { enableStockReceiptPosting, loadEnv, uid } from './po-landed-fixtures'

/**
 * A SUPPLIER CREDIT THE STOCK CANNOT CARRY GOES TO COST OF SALES (switch landed_cost_floor_cogs_enabled), against a real PostgreSQL (scratch
 * database). Nothing is sent anywhere: the accounting queue only writes rows and the tier has no network.
 *
 * The fixture: a goods order of two lines, A (4 x 10.00) and B (4 x 100.00), and a linked freight order with one credit line of -100.00 split BY
 * QUANTITY, so each unit takes -12.50. A goes to 10.00 - 12.50 = -2.50 and is floored at 0.00 (4 x 2.50 = 10.00 not absorbed); B goes to 87.50.
 *
 *  1. Switch off: the receipt and a recalculation post exactly what they posted before (no floored-credit journal, no sub-ledger row).
 *  2. Switch on, receipt: one COGS_JOURNAL DR Stock in Transit 10.00 / CR COGS 10.00, a transit row +10.00 and a COGS row -10.00.
 *  3. A second change (the credit grows to -140.00): A's floor leaves 4 x 7.50 = 30.00, so the next journal is the difference, +20.00.
 *  4. The freight order is cancelled: the credit leaves the allocation, the target is 0 and the journal is reversed, -30.00.
 *  Throughout: the transit sub-ledger of the order (receipt, landed-cost reclasses and this journal) equals minus what the bills put in transit
 *  (goods 440.00 plus the credit), so R11 ties.
 *  5. Unmapped COGS account: the receipt that owes the journal is refused and nothing is written.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const SWITCH = 'landed_cost_floor_cogs_enabled'
const PREFIX = 'landed-floor-cogs:'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

async function setSettings(t: { after: (fn: () => Promise<void>) => void }, values: Record<string, string | null>) {
  const { db } = await import('@/lib/db')
  for (const [key, value] of Object.entries(values)) {
    const saved = await db.setting.findUnique({ where: { key } })
    if (value === null) await db.setting.deleteMany({ where: { key } })
    else await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    t.after(async () => {
      await db.setting.deleteMany({ where: { key } })
      if (saved) await db.setting.create({ data: { key, value: saved.value } })
    })
  }
}

async function seedWorld(label: string) {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-lfc-${label}`
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const products: string[] = []
  for (const suffix of ['a', 'b']) {
    const p = await db.product.create({ data: { sku: `${tag}-${suffix}`, name: `lfc ${suffix}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
    await db.stockLevel.create({ data: { productId: p.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' } })
    products.push(p.id)
  }
  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: [
      { productId: products[0]!, sku: `${tag}-a`, productName: 'lfc a', qty: 4, unitCostForeign: 10 },
      { productId: products[1]!, sku: `${tag}-b`, productName: 'lfc b', qty: 4, unitCostForeign: 100 },
    ],
  })
  assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, productId: true } } } })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `${tag}-F`, supplierId: supplier.id, status: 'PO_SENT', type: 'FREIGHT', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: -100, subtotalBase: -100, totalForeign: -100, totalBase: -100,
      freightCostLines: { create: [{ description: 'supplier rebate', amountForeign: '-100.0000', amountBase: '-100.0000', vatable: false, distributionMethod: 'BY_QUANTITY', sortOrder: 0 }] },
    },
    select: { id: true, freightCostLines: { select: { id: true } } },
  })
  await db.landedCostLink.create({ data: { primaryPoId: po.id, freightPoId: freight.id, method: 'BY_QUANTITY', allocated: false } })
  const lineA = po.lines.find((l) => l.productId === products[0])!.id
  const lineB = po.lines.find((l) => l.productId === products[1])!.id
  return { tag, poId: po.id, lineA, lineB, warehouseId: warehouse.id, freightId: freight.id, creditLineId: freight.freightCostLines[0]!.id }
}

type World = Awaited<ReturnType<typeof seedWorld>>

async function receiveAll(w: World) {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  return receivePurchaseOrder(w.poId, [
    { poLineId: w.lineA, qtyReceived: 4, warehouseId: w.warehouseId },
    { poLineId: w.lineB, qtyReceived: 4, warehouseId: w.warehouseId },
  ])
}

async function recalc(w: World, reason: 'freight_purchase_order_costs_updated' | 'freight_purchase_order_cancelled') {
  const { db } = await import('@/lib/db')
  const { recalculateLandedCosts, queueLandedCostAdjustmentJournals } = await import('@/lib/domain/purchasing/landed-cost-service')
  const result = await db.$transaction((tx) => recalculateLandedCosts(tx, w.freightId, undefined, { triggeredById: null, reason, scheduleAdjustmentJournals: true }), { timeout: 60_000, maxWait: 10_000 })
  await queueLandedCostAdjustmentJournals(result)
  return result
}

async function floorJournals(w: World) {
  const { db } = await import('@/lib/db')
  const logs = await db.accountingSyncLog.findMany({ where: { type: 'COGS_JOURNAL', referenceId: w.poId }, orderBy: { createdAt: 'asc' }, select: { payload: true } })
  const floored = logs
    .map((l) => l.payload as { _idempotencyKey?: string; reference?: string; lines: Array<{ accountCode: string; debit?: number; credit?: number }> })
    .filter((p) => String(p.reference ?? '').startsWith('Landed credit to COGS'))
  const transit = await db.transitSubledgerMovement.findMany({ where: { sourceRef: w.poId, sourceType: 'LANDED_COST_CONSUMED_OFFSET', idempotencyKey: { startsWith: PREFIX } }, orderBy: { createdAt: 'asc' }, select: { baseDelta: true, idempotencyKey: true } })
  const cogs = await db.cogsSubledgerMovement.findMany({ where: { sourceRef: w.poId, sourceType: 'LANDED_COST_ADJUSTMENT', idempotencyKey: { startsWith: PREFIX } }, select: { baseDelta: true } })
  return { floored, transit: transit.map((r) => Number(r.baseDelta)), cogs: cogs.map((r) => Number(r.baseDelta)) }
}

/** The order's transit sub-ledger net, all sources. */
async function transitNet(poId: string) {
  const { db } = await import('@/lib/db')
  const sum = await db.transitSubledgerMovement.aggregate({ where: { sourceRef: poId }, _sum: { baseDelta: true } })
  return Math.round(Number(sum._sum.baseDelta ?? 0) * 100) / 100
}

async function layer(lineId: string) {
  const { db } = await import('@/lib/db')
  const l = await db.costLayer.findFirstOrThrow({ where: { poLineId: lineId }, select: { unitCostBase: true } })
  return Number(l.unitCostBase)
}

async function accounting(t: { after: (fn: () => Promise<void>) => void }, extra: Record<string, string | null> = {}) {
  loadEnv()
  await enableStockReceiptPosting()
  await setSettings(t, { xero_cogs_account: '500', xero_sync_cogs_journal: 'submitted', ...extra })
}

test('switch off: receipt and recalculation post exactly what they did before (no floored-credit journal or row)', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: null })
  const w = await seedWorld('off')
  const received = await receiveAll(w)
  assert.equal(received.success, true, received.error)
  assert.equal(await layer(w.lineA), 0, 'A is floored at 0.00')
  assert.equal(await layer(w.lineB), 87.5)
  await recalc(w, 'freight_purchase_order_costs_updated')
  const j = await floorJournals(w)
  assert.deepEqual(j, { floored: [], transit: [], cogs: [] }, 'nothing is journalled for the floored credit')
  assert.equal(await transitNet(w.poId), -350, 'only the receipt drains transit, as before')
})

test('switch on: receipt journals the unabsorbed credit; a second change adjusts it; cancelling the freight order reverses it; transit ties throughout', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'true' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('on')
  // What the bills put in transit: the goods (440.00) plus every freight cost line (the credit).
  const billed = async () => 440 + Number((await db.freightCostLine.aggregate({ where: { poId: w.freightId, po: { status: { not: 'CANCELLED' } } }, _sum: { amountBase: true } }))._sum.amountBase ?? 0)

  // RECEIPT: 4 x 2.50 not absorbed on A.
  const received = await receiveAll(w)
  assert.equal(received.success, true, received.error)
  assert.equal(await layer(w.lineA), 0, 'the zero floor is kept')
  let j = await floorJournals(w)
  assert.equal(j.floored.length, 1)
  const lines = j.floored[0]!.lines
  assert.deepEqual(lines.map((l) => ({ account: l.accountCode, debit: l.debit ?? 0, credit: l.credit ?? 0 })), [
    { account: '631', debit: 10, credit: 0 },
    { account: '500', debit: 0, credit: 10 },
  ], 'DR Stock in Transit / CR COGS for what the stock cannot carry')
  assert.deepEqual(j.transit, [10])
  assert.deepEqual(j.cogs, [-10])
  assert.equal(await transitNet(w.poId), -(await billed()), 'transit sub-ledger = minus what the bills put in transit (440 - 100)')

  // REPLAY: a recalculation with the same cost lines changes nothing.
  await recalc(w, 'freight_purchase_order_costs_updated')
  j = await floorJournals(w)
  assert.deepEqual(j.transit, [10], 'idempotent: nothing more is owed')

  // A SECOND CHANGE: the credit grows to -140.00 (-17.50 a unit): A leaves 4 x 7.50 = 30.00; the journal is the difference.
  await db.freightCostLine.update({ where: { id: w.creditLineId }, data: { amountForeign: '-140.0000', amountBase: '-140.0000' } })
  await recalc(w, 'freight_purchase_order_costs_updated')
  j = await floorJournals(w)
  assert.deepEqual(j.transit, [10, 20])
  assert.deepEqual(j.cogs, [-10, -20])
  assert.equal(await layer(w.lineB), 82.5)
  assert.equal(await transitNet(w.poId), -(await billed()), 'still ties (440 - 140)')

  // CANCELLED FREIGHT ORDER: the credit leaves the allocation; the journal is reversed.
  await db.purchaseOrder.update({ where: { id: w.freightId }, data: { status: 'CANCELLED' } })
  await recalc(w, 'freight_purchase_order_cancelled')
  j = await floorJournals(w)
  assert.deepEqual(j.transit, [10, 20, -30])
  assert.deepEqual(j.cogs, [-10, -20, 30])
  const reversal = j.floored[2]!.lines
  assert.deepEqual(reversal.map((l) => ({ account: l.accountCode, debit: l.debit ?? 0, credit: l.credit ?? 0 })), [
    { account: '500', debit: 30, credit: 0 },
    { account: '631', debit: 0, credit: 30 },
  ], 'the reversal: DR COGS / CR Stock in Transit')
  assert.equal(await layer(w.lineA), 10, 'A is back at its goods cost')
  assert.equal(await transitNet(w.poId), -440, 'ties with the goods bill alone')
})

test('an unmapped COGS account refuses the receipt that owes the journal, and nothing is written', SKIP, async (t) => {
  await accounting(t, { xero_cogs_account: null })
  await setSettings(t, { [SWITCH]: 'true' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('nocogs')
  const received = await receiveAll(w)
  assert.equal(received.success, false)
  assert.match(received.error ?? '', /COGS account is not mapped/)
  assert.equal(await db.costLayer.count({ where: { poLineId: { in: [w.lineA, w.lineB] } } }), 0, 'the receipt was rolled back')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: w.poId, type: { in: ['STOCK_RECEIPT', 'COGS_JOURNAL'] } } }), 0, 'and no journal was queued')
})
