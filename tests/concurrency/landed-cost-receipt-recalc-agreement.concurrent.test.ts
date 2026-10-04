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

async function seedGoodsPo(label: string, qty: number, unitCost: number, extraLines: Array<{ qty: number; unit: number }> = []): Promise<SeededGoodsPo> {
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
  const extras: Array<{ id: string; sku: string }> = []
  for (let i = 0; i < extraLines.length; i += 1) {
    const sku = `${tag}-x${i}`
    const extra = await db.product.create({ data: { sku, name: `lcagree ${label} x${i}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
    await db.stockLevel.create({ data: { productId: extra.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' } })
    extras.push({ id: extra.id, sku })
  }
  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: [{ productId: product.id, sku: tag, productName: `lcagree ${label}`, qty, unitCostForeign: unitCost }, ...extras.map((extra, i) => ({ productId: extra.id, sku: extra.sku, productName: `lcagree ${label} x${i}`, qty: extraLines[i]!.qty, unitCostForeign: extraLines[i]!.unit }))],
  })
  assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder must succeed: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  return { poId: po.id, poLineId: po.lines[0]!.id, productId: product.id, sku: tag, warehouseId: warehouse.id, supplierId: supplier.id }
}

/** A linked FREIGHT order whose cost lines are written DIRECTLY, so a credit line exists whatever the actions allow. */
async function seedFreightWithLines(primaryPoId: string, supplierId: string, amounts: Array<number | string>, status: 'PO_SENT' | 'CANCELLED' = 'PO_SENT', options: { method?: 'BY_VALUE' | 'BY_QUANTITY'; fx?: number; baseOverride?: string[]; vatable?: boolean } = {}): Promise<{ poId: string }> {
  const { db } = await import('@/lib/db')
  const total = amounts.reduce<number>((sum, a) => sum + Number(a), 0)
  const fx = options.fx ?? 1
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `${uid()}-lcagree-F`,
      supplierId,
      status,
      type: 'FREIGHT',
      currency: 'GBP',
      fxRateToBase: String(fx),
      subtotalForeign: total,
      subtotalBase: total,
      totalForeign: total,
      totalBase: total,
      freightCostLines: {
        create: amounts.map((amount, index) => ({
          description: `freight ${index}`,
          amountForeign: Number(amount).toFixed(4),
          amountBase: options.baseOverride?.[index] ?? (Number(amount) / fx).toFixed(4),
          vatable: options.vatable ?? false,
          distributionMethod: options.method ?? ('BY_VALUE' as const),
          sortOrder: index,
        })),
      },
    },
    select: { id: true },
  })
  await db.landedCostLink.create({ data: { primaryPoId, freightPoId: freight.id, method: options.method ?? 'BY_VALUE', allocated: false } })
  return { poId: freight.id }
}

async function journalRows(poId: string, type: string) {
  const { db } = await import('@/lib/db')
  return db.accountingSyncLog.count({ where: { type: type as never, referenceId: poId } })
}

// ─── T5: the headline — receipt then a recalculation with the SAME cost lines posts nothing ─────────────

test('T5: receive a PO whose linked freight has +20 and -5, then recalculate with the SAME lines: zero reclass, zero COGS, layer unchanged', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const UNIT = 10
  const goods = await seedGoodsPo('t5', QTY, UNIT)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [20, -5])

  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
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

  // Revalue with the SAME cost lines through the real recalculation (a save of unchanged lines is now a no-op, so
  // it would not reach the recalculation at all; this drives the recalculation itself).
  const { recalculateLandedCosts, queueLandedCostAdjustmentJournals } = await import('@/lib/domain/purchasing/landed-cost-service')
  const recalculated = await db.$transaction((tx) => recalculateLandedCosts(tx, freight.poId, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  }), { timeout: 60_000, maxWait: 10_000 })
  await queueLandedCostAdjustmentJournals(recalculated)
  const runs = await db.landedCostRevaluationRun.count({ where: { primaryPoId: goods.poId } })
  const layerAfter = await db.costLayer.findUniqueOrThrow({ where: { id: layerAtReceipt.id }, select: { unitCostBase: true } })
  const reclass = await journalRows(goods.poId, 'STOCK_IN_TRANSIT')
  const cogs = await journalRows(goods.poId, 'COGS_JOURNAL')
  console.log(`T5 PRECONDITION: recalculation runs recorded: ${runs}, layer after: ${layerAfter.unitCostBase}, STOCK_IN_TRANSIT rows: ${reclass}, COGS_JOURNAL rows: ${cogs}`)
  assert.equal(runs >= 1, true, 'the recalculation really ran (a recalculation that never revalued would prove nothing)')
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
  // Two REAL changes (a save of unchanged lines is a no-op and would prove nothing): bump the amount, then restore
  // it, so the rows the update builder writes are compared with the rows the create builder wrote.
  const bumped = await updateFreightPoCosts(created.po!.id, [{ ...input[0]!, amountForeign: 0.2309 }], 0.2)
  assert.equal(bumped.success, true, `PRECONDITION: the bump must succeed: ${bumped.error}`)
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

// ─── Re-saving freight lines: unchanged is a NO-OP, a change keeps ids, VAT cannot sneak a negative total ──

test('re-save: unchanged freight lines revalue NOTHING (order-sensitive lines on TWO freight orders, and a legacy float-rounded row)', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  // The order-sensitive fixture from the allocation test: summing these shares in another order moves a 6dp cost.
  const goods = await seedGoodsPo('rs', 25, 3.01, [{ qty: 6, unit: 19.58 }, { qty: 8, unit: 6.46 }, { qty: 17, unit: 10.74 }])
  const a = await seedFreightWithLines(goods.poId, goods.supplierId, ['89401.8989', '-27040.1416'], 'PO_SENT', { method: 'BY_QUANTITY' })
  const b = await seedFreightWithLines(goods.poId, goods.supplierId, ['18605.9624'], 'PO_SENT', { method: 'BY_QUANTITY' })
  const save = async (poId: string, lines: Parameters<typeof updateFreightPoCosts>[1]) => {
    const outcome = await updateFreightPoCosts(poId, lines)
    assert.equal(outcome.success, true, `PRECONDITION: the save must succeed: ${outcome.error}`)
  }
  const asInput = (amounts: string[]) => amounts.map((amount, index) => ({ description: `freight ${index}`, amountForeign: Number(amount), vatable: false, distributionMethod: 'BY_QUANTITY' }))
  // A first real change establishes the stored landed costs (then the original amount is restored).
  await save(a.poId, asInput(['89402.8989', '-27040.1416']))
  await save(a.poId, asInput(['89401.8989', '-27040.1416']))
  const snapshot = async () => {
    const lines = await db.purchaseOrderLine.findMany({ where: { poId: goods.poId }, orderBy: { sortOrder: 'asc' }, select: { landedUnitCostBase: true } })
    const ids = await db.freightCostLine.findMany({ where: { poId: { in: [a.poId, b.poId] } }, orderBy: [{ poId: 'asc' }, { sortOrder: 'asc' }], select: { id: true } })
    return {
      landed: lines.map((l) => l.landedUnitCostBase.toString()),
      runs: await db.landedCostRevaluationRun.count({ where: { primaryPoId: goods.poId } }),
      ids: ids.map((r) => r.id).join(','),
      reclass: await journalRows(goods.poId, 'STOCK_IN_TRANSIT'),
      cogs: await journalRows(goods.poId, 'COGS_JOURNAL'),
    }
  }
  const before = await snapshot()
  for (let i = 0; i < 6; i += 1) {
    await save(b.poId, asInput(['18605.9624']))
    await save(a.poId, asInput(['89401.8989', '-27040.1416']))
  }
  const after = await snapshot()
  console.log(`re-save PRECONDITION: 12 unchanged saves across 2 freight orders; runs ${before.runs} -> ${after.runs}; landed ${before.landed.join('/')} -> ${after.landed.join('/')}; ids unchanged: ${before.ids === after.ids}`)
  assert.equal(after.runs, before.runs, 'an unchanged save must not record a revaluation')
  assert.deepEqual(after.landed, before.landed)
  assert.equal(after.ids, before.ids, 'and must not recreate the lines')
  assert.equal(after.reclass + after.cogs, before.reclass + before.cogs)

  // The legacy float artefact: a row stored by the old builder (amountBase 0.0654 where HALF_UP gives 0.0655)
  // is NOT an edit when the operator re-saves the same input.
  const legacy = await seedFreightWithLines(goods.poId, goods.supplierId, ['0.1309'], 'PO_SENT', { fx: 2, baseOverride: ['0.0654'], method: 'BY_QUANTITY' })
  const legacyBefore = await snapshot()
  const legacySaved = await updateFreightPoCosts(legacy.poId, [{ description: 'freight 0', amountForeign: 0.1309, vatable: false, distributionMethod: 'BY_QUANTITY' }])
  assert.equal(legacySaved.success, true)
  const legacyRow = await db.freightCostLine.findFirstOrThrow({ where: { poId: legacy.poId }, select: { amountBase: true } })
  const legacyAfter = await snapshot()
  console.log(`re-save PRECONDITION: legacy amountBase stays ${legacyRow.amountBase}; runs ${legacyBefore.runs} -> ${legacyAfter.runs}`)
  assert.equal(legacyRow.amountBase.toString(), '0.0654', 'the legacy row was not rewritten')
  assert.equal(legacyAfter.runs, legacyBefore.runs)

  // A CHANGE updates in place: the untouched line keeps its id, the changed one keeps its id too, and it revalues.
  const aIdsBefore = (await db.freightCostLine.findMany({ where: { poId: a.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true } })).map((r) => r.id)
  await save(a.poId, asInput(['89401.8989', '-27039.1416']).map((line, index) => ({ ...line, id: aIdsBefore[index]! })))
  const aIdsAfter = (await db.freightCostLine.findMany({ where: { poId: a.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true } })).map((r) => r.id)
  const changed = await snapshot()
  console.log(`re-save PRECONDITION: after one real edit ids ${aIdsBefore.join(',') === aIdsAfter.join(',') ? 'kept' : 'CHANGED'}, runs ${legacyAfter.runs} -> ${changed.runs}`)
  assert.deepEqual(aIdsAfter, aIdsBefore, 'a changed save keeps the ids of the lines it edits in place')
  assert.equal(changed.runs, legacyAfter.runs + 1, 'and a real edit does revalue')
})

test('VAT cannot sneak a NEGATIVE freight order total past the net rule (create and update), and a legitimate mix is accepted', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('vat', 4, 10)
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  // +100 non-vatable, -100 vatable: subtotal 0, but VAT at 20% on the negative line makes the total -20.
  const lines = [
    { description: 'freight', amountForeign: 100, vatable: false, distributionMethod: 'BY_VALUE' },
    { description: 'credit', amountForeign: -100, vatable: true, distributionMethod: 'BY_VALUE' },
  ]
  const before = await db.purchaseOrder.count({ where: { supplierId: goods.supplierId, type: 'FREIGHT' } })
  const refused = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: lines })
  console.log(`VAT PRECONDITION: subtotal 0, total would be -20; create outcome ${JSON.stringify(refused)}`)
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /supplier credit note/)
  assert.equal(await db.purchaseOrder.count({ where: { supplierId: goods.supplierId, type: 'FREIGHT' } }), before, 'nothing was persisted')

  const ok = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: [lines[0]!, { ...lines[1]!, amountForeign: -50 }] })
  assert.equal(ok.success, true, `total 100 - 50 - 10 = 40 is accepted: ${ok.error}`)
  const total = await db.purchaseOrder.findUniqueOrThrow({ where: { id: ok.po!.id }, select: { totalForeign: true } })
  assert.equal(total.totalForeign.toString(), '40')

  const linesBefore = JSON.stringify(await db.freightCostLine.findMany({ where: { poId: ok.po!.id }, orderBy: { sortOrder: 'asc' }, select: { id: true, amountForeign: true } }))
  const refusedUpdate = await updateFreightPoCosts(ok.po!.id, lines, 0.2)
  assert.equal(refusedUpdate.success, false)
  assert.match(String(refusedUpdate.error), /supplier credit note/)
  assert.equal(JSON.stringify(await db.freightCostLine.findMany({ where: { poId: ok.po!.id }, orderBy: { sortOrder: 'asc' }, select: { id: true, amountForeign: true } })), linesBefore, 'a refused update changed nothing')
})

test('preview badge: the tense follows what is RECEIVED (future before, both while partial, past after) and the residue splits the same way', SKIP, async () => {
  loadEnv()
  await enableStockReceiptPosting()
  const { getPurchaseOrder, receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const goods = await seedGoodsPo('tense', 2, 1)
  await seedFreightWithLines(goods.poId, goods.supplierId, [-3])
  const message = async () => (await getPurchaseOrder(goods.poId))?.landedCostFloors[0]?.message ?? ''
  const none = await message()
  assert.equal((await receivePurchaseOrder(goods.poId, [{ poLineId: goods.poLineId, qtyReceived: 1, warehouseId: goods.warehouseId }])).success, true)
  const partial = await message()
  assert.equal((await receivePurchaseOrder(goods.poId, [{ poLineId: goods.poLineId, qtyReceived: 1, warehouseId: goods.warehouseId }])).success, true)
  const full = await message()
  console.log(`tense PRECONDITION:\n  none: ${none}\n  partial: ${partial}\n  full: ${full}`)
  assert.match(none, /will value those units/)
  assert.doesNotMatch(none, /valued those units/)
  assert.match(partial, /\(1 received\).*valued those units at 0\.00 each and could not absorb 0\.50/)
  assert.match(partial, /\(1 not yet received\).*will value those units.*cannot absorb 0\.50/)
  assert.match(full, /valued those units/)
  assert.doesNotMatch(full, /will value/)
  assert.match(full, /could not absorb 1\.00/)
})

// ─── Round 2: VAT survives an edit, credit lines survive the dialog payload, billed rows are untouchable ──

test('VAT: a real edit KEEPS the stored rate when none is passed, a tax-only edit is a real edit, an unchanged save is a no-op, a legacy order derives its rate', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('vat2', 4, 10)
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const created = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: [{ description: 'freight', amountForeign: 100, vatable: true, distributionMethod: 'BY_VALUE' }] })
  assert.equal(created.success, true, String(created.error))
  const poId = created.po!.id
  const header = async () => db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { taxForeign: true, totalForeign: true, taxRatePercent: true } })
  const runs = () => db.landedCostRevaluationRun.count({ where: { primaryPoId: goods.poId } })
  const line = async () => db.freightCostLine.findFirstOrThrow({ where: { poId }, select: { id: true } })
  const first = await header()
  console.log(`VAT PRECONDITION: created tax ${first.taxForeign}, stored rate ${first.taxRatePercent}`)
  assert.equal(first.taxForeign.toString(), '20')
  assert.equal(first.taxRatePercent?.toString(), '0.2')

  // The UI shape: ids, NO tax rate. A real edit (100 -> 110) must keep 20% => tax 22, not zero it.
  const id = (await line()).id
  assert.equal((await updateFreightPoCosts(poId, [{ id, description: 'freight', amountForeign: 110, vatable: true, distributionMethod: 'BY_VALUE' }])).success, true)
  const edited = await header()
  console.log(`VAT PRECONDITION: after a real edit with no rate passed: tax ${edited.taxForeign}, total ${edited.totalForeign}`)
  assert.equal(edited.taxForeign.toString(), '22')
  assert.equal(edited.totalForeign.toString(), '132')

  // Unchanged with no rate: a no-op.
  const before = await runs()
  assert.equal((await updateFreightPoCosts(poId, [{ id, description: 'freight', amountForeign: 110, vatable: true, distributionMethod: 'BY_VALUE' }])).success, true)
  assert.equal(await runs(), before, 'unchanged lines and rate: nothing revalued')

  // Tax-only edit (same lines, new rate): a REAL edit, the totals move.
  assert.equal((await updateFreightPoCosts(poId, [{ id, description: 'freight', amountForeign: 110, vatable: true, distributionMethod: 'BY_VALUE' }], 0.1)).success, true)
  const taxOnly = await header()
  console.log(`VAT PRECONDITION: tax-only edit to 10%: tax ${taxOnly.taxForeign}, rate ${taxOnly.taxRatePercent}`)
  assert.equal(taxOnly.taxForeign.toString(), '11')
  assert.equal(taxOnly.taxRatePercent?.toString(), '0.1')

  // A legacy order (no stored rate, tax 20 on a vatable 100) derives 20% and keeps it.
  const legacy = await seedFreightWithLines(goods.poId, goods.supplierId, [100], 'PO_SENT', { vatable: true })
  await db.purchaseOrder.update({ where: { id: legacy.poId }, data: { taxForeign: 20, taxBase: 20, totalForeign: 120, totalBase: 120, taxRatePercent: null } })
  const legacyId = (await db.freightCostLine.findFirstOrThrow({ where: { poId: legacy.poId }, select: { id: true } })).id
  assert.equal((await updateFreightPoCosts(legacy.poId, [{ id: legacyId, description: 'freight 0', amountForeign: 150, vatable: true, distributionMethod: 'BY_VALUE' }])).success, true)
  const legacyAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: legacy.poId }, select: { taxForeign: true } })
  console.log(`VAT PRECONDITION: legacy order (no stored rate) edited to 150: tax ${legacyAfter.taxForeign}`)
  assert.equal(legacyAfter.taxForeign.toString(), '30')
})

test('credit lines: saving with the dialog payload (stored ids, credit echoed back) keeps the credit row; omitting it is an explicit removal', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('cred', 4, 10)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [20, -5])
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const rows = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, amountForeign: true } })
  const dialogPayload = (positive: number) => [
    { id: rows[0]!.id, description: rows[0]!.description, amountForeign: positive, vatable: false, distributionMethod: 'BY_VALUE' },
    { id: rows[1]!.id, description: rows[1]!.description, amountForeign: -5, vatable: false, distributionMethod: 'BY_VALUE' },
  ]
  const saved = await updateFreightPoCosts(freight.poId, dialogPayload(25))
  assert.equal(saved.success, true, String(saved.error))
  const after = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, amountForeign: true } })
  console.log(`credit PRECONDITION: stored ${rows.length} lines (+20, -5); after the dialog save: ${after.map((r) => `${r.id === rows[0]!.id || r.id === rows[1]!.id ? 'same-id' : 'NEW-ID'}:${r.amountForeign}`).join(', ')}`)
  assert.deepEqual(after.map((r) => [r.id, r.amountForeign.toString()]), [[rows[0]!.id, '25'], [rows[1]!.id, '-5']])
  // The old dialog dropped the credit; the server treats an omitted stored row as an explicit removal.
  const dropped = await updateFreightPoCosts(freight.poId, [dialogPayload(25)[0]!])
  assert.equal(dropped.success, true, String(dropped.error))
  assert.equal(await db.freightCostLine.count({ where: { poId: freight.poId } }), 1)
})

test('billed cost lines: a reordered or removed submission can neither reassign nor delete a row that has been invoiced', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('billed', 4, 10)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [30, 20])
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const rows = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, amountForeign: true } })
  await db.purchaseInvoice.create({
    data: {
      poId: freight.poId, invoiceDate: new Date(), totalForeign: 30, totalBase: 30, fxRateToBase: 1,
      lines: { create: [{ costLineId: rows[0]!.id, description: 'billed freight', qtyBilled: 1, unitCostForeign: 30, totalForeign: 30, totalBase: 30 }] },
    },
  })
  const snapshot = async () => JSON.stringify(await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { id: 'asc' }, select: { id: true, amountForeign: true, description: true } }))
  const before = await snapshot()
  const line = (r: (typeof rows)[number], amount: number) => ({ id: r.id, description: r.description, amountForeign: amount, vatable: false, distributionMethod: 'BY_VALUE' })
  // Reordered, UNCHANGED amounts: fine, and nothing is rewritten.
  const reordered = await updateFreightPoCosts(freight.poId, [line(rows[1]!, 20), line(rows[0]!, 30)])
  // Changing the billed row: refused.
  const changeBilled = await updateFreightPoCosts(freight.poId, [line(rows[0]!, 31), line(rows[1]!, 20)])
  // Removing the billed row: refused.
  const removeBilled = await updateFreightPoCosts(freight.poId, [line(rows[1]!, 20)])
  // Submitting WITHOUT ids (pre-id contract) cannot replace it either.
  const noIds = await updateFreightPoCosts(freight.poId, [{ description: 'x', amountForeign: 99, vatable: false, distributionMethod: 'BY_VALUE' }])
  console.log(`billed PRECONDITION: reordered=${reordered.success}, change=${JSON.stringify(changeBilled.error)}, remove=${JSON.stringify(removeBilled.error)}, noIds=${JSON.stringify(noIds.error)}`)
  assert.equal(reordered.success, true)
  assert.equal(changeBilled.success, false)
  assert.match(String(changeBilled.error), /billed and cannot be changed/)
  assert.equal(removeBilled.success, false)
  assert.match(String(removeBilled.error), /billed and cannot be removed/)
  assert.equal(noIds.success, false)
  assert.match(String(noIds.error), /billed and cannot be replaced/)
  assert.equal(await snapshot(), before, 'no stored row was changed, moved or deleted')
  // An UNBILLED row may still change.
  assert.equal((await updateFreightPoCosts(freight.poId, [line(rows[0]!, 30), line(rows[1]!, 21)])).success, true)
})

test('preview badge: units landed by a WMS alignment count as RECEIVED for the tense', SKIP, async () => {
  loadEnv()
  const { getPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { addAsn } = await import('./po-landed-fixtures')
  const goods = await seedGoodsPo('aligned', 2, 1)
  await seedFreightWithLines(goods.poId, goods.supplierId, [-3])
  const before = (await getPurchaseOrder(goods.poId))?.landedCostFloors[0]?.message ?? ''
  await addAsn(
    { tag: 't', poId: goods.poId, warehouseId: goods.warehouseId, lines: [], binding: {} } as never,
    { poLineId: goods.poLineId, productId: goods.productId, sku: goods.sku, qty: 2 },
    { expectedQty: 2, viaSnapshot: 1 },
  )
  const after = (await getPurchaseOrder(goods.poId))?.landedCostFloors[0]?.message ?? ''
  console.log(`aligned PRECONDITION:\n  before alignment: ${before.slice(0, 120)}\n  after 1 unit aligned (qtyReceived still 0): ${after.slice(0, 260)}`)
  assert.doesNotMatch(before, /\(\d+ received\)/)
  assert.match(after, /\(1 received\)/)
  assert.match(after, /\(1 not yet received\)/)
})
