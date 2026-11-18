import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateCogsReport,
  addExactCredit,
  emptyExactCredit,
  resolveCogsRevenueKeys,
  type CogsAggregationInput,
} from '@/lib/domain/inventory/inventory-costing-reports'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-002w. A line of 4 units at 400 that ships 1 unit in June and 3 in July booked 400 of revenue in
 * June (one unit of COGS) and 400 again in July. The Gross Margin report books unitRevenue x dispatchedQty.
 * And totals.grossMarginBase was not totals.revenueBase - totals.cogsBase when a row was Unmatched.
 */

function input(over: Partial<CogsAggregationInput> & { id: string }): CogsAggregationInput {
  return {
    qty: '1', cogsBase: '40', productId: 'p1', sku: 'S1', productName: 'Widget', categoryName: null,
    warehouseId: 'w1', warehouseCode: 'W1', warehouseName: 'W1', customerName: 'Acme', channel: 'manual',
    revenueKey: 'L:L1', revenueBase: '400', revenueQty: '4', ...over,
  }
}

test('a line shipped across two periods books only the in-window share (o3d-002w)', () => {
  const june = aggregateCogsReport([input({ id: 'm1', qty: '1' })], 'product')
  assert.equal(june.rows[0]!.revenueBase!.exactString(), '100', 'one of four units: 100, not 400')
  assert.equal(june.totals.revenueBase.exactString(), '100')
  const july = aggregateCogsReport([input({ id: 'm2', qty: '3', cogsBase: '120' })], 'product')
  assert.equal(july.rows[0]!.revenueBase!.exactString(), '300')
  assert.equal(june.totals.revenueBase.add(july.totals.revenueBase).exactString(), '400', 'the two windows add to the line, once')
})

test('a line split across two warehouses in one window still books the whole line once', () => {
  const { totals } = aggregateCogsReport([
    input({ id: 'm1', qty: '1', warehouseId: 'w1', warehouseCode: 'W1' }),
    input({ id: 'm2', qty: '3', warehouseId: 'w2', warehouseCode: 'W2' }),
  ], 'warehouse')
  assert.equal(totals.revenueBase.exactString(), '400')
})

test('credit on a prorated line follows the same share; the out-of-window part bounds the totals (o3d-002w)', () => {
  const credit = emptyExactCredit()
  addExactCredit(credit, 'NET', '80')
  const { rows, totals, credits } = aggregateCogsReport(
    [input({ id: 'm1', qty: '1' })], 'product',
    { byRevenueKey: new Map([['L:L1', credit]]), outsideReport: emptyExactCredit(), unattributed: emptyExactCredit() },
  )
  assert.equal(rows[0]!.refundsNetBasis.exactString(), '20', 'a quarter of the credit for a quarter of the line')
  assert.equal(rows[0]!.revenueBase!.exactString(), '80', '100 - 20')
  assert.equal(totals.revenueBase.exactString(), '80')
  assert.equal(credits.outsideReport.net.exactString(), '60', 'the credit for units shipped in other windows is not dropped')
  assert.equal(credits.basisComplete, false)
})

test('the margin total reconciles with its own columns even when a row is Unmatched (o3d-002w)', () => {
  const { totals } = aggregateCogsReport([
    input({ id: 'm1', qty: '4', cogsBase: '160' }),
    input({ id: 'm2', productId: 'p2', sku: 'S2', revenueKey: null, revenueBase: null, revenueQty: null, cogsBase: '55' }),
  ], 'product')
  assert.equal(totals.cogsBase.exactString(), '215')
  assert.equal(totals.cogsBaseWithRevenue.exactString(), '160')
  assert.equal(totals.revenueBase.sub(totals.cogsBaseWithRevenue).exactString(), totals.grossMarginBase.exactString())
  assert.equal(totals.grossMarginBase.exactString(), '240')
})

test('resolveCogsRevenueKeys carries the line quantity the revenue is denominated in', () => {
  const [line] = resolveCogsRevenueKeys(
    [{ orderId: 'O1', productId: 'p1', shipmentLine: { lineId: 'L1', lineProductId: 'p1', lineTotalBase: '400', lineQty: '4' } }],
    new Map(),
  )
  assert.equal(line!.revenueQty!.toString(), '4')
  const [blended] = resolveCogsRevenueKeys(
    [{ orderId: 'O1', productId: 'p1', shipmentLine: null }],
    new Map([['O1:p1', toDecimal('400')]]), new Map([['O1:p1', toDecimal('4')]]),
  )
  assert.equal(blended!.revenueQty!.toString(), '4')
})
