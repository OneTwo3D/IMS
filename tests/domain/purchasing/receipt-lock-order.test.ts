import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// o3d-chs1h: static guard. The supplier return takes stock_levels and then cost_layers, so the receipt must take
// them in the same direction or a receipt of one PO and a return of another (same product and warehouse) can
// deadlock. This pins the order inside receiveStock's per-line loop.
test('receipt writes the stock level before the cost layer', () => {
  const src = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const start = src.indexOf("type: 'PURCHASE_RECEIPT'")
  assert.ok(start > 0)
  const stock = src.indexOf('tx.stockLevel.upsert', start)
  const layer = src.indexOf('await createCostLayer(tx', start)
  assert.ok(stock > 0 && layer > 0)
  assert.ok(stock < layer, 'stock_levels must be written before cost_layers in the receipt')
})
