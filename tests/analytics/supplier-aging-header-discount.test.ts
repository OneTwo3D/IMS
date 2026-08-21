import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { headerDiscountedReturnCreditBase } from '@/lib/domain/purchasing/return-credit-basis'

/**
 * o3d-iigc round 4, Codex finding 4: THE HEADER-DISCOUNT MISMATCH ROUND 3 FLAGGED ON ITSELF.
 *
 * Round 3 put the two sides of the supplier-aging subtraction on the same VAT basis and wrote, in its
 * own comment, that "a return is valued at `unitCostBase`, which a header order discount never
 * reduces, so a return against a header-discounted PO is credited at the pre-discount cost". That is
 * the SAME defect shape it had just repaired — one side of a subtraction measured on an axis the
 * other side is not — with the DISCOUNT in place of the VAT. It is due.
 *
 * WHY THE MISMATCH EXISTS, in the tree: createPurchaseOrder builds each line's `unitCostBase` from
 * the line-discounted, VAT-extracted unit cost and sums them into `subtotalBase`; only THEN does
 * applyHeaderOrderDiscount subtract `discountNetBase` from `subtotalBase` and `discountVatBase` from
 * `taxBase`, never revisiting the lines. So `unitCostBase` is PRE-header-discount and `totalBase` is
 * POST. PurchaseReturnLine stores no amount of its own, so that unit cost is the only place a
 * return's value is formed.
 *
 * WORKED, and the numbers every test below uses. A PO of 10 units at £100 net = £1,000, less a 10%
 * header discount:
 *
 *     subtotalBase 900   taxBase 180 (20% of 1,000, less the 20% of the discount)   totalBase 1,080
 *
 * One unit comes back. `unitCostBase` is still 100.
 *
 *     old:  1,080 - 180 - 100 = 800
 *     kept: nine of the ten units, and the goods kept are 9/10 of 900 = 810
 *
 * The £10 gap is exactly the header discount on the returned unit — money the supplier was never
 * paid, credited back a second time.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

type PoOpts = {
  /** Ex-VAT goods BEFORE the header discount — the sum of the line totals. */
  preDiscountNet: number
  /** Ex-VAT goods AFTER it — PurchaseOrder.subtotalBase. */
  postDiscountNet: number
  taxBase: number
  freightBase?: number
  /** Unit cost as stored on the PO line: ex-VAT and PRE header discount. */
  returnLines?: { qtyReturned: number; unitCostBase: number }[]
  lineTotals?: number[]
}

function po(o: PoOpts) {
  return {
    totalBase: o.postDiscountNet + o.taxBase + (o.freightBase ?? 0),
    taxBase: o.taxBase,
    directFreightBase: o.freightBase ?? 0,
    subtotalBase: o.postDiscountNet,
    lines: (o.lineTotals ?? [o.preDiscountNet]).map((totalBase) => ({ totalBase })),
    poSentAt: null,
    receivedAt: null,
    invoices: [],
    returns: o.returnLines?.length
      ? [{ lines: o.returnLines.map((l) => ({ qtyReturned: l.qtyReturned, poLine: { unitCostBase: l.unitCostBase } })) }]
      : [],
  }
}

let SUPPLIERS: { id: string; name: string; purchaseOrders: ReturnType<typeof po>[] }[] = []

mock.module('@/lib/db', {
  namedExports: { db: { supplier: { findMany: async () => SUPPLIERS } } },
})

async function aging(name: string) {
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const rows = await getSupplierAging()
  const row = rows.find((r) => r.supplierName === name)
  assert.ok(row, `no aging row for ${name}`)
  return row
}

/** The worked PO above: £1,000 of goods, 10% header discount, one of ten units returned. */
const DISCOUNTED_PO = po({
  preDiscountNet: 1000,
  postDiscountNet: 900,
  taxBase: 180,
  returnLines: [{ qtyReturned: 1, unitCostBase: 100 }],
})

test('supplier aging: a return against a header-discounted PO is credited at £90, not £100 (o3d-iigc r4 #4)', async () => {
  SUPPLIERS = [{ id: 'sup-1', name: 'Acme', purchaseOrders: [DISCOUNTED_PO] }]
  const r = await aging('Acme')

  assert.equal(r.grossAmount, 1080, 'the VAT-inclusive committed spend is what the supplier billed')
  assert.equal(r.tax, 180)
  // Was £100 — the pre-discount line cost, subtracted from a post-discount total.
  assert.equal(r.refunds, 90, 'the credit is scaled onto the goods value the order total is measured on')

  // The old figure. It is a real candidate and it is NOT the one published.
  assert.notEqual(r.netAmount, 800)
  assert.equal(r.netAmount, 810, 'nine of ten units kept, at the post-discount goods value: 0.9 x 900')

  // A reader with the three columns in front of them can still check the arithmetic.
  assert.equal(r.grossAmount - r.tax - r.refunds, r.netAmount)
})

test('supplier aging: with NO header discount the figure is unchanged, to the penny (o3d-iigc r4 #4 control)', async () => {
  // Round 3's own £1,000 + £200 VAT PO with a £100 return: the factor is exactly 1.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({ preDiscountNet: 1000, postDiscountNet: 1000, taxBase: 200, returnLines: [{ qtyReturned: 1, unitCostBase: 100 }] })],
  }]
  const r = await aging('Acme')

  assert.equal(r.refunds, 100, 'no discount, no scaling — the credit is the line cost')
  assert.equal(r.netAmount, 900, "round 3's answer survives unchanged")
  // The control is not vacuous: the SAME return under the discounted PO above is 90/810.
  assert.notEqual(r.refunds, 90)
})

test('supplier aging: the discount is spread across lines in proportion, as the order applied it (o3d-iigc r4 #4)', async () => {
  // applyHeaderOrderDiscount reduces the NET SUBTOTAL by one amount and leaves each line's share of
  // it proportional to that line's net total, so one factor governs every line of the order. Two
  // lines of £600 and £400; a £200 header discount leaves £800.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      preDiscountNet: 1000, lineTotals: [600, 400], postDiscountNet: 800, taxBase: 160,
      // One £60 unit off the first line and one £40 unit off the second: £100 at line cost.
      returnLines: [{ qtyReturned: 1, unitCostBase: 60 }, { qtyReturned: 1, unitCostBase: 40 }],
    })],
  }]
  const r = await aging('Acme')

  assert.equal(r.refunds, 80, '0.8 x 100 — the same fraction the order discount took off the goods')
  assert.equal(r.netAmount, 720, '960 - 160 - 80')
})

test('supplier aging: a PO with no returns never touches the factor at all (o3d-iigc r4 #4 control)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({ preDiscountNet: 1000, postDiscountNet: 900, taxBase: 180 })],
  }]
  const r = await aging('Acme')
  assert.equal(r.refunds, 0)
  assert.equal(r.netAmount, 900, 'the ex-VAT goods value, post-discount, exactly as stored')
})

// ---------------------------------------------------------------------------
// The factor itself
// ---------------------------------------------------------------------------

test('the credit factor is read back from the STORED totals, not recomputed from a discount string (o3d-iigc r4 #4)', () => {
  // A PO whose totals were written by any other path — a supplier requote through submitSupplierQuote,
  // an import, an FX rebase — is scaled by what its own stored totals say. Here the stored subtotal
  // is 75% of the line totals, whatever produced that.
  assert.equal(headerDiscountedReturnCreditBase({
    subtotalBase: 750,
    lines: [{ totalBase: 1000 }],
    returns: [{ lines: [{ qtyReturned: 2, poLine: { unitCostBase: 50 } }] }],
  }), 75)
})

test('the credit factor degrades to 1 rather than to zero or NaN (o3d-iigc r4 #4)', () => {
  const returns = [{ lines: [{ qtyReturned: 1, poLine: { unitCostBase: 100 } }] }]

  // No lines at all, or only zero-value ones: there is no proportion to take, so the credit is left
  // as it was. Dividing by zero here would publish NaN, and clamping to zero would silently delete a
  // real credit — both worse than the pre-existing behaviour.
  assert.equal(headerDiscountedReturnCreditBase({ subtotalBase: 0, lines: [], returns }), 100)
  assert.equal(headerDiscountedReturnCreditBase({ subtotalBase: 0, lines: [{ totalBase: 0 }], returns }), 100)
  assert.equal(headerDiscountedReturnCreditBase({ subtotalBase: null, lines: [{ totalBase: 1000 }], returns }), 100)

  // And a fully discounted order genuinely credits nothing back, because nothing was paid.
  assert.equal(headerDiscountedReturnCreditBase({ subtotalBase: 0, lines: [{ totalBase: 1000 }], returns }), 0)
})

test('a PO with no returns never READS the discount fields at all (o3d-iigc r4 #4)', () => {
  // Not merely "the answer is 0" — 0 x any factor is 0, so that alone would assert nothing. What the
  // short-circuit buys is that a returns-free order never depends on `subtotalBase` or the line
  // totals, which is what makes the degenerate shapes above unreachable for the overwhelming
  // majority of POs. Asserted with fields that detonate if touched.
  let touched = false
  const po = {
    get subtotalBase(): number { touched = true; return 900 },
    get lines(): { totalBase: number }[] { touched = true; return [{ totalBase: 1000 }] },
    returns: [] as { lines: { qtyReturned: number; poLine: { unitCostBase: number } }[] }[],
  }
  assert.equal(headerDiscountedReturnCreditBase(po), 0)
  assert.equal(touched, false, 'the discount fields were read for an order that has no credit to value')
})
