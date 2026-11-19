import { addMoney, compareDecimal, multiplyMoney, roundQuantity, subtractMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { RefundRequestLine } from '@/lib/domain/sales/refund-service'

// ---------------------------------------------------------------------------
// A PARTIAL PAYMENT REMOVAL, BOOKED AS A CREDIT NOTE (owner decision on o3d-hqvrp.395)
// ---------------------------------------------------------------------------
//
// When the ledger stops holding part of an order's payment, IMS raises a credit note for the REMOVED amount through the ordinary refund
// path (so it is staged behind the outbound write hold like every other credit note). The goods are not returned and nothing is restocked:
// every line is a price-only credit (quantity 0), which is how the refund path already carries an amount without units.
//
// The removed amount is spread pro rata over what the order is made of. Each sale line and the shipping charge is credited at the same
// fraction of its net value, so each carries the VAT of its own tax code at its own rate (the VAT is apportioned pro rata to the removed amount
// by construction), and the refund path unwinds the deferred revenue (Unearned Revenue, then the Group A1/B recognition) from the net it is
// handed, the same way it does for any partial refund. An order-level discount is mirrored as its OWN negative line (the way the chargeback path does, and the way the
// invoice carries it): the lines are credited at their PRE-discount nets and the discount line at the same fraction of the discount, so every line, and the discount
// at the order default tax code, carries VAT at its own rate and the credit note's gross equals the removed amount, on a mixed-rate order too.

export type RemovalCreditOrderLine = { lineId: string; productId: string | null; description: string; totalBase: DecimalInput }

export type RemovalCreditPlan =
  | { ok: true; lines: RefundRequestLine[]; ratio: Decimal; netTotalBase: Decimal; /** The order-level discount (net, base) the plan mirrors as a negative line; 0 when the order has none. */ discountBase: Decimal }
  | { ok: false; reason: string }

/** The order's discount is inferred from its own figures (lines plus shipping less the net total); below this it is rounding and not a discount. */
const DISCOUNT_TOLERANCE = toDecimal('0.0005')

export function planRemovalCreditNoteLines(input: {
  lines: ReadonlyArray<RemovalCreditOrderLine>
  shippingBase: DecimalInput
  /** The order's net total in base currency: total less tax, so already net of any order discount. */
  orderNetTotalBase: DecimalInput
  /** The order's gross total and the removed part of it, both in the order currency. */
  totalForeign: DecimalInput
  removedForeign: DecimalInput
}): RemovalCreditPlan {
  const total = toDecimal(input.totalForeign)
  const removed = toDecimal(input.removedForeign)
  if (compareDecimal(total, 0) <= 0) return { ok: false, reason: 'the order has no total to apportion the removed amount against' }
  if (compareDecimal(removed, 0) <= 0) return { ok: false, reason: 'the removed amount is not positive' }
  if (compareDecimal(removed, total) > 0) return { ok: false, reason: 'the removed amount is larger than the order total' }
  const ratio = removed.div(total)

  const targets = input.lines
    .map((l) => ({ line: l, base: toDecimal(l.totalBase), kind: 'sale' as const }))
    .filter((t) => compareDecimal(t.base, 0) > 0)
  const shipping = toDecimal(input.shippingBase)
  const lineSum = targets.reduce((sum, t) => addMoney(sum, t.base), toDecimal(0))
  const gross = addMoney(lineSum, compareDecimal(shipping, 0) > 0 ? shipping : 0)
  if (compareDecimal(gross, 0) <= 0) return { ok: false, reason: 'the order has no line value to credit' }

  const netTotal = toDecimal(input.orderNetTotalBase)
  if (compareDecimal(netTotal, 0) <= 0) return { ok: false, reason: 'the order has no net total to apportion the removed amount against' }
  const targetNet = roundQuantity(multiplyMoney(netTotal, ratio), 4)
  const discountRaw = subtractMoney(gross, netTotal)
  const discountBase = compareDecimal(discountRaw, DISCOUNT_TOLERANCE) > 0 ? roundQuantity(discountRaw, 4) : toDecimal(0)

  const lines: RefundRequestLine[] = targets.map((t) => ({
    lineId: t.line.lineId,
    productId: t.line.productId,
    description: t.line.description,
    qty: 0,
    totalBase: roundQuantity(multiplyMoney(t.base, ratio), 4).toNumber(),
    lineKind: t.kind,
  }))
  if (compareDecimal(shipping, 0) > 0) {
    lines.push({ lineId: null, productId: null, description: 'Shipping', qty: 0, totalBase: roundQuantity(multiplyMoney(shipping, ratio), 4).toNumber(), lineKind: 'shipping' })
  }
  const discountCredit = compareDecimal(discountBase, 0) > 0 ? roundQuantity(multiplyMoney(discountBase, ratio), 4) : toDecimal(0)
  // The residue of rounding each part is put on the largest positive one, so the credit's net is exactly the apportioned figure.
  const positive = lines.reduce((s, l) => addMoney(s, l.totalBase), toDecimal(0))
  const residue = subtractMoney(addMoney(targetNet, discountCredit), positive)
  if (compareDecimal(residue, 0) !== 0) {
    const largest = lines.reduce((best, l) => (l.totalBase > best.totalBase ? l : best), lines[0]!)
    largest.totalBase = roundQuantity(addMoney(largest.totalBase, residue), 4).toNumber()
  }
  const kept = lines.filter((l) => l.totalBase > 0)
  if (kept.length === 0) return { ok: false, reason: 'the removed amount is too small to credit' }
  if (compareDecimal(discountCredit, 0) > 0) {
    kept.push({ lineId: null, productId: null, description: 'Order discount', qty: 0, totalBase: discountCredit.neg().toNumber(), lineKind: 'discount' })
  }
  return { ok: true, lines: kept, ratio, netTotalBase: targetNet, discountBase }
}

/** The reason text on the credit note. It names the removal record for the reader only: the link that stops a second credit note is the record's own refund id, claimed in the refund transaction. */
export const partialRemovalCreditReason = (recordId: string): string => `Payment partly removed from the ledger (removal ${recordId})`

export const PARTIAL_REMOVAL_CREDIT_NOTE_SETTING_KEY = 'xero_partial_payment_removal_credit_note_enabled'

/** Cutoff: only removals recorded AFTER the flag was turned on are credited automatically (ISO time; set by the poller when it first sees the flag on, cleared while it is off). */
export const PARTIAL_REMOVAL_CREDIT_NOTE_ENABLED_AT_KEY = 'xero_partial_payment_removal_credit_note_enabled_at'

/** The ledgerAction terminal state of a removal that needs a person (a refusal that will never clear); the poller never retries it. */
export const REMOVAL_LEDGER_ACTION_MANUAL = 'MANUAL_CREDIT_NOTE'
/** A removal recorded before the flag was enabled: never credited automatically, listed in the operator report. */
export const REMOVAL_LEDGER_ACTION_BACKLOG = 'BACKLOG_NOT_CREDITED'
