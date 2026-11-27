import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * THE CONDITION CHECK ON RETURNS (switch return_condition_check_enabled), through the real server actions and services, against a real
 * PostgreSQL (scratch database). Nothing is sent anywhere: the storefront stock-sync enqueue is replaced, accounting syncs are only
 * returned by the refund service, and the tier has no network.
 *
 *  1. SELLABLE RETURN (unchanged): with the switch on, a sellable return restocks the ordinary warehouse exactly as a return with the
 *     switch off does (stock, return cost layer, movement value).
 *  2. UNSELLABLE RETURN TO QUARANTINE: the unit enters the quarantine warehouse at its return cost layer; it is NOT allocatable (automatic
 *     allocation skips it, a manual allocation is refused), NOT available (product page), NOT pushed (storefront warehouse set), and the
 *     wrong pairings (unsellable to an ordinary warehouse, sellable to quarantine, no condition) are refused with nothing written.
 *     The refund journal is the same whichever warehouse the unit goes to (only the warehouse differs).
 *  3. WRITE-OFF FROM QUARANTINE: the ordinary adjustment flow removes the unit at its quarantine layer's cost, and the journal for that
 *     movement debits the write-off reason's account and credits Inventory.
 *  4. MOVE BACK TO STOCK: the ordinary transfer flow moves the unit out of quarantine and recreates its layer at the same cost.
 *  5. MINTSOFT RETURNS INBOX: the restock dialog's condition is checked against the warehouse the same way.
 *  6. SWITCH OFF IS IDENTICAL: no condition is asked, a return goes to any warehouse, a quarantine-typed warehouse flagged for sale is
 *     allocated from and pushed exactly as before.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const SWITCH = 'return_condition_check_enabled'

let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() { depsPromise ??= loadDepsOnce(); return depsPromise }
async function loadDepsOnce() {
  loadEnv()
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
  mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
  mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
  const realAuth = await import('@/lib/auth/server')
  const session = { user: { id: 'qc-test-user', role: 'ADMIN' } }
  mock.module('@/lib/auth/server', {
    namedExports: {
      ...realAuth,
      requireAuth: async () => session,
      requirePermission: async () => session,
      requireInternalUser: async () => session,
      requireRole: async () => session,
      requireFreshPermission: async () => session,
      freshAuthFailureResult: () => null,
    },
  })
  const [{ db }, sales, allocation, transfers, stock, products, mintsoft, allocationService, wooStock, refundService, adjustment, quarantine] = await Promise.all([
    import('@/lib/db'),
    import('@/app/actions/sales'),
    import('@/app/actions/allocation'),
    import('@/app/actions/transfers'),
    import('@/app/actions/stock'),
    import('@/app/actions/products'),
    import('@/app/actions/mintsoft-sync'),
    import('@/lib/domain/sales/allocation-service'),
    import('@/lib/connectors/woocommerce/sync/stock-sync'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/domain/inventory/stock-adjustment-apply'),
    import('@/lib/domain/inventory/quarantine-warehouse'),
  ])
  return { db, sales, allocation, transfers, stock, products, mintsoft, allocationService, wooStock, refundService, adjustment, quarantine }
}

type World = Awaited<ReturnType<typeof seedWorld>>

async function setSwitch(on: boolean) {
  const { db } = await loadDeps()
  await db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: on ? 'true' : 'false' }, update: { value: on ? 'true' : 'false' } })
}

/** A product shipped on `orders` orders (2 units each, at 45 a unit), a sellable warehouse and a quarantine warehouse. */
async function seedWorld(options: { orders?: number; journaled?: boolean } = {}) {
  const { db } = await loadDeps()
  const tag = uid()
  const D = (value: string) => value
  await db.user.upsert({ where: { id: 'qc-test-user' }, create: { id: 'qc-test-user', email: 'qc-test-user@example.invalid', name: 'qc test user', passwordHash: 'x' }, update: {} })
  const savedSwitch = await db.setting.findUnique({ where: { key: SWITCH } })
  // The shared tier may carry accounting settings an earlier file left (a Xero connector with credit-note posting on arms the posted-VAT
  // fence): the world starts with none and puts them back at teardown. The line also carries its own mapped tax rate, so the refund has a
  // tax identity whichever settings are present.
  const leftover = await db.setting.findMany({ where: { OR: [{ key: { startsWith: 'xero_' } }, { key: 'plugin_xero_enabled' }] } })
  // The restore is registered BEFORE the delete and runs exactly once: from the teardown, or from the catch below when seeding fails part way,
  // so a failed seed never leaves the shared tier without the settings an earlier file left.
  let settingsRestored = false
  const restoreSettings = async () => {
    if (settingsRestored) return
    settingsRestored = true
    await db.setting.deleteMany({ where: { key: { in: leftover.map((r) => r.key) } } })
    for (const r of leftover) await db.setting.create({ data: { key: r.key, value: r.value } })
  }
  await db.setting.deleteMany({ where: { key: { in: leftover.map((r) => r.key) } } })
  try {
  const taxRate = await db.taxRate.create({ data: { name: `QC Zero ${tag}`, rate: '0', usedFor: 'SALES', taxCategory: 'ZERO', accountingTaxType: 'ZERORATEDOUTPUT', active: true }, select: { id: true, name: true } })
  const product = await db.product.create({ data: { sku: `QC-${tag}`, name: `Quarantine ${tag}`, type: 'SIMPLE', oversellAllowed: false }, select: { id: true, sku: true, name: true } })
  const main = await db.warehouse.create({ data: { code: `QM${tag.slice(0, 8)}`, name: `qc main ${tag}`, type: 'STANDARD', availableForSale: true, syncToStore: true }, select: { id: true, code: true } })
  const qar = await db.warehouse.create({ data: { code: `QQ${tag.slice(0, 8)}`, name: `qc quarantine ${tag}`, type: 'QUARANTINE', availableForSale: false, syncToStore: false }, select: { id: true, code: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  const orders: Array<{ orderId: string; lineId: string }> = []
  for (let i = 0; i < (options.orders ?? 1); i += 1) {
    const layer = await db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: D('2'), remainingQty: D('0'), unitCostBase: D('45') }, select: { id: true } })
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `QC-${tag.slice(0, 8)}-${i}`,
        status: 'SHIPPED',
        currency: 'GBP',
        fxRateToBase: D('1'),
        subtotalForeign: D('200'), totalForeign: D('200'), subtotalBase: D('200'), taxBase: D('0'), totalBase: D('200'),
        taxRateName: taxRate.name, taxRatePercent: D('0'),
        ...(options.journaled ? { revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'), unearnedRevenueAmount: D('200') } : {}),
        lines: { create: [{ productId: product.id, sku: product.sku, description: 'qc line', taxRateId: taxRate.id, qty: D('2'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('200'), totalBase: D('200') }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    const lineId = order.lines[0].id
    await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt: new Date(),
        ...(options.journaled ? { shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'), revenueRecognizedAmount: D('200'), cogsBatchAmount: D('90') } : {}),
        lines: { create: [{ lineId, productId: product.id, qty: D('2'), costLayerSnapshot: [{ costLayerId: layer.id, qty: '2', unitCostBase: '45' }] }] },
      },
    })
    orders.push({ orderId: order.id, lineId })
  }
  const extraOrderIds: string[] = []
  const reasonIds: string[] = []
  const inboxIds: string[] = []
  const teardown = async () => {
    const orderIds = [...orders.map((o) => o.orderId), ...extraOrderIds]
    const refundIds = (await db.salesOrderRefund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((r) => r.id)
    for (const id of orderIds) await db.integrationOutbox.deleteMany({ where: { payloadJson: { path: ['orderId'], equals: id } } })
    await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: { in: [...orderIds, ...refundIds] } }] } })
    await db.activityLog.deleteMany({ where: { entityId: { in: [...orderIds, ...refundIds, ...inboxIds, product.id] } } })
    await db.returnExpectationLine.deleteMany({ where: { expectation: { orderId: { in: orderIds } } } })
    await db.returnExpectation.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.wmsReturnsInbox.deleteMany({ where: { id: { in: inboxIds } } })
    const transfers = await db.stockTransfer.findMany({ where: { OR: [{ fromWarehouseId: { in: [main.id, qar.id] } }, { toWarehouseId: { in: [main.id, qar.id] } }] }, select: { id: true } })
    await db.activityLog.deleteMany({ where: { entityId: { in: [...transfers.map((t) => t.id), main.id, qar.id] } } })
    await db.stockTransferLine.deleteMany({ where: { transferId: { in: transfers.map((t) => t.id) } } })
    await db.stockTransfer.deleteMany({ where: { id: { in: transfers.map((t) => t.id) } } })
    await db.cogsEntry.deleteMany({ where: { costLayer: { productId: product.id } } })
    await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId: product.id } } })
    await db.stockMovement.deleteMany({ where: { productId: product.id } })
    await db.costLayer.deleteMany({ where: { productId: product.id } })
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: { in: orderIds } } } })
    await db.salesOrderRefund.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.orderAllocation.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.shipmentLine.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } })
    await db.shipment.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.adjustmentReason.deleteMany({ where: { id: { in: reasonIds } } })
    await db.productionOrder.deleteMany({ where: { warehouseId: { in: [main.id, qar.id] } } })
    await db.bom.deleteMany({ where: { name: `qc bom ${tag}` } })
    await db.product.deleteMany({ where: { id: product.id } })
    await db.externalWmsBinding.deleteMany({ where: { warehouseId: { in: [main.id, qar.id] } } })
    await db.wmsConnection.deleteMany({ where: { label: `qc-${tag}` } })
    await db.warehouse.deleteMany({ where: { id: { in: [main.id, qar.id] } } })
    await db.taxRate.deleteMany({ where: { id: taxRate.id } })
    await restoreSettings()
    await db.setting.deleteMany({ where: { key: SWITCH } })
    if (savedSwitch) await db.setting.create({ data: { key: SWITCH, value: savedSwitch.value } })
    await db.activityLog.deleteMany({ where: { userId: 'qc-test-user' } })
    await db.user.deleteMany({ where: { id: 'qc-test-user' } })
  }
  return { tag, product, main, qar, orders, extraOrderIds, reasonIds, inboxIds, taxRateId: taxRate.id, teardown }
  } catch (error) {
    await restoreSettings()
    throw error
  }
}

function returnLine(w: World, index = 0, qty = 1) {
  const { orderId, lineId } = w.orders[index]
  return { orderId, lines: [{ lineId, productId: w.product.id, description: 'qc line', qty, totalForeign: qty * 100, totalBase: qty * 100, lineKind: 'sale' as const }] }
}

async function stockAt(w: World, warehouseId: string) {
  const { db } = await loadDeps()
  const level = await db.stockLevel.findFirst({ where: { productId: w.product.id, warehouseId }, select: { quantity: true, reservedQty: true } })
  const layers = await db.costLayer.findMany({ where: { productId: w.product.id, warehouseId, remainingQty: { gt: 0 } }, orderBy: { receivedAt: 'asc' }, select: { remainingQty: true, unitCostBase: true, returnMovementId: true } })
  return {
    qty: level ? Number(level.quantity) : 0,
    reserved: level ? Number(level.reservedQty) : 0,
    layers: layers.map((l) => ({ remaining: Number(l.remainingQty), unit: Number(l.unitCostBase), fromReturn: l.returnMovementId != null })),
  }
}

/** A PROCESSING order for one unit of the product, for the allocation arms. */
async function demandOrder(w: World, qty = 1): Promise<string> {
  const { db } = await loadDeps()
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `QD-${w.tag.slice(0, 8)}-${w.extraOrderIds.length}`,
      status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: '100', totalForeign: '100', subtotalBase: '100', taxBase: '0', totalBase: '100',
      lines: { create: [{ productId: w.product.id, sku: w.product.sku, description: 'qc demand', taxRateId: w.taxRateId, qty: String(qty), unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '0', taxBase: '0', totalForeign: String(100 * qty), totalBase: String(100 * qty) }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  w.extraOrderIds.push(order.id)
  return order.id
}

test('sellable return with the switch on is the return of before: same warehouse, stock, layer and movement value', SKIP, async (t) => {
  const w = await seedWorld({ orders: 2 })
  t.after(() => w.teardown())
  const { db, sales } = await loadDeps()

  await setSwitch(false)
  const off = returnLine(w, 0)
  const before = await sales.createRefund(off.orderId, off.lines, 'qc return', w.main.id)
  assert.equal(before.success, true, before.error)
  const offMovement = await db.stockMovement.findFirstOrThrow({ where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', productId: w.product.id }, select: { toWarehouseId: true, qty: true, unitCostBase: true, totalValueBase: true } })

  await setSwitch(true)
  const missing = returnLine(w, 1)
  const refused = await sales.createRefund(missing.orderId, missing.lines, 'qc return', w.main.id)
  assert.equal(refused.success, false, 'with the switch on, an operator restock states the condition')
  assert.match(refused.error ?? '', /condition/)
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: missing.orderId } }), 0, 'nothing recorded')

  const on = await sales.createRefund(missing.orderId, missing.lines, 'qc return', w.main.id, { returnCondition: 'SELLABLE' })
  assert.equal(on.success, true, on.error)
  const movements = await db.stockMovement.findMany({ where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', productId: w.product.id }, orderBy: { createdAt: 'asc' }, select: { toWarehouseId: true, qty: true, unitCostBase: true, totalValueBase: true } })
  assert.equal(movements.length, 2)
  assert.deepEqual(
    { ...movements[1], qty: Number(movements[1].qty), unitCostBase: Number(movements[1].unitCostBase), totalValueBase: Number(movements[1].totalValueBase) },
    { ...offMovement, qty: Number(offMovement.qty), unitCostBase: Number(offMovement.unitCostBase), totalValueBase: Number(offMovement.totalValueBase) },
    'the sellable return books the movement the switch-off return booked',
  )
  assert.deepEqual(await stockAt(w, w.main.id), { qty: 2, reserved: 0, layers: [{ remaining: 1, unit: 45, fromReturn: true }, { remaining: 1, unit: 45, fromReturn: true }] })
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 0, reserved: 0, layers: [] })
  const audit = await db.activityLog.findFirstOrThrow({ where: { entityId: missing.orderId, action: 'refunded' }, select: { metadata: true } })
  assert.equal((audit.metadata as { returnCondition?: string }).returnCondition, 'SELLABLE', 'the condition is recorded')
  const offAudit = await db.activityLog.findFirstOrThrow({ where: { entityId: off.orderId, action: 'refunded' }, select: { metadata: true } })
  assert.equal('returnCondition' in (offAudit.metadata as object), false, 'with the switch off the audit entry is the one of before')
})

test('unsellable return goes to quarantine at its cost; it is not allocatable, not available and not pushed; wrong pairings are refused', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, sales, allocation, allocationService, wooStock, products, quarantine } = await loadDeps()
  await setSwitch(true)
  const r = returnLine(w, 0)

  const intoMain = await sales.createRefund(r.orderId, r.lines, 'qc return', w.main.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(intoMain.success, false)
  assert.match(intoMain.error ?? '', /is not one/)
  const sellableIntoQar = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'SELLABLE' })
  assert.equal(sellableIntoQar.success, false)
  assert.match(sellableIntoQar.error ?? '', /quarantine warehouse/)
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: r.orderId } }), 0, 'refusals write nothing')

  const result = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(result.success, true, result.error)
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 1, reserved: 0, layers: [{ remaining: 1, unit: 45, fromReturn: true }] }, 'in quarantine at the return cost layer')
  assert.deepEqual(await stockAt(w, w.main.id), { qty: 0, reserved: 0, layers: [] })
  const movement = await db.stockMovement.findFirstOrThrow({ where: { type: 'RETURN_INBOUND', productId: w.product.id }, select: { toWarehouseId: true, totalValueBase: true } })
  assert.equal(movement.toWarehouseId, w.qar.id)
  assert.equal(Number(movement.totalValueBase), 45)

  // NOT ALLOCATABLE: automatic allocation skips quarantine (even when its flags are wrongly set), a manual allocation is refused.
  await db.warehouse.update({ where: { id: w.qar.id }, data: { availableForSale: true, syncToStore: true } })
  const demand = await demandOrder(w)
  await allocationService.allocateSalesOrder(db, { orderId: demand })
  assert.equal(await db.orderAllocation.count({ where: { orderId: demand, warehouseId: w.qar.id } }), 0, 'automatic allocation never takes quarantine stock')
  const line = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: demand }, select: { id: true } })
  const manual = await allocation.addAllocation(demand, line.id, w.product.id, w.qar.id, 1)
  assert.equal(manual.success, false)
  assert.equal(manual.error, quarantine.QUARANTINE_ALLOCATION_REFUSAL)
  assert.equal(await db.orderAllocation.count({ where: { orderId: demand } }), 0)
  assert.equal((await stockAt(w, w.qar.id)).reserved, 0)

  // NOT PUSHED: the storefront's warehouse set leaves quarantine out even when it is flagged to sync.
  const pushed = (await wooStock.loadStorefrontStockWarehouses(db)).map((row) => row.id)
  assert.equal(pushed.includes(w.qar.id), false, 'quarantine stock is never pushed to the store')
  assert.equal(pushed.includes(w.main.id), true)

  // NOT AVAILABLE: on hand, but not available, and the warehouse is marked.
  const detail = await products.getProduct(w.product.id)
  assert.equal(detail?.totalStock, '1.00')
  assert.equal(detail?.availableStock, '0.00')
  const row = detail?.stockByWarehouse.find((s) => s.warehouseId === w.qar.id)
  assert.equal(row?.quarantine, true)
  assert.equal(row?.availableQty, '0.00')

  // The settings refuse the sellable flags on a quarantine warehouse while the switch is on.
  const { updateWarehouse } = await import('@/app/actions/settings')
  const saved = await updateWarehouse(w.qar.id, { code: w.qar.code, name: 'qc quarantine', type: 'QUARANTINE', country: 'GB', availableForSale: true, availableForPurchaseOrders: false, syncToStore: false, isDefault: false, defaultReturnWarehouse: false, active: true })
  assert.equal(saved.success, false)
  assert.match(saved.error ?? '', /Available for sale/)
})

test('the refund journal is the same whichever warehouse the unit goes to: quarantining moves no value', SKIP, async (t) => {
  const w = await seedWorld({ orders: 2, journaled: true })
  t.after(() => w.teardown())
  const { db, refundService } = await loadDeps()
  const accountingSettings = {
    connector: 'xero', syncEnabled: true, salesAccount: '4000', shippingAccount: '4010', discountAccount: '', cogsAccount: '5000', inventoryRevaluationAccount: '',
    inventoryAccount: '1200', allocatedInventoryAccount: '1210', unearnedRevenueAccount: '2100', transitAccount: '', accountsReceivableAccount: '', accountsPayableAccount: '',
    realisedFxGainLossAccount: '', unrealisedFxGainLossAccount: '', manufacturingOverheadAccount: '', euVatIossAccount: '', euVatDdpAccount: '', euFeeAccount: '',
    roundingDifferenceAccount: '', paymentAccountMap: '{}', invoiceUrlTemplate: '', billUrlTemplate: '', reverseChargeSalesTaxType: '',
  } as never
  const journalOf = async (index: number, warehouseId: string) => {
    const r = returnLine(w, index)
    const result = await refundService.createSalesOrderRefund(db, { orderId: r.orderId, lines: r.lines, reason: 'qc', returnWarehouseId: warehouseId, creditNotePrefix: `QC${index}${w.tag.slice(0, 4)}-`, accountingSettings })
    assert.equal(result.success, true, result.success ? '' : result.error)
    const syncs = (result as unknown as { accountingSyncs: Array<{ type: string; payload: { lines: Array<{ accountCode: string; debit?: number; credit?: number }> } }> }).accountingSyncs
    return syncs.filter((s) => s.type === 'COGS_REVERSAL').map((s) => s.payload.lines.map((l) => ({ account: l.accountCode, debit: l.debit ?? 0, credit: l.credit ?? 0 })))
  }
  const ordinary = await journalOf(0, w.main.id)
  const quarantined = await journalOf(1, w.qar.id)
  assert.ok(ordinary.length > 0, 'the return reverses COGS')
  assert.deepEqual(quarantined, ordinary, 'the same journal, only the warehouse differs')
  assert.deepEqual((await stockAt(w, w.qar.id)).layers, [{ remaining: 1, unit: 45, fromReturn: true }])
})

test('write-off from quarantine: the ordinary adjustment removes the unit at its layer cost; the journal is Dr write-off / Cr Inventory', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, sales, stock, adjustment } = await loadDeps()
  await setSwitch(true)
  const r = returnLine(w, 0)
  assert.equal((await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })).success, true)

  const reason = await db.adjustmentReason.create({ data: { name: `QC write-off ${w.tag}`, accountCode: '5150', active: true }, select: { id: true } })
  w.reasonIds.push(reason.id)
  const form = new FormData()
  form.set('productId', w.product.id)
  form.set('warehouseId', w.qar.id)
  form.set('qty', '-1')
  form.set('reasonId', reason.id)
  form.set('note', 'damaged return')
  const state = await stock.adjustStock({} as never, form)
  assert.equal((state as { errors?: unknown }).errors, undefined, JSON.stringify(state))
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 0, reserved: 0, layers: [] }, 'written off: nothing left in quarantine')
  const writeOff = await db.stockMovement.findFirstOrThrow({ where: { type: 'ADJUSTMENT', productId: w.product.id, fromWarehouseId: w.qar.id }, select: { qty: true, totalValueBase: true } })
  assert.equal(Number(writeOff.totalValueBase), 45, 'at the quarantine layer cost (FIFO)')
  const journal = adjustment.buildInventoryAdjustmentJournal({ reasonAccountCode: '5150', inventoryAccountCode: '1200', productSku: w.product.sku, productName: w.product.name, warehouseCode: w.qar.code, warehouseName: 'qc quarantine', qty: -1, totalValueBase: Number(writeOff.totalValueBase), note: null })
  assert.deepEqual(journal?.lines.map((l) => ({ account: l.accountCode, debit: l.debit ?? 0, credit: l.credit ?? 0 })), [{ account: '5150', debit: 45, credit: 0 }, { account: '1200', debit: 0, credit: 45 }])
})

test('move back to stock: the ordinary transfer takes the unit out of quarantine and recreates its layer at the same cost', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, sales, transfers, wooStock, allocationService } = await loadDeps()
  await setSwitch(true)
  const r = returnLine(w, 0)
  assert.equal((await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })).success, true)

  const created = await transfers.createTransfer(w.qar.id, w.main.id, [{ productId: w.product.id, sku: w.product.sku, productName: w.product.name, qty: 1 }], 'back to stock')
  assert.equal(created.success, true, created.message)
  const id = created.transfer!.id
  assert.equal((await transfers.dispatchTransfer(id)).success, true)
  const received = await transfers.receiveTransfer(id)
  assert.equal(received.success, true, received.message)
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 0, reserved: 0, layers: [] })
  const main = await stockAt(w, w.main.id)
  assert.equal(main.qty, 1)
  assert.deepEqual(main.layers.map((l) => ({ remaining: l.remaining, unit: l.unit })), [{ remaining: 1, unit: 45 }], 'the FIFO cost moved with the unit')
  assert.equal((await wooStock.loadStorefrontStockWarehouses(db)).some((row) => row.id === w.main.id), true)
  const demand = await demandOrder(w)
  await allocationService.allocateSalesOrder(db, { orderId: demand })
  assert.equal(await db.orderAllocation.count({ where: { orderId: demand, warehouseId: w.main.id } }), 1, 'back in stock: allocatable again')
})

test('Mintsoft returns inbox: an unsellable unit held at the 3PL is never quarantined, so alignment cannot hold it twice', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, mintsoft, quarantine } = await loadDeps()
  await setSwitch(true)
  // The bound warehouse is aligned to Mintsoft (Mintsoft is the stock master): Mintsoft's count of the returned unit is booked into it.
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `qc-${w.tag}` }, select: { id: true } })
  await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: w.main.id, connector: 'mintsoft', externalWarehouseId: `qc-ext-${w.tag}`, stockSyncMode: 'ALIGN_TO_WMS', stockMasterSystem: 'WMS' } })
  // A costed unit elsewhere, so the unpriced inbox row is valued at an average (orderless return).
  await db.costLayer.create({ data: { productId: w.product.id, warehouseId: w.main.id, receivedQty: '1', remainingQty: '1', unitCostBase: '45' } })
  await db.stockLevel.update({ where: { productId_warehouseId: { productId: w.product.id, warehouseId: w.main.id } }, data: { quantity: '1' } })
  const inbox = await db.wmsReturnsInbox.create({ data: { connector: 'mintsoft', externalReturnId: `QC-RET-${w.tag}`, productId: w.product.id, sku: w.product.sku, qty: 1, status: 'NEW' } as never, select: { id: true } })
  w.inboxIds.push(inbox.id)

  const noCondition = await mintsoft.restockMintsoftReturnInboxItem({ id: inbox.id, warehouseId: w.main.id })
  assert.equal(noCondition.success, false)
  assert.match(noCondition.error ?? '', /condition/)
  for (const warehouseId of [w.qar.id, w.main.id]) {
    const unsellable = await mintsoft.restockMintsoftReturnInboxItem({ id: inbox.id, warehouseId, condition: 'UNSELLABLE' })
    assert.equal(unsellable.success, false, 'an unsellable unit at the 3PL is refused into any warehouse')
    assert.equal(unsellable.error, quarantine.WMS_UNSELLABLE_RETURN_REFUSAL)
  }
  assert.equal((await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: inbox.id }, select: { status: true } })).status, 'NEW', 'refused: nothing restocked')
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 0, reserved: 0, layers: [] }, 'nothing entered quarantine, so Mintsoft\'s count of the unit (aligned into the bound warehouse) is the only one')
  assert.equal(await db.stockMovement.count({ where: { productId: w.product.id, toWarehouseId: w.qar.id } }), 0)

  const sellableIntoQar = await mintsoft.restockMintsoftReturnInboxItem({ id: inbox.id, warehouseId: w.qar.id, condition: 'SELLABLE' })
  assert.equal(sellableIntoQar.success, false)
  assert.match(sellableIntoQar.error ?? '', /quarantine warehouse/)
  const ok = await mintsoft.restockMintsoftReturnInboxItem({ id: inbox.id, warehouseId: w.main.id, condition: 'SELLABLE' })
  assert.equal(ok.success, true, ok.error)
  assert.equal((await stockAt(w, w.main.id)).qty, 2)
  const row = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: inbox.id }, select: { status: true, resolutionNote: true } })
  assert.equal(row.status, 'RESTOCKED')
  assert.match(row.resolutionNote ?? '', /condition: sellable/)
})

test('refund dialog: an unsellable return of units shipped from a 3PL (WMS-bound warehouse, or an order the WMS holds) is refused before any write', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(async () => {
    const { db } = await loadDeps()
    await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: w.orders.map((o) => o.orderId) } } })
    await w.teardown()
  })
  const { db, sales, quarantine } = await loadDeps()
  await setSwitch(true)
  const r = returnLine(w, 0)
  const nothingWritten = async () => {
    assert.equal(await db.salesOrderRefund.count({ where: { orderId: r.orderId } }), 0, 'refused: no refund')
    assert.deepEqual(await stockAt(w, w.qar.id), { qty: 0, reserved: 0, layers: [] }, 'refused: nothing in quarantine')
  }

  // The order shipped from MAIN, and MAIN is bound to the warehouse system (aligned to it).
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `qc-${w.tag}` }, select: { id: true } })
  const binding = await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: w.main.id, connector: 'mintsoft', externalWarehouseId: `qc-ext-${w.tag}`, stockSyncMode: 'ALIGN_TO_WMS', stockMasterSystem: 'WMS' }, select: { id: true } })
  const bound = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(bound.success, false)
  assert.equal(bound.error, quarantine.WMS_UNSELLABLE_REFUND_REFUSAL)
  await nothingWritten()

  // No binding, but the warehouse system holds the order (a SYNCED push link): refused the same way.
  await db.externalWmsBinding.delete({ where: { id: binding.id } })
  await db.wmsOrderPushLink.create({ data: { orderId: r.orderId, connector: 'mintsoft', state: 'SYNCED' } })
  const pushed = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(pushed.success, false)
  assert.equal(pushed.error, quarantine.WMS_UNSELLABLE_REFUND_REFUSAL)
  await nothingWritten()

  // Control: neither, the same unsellable return is quarantined.
  await db.wmsOrderPushLink.deleteMany({ where: { orderId: r.orderId } })
  const own = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(own.success, true, own.error)
  assert.equal((await stockAt(w, w.qar.id)).qty, 1)
})

test('a warehouse with sellable work cannot become a quarantine warehouse; an allocation is never grown in quarantine; forecasts leave quarantine out', SKIP, async (t) => {
  const w = await seedWorld({ orders: 2 })
  t.after(() => w.teardown())
  const { db, sales, allocation, allocationService } = await loadDeps()
  const { updateWarehouse } = await import('@/app/actions/settings')
  const { generateForecasts } = await import('@/app/actions/forecasting')
  const asWarehouse = (id: string, code: string, type: 'STANDARD' | 'QUARANTINE', flags: { availableForSale: boolean; syncToStore: boolean }) =>
    updateWarehouse(id, { code, name: `qc ${code}`, type, country: 'GB', ...flags, availableForPurchaseOrders: false, isDefault: false, defaultReturnWarehouse: false, active: true })

  // Stock in MAIN and an order allocated from it.
  await setSwitch(false)
  const r = returnLine(w, 0)
  assert.equal((await sales.createRefund(r.orderId, r.lines, 'qc return', w.main.id)).success, true)
  const demand = await demandOrder(w)
  await allocationService.allocateSalesOrder(db, { orderId: demand })
  assert.equal(await db.orderAllocation.count({ where: { orderId: demand, warehouseId: w.main.id } }), 1)

  await setSwitch(true)
  const refused = await asWarehouse(w.main.id, w.main.code, 'QUARANTINE', { availableForSale: false, syncToStore: false })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /1 open allocation/)
  assert.equal((await db.warehouse.findUniqueOrThrow({ where: { id: w.main.id }, select: { type: true } })).type, 'STANDARD')

  // An allocation already sitting in a quarantine-typed warehouse (made while the switch was off) may shrink, never grow.
  await setSwitch(false)
  await db.orderAllocation.deleteMany({ where: { orderId: demand } })
  await db.stockLevel.update({ where: { productId_warehouseId: { productId: w.product.id, warehouseId: w.main.id } }, data: { reservedQty: '0' } })
  const t2 = returnLine(w, 1, 2)
  const intoQar = await sales.createRefund(t2.orderId, t2.lines, 'qc return', w.qar.id)
  assert.equal(intoQar.success, true, intoQar.error)
  const demand2 = await demandOrder(w, 2)
  const line = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: demand2 }, select: { id: true } })
  const legacy = await allocation.addAllocation(demand2, line.id, w.product.id, w.qar.id, 1)
  assert.equal(legacy.success, true, `switch off: allowed, as before (${legacy.error})`)
  const held = await db.orderAllocation.findFirstOrThrow({ where: { orderId: demand2, warehouseId: w.qar.id }, select: { id: true } })
  await setSwitch(true)
  const grow = await allocation.updateAllocation(held.id, w.qar.id, 2)
  assert.equal(grow.success, false, 'growing an allocation in quarantine is refused (the stock is there: 2 units)')
  assert.match(grow.error ?? '', /quarantine/)
  const release = await allocation.updateAllocation(held.id, w.qar.id, 0)
  assert.equal(release.success, true, release.error)

  // Forecasts: the quarantine units are not available stock.
  await db.orderAllocation.deleteMany({ where: { orderId: { in: [demand, demand2] } } })
  await db.stockLevel.updateMany({ where: { productId: w.product.id }, data: { reservedQty: '0' } })
  const forecastOn = (await generateForecasts()).find((f) => f.productId === w.product.id)
  await setSwitch(false)
  const forecastOff = (await generateForecasts()).find((f) => f.productId === w.product.id)
  assert.equal(forecastOff?.availableStock, 3, 'off: both warehouses count, as before')
  assert.equal(forecastOn?.availableStock, 1, 'on: the quarantine units are not available')
})

test('before switch-on: the interlock, the type change both ways, production in quarantine, the stock reports and returns in transit', SKIP, async (t) => {
  const w = await seedWorld({ orders: 2 })
  t.after(() => w.teardown())
  const { db, sales, quarantine } = await loadDeps()
  const { updateWarehouse } = await import('@/app/actions/settings')
  const { updateManufacturingOrderStatus } = await import('@/app/actions/manufacturing')
  const { getStockOnHand } = await import('@/app/actions/inventory-stats')
  const { getStockOnHandReport } = await import('@/lib/domain/inventory/stock-position-reports')
  const save = (id: string, code: string, type: 'STANDARD' | 'QUARANTINE', flags: Partial<{ availableForSale: boolean; syncToStore: boolean; availableForPurchaseOrders: boolean; defaultReturnWarehouse: boolean }> = {}) =>
    updateWarehouse(id, { code, name: `qc ${code}`, type, country: 'GB', availableForSale: false, syncToStore: false, availableForPurchaseOrders: false, isDefault: false, defaultReturnWarehouse: false, active: true, ...flags })

  // THE INTERLOCK: the seeded quarantine warehouse is still "available in purchase orders" (the column default), so turning the switch on is refused.
  await setSwitch(false)
  const refusal = await quarantine.quarantineSwitchOnRefusal(db)
  assert.match(refusal ?? '', new RegExp(`${w.qar.code} \\(marked Available in purchase orders`))
  assert.equal((await save(w.qar.id, w.qar.code, 'QUARANTINE')).success, true)
  const others = (await quarantine.listQuarantineWarehouseIssues(db)).filter((i) => i.id !== w.qar.id)
  assert.equal((await quarantine.listQuarantineWarehouseIssues(db)).some((i) => i.id === w.qar.id), false, 'clean once its flags are cleared')
  if (others.length === 0) assert.equal(await quarantine.quarantineSwitchOnRefusal(db), null)

  // INTO QUARANTINE is refused whatever the switch, here with it OFF: a transfer in transit into MAIN is sellable work.
  const transfer = await db.stockTransfer.create({ data: { reference: `QC-T-${w.tag}`, fromWarehouseId: w.qar.id, toWarehouseId: w.main.id, status: 'IN_TRANSIT' }, select: { id: true } })
  const into = await save(w.main.id, w.main.code, 'QUARANTINE')
  assert.equal(into.success, false)
  assert.match(into.error ?? '', /1 transfer\(s\) in transit into it/)
  await db.stockTransfer.delete({ where: { id: transfer.id } })

  // L1: with the switch on, a quarantine warehouse may not be the default return warehouse.
  await setSwitch(true)
  const asDefaultReturn = await save(w.qar.id, w.qar.code, 'QUARANTINE', { defaultReturnWarehouse: true })
  assert.equal(asDefaultReturn.success, false)
  assert.match(asDefaultReturn.error ?? '', /Default return warehouse/)

  // OUT OF QUARANTINE (switch on) is refused while it holds stock.
  const r = returnLine(w, 0)
  assert.equal((await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })).success, true)
  const out = await save(w.qar.id, w.qar.code, 'STANDARD')
  assert.equal(out.success, false)
  assert.match(out.error ?? '', /still holds 1 unit/)
  assert.match(out.error ?? '', /write units off with a stock adjustment/)
  assert.match(out.error ?? '', /transfer/)
  assert.equal((await db.warehouse.findUniqueOrThrow({ where: { id: w.qar.id }, select: { type: true } })).type, 'QUARANTINE')

  // STOCK REPORTS (switch on): the quarantine row is on hand, 0 available.
  const onHand = (await getStockOnHand()).find((row) => row.productId === w.product.id && row.warehouseCode === w.qar.code)
  assert.equal(onHand?.quantity, 1)
  assert.equal(onHand?.available, 0)
  const report = await getStockOnHandReport({ warehouseId: w.qar.id }, { paginate: false })
  const reportRow = report.rows.find((row) => row.productId === w.product.id)
  assert.equal(Number(reportRow?.quantity), 1)
  assert.equal(Number(reportRow?.availableQty), 0)

  // L7: a production order in a quarantine warehouse is neither started nor completed.
  const bom = await db.bom.create({ data: { name: `qc bom ${w.tag}` }, select: { id: true } })
  const mo = await db.productionOrder.create({ data: { reference: `QC-MO-${w.tag}`, bomId: bom.id, outputProductId: w.product.id, warehouseId: w.qar.id, qtyPlanned: '1', status: 'DRAFT' }, select: { id: true } })
  for (const status of ['IN_PROGRESS', 'COMPLETED'] as const) {
    const moved = await updateManufacturingOrderStatus(mo.id, status)
    assert.equal(moved.success, false)
    assert.equal(moved.error, quarantine.QUARANTINE_PRODUCTION_REFUSAL)
  }
  assert.equal((await db.productionOrder.findUniqueOrThrow({ where: { id: mo.id }, select: { status: true } })).status, 'DRAFT')

  // M4: with returns in transit on, the refund asks no condition and may not expect the units in quarantine.
  const transitKey = 'refund_returns_in_transit_enabled'
  const savedTransit = await db.setting.findUnique({ where: { key: transitKey } })
  t.after(async () => {
    await db.setting.deleteMany({ where: { key: transitKey } })
    if (savedTransit) await db.setting.create({ data: { key: transitKey, value: savedTransit.value } })
  })
  await db.setting.upsert({ where: { key: transitKey }, create: { key: transitKey, value: 'true' }, update: { value: 'true' } })
  const r2 = returnLine(w, 1)
  const expectQar = await sales.createRefund(r2.orderId, r2.lines, 'qc return', w.qar.id, { returnCondition: 'UNSELLABLE' })
  assert.equal(expectQar.success, false)
  assert.equal(expectQar.error, quarantine.QUARANTINE_IN_TRANSIT_EXPECTED_REFUSAL)
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: r2.orderId } }), 0)
  const plain = await sales.createRefund(r2.orderId, r2.lines, 'qc return', w.main.id)
  assert.equal(plain.success, true, `no condition is asked while returns are in transit (${plain.error})`)
  const audit = await db.activityLog.findFirstOrThrow({ where: { entityId: r2.orderId, action: 'refunded' }, select: { metadata: true } })
  assert.equal('returnCondition' in (audit.metadata as object), false, 'and none is recorded')
})

test('open allocations are counted by residual: a warehouse whose only allocation shipped in full can become Quarantine; an inbound transfer blocks only the type change', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, quarantine } = await loadDeps()
  const { updateWarehouse } = await import('@/app/actions/settings')
  const save = (type: 'STANDARD' | 'QUARANTINE') =>
    updateWarehouse(w.main.id, { code: w.main.code, name: 'qc main', type, country: 'GB', availableForSale: false, syncToStore: false, availableForPurchaseOrders: false, isDefault: false, defaultReturnWarehouse: false, active: true })
  await setSwitch(false)
  // The seeded order shipped both units from MAIN; its allocation row survives dispatch with qty 2.
  const { orderId, lineId } = w.orders[0]
  const allocation = await db.orderAllocation.create({ data: { orderId, lineId, productId: w.product.id, warehouseId: w.main.id, qty: '2' }, select: { id: true } })
  assert.equal(await quarantine.countOpenAllocations(db, w.main.id), 0, 'fully shipped: nothing is still reserved')
  // A residual (3 allocated, 2 shipped) is still open and blocks.
  await db.orderAllocation.update({ where: { id: allocation.id }, data: { qty: '3' } })
  assert.equal(await quarantine.countOpenAllocations(db, w.main.id), 1)
  const blocked = await save('QUARANTINE')
  assert.equal(blocked.success, false)
  assert.match(blocked.error ?? '', /1 open allocation/)
  await db.orderAllocation.update({ where: { id: allocation.id }, data: { qty: '2' } })
  const ok = await save('QUARANTINE')
  assert.equal(ok.success, true, `a warehouse whose only allocation shipped in full can become Quarantine (${ok.error})`)

  // Transferring damaged stock INTO a quarantine warehouse is normal: an in-transit transfer into it is not an issue for the switch-on census.
  const transfer = await db.stockTransfer.create({ data: { reference: `QC-T2-${w.tag}`, fromWarehouseId: w.qar.id, toWarehouseId: w.main.id, status: 'IN_TRANSIT' }, select: { id: true } })
  t.after(() => db.stockTransfer.deleteMany({ where: { id: transfer.id } }))
  assert.equal((await quarantine.listQuarantineWarehouseIssues(db)).some((i) => i.id === w.main.id), false)
  // ...but it still blocks turning another warehouse into Quarantine (the type change counts it).
  assert.equal((await quarantine.loadQuarantineBlockers(db, w.main.id)).inboundTransfers, 1)
  assert.equal((await quarantine.loadQuarantineBlockers(db, w.main.id, { inboundTransfers: false })).inboundTransfers, 0)
  assert.equal((await save('STANDARD')).success, true, 'switch off: leaving quarantine is not checked')
})

test('switch off is identical: no condition, any warehouse, and a quarantine-typed warehouse flagged for sale behaves as before', SKIP, async (t) => {
  const w = await seedWorld({ orders: 1 })
  t.after(() => w.teardown())
  const { db, sales, allocation, allocationService, wooStock, products } = await loadDeps()
  await setSwitch(false)
  // A condition sent with the switch off is ignored, and a return into the quarantine-typed warehouse needs none.
  const r = returnLine(w, 0)
  const result = await sales.createRefund(r.orderId, r.lines, 'qc return', w.qar.id, { returnCondition: 'SELLABLE' })
  assert.equal(result.success, true, result.error)
  assert.deepEqual(await stockAt(w, w.qar.id), { qty: 1, reserved: 0, layers: [{ remaining: 1, unit: 45, fromReturn: true }] })
  const audit = await db.activityLog.findFirstOrThrow({ where: { entityId: r.orderId, action: 'refunded' }, select: { metadata: true } })
  assert.equal('returnCondition' in (audit.metadata as object), false)

  // Flags decide, as before: a QUARANTINE-typed warehouse flagged for sale and sync is allocated from and pushed.
  await db.warehouse.update({ where: { id: w.qar.id }, data: { availableForSale: true, syncToStore: true } })
  assert.equal((await wooStock.loadStorefrontStockWarehouses(db)).some((row) => row.id === w.qar.id), true, 'pushed, as before')
  const detail = await products.getProduct(w.product.id)
  assert.equal(detail?.availableStock, '1.00', 'counted as available, as before')
  assert.equal(detail?.stockByWarehouse.find((s) => s.warehouseId === w.qar.id)?.quarantine, undefined)
  const demand = await demandOrder(w)
  await allocationService.allocateSalesOrder(db, { orderId: demand })
  assert.equal(await db.orderAllocation.count({ where: { orderId: demand, warehouseId: w.qar.id } }), 1, 'allocated, as before')
  await db.orderAllocation.deleteMany({ where: { orderId: demand } })
  await db.stockLevel.update({ where: { productId_warehouseId: { productId: w.product.id, warehouseId: w.qar.id } }, data: { reservedQty: '0' } })
  const line = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: demand }, select: { id: true } })
  const manual = await allocation.addAllocation(demand, line.id, w.product.id, w.qar.id, 1)
  assert.equal(manual.success, true, manual.error)
  // And the settings accept the flags, as before.
  const { updateWarehouse } = await import('@/app/actions/settings')
  const saved = await updateWarehouse(w.qar.id, { code: w.qar.code, name: 'qc quarantine', type: 'QUARANTINE', country: 'GB', availableForSale: true, availableForPurchaseOrders: false, syncToStore: true, isDefault: false, defaultReturnWarehouse: false, active: true })
  assert.equal(saved.success, true, saved.error)
})
