import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'
import type { SeededPo } from './po-landed-fixtures'

/**
 * CLOSE-SHORT REALLOCATES THE UNRECEIVED FREIGHT SHARE ONTO THE RECEIVED UNITS (owner ruling 2026-11-10, option A).
 *
 * Real `receivePurchaseOrder`, `advancePoStatus('CLOSED')` and `cancelPurchaseOrder` over a real PostgreSQL. The journals are produced by
 * production code (`queueLandedCostAdjustmentJournals` through the close) and only COUNTED/UNPACKED here; nothing contacts Xero. The only
 * thing a fixture writes for a "bill" is its effect on Transit (a PURCHASE_BILL subledger row), so the arm can prove Transit for the
 * order clears to zero: bills - receipts - reclass = 0.
 *
 * The world: 100 @ 5.00 ordered, a 50.00 BY_VALUE freight cost line, 60 received. At receipt the freight is spread over the 100 ordered, so a
 * received unit costs 5.50 (receipt journal 330.00). Closing short spreads the 50.00 over the 60 that arrived: 5.833333 a unit, +20.00.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, seedPo, receive, uid } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

const near = (actual: number, expected: number, tolerance = 0.011, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} (+/-${tolerance}), got ${actual}`)

async function addDirectFreight(po: SeededPo, amount = 50) {
  const { db } = await import('@/lib/db')
  await db.freightCostLine.create({ data: { poId: po.poId, description: 'Freight', amountForeign: amount, amountBase: amount, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 } })
}

/** A bill's effect on Transit: DR Transit (+). Written directly: bill creation itself is not under test. */
async function billTransit(poId: string, amount: number, label: string) {
  const { db } = await import('@/lib/db')
  await db.transitSubledgerMovement.create({ data: { sourceType: 'PURCHASE_BILL', sourceRef: poId, idempotencyKey: `${label}-${uid()}`, baseDelta: amount, journalDate: new Date() } })
}

async function transitNet(poId: string) {
  const { db } = await import('@/lib/db')
  const rows = await db.transitSubledgerMovement.findMany({ where: { sourceRef: poId }, select: { sourceType: true, baseDelta: true } })
  return { net: rows.reduce((sum, r) => sum + Number(r.baseDelta), 0), byType: Object.fromEntries(rows.map((r) => [r.sourceType, Number(r.baseDelta)])) }
}

async function journals(poId: string) {
  const { db } = await import('@/lib/db')
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId: poId, NOT: { type: 'STOCK_RECEIPT' } }, orderBy: { createdAt: 'asc' }, select: { type: true, payload: true } })
  return rows.map((row) => {
    const lines = ((row.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }).lines ?? [])
    return { type: row.type as string, debit: lines.filter((l) => l.debit).map((l) => ({ account: l.accountCode, amount: Number(l.debit) })), credit: lines.filter((l) => l.credit).map((l) => ({ account: l.accountCode, amount: Number(l.credit) })) }
  })
}

async function layersOf(po: SeededPo) {
  const { db } = await import('@/lib/db')
  const layers = await db.costLayer.findMany({ where: { poLineId: { in: po.lines.map((l) => l.poLineId) } }, select: { id: true, unitCostBase: true, receivedQty: true, remainingQty: true } })
  const line = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: po.lines[0]!.poLineId }, select: { landedUnitCostBase: true } })
  return { layers: layers.map((l) => ({ id: l.id, unit: Number(l.unitCostBase), received: Number(l.receivedQty), remaining: Number(l.remainingQty) })), lineLanded: Number(line.landedUnitCostBase) }
}

async function close(po: SeededPo, how: 'close' | 'cancel') {
  const { advancePoStatus, cancelPurchaseOrder } = await import('@/app/actions/purchase-orders')
  return how === 'close' ? advancePoStatus(po.poId, 'CLOSED') : cancelPurchaseOrder(po.poId)
}

for (const how of ['close', 'cancel'] as const) {
  for (const billed of [true, false]) {
    test(`direct freight, ${billed ? 'billed' : 'unbilled'}: ${how} short revalues the received layer 5.50 -> 5.833333, posts DR Inventory / CR Transit 20.00, and Transit ${billed ? 'clears to zero' : 'holds the unbilled freight credit'}`, SKIP, async () => {
      const po = await seedPo(`csf-${how}-${billed ? 'b' : 'u'}`, [100])
      const line = po.lines[0]!
      await addDirectFreight(po)
      assert.equal((await receive(po, line, 60)).success, true)
      const before = await layersOf(po)
      near(before.layers[0]!.unit, 5.5, 0.000001, 'layer at receipt')
      const receiptTransit = await transitNet(po.poId)
      near(receiptTransit.byType.STOCK_RECEIPT ?? 0, -330, 0.001, 'receipt credits Transit with goods + the freight share')

      const result = await close(po, how)
      assert.equal(result.success, true, String(result.error))

      const after = await layersOf(po)
      assert.equal(after.layers.length, 1)
      near(after.layers[0]!.unit, 5 + 50 / 60, 0.000002, 'layer revalued over the 60 that landed')
      near(after.lineLanded, 5 + 50 / 60, 0.000002, 'line landed unit cost')
      assert.equal(after.layers[0]!.remaining, 60, 'quantities untouched')

      const posted = await journals(po.poId)
      assert.deepEqual(posted.map((j) => j.type), ['STOCK_IN_TRANSIT'], 'one inventory journal, nothing for sold units (none sold)')
      near(posted[0]!.debit[0]!.amount, 20, 0.011, 'DR Inventory')
      near(posted[0]!.credit[0]!.amount, 20, 0.011, 'CR Transit')

      // Idempotent: the same revaluation is enqueued twice (the durable outbox row in the transaction and the post-commit call share
      // one key), and exactly one journal and one subledger row exist.
      const { db } = await import('@/lib/db')
      assert.equal(await db.accountingSyncLog.count({ where: { referenceId: po.poId, type: 'STOCK_IN_TRANSIT' } }), 1)
      assert.equal(await db.transitSubledgerMovement.count({ where: { sourceRef: po.poId, sourceType: 'LANDED_COST_RECLASS' } }), 1)

      const t = await transitNet(po.poId)
      near(t.byType.LANDED_COST_RECLASS ?? 0, -20, 0.011, 'reclass credits Transit')
      if (billed) {
        await billTransit(po.poId, 300, 'bill-goods') // goods billed for the 60 received
        await billTransit(po.poId, 50, 'bill-freight') // the whole freight bill
        near((await transitNet(po.poId)).net, 0, 0.011, 'Transit for the order clears to zero')
      } else {
        await billTransit(po.poId, 300, 'bill-goods')
        near((await transitNet(po.poId)).net, -50, 0.011, 'the freight is still unbilled: its credit waits for the bill')
        await billTransit(po.poId, 50, 'bill-freight-later')
        near((await transitNet(po.poId)).net, 0, 0.011, 'and clears when the freight bill arrives')
      }
      assert.equal((await (await import('@/lib/db')).db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { status: true } })).status, 'CLOSED')
    })
  }
}

test('units already sold: the sold share goes to COGS, the on-hand share to Inventory, and Transit still clears', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedPo('csf-sold', [100])
  const line = po.lines[0]!
  await addDirectFreight(po)
  assert.equal((await receive(po, line, 60)).success, true)
  // 10 of the 60 were consumed (sold).
  const layer = await db.costLayer.findFirstOrThrow({ where: { poLineId: line.poLineId }, select: { id: true } })
  await db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: 50 } })
  await db.stockLevel.update({ where: { productId_warehouseId: { productId: line.productId, warehouseId: po.warehouseId } }, data: { quantity: 50 } })

  const result = await close(po, 'close')
  assert.equal(result.success, true, String(result.error))
  const posted = await journals(po.poId)
  const byType = Object.fromEntries(posted.map((j) => [j.type, j]))
  console.log(`sold-arm journals: ${JSON.stringify(posted)}`)
  assert.ok(byType.STOCK_IN_TRANSIT, 'inventory journal for the 50 on hand')
  near(byType.STOCK_IN_TRANSIT!.debit[0]!.amount, 50 * (50 / 60 - 0.5), 0.011, 'DR Inventory for the 50 on hand')
  assert.ok(byType.COGS_JOURNAL, 'COGS journal for the 10 sold')
  const cogs = byType.COGS_JOURNAL!.debit.reduce((s, d) => s + d.amount, 0)
  near(cogs, 10 * (50 / 60 - 0.5), 0.011, 'DR COGS for the 10 sold')
  const t = await transitNet(po.poId)
  const reclassTotal = Object.entries(t.byType).filter(([k]) => k !== 'STOCK_RECEIPT').reduce((s, [, v]) => s + v, 0)
  near(reclassTotal, -20, 0.02, 'Transit credited with the whole 20.00 (inventory + COGS legs)')
  await billTransit(po.poId, 350, 'bill-all')
  near((await transitNet(po.poId)).net, 0, 0.02, 'Transit clears to zero')
})

test('linked freight order: the closed order carries the whole link, the freight order and the other linked order are untouched', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedPo('csf-linked', [100])
  const other = await seedPo('csf-linked-other', [100])
  const freight = await seedPo('csf-linked-f', [1])
  await db.purchaseOrder.update({ where: { id: freight.poId }, data: { type: 'FREIGHT' } })
  await db.freightCostLine.create({ data: { poId: freight.poId, description: 'Sea freight', amountForeign: 50, amountBase: 50, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 } })
  await db.landedCostLink.create({ data: { primaryPoId: po.poId, freightPoId: freight.poId } })
  await db.landedCostLink.create({ data: { primaryPoId: other.poId, freightPoId: freight.poId } })
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  assert.equal((await receive(other, other.lines[0]!, 60)).success, true)
  const otherBefore = await layersOf(other)
  const freightBefore = await db.purchaseOrder.findUniqueOrThrow({ where: { id: freight.poId }, select: { status: true, totalForeign: true } })
  near((await layersOf(po)).layers[0]!.unit, 5.5, 0.000001, 'linked freight is in the receipt cost')

  const result = await close(po, 'close')
  assert.equal(result.success, true, String(result.error))
  near((await layersOf(po)).layers[0]!.unit, 5 + 50 / 60, 0.000002, 'closed order re-spread its link over the 60 that landed')
  assert.deepEqual(await layersOf(other), otherBefore, 'the other linked order keeps its own allocation')
  const freightAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: freight.poId }, select: { status: true, totalForeign: true } })
  assert.deepEqual(freightAfter, freightBefore, 'the freight order is not touched')
  const links = await db.landedCostLink.findMany({ where: { freightPoId: freight.poId }, select: { primaryPoId: true, allocated: true } })
  assert.equal(links.find((l) => l.primaryPoId === po.poId)?.allocated, true)
  const posted = await journals(po.poId)
  assert.deepEqual(posted.map((j) => j.type), ['STOCK_IN_TRANSIT'])
  near(posted[0]!.debit[0]!.amount, 20, 0.011)
  assert.deepEqual(await journals(other.poId), [], 'nothing is posted for the other order')
})

test('no freight: closing short revalues nothing and posts nothing; fully landed lines are not revalued either', SKIP, async () => {
  const po = await seedPo('csf-none', [100])
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  const before = await layersOf(po)
  assert.equal((await close(po, 'close')).success, true)
  assert.deepEqual(await layersOf(po), before)
  assert.deepEqual(await journals(po.poId), [])
  const { db } = await import('@/lib/db')
  assert.equal(await db.landedCostRevaluationRun.count({ where: { primaryPoId: po.poId } }), 0)
})

test('two lines: BY_VALUE freight follows LANDED value (a line that landed nothing carries none)', SKIP, async () => {
  const po = await seedPo('csf-two', [100, 100])
  await addDirectFreight(po, 60)
  assert.equal((await receive(po, po.lines[0]!, 50)).success, true)
  const { db } = await import('@/lib/db')
  // At receipt: 60 over 200 ordered value 1000 -> line A (value 500) gets 30 over 100 units = +0.30 -> 5.30.
  const a = await db.costLayer.findFirstOrThrow({ where: { poLineId: po.lines[0]!.poLineId }, select: { unitCostBase: true } })
  near(Number(a.unitCostBase), 5.3, 0.000001, 'receipt cost')
  assert.equal((await close(po, 'close')).success, true)
  const a2 = await db.costLayer.findFirstOrThrow({ where: { poLineId: po.lines[0]!.poLineId }, select: { unitCostBase: true } })
  // After close: only line A landed (50 units), so it carries all 60: 5 + 60/50 = 6.20.
  near(Number(a2.unitCostBase), 6.2, 0.000001, 'closed: the whole freight on the line that landed')
})

test('a live ASN still refuses the close; nothing is revalued', SKIP, async () => {
  const po = await seedPo('csf-asn', [100])
  await addDirectFreight(po)
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  await fixtures.addAsn(po, po.lines[0]!, { expectedQty: 40, status: 'OPEN' })
  const before = await layersOf(po)
  const result = await close(po, 'close')
  assert.equal(result.success, false)
  assert.deepEqual(await layersOf(po), before)
  assert.deepEqual(await journals(po.poId), [])
})

test('the durable outbox backstop row for the reallocation journals is written in the close transaction', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedPo('csf-outbox', [100])
  await addDirectFreight(po)
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  assert.equal((await close(po, 'close')).success, true)
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM integration_outbox
    WHERE operation = 'landed-cost.adjustment-journal' AND "payloadJson"::text LIKE ${'%' + po.poId + '%'}`
  assert.equal(rows[0]!.n, 1)
})

test('fully landed (nothing dropped) with freight: closing revalues nothing', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedPo('csf-full', [10])
  await addDirectFreight(po, 5)
  assert.equal((await receive(po, po.lines[0]!, 10)).success, true)
  const before = await layersOf(po)
  assert.equal((await close(po, 'close')).success, true)
  assert.deepEqual(await layersOf(po), before)
  assert.equal(await db.landedCostRevaluationRun.count({ where: { primaryPoId: po.poId } }), 0)
  assert.deepEqual(await journals(po.poId), [])
})

test('credit floor: a freight credit that only fits the full order is floored at 0.00 once spread over fewer units, and the operator is told', SKIP, async () => {
  const po = await seedPo('csf-floor', [100])
  const { db } = await import('@/lib/db')
  // Goods 5.00; a 400.00 credit over 100 units is -4.00 a unit (1.00 net); over the 60 that landed it is -6.67 (floored at 0).
  await db.freightCostLine.create({ data: { poId: po.poId, description: 'Supplier credit', amountForeign: -400, amountBase: -400, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 } })
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  near((await layersOf(po)).layers[0]!.unit, 1, 0.000001, 'receipt: 5 - 4')
  const result = await close(po, 'close') as { success: boolean; error?: string; warnings?: string[] }
  assert.equal(result.success, true, String(result.error))
  assert.equal((await layersOf(po)).layers[0]!.unit, 0, 'floored at zero, never negative')
  assert.ok((result.warnings ?? []).some((w) => /floor|zero|0\.00/i.test(w)), `the operator is told: ${JSON.stringify(result.warnings)}`)
  const posted = await journals(po.poId)
  assert.deepEqual(posted.map((j) => j.type), ['STOCK_IN_TRANSIT'])
  near(posted[0]!.credit[0]!.amount, 60, 0.011, 'inventory decreased by 60 x 1.00 (CR Inventory)')
})
