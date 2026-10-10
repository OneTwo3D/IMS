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

  // Revalue with the SAME cost lines through the real recalculation directly.
  const { recalculateLandedCosts, queueLandedCostAdjustmentJournals } = await import('@/lib/domain/purchasing/landed-cost-service')
  const recalculated = await db.$transaction((tx) => recalculateLandedCosts(tx, freight.poId, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  }), { timeout: 60_000, maxWait: 10_000 })
  await queueLandedCostAdjustmentJournals(recalculated)
  // And re-save the freight order with the very same lines through the real action (it matches them by id, edits
  // nothing, and recalculates): receipt and recalculation agree, so this posts nothing either.
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
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
  assert.equal(runs >= 2, true, 'the recalculation really ran (a recalculation that never revalued would prove nothing)')
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

test('credit lines: saving with the dialog payload (credit line echoed back) keeps the credit; omitting it removes it', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('cred', 4, 10)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [20, -5])
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const rows = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, amountForeign: true } })
  const dialogPayload = (positive: number) => [
    { description: rows[0]!.description, amountForeign: positive, vatable: false, distributionMethod: 'BY_VALUE' },
    { description: rows[1]!.description, amountForeign: -5, vatable: false, distributionMethod: 'BY_VALUE' },
  ]
  const saved = await updateFreightPoCosts(freight.poId, dialogPayload(25))
  assert.equal(saved.success, true, String(saved.error))
  const after = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, amountForeign: true } })
  console.log(`credit PRECONDITION: stored ${rows.length} lines (+20, -5); after the dialog save: ${after.map((r) => r.amountForeign.toString()).join(', ')}`)
  assert.deepEqual(after.map((r) => r.amountForeign.toString()), ['25', '-5'])
  // The old dialog dropped the credit, and a save REPLACES the order's lines, so an omitted credit is removed.
  const dropped = await updateFreightPoCosts(freight.poId, [dialogPayload(25)[0]!])
  assert.equal(dropped.success, true, String(dropped.error))
  assert.equal(await db.freightCostLine.count({ where: { poId: freight.poId } }), 1)
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

// ─── The original defect, end to end: an identical re-save of order-sensitive lines changes nothing ──────

test('re-save of IDENTICAL freight lines (order-sensitive fixture, two freight orders, real action, real layers) leaves every layer unchanged and posts nothing', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const { receivePurchaseOrder, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  // The fixture on which summing the cost lines' shares in a different order moves a 6dp unit cost.
  const goods = await seedGoodsPo('rs3', 25, 3.01, [{ qty: 6, unit: 19.58 }, { qty: 8, unit: 6.46 }, { qty: 17, unit: 10.74 }])
  const a = await seedFreightWithLines(goods.poId, goods.supplierId, ['89401.8989', '-27040.1416'], 'PO_SENT', { method: 'BY_QUANTITY' })
  const b = await seedFreightWithLines(goods.poId, goods.supplierId, ['18605.9624'], 'PO_SENT', { method: 'BY_QUANTITY' })
  const poLines = await db.purchaseOrderLine.findMany({ where: { poId: goods.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, qty: true } })
  const received = await receivePurchaseOrder(goods.poId, poLines.map((l) => ({ poLineId: l.id, qtyReceived: Number(l.qty), warehouseId: goods.warehouseId })))
  assert.equal(received.success, true, `PRECONDITION: the receipt must succeed: ${received.error}`)
  const layers = async () => (await db.costLayer.findMany({ where: { poLineId: { in: poLines.map((l) => l.id) } }, orderBy: { poLineId: 'asc' }, select: { poLineId: true, unitCostBase: true } })).map((l) => `${l.poLineId}:${l.unitCostBase}`).join(' ')
  const before = await layers()
  const idsBefore = (await db.freightCostLine.findMany({ where: { poId: { in: [a.poId, b.poId] } }, select: { id: true } })).map((r) => r.id).sort().join()
  const asInput = (amounts: string[]) => amounts.map((amount, index) => ({ description: `freight ${index}`, amountForeign: Number(amount), vatable: false, distributionMethod: 'BY_QUANTITY' }))
  for (let i = 0; i < 6; i += 1) {
    // Alternate which freight order is re-saved FIRST, so the recreated ids interleave in both orders.
    const saveA = () => updateFreightPoCosts(a.poId, asInput(['89401.8989', '-27040.1416']))
    const saveB = () => updateFreightPoCosts(b.poId, asInput(['18605.9624']))
    const one = i % 2 === 0 ? await saveA() : await saveB()
    const two = i % 2 === 0 ? await saveB() : await saveA()
    assert.equal(one.success && two.success, true, `PRECONDITION: the re-save must succeed: ${one.error ?? two.error}`)
  }
  const after = await layers()
  const idsAfter = (await db.freightCostLine.findMany({ where: { poId: { in: [a.poId, b.poId] } }, select: { id: true } })).map((r) => r.id).sort().join()
  const reclass = await journalRows(goods.poId, 'STOCK_IN_TRANSIT')
  const cogs = await journalRows(goods.poId, 'COGS_JOURNAL')
  console.log(`re-save PRECONDITION: 12 identical saves; cost-line ids kept: ${idsBefore === idsAfter}; layers unchanged: ${before === after}; STOCK_IN_TRANSIT rows ${reclass}, COGS_JOURNAL rows ${cogs}`)
  // The re-save used to delete and recreate every cost line, which renumbered the ids (and, on this fixture, moved a
  // 6dp unit cost because shares are summed in id order). Lines are now matched by id and edited in place, so the ids
  // survive: assert it, because "layers unchanged" only means something if the ids really were stable.
  assert.equal(idsBefore === idsAfter, true, 'PRECONDITION: the saves kept the cost-line ids (matched by id, edited in place)')
  assert.equal(after, before, 'every layer cost is byte-identical')
  assert.equal(reclass, 0)
  assert.equal(cogs, 0)
})

// ─── Purchasing money: VAT survives an edit, billed rows are untouchable ─────────────────────────────────

test('VAT: creation records the rate; an edit that sends none KEEPS it; a tax-only edit is a real edit; an unchanged save keeps the line ids; a legacy order is refused, never inferred', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('vat2', 4, 10)
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const { FREIGHT_TAX_RATE_UNKNOWN_MESSAGE } = await import('@/lib/domain/purchasing/freight-cost-lines')
  const created = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: [{ description: 'freight', amountForeign: 100, vatable: true, distributionMethod: 'BY_VALUE' }] })
  assert.equal(created.success, true, String(created.error))
  const poId = created.po!.id
  const header = async () => db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { taxForeign: true, totalForeign: true, taxRatePercent: true } })
  const first = await header()
  console.log(`VAT PRECONDITION: created tax ${first.taxForeign}, stored rate ${first.taxRatePercent}`)
  assert.equal(first.taxForeign.toString(), '20')
  assert.equal(first.taxRatePercent?.toString(), '0.2')

  // The dialog shape for an order with a recorded rate may send NO rate: a real edit (100 -> 110) keeps 20% => tax 22.
  const id = (await db.freightCostLine.findFirstOrThrow({ where: { poId }, select: { id: true } })).id
  const lineAt = (amount: number) => [{ id, description: 'freight', amountForeign: amount, vatable: true, distributionMethod: 'BY_VALUE' }]
  assert.equal((await updateFreightPoCosts(poId, lineAt(110))).success, true)
  const edited = await header()
  console.log(`VAT PRECONDITION: after a real edit with no rate passed: tax ${edited.taxForeign}, total ${edited.totalForeign}`)
  assert.equal(edited.taxForeign.toString(), '22')
  assert.equal(edited.totalForeign.toString(), '132')

  // Unchanged lines, no rate: the stored rate is kept and the cost line keeps its id (it is not deleted and recreated).
  assert.equal((await updateFreightPoCosts(poId, lineAt(110))).success, true)
  const idAfterResave = (await db.freightCostLine.findFirstOrThrow({ where: { poId }, select: { id: true } })).id
  console.log(`VAT PRECONDITION: unchanged re-save: cost line id kept=${idAfterResave === id}, tax ${(await header()).taxForeign}`)
  assert.equal(idAfterResave, id)
  assert.equal((await header()).taxForeign.toString(), '22')

  // Tax-only edit (same lines, new rate): a REAL edit, the totals and the recorded rate move.
  assert.equal((await updateFreightPoCosts(poId, lineAt(110), 0.1)).success, true)
  const taxOnly = await header()
  console.log(`VAT PRECONDITION: tax-only edit to 10%: tax ${taxOnly.taxForeign}, rate ${taxOnly.taxRatePercent}`)
  assert.equal(taxOnly.taxForeign.toString(), '11')
  assert.equal(taxOnly.taxRatePercent?.toString(), '0.1')

  // A legacy order (VAT charged, no rate recorded): a save with no rate is REFUSED and writes nothing; naming the rate works.
  const legacy = await seedFreightWithLines(goods.poId, goods.supplierId, [100], 'PO_SENT', { vatable: true })
  await db.purchaseOrder.update({ where: { id: legacy.poId }, data: { taxForeign: 20, taxBase: 20, totalForeign: 120, totalBase: 120, taxRatePercent: null } })
  const legacyId = (await db.freightCostLine.findFirstOrThrow({ where: { poId: legacy.poId }, select: { id: true } })).id
  const legacyLines = [{ id: legacyId, description: 'freight 0', amountForeign: 150, vatable: true, distributionMethod: 'BY_VALUE' }]
  const refused = await updateFreightPoCosts(legacy.poId, legacyLines)
  const afterRefusal = await db.purchaseOrder.findUniqueOrThrow({ where: { id: legacy.poId }, select: { taxForeign: true, taxRatePercent: true } })
  console.log(`VAT PRECONDITION: legacy order, no rate sent: success=${refused.success}, tax ${afterRefusal.taxForeign}, rate ${afterRefusal.taxRatePercent}`)
  assert.equal(refused.success, false)
  assert.equal(refused.error, FREIGHT_TAX_RATE_UNKNOWN_MESSAGE)
  assert.equal(afterRefusal.taxForeign.toString(), '20')
  assert.equal(afterRefusal.taxRatePercent, null)
  assert.equal((await updateFreightPoCosts(legacy.poId, legacyLines, 0.2)).success, true)
  const legacyAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: legacy.poId }, select: { taxForeign: true, taxRatePercent: true } })
  assert.equal(legacyAfter.taxForeign.toString(), '30')
  assert.equal(legacyAfter.taxRatePercent?.toString(), '0.2')
})

test('billed cost lines: a reordered, removed or id-less submission can neither change, reassign nor delete a row that has been invoiced', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const goods = await seedGoodsPo('billed', 4, 10)
  const freight = await seedFreightWithLines(goods.poId, goods.supplierId, [30, 20])
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const rows = await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, amountForeign: true } })
  const invoice = await db.purchaseInvoice.create({
    data: {
      poId: freight.poId, invoiceDate: new Date(), totalForeign: 30, totalBase: 30, fxRateToBase: 1,
      lines: { create: [{ costLineId: rows[0]!.id, description: 'billed freight', qtyBilled: 1, unitCostForeign: 30, totalForeign: 30, totalBase: 30 }] },
    },
    select: { id: true, lines: { select: { id: true, costLineId: true } } },
  })
  const snapshot = async () => JSON.stringify([
    await db.freightCostLine.findMany({ where: { poId: freight.poId }, orderBy: { id: 'asc' }, select: { id: true, amountForeign: true, description: true } }),
    await db.purchaseInvoiceLine.findMany({ where: { invoiceId: invoice.id }, orderBy: { id: 'asc' }, select: { id: true, costLineId: true } }),
  ])
  const before = await snapshot()
  console.log(`billed PRECONDITION: ${rows.length} cost lines, invoice line ${invoice.lines[0]!.id} points at ${invoice.lines[0]!.costLineId}`)
  assert.equal(invoice.lines[0]!.costLineId, rows[0]!.id)
  const line = (r: (typeof rows)[number], amount: number) => ({ id: r.id, description: r.description, amountForeign: amount, vatable: false, distributionMethod: 'BY_VALUE' })
  const reordered = await updateFreightPoCosts(freight.poId, [line(rows[1]!, 20), line(rows[0]!, 30)])
  const changeBilled = await updateFreightPoCosts(freight.poId, [line(rows[0]!, 31), line(rows[1]!, 20)])
  const removeBilled = await updateFreightPoCosts(freight.poId, [line(rows[1]!, 20)])
  const noIds = await updateFreightPoCosts(freight.poId, [{ description: 'x', amountForeign: 99, vatable: false, distributionMethod: 'BY_VALUE' }])
  console.log(`billed PRECONDITION: reordered=${reordered.success}, change=${JSON.stringify(changeBilled.error)}, remove=${JSON.stringify(removeBilled.error)}, noIds=${JSON.stringify(noIds.error)}`)
  assert.equal(reordered.success, true)
  assert.equal(changeBilled.success, false)
  assert.match(String(changeBilled.error), /billed and cannot be changed/)
  assert.equal(removeBilled.success, false)
  assert.match(String(removeBilled.error), /billed and cannot be removed/)
  assert.equal(noIds.success, false)
  assert.match(String(noIds.error), /billed and cannot be replaced/)
  assert.equal(await snapshot(), before, 'no cost line was changed, moved or deleted and the invoice line still points at its cost line')
  // An UNBILLED row may still change, and the billed row keeps its id and the invoice line its link.
  assert.equal((await updateFreightPoCosts(freight.poId, [line(rows[0]!, 30), line(rows[1]!, 21)])).success, true)
  const link = await db.purchaseInvoiceLine.findUniqueOrThrow({ where: { id: invoice.lines[0]!.id }, select: { costLineId: true } })
  assert.equal(link.costLineId, rows[0]!.id)
})

test('billed order: a VAT-rate change is refused and leaves the order VAT and the bill untouched; the same edit on an unbilled order is allowed', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createFreightPo, updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  const { FREIGHT_BILLED_VAT_CHANGE_MESSAGE } = await import('@/lib/domain/purchasing/freight-cost-lines')
  const make = async (label: string) => {
    const goods = await seedGoodsPo(label, 4, 10)
    const created = await createFreightPo({ supplierId: goods.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [goods.poId], taxRateValue: 0.2, costLines: [{ description: 'freight', amountForeign: 100, vatable: true, distributionMethod: 'BY_VALUE' }] })
    assert.equal(created.success, true, String(created.error))
    const poId = created.po!.id
    const line = await db.freightCostLine.findFirstOrThrow({ where: { poId }, select: { id: true } })
    return { poId, lineId: line.id }
  }
  const payload = (lineId: string) => [{ id: lineId, description: 'freight', amountForeign: 100, vatable: true, distributionMethod: 'BY_VALUE' }]

  const billed = await make('bvat1')
  await db.purchaseInvoice.create({
    data: {
      poId: billed.poId, invoiceDate: new Date(), subtotalForeign: 100, subtotalBase: 100, taxForeign: 20, taxBase: 20, totalForeign: 120, totalBase: 120, fxRateToBase: 1,
      lines: { create: [{ costLineId: billed.lineId, description: 'freight', qtyBilled: 1, unitCostForeign: 100, totalForeign: 100, totalBase: 100 }] },
    },
  })
  const refused = await updateFreightPoCosts(billed.poId, payload(billed.lineId), 0)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: billed.poId }, select: { taxForeign: true, totalForeign: true, taxRatePercent: true } })
  console.log(`billed-vat PRECONDITION: billed order 20% -> 0%: success=${refused.success}; order tax ${po.taxForeign}, total ${po.totalForeign}, rate ${po.taxRatePercent}`)
  assert.equal(refused.success, false)
  assert.equal(refused.error, FREIGHT_BILLED_VAT_CHANGE_MESSAGE)
  assert.equal(po.taxForeign.toString(), '20')
  assert.equal(po.totalForeign.toString(), '120')
  assert.equal(po.taxRatePercent?.toString(), '0.2')

  const open = await make('bvat2')
  const allowed = await updateFreightPoCosts(open.poId, payload(open.lineId), 0)
  const openPo = await db.purchaseOrder.findUniqueOrThrow({ where: { id: open.poId }, select: { taxForeign: true } })
  console.log(`billed-vat PRECONDITION: UNBILLED order 20% -> 0%: success=${allowed.success}; tax ${openPo.taxForeign}`)
  assert.equal(allowed.success, true, String(allowed.error))
  assert.equal(openPo.taxForeign.toString(), '0')
})

test('draft order edit: a DRAFT order that already has a bill refuses a VAT/lines/rate edit and keeps its figures; a header-only edit and an unbilled order are allowed', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { PO_BILLED_FIGURES_EDIT_MESSAGE } = await import('@/lib/domain/purchasing/purchase-invoice-edit')
  const billed = await seedGoodsPo('drbill', 4, 10)
  const unbilled = await seedGoodsPo('drfree', 4, 10)
  for (const po of [billed, unbilled]) await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'DRAFT' } })
  await db.purchaseInvoice.create({ data: { poId: billed.poId, invoiceDate: new Date(), subtotalForeign: 40, subtotalBase: 40, totalForeign: 40, totalBase: 40, fxRateToBase: 1 } })
  const before = await db.purchaseOrder.findUniqueOrThrow({ where: { id: billed.poId }, select: { taxForeign: true, taxRatePercent: true, notes: true } })
  const refused = await updatePurchaseOrder(billed.poId, { taxRateValue: 0.2, taxRateName: 'Std' })
  const afterRefusal = await db.purchaseOrder.findUniqueOrThrow({ where: { id: billed.poId }, select: { taxForeign: true, taxRatePercent: true } })
  console.log(`draft-billed PRECONDITION: billed DRAFT order VAT edit: success=${refused.success} error=${JSON.stringify(refused.error)}; tax ${before.taxForeign} -> ${afterRefusal.taxForeign}`)
  assert.equal(refused.success, false)
  assert.equal(refused.error, PO_BILLED_FIGURES_EDIT_MESSAGE)
  assert.equal(afterRefusal.taxForeign.toString(), before.taxForeign.toString())
  assert.equal(afterRefusal.taxRatePercent, before.taxRatePercent)
  const header = await updatePurchaseOrder(billed.poId, { notes: 'note only' })
  console.log(`draft-billed PRECONDITION: header-only edit success=${header.success}`)
  assert.equal(header.success, true, String(header.error))
  const free = await updatePurchaseOrder(unbilled.poId, { taxRateValue: 0.2, taxRateName: 'Std' })
  console.log(`draft-billed PRECONDITION: UNBILLED draft VAT edit success=${free.success} ${free.error ?? ''}`)
  assert.equal(free.success, true, String(free.error))
})
