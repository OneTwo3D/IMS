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
 *   `PurchaseInvoice.paidAt`      EXISTS. A nullable timestamp — a SETTLEMENT FLAG with a date,
 *   + paymentAccountId/Name       plus which bank account and reference were used. No amount.
 *   + paymentReference
 *
 * So "was this bill settled" is recorded and "how much was paid" is not, and the flag is weaker
 * than it looks in two directions:
 *
 *   * `markBillPaid` accepts an explicit `input.amountForeign`, so an operator can set `paidAt`
 *     while paying part of a bill. The flag is an OPERATOR ASSERTION, and app/actions/
 *     purchase-orders.ts already says so in as many words: "paidAt says IMS was told the bill was
 *     paid" — it keeps a separate `settlement` verdict for whether the LEDGER agrees.
 *   * the Xero poller sets it from `FullyPaidOnDate`, which is full settlement; the QuickBooks
 *     poller and the reversal path can clear it again.
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
 *              whose flag is set would publish an amount BILLED under the word PAID, which is the
 *              same defect one step further on — and o3d-anu8 has just finished stopping seven
 *              other readers from promoting an operator assertion into system evidence.
 *
 *   Due        WITHHELD. Due is billed minus paid; paid is not a quantity, and supplier credit
 *              notes reduce what is owed as well. Publishing `billedAmount` under the word DUE was
 *              the original defect.
 *
 *   Discounts  WITHHELD. See SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED.
 *
 *   Billed     UNCHANGED, and Settled/Unsettled are ADDED beside it. How much was BILLED on the
 *              bills carrying a settlement flag, and on those not carrying one, is not in doubt:
 *              both are sums of `PurchaseInvoice.totalBase`. They are amounts billed, and they are
 *              named for what they are rather than for what a reader would like them to be.
 *              `billedAmount = settledBilledAmount + unsettledBilledAmount`, checkable in the row.
 *
 *   The four   The NUMBER survives and the RELATION is withheld. The population is narrowed to
 *   buckets    bills with no settlement flag, so a settled bill stops ageing forever; the name
 *              changes from `overdue*` to `unsettledBilled*`, because "overdue" is a relation to a
 *              DUE DATE and these buckets are cut from the INVOICE date. Renaming rather than
 *              re-anchoring: `PurchaseInvoice.dueDate` is nullable, so switching the anchor would
 *              silently mix two different clocks in one column, which is a product decision and
 *              not this defect.
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
  'Withheld: IMS records no amount paid to a supplier. A bill carries a settlement flag and date (PurchaseInvoice.paidAt) and no payment amount, and the Payment model is sales-only, so neither Paid nor Due can be measured. They are left empty rather than shown as 0, because a 0 would read as "nothing has been paid". Settled and Unsettled beside them report the BILLED value of bills with and without a recorded settlement, which is known.'

/** Why the Discounts column is empty rather than carrying the part of the discount that IS exact. */
export const SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED =
  'Withheld: a discount total cannot be assembled. Per-line discounts are already folded into the stored line totals and survive only as PurchaseOrderLine.discountAmount, in FOREIGN currency and in whichever tax convention that order used (VAT-inclusive when pricesIncludeVat is set). Only the header order discount is exactly recoverable in base currency ex-VAT, and publishing that part alone under a Discounts column would publish a part as a total. Gross, Net and Total are all already net of every discount the order applied.'

/** What the four age buckets, and the Unsettled total, actually measure. */
export const SUPPLIER_UNSETTLED_BILLED_BASIS =
  'Billed value of bills carrying no recorded settlement, aged from the INVOICE date. This is not an overdue figure: no payment amount is recorded, supplier credit notes are not netted off it, and the due date recorded on the bill itself is not used. It states what was billed and not marked settled.'

/** What the Settled column measures, which is an amount BILLED and not an amount paid. */
export const SUPPLIER_SETTLED_BILLED_BASIS =
  'Billed value of bills an operator or the accounting connector marked as settled. An amount BILLED, not an amount paid: the settlement flag carries no amount, and a bill can be flagged while only part of it was paid.'

/**
 * Split a supplier's bills by whether a settlement was ever recorded against them.
 *
 * The only judgement in here is that `paidAt == null` means "no settlement recorded" and anything
 * else means "one was". Explicitly `== null` rather than falsy: a Date is never falsy, but an
 * undefined column on a partially-selected row would be, and reading an absent field as "settled"
 * is the direction that would hide money.
 *
 * Returns UNROUNDED accumulators. The caller rounds once, at the end, for the same reason the net
 * amount does — rounding each bill first and summing gives a different penny.
 */
export function billedSettlementSplit(
  invoices: readonly { totalBase: unknown; paidAt: Date | null | undefined }[],
): { settled: number; unsettled: number } {
  let settled = 0
  let unsettled = 0
  for (const invoice of invoices) {
    const amount = Number(invoice.totalBase)
    if (invoice.paidAt == null) unsettled += amount
    else settled += amount
  }
  return { settled, unsettled }
}
