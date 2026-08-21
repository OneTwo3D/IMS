import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-iigc round 2, Codex finding 2: the supplier aging "Net Amount" was an arithmetic hybrid.
 *
 * `PurchaseOrder.totalBase` is VAT-INCLUSIVE (createPurchaseOrder stores subtotalBase + taxBase +
 * directFreightBase). A purchase RETURN carries no amount of its own — PurchaseReturnLine stores
 * only a quantity — so its value is formed here, from `PurchaseOrderLine.unitCostBase`, which is
 * EX-VAT at every writer of that column. The report subtracted the second from the first.
 *
 * WORKED, on round 1's own numbers: a £1,000 net PO plus £200 VAT, with a £100 net return,
 * reported £1,100. Consistent-gross is £1,080. Consistent-net is £900. £1,100 IS NEITHER, so it
 * answered no question a reader could have asked.
 *
 * Round 1 filed rather than fixed this, on the grounds that "Net Amount" beside a gross column and
 * a tax column is a product decision. Choosing the CONVENTION is; publishing a figure that is
 * neither convention is not. The convention picked is CONSISTENT-NET, for two reasons that are
 * checkable rather than aesthetic:
 *
 *   1. It is this branch's existing rule, applied unchanged. `netOfRefunds`/`orderTotalOnBasis`
 *      put the ORDER total on THE CREDIT'S basis and then subtract. The credit here is provably
 *      NET, so the PO total goes on the NET basis.
 *   2. It needs NO CONVERSION. `taxBase` is stored on the PO header, so gross-less-VAT is exact,
 *      whereas grossing the return up would mean re-deriving a rate per return line — and each
 *      line of a PO may carry its own tax rate.
 *
 * Nothing is withheld: unlike the sales side there is no basis ambiguity to refuse, so refusing
 * would have been the opposite error.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

type ReturnLine = { qtyReturned: number; unitCostBase: number }

/** One committed PO. `totalBase` is GROSS; `taxBase` is the VAT inside it. */
function po(opts: {
  totalBase: number
  taxBase: number
  freightBase?: number
  invoices?: { totalBase: number; invoiceDate: Date }[]
  returnLines?: ReturnLine[]
  poSentAt?: Date | null
  receivedAt?: Date | null
}) {
  return {
    totalBase: opts.totalBase,
    taxBase: opts.taxBase,
    directFreightBase: opts.freightBase ?? 0,
    poSentAt: opts.poSentAt ?? null,
    receivedAt: opts.receivedAt ?? null,
    invoices: opts.invoices ?? [],
    returns: opts.returnLines?.length
      ? [{ lines: opts.returnLines.map((l) => ({ qtyReturned: l.qtyReturned, poLine: { unitCostBase: l.unitCostBase } })) }]
      : [],
  }
}

let SUPPLIERS: { id: string; name: string; purchaseOrders: ReturnType<typeof po>[] }[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      supplier: { findMany: async () => SUPPLIERS },
    },
  },
})

async function aging() {
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const rows = await getSupplierAging()
  return new Map(rows.map((r) => [r.supplierName, r]))
}

test('supplier aging: a NET return is subtracted from the EX-VAT total — £900, not £1,100 (o3d-iigc)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    // £1,000 net + £200 VAT; one unit returned at its £100 ex-VAT line cost.
    purchaseOrders: [po({ totalBase: 1200, taxBase: 200, returnLines: [{ qtyReturned: 1, unitCostBase: 100 }] })],
  }]
  const r = (await aging()).get('Acme')!

  assert.equal(r.grossAmount, 1200, 'the VAT-inclusive committed spend is unchanged')
  assert.equal(r.tax, 200)
  assert.equal(r.refunds, 100, 'the return, at the ex-VAT line cost, is unchanged')

  // Order matters: the first assertion is what kills the gross-basis convention on its own, the
  // second what kills the old hybrid, so neither is carried by the other.
  assert.notEqual(r.netAmount, 1080, 'the gross-basis answer is a real candidate, and it is NOT the one published')
  assert.equal(r.netAmount, 900, 'was 1100 — an ex-VAT credit taken off a VAT-inclusive total')
  assert.equal(r.grossAmount - r.tax - r.refunds, r.netAmount, 'the reader can check it from the columns beside it')

  assert.equal(r.totalAmount, 1200, 'Total stays the VAT-inclusive figure it has always been')
})

test('supplier aging: with no returns at all, Net Amount is simply the ex-VAT total (o3d-iigc)', async () => {
  SUPPLIERS = [{ id: 'sup-1', name: 'Acme', purchaseOrders: [po({ totalBase: 1200, taxBase: 200 })] }]
  const r = (await aging()).get('Acme')!

  // Was 1200 — identical to Gross and to Total, three columns showing one number while a Tax column
  // sat beside them.
  assert.equal(r.netAmount, 1000)
  assert.equal(r.refunds, 0)
})

test('supplier aging: a zero-rated supplier does not move at all (o3d-iigc control)', async () => {
  SUPPLIERS = [{
    id: 'sup-2', name: 'Zero Rated Ltd',
    purchaseOrders: [po({ totalBase: 500, taxBase: 0, returnLines: [{ qtyReturned: 5, unitCostBase: 10 }] })],
  }]
  const r = (await aging()).get('Zero Rated Ltd')!

  // With no VAT in the total the two conventions coincide, and this is the common case for the
  // overwhelming majority of suppliers — so the change is confined to VAT-bearing spend.
  assert.equal(r.grossAmount, 500)
  assert.equal(r.tax, 0)
  assert.equal(r.refunds, 50)
  assert.equal(r.netAmount, 450)
})

test('supplier aging: direct freight stays inside both Gross and Net (o3d-iigc)', async () => {
  SUPPLIERS = [{
    id: 'sup-3', name: 'Freighted',
    // £1,000 goods + £200 VAT + £50 freight = £1,250 gross. Only the VAT basis was in question,
    // so freight is not quietly removed on the way past — `landedCosts` reports it beside this.
    purchaseOrders: [po({ totalBase: 1250, taxBase: 200, freightBase: 50, returnLines: [{ qtyReturned: 2, unitCostBase: 25 }] })],
  }]
  const r = (await aging()).get('Freighted')!

  assert.equal(r.grossAmount, 1250)
  assert.equal(r.landedCosts, 50)
  assert.equal(r.netAmount, 1000, '1250 - 200 VAT - 50 returned')
})

test('supplier aging: several POs are netted on one basis, and rounding happens ONCE (o3d-iigc)', async () => {
  SUPPLIERS = [{
    id: 'sup-4', name: 'Multi',
    // Half-penny tails on every term, so rounding at the wrong moment is visible in the figure.
    purchaseOrders: [
      po({ totalBase: 199.995, taxBase: 33.335, returnLines: [{ qtyReturned: 1, unitCostBase: 11.115 }] }),
      po({ totalBase: 199.995, taxBase: 33.335 }),
    ],
  }]
  const r = (await aging()).get('Multi')!

  assert.equal(r.grossAmount, 399.99, 'summed then rounded; rounding each PO first would say 400.00')
  assert.equal(r.tax, 66.67, 'per-PO rounding would say 66.68')
  assert.equal(r.refunds, 11.12)
  // 399.99 - 66.67 - 11.115 on the UNROUNDED accumulators = 322.205 -> 322.21. Subtracting the
  // three already-rounded columns instead gives 322.20, and the old hybrid gave 388.88.
  assert.equal(r.netAmount, 322.21)
})

test('supplier aging: a supplier with nothing received reports NO average lead time (o3d-iigc)', async () => {
  SUPPLIERS = [{
    id: 'sup-5', name: 'Never Delivered Ltd',
    purchaseOrders: [po({ totalBase: 120, taxBase: 20, poSentAt: new Date('2026-01-01T00:00:00Z'), receivedAt: null })],
  }]
  const r = (await aging()).get('Never Delivered Ltd')!

  // Null, not 0 — and lib/analytics/table-filter-sort is what keeps that null from sorting to the
  // top of a "fastest suppliers first" list.
  assert.equal(r.avgLeadTimeDays, null)
})
