import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { parseCsv } from '@/lib/csv'

/**
 * o3d-azdf: A NET RETURN CREDIT SUBTRACTED FROM A GROSS PURCHASE-ORDER TOTAL.
 *
 * The defect as filed:
 *
 *     grossAmount += Number(po.totalBase)              // GROSS - includes PurchaseOrder.taxBase
 *     refunds     += qtyReturned * poLine.unitCostBase // NET   - "effective net cost per stock unit"
 *     netAmount    = grossAmount - refunds             // mixes the two
 *
 * On a 1,000.00 net PO plus 200.00 VAT with one unit returned at a 100.00 net unit cost that
 * published 1,100.00, where consistent-gross is 1,080.00 and consistent-net is 900.00. IT MATCHED
 * NEITHER, so it answered no question a reader could have asked.
 *
 * THE PRODUCTION FIX IS ALREADY IN THIS BRANCH'S BASE, landed by o3d-iigc as commit d5c004eb
 * (PR #633): rounds 3 and 4 put both sides of the subtraction on the same basis on BOTH axes —
 * consistent-NET for the VAT (`grossAmount - tax - refunds`, using the header's own stored
 * `taxBase`, which needs no conversion and no per-line rate re-derivation), and, in
 * `headerDiscountedReturnCreditBase`, post-header-discount for the DISCOUNT, because a return
 * credited at its pre-discount `unitCostBase` credits the discount on the returned unit twice.
 *
 * SO THIS FILE IS A GUARD, NOT A REPAIR, and it guards the join that o3d-8u4h has just created.
 * That issue added VAT-INCLUSIVE billing figures to this very row — `billedAmount`,
 * `billedWithPaymentMarker`, `billedWithoutPaymentMarker`, all sums of `PurchaseInvoice.totalBase` — sitting
 * beside an ex-VAT `netAmount` and a net `refunds`. Gross-basis money next to net-basis money in one
 * accumulator loop is precisely the arrangement that produced the original defect, so every case
 * below carries BILLS as well as a return and asserts that the billing side does not reach the net
 * figure. The existing net-basis and header-discount files cover the two axes without any bills at
 * all; nothing before this asserted that the two families stay apart.
 *
 * MUTATION EVIDENCE (there is no production change to revert): restoring the filed defect —
 * `netAmount: Math.round((grossAmount - refunds) * 100) / 100` in getSupplierAging — fails
 * every test in this file.
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

type PoOpts = {
  /** Ex-VAT goods BEFORE any header discount — the sum of the line totals. */
  preDiscountNet: number
  /** Ex-VAT goods AFTER it — PurchaseOrder.subtotalBase. Defaults to no discount. */
  postDiscountNet?: number
  taxBase: number
  lineTotals?: number[]
  /** Unit cost as stored on the PO line: EX-VAT, and PRE header discount. */
  returnLines?: { qtyReturned: number; unitCostBase: number }[]
  /** Supplier bills: VAT-INCLUSIVE totals, i.e. the OTHER basis. */
  bills?: { totalBase: number; ageDays: number; marked?: boolean }[]
}

function po(o: PoOpts) {
  const postDiscountNet = o.postDiscountNet ?? o.preDiscountNet
  return {
    totalBase: postDiscountNet + o.taxBase,
    taxBase: o.taxBase,
    directFreightBase: 0,
    subtotalBase: postDiscountNet,
    lines: (o.lineTotals ?? [o.preDiscountNet]).map((totalBase) => ({ totalBase })),
    poSentAt: null,
    receivedAt: null,
    invoices: (o.bills ?? []).map((b) => ({
      totalBase: b.totalBase,
      invoiceDate: new Date(Date.now() - b.ageDays * 86400000),
      paidAt: b.marked ? new Date(Date.now() - 86400000) : null,
    })),
    returns: o.returnLines?.length
      ? [{ lines: o.returnLines.map((l) => ({ qtyReturned: l.qtyReturned, poLine: { unitCostBase: l.unitCostBase } })) }]
      : [],
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

test('supplier aging: the issue own worked example — 900.00, and not 1,100.00 (o3d-azdf)', async () => {
  // 1,000.00 net + 200.00 VAT = 1,200.00 gross. One unit back at its 100.00 NET unit cost.
  // The whole 1,200.00 is also billed, so the GROSS-basis billing figures are on the row too.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      preDiscountNet: 1000, taxBase: 200,
      returnLines: [{ qtyReturned: 1, unitCostBase: 100 }],
      bills: [{ totalBase: 1200, ageDays: 10 }],
    })],
  }]
  const r = await agingRow()

  // The two sides, each still on its OWN recorded basis where it is reported.
  assert.equal(r.grossAmount, 1200, 'VAT-INCLUSIVE committed spend, untouched')
  assert.equal(r.tax, 200)
  assert.equal(r.refunds, 100, 'the credit is reported at the ex-VAT line cost it is stored at — not grossed up')

  // The published figure, and both of the answers it is NOT.
  assert.equal(r.netAmount, 900, 'consistent-net: 1,000 of goods less a 100 net return')
  assert.notEqual(r.netAmount, 1100, 'the filed defect: a NET credit taken off a GROSS total')
  assert.notEqual(r.netAmount, 1080, 'consistent-gross is a real candidate, and it is not the one published')

  // The gross-basis billing figures o3d-8u4h added sit on this row and stay out of the subtraction.
  assert.equal(r.billedAmount, 1200)
  assert.equal(r.billedWithoutPaymentMarker, 1200)
  assert.equal(r.grossAmount - r.tax - r.refunds, r.netAmount, 'the reader can check it from the columns beside it')
})

test('supplier aging: both axes at once — VAT and header discount, with bills on the row (o3d-azdf)', async () => {
  // 1,000 of goods less a 10% header discount = 900 net, +180 VAT = 1,080 gross. One of ten units
  // returned; `unitCostBase` is still the PRE-discount 100. Two bills, one carrying a payment marker, one not.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      preDiscountNet: 1000, postDiscountNet: 900, taxBase: 180,
      returnLines: [{ qtyReturned: 1, unitCostBase: 100 }],
      bills: [
        { totalBase: 600, ageDays: 120, marked: true },
        { totalBase: 480, ageDays: 20 },
      ],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.refunds, 90, 'scaled onto the post-discount goods value the order total is measured on')
  assert.equal(r.netAmount, 810, 'nine of ten units kept, at the post-discount goods value: 0.9 x 900')

  // Every wrong answer this arrangement can produce, named:
  assert.notEqual(r.netAmount, 990, 'the o3d-azdf defect on this PO: 1,080 gross less a 90 net credit')
  assert.notEqual(r.netAmount, 800, 'crediting the pre-discount 100 credits the discount on that unit twice')
  assert.notEqual(r.netAmount, 980, 'and the two defects together')

  // Billing is on the OTHER basis and stays there.
  assert.equal(r.billedAmount, 1080)
  assert.equal(r.billedWithPaymentMarker, 600)
  assert.equal(r.billedWithoutPaymentMarker, 480)
  assert.equal(r.grossAmount - r.tax - r.refunds, r.netAmount)
})

test('supplier aging: a fully returned, fully billed PO leaves NO surviving spend (o3d-azdf)', async () => {
  // The customer-aging shape from o3d-iigc, on the purchase side: a fully credited order that reads
  // as some surviving amount is the signature of a cross-basis subtraction. Here the whole order
  // comes back, so the ex-VAT figure is exactly 0 — while 1,200 is still BILLED and carries no payment marker.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      preDiscountNet: 1000, taxBase: 200,
      returnLines: [{ qtyReturned: 10, unitCostBase: 100 }],
      bills: [{ totalBase: 1200, ageDays: 200 }],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.refunds, 1000)
  assert.equal(r.netAmount, 0, 'nothing was kept, so no goods value survives')
  assert.notEqual(r.netAmount, 200, 'the filed defect leaves exactly the VAT behind, looking like surviving spend')

  // And the billing side is untouched by the return, because a return is not a payment and this
  // report does not net supplier credit notes off what was billed.
  assert.equal(r.billedAmount, 1200)
  assert.equal(r.billedWithoutPaymentMarker91plus, 1200)
})

test('supplier-aging CSV: net and billed columns reconcile SEPARATELY in the file (o3d-azdf)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      preDiscountNet: 1000, postDiscountNet: 900, taxBase: 180,
      returnLines: [{ qtyReturned: 1, unitCostBase: 100 }],
      bills: [{ totalBase: 600, ageDays: 120, marked: true }, { totalBase: 480, ageDays: 20 }],
    })],
  }]
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest('https://ims.test/api/export/analytics?type=po_aging'))
  const [row] = parseCsv(await res.text())

  assert.equal(row.netAmountExVat, '810.00')
  assert.equal(row.refunds, '90.00')
  assert.equal(
    Number(row.grossAmount) - Number(row.tax) - Number(row.refunds),
    Number(row.netAmountExVat),
    'the net family reconciles on the net basis',
  )
  assert.equal(
    Number(row.billedWithPaymentMarker) + Number(row.billedWithoutPaymentMarker),
    Number(row.billedAmount),
    'the billed family reconciles on the gross basis, and the two families never cross',
  )
  assert.notEqual(Number(row.netAmountExVat), 990)
})
