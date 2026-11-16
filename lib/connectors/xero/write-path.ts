import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

/**
 * Xero rounds every line `UnitAmount` to 2 decimal places unless the request carries `unitdp=4`, which
 * makes it keep 4. IMS computes unit amounts to 4-6 dp (a tax-inclusive 9.99 x 3 at 20% is 8.325 net), so
 * without the parameter Xero's own total (8.33 x 3) can differ from the order by pennies and the payment
 * for the order's total is refused. Every POST/PUT that carries line items (invoices and bills, credit
 * notes and supplier credits, purchase orders) is sent with it; this is the one place that adds it.
 * Sub-resources (`Invoices/{id}/History`, `/Attachments`, ...) carry no line items and are left alone.
 */
export const XERO_UNIT_DP = 4
const XERO_LINE_ITEM_WRITE_PATH_RE = /^(?:Invoices|CreditNotes|PurchaseOrders)(?:\/[^/?]+)?(?:\?.*)?$/

export function xeroWritePath(method: 'GET' | 'POST' | 'PUT', path: string): string {
  if (method === 'GET' || !XERO_LINE_ITEM_WRITE_PATH_RE.test(path)) return path
  if (/[?&]unitdp=/i.test(path)) return path
  return `${path}${path.includes('?') ? '&' : '?'}unitdp=${XERO_UNIT_DP}`
}

/**
 * `unitdp=4` keeps four decimal places of a UnitAmount, but IMS holds unit prices to six (`subtotal / quantity`):
 * £100 over 300 units is 0.333333, which Xero keeps as 0.3333 and totals 300 x 0.3333 = 99.99, a penny short of the
 * order, so a later full payment is refused. Xero totals a line as round2(Quantity x UnitAmount at 4dp).
 *
 * THE FIX IS PER LINE, AND ONLY WHERE NEEDED. When the 4dp unit amount reproduces the line's total to the penny, the line
 * is sent as it was (with the 4dp unit amount). When it does not, the line is sent as Quantity 1 at the line's own total
 * rounded to 2dp (the figure Xero would book for the IMS line), and the description says the quantity
 * and unit price it was. Money is exact; the quantity is only kept in the description for those lines.
 *
 * Chosen over `LineAmount` (not verifiable offline whether Xero honours a supplied value against Quantity x UnitAmount,
 * and a silent recompute would bring the penny back) and over a rounding line (needs a mapped Rounding account and
 * puts a balancing figure on a customer-facing invoice).
 */
export type XeroUnitDpLine = { Quantity: number; UnitAmount: number; collapsed: boolean }

export function fitLineToXeroUnitDp(quantity: number, unitAmount: number): XeroUnitDpLine {
  const q = toDecimal(quantity)
  const exact = toDecimal(unitAmount)
  const rounded = roundQuantity(exact, XERO_UNIT_DP)
  const intended = roundQuantity(q.mul(exact), 2)
  const asXeroSees = roundQuantity(q.mul(rounded), 2)
  if (asXeroSees.eq(intended)) return { Quantity: quantity, UnitAmount: rounded.toNumber(), collapsed: false }
  return { Quantity: 1, UnitAmount: intended.toNumber(), collapsed: true }
}

/** The description of a line that `fitLineToXeroUnitDp` collapsed to Quantity 1. */
export function collapsedLineDescription(description: string, quantity: number, unitAmount: number): string {
  return `${description} (${quantity} x ${unitAmount})`
}

/** The Description / Quantity / UnitAmount of a Xero line item for an IMS line, fitted to unitdp=4 (see `fitLineToXeroUnitDp`). */
export function xeroQuantityLine(description: string, quantity: number, unitAmount: number): { Description: string; Quantity: number; UnitAmount: number } {
  const fit = fitLineToXeroUnitDp(quantity, unitAmount)
  return { Description: fit.collapsed ? collapsedLineDescription(description, quantity, unitAmount) : description, Quantity: fit.Quantity, UnitAmount: fit.UnitAmount }
}
