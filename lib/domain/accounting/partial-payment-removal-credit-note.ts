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
// handed, the same way it does for any partial refund. An order-level discount is not mirrored as its own negative line: the order's
// NET TOTAL (which is already net of the discount) is what is apportioned, so the credit is the same fraction of the order whichever way the discount was taxed.

export type RemovalCreditOrderLine = { lineId: string; productId: string | null; description: string; totalBase: DecimalInput }

export type RemovalCreditPlan =
  | { ok: true; lines: RefundRequestLine[]; ratio: Decimal; netTotalBase: Decimal }
  | { ok: false; reason: string }

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
  const factor = targetNet.div(gross)

  const lines: RefundRequestLine[] = targets.map((t) => ({
    lineId: t.line.lineId,
    productId: t.line.productId,
    description: t.line.description,
    qty: 0,
    totalBase: roundQuantity(multiplyMoney(t.base, factor), 4).toNumber(),
    lineKind: t.kind,
  }))
  if (compareDecimal(shipping, 0) > 0) {
    lines.push({ lineId: null, productId: null, description: 'Shipping', qty: 0, totalBase: roundQuantity(multiplyMoney(shipping, factor), 4).toNumber(), lineKind: 'shipping' })
  }
  // The residue of rounding each part is put on the largest one, so the credit's net is exactly the apportioned figure.
  const sum = lines.reduce((s, l) => addMoney(s, l.totalBase), toDecimal(0))
  const residue = subtractMoney(targetNet, sum)
  if (compareDecimal(residue, 0) !== 0) {
    const largest = lines.reduce((best, l) => (l.totalBase > best.totalBase ? l : best), lines[0]!)
    largest.totalBase = roundQuantity(addMoney(largest.totalBase, residue), 4).toNumber()
  }
  if (lines.some((l) => l.totalBase <= 0)) lines.splice(0, lines.length, ...lines.filter((l) => l.totalBase > 0))
  if (lines.length === 0) return { ok: false, reason: 'the removed amount is too small to credit' }
  return { ok: true, lines, ratio, netTotalBase: targetNet }
}

/** The reason text on the credit note, which also names the removal record so a retry finds the credit note it already raised and never raises a second. */
export const partialRemovalCreditReason = (recordId: string): string => `Payment partly removed from the ledger (removal ${recordId})`

export const PARTIAL_REMOVAL_CREDIT_NOTE_SETTING_KEY = 'xero_partial_payment_removal_credit_note_enabled'
