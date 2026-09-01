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
 * WHY AN EPSILON AT ALL. Both sides are `Number`s read from Prisma `Decimal` columns, and a receipt
 * total assembled from several rows will not land exactly on a stored total. The band is a hundredth
 * of a penny — far below any currency's minor unit, so it cannot absorb a real shortfall — and it
 * leans towards "covered", which is the direction that was already in production.
 */

/** A hundredth of a penny: below every minor unit, so it can only absorb float assembly noise. */
export const PAID_COVERAGE_EPSILON = 0.0001

/**
 * Does `covered` settle `documentTotal`?
 *
 * Both arguments must already be in the SAME currency: a receipt in another one covers none of this
 * document, and neither caller converts. `removePaymentAndSettlePaidAt` filters by currency before it
 * sums, and the registration reader drops any registration whose payload names a different one.
 */
export function coversDocumentTotal(covered: number, documentTotal: number): boolean {
  return covered >= documentTotal - PAID_COVERAGE_EPSILON
}
