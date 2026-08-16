import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RESERVATION_RELEASING_SHIPMENT_STATUS,
  allocationScopeKey,
  residualAllocationQty,
  residualAllocationRows,
  residualAllocationRowsForOrder,
  sumDispatchedQtyByAllocationScope,
} from '@/lib/domain/inventory/reservation-residual'

/**
 * o3d-4kfh: this module is the ONE definition of a live reservation. Three release paths, the
 * under-reservation detector, the availability map and the invariant checker all consume it, so
 * every property asserted here is load-bearing somewhere else.
 */

const SCOPE = { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1' }

test('a row with no dispatch has a residual equal to its quantity', () => {
  assert.equal(
    residualAllocationQty({ ...SCOPE, qty: 10 }, new Map()).toNumber(),
    10,
  )
})

test('dispatch reduces the residual by exactly the dispatched quantity', () => {
  const dispatched = sumDispatchedQtyByAllocationScope([{ ...SCOPE, qty: 5 }])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: 10 }, dispatched).toNumber(), 5)
})

test('a fully dispatched row has a ZERO residual — dispatch already gave the reservation back', () => {
  const dispatched = sumDispatchedQtyByAllocationScope([{ ...SCOPE, qty: 10 }])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: 10 }, dispatched).toNumber(), 0)
})

test('the residual is floored at zero PER ROW, never negative', () => {
  // A negative would silently offset a SIBLING row's residual in the same scope and under-release
  // it, which is the same class of bug this module exists to remove. GREATEST(..., 0) in the
  // invariant checker floors per row for the same reason.
  const dispatched = sumDispatchedQtyByAllocationScope([{ ...SCOPE, qty: 12 }])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: 10 }, dispatched).toNumber(), 0)

  const rows = residualAllocationRows(
    [
      { ...SCOPE, qty: 10 },
      { lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 },
    ],
    [{ ...SCOPE, qty: 12 }],
  )
  assert.deepEqual(rows.map((row) => row.qty.toNumber()), [0, 4], 'line-2 keeps its full residual')
})

test('dispatch is attributed at (lineId, warehouseId, productId) — not by product alone', () => {
  // OrderAllocation is unique on that triple, and a shipment from another warehouse released a
  // different stock level's reservation. Netting it here would release the wrong row.
  const dispatched = sumDispatchedQtyByAllocationScope([
    { ...SCOPE, warehouseId: 'warehouse-2', qty: 5 },
  ])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: 10 }, dispatched).toNumber(), 10)
  assert.notEqual(
    allocationScopeKey(SCOPE),
    allocationScopeKey({ ...SCOPE, warehouseId: 'warehouse-2' }),
  )
})

test('multiple dispatches against one allocation row accumulate', () => {
  const dispatched = sumDispatchedQtyByAllocationScope([
    { ...SCOPE, qty: 2 },
    { ...SCOPE, qty: 3 },
  ])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: 10 }, dispatched).toNumber(), 5)
})

test('residualAllocationRows preserves row identity and keeps zero-residual rows', () => {
  const rows = residualAllocationRows(
    [{ ...SCOPE, qty: 10, orderId: 'order-1' }],
    [{ ...SCOPE, qty: 10 }],
  )
  assert.equal(rows.length, 1, 'a zero-residual row is kept, so callers still see the full set')
  assert.equal(rows[0].orderId, 'order-1')
  assert.equal(rows[0].warehouseId, 'warehouse-1')
  assert.equal(rows[0].qty.toNumber(), 0)
})

test('fractional quantities are netted as Decimals, not floats', () => {
  const dispatched = sumDispatchedQtyByAllocationScope([{ ...SCOPE, qty: '0.1' }])
  assert.equal(residualAllocationQty({ ...SCOPE, qty: '0.3' }, dispatched).toString(), '0.2')
})

test('only DISPATCHED shipments are loaded — a picked or packed shipment has released nothing', async () => {
  // reservedQty is decremented on the transition to SHIPPED and nowhere else. Netting a
  // PICKING/PACKED shipment would under-release and strand reservation on the stock level forever.
  assert.equal(RESERVATION_RELEASING_SHIPMENT_STATUS, 'SHIPPED')

  const queries: unknown[] = []
  const client = {
    shipmentLine: {
      findMany: async (args: unknown) => {
        queries.push(args)
        return [{
          lineId: 'line-1',
          productId: 'product-1',
          qty: 4,
          shipment: { warehouseId: 'warehouse-9' },
        }]
      },
    },
  }

  const rows = await residualAllocationRowsForOrder(client as never, 'order-1', [
    { ...SCOPE, warehouseId: 'warehouse-9', qty: 10 },
  ])

  assert.deepEqual(
    (queries[0] as { where: unknown }).where,
    { shipment: { orderId: 'order-1', status: 'SHIPPED' } },
    'the loader asks for dispatched lines of THIS order only',
  )
  assert.equal(rows[0].qty.toNumber(), 6, 'and the shipment warehouse keys the residual')
})

test('an order with no allocations issues no query at all', async () => {
  let called = false
  const client = {
    shipmentLine: {
      findMany: async () => {
        called = true
        return []
      },
    },
  }

  assert.deepEqual(await residualAllocationRowsForOrder(client as never, 'order-1', []), [])
  assert.equal(called, false)
})
