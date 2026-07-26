import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-hrak: accounting enqueue must join the sales-order delete protocol.
//
// o3d-5r8 made the hard delete lock the order, check for live accounting/WMS work, then delete.
// The side that WRITES never took part: queueXeroSync / queueQuickBooksSync create their
// AccountingSyncLog row in their own transaction with no order lock and no existence check, and
// AccountingSyncLog has no FK to SalesOrder. A poster holding a pre-delete payload snapshot could
// therefore insert its PENDING row after the guard looked and commit after the order was gone —
// and the worker would post a real document for an order that no longer exists.

const locked: string[] = []
let orders: string[] = []
let shipments: Array<{ id: string; orderId: string }> = []

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => {
      locked.push(orderId)
    },
  },
})

function makeTx() {
  return {
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        orders.includes(where.id) ? { id: where.id } : null,
    },
    shipment: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        shipments.find((row) => row.id === where.id) ?? null,
    },
  } as never
}

async function load() {
  return (await import('@/lib/domain/accounting/enqueue-order-guard')).lockOrderForAccountingEnqueue
}

function reset() {
  locked.length = 0
  orders = ['order-1']
  shipments = [{ id: 'ship-1', orderId: 'order-1' }]
}

test('a live SalesOrder is locked and permitted (o3d-hrak)', async () => {
  const guard = await load()
  reset()

  const result = await guard(makeTx(), { referenceType: 'SalesOrder', referenceId: 'order-1' })

  assert.equal(result, 'order-1')
  assert.deepEqual(locked, ['order-1'], 'the SAME row the delete path locks')
})

test('a DELETED SalesOrder is refused, so no sync row is created (o3d-hrak)', async () => {
  const guard = await load()
  reset()
  orders = []

  const result = await guard(makeTx(), { referenceType: 'SalesOrder', referenceId: 'order-1' })

  assert.equal(result, null, 'null is the caller\'s signal to skip the enqueue entirely')
})

test('a Shipment resolves to its order and locks THAT (o3d-hrak)', async () => {
  const guard = await load()
  reset()

  const result = await guard(makeTx(), { referenceType: 'Shipment', referenceId: 'ship-1' })

  assert.equal(result, 'order-1')
  assert.deepEqual(locked, ['order-1'], 'locking the shipment would not serialise against the delete')
})

test('a Shipment whose order is gone is refused (o3d-hrak)', async () => {
  const guard = await load()
  reset()
  shipments = []

  const result = await guard(makeTx(), { referenceType: 'Shipment', referenceId: 'ship-1' })

  assert.equal(result, null)
  assert.deepEqual(locked, [], 'nothing to lock once the shipment is gone')
})

test('a non-order reference is NOT refused and locks nothing (o3d-hrak)', async () => {
  const guard = await load()
  reset()

  // DailyBatch / PurchaseOrder / Product documents have no owning sales order. Treating "not
  // applicable" as "deleted" would silently stop every non-order document from being queued —
  // a far worse failure than the one being fixed.
  for (const referenceType of ['DailyBatch', 'PurchaseOrder', 'Product']) {
    const result = await guard(makeTx(), { referenceType, referenceId: 'whatever' })
    assert.equal(result, undefined, `${referenceType} must be undefined, not null`)
  }
  assert.deepEqual(locked, [])
})
