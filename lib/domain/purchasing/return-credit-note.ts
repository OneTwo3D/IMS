import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// Auto-draft supplier credit note for goods returned from a billed PO
//
// Returning goods that were billed leaves the AP liability standing at the full
// amount. This computes the DRAFT supplier credit note to raise so the books
// reflect that the supplier owes us for the returned goods — netting any credit
// notes already recorded (so repeated returns each top the credit up to the
// over-billed total rather than double-crediting).
//
// Invoice LINES are stored NET (ex-VAT); the credit note amount is GROSS
// (tax-inclusive — `lineAmountsIncludeTax: true` on the Xero payload, and the
// over-credit cap is the bill's gross total). So the net over-billed value is
// grossed up by the chosen bill's gross/net ratio and capped to that bill's
// remaining creditable amount.
// ---------------------------------------------------------------------------

export type ReturnCreditNoteBillLine = {
  poLineId: string | null
  qtyBilled: DecimalInput
  /** Line NET value in the PO/bill foreign currency (ex-VAT). */
  totalForeign: DecimalInput
}

export type ReturnCreditNoteBill = {
  invoiceId: string
  /** Bill NET subtotal (ex-VAT), foreign. Used to derive the gross-up ratio. */
  subtotalForeign: DecimalInput
  /** Bill GROSS total (incl-VAT), foreign. The over-credit ceiling. */
  totalForeign: DecimalInput
  fxRateToBase: DecimalInput
  /**
   * Sum of amountForeign of ALL credit notes recorded against this bill (manual +
   * return-generated). Used only as the over-credit CAP — the bill can never be
   * credited beyond its gross across every credit note.
   */
  alreadyCreditedForeign: DecimalInput
  /**
   * Sum of amountForeign of RETURN-generated credit notes recorded against this
   * bill. The return-credit top-up nets against THIS (not the all-credits sum) so
   * a manual allowance can't silently suppress return credit.
   */
  alreadyReturnCreditedForeign: DecimalInput
  createdAt: number
  lines: ReturnCreditNoteBillLine[]
}

export type ReturnCreditNotePoLine = {
  poLineId: string
  qtyReceived: DecimalInput
  /** Cumulative returned quantity AFTER the current return is applied. */
  qtyReturned: DecimalInput
}

export type ReturnCreditNoteDraft = {
  invoiceId: string
  /** Incremental GROSS credit to record now, PO/bill foreign currency. */
  amountForeign: number
  /** amountForeign × the bill's fx rate, base currency. */
  amountBase: number
  fxRateToBase: number
}

export type ReturnCreditNoteComputation = {
  /** The credit note to auto-create now, or null when there's nothing to create. */
  draft: ReturnCreditNoteDraft | null
  /**
   * GROSS return credit (bill foreign currency) the over-billing warrants but
   * that could NOT be auto-created because existing credit notes (e.g. manual
   * allowances) already consumed the bill's creditable capacity. > 0 means
   * finance should review and raise the remainder manually.
   */
  suppressedForeign: number
}

const EPSILON = 0.0001

/**
 * Compute the DRAFT credit note (if any) to raise after a return, plus any
 * return credit that's warranted but couldn't be auto-created. `draft` is null
 * when there's nothing new to credit (no bills, nothing over-billed, or the
 * return credit is already fully covered by prior RETURN credits). `suppressedForeign`
 * is > 0 when the over-billing warrants more return credit than the bill's
 * remaining capacity allows because existing (e.g. manual) credits consumed it —
 * the caller should warn finance to raise the remainder manually.
 *
 * The credit is raised against a SINGLE bill — the most recent bill that billed
 * an over-billed line — mirroring the manual single-bill credit-note model. The
 * top-up nets against prior RETURN credits only; the bill's gross (across ALL
 * credit notes) is the hard over-credit cap.
 */
export function computeReturnCreditNoteDraft(input: {
  poLines: ReturnCreditNotePoLine[]
  bills: ReturnCreditNoteBill[]
}): ReturnCreditNoteComputation {
  if (input.bills.length === 0) return { draft: null, suppressedForeign: 0 }

  const netReceivedByLine = new Map<string, Decimal>()
  for (const l of input.poLines) {
    const net = subtractMoney(l.qtyReceived, l.qtyReturned)
    netReceivedByLine.set(l.poLineId, net.lt(0) ? toDecimal(0) : net)
  }

  // Sum billed qty + net value per PO line across ALL bills, and remember which
  // bills billed each line.
  const billedByLine = new Map<string, { qty: Decimal; netForeign: Decimal; billIds: Set<string> }>()
  for (const bill of input.bills) {
    for (const line of bill.lines) {
      if (!line.poLineId) continue
      const existing = billedByLine.get(line.poLineId) ?? { qty: toDecimal(0), netForeign: toDecimal(0), billIds: new Set<string>() }
      existing.qty = addMoney(existing.qty, line.qtyBilled)
      existing.netForeign = addMoney(existing.netForeign, line.totalForeign)
      existing.billIds.add(bill.invoiceId)
      billedByLine.set(line.poLineId, existing)
    }
  }

  // Total NET foreign value over-billed across the PO, and the set of bills that
  // contributed to an over-billed line.
  let overBilledNetForeign = toDecimal(0)
  const contributingBillIds = new Set<string>()
  for (const [poLineId, billed] of billedByLine) {
    if (billed.qty.lte(0)) continue
    const netReceived = netReceivedByLine.get(poLineId) ?? toDecimal(0)
    const overBilledQty = subtractMoney(billed.qty, netReceived)
    if (overBilledQty.lte(0)) continue
    const avgNetUnitForeign = billed.netForeign.div(billed.qty)
    overBilledNetForeign = addMoney(overBilledNetForeign, multiplyMoney(overBilledQty, avgNetUnitForeign))
    for (const billId of billed.billIds) contributingBillIds.add(billId)
  }
  if (overBilledNetForeign.lte(EPSILON)) return { draft: null, suppressedForeign: 0 }

  // Only auto-create when a SINGLE bill billed the over-billed goods. Spreading
  // a credit across multiple bills with potentially different tax rates and FX
  // rates can't be done correctly from a PO-level average, so multi-bill cases
  // fall back to manual handling (the caller logs a warning).
  if (contributingBillIds.size !== 1) return { draft: null, suppressedForeign: 0 }
  const targetBill = input.bills.find((b) => contributingBillIds.has(b.invoiceId))
  if (!targetBill) return { draft: null, suppressedForeign: 0 }

  // Gross up the net over-billed value by the bill's gross/net ratio so the
  // credit is tax-inclusive like the bill it offsets. A zero net subtotal (no
  // VAT, or a degenerate bill) falls back to a 1:1 ratio.
  const subtotal = toDecimal(targetBill.subtotalForeign)
  const grossTotal = toDecimal(targetBill.totalForeign)
  const grossUpRatio = subtotal.gt(0) ? grossTotal.div(subtotal) : toDecimal(1)
  const overBilledGrossForeign = multiplyMoney(overBilledNetForeign, grossUpRatio)

  // The cumulative RETURN credit this bill should carry = the over-billed gross,
  // capped at the bill's own gross total (can't credit more than the bill). The
  // amount to record NOW tops that up over prior RETURN credits only — manual
  // allowances must NOT reduce what the return warrants, otherwise a manual
  // credit silently suppresses the return credit (the bug this fixes).
  const targetCumulative = overBilledGrossForeign.gt(grossTotal) ? grossTotal : overBilledGrossForeign
  const incremental = subtractMoney(targetCumulative, targetBill.alreadyReturnCreditedForeign)
  if (incremental.lte(EPSILON)) return { draft: null, suppressedForeign: 0 }

  const roundedIncremental = roundQuantity(incremental, 4)

  // The bill can never be credited beyond its gross across ALL credit notes, so
  // the new draft is capped by the capacity left after EVERY existing credit
  // (manual + return). Any return credit that doesn't fit is reported as
  // suppressed so finance can raise it elsewhere rather than it vanishing.
  const capacity = subtractMoney(grossTotal, targetBill.alreadyCreditedForeign)
  if (capacity.lte(EPSILON)) {
    return { draft: null, suppressedForeign: roundedIncremental.toNumber() }
  }
  const roundedCapacity = roundQuantity(capacity, 4)
  const finalForeign = roundedIncremental.gt(roundedCapacity) ? roundedCapacity : roundedIncremental
  const suppressedForeign = roundQuantity(subtractMoney(roundedIncremental, finalForeign), 4).toNumber()
  if (finalForeign.lte(EPSILON)) return { draft: null, suppressedForeign }

  const amountForeign = finalForeign.toNumber()
  const fxRateToBase = toDecimal(targetBill.fxRateToBase).toNumber()
  const amountBase = roundQuantity(multiplyMoney(finalForeign, targetBill.fxRateToBase), 4).toNumber()

  return {
    draft: { invoiceId: targetBill.invoiceId, amountForeign, amountBase, fxRateToBase },
    suppressedForeign,
  }
}
