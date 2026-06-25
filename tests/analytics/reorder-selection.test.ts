import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_SELECTED_IDS,
  emptyReorderSelection,
  parseSelectedParam,
  reorderSelectionReducer,
  selectAllState,
  selectedVisibleCount,
  serializeSelectedParam,
  sumSelectedField,
  type ReorderSelectionState,
} from '../../lib/analytics/reorder-selection.ts'

function stateOf(ids: string[]): ReorderSelectionState {
  return { selected: new Set(ids) }
}

test('toggle adds an unselected id', () => {
  const next = reorderSelectionReducer(emptyReorderSelection, { type: 'toggle', id: 'p1' })
  assert.deepEqual([...next.selected], ['p1'])
})

test('toggle removes an already-selected id', () => {
  const next = reorderSelectionReducer(stateOf(['p1', 'p2']), { type: 'toggle', id: 'p1' })
  assert.deepEqual([...next.selected].sort(), ['p2'])
})

test('toggle does not mutate the previous state', () => {
  const prev = stateOf(['p1'])
  reorderSelectionReducer(prev, { type: 'toggle', id: 'p2' })
  assert.deepEqual([...prev.selected], ['p1'])
})

test('toggleAll does not mutate the previous state', () => {
  const prev = stateOf(['p1'])
  reorderSelectionReducer(prev, { type: 'toggleAll', visibleIds: ['p1', 'p2'] })
  assert.deepEqual([...prev.selected], ['p1'])
})

test('set does not mutate the previous state', () => {
  const prev = stateOf(['p1'])
  reorderSelectionReducer(prev, { type: 'set', ids: ['p2', 'p3'] })
  assert.deepEqual([...prev.selected], ['p1'])
})

test('toggleAll from none selects every visible id', () => {
  const next = reorderSelectionReducer(emptyReorderSelection, { type: 'toggleAll', visibleIds: ['p1', 'p2', 'p3'] })
  assert.deepEqual([...next.selected].sort(), ['p1', 'p2', 'p3'])
})

test('toggleAll from partial selects every visible id', () => {
  const next = reorderSelectionReducer(stateOf(['p2']), { type: 'toggleAll', visibleIds: ['p1', 'p2', 'p3'] })
  assert.deepEqual([...next.selected].sort(), ['p1', 'p2', 'p3'])
})

test('toggleAll from all clears every visible id', () => {
  const next = reorderSelectionReducer(stateOf(['p1', 'p2', 'p3']), { type: 'toggleAll', visibleIds: ['p1', 'p2', 'p3'] })
  assert.deepEqual([...next.selected], [])
})

test('toggleAll preserves selections that are not currently visible', () => {
  // off-page selection p9 survives a select-all and a clear-all of the visible page
  const selectAll = reorderSelectionReducer(stateOf(['p9']), { type: 'toggleAll', visibleIds: ['p1', 'p2'] })
  assert.deepEqual([...selectAll.selected].sort(), ['p1', 'p2', 'p9'])
  const clearVisible = reorderSelectionReducer(selectAll, { type: 'toggleAll', visibleIds: ['p1', 'p2'] })
  assert.deepEqual([...clearVisible.selected], ['p9'])
})

test('toggleAll with no visible ids is a no-op', () => {
  const next = reorderSelectionReducer(stateOf(['p1']), { type: 'toggleAll', visibleIds: [] })
  assert.deepEqual([...next.selected], ['p1'])
})

test('set replaces the whole selection', () => {
  const next = reorderSelectionReducer(stateOf(['p1', 'p2']), { type: 'set', ids: ['p3'] })
  assert.deepEqual([...next.selected], ['p3'])
})

test('clear empties the selection', () => {
  const next = reorderSelectionReducer(stateOf(['p1', 'p2']), { type: 'clear' })
  assert.deepEqual([...next.selected], [])
})

test('selectAllState reports none / some / all', () => {
  const visible = ['p1', 'p2', 'p3']
  assert.equal(selectAllState(new Set(), visible), 'none')
  assert.equal(selectAllState(new Set(['p2']), visible), 'some')
  assert.equal(selectAllState(new Set(['p1', 'p2', 'p3']), visible), 'all')
})

test('selectAllState is none when there are no visible rows', () => {
  assert.equal(selectAllState(new Set(['p1']), []), 'none')
})

test('selectAllState ignores selected ids that are not visible', () => {
  // all visible selected, plus an off-page id → still "all", not "some"
  assert.equal(selectAllState(new Set(['p1', 'p2', 'p9']), ['p1', 'p2']), 'all')
})

test('selectedVisibleCount counts only visible selected ids', () => {
  assert.equal(selectedVisibleCount(new Set(['p1', 'p9']), ['p1', 'p2', 'p3']), 1)
  assert.equal(selectedVisibleCount(new Set(['p1', 'p2']), ['p1', 'p2', 'p3']), 2)
})

test('parseSelectedParam splits, trims and de-dups', () => {
  assert.deepEqual(parseSelectedParam('p1, p2 ,p1,p3'), ['p1', 'p2', 'p3'])
})

test('parseSelectedParam returns [] for empty/undefined', () => {
  assert.deepEqual(parseSelectedParam(undefined), [])
  assert.deepEqual(parseSelectedParam(''), [])
  assert.deepEqual(parseSelectedParam(' , , '), [])
})

test('parseSelectedParam caps at MAX_SELECTED_IDS', () => {
  const many = Array.from({ length: MAX_SELECTED_IDS + 50 }, (_, i) => `p${i}`).join(',')
  assert.equal(parseSelectedParam(many).length, MAX_SELECTED_IDS)
})

test('serializeSelectedParam round-trips with parse', () => {
  const ids = ['p1', 'p2', 'p3']
  assert.deepEqual(parseSelectedParam(serializeSelectedParam(new Set(ids))), ids)
})

test('serializeSelectedParam caps at MAX_SELECTED_IDS', () => {
  const ids = Array.from({ length: MAX_SELECTED_IDS + 10 }, (_, i) => `p${i}`)
  assert.equal(serializeSelectedParam(new Set(ids)).split(',').length, MAX_SELECTED_IDS)
})

test('sumSelectedField totals the field over selected rows only', () => {
  const rows = [
    { productId: 'p1', qty: 5 },
    { productId: 'p2', qty: 10 },
    { productId: 'p3', qty: 3 },
  ]
  assert.equal(sumSelectedField(rows, new Set(['p1', 'p3']), (r) => r.qty), 8)
  assert.equal(sumSelectedField(rows, new Set(), (r) => r.qty), 0)
})

test('sumSelectedField ignores non-finite field values', () => {
  const rows = [
    { productId: 'p1', qty: Number.NaN },
    { productId: 'p2', qty: 7 },
  ]
  assert.equal(sumSelectedField(rows, new Set(['p1', 'p2']), (r) => r.qty), 7)
})

test('sumSelectedField ignores selected ids not present in rows', () => {
  const rows = [{ productId: 'p1', qty: 4 }]
  assert.equal(sumSelectedField(rows, new Set(['p1', 'p9']), (r) => r.qty), 4)
})
