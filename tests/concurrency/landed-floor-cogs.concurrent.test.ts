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
 *  6. Only layers whose receipt journal reached the ledger count: a floored-only (0.00) receipt, a receipt made with sync off (then sync on), a
 *     receipt shadowed by the outbound write hold (P1, then P2), and a journalled receipt whose date the seam now shadows, all post nothing,
 *     and no shadow warning is raised.
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

async function seedWorld(label: string, options: { weights?: [number, number]; costLines?: Array<{ amount: number; method: 'BY_QUANTITY' | 'BY_WEIGHT' }> } = {}) {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-lfc-${label}`
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const products: string[] = []
  for (const [index, suffix] of (['a', 'b'] as const).entries()) {
    const weight = options.weights ? String(options.weights[index]) : undefined
    const p = await db.product.create({ data: { sku: `${tag}-${suffix}`, name: `lfc ${suffix}`, type: 'SIMPLE', countryOfOrigin: 'CN', ...(weight ? { weight } : {}) }, select: { id: true } })
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
  const costLines = options.costLines ?? [{ amount: -100, method: 'BY_QUANTITY' as const }]
  const net = costLines.reduce((sum, line) => sum + line.amount, 0)
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `${tag}-F`, supplierId: supplier.id, status: 'PO_SENT', type: 'FREIGHT', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: net, subtotalBase: net, totalForeign: net, totalBase: net,
      freightCostLines: { create: costLines.map((line, index) => ({ description: `cost ${index}`, amountForeign: line.amount.toFixed(4), amountBase: line.amount.toFixed(4), vatable: false, distributionMethod: line.method, sortOrder: index })) },
    },
    select: { id: true, freightCostLines: { select: { id: true } } },
  })
  await db.landedCostLink.create({ data: { primaryPoId: po.id, freightPoId: freight.id, method: 'BY_QUANTITY', allocated: false } })
  const lineA = po.lines.find((l) => l.productId === products[0])!.id
  const lineB = po.lines.find((l) => l.productId === products[1])!.id
  return { tag, poId: po.id, lineA, lineB, warehouseId: warehouse.id, freightId: freight.id, creditLineId: freight.freightCostLines[0]!.id }
}

type World = Awaited<ReturnType<typeof seedWorld>>

async function receive(w: World, a: number, b: number) {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  return receivePurchaseOrder(w.poId, [
    ...(a > 0 ? [{ poLineId: w.lineA, qtyReceived: a, warehouseId: w.warehouseId }] : []),
    ...(b > 0 ? [{ poLineId: w.lineB, qtyReceived: b, warehouseId: w.warehouseId }] : []),
  ])
}

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
  const { readLandedCostChartBeforeTx } = await import('@/lib/domain/purchasing/landed-cost-service')
  const accountingSettings = await readLandedCostChartBeforeTx()
  const result = await db.$transaction((tx) => recalculateLandedCosts(tx, w.freightId, undefined, { triggeredById: null, reason, scheduleAdjustmentJournals: true, accountingSettings }), { timeout: 60_000, maxWait: 10_000 })
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

/** What the bills put in transit for the units that LANDED: their goods value plus every contributing cost line. */
async function landedBilled(w: World, landedValue: number) {
  const { db } = await import('@/lib/db')
  return landedValue + Number((await db.freightCostLine.aggregate({ where: { poId: w.freightId }, _sum: { amountBase: true } }))._sum.amountBase ?? 0)
}

const HOLD_ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM'] as const
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const DAY = 86_400_000
const isoInstant = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z')

/** The outbound write hold for Xero, enforced, with its live-from instant at `liveFrom` (the environment before the FIRST call is restored after the test). */
const holdRestoring = new WeakSet<object>()
function holdXero(t: { after: (fn: () => void) => void }, liveFrom: Date) {
  if (!holdRestoring.has(t)) {
    holdRestoring.add(t)
    const saved = HOLD_ENV_KEYS.map((key) => [key, process.env[key]] as const)
    t.after(() => {
      for (const key of HOLD_ENV_KEYS) delete process.env[key]
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
    })
  }
  Object.assign(process.env, { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: isoInstant(liveFrom) })
}

async function shadowWarnings(poId: string) {
  const { db } = await import('@/lib/db')
  return db.activityLog.count({ where: { entityId: poId, action: 'landed_floor_cogs_shadowed' } })
}

test('a receipt of floored units only (worth 0.00, no receipt journal, so no evidence) is not counted: conservative, the credit stays on transit', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'true' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('flooredonly')
  const received = await receive(w, 4, 0)
  assert.equal(received.success, true, received.error)
  assert.equal(await layer(w.lineA), 0)
  assert.equal(await db.transitSubledgerMovement.count({ where: { sourceRef: w.poId, sourceType: 'STOCK_RECEIPT' } }), 0, 'PRECONDITION: the receipt was worth 0.00 and wrote no receipt row')
  assert.deepEqual((await floorJournals(w)).transit, [], 'no durable evidence the receipt reached the ledger: nothing journalled')
})

test('a receipt made with accounting sync off, then sync turned on: the next event posts nothing for it', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'true', xero_sync_enabled: 'false' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('syncoff')
  assert.equal((await receiveAll(w)).success, true)
  assert.equal(await db.transitSubledgerMovement.count({ where: { sourceRef: w.poId, sourceType: 'STOCK_RECEIPT' } }), 0, 'PRECONDITION: no receipt journal with sync off')
  await db.setting.update({ where: { key: 'xero_sync_enabled' }, data: { value: 'true' } })
  await recalc(w, 'freight_purchase_order_costs_updated')
  assert.deepEqual((await floorJournals(w)).transit, [], 'the receipt never drained transit through the ledger: nothing is owed for it')
})

test('a receipt shadowed by the outbound write hold (P1), then a P2 event: posts nothing, and no shadow warning is raised', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'true' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('p1shadow')
  holdXero(t, new Date(Date.now() + 2 * DAY)) // P1: today's receipt is before the live-from instant, so it is shadowed
  assert.equal((await receiveAll(w)).success, true)
  assert.equal(await db.transitSubledgerMovement.count({ where: { sourceRef: w.poId, sourceType: 'STOCK_RECEIPT' } }), 0, 'PRECONDITION: the shadowed receipt wrote no receipt row')
  holdXero(t, new Date(Date.now() - 2 * DAY)) // P2: live from two days ago
  await recalc(w, 'freight_purchase_order_costs_updated')
  assert.deepEqual((await floorJournals(w)).transit, [], 'nothing posted for a receipt Xero never saw')
  assert.equal(await shadowWarnings(w.poId), 0, 'and no shadow warning noise while the receipt was held')
})

test('a journalled receipt whose date the seam shadows (hold enforced later, live from after it) is not counted', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'false' })
  const { db } = await import('@/lib/db')
  const w = await seedWorld('seamshadow')
  assert.equal((await receiveAll(w)).success, true)
  assert.equal(await db.transitSubledgerMovement.count({ where: { sourceRef: w.poId, sourceType: 'STOCK_RECEIPT' } }), 1, 'PRECONDITION: the receipt was journalled (no hold yet)')
  await db.setting.update({ where: { key: SWITCH }, data: { value: 'true' } })
  holdXero(t, new Date(Date.now() + 2 * DAY))
  await recalc(w, 'freight_purchase_order_costs_updated')
  assert.deepEqual((await floorJournals(w)).transit, [], 'the seam would shadow the receipt date: not counted')
  assert.equal(await shadowWarnings(w.poId), 0, 'nothing owed, so nothing shadowed and no warning')
})

test('close-short: the target follows the landed-quantity basis, so neither under- nor over-clears (BY_QUANTITY credit, and mixed methods)', SKIP, async (t) => {
  await accounting(t)
  await setSettings(t, { [SWITCH]: 'true' })
  const { advancePoStatus } = await import('@/app/actions/purchase-orders')

  // UNDER-CLEAR CASE: receive A 4 and B 1, then close. Over the 5 landed units the -100 is -20 a unit: A 10 - 20 = -10 floored, 4 x 10 = 40.
  const w = await seedWorld('closeq')
  assert.equal((await receive(w, 4, 1)).success, true)
  assert.deepEqual((await floorJournals(w)).transit, [10], 'before the close: over the ordered 8 units, 4 x 2.50')
  const closed = await advancePoStatus(w.poId, 'CLOSED')
  assert.equal(closed.success, true, closed.error)
  const j = await floorJournals(w)
  assert.deepEqual(j.transit, [10, 30], 'the close-short raises it to 40')
  assert.equal(await layer(w.lineB), 80)
  assert.equal(await transitNet(w.poId), -(await landedBilled(w, 4 * 10 + 1 * 100)), 'transit ties with what the bills of the landed units put in')

  // OVER-CLEAR CASE: +200 BY_QUANTITY and -300 BY_WEIGHT (A 10 kg, B 1 kg). On the ordered basis A would leave 132.73 unabsorbed; on the landed
  // basis (A 4, B 1) only 92.68. Using the ordered basis would over-credit COGS by the difference.
  const m = await seedWorld('closemixed', { weights: [10, 1], costLines: [{ amount: 200, method: 'BY_QUANTITY' }, { amount: -300, method: 'BY_WEIGHT' }] })
  assert.equal((await receive(m, 4, 1)).success, true)
  assert.equal((await advancePoStatus(m.poId, 'CLOSED')).success, true)
  const mj = await floorJournals(m)
  assert.equal(Math.round(mj.transit.reduce((a, b) => a + b, 0) * 100) / 100, 92.68, 'the landed-basis target')
  assert.equal(await layer(m.lineA), 0)
  const tie = Math.round((await transitNet(m.poId) + await landedBilled(m, 4 * 10 + 1 * 100)) * 100) / 100
  assert.ok(Math.abs(tie) <= 0.02, `transit ties within rounding (gap ${tie})`)
})
