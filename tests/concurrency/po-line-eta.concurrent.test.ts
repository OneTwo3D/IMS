import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * PER-LINE ETA over a real PostgreSQL: a part receipt must not clear or overwrite a line's own delivery date, and an amend of a
 * received line may change it. Drives the REAL createPurchaseOrder / receivePurchaseOrder / updatePurchaseOrder / getPurchaseOrder.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, seedPo, receive } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

test('a part receipt keeps the line date; an amend can change it; blank goes back to the header date', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { updatePurchaseOrder, getPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('eta', [10, 10])
  const header = new Date('2026-12-01T00:00:00.000Z')
  const own = new Date('2026-12-20T00:00:00.000Z')
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { expectedDelivery: header } })
  await db.purchaseOrderLine.update({ where: { id: po.lines[0]!.poLineId }, data: { expectedDelivery: own } })

  const received = await receive(po, po.lines[0]!, 4)
  assert.equal(received.success, true, String(received.error))

  const stored = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, orderBy: { sortOrder: 'asc' }, select: { expectedDelivery: true, qtyReceived: true } })
  assert.equal(Number(stored[0]!.qtyReceived), 4)
  assert.equal(stored[0]!.expectedDelivery?.toISOString(), own.toISOString(), 'the part receipt did not touch the line date')
  assert.equal(stored[1]!.expectedDelivery, null, 'a line with no date stays blank')

  const detail = await getPurchaseOrder(po.poId)
  assert.equal(detail!.lines[0]!.effectiveDelivery, own.toISOString())
  assert.equal(detail!.lines[1]!.effectiveDelivery, header.toISOString(), 'a blank line shows the header date')

  const edit = (dates: Array<string | null>) => ({
    currency: 'GBP',
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: po.lines.map((l, i) => ({
      poLineId: l.poLineId, productId: l.productId, sku: l.sku, productName: `p${i}`, qty: 10,
      unitCostForeign: fixtures.UNIT_COST, expectedDelivery: dates[i],
    })),
  }) as Parameters<typeof updatePurchaseOrder>[1]

  const moved = await updatePurchaseOrder(po.poId, edit(['2026-12-30', '2026-12-10']))
  assert.equal(moved.success, true, String(moved.error))
  const after = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, orderBy: { sortOrder: 'asc' }, select: { expectedDelivery: true, qtyReceived: true } })
  assert.equal(after[0]!.expectedDelivery?.toISOString().slice(0, 10), '2026-12-30', 'the received line date can be amended')
  assert.equal(Number(after[0]!.qtyReceived), 4)
  assert.equal(after[1]!.expectedDelivery?.toISOString().slice(0, 10), '2026-12-10')

  const cleared = await updatePurchaseOrder(po.poId, edit([null, null]))
  assert.equal(cleared.success, true, String(cleared.error))
  const blank = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, select: { expectedDelivery: true } })
  assert.ok(blank.every((l) => l.expectedDelivery === null), 'a blank date clears the line back to inheriting the header')
})
