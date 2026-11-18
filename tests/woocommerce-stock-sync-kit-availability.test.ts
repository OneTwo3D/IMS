import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStockMaps,
  computeAvailableByProduct,
  type CandidateProduct,
  type StockLevelSnapshotRow,
} from '@/lib/connectors/woocommerce/sync/stock-sync'

function simpleProduct(id: string): CandidateProduct {
  return { id, sku: id, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', externalProductId: null, parent: null, productComponents: [] }
}

function kit(
  id: string,
  components: { componentId: string; qty: number; type?: CandidateProduct['productComponents'][number]['component']['type'] }[],
): CandidateProduct {
  return {
    id,
    sku: id,
    type: 'KIT',
    lifecycleStatus: 'ACTIVE',
    externalProductId: null,
    parent: null,
    productComponents: components.map((c) => ({
      componentId: c.componentId,
      qty: c.qty as unknown as CandidateProduct['productComponents'][number]['qty'],
      component: { type: c.type ?? 'SIMPLE', lifecycleStatus: 'ACTIVE' },
    })),
  }
}

function rows(...r: [string, string, number][]): StockLevelSnapshotRow[] {
  return r.map(([productId, warehouseId, quantity]) => ({ productId, warehouseId, quantity, reservedQty: 0 }))
}

test('nested KIT-of-KIT availability is warehouse-correct, not memo-leaked across warehouses (yi4m)', () => {
  // S has 10 in warehouse A and 0 in warehouse B. Nested KIT N = 1×S. Parent P = 1×N.
  // Correct: P availability = 10 (A) + 0 (B) = 10. The product-only memo bug reused A's
  // nested result for B, valuing P at 20 (oversell).
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(rows(['S', 'A', 10], ['S', 'B', 0]))
  const N = kit('N', [{ componentId: 'S', qty: 1 }])
  const P = kit('P', [{ componentId: 'N', qty: 1, type: 'KIT' }])
  const productById = new Map<string, CandidateProduct>([
    ['P', P],
    ['N', N],
    ['S', simpleProduct('S')],
  ])

  const available = computeAvailableByProduct([P], ['A', 'B'], stockByProduct, stockByProductWarehouse, productById, [])

  assert.equal(available.get('P'), 10)
})

test('two parent KITs sharing a nested KIT each get the correct per-warehouse value (yi4m)', () => {
  // S: 4 in A only. Two parents P1, P2 both = 1×N, N = 1×S.
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(rows(['S', 'A', 4], ['S', 'B', 0]))
  const N = kit('N', [{ componentId: 'S', qty: 1 }])
  const P1 = kit('P1', [{ componentId: 'N', qty: 1, type: 'KIT' }])
  const P2 = kit('P2', [{ componentId: 'N', qty: 1, type: 'KIT' }])
  const productById = new Map<string, CandidateProduct>([['P1', P1], ['P2', P2], ['N', N], ['S', simpleProduct('S')]])

  const available = computeAvailableByProduct([P1, P2], ['A', 'B'], stockByProduct, stockByProductWarehouse, productById, [])

  assert.equal(available.get('P1'), 4)
  assert.equal(available.get('P2'), 4)
})

test('a nested KIT absent from productById values the parent at 0 (no crash)', () => {
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(rows(['S', 'A', 10]))
  const P = kit('P', [{ componentId: 'N', qty: 1, type: 'KIT' }])
  // N intentionally omitted from productById.
  const productById = new Map<string, CandidateProduct>([['P', P]])

  const available = computeAvailableByProduct([P], ['A'], stockByProduct, stockByProductWarehouse, productById, [])

  assert.equal(available.get('P'), 0)
})
