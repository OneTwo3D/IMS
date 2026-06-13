import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAssemblyOutputQty } from '@/lib/domain/manufacturing/production-completion'

// audit-wght: actual-produced quantity at assembly completion.

test('defaults to planned when no actual supplied', () => {
  assert.deepEqual(resolveAssemblyOutputQty({ qtyPlanned: 100 }), { qty: 100 })
  assert.deepEqual(resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: null }), { qty: 100 })
})

test('accepts a partial (yield-loss) actual', () => {
  assert.deepEqual(resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: 90 }), { qty: 90 })
  assert.deepEqual(resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: 100 }), { qty: 100 })
})

test('rejects a non-positive actual', () => {
  assert.match((resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: 0 }) as { error: string }).error, /greater than 0/)
  assert.match((resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: -5 }) as { error: string }).error, /greater than 0/)
  assert.match((resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: Number.NaN }) as { error: string }).error, /greater than 0/)
})

test('rejects an actual exceeding planned (over-yield out of scope)', () => {
  assert.match((resolveAssemblyOutputQty({ qtyPlanned: 100, actualQtyProduced: 120 }) as { error: string }).error, /cannot exceed the planned quantity \(100\)/)
})
