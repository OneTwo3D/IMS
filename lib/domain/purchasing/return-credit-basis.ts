/**
 * o3d-iigc round 4 (Codex finding 4): PUT THE RETURN CREDIT ON THE ORDER TOTAL'S DISCOUNT BASIS.
 *
 * Round 3 put the two sides of the supplier-aging subtraction on the same VAT basis and flagged, in
 * its own words, that "a return is valued at `unitCostBase`, which a header order discount never
 * reduces, so a return against a header-discounted PO is credited at the pre-discount cost". That is
 * due, and it is the SAME defect shape round 3 fixed — one side of a subtraction measured on an axis
 * the other side is not — with the discount in place of the VAT.
 *
 * WHY THE MISMATCH EXISTS, verified in the tree rather than assumed. createPurchaseOrder computes
 * each line's `unitCostBase` from the LINE-discounted, VAT-extracted unit cost, sums those into
 * `subtotalBase`, and only THEN applies the header discount — applyHeaderOrderDiscount subtracts
 * `discountNetBase` from `subtotalBase` and `discountVatBase` from `taxBase`, and never revisits the
 * lines. `PurchaseReturnLine` stores no amount of its own, so `qtyReturned x poLine.unitCostBase` is
 * the only place a return's value is formed, and it is a PRE-header-discount number. `po.totalBase`
 * is post-discount. Subtracting one from the other credits back money the supplier was never paid.
 *
 * THE FACTOR IS THE DISCOUNT'S OWN ALLOCATION, NOT A NEW ONE. applyHeaderOrderDiscount reduces the
 * net subtotal by a single amount and leaves every line's share of it proportional to that line's net
 * total — so the surviving fraction of every line is the same number, `subtotalBase / SUM(line.totalBase)`.
 * It is READ BACK from the stored totals rather than recomputed from `discountStr`, so a PO whose
 * totals were written by any other path (a supplier requote through submitSupplierQuote, an import,
 * an FX rebase) is scaled by what its own stored totals actually say.
 *
 * WORKED. A PO of 10 units at 100 net = 1,000, less a 10% header discount: subtotalBase 900, VAT
 * 180, totalBase 1,080. One unit comes back. `unitCostBase` is still 100, so the old code credited
 * 100 and reported 1,080 - 180 - 100 = 800. But nine of the ten units were kept and the goods kept
 * are 9/10 of 900 = 810. The factor is 900/1000 = 0.9, the credit is 90, and the figure is 810. The
 * 10 pounds of difference is exactly the header discount on the returned unit.
 *
 * NOT WITHHELD, deliberately: as with the VAT basis there is no ambiguity here to refuse — both the
 * pre- and post-discount goods values are stored and exact — so a figure IS computable and refusing
 * would be the opposite error.
 *
 * DEGENERATE CASE. When the pre-discount line total is not positive (a PO with no lines, or only
 * zero-value ones) there is no proportion to take, so the factor is 1 and the credit is unchanged —
 * which is also what a PO with no header discount gets, since the factor is then exactly 1 and the
 * figure is byte-for-byte what it was.
 */
export function headerDiscountedReturnCreditBase(po: {
  subtotalBase: unknown
  lines: { totalBase: unknown }[]
  returns: { lines: { qtyReturned: unknown; poLine: { unitCostBase: unknown } }[] }[]
}): number {
  const creditAtLineCost = po.returns.reduce(
    (sum, r) => sum + r.lines.reduce((s2, rl) => s2 + Number(rl.qtyReturned) * Number(rl.poLine.unitCostBase), 0),
    0,
  )
  if (creditAtLineCost === 0) return 0
  const preDiscountNet = po.lines.reduce((sum, l) => sum + Number(l.totalBase), 0)
  if (!(preDiscountNet > 0)) return creditAtLineCost
  // `== null` explicitly: `Number(null)` is 0, which is FINITE, so a missing subtotal would otherwise
  // scale every credit to nothing — inventing a total discount out of absent data. The schema makes
  // this column non-nullable, so this is a guard against a shape we never expect, and it degrades to
  // the unscaled credit rather than to zero.
  if (po.subtotalBase == null) return creditAtLineCost
  const postDiscountNet = Number(po.subtotalBase)
  if (!Number.isFinite(postDiscountNet)) return creditAtLineCost
  return creditAtLineCost * (postDiscountNet / preDiscountNet)
}
