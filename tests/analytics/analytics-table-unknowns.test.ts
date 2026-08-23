import assert from 'node:assert/strict'
import test from 'node:test'

import { filterAndSortRows, matchesFilterRule, compareCells, presentColumns } from '@/lib/analytics/table-filter-sort'

/**
 * o3d-iigc round 2, Codex finding 3: the analytics tables sorted and filtered a WITHHELD figure as
 * if it were a real zero.
 *
 * The figures involved are the ones the earlier rounds went to some trouble to refuse: a customer
 * aging `netTotal` whose credits are not all on one proven basis, a refund's `pctOfSale` whose
 * basis was never stamped, a supplier's `avgLeadTimeDays` with nothing delivered to measure. Each
 * is `null` BECAUSE it could not be established — and then `?? 0` in the comparator and
 * `Number(null)` in the filter put it at the bottom of an ascending sort, inside `< 50`, and
 * inside `= 0`. That is a claim about a number we had just said we could not produce.
 *
 * Every case below is worked from the round-1 fixtures so the figures are the real ones:
 *   * SO-1 — £120 gross order, £20 VAT, credited in full by a £100 NET credit -> netTotal £0.00,
 *     a GENUINE zero. It is the row an unknown must not be confused with.
 *   * SO-3 — the same order with a mixed NET + unstamped credit set -> netTotal null.
 */

type AgingRow = { orderNumber: string; netTotal: number | null; netTotalBasis: string }

// Deliberately in this order: SO-1 (the genuine zero) precedes SO-3 (the withheld figure), so a
// stable sort that treats them as equal shows SO-1 first — which is how the old behaviour produced
// a plausible-looking list with a fabricated claim in it.
const AGING: AgingRow[] = [
  { orderNumber: 'SO-1', netTotal: 0, netTotalBasis: 'NET' },
  { orderNumber: 'SO-2', netTotal: 60, netTotalBasis: 'GROSS' },
  { orderNumber: 'SO-3', netTotal: null, netTotalBasis: 'UNKNOWN' },
  { orderNumber: 'SO-4', netTotal: 120, netTotalBasis: 'NONE' },
]

const refs = (rows: AgingRow[]) => rows.map((r) => r.orderNumber)
const rule = (field: string, operator: string, value: string) => ({ field, operator, value })

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test('a withheld net total takes NO position in an ascending sort — it does not lead as the smallest (o3d-iigc)', () => {
  const sorted = filterAndSortRows(AGING, [], 'netTotal', 'asc')

  // Was ['SO-1', 'SO-3', 'SO-2', 'SO-4']: the withheld figure sat second, among the genuine zeroes,
  // telling the reader this order had the smallest surviving sale in the table.
  assert.deepEqual(refs(sorted), ['SO-1', 'SO-2', 'SO-4', 'SO-3'])
  assert.equal(sorted[0].netTotal, 0, 'the £0.00 order — fully credited, and that IS a figure')
  assert.equal(sorted[3].netTotal, null)
})

test('and it takes no position in a descending sort either — unknowns go last BOTH ways (o3d-iigc)', () => {
  const sorted = filterAndSortRows(AGING, [], 'netTotal', 'desc')

  // Pinning unknowns to the top of ascending order would only move the same false claim to the
  // other end of the table, so the direction flip applies to two KNOWN values only.
  assert.deepEqual(refs(sorted), ['SO-4', 'SO-2', 'SO-1', 'SO-3'])
})

test('known figures still sort exactly as they did, in both directions (o3d-iigc control)', () => {
  const known = AGING.filter((r) => r.netTotal != null)
  assert.deepEqual(refs(filterAndSortRows(known, [], 'netTotal', 'asc')), ['SO-1', 'SO-2', 'SO-4'])
  assert.deepEqual(refs(filterAndSortRows(known, [], 'netTotal', 'desc')), ['SO-4', 'SO-2', 'SO-1'])
})

test('two unknowns keep the order the server sent them in (o3d-iigc)', () => {
  const rows = [
    { orderNumber: 'SO-A', netTotal: null },
    { orderNumber: 'SO-B', netTotal: 5 },
    { orderNumber: 'SO-C', netTotal: null },
  ]
  // Array#sort is stable and compareCells returns 0 for two unknowns, so they are not reshuffled
  // into an order that would imply one is larger than the other.
  assert.deepEqual(filterAndSortRows(rows, [], 'netTotal', 'asc').map((r) => r.orderNumber), ['SO-B', 'SO-A', 'SO-C'])
  assert.equal(compareCells(null, null, 'asc'), 0)
})

test('a supplier with no established lead time is not the fastest (o3d-iigc)', () => {
  // The same defect on the purchase page, which shares the module: avgLeadTimeDays is null when no
  // PO from that supplier has both a sent and a received date, and ascending "fastest first" put
  // that supplier at the very top.
  const suppliers = [
    { supplierName: 'Acme', avgLeadTimeDays: 3 },
    { supplierName: 'Never Delivered Ltd', avgLeadTimeDays: null },
    { supplierName: 'Slowco', avgLeadTimeDays: 12 },
  ]
  const sorted = filterAndSortRows(suppliers, [], 'avgLeadTimeDays', 'asc').map((r) => r.supplierName)

  assert.deepEqual(sorted, ['Acme', 'Slowco', 'Never Delivered Ltd'], 'was Never Delivered Ltd first, at 0 days')
})

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('a withheld net total is not swept up by "less than 50" (o3d-iigc)', () => {
  const kept = filterAndSortRows(AGING, [rule('netTotal', '<', '50')], null, 'asc')

  // Was ['SO-1', 'SO-3'] — Number(null) is 0, so the withheld figure satisfied the comparison.
  assert.deepEqual(refs(kept), ['SO-1'])
})

test('a withheld net total does not answer "equals 0" (o3d-iigc)', () => {
  const kept = filterAndSortRows(AGING, [rule('netTotal', '=', '0')], null, 'asc')

  // Was ['SO-1', 'SO-3']. SO-1 genuinely IS zero — an order credited in full — and that row must
  // still be found by this filter, which is the whole reason a null cannot be rendered as one.
  assert.deepEqual(refs(kept), ['SO-1'])
})

test('nor does it answer "not equals 0" — an unknown is not evidence either way (o3d-iigc)', () => {
  const kept = filterAndSortRows(AGING, [rule('netTotal', '!=', '0')], null, 'asc')

  // A CONTROL, and the point of the three-valued rule: "we cannot say" is no more evidence that the
  // figure differs from zero than that it equals it, so the unknown is absent from BOTH results.
  assert.deepEqual(refs(kept), ['SO-2', 'SO-4'])
})

test('"greater than 0" keeps every established figure above zero and nothing else (o3d-iigc control)', () => {
  assert.deepEqual(refs(filterAndSortRows(AGING, [rule('netTotal', '>', '0')], null, 'asc')), ['SO-2', 'SO-4'])
  assert.deepEqual(refs(filterAndSortRows(AGING, [rule('netTotal', '>=', '0')], null, 'asc')), ['SO-1', 'SO-2', 'SO-4'])
})

test('an unestablished % of sale is not filtered as 0% (o3d-iigc)', () => {
  // CN-2 is a genuine 0% (a zero-value credit line); CN-3 is the unstamped credit whose proportion
  // round 1 refused to invent. "at most 0%" means the first and not the second.
  const credits = [
    { creditNoteNumber: 'CN-1', pctOfSale: 100 },
    { creditNoteNumber: 'CN-2', pctOfSale: 0 },
    { creditNoteNumber: 'CN-3', pctOfSale: null },
  ]
  const kept = filterAndSortRows(credits, [rule('pctOfSale', '<=', '0')], null, 'asc')

  assert.deepEqual(kept.map((r) => r.creditNoteNumber), ['CN-2'], 'was CN-2 and CN-3')
  assert.deepEqual(
    filterAndSortRows(credits, [], 'pctOfSale', 'asc').map((r) => r.creditNoteNumber),
    ['CN-2', 'CN-1', 'CN-3'],
    'and it does not head the "smallest refund proportion" list either',
  )
})

test('the basis column is a real value and still filters as one (o3d-iigc control)', () => {
  // UNKNOWN as a stamped BASIS is not a missing value — the report states it — so the select
  // operators keep working on it unchanged.
  assert.deepEqual(refs(filterAndSortRows(AGING, [rule('netTotalBasis', 'is', 'UNKNOWN')], null, 'asc')), ['SO-3'])
  assert.deepEqual(refs(filterAndSortRows(AGING, [rule('netTotalBasis', 'is_not', 'NONE')], null, 'asc')), ['SO-1', 'SO-2', 'SO-3'])
})

test('an absent TEXT attribute keeps the empty-string reading, deliberately (o3d-iigc)', () => {
  // A product with no barcode has an established absence, not a withheld measurement: "contains"
  // must not match it and "does not contain" must, which is what a reader filtering a text column
  // means. Only the numeric operators were making arithmetic claims.
  const products = [
    { sku: 'SKU-1', barcode: '50601234' },
    { sku: 'SKU-2', barcode: null },
  ]
  assert.deepEqual(filterAndSortRows(products, [rule('barcode', 'contains', '506')], null, 'asc').map((r) => r.sku), ['SKU-1'])
  assert.deepEqual(filterAndSortRows(products, [rule('barcode', 'not_contains', '506')], null, 'asc').map((r) => r.sku), ['SKU-2'])
})

test('a field the row does not have at all is an unknown, not a zero (o3d-iigc)', () => {
  // The tables are filtered by a rule whose field comes from the tab's own field list, but a SAVED
  // VIEW can carry a rule for a column the current rows do not have. Reading that as 0 invented a
  // value for every row at once.
  assert.equal(matchesFilterRule(undefined as unknown as null, rule('netTotal', '<', '50')), false)
  assert.deepEqual(filterAndSortRows([{ sku: 'SKU-1' }], [rule('netTotal', '=', '0')], null, 'asc'), [])
})

test('an empty rule value still filters nothing out (o3d-iigc control)', () => {
  assert.deepEqual(refs(filterAndSortRows(AGING, [rule('netTotal', '<', '')], null, 'asc')), ['SO-1', 'SO-2', 'SO-3', 'SO-4'])
})

// ---------------------------------------------------------------------------
// A saved view that outlived one of its columns (o3d-8u4h)
// ---------------------------------------------------------------------------

test('a retired column key is dropped ONCE, so header and body cannot disagree (o3d-8u4h)', () => {
  // The supplier-aging buckets were renamed `overdue*` -> `unsettledBilled*`, because "overdue"
  // claims a relation to a due date the report does not measure. A view saved before that rename
  // still asks for the old keys. The table rendered its header and its body from the same list but
  // treated unknown keys differently — the header skipped them, the body still emitted a cell — so
  // one dead key shifted every column after it one place LEFT and the figures were read under the
  // wrong headings. Silent, and worse than a blank column.
  const fields = [
    { key: 'supplierName' }, { key: 'billedAmount' },
    { key: 'unsettledBilled0_30' }, { key: 'unsettledBilled91plus' },
  ]
  const savedView = ['supplierName', 'overdue0_30', 'billedAmount', 'overdue91plus', 'unsettledBilled91plus']

  const cols = presentColumns(savedView, fields)
  assert.deepEqual(cols, ['supplierName', 'billedAmount', 'unsettledBilled91plus'])
  // The property that matters is not the list itself but that ONE list now feeds both loops: every
  // key that survives has a field definition, so a header exists for every cell.
  for (const key of cols) assert.ok(fields.some((f) => f.key === key), `${key} has no field definition`)
})

test('a view naming only live columns is passed through untouched (o3d-8u4h control)', () => {
  const fields = [{ key: 'supplierName' }, { key: 'billedAmount' }]
  assert.deepEqual(presentColumns(['billedAmount', 'supplierName'], fields), ['billedAmount', 'supplierName'])
  // Order is the VIEW's, not the field list's — a saved view is a saved column ORDER as well.
  assert.notDeepEqual(presentColumns(['billedAmount', 'supplierName'], fields), ['supplierName', 'billedAmount'])
})
