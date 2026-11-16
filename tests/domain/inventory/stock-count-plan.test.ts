import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkLineAddition,
  checkLineRemoval,
  describeAlreadyInCount,
  describeNotCountable,
  describePlanLocked,
  describeUnremovableLines,
  filterCountsByStatus,
  isStockCountPlanEditable,
  isStockCountableProductType,
  lineRemovability,
  mergeSelection,
  normaliseProductSearchFilters,
} from '@/lib/domain/inventory/stock-count-plan'

test('a line is removable only while it is neither counted nor reconciled', () => {
  assert.deepEqual(lineRemovability({ countedQty: null, reconciledQty: null }), { removable: true })
  assert.deepEqual(lineRemovability({ countedQty: 0, reconciledQty: null }), { removable: false, reason: 'COUNTED' }, 'a counted zero is still counted')
  assert.deepEqual(lineRemovability({ countedQty: null, reconciledQty: 4 }), { removable: false, reason: 'RECONCILED' })
  assert.deepEqual(lineRemovability({ countedQty: 3, reconciledQty: 4 }), { removable: false, reason: 'COUNTED_AND_RECONCILED' })
})

test('the plan is editable while the count is open, and not once it is posted or cancelled', () => {
  assert.equal(isStockCountPlanEditable('DRAFT'), true)
  assert.equal(isStockCountPlanEditable('IN_PROGRESS'), true)
  assert.equal(isStockCountPlanEditable('COMPLETED'), false)
  assert.equal(isStockCountPlanEditable('CANCELLED'), false)
  assert.equal(describePlanLocked('DRAFT'), null)
  assert.match(describePlanLocked('COMPLETED')!, /already been posted/)
  assert.match(describePlanLocked('CANCELLED')!, /cancelled/)
})

test('only product types that carry their own stock are countable', () => {
  for (const t of ['SIMPLE', 'VARIANT', 'BOM']) assert.equal(isStockCountableProductType(t), true, t)
  for (const t of ['VARIABLE', 'KIT', 'NON_INVENTORY', '']) assert.equal(isStockCountableProductType(t), false, t)
})

test('removal check separates removable, blocked and unknown lines, and ignores repeats', () => {
  const lines = [
    { id: 'a', sku: 'A', countedQty: null, reconciledQty: null },
    { id: 'b', sku: 'B', countedQty: 2, reconciledQty: null },
    { id: 'c', sku: 'C', countedQty: null, reconciledQty: 5 },
  ]
  const r = checkLineRemoval(['a', 'a', 'b', 'c', 'zzz'], lines)
  assert.deepEqual(r.removableIds, ['a'])
  assert.deepEqual(r.unknownIds, ['zzz'])
  assert.deepEqual(r.blocked.map((b) => [b.sku, b.reason]), [['B', 'COUNTED'], ['C', 'RECONCILED']])
})

test('the unremovable-line refusal names every product, says nothing was removed, and tells the operator what to do', () => {
  const text = describeUnremovableLines([
    { lineId: 'b', sku: 'B', reason: 'COUNTED' },
    { lineId: 'c', sku: 'C', reason: 'RECONCILED' },
    { lineId: 'd', sku: 'D', reason: 'COUNTED_AND_RECONCILED' },
  ])
  assert.match(text, /^Nothing was removed/)
  assert.match(text, /B \(already counted\)/)
  assert.match(text, /C \(reconciled\)/)
  assert.match(text, /D \(already counted and reconciled\)/)
  assert.match(text, /clear its counted quantity and save/)
})

test('addition check de-duplicates the request and reports products already on the count', () => {
  const r = checkLineAddition(['p1', 'p2', 'p2', 'p3', 'p1'], ['p3', 'p9'])
  assert.deepEqual(r.toAdd, ['p1', 'p2'])
  assert.deepEqual(r.alreadyInCount, ['p3'])
  assert.deepEqual(checkLineAddition([], ['p1']), { toAdd: [], alreadyInCount: [] })
})

test('refusal wording for duplicates and uncountable products names the SKUs', () => {
  assert.match(describeAlreadyInCount(['A', 'B']), /^Nothing was added: 2 product\(s\) are already on this count: A, B/)
  const t = describeNotCountable([{ sku: 'X', why: 'ARCHIVED' }, { sku: 'Y', why: 'TYPE' }, { sku: 'Z', why: 'MISSING' }])
  assert.match(t, /X \(archived\)/)
  assert.match(t, /Y \(not a stocked product type/)
  assert.match(t, /Z \(no longer exists\)/)
})

test('picks survive a change of search or filters: merging keeps earlier picks, adds new ones once, drops unpicked', () => {
  let picks: string[] = []
  picks = mergeSelection(picks, ['a', 'b'], [])
  picks = mergeSelection(picks, ['b', 'c'], []) // a different search shows b again and c
  assert.deepEqual(picks, ['a', 'b', 'c'])
  picks = mergeSelection(picks, [], ['b'])
  assert.deepEqual(picks, ['a', 'c'])
})

test('search filters are normalised: query trimmed, unknown types dropped, bad state falls back to operational', () => {
  assert.deepEqual(normaliseProductSearchFilters({ query: '  Widget ', types: ['SIMPLE', 'KIT', 'SIMPLE', 'nope'], state: 'ARCHIVED', categoryId: 'cat1' }),
    { query: 'Widget', types: ['SIMPLE'], state: 'ARCHIVED', categoryId: 'cat1' })
  assert.deepEqual(normaliseProductSearchFilters({ state: 'weird', categoryId: '' }),
    { query: '', types: [], state: 'OPERATIONAL', categoryId: null })
  assert.equal(normaliseProductSearchFilters({ query: 'x'.repeat(500) }).query.length, 100)
})

test('the list filters by status', () => {
  const counts = [{ status: 'DRAFT' as const }, { status: 'COMPLETED' as const }, { status: 'DRAFT' as const }]
  assert.equal(filterCountsByStatus(counts, 'ALL').length, 3)
  assert.equal(filterCountsByStatus(counts, 'DRAFT').length, 2)
  assert.equal(filterCountsByStatus(counts, 'CANCELLED').length, 0)
})
