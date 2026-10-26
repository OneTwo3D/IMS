/**
 * Owner rulings (2026-10-25) on closed purchase order lines:
 *   1. A duplicate CLOSED (or otherwise non-open) line is excluded before the duplicate check; a duplicate OPEN line still refuses every copy.
 *   2. The pinned incoming-stock map maps the status "Closed" to CLOSED, which the transform excludes as NOT_OPEN (it was UNMAPPED_VALUE).
 *
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ingestDataset, parseColumnMap } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, precondition, product, rowsOf, run } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const line = (orderKey: string, extra: Record<string, string> = {}) => ({ orderKey, supplierName: 'Sup', sku: 'A', qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3', ...extra })
const po = (lines: Array<Record<string, string>>) => run({ products: ds('products', [product('A'), product('B')]), 'purchase-order-lines': ds('purchase-order-lines', lines) })
const codes = (r: ReturnType<typeof run>, outcome: 'REJECTED' | 'EXCLUDED') => dispositionCodes(r, 'purchase-order-lines', outcome).sort()

// [mutation: build the duplicate groups over every line (drop the notOpenBeforeDuplicateCheck skip)]
test('a duplicate CLOSED line is excluded NOT_OPEN, not refused as a duplicate; the run is not blocked', (t) => {
  const r = po([line('O1', { status: 'CLOSED' }), line('O1', { status: 'CLOSED' }), line('O2')])
  precondition(t, 'lines', 3)
  assert.deepEqual(codes(r, 'REJECTED'), [])
  assert.deepEqual(codes(r, 'EXCLUDED'), ['NOT_OPEN', 'NOT_OPEN'])
  assert.equal(r.blocking, false)
  assert.deepEqual(rowsOf(r, 'purchase-orders').map((x) => x.orderKey), ['T-O2'])
})

// [mutation: skip only CLOSED (not CANCELLED / fully received), or skip every status]
test('duplicate cancelled and fully-received lines are set aside too; a closed line repeated with different data is not a conflict', (t) => {
  const r = po([
    line('O1', { status: 'CANCELLED' }), line('O1', { status: 'CANCELLED' }),
    line('O2', { qtyOrdered: '4', qtyReceived: '4' }), line('O2', { qtyOrdered: '4', qtyReceived: '4' }),
    line('O3', { status: 'CLOSED', unitCostForeign: '1' }), line('O3', { status: 'CLOSED', unitCostForeign: '2' }),
    line('O4'),
  ])
  precondition(t, 'lines', 7)
  assert.deepEqual(codes(r, 'REJECTED'), [])
  assert.deepEqual(codes(r, 'EXCLUDED'), ['FULLY_RECEIVED', 'FULLY_RECEIVED', 'NOT_OPEN', 'NOT_OPEN', 'NOT_OPEN', 'NOT_OPEN'])
  assert.deepEqual(rowsOf(r, 'purchase-orders').map((x) => x.orderKey), ['T-O4'])
})

// [mutation: let the exclusion also hide open duplicates (skip when status is OPEN too), or drop the duplicate check]
test('duplicates among OPEN lines still refuse every copy (identical: DUPLICATE_PO_LINE, different: DUPLICATE_PO_LINE_CONFLICT), also beside a closed copy', (t) => {
  const identical = po([line('O1'), line('O1')])
  const conflict = po([line('O1'), line('O1', { unitCostForeign: '9' })])
  const beside = po([line('O1'), line('O1'), line('O1', { status: 'CLOSED' })])
  precondition(t, 'cases', 3)
  assert.deepEqual(codes(identical, 'REJECTED'), ['DUPLICATE_PO_LINE', 'DUPLICATE_PO_LINE'])
  assert.deepEqual(codes(conflict, 'REJECTED'), ['DUPLICATE_PO_LINE_CONFLICT', 'DUPLICATE_PO_LINE_CONFLICT'])
  assert.deepEqual(codes(beside, 'REJECTED'), ['DUPLICATE_PO_LINE', 'DUPLICATE_PO_LINE'])
  assert.deepEqual(codes(beside, 'EXCLUDED'), ['NOT_OPEN'])
  for (const r of [identical, conflict, beside]) assert.equal(r.blocking, true)
})

// [mutation: remove "Closed" from the map, or map it to OPEN]
test('the pinned incoming-stock map maps Closed to CLOSED: a Closed row of the native shape is NOT_OPEN, not UNMAPPED_VALUE', (t) => {
  const text = readFileSync(path.join(NATIVE, 'maps', 'qoblex-incoming-stock.map.json'), 'utf8')
  const mapping = parseColumnMap(text, 'm.json').datasets['purchase-order-lines']!
  assert.deepEqual(mapping.valueMaps.status, { Approved: 'OPEN', PartiallyReceived: 'OPEN', Closed: 'CLOSED' })
  const header = ['Product variant', 'SKU', 'Created on', 'Received on', 'Due On', 'Purchase Order', 'Status', 'Ordered Quantity', 'Received Quantity', 'Price', 'Discount (%)', 'Supplier', 'Supplier Reference']
  const row = (po: string, status: string) => ['P', 'A', 'Thu, Sep 24 2026', '', 'Thu, Oct 8 2026', po, status, '2', '0', '3', '0', 'Sup', ''].map((c) => `"${c}"`).join(',')
  const csv = [header.map((c) => `"${c}"`).join(','), row('O1', 'Closed'), row('O1', 'Closed'), row('O2', 'Approved'), row('O3', 'Bogus')].join('\n') + '\n'
  const ingested = ingestDataset('purchase-order-lines', new TextEncoder().encode(csv), 'incoming.csv', mapping)
  precondition(t, 'records', ingested.recordsRead)
  assert.equal(ingested.rejected.length, 1, 'only the unmapped Bogus status is refused at the map')
  assert.match(JSON.stringify(ingested.rejected), /UNMAPPED_VALUE/)
  const clean = ingestDataset('purchase-order-lines', new TextEncoder().encode(csv.split('\n').filter((l) => !l.includes('Bogus')).join('\n')), 'incoming.csv', mapping)
  assert.equal(clean.rejected.length, 0)
  const r = run({ products: ds('products', [product('A')]), 'purchase-order-lines': clean })
  assert.deepEqual(codes(r, 'REJECTED'), [])
  assert.deepEqual(codes(r, 'EXCLUDED'), ['NOT_OPEN', 'NOT_OPEN'])
  assert.equal(rowsOf(r, 'purchase-orders').length, 1)
})
