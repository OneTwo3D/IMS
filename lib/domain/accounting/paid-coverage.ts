/**
 * DO THE RECEIPTS ON A DOCUMENT COVER ITS TOTAL? ONE SPELLING, FOR THE WRITER AND THE READER ALIKE.
 *
 * o3d-psrx r7 (Codex HIGH 1). This test decides two things that MUST agree, and until this file
 * existed it was written out twice:
 *
 *   the WRITER   `addPayment` clears `SalesOrder.unregisteredPaidAt` — the off-ledger provenance
 *                marker — only when the non-refund receipts on the order cover its total, and
 *                `removePaymentAndSettlePaidAt` clears `paidAt` and the marker together when a
 *                removal takes the remainder below it (app/actions/sales.ts).
 *   the READER   `classifyRegisteredPaymentAgainstListing` refuses to read the removal of a
 *                PART-covering registration as a reversal of the WHOLE document while that marker
 *                still stands (lib/connectors/xero/invoice-delta.ts).
 *
 * The reader's guard is only sound because it asks the same question the writer answered. If the two
 * comparisons drifted — a different epsilon, a `>` for a `>=` — there would be a band of amounts in
 * which the marker is cleared and the reader still believes it should be standing, or the reverse:
 * the marker kept and the reader admitting a full reversal anyway. That band is a chargeback credit
 * note against a sale nobody reversed, which is the defect this whole round is about.
 *
 * WHY AN EPSILON AT ALL, AND WHAT IT IS FOR NOW. r7 wrote: "both sides are `Number`s read from Prisma
 * `Decimal` columns, and a receipt total assembled from several rows will not land exactly on a stored
 * total". HALF OF THAT SENTENCE IS NO LONGER TRUE — r18 carries the `Decimal`s through, so the two
 * writer call sites sum stored decimals exactly and there is no assembly noise left for a band to
 * absorb on that route. It is kept, and narrowed to the one operand that is still not a stored
 * decimal: the READER's `registeredAmount` comes from the enqueue's JSON payload.
 *
 * o3d-1xq8 — AND THE SENTENCE r18 WROTE ABOUT THAT LAST OPERAND WAS ITSELF ONLY HALF TRUE.
 *
 * r18 said the payload double "leans towards covered, which is the direction that was already in
 * production", filed the hop as o3d-1xq8 and moved on. `Number(receipt.amount)` does not lean: it
 * rounds in BOTH directions, and the upward one is not absorbed by this band at all — at 2^39 the
 * stored receipt `549755813888.0008` converts to a double whose own decimal reading is
 * `549755813888.0009`, so against an order totalling `549755813888.0009` it is not "within the band"
 * of the total, it IS the total. That MANUFACTURES coverage, this rule answers YES, the reader's
 * PART_COVERED_OFF_LEDGER guard stands down, and a chargeback credit note is raised against a
 * customer who paid. The band was never what stood between that and production; nothing did.
 *
 * WHAT THE BAND IS FOR NOW, stated exactly. The enqueue records the receipt's exact decimal STRING in
 * the payload beside the number and `payloadRegisteredAmount` prefers it, so every registration
 * written since o3d-1xq8 reaches this rule as the stored decimal and needs no band. A row written
 * BEFORE it carries the number alone; the band absorbs that double's residue and nothing else. It is
 * a legacy allowance with a shrinking population, not a tolerance the current writers rely on — and
 * it can only ever admit, so it is not what makes a new row's reading exact.
 *
 * o3d-psrx r17 — AND THE BAND IS DERIVED, BECAUSE THE SENTENCE THAT SIZED IT WAS FALSE. It was a
 * literal `0.0001`, described here as "a hundredth of a penny — far below any currency's minor unit,
 * so it cannot absorb a real shortfall". It is not below every minor unit: `currencyMinorUnits` puts
 * CLF and UYW at FOUR decimals, whose minor unit is 0.0001 EXACTLY. So in those currencies the band
 * was one whole minor unit wide and did absorb a real shortfall — a registration one unit short of
 * the total read as covering it, the coverage guard in `classifyRegisteredPaymentAgainstListing`
 * stood down, and the verdict became an ADMITTED reversal of the whole document. That is the same
 * shape as the r17 finding one module over: a fixed constant that is safe only while every currency
 * in sight happens to be coarser than it.
 *
 * So it is now HALF the finest minor unit this repository supports — `ledgerAmountEpsilon(null)`, the
 * one function both connectors' reversal readers ask "how small is nothing", given the null currency
 * it resolves to the strictest precision. That makes the original claim TRUE: strictly below one
 * minor unit in every supported currency, so no real shortfall fits inside it, while remaining orders
 * of magnitude above the float assembly noise it exists for (summing even a thousand receipt rows of
 * a million-unit order moves the total by ~1e-7).
 *
 * IT MOVED IN THE STRICT DIRECTION, WHICH IS THE SAFE ONE FOR ALL THREE CALLERS. A narrower band can
 * only make `coversDocumentTotal` answer NO where it used to answer YES: the reader then returns
 * `PART_COVERED_OFF_LEDGER`, which WITHHOLDS the reversal; `addPayment` declines to set `paidAt` on
 * coverage it cannot establish; `removePaymentAndSettlePaidAt` clears `paidAt` rather than leaving a
 * document claiming to be settled by receipts that fall short of it. It is also a SHARED constant, so
 * the writer and the reader move together and the "one spelling" property above is untouched.
 */

import { ledgerAmountEpsilon, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Half the finest supported minor unit: below every currency's minor unit, so it can only absorb
 * assembly noise. Not a literal — see above for the round it stopped being one.
 *
 * o3d-psrx r18: and it is the `Decimal` `ledgerAmountEpsilon` returns, not a `.toNumber()` of it. The
 * comparison below is exact decimal arithmetic, so converting the band to a double would put the one
 * lossy step this rule exists to remove back into the only subtraction it performs.
 */
export const PAID_COVERAGE_EPSILON: Decimal = ledgerAmountEpsilon(null)

/**
 * Does `covered` settle `documentTotal`?
 *
 * Both arguments must already be in the SAME currency: a receipt in another one covers none of this
 * document, and neither caller converts. `removePaymentAndSettlePaidAt` filters by currency before it
 * sums, and the registration reader drops any registration whose payload names a different one.
 *
 * o3d-psrx r18 (Codex HIGH 2) — AND THEY ARE `Decimal`s CARRIED FROM STORAGE, NOT `number`s.
 *
 * THE DEFECT. Every figure this rule weighs comes out of a `Decimal(18, 4)` column — `Payment.amount`
 * and `SalesOrder.totalForeign` — and all three call sites used to write `Number(...)` on the way in.
 * A double cannot hold four decimals across that column's whole range: at 549755813888 (2^39) the
 * spacing between neighbouring doubles is about 0.00012, so the stored, perfectly valid, one-minor-
 * unit-apart values `549755813888.0002` and `549755813888.0003` are the SAME double. A registration a
 * whole minor unit short of the order then read as exact coverage, `coversDocumentTotal` answered YES,
 * and the classifier returned GONE — an ADMITTED reversal of the whole document, which is the r17
 * epsilon defect reached by a second route. The r17 band is not what failed: the band is exact and
 * the operands were not.
 *
 * THE CONVERSION WAS A CHOICE, NOT AN INHERITANCE, so it is simply not made. Prisma hands these
 * columns over as `Decimal`, and they stay `Decimal` through the summation at each call site, through
 * this comparison, and through the epsilon it subtracts. There is no magnitude at which any of it
 * loses a minor unit, so this rule needs no bound of its own.
 *
 * THE PARAMETERS ARE `Decimal` RATHER THAN `DecimalInput` FOR THE SAME REASON `isLedgerMinorUnitQuantized`
 * takes one: a caller that has a `number` must write the conversion down. It cannot reach this rule by
 * accident, and a boundary conversion is then a visible edit rather than an invisible default.
 */
export function coversDocumentTotal(covered: Decimal, documentTotal: Decimal): boolean {
  return covered.gte(documentTotal.sub(PAID_COVERAGE_EPSILON))
}
