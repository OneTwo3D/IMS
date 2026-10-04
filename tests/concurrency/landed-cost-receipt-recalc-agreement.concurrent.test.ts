import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { enableStockReceiptPosting, loadEnv, uid } from './po-landed-fixtures'

/**
 * A CREDIT OR ZERO FREIGHT LINE IS COSTED THE SAME WAY AT RECEIPT AND AT RECALCULATION, AND NEVER BELOW ZERO
 * (o3d-gj68 + o3d-ab13). Needs real Postgres: the properties are "a receipt followed by a recalculation with
 * unchanged cost lines posts NOTHING", "the stored layer is exactly zero", and "the activity entry is written
 * after the commit".
 *
 * Every arm prints its precondition. No network: nothing here reaches Xero, QuickBooks, Mintsoft or
 * WooCommerce, and no email is sent.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

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

type SeededGoodsPo = { poId: string; poLineId: string; productId: string; sku: string; warehouseId: string; supplierId: string }

async function seedGoodsPo(label: string, qty: number, unitCost: number): Promise<SeededGoodsPo> {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-lcagree-${label}`
  const product = await db.product.create({
    data: { sku: tag, name: `lcagree ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: [{ productId: product.id, sku: tag, productName: `lcagree ${label}`, qty, unitCostForeign: unitCost }],
  })
  assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder must succeed: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  return { poId: po.id, poLineId: po.lines[0]!.id, productId: product.id, sku: tag, warehouseId: warehouse.id, supplierId: supplier.id }
}

/** A linked FREIGHT order whose cost lines are written DIRECTLY, so a credit line exists whatever the actions allow. */
async function seedFreightWithLines(primaryPoId: string, supplierId: string, amounts: number[], status: 'PO_SENT' | 'CANCELLED' = 'PO_SENT'): Promise<{ poId: string }> {
  const { db } = await import('@/lib/db')
  const total = amounts.reduce((sum, a) => sum + a, 0)
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `${uid()}-lcagree-F`,
      supplierId,
      status,
      type: 'FREIGHT',
      currency: 'GBP',
      fxRateToBase: '1',
      subtotalForeign: total,
      subtotalBase: total,
      totalForeign: total,
      totalBase: total,
      freightCostLines: {
        create: amounts.map((amount, index) => ({
          description: `freight ${index}`,
          amountForeign: amount.toFixed(4),
          amountBase: amount.toFixed(4),
          vatable: false,
          distributionMethod: 'BY_VALUE' as const,
          sortOrder: index,
        })),
      },
    },
    select: { id: true },
  })
  await db.landedCostLink.create({ data: { primaryPoId, freightPoId: freight.id, method: 'BY_VALUE', allocated: false } })
  return { poId: freight.id }
}

async function journalRows(poId: string, type: string) {
  const { db } = await import('@/lib/db')
  return db.accountingSyncLog.count({ where: { type: type as never, referenceId: poId } })
}

// ─── T5: the headline — receipt then a recalculation with the SAME cost lines posts nothing ─────────────

test('T5: receive a PO whose linked freight has +20 and -5, then re-save the SAME lines: zero reclass, zero COGS, layer unchanged', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const UNIT = 10
  const goods = await seedGoodsPo('t5', QTY, UNIT)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [20, -5])

  const { receivePurchaseOrder, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const received = await receivePurchaseOrder(goods.poId, [{ poLineId: goods.poLineId, qtyReceived: QTY, warehouseId: goods.warehouseId }])
  assert.equal(received.success, true, `PRECONDITION: the receipt must succeed: ${received.error}`)

  // Credit applied: 10 + (20 - 5) / 4 = 13.75. The old receipt helper skipped the -5 and laid 15.
  const layerAtReceipt = await db.costLayer.findFirstOrThrow({ where: { poLineId: goods.poLineId }, select: { id: true, unitCostBase: true } })
  const creditLines = await db.freightCostLine.count({ where: { poId: freight.poId, amountBase: { lt: 0 } } })
  console.log(`T5 PRECONDITION: credit lines on the linked freight: ${creditLines}, layer cost at receipt: ${layerAtReceipt.unitCostBase}`)
  assert.equal(creditLines, 1)
  assert.equal(Number(layerAtReceipt.unitCostBase), 13.75, 'the receipt must apply the -5 credit, exactly as a recalculation would')
  const receiptJournal = await db.accountingSyncLog.findFirst({ where: { type: 'STOCK_RECEIPT', referenceId: goods.poId }, select: { payload: true } })
  const debit = ((receiptJournal?.payload as { lines?: Array<{ debit?: number }> } | null)?.lines ?? []).find((l) => typeof l.debit === 'number')?.debit
  assert.equal(debit, QTY * 13.75, 'the receipt journal carries the credited cost')

  // Re-save the freight order with the very same lines through the real action.
  const resaved = await updateFreightPoCosts(freight.poId, [
    { description: 'freight 0', amountForeign: 20, vatable: false, distributionMethod: 'BY_VALUE' },
    { description: 'freight 1', amountForeign: -5, vatable: false, distributionMethod: 'BY_VALUE' },
  ])
  assert.equal(resaved.success, true, `PRECONDITION: the re-save must succeed: ${resaved.error}`)
  const runs = await db.landedCostRevaluationRun.count({ where: { primaryPoId: goods.poId } })
  const layerAfter = await db.costLayer.findUniqueOrThrow({ where: { id: layerAtReceipt.id }, select: { unitCostBase: true } })
  const reclass = await journalRows(goods.poId, 'STOCK_IN_TRANSIT')
  const cogs = await journalRows(goods.poId, 'COGS_JOURNAL')
  console.log(`T5 PRECONDITION: recalculation runs recorded: ${runs}, layer after: ${layerAfter.unitCostBase}, STOCK_IN_TRANSIT rows: ${reclass}, COGS_JOURNAL rows: ${cogs}`)
  assert.equal(runs >= 1, true, 'the recalculation really ran (a re-save that never revalued would prove nothing)')
  assert.equal(Number(layerAfter.unitCostBase), 13.75, 'layer unchanged')
  assert.equal(reclass, 0, 'a recalculation of unchanged cost lines posts NO inventory/transit reclass')
  assert.equal(cogs, 0, 'and no COGS adjustment')
})

// ─── T6: a credit larger than the goods cost, at receipt ────────────────────────────────────────────────

test('T6: receipt floors a credit at zero: layer 0, movement value 0, no STOCK_RECEIPT, ONE activity WARNING after the commit, warning in the result', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 2
  const goods = await seedGoodsPo('t6', QTY, 1)
  await seedFreightWithLines(goods.poId, goods.supplierId, [-3])

  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const received = await receivePurchaseOrder(goods.poId, [{ poLineId: goods.poLineId, qtyReceived: QTY, warehouseId: goods.warehouseId }])
  assert.equal(received.success, true, `PRECONDITION: the receipt must succeed (a negative layer would have thrown): ${received.error}`)

  const layer = await db.costLayer.findFirstOrThrow({ where: { poLineId: goods.poLineId }, select: { unitCostBase: true, receivedQty: true } })
  const movement = await db.stockMovement.findFirstOrThrow({ where: { type: 'PURCHASE_RECEIPT', productId: goods.productId }, select: { unitCostBase: true, totalValueBase: true } })
  const receiptJournals = await journalRows(goods.poId, 'STOCK_RECEIPT')
  const activity = await db.activityLog.findMany({ where: { entityType: 'PURCHASE_ORDER', entityId: goods.poId, action: 'landed_cost_credit_floored' }, select: { level: true, description: true } })
  console.log(`T6 PRECONDITION: unfloored cost would be ${1 + -3 / QTY}; layer=${layer.unitCostBase}, movement=${movement.unitCostBase}/${movement.totalValueBase}, STOCK_RECEIPT rows=${receiptJournals}, floor activity entries=${activity.length}, result.warnings=${JSON.stringify(received.warnings)}`)
  assert.equal(layer.unitCostBase.toString(), '0', 'the stored layer is exactly zero (not -0.5, not 1)')
  assert.equal(Number(movement.unitCostBase), 0)
  assert.equal(Number(movement.totalValueBase), 0)
  assert.equal(receiptJournals, 0, 'nothing of value entered stock, so no STOCK_RECEIPT is queued')
  assert.equal(activity.length, 1, 'exactly one durable WARNING, written after the commit')
  assert.equal(activity[0].level, 'WARNING')
  assert.match(activity[0].description, /could not absorb 1\.00 of it into stock/)
  assert.equal(received.warnings?.length, 1, 'and the operator sees it in the action result')
  assert.equal(received.warnings?.[0], activity[0].description, 'one sentence, from the one builder')
})

// ─── T11 (DB): the two freight actions persist byte-identical rows, and accept a deliberate credit ──────

test('T11 (DB): createFreightPo and updateFreightPoCosts persist IDENTICAL rows and totals for the same input; {+20,-5} is accepted; a net credit is refused', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('t11', 4, 10)
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')

  const input = [{ description: 'odd fx', amountForeign: 0.1309, vatable: true, distributionMethod: 'BY_VALUE' }]
  const created = await createFreightPo({ supplierId: goods.supplierId, currency: 'EUR', fxRateToBase: 2, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: input })
  assert.equal(created.success, true, `PRECONDITION: createFreightPo must succeed: ${created.error}`)
  const snapshot = async (poId: string) => {
    const po = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      select: { subtotalForeign: true, subtotalBase: true, taxForeign: true, taxBase: true, totalForeign: true, totalBase: true, directFreightForeign: true, directFreightBase: true },
    })
    const lines = await db.freightCostLine.findMany({ where: { poId }, orderBy: { sortOrder: 'asc' }, select: { description: true, amountForeign: true, amountBase: true, vatable: true, distributionMethod: true, sortOrder: true } })
    return JSON.stringify({ po, lines })
  }
  const viaCreate = await snapshot(created.po!.id)
  const updated = await updateFreightPoCosts(created.po!.id, input, 0.2)
  assert.equal(updated.success, true, `PRECONDITION: updateFreightPoCosts must succeed: ${updated.error}`)
  const viaUpdate = await snapshot(created.po!.id)
  const amountBase = (JSON.parse(viaCreate) as { lines: Array<{ amountBase: string }> }).lines[0].amountBase
  console.log(`T11 PRECONDITION: persisted amountBase via create=${amountBase} (HALF_UP of 0.06545; the old float builder stored 0.0654); create snapshot == update snapshot: ${viaCreate === viaUpdate}`)
  assert.equal(Number(amountBase), 0.0655)
  assert.equal(viaCreate, viaUpdate, 'the same input persists byte-identical rows and totals whichever action saves it')

  // A deliberate credit inside a non-negative total is accepted by BOTH actions and persisted signed.
  const mixed = [
    { description: 'freight', amountForeign: 20, vatable: false, distributionMethod: 'BY_VALUE' },
    { description: 'discount', amountForeign: -5, vatable: false, distributionMethod: 'BY_VALUE' },
  ]
  const second = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], costLines: mixed })
  assert.equal(second.success, true, `{+20,-5} must be accepted: ${second.error}`)
  const signed = await db.freightCostLine.findMany({ where: { poId: second.po!.id }, orderBy: { sortOrder: 'asc' }, select: { amountBase: true } })
  assert.deepEqual(signed.map((row) => Number(row.amountBase)), [20, -5])
  const resaved = await updateFreightPoCosts(second.po!.id, mixed)
  assert.equal(resaved.success, true, `{+20,-5} must be accepted on update: ${resaved.error}`)

  // A NET credit is refused by both, and the refusal leaves the saved lines alone.
  const before = await snapshot(second.po!.id)
  const refusedUpdate = await updateFreightPoCosts(second.po!.id, [{ description: 'credit', amountForeign: -1, vatable: false, distributionMethod: 'BY_VALUE' }])
  assert.equal(refusedUpdate.success, false)
  assert.match(String(refusedUpdate.error), /supplier credit note/)
  assert.equal(await snapshot(second.po!.id), before, 'a refused update changed nothing')
  const poCountBefore = await db.purchaseOrder.count({ where: { supplierId: goods.supplierId, type: 'FREIGHT' } })
  const refusedCreate = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], costLines: [{ description: 'credit', amountForeign: -1, vatable: false, distributionMethod: 'BY_VALUE' }] })
  assert.equal(refusedCreate.success, false)
  assert.match(String(refusedCreate.error), /supplier credit note/)
  assert.equal(await db.purchaseOrder.count({ where: { supplierId: goods.supplierId, type: 'FREIGHT' } }), poCountBefore, 'a refused create persisted no freight order')
})

// ─── The PO detail preview agrees with receipt: credits applied, cancelled freight excluded, read-only ──

test('preview: getPurchaseOrder costs a credit like the receipt, ignores CANCELLED freight, flags a floored line, and writes nothing', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { getPurchaseOrder } = await import('@/app/actions/purchase-orders')

  // (a) credit applied and the cancelled freight order excluded: 10 + (20 - 5) / 4 = 13.75, NOT 10 + 415/4.
  const goods = await seedGoodsPo('pv1', 4, 10)
  await seedFreightWithLines(goods.poId, goods.supplierId, [20, -5])
  await seedFreightWithLines(goods.poId, goods.supplierId, [400], 'CANCELLED')
  const detail = await getPurchaseOrder(goods.poId)
  console.log(`preview PRECONDITION: gross unit cost ${detail?.lines[0]?.grossUnitCostBase} (live +20/-5 applied, cancelled +400 excluded; including it would be ${10 + 415 / 4}), floors=${detail?.landedCostFloors.length}`)
  assert.equal(detail?.lines[0]?.grossUnitCostBase, 13.75)
  assert.deepEqual(detail?.landedCostFloors, [])

  // (b) a floored line is flagged for the ORDERED qty, with the shared sentence, and the preview writes nothing.
  const floored = await seedGoodsPo('pv2', 2, 1)
  await seedFreightWithLines(floored.poId, floored.supplierId, [-3])
  const before = await db.activityLog.count({ where: { entityType: 'PURCHASE_ORDER', entityId: floored.poId } })
  const flooredDetail = await getPurchaseOrder(floored.poId)
  const after = await db.activityLog.count({ where: { entityType: 'PURCHASE_ORDER', entityId: floored.poId } })
  console.log(`preview PRECONDITION: floors=${JSON.stringify(flooredDetail?.landedCostFloors.map((f) => [f.sku, f.unabsorbedBase, f.unflooredGrossUnitCostBase]))}, gross=${flooredDetail?.lines[0]?.grossUnitCostBase}, activity rows before/after=${before}/${after}`)
  assert.equal(flooredDetail?.lines[0]?.grossUnitCostBase, 0)
  assert.equal(flooredDetail?.landedCostFloors.length, 1)
  assert.equal(flooredDetail?.landedCostFloors[0].unabsorbedBase, 1)
  assert.equal(flooredDetail?.landedCostFloors[0].unflooredGrossUnitCostBase, -0.5)
  assert.match(flooredDetail?.landedCostFloors[0].message ?? '', /cannot absorb 1\.00 of it into stock/)
  assert.equal(after, before, 'the read-only preview must not write an activity entry')
})
