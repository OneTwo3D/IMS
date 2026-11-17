import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * "Available in purchase orders" warehouse flag, the barcode / supplier SKU carried on PO lines, and the order that
 * already points at a restricted warehouse. Every arm runs the real server actions over a real PostgreSQL.
 * Fixture identity is randomUUID entropy (CI shares one database and these rows stay).
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
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} },
})
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, seedPo, snapshotOf, uid, addAsn, bookIn } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
})

async function warehouse(label: string, availableForPurchaseOrders: boolean) {
  const { db } = await import('@/lib/db')
  return db.warehouse.create({
    data: { code: `${uid()}-${label}`, name: `${label} wh`, type: 'STANDARD', availableForPurchaseOrders },
    select: { id: true, code: true, name: true },
  })
}

async function setFlag(id: string, availableForPurchaseOrders: boolean) {
  const { db } = await import('@/lib/db')
  await db.warehouse.update({ where: { id }, data: { availableForPurchaseOrders } })
}

function createInput(po: fixtures.SeededPo, supplierId: string, destinationWarehouseId?: string) {
  const line = po.lines[0]!
  return {
    supplierId,
    currency: 'GBP',
    destinationWarehouseId,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: [{ productId: line.productId, sku: line.sku, productName: 'flag test', qty: 3, unitCostForeign: 5 }],
  }
}

test('a new warehouse is available in purchase orders by default (additive migration)', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const wh = await db.warehouse.create({ data: { code: `${uid()}-DEF`, name: 'default flag' }, select: { availableForPurchaseOrders: true } })
  assert.equal(wh.availableForPurchaseOrders, true)
})

test('createPurchaseOrder refuses a restricted destination on the server, and accepts an eligible one', SKIP, async () => {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { db } = await import('@/lib/db')
  const po = await seedPo('flag-create', [5])
  const supplierId = (await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { supplierId: true } })).supplierId
  const restricted = await warehouse('RESTR', false)
  const refused = await createPurchaseOrder({ ...createInput(po, supplierId, restricted.id), reference: `${uid()}-refused` })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /is not available for purchase orders, so it cannot be the destination/)
  assert.equal(await db.purchaseOrder.count({ where: { destinationWarehouseId: restricted.id } }), 0, 'nothing was written')
  const ok = await createPurchaseOrder({ ...createInput(po, supplierId, po.warehouseId), reference: `${uid()}-ok` })
  assert.equal(ok.success, true, ok.error)
})

test('updatePurchaseOrder refuses changing the destination to a restricted warehouse, but an unchanged restricted destination still saves', SKIP, async () => {
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { db } = await import('@/lib/db')
  const po = await seedPo('flag-update', [5])
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'DRAFT' } })
  const restricted = await warehouse('RESTR', false)
  const refused = await updatePurchaseOrder(po.poId, { destinationWarehouseId: restricted.id })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /cannot be the destination/)
  assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { destinationWarehouseId: true } })).destinationWarehouseId, po.warehouseId)
  // The order's own warehouse is restricted later: the order stays editable with that destination left as it is.
  await setFlag(po.warehouseId, false)
  const unchanged = await updatePurchaseOrder(po.poId, { destinationWarehouseId: po.warehouseId, notes: 'still editable' })
  assert.equal(unchanged.success, true, unchanged.error)
})

test('createReorderPOs refuses a restricted warehouse as the draft PO destination', SKIP, async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  const restricted = await warehouse('RESTR', false)
  const result = await createReorderPOs([], { filters: { warehouseId: restricted.id } })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /cannot be the destination/)
})

test('receiving into a restricted warehouse that is not the PO destination is refused and moves no stock', SKIP, async () => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('flag-receive-refused', [10])
  const line = po.lines[0]!
  const restricted = await warehouse('QUAR', false)
  const result = await receivePurchaseOrder(po.poId, [{ poLineId: line.poLineId, qtyReceived: 4, warehouseId: restricted.id }], undefined, { confirmWarehouseDivergence: true })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /goods cannot be received into it/)
  const after = await snapshotOf(po, line)
  assert.equal(after.stock, 0)
  assert.equal(after.qtyReceived, 0)
})

test('an existing PO whose destination was restricted later still receives, with a warning', SKIP, async () => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('flag-receive-existing', [10])
  const line = po.lines[0]!
  await setFlag(po.warehouseId, false)
  const result = await receivePurchaseOrder(po.poId, [{ poLineId: line.poLineId, qtyReceived: 4, warehouseId: po.warehouseId }])
  assert.equal(result.success, true, result.error)
  assert.ok((result.warnings ?? []).some((w) => /already pointed at it/.test(w)), 'the operator is warned, not blocked')
  assert.equal((await snapshotOf(po, line)).stock, 4)
})

test('an eligible receipt has no flag warning', SKIP, async () => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('flag-receive-ok', [10])
  const result = await receivePurchaseOrder(po.poId, [{ poLineId: po.lines[0]!.poLineId, qtyReceived: 2, warehouseId: po.warehouseId }])
  assert.equal(result.success, true, result.error)
  assert.equal(result.warnings, undefined)
})

test('a WMS-driven ASN book-in is not affected by the flag: goods land in a restricted warehouse', SKIP, async () => {
  const po = await seedPo('flag-wms', [5])
  const line = po.lines[0]!
  await setFlag(po.warehouseId, false)
  const asn = await addAsn(po, line, { expectedQty: 5 })
  const status = await bookIn(asn, line, 5, 5)
  const after = await snapshotOf(po, line)
  assert.equal(after.qtyReceived, 5, `the book-in (${status}) landed the goods`)
  assert.equal(after.stock, 5)
})

test('the warehouse picker data carries the flag, and the picker helper filters on it', SKIP, async () => {
  const { getWarehouses } = await import('@/app/actions/stock')
  const { selectablePoWarehouses } = await import('@/lib/domain/purchasing/po-warehouse-eligibility')
  const open = await warehouse('PICKOK', true)
  const restricted = await warehouse('PICKNO', false)
  const all = await getWarehouses()
  assert.equal(all.find((w) => w.id === open.id)?.availableForPurchaseOrders, true)
  assert.equal(all.find((w) => w.id === restricted.id)?.availableForPurchaseOrders, false)
  const offered = selectablePoWarehouses(all).map((w) => w.id)
  assert.ok(offered.includes(open.id))
  assert.ok(!offered.includes(restricted.id))
  assert.ok(selectablePoWarehouses(all, restricted.id).some((w) => w.id === restricted.id))
})

test('PO lines carry the product barcode (empty when none) and the supplier SKU comes from the supplier mapping', SKIP, async () => {
  const { getPurchaseOrder, getSupplierLastPrices } = await import('@/app/actions/purchase-orders')
  const { db } = await import('@/lib/db')
  const po = await seedPo('flag-lines', [5, 5])
  const [withCode, without] = po.lines
  const barcode = `${Date.now()}${Math.floor(Math.random() * 1e6)}`
  await db.product.update({ where: { id: withCode!.productId }, data: { barcode } })
  const detail = await getPurchaseOrder(po.poId)
  assert.ok(detail)
  assert.equal(detail.lines.find((l) => l.productId === withCode!.productId)?.barcode, barcode)
  assert.equal(detail.lines.find((l) => l.productId === without!.productId)?.barcode, null)
  await db.supplierProduct.upsert({
    where: { supplierId_productId: { supplierId: detail.supplierId, productId: withCode!.productId } },
    create: { supplierId: detail.supplierId, productId: withCode!.productId, supplierSku: 'SUP-123', lastUnitCost: '5', currency: 'GBP' },
    update: { supplierSku: 'SUP-123' },
  })
  const skus = await getSupplierLastPrices(detail.supplierId)
  assert.equal(skus[withCode!.productId]?.supplierSku, 'SUP-123')
  assert.equal(skus[without!.productId]?.supplierSku ?? null, null, 'a line whose mapping has no supplier SKU reads as empty')
})
