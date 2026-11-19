import assert from 'node:assert/strict'
import test from 'node:test'

import { buildLines, buildPushInput } from '@/lib/domain/wms/order-push-sweep'
import { loadSkuRenameHeldProductIds, skuRenameHoldReason, withSkuRenameHolds } from '@/lib/domain/wms/sku-rename-hold'

/**
 * o3d-zz37l (6): order push holds an order whose line carries a SKU renamed in IMS but not yet in the warehouse (an OPEN PRODUCT_SKU_RENAMED
 * discrepancy), instead of sending the new SKU to the LIVE warehouse. No database, no network.
 */
const line = (over: Record<string, unknown>) => ({ id: 'l1', sku: 'NEW-1', productId: 'p1', qty: 1, taxForeign: 0, totalForeign: 10, description: 'x', ...over }) as never

function fakeClient(openRenamedProductIds: string[]) {
  const queries: unknown[] = []
  const client = {
    wmsStockDiscrepancy: {
      findMany: async (args: { where: { category: string; status: string; productId: { in: string[] } } }) => {
        queries.push(args.where)
        assert.equal(args.where.category, 'PRODUCT_SKU_RENAMED')
        assert.equal(args.where.status, 'OPEN')
        return args.where.productId.in.filter((id) => openRenamedProductIds.includes(id)).map((productId) => ({ productId }))
      },
    },
  }
  return { client: client as never, queries }
}

test('buildLines refuses a line whose product SKU rename the warehouse does not have, naming the SKU', () => {
  assert.throws(() => buildLines([line({})], undefined, ['p1']), (error: Error) => error.message === skuRenameHoldReason(['NEW-1']) && /NEW-1/.test(error.message))
})

test('buildLines without a held product (or with an unrelated one) builds as before', () => {
  assert.equal(buildLines([line({})]).length, 1)
  assert.equal(buildLines([line({})], undefined, []).length, 1)
  assert.equal(buildLines([line({})], undefined, ['other']).length, 1)
})

test('one held line holds the whole order: nothing is sent partially', () => {
  assert.throws(() => buildLines([line({}), line({ id: 'l2', sku: 'OK', productId: 'p2' })], undefined, ['p1']), /Order held/)
})

test('the port reads the open discrepancy once per batch and marks only the affected orders', async () => {
  const { client, queries } = fakeClient(['p1'])
  const orders = [{ id: 'o1', lines: [line({})] }, { id: 'o2', lines: [line({ productId: 'p2', sku: 'OK' })] }, { id: 'o3', lines: [line({ productId: null })] }]
  const marked = await withSkuRenameHolds(client, orders)
  assert.equal(queries.length, 1)
  assert.deepEqual(marked.map((o) => o.skuRenameHeldProductIds), [['p1'], [], []])
  assert.equal(orders[0] && 'skuRenameHeldProductIds' in orders[0], false, 'the input is not mutated')
})

test('no products: no query', async () => {
  const { client, queries } = fakeClient(['p1'])
  assert.equal((await loadSkuRenameHeldProductIds(client, [])).size, 0)
  assert.equal(queries.length, 0)
})

test('once the discrepancy is closed the same order builds again (the revalidation pass re-queues it)', async () => {
  const lines = [line({})]
  const held = await withSkuRenameHolds(fakeClient(['p1']).client, [{ lines }])
  assert.throws(() => buildLines(lines, undefined, held[0]!.skuRenameHeldProductIds), /Order held/)
  const released = await withSkuRenameHolds(fakeClient([]).client, [{ lines }])
  assert.equal(buildLines(lines, undefined, released[0]!.skuRenameHeldProductIds).length, 1)
})

test('buildPushInput refuses an order carrying a held product', () => {
  const order = {
    id: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'A', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 Road', city: 'X', postcode: 'AB1', country: 'GB' }, subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: 0,
    pricesIncludeVat: false, discountAmount: 0, totalForeign: 10, lines: [line({})], skuRenameHeldProductIds: ['p1'],
  }
  assert.throws(() => buildPushInput(order as never, '1'), /Order held: SKU NEW-1 was renamed/)
})
