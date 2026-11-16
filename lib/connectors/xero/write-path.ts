import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

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
 * A LINE'S QUANTITY IS NEVER ALTERED, WHATEVER IT CARRIES. A line with an ItemCode records a stock movement of that
 * quantity against a tracked Xero item, and even an untracked line's structured quantity is the document's record of
 * what was sold. So every line is sent as Quantity x UnitAmount (4dp), and the penny the 4dp price loses is made good by
 * ONE separate "Rounding adjustment" line per document (Quantity 1, no ItemCode, no tax) on the configured Rounding
 * account (the Xero setting `xero_rounding_difference_account`, 860 in the OneTwo3D chart: the same account the EU scheme
 * path already posts rounding to). With no Rounding account mapped the document is REFUSED rather than posted with a
 * total that differs from the order. One approach for every line, with or without an ItemCode, so the document looks the
 * same whatever the lines carry.
 */
export class XeroRoundingAccountMissingError extends Error {
  constructor(what: string, gap: string) {
    super(
      `${what} needs a rounding adjustment of ${gap}: IMS holds unit prices to six decimal places and Xero keeps four, so its line totals differ from the order's by that much. `
      + 'Map a Rounding account (Accounting settings, Xero, Rounding difference account) so the difference can be posted; nothing was sent.',
    )
    this.name = 'XeroRoundingAccountMissingError'
  }
}

type PricedLine = { quantity: number; unitAmount: number }

/** The Quantity and 4dp UnitAmount a line is sent with. The quantity is the IMS quantity, untouched. */
export function xeroUnitDpFields(quantity: number, unitAmount: number): { Quantity: number; UnitAmount: number } {
  return { Quantity: quantity, UnitAmount: roundQuantity(unitAmount, XERO_UNIT_DP).toNumber() }
}

/** What the IMS lines total, less what Xero will total them to at unitdp=4 (each line rounded to 2dp, as Xero does). Zero when 4dp reproduces every line. */
export function unitDpLineGap(lines: readonly PricedLine[]): Decimal {
  let gap = toDecimal(0)
  for (const l of lines) {
    const q = toDecimal(l.quantity)
    const intended = roundQuantity(q.mul(toDecimal(l.unitAmount)), 2)
    const asXeroSees = roundQuantity(q.mul(roundQuantity(l.unitAmount, XERO_UNIT_DP)), 2)
    gap = gap.add(intended.sub(asXeroSees))
  }
  return gap
}

/** The rounding line, or null when there is no gap. THROWS when there is a gap and no account: no document with a total that differs from the order. */
export function xeroUnitDpRoundingLine(
  lines: readonly PricedLine[], account: string | null | undefined, what: string,
): Record<string, unknown> | null {
  const gap = unitDpLineGap(lines)
  if (gap.isZero()) return null
  if (!account || !account.trim()) throw new XeroRoundingAccountMissingError(what, gap.toFixed(2))
  return { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: gap.toNumber(), AccountCode: account.trim(), TaxType: 'NONE' }
}

/**
 * The guard behind "a line's quantity is never altered": the first `lines.length` items of a built document are the IMS lines in order, and each keeps
 * its IMS quantity. A line that carries an ItemCode would otherwise book a different stock movement against a TRACKED Xero item
 * (IsTrackedAsInventory), which cannot be seen from the document.
 */
export function assertXeroLineQuantitiesKept(lines: readonly { quantity: number; description?: string }[], lineItems: readonly Record<string, unknown>[]): void {
  lines.forEach((line, i) => {
    if (lineItems[i]?.Quantity !== line.quantity) {
      throw new Error(`Line ${i + 1} ("${line.description ?? ''}") was built with quantity ${String(lineItems[i]?.Quantity)} instead of ${line.quantity}; a line's quantity is never altered.`)
    }
  })
}
