import assert from 'node:assert/strict'
import test from 'node:test'

import { partitionReorderMoCandidates } from '@/lib/domain/manufacturing/reorder-mo-planning'

function base() {
  return {
    productIds: ['p1'],
    rowByProduct: new Map([['p1', { sku: 'A', suggestedReorderQty: 10 }]]),
    bomIdByProduct: new Map<string, string>([['p1', 'bom1']]),
    warehouseByProduct: new Map<string, string | undefined>([['p1', 'wh1']]),
    recentDraftProductIds: new Set<string>(),
  }
}

test('eligible product with BOM + warehouse is queued to create', () => {
  const { toCreate, skipped } = partitionReorderMoCandidates(base())
  assert.equal(skipped.length, 0)
  assert.deepEqual(toCreate, [{ productId: 'p1', sku: 'A', bomId: 'bom1', warehouseId: 'wh1', qtyPlanned: 10 }])
})

test('audit-M-mfg #3: a BOM product with no active Bom is surfaced as skipped, not silently dropped', () => {
  const input = base()
  input.bomIdByProduct = new Map()
  const { toCreate, skipped } = partitionReorderMoCandidates(input)
  assert.equal(toCreate.length, 0)
  assert.deepEqual(skipped, [{ productId: 'p1', sku: 'A', reason: 'no_active_bom' }])
})

test('no resolvable warehouse is surfaced as skipped', () => {
  const input = base()
  input.warehouseByProduct = new Map([['p1', undefined]])
  const { toCreate, skipped } = partitionReorderMoCandidates(input)
  assert.equal(toCreate.length, 0)
  assert.equal(skipped[0].reason, 'no_warehouse')
})

test('audit-M-mfg #2: a recent DRAFT MO suppresses a duplicate (double-click)', () => {
  const input = base()
  input.recentDraftProductIds = new Set(['p1'])
  const { toCreate, skipped } = partitionReorderMoCandidates(input)
  assert.equal(toCreate.length, 0)
  assert.equal(skipped[0].reason, 'recent_draft_exists')
})

test('recent-draft check takes precedence over no-BOM', () => {
  const input = base()
  input.recentDraftProductIds = new Set(['p1'])
  input.bomIdByProduct = new Map()
  const { skipped } = partitionReorderMoCandidates(input)
  assert.equal(skipped[0].reason, 'recent_draft_exists')
})
