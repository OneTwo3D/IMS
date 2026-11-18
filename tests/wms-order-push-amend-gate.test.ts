import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * AMEND GATE (PR 1017 final). The REAL Prisma port against a recording db (no network, nothing sent).
 * Order line A: 10 ordered, 8 SHIPPED, 2 of the shipped units returned and refunded (restock).
 *   - a CREATE gets the NETTED quantity (nothing cancelled), so IMS and the warehouse agree on what is still owed;
 *   - an AMEND of an already-pushed order keeps development's quantity, ordered minus GROSS refund (8), for any line that
 *     has SHIPPED shipments, so the quantity sent to a live warehouse order never rises.
 */
type Row = Record<string, unknown>

const orderRow = {
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com',
  customerVatNumber: null, euVatRegime: null, erasedAt: null,
  shippingAddress: { address1: '1 St', line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
  subtotalForeign: 100, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, discountAmount: 0, totalForeign: 100,
  lines: [{ id: 'A', sku: 'SKU-A', qty: 10, taxForeign: 0, totalForeign: 100, description: 'Widget', productId: 'P' }],
  refunds: [{ lines: [{ salesOrderLineId: 'A', qty: 2 }] }],
}
const refundLine = {
  id: 'RL-A', salesOrderLineId: 'A', productId: 'P', qty: 2, refundId: 'R',
  refund: { orderId: 'so-1', returnWarehouseId: 'W', chargeback: false, accountingRetryRequired: false },
}

const readers = {
  salesOrderRefundLine: { findMany: async () => [refundLine] },
  stockMovement: { findMany: async () => [{ referenceId: 'R', productId: 'P', qty: 2, idempotencyKey: 'refund:R:line:RL-A:warehouse:W:product:P' }] },
  salesOrderLine: { findMany: async () => [{ id: 'A', productId: 'P', fulfillmentRequirements: null }] },
  shipmentLine: { findMany: async () => [{ lineId: 'A', productId: 'P', qty: 8 }] },
  product: { findMany: async () => [{ id: 'P', type: 'SIMPLE', fulfillmentGraphVersion: 0, productComponents: [] }] },
}
const tx = { $queryRaw: async () => [{ id: 'so-1' }], salesOrder: { findUnique: async () => orderRow }, ...readers }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (c: typeof tx) => Promise<unknown>) => fn(tx),
      $queryRaw: async () => [{ id: 'link-1' }],
      wmsOrderPushLink: { findMany: async (_a: Row) => [{ id: 'link-1', externalOrderId: 'wms-1', order: orderRow }] },
      salesOrder: { findMany: async () => [{ ...orderRow, wmsOrderPush: null }] },
      ...readers,
    },
  },
})

async function mod() { return import('../lib/domain/wms/order-push-sweep.ts') }
const quantities = (input: { lines: Array<{ quantity: unknown }> }) => input.lines.map((l) => Number(l.quantity))

test('create after a shipped-units return gets the NETTED quantity (10: nothing cancelled)', async () => {
  const { createPrismaWmsOrderPushPort, buildPushInput } = await mod()
  const [candidate] = await createPrismaWmsOrderPushPort().createCandidates('mintsoft', ['wh-1'], 10, null as never, undefined as never)
  assert.deepEqual(quantities(buildPushInput(candidate as never, '301')), [10])
  const reloaded = await createPrismaWmsOrderPushPort().reloadOrderForPush!('so-1')
  assert.deepEqual(quantities(buildPushInput({ ...orderRow, ...reloaded } as never, '301')), [10])
})

test('case B: the amend quantity equals development\'s (ordered minus GROSS refund = 8), from the update pass and from the reload', async () => {
  const { createPrismaWmsOrderPushPort, buildPushInput } = await mod()
  const port = createPrismaWmsOrderPushPort()
  const [link] = await port.updatableLinks('mintsoft', 10, undefined as never)
  assert.deepEqual(quantities(buildPushInput(link.order as never, '301')), [8])
  const reloaded = await port.reloadOrderForPush!('so-1', true)
  assert.deepEqual(quantities(buildPushInput({ ...link.order, ...reloaded } as never, '301')), [8], 'the under-lock reload an amend uses does not raise it either')
})

test('case C: the refused-action text and quantity equal development\'s (holds 8, never asks to hold 10)', async () => {
  const { createPrismaWmsOrderPushPort, buildPushInput } = await mod()
  const { amendmentNotAppliedQuery } = await import('../lib/domain/wms/operator-tasks.ts')
  const port = createPrismaWmsOrderPushPort()
  const reloaded = await port.reloadOrderForPush!('so-1', true)
  const input = buildPushInput({ ...orderRow, ...reloaded } as never, '301')
  const text = amendmentNotAppliedQuery('WN-1', 'SO-1', input.lines.map((l) => ({ sku: l.sku, quantity: Number(l.quantity) })), 'DESPATCHED')
  assert.match(text, /IMS now holds this order as: 8 x SKU-A\./)
  assert.doesNotMatch(text, /10 x SKU-A/)
})
