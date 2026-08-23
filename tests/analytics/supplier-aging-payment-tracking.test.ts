import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { parseCsv } from '@/lib/csv'

/**
 * o3d-8u4h: SUPPLIER AGING PUBLISHED THREE QUANTITIES THE SYSTEM DOES NOT HOLD.
 *
 * `getSupplierAging` returned `paidAmount: 0`, `discounts: 0` and `dueAmount: billedAmount`. None of
 * the three was a calculation that came out wrong — each was a LITERAL standing where a measurement
 * belongs, which is the worse failure, because a wrong calculation is at least a calculation. A `0`
 * in a Paid column is the strongest claim the column can make: nothing has ever been paid to this
 * supplier. And with no payment offset anywhere in the function, every bucket aged from the invoice
 * date forever, so a bill settled two years ago still sat in the 91+ column.
 *
 * WHAT THE SCHEMA HOLDS, checked rather than assumed. `Payment` is sales-only (orderId ->
 * SalesOrder, refundId -> SalesOrderRefund), so no row anywhere carries an amount paid to a
 * supplier. But `PurchaseInvoice.paidAt` DOES exist — a settlement flag with a date, and no amount —
 * and the sibling AP aging report in lib/domain/finance/finance-period-analytics.ts already reads it
 * and states, in its own notice, that partial supplier payments are not stored.
 *
 * SO THE SHAPE IS o3d-iigc's RULE, APPLIED UNCHANGED: a figure that cannot be stated publishes
 * nothing, while the related total that IS known stays on the row.
 *
 *   Paid, Due, Discounts   withheld — `null`, never `0`
 *   Billed                 unchanged, and split into Settled / Unsettled BILLED value, because how
 *                          much was BILLED on each side of the flag is not in doubt
 *   the four buckets       the number survives and the relation is withheld: unsettled bills only,
 *                          and no longer called `overdue`
 *
 * EVERY ASSERTION BELOW IS ON WHAT THE REPORT PUBLISHES — the row and the exported file. A test that
 * checked a call or a log line would reproduce the very defect: the old code called nothing and
 * logged nothing, it simply published a number it had no right to.
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

const DAY = 86400000

/** A bill: VAT-inclusive `totalBase`, plus the settlement flag or the absence of one. */
function bill(totalBase: number, ageDays: number, paidAt: Date | null = null) {
  return { totalBase, invoiceDate: new Date(Date.now() - ageDays * DAY), paidAt }
}

/** A committed PO with no returns and no discount, so only the billing side is in play. */
function po(opts: { totalBase: number; taxBase: number; bills?: ReturnType<typeof bill>[] }) {
  const goodsExVat = opts.totalBase - opts.taxBase
  return {
    totalBase: opts.totalBase, taxBase: opts.taxBase, directFreightBase: 0,
    subtotalBase: goodsExVat, lines: [{ totalBase: goodsExVat }],
    poSentAt: null, receivedAt: null,
    invoices: opts.bills ?? [],
    returns: [],
  }
}

let SUPPLIERS: { id: string; name: string; purchaseOrders: ReturnType<typeof po>[] }[] = []

mock.module('@/lib/db', {
  namedExports: { db: { supplier: { findMany: async () => SUPPLIERS } } },
})

async function agingRow(name = 'Acme') {
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const row = (await getSupplierAging()).find((r) => r.supplierName === name)
  assert.ok(row, `no aging row for ${name}`)
  return row
}

async function exportBody(): Promise<string> {
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest('https://ims.test/api/export/analytics?type=po_aging'))
  return res.text()
}

// ---------------------------------------------------------------------------
// The three published literals
// ---------------------------------------------------------------------------

test('supplier aging: Paid is WITHHELD, not 0 — no amount paid to a supplier is recorded (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({ totalBase: 1200, taxBase: 200, bills: [bill(1200, 10)] })],
  }]
  const r = await agingRow()

  // The point of the whole issue: 0 is a figure, and it was the wrong one. `null` is an admission.
  assert.equal(r.paidAmount, null)
  assert.notEqual(r.paidAmount, 0, 'a 0 here reads as "nothing has ever been paid to this supplier"')

  // The related total that IS known is still on the row — how much was BILLED is not in doubt.
  assert.equal(r.billedAmount, 1200)
})

test('supplier aging: Due is WITHHELD — it used to be the entire billed ledger, forever (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({ totalBase: 1200, taxBase: 200, bills: [bill(1200, 10)] })],
  }]
  const r = await agingRow()

  assert.equal(r.dueAmount, null)
  // The old value, spelled out: due WAS billed, unconditionally.
  assert.notEqual(r.dueAmount, r.billedAmount)
  assert.notEqual(r.dueAmount, 1200)
})

test('supplier aging: Discounts is WITHHELD — a part of a discount is not a discount total (o3d-8u4h)', async () => {
  // A PO with a real 10% header discount: 1,000 of goods becomes 900, and 900/1000 is exactly
  // recoverable from the stored totals. The per-line part is NOT — it is already inside those line
  // totals and survives only in foreign currency under the order's own tax convention — so a
  // Discounts column filled from the header alone would publish a part as a total.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [{
      totalBase: 1080, taxBase: 180, directFreightBase: 0, subtotalBase: 900,
      lines: [{ totalBase: 1000 }], poSentAt: null, receivedAt: null, invoices: [], returns: [],
    }],
  }]
  const r = await agingRow()

  assert.equal(r.discounts, null)
  assert.notEqual(r.discounts, 0, 'a 0 here reads as "this supplier gave no discount at all"')
  // And NOT the recoverable header part either — that is the part-as-total error.
  assert.notEqual(r.discounts, 100)
})

// ---------------------------------------------------------------------------
// What replaces them, and what it is allowed to claim
// ---------------------------------------------------------------------------

test('supplier aging: Billed splits into Settled and Unsettled, and the row adds up (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 3000, taxBase: 500,
      bills: [bill(1200, 200, new Date(Date.now() - 100 * DAY)), bill(800, 40), bill(1000, 5)],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.billedAmount, 3000)
  assert.equal(r.settledBilledAmount, 1200, 'the ONE bill carrying a settlement flag, at its billed value')
  assert.equal(r.unsettledBilledAmount, 1800)
  // Checkable across the row by the reader, which is the property that makes the split honest.
  assert.equal(r.settledBilledAmount + r.unsettledBilledAmount, r.billedAmount)
})

test('supplier aging: a bill settled long ago STOPS AGEING (o3d-8u4h)', async () => {
  // The headline case from the issue: a settled bill used to sit in the 91+ column forever, because
  // nothing in the function had ever looked at a settlement.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 5000, taxBase: 0,
      bills: [
        bill(2000, 400, new Date(Date.now() - 380 * DAY)), // paid 380 days ago, invoiced 400
        bill(700, 400),                                    // same age, never settled
        bill(300, 75),
        bill(200, 45),
        bill(100, 5),
      ],
    })],
  }]
  const r = await agingRow()

  // 700, not 2,700: the settled bill is gone from the bucket.
  assert.equal(r.unsettledBilled91plus, 700)
  assert.notEqual(r.unsettledBilled91plus, 2700, 'the settled bill must not age forever')
  assert.equal(r.unsettledBilled61_90, 300)
  assert.equal(r.unsettledBilled31_60, 200)
  assert.equal(r.unsettledBilled0_30, 100)

  // The buckets are exactly the unsettled billed value, split by invoice age — nothing lost, and
  // nothing counted that the Unsettled total does not also carry.
  assert.equal(
    r.unsettledBilled0_30 + r.unsettledBilled31_60 + r.unsettledBilled61_90 + r.unsettledBilled91plus,
    r.unsettledBilledAmount,
  )
  assert.equal(r.unsettledBilledAmount, 1300)
  assert.equal(r.settledBilledAmount, 2000)
})

test('supplier aging: a supplier whose every bill is settled shows an empty ageing profile (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-2', name: 'Prompt Payer Ltd',
    purchaseOrders: [po({
      totalBase: 1200, taxBase: 200,
      bills: [bill(1200, 500, new Date(Date.now() - 480 * DAY))],
    })],
  }]
  const r = await agingRow('Prompt Payer Ltd')

  // Was 1,200 in the 91+ column, in red, for the rest of time.
  assert.equal(r.unsettledBilled91plus, 0)
  assert.equal(r.unsettledBilledAmount, 0)
  assert.equal(r.settledBilledAmount, 1200)
  assert.equal(r.billedAmount, 1200, 'billed is still billed — the bill did not stop existing')
})

test('supplier aging: rounding still happens ONCE, across the split (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 400, taxBase: 0,
      bills: [bill(66.665, 10), bill(66.665, 10), bill(66.665, 200, new Date(Date.now() - DAY))],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.unsettledBilledAmount, 133.33, 'summed then rounded; per-bill rounding would say 133.34')
  assert.equal(r.unsettledBilled0_30, 133.33)
  assert.equal(r.settledBilledAmount, 66.67)
})

// ---------------------------------------------------------------------------
// The exported file — a spreadsheet reader has no tooltip
// ---------------------------------------------------------------------------

test('supplier-aging CSV: Due is an EMPTY cell, and the file carries the reason (o3d-8u4h)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 1200, taxBase: 200,
      bills: [bill(500, 200), bill(700, 10, new Date())],
    })],
  }]
  const body = await exportBody()
  const header = body.split('\r\n')[0].split(',')
  const [row] = parseCsv(body)

  // Empty, not '0.00'. A 0 in a spreadsheet is summed, charted and believed.
  assert.equal(row.dueAmount, '')
  assert.notEqual(row.dueAmount, '0.00')
  assert.notEqual(row.dueAmount, '1200.00')

  assert.equal(row.billedAmount, '1200.00')
  assert.equal(row.settledBilledAmount, '700.00')
  assert.equal(row.unsettledBilledAmount, '500.00')
  assert.equal(
    Number(row.settledBilledAmount) + Number(row.unsettledBilledAmount),
    Number(row.billedAmount),
    'the columns in the file must reconcile — a reader has only the file',
  )

  // The word that claimed a relation to a due date this report does not measure.
  assert.ok(!header.some((h) => h.startsWith('overdue')), 'the overdue columns must not come back')
  assert.ok(header.includes('unsettledBilled91plus'))
  assert.equal(row.unsettledBilled91plus, '500.00')

  // The metadata rows at the foot of the file (and the X-IMS-Export-Metadata header) say WHY the
  // cell is empty, so the emptiness is a statement rather than a gap.
  assert.match(body, /# IMS export metadata/)
  assert.match(body, /IMS records no amount paid to a supplier/)
})
