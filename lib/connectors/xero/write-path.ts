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
