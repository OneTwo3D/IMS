import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  getReturnsAnalyticsReport,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'

/**
 * o3d-iigc round 5: THE RETURNS REPORT WAS SUMMING CREDITS OF DIFFERENT BASES INTO ONE FIGURE —
 * AND SORTING THE REPORT BY THAT FIGURE.
 *
 * Round 4 found it, named it and left it, so this is the same defect one round later. It did not
 * even SELECT `totalsBasis`, so no reader of the query could have seen a basis decision being made;
 * there was not one to see.
 *
 * A NET amount plus a GROSS amount is on neither basis — the same reason `netOfRefunds` returns null
 * for a mixed set instead of a plausible-looking total. Worse than the wrong figure, it ordered the
 * page: a row of legacy gross credits outranked a larger net one purely on the VAT it still carried,
 * so the "biggest returns problem" a reader was shown could be an artefact of when the credit was
 * written.
 */

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): SalesFulfillmentAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    product: {
      findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
        .map((id) => ({ id, type: 'SIMPLE', productComponents: [] })),
    },
    salesOrder: unused,
    salesOrderRefund: unused,
    salesOrderRefundLine: unused,
    cogsEntry: unused,
    stockMovement: unused,
    shipment: unused,
    activityLog: unused,
  }
}

type LineSpec = {
  productId: string
  sku: string
  refundId: string
  totalsBasis: string | null
  qty: string
  totalBase: string
  customerName?: string
}

function refundLine(spec: LineSpec) {
  return {
    id: `${spec.refundId}-${spec.productId}`,
    refundId: spec.refundId,
    productId: spec.productId,
    description: spec.sku,
    qty: decimal(spec.qty),
    totalBase: decimal(spec.totalBase),
    product: { id: spec.productId, sku: spec.sku, name: spec.sku },
    refund: {
      id: spec.refundId,
      reason: 'Damaged',
      totalBase: decimal(spec.totalBase),
      totalsBasis: spec.totalsBasis,
      refundedAt: new Date('2026-06-01T12:00:00.000Z'),
      order: {
        customerName: spec.customerName ?? 'Customer A',
        lines: [{ productId: spec.productId, qty: decimal('10') }],
      },
    },
  }
}

async function report(lines: ReturnType<typeof refundLine>[], shipped: Array<{ productId: string; qty: string }> = []) {
  const client: SalesFulfillmentAnalyticsClient = {
    ...unusedClient(),
    salesOrderRefundLine: { findMany: async () => lines },
    stockMovement: { findMany: async () => shipped.map((s) => ({ productId: s.productId, qty: decimal(s.qty) })) },
  }
  return getReturnsAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client, now: () => new Date('2026-06-01T15:00:00.000Z') },
  )
}

test('a row mixing NET and GROSS credits states NO single value (o3d-iigc r5)', async () => {
  const rows = [
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' }),
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r2', totalsBasis: 'GROSS', qty: '1', totalBase: '120' }),
  ]
  const result = await report(rows, [{ productId: 'p1', qty: '10' }])

  const row = result.rows[0]!
  // The old figure was '220' — one hundred ex-VAT added to one hundred and twenty VAT-inclusive,
  // an amount on neither basis, presented as a measurement.
  assert.equal(row.refundValueBase, null)
  assert.equal(row.refundValueBasis, 'MIXED')
  // A null is an ADMISSION, and the three buckets are what stop it being a loss of information:
  // how much credit exists is never in doubt, only what unit a single total would be in.
  assert.equal(row.refundValueNetBasis, '100')
  assert.equal(row.refundValueGrossBasis, '120')
  assert.equal(row.refundValueUnknownBasis, '0')
  // Quantity is basis-independent, so it still takes every line.
  assert.equal(row.returnedQty, '2')
  assert.equal(row.returnRatePct, '20')
})

test('a row on ONE basis still states its value, on that basis (o3d-iigc r5 control)', async () => {
  const net = await report(
    [refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' })],
    [{ productId: 'p1', qty: '10' }],
  )
  // The control against over-refusal: an unambiguous row must not be withheld.
  assert.equal(net.rows[0]?.refundValueBase, '100')
  assert.equal(net.rows[0]?.refundValueBasis, 'NET')
  assert.equal(net.totals.refundValueBase, '100')

  const gross = await report(
    [refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'GROSS', qty: '1', totalBase: '120' })],
    [{ productId: 'p1', qty: '10' }],
  )
  assert.equal(gross.rows[0]?.refundValueBase, '120')
  assert.equal(gross.rows[0]?.refundValueBasis, 'GROSS')
})

test('an unstamped credit states its AMOUNT and withholds only the basis (o3d-iigc r5)', async () => {
  const result = await report(
    [refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: null, qty: '1', totalBase: '75' })],
    [{ productId: 'p1', qty: '10' }],
  )
  // £75 of credit provably exists; what is unknown is which basis it is on. Withholding the amount
  // as well would be the other failure mode — refusing to report a fact we hold.
  assert.equal(result.rows[0]?.refundValueBase, '75')
  assert.equal(result.rows[0]?.refundValueBasis, 'UNKNOWN')
  assert.equal(result.rows[0]?.refundValueUnknownBasis, '75')
})

test('an EXACTLY-zero bucket does not make a unanimous row mixed (o3d-iigc r5 control)', async () => {
  const result = await report([
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' }),
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r2', totalsBasis: 'GROSS', qty: '1', totalBase: '0' }),
  ], [{ productId: 'p1', qty: '10' }])

  // Zero is identical on both bases, so it carries no basis information. Treating it as a second
  // basis would blank a row that is in fact perfectly well defined.
  assert.equal(result.rows[0]?.refundValueBase, '100')
  assert.equal(result.rows[0]?.refundValueBasis, 'NET')
})

test('a row whose value cannot be stated sorts LAST, not among the zeroes (o3d-iigc r5)', async () => {
  const result = await report([
    // p1: mixed, and by the old summed figure it was the largest at 220.
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' }),
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r2', totalsBasis: 'GROSS', qty: '1', totalBase: '120' }),
    // p2: a single, unambiguous £150 NET credit.
    refundLine({ productId: 'p2', sku: 'SKU-2', refundId: 'r3', totalsBasis: 'NET', qty: '1', totalBase: '150' }),
    // p3: a single, unambiguous £10 NET credit.
    refundLine({ productId: 'p3', sku: 'SKU-3', refundId: 'r4', totalsBasis: 'NET', qty: '1', totalBase: '10' }),
  ])

  // The old order was p1 (220), p2 (150), p3 (10) — a ranking led by a number with no unit.
  // An unstated value has no position in the ordering, so it goes last; pinning it to the top would
  // only move the same false claim to the other end.
  assert.deepEqual(result.rows.map((r) => r.sku), ['SKU-2', 'SKU-3', 'SKU-1'])
  assert.equal(result.rows[2]?.refundValueBase, null)
})

test('the PERIOD total refuses too, and keeps its three buckets (o3d-iigc r5)', async () => {
  const result = await report([
    refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' }),
    refundLine({ productId: 'p2', sku: 'SKU-2', refundId: 'r2', totalsBasis: 'GROSS', qty: '1', totalBase: '120' }),
    refundLine({ productId: 'p3', sku: 'SKU-3', refundId: 'r3', totalsBasis: null, qty: '1', totalBase: '5' }),
  ])

  // Each ROW is unanimous, so each row states its own value — but the PERIOD is not, and the old
  // total said '225'.
  assert.deepEqual(result.rows.map((r) => r.refundValueBase), ['120', '100', '5'])
  assert.equal(result.totals.refundValueBase, 'Mixed basis')
  assert.equal(result.totals.refundValueBasis, 'MIXED')
  assert.equal(result.totals.refundValueNetBasis, '100')
  assert.equal(result.totals.refundValueGrossBasis, '120')
  assert.equal(result.totals.refundValueUnknownBasis, '5')
  // Quantity is unaffected by any of this.
  assert.equal(result.totals.returnedQty, '3')
})

test('the report states, in its own notices, what a blank value means (o3d-iigc r5)', async () => {
  const result = await report(
    [refundLine({ productId: 'p1', sku: 'SKU-1', refundId: 'r1', totalsBasis: 'NET', qty: '1', totalBase: '100' })],
  )
  // The page renders report.notices, and the CSV route carries the same string as export metadata,
  // because a file reader has no tooltip.
  assert.ok(
    result.notices.some((n) => n.includes('Rows with no single stated value sort last')),
    'the mixed-basis rule is stated where the figures are read',
  )
})
