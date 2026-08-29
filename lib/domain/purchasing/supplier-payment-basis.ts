/**
 * o3d-8u4h: WHAT THE SUPPLIER AGING REPORT MAY AND MAY NOT SAY ABOUT MONEY PAID TO A SUPPLIER.
 *
 * -----------------------------------------------------------------------------------------------
 * THE DEFECT
 * -----------------------------------------------------------------------------------------------
 * `getSupplierAging` published `paidAmount: 0`, `dueAmount: billedAmount` and `discounts: 0` as if
 * they were measurements. They were literals. A zero is a figure, and a zero in a Paid column reads
 * as THE STRONGEST POSSIBLE CLAIM — "nothing has ever been paid to this supplier" — which is not
 * something this system is in a position to assert about anybody. Worse than a wrong calculation:
 * a wrong calculation is at least a calculation.
 *
 * The aging buckets inherited it. Every bill aged from its invoice date with no settlement offset
 * of any kind, so a bill paid two years ago still sat in the 91+ column forever, and the column was
 * called `overdue`.
 *
 * -----------------------------------------------------------------------------------------------
 * WHAT THE SCHEMA ACTUALLY HOLDS, verified in prisma/schema.prisma rather than assumed
 * -----------------------------------------------------------------------------------------------
 * The issue said there is "NO supplier payment record in the schema at all". That is right about
 * the AMOUNT and wrong about the FACT, and the difference is the whole shape of the fix:
 *
 *   `Payment`                     sales-only. Its foreign keys are orderId -> SalesOrder and
 *                                 refundId -> SalesOrderRefund. There is no supplier side to it,
 *                                 so no row anywhere carries an amount paid to a supplier.
 *
 *   `PurchaseInvoice.paidAt`      EXISTS. A nullable timestamp — a PAYMENT MARKER: a date somebody
 *   + paymentAccountId/Name       or something stamped on the bill, plus which bank account and
 *   + paymentReference            reference were quoted. NO AMOUNT.
 *
 * So "has a payment been marked against this bill" is recorded and "how much was paid" is not, and
 * the marker is weaker than it looks in two directions:
 *
 *   * `markBillPaid` accepts an explicit `input.amountForeign` AND STAMPS `paidAt` REGARDLESS, so
 *     an operator can mark a bill while paying part of it. The marker is an OPERATOR ASSERTION, and
 *     app/actions/purchase-orders.ts already says so in as many words: "paidAt says IMS was told
 *     the bill was paid" — it keeps a separate `settlement` verdict for whether the LEDGER agrees.
 *   * the Xero poller sets it from `FullyPaidOnDate`, which IS full settlement; the QuickBooks
 *     poller and the reversal path can clear it again.
 *
 * -----------------------------------------------------------------------------------------------
 * ROUND 2, AND WHY THESE COLUMNS ARE NOT CALLED "SETTLED" AND "UNSETTLED"
 * -----------------------------------------------------------------------------------------------
 * Round 1 split Billed into `settledBilledAmount` / `unsettledBilledAmount`. That still published
 * A SETTLEMENT RELATION THE MARKER DOES NOT PROVE. "Settled" means the debt is discharged; the
 * marker says only that a date was stamped, and the very same round established that `markBillPaid`
 * accepts a partial amount and stamps it anyway. So a part-paid bill was published as fully settled
 * — its whole billed value in the settled column — AND, because the buckets were narrowed to
 * "unsettled" bills, it left the ageing report altogether. The residue nobody has paid became
 * invisible at exactly the moment the first instalment was recorded.
 *
 * The correction is the one this file already made when it refused to sum marked bills under Paid,
 * carried the rest of the way: NAME THE TWO GROUPS AFTER THE RAW EVIDENCE. There is a marker on the
 * bill, or there is not. `billedWithPaymentMarker` / `billedWithoutPaymentMarker`, everywhere — the
 * server action, the column headings, the CSV — and the four age bands are the without-marker
 * population, named for that too. Neither word now implies an amount or a discharge.
 *
 * -----------------------------------------------------------------------------------------------
 * THE SHAPE, WHICH IS o3d-iigc's RULE APPLIED UNCHANGED
 * -----------------------------------------------------------------------------------------------
 * o3d-iigc established, over six review rounds, that A FIGURE THAT CANNOT BE STATED PUBLISHES
 * NOTHING — while a related total that IS known is still shown, because how much exists is not in
 * doubt (its customer aging withholds `netTotal` and keeps `refundsTotal` beside it). And that AN
 * INDETERMINATE FIGURE PUBLISHES THE NUMBER AND WITHHOLDS ONLY THE RELATION, because marking a
 * figure with the wrong relation is worse than not marking it.
 *
 * Applied here:
 *
 *   Paid       WITHHELD. An amount paid is not a recorded quantity. Summing the totals of bills
 *              carrying a marker would publish an amount BILLED under the word PAID, which is the
 *              same defect one step further on — and o3d-anu8 has just finished stopping seven
 *              other readers from promoting an operator assertion into system evidence.
 *
 *   Due        WITHHELD. Due is billed minus paid; paid is not a quantity, and supplier credit
 *              notes reduce what is owed as well. Publishing `billedAmount` under the word DUE was
 *              the original defect.
 *
 *   Discounts  WITHHELD. See SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED.
 *
 *   Billed     UNCHANGED, and the two marker groups are ADDED beside it. How much was BILLED on the
 *              bills carrying a payment marker, and on those carrying none, is not in doubt: both
 *              are sums of `PurchaseInvoice.totalBase`. They are amounts billed, grouped by a
 *              marker, and they are named for exactly that.
 *              `billedAmount = billedWithPaymentMarker + billedWithoutPaymentMarker`, checkable in
 *              the row, so a reader can see nothing was lost in the split.
 *
 *   The four   The NUMBER survives and the RELATION is withheld. The population is the bills with
 *   buckets    NO payment marker, so a marked bill stops ageing; the name changes from `overdue*`,
 *              because "overdue" is a relation to a DUE DATE and these buckets are cut from the
 *              INVOICE date. Renaming rather than re-anchoring: `PurchaseInvoice.dueDate` is
 *              nullable, so switching the anchor would silently mix two different clocks in one
 *              column, which is a product decision and not this defect.
 *
 * A PART-PAID BILL IS STILL COUNTED WHOLE ON THE MARKED SIDE, and that is not a residual lie — it
 * is the honest consequence of the naming. The column claims the BILLED value of the bills carrying
 * a marker, which is exactly what it sums. It does not claim that value was paid, and it does not
 * claim the debt is gone. What the report cannot do is tell you how much of that bill is still
 * outstanding, and it says so rather than guessing.
 *
 * NOTHING HERE NEEDS A SCHEMA CHANGE, and that is deliberate. A supplier-payment model would let
 * Paid and Due be measured, and it is a feature: new tables, migrations, a recording UI and a
 * connector to fill it. The report's job in the meantime is to say that it cannot say.
 *
 * -----------------------------------------------------------------------------------------------
 * KEEP THIS FILE IMPORT-FREE
 * -----------------------------------------------------------------------------------------------
 * Same reason as lib/analytics/refund-figure-surfaces.ts: the notices are read by a SERVER action,
 * by the export route, and by a CLIENT component, and a stray import here would drag whatever it
 * pulls into a browser chunk. Strings and pure functions only.
 */

/** Why Paid and Due are empty wherever this report renders or exports them. */
export const SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED =
  'Withheld: IMS records no amount paid to a supplier. A bill carries a payment marker — a date (PurchaseInvoice.paidAt) with no amount — and the Payment model is sales-only, so neither Paid nor Due can be measured. They are left empty rather than shown as 0, because a 0 would read as "nothing has been paid". The two Billed columns beside them report the BILLED value of bills with and without that marker, which is known.'

/** Why the Discounts column is empty rather than carrying the part of the discount that IS exact. */
export const SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED =
  'Withheld: a discount total cannot be assembled. Per-line discounts are already folded into the stored line totals and survive only as PurchaseOrderLine.discountAmount, in FOREIGN currency and in whichever tax convention that order used (VAT-inclusive when pricesIncludeVat is set). Only the header order discount is exactly recoverable in base currency ex-VAT, and publishing that part alone under a Discounts column would publish a part as a total. Gross, Net and Total are all already net of every discount the order applied.'

/** What the four age buckets, and the without-marker total, actually measure. */
export const SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS =
  'Billed value of bills carrying NO payment marker, aged from the INVOICE date. Not an overdue figure and not a balance owed: no payment amount is recorded, supplier credit notes are not netted off it, and the due date on the bill is not used. It states what was billed and never marked.'

/**
 * o3d-8u4h round 3: HOW THE ROW IS MADE TO ADD UP, said to the reader who was told to add it up.
 *
 * The columns invite a check — Billed = the two marker groups, and the four age bands = the
 * without-marker group — and a bill is stored to four decimal places while the report publishes
 * two. Rounding the total and the parts separately breaks that check by a penny. So each figure is
 * summed exactly and rounded once, and the rounding residue is then placed by a stated rule instead
 * of being left where it fell.
 */
export const SUPPLIER_BILLED_ROUNDING_RECONCILIATION =
  'Reconciled to the penny. Bills are stored to four decimal places and this report publishes two: every figure is summed at full precision and rounded once (half away from zero), and the rounding residue — never more than a penny or two — is then added to the LARGEST component of each split, so that the two marker groups add back to Billed and the four age bands add back to the without-marker group exactly, on screen and in the exported file. One component therefore carries the residue by rule rather than by accident; no component is claimed exact to the penny in isolation.'

/** What the with-marker column measures, which is an amount BILLED and not an amount paid. */
export const SUPPLIER_BILLED_WITH_PAYMENT_MARKER_BASIS =
  'Billed value of bills carrying a payment marker (PurchaseInvoice.paidAt), whoever stamped it. An amount BILLED, not an amount paid and not a settled debt: the marker carries no amount, and markBillPaid stamps it even when only part of the bill was paid.'

/**
 * Does this bill carry a payment marker?
 *
 * The only judgement in the split, and the whole of it. Explicitly `== null` rather than falsy: a
 * Date is never falsy, but an undefined column on a partially-selected row would be, and reading an
 * absent field as "marked" is the direction that would take a bill out of the ageing bands on no
 * evidence at all.
 *
 * o3d-8u4h round 3: this used to be `billedPaymentMarkerSplit`, which also SUMMED the two groups —
 * in floating point, because this file may not import Prisma (see the note above: its sentences are
 * read by a client component, and a Prisma import here would drag the client into a browser chunk).
 * The summing moved to the caller, which now aggregates in `Prisma.Decimal` and reconciles the
 * rounded groups back to the rounded total. A predicate is all the domain rule ever was.
 */
export function hasPaymentMarker(invoice: { paidAt: Date | null | undefined }): boolean {
  return invoice.paidAt != null
}
