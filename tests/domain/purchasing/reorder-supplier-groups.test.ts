import assert from 'node:assert/strict'
import test from 'node:test'
import { groupReorderRowsBySupplier, type ReorderGroupableRow } from '@/lib/domain/purchasing/reorder-supplier-groups'

type R = ReorderGroupableRow & { sku: string; leadTimeDays: number; latestPoDate: string | null; warehouseId: string }

const row = (over: Partial<R> & { sku: string }): R => ({
  productId: `p-${over.sku}`,
  productType: 'SIMPLE',
  supplierId: 's1',
  supplierName: 'Acme',
  suggestedReorderQty: '5',
  leadTimeDays: 7,
  latestPoDate: null,
  warehouseId: 'w1',
  ...over,
})

const ROWS: R[] = [
  row({ sku: 'A', suggestedReorderQty: '10', leadTimeDays: 7, latestPoDate: '2026-12-01' }),
  row({ sku: 'B', suggestedReorderQty: '2.5', leadTimeDays: 30, latestPoDate: '2026-11-20' }),
  row({ sku: 'C', supplierId: 's2', supplierName: 'Beta', suggestedReorderQty: '4' }),
  row({ sku: 'D', supplierId: null, supplierName: null, suggestedReorderQty: '3' }),
  row({ sku: 'E', productType: 'BOM', supplierId: null, supplierName: 'Manufactured in-house', suggestedReorderQty: '8' }),
  row({ sku: 'F', productType: 'BOM', supplierId: null, supplierName: 'Manufactured by Foundry Ltd', suggestedReorderQty: '1' }),
  row({ sku: 'G', supplierId: null, supplierName: 'Unassigned', suggestedReorderQty: '6' }),
]

test('rows group by supplier with the total recommended quantity of each group', () => {
  const groups = groupReorderRowsBySupplier(ROWS)
  const acme = groups.find((g) => g.label === 'Acme')!
  assert.equal(acme.kind, 'supplier')
  assert.deepEqual(acme.rows.map((r) => r.sku), ['A', 'B'])
  assert.equal(acme.totalSuggestedQty, '12.5')
  assert.equal(groups.find((g) => g.label === 'Beta')!.totalSuggestedQty, '4')
})

test('a group never merges lead times: every row keeps its own lead time and PO date', () => {
  const acme = groupReorderRowsBySupplier(ROWS).find((g) => g.label === 'Acme')!
  assert.deepEqual(acme.rows.map((r) => [r.leadTimeDays, r.latestPoDate]), [[7, '2026-12-01'], [30, '2026-11-20']])
})

test('rows with no supplier go in their own warning group, last, with their own total', () => {
  const groups = groupReorderRowsBySupplier(ROWS)
  const last = groups[groups.length - 1]!
  assert.equal(last.kind, 'no_supplier')
  assert.equal(last.label, 'No supplier')
  assert.deepEqual(last.rows.map((r) => r.sku).sort(), ['D', 'G'])
  assert.equal(last.totalSuggestedQty, '9')
  assert.equal(groups.filter((g) => g.kind === 'no_supplier').length, 1)
})

test('manufactured (BOM) rows get their own groups, never the no-supplier group, after the supplier groups', () => {
  const groups = groupReorderRowsBySupplier(ROWS)
  assert.deepEqual(groups.map((g) => g.kind), ['supplier', 'supplier', 'manufactured', 'manufactured', 'no_supplier'])
  const inHouse = groups.find((g) => g.label === 'Manufactured in-house')!
  assert.deepEqual(inHouse.rows.map((r) => r.sku), ['E'])
  assert.equal(groups.find((g) => g.label === 'Manufactured by Foundry Ltd')!.totalSuggestedQty, '1')
})

test('every row appears exactly once and the group totals add up to the row total', () => {
  const groups = groupReorderRowsBySupplier(ROWS)
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), ROWS.length)
  const sum = groups.reduce((s, g) => s + Number(g.totalSuggestedQty), 0)
  assert.equal(sum, ROWS.reduce((s, r) => s + Number(r.suggestedReorderQty), 0))
})

test('groups recalculate with the location filter: the same rows filtered to one warehouse regroup with their own totals', () => {
  const rows = [
    row({ sku: 'A', warehouseId: 'w1', suggestedReorderQty: '10' }),
    row({ sku: 'B', warehouseId: 'w2', suggestedReorderQty: '7' }),
    row({ sku: 'C', warehouseId: 'w2', supplierId: null, supplierName: null, suggestedReorderQty: '2' }),
  ]
  const all = groupReorderRowsBySupplier(rows)
  assert.equal(all.find((g) => g.label === 'Acme')!.totalSuggestedQty, '17')
  const w2 = groupReorderRowsBySupplier(rows.filter((r) => r.warehouseId === 'w2'))
  assert.equal(w2.find((g) => g.label === 'Acme')!.totalSuggestedQty, '7')
  assert.equal(w2.find((g) => g.kind === 'no_supplier')!.totalSuggestedQty, '2')
  assert.equal(groupReorderRowsBySupplier(rows.filter((r) => r.warehouseId === 'w1')).some((g) => g.kind === 'no_supplier'), false)
})

test('no rows gives no groups; a zero-quantity row still sits in its supplier group', () => {
  assert.deepEqual(groupReorderRowsBySupplier([]), [])
  const [g] = groupReorderRowsBySupplier([row({ sku: 'Z', suggestedReorderQty: '0' })])
  assert.equal(g!.totalSuggestedQty, '0')
  assert.equal(g!.rows.length, 1)
})

test('a supplier with the same name but a different id is a different group', () => {
  const groups = groupReorderRowsBySupplier([row({ sku: 'A', supplierId: 's1' }), row({ sku: 'B', supplierId: 's9' })])
  assert.equal(groups.length, 2)
})
