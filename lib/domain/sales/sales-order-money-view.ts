/**
 * THE FIGURES A SALES ORDER SHOWS, in ONE basis, derived from the amounts as they are stored.
 *
 * What is stored (createSalesOrder, the WooCommerce importer) and what the ledger is sent:
 *
 *   line.unitPriceForeign, line.discountAmount   the price AS TYPED: gross on a manual order with VAT-inclusive prices, net otherwise
 *   line.totalForeign, line.taxForeign           the line's NET and its VAT, always
 *   order.subtotalForeign                        sum of the line NETS, before the order discount
 *   order.shippingForeign                        NET (grossed up at the order's default rate when the invoice is sent inclusive)
 *   order.discountAmount                         the order discount in the SAME basis as the unit prices (gross when the amounts include VAT)
 *   order.taxForeign                             the order's total VAT (lines + shipping - the VAT in the discount)
 *   order.totalForeign                           the grand total, VAT included: what the invoice books
 *
 * Which basis the typed amounts are in is decided once, by storedAmountsIncludeVat (a WooCommerce order is net whatever the
 * storefront displays). Everything shown follows that one answer:
 *
 *   GROSS basis  every figure includes VAT; a line is its net + ITS OWN VAT (never the header rate: a line can carry a different rate, or 0%),
 *                shipping is grossed up at the order's default rate exactly as the invoice is sent; VAT is "of which", not an addition.
 *   NET basis    every figure excludes VAT; the order's VAT is an addition before the Total.
 *
 * The two ways round the same stored order reconcile to the stored total to the cent. When they do not (a damaged row) the view says so
 * rather than showing a set of figures that does not add up.
 *
 * Pure numbers, no database or Decimal runtime: the order page (a client component), the PDFs and the refund dialog all read this.
 */
import { storedAmountsIncludeVat } from '@/lib/domain/sales/sales-order-vat-basis'

// decimal-boundary-ok: display-only (these are rendering figures, rounded to the minor unit; the stored Decimals are never written back from them)
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/** Anything off by more than half a minor unit does not reconcile. */
const RECONCILE_TOLERANCE = 0.005

export type MoneyViewLine = {
  id?: string
  qty: number
  unitPriceForeign: number
  discountAmount: number
  totalForeign: number
  taxForeign: number
  /** The line's own rate as a fraction (0.2 = 20%); null when the line names none. */
  taxRatePercent?: number | null
}

export type MoneyViewOrder = {
  pricesIncludeVat: boolean | null | undefined
  shoppingLinks?: ReadonlyArray<{ connector: string }> | null
  /** The order's default rate as a fraction; null or 0 means "No VAT". */
  taxRatePercent: number | null
  subtotalForeign: number
  discountAmount: number
  shippingForeign: number
  taxForeign: number
  totalForeign: number
  storeCreditForeign?: number | null
  lines: ReadonlyArray<MoneyViewLine>
}

export type SalesOrderMoneyView = {
  basis: 'GROSS' | 'NET'
  /** Short label for a column or a total: "incl. VAT" / "excl. VAT". */
  basisLabel: 'incl. VAT' | 'excl. VAT'
  /** True when the order's VAT is added to the figures before the Total (NET basis); false when it is already inside them (GROSS). */
  vatIsAdditional: boolean
  lines: { unitPrice: number; discount: number; vat: number; total: number }[]
  subtotal: number
  orderDiscount: number
  shipping: number
  vat: number
  storeCredit: number
  total: number
  /** The figure the displayed parts add up to; equal to `total` when the order reconciles. */
  computedTotal: number
  reconciles: boolean
  difference: number
}

export function salesOrderMoneyView(order: MoneyViewOrder): SalesOrderMoneyView {
  const gross = storedAmountsIncludeVat(order)
  const headerRate = Number(order.taxRatePercent ?? 0)
  const lines = order.lines.map((l) => ({
    unitPrice: l.unitPriceForeign,
    discount: l.discountAmount,
    vat: l.taxForeign,
    // GROSS: the line's net and its own VAT. NET: the net.
    total: gross ? round4(l.totalForeign + l.taxForeign) : l.totalForeign,
  }))
  const subtotal = gross ? round4(lines.reduce((s, l) => s + l.total, 0)) : order.subtotalForeign
  // Shipping is stored net and goes out grossed up at the order's default rate (queueSalesInvoiceForOrder).
  const shipping = gross && headerRate > 0 ? round4(order.shippingForeign * (1 + headerRate)) : order.shippingForeign
  const orderDiscount = order.discountAmount
  const vat = order.taxForeign
  const storeCredit = Number(order.storeCreditForeign ?? 0)
  const computedTotal = round4(subtotal - orderDiscount + shipping + (gross ? 0 : vat) - storeCredit)
  const difference = round4(computedTotal - order.totalForeign)
  return {
    basis: gross ? 'GROSS' : 'NET',
    basisLabel: gross ? 'incl. VAT' : 'excl. VAT',
    vatIsAdditional: !gross,
    lines,
    subtotal,
    orderDiscount,
    shipping,
    vat,
    storeCredit,
    total: order.totalForeign,
    computedTotal,
    reconciles: Math.abs(difference) < RECONCILE_TOLERANCE,
    difference,
  }
}

export type TotalsRow = { label: string; amount: number; strong?: boolean }

/**
 * The totals block of a printed document (sales order, invoice), in order. The caller supplies the VAT rows it wants
 * (one per rate, or one in all); they sit BEFORE the Total when VAT is additional and AFTER it, as "included", when it is not.
 */
export function documentTotalsRows(view: SalesOrderMoneyView, vatRows: ReadonlyArray<{ label: string; amount: number }>): TotalsRow[] {
  const suffix = ` (${view.basisLabel})`
  const rows: TotalsRow[] = [{ label: `Subtotal${suffix}`, amount: view.subtotal }]
  if (view.orderDiscount > 0) rows.push({ label: `Discount${suffix}`, amount: -view.orderDiscount })
  if (view.shipping > 0) rows.push({ label: `Shipping${suffix}`, amount: view.shipping })
  if (view.vatIsAdditional) for (const r of vatRows) rows.push(r)
  if (view.storeCredit > 0) rows.push({ label: 'Store credit', amount: -view.storeCredit })
  rows.push({ label: 'Total', amount: view.total, strong: true })
  if (!view.vatIsAdditional) for (const r of vatRows) rows.push({ label: `Includes ${r.label}`, amount: r.amount })
  return rows
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * A refund line is stored NET and the credit note posts it NET (lineAmountsIncludeTax: false), so the ledger adds the VAT at the
 * rate of the tax code the line posts under: the refunded order line's own rate. That is the figure the customer is credited, and
 * the only one an operator should be shown before confirming.
 */
export type RefundAmounts = { net: number; vat: number; gross: number }

export function lineVatRate(line: Pick<MoneyViewLine, 'totalForeign' | 'taxForeign' | 'taxRatePercent'>, orderRate: number | null): number {
  if (line.taxRatePercent != null) return Number(line.taxRatePercent)
  // A line that names no rate: what it was actually charged, else the order's default.
  if (line.totalForeign > 0) return line.taxForeign / line.totalForeign
  return Number(orderRate ?? 0)
}

/** What refunding `qty` units of an order line credits: the line's stored net pro rata (discount included), its VAT, the sum. */
export function refundLineAmounts(
  line: Pick<MoneyViewLine, 'qty' | 'totalForeign' | 'taxForeign' | 'taxRatePercent'>,
  qty: number,
  orderRate: number | null,
): RefundAmounts {
  if (!(qty > 0) || !(line.qty > 0)) return { net: 0, vat: 0, gross: 0 }
  const net = round2((line.totalForeign * Math.min(qty, line.qty)) / line.qty)
  return creditAmounts(net, lineVatRate(line, orderRate))
}

/** Net money credited at a rate: VAT rounded per line as the ledger does. */
export function creditAmounts(net: number, rate: number): RefundAmounts {
  const vat = round2(net * rate)
  return { net, vat, gross: round2(net + vat) }
}

export function sumRefundAmounts(parts: ReadonlyArray<RefundAmounts>): RefundAmounts {
  const net = round2(parts.reduce((s, p) => s + p.net, 0))
  const vat = round2(parts.reduce((s, p) => s + p.vat, 0))
  return { net, vat, gross: round2(net + vat) }
}

export type RefundSelection = { lineId: string; qty: number }

/**
 * The refund dialog's lines AS SENT to createRefund, and the figures it shows. One computation: what is displayed is what is sent,
 * and what is sent is what the credit note posts (net lines, VAT added by the ledger at each line's rate).
 */
export function buildRefundRequest(
  order: { taxRatePercent: number | null; fxRateToBase: number; lines: ReadonlyArray<MoneyViewLine & { id: string; productId: string | null; description: string }> },
  selections: ReadonlyArray<RefundSelection>,
): {
  lines: { lineId: string; productId: string | null; description: string; qty: number; totalForeign: number; totalBase: number }[]
  perLine: Record<string, RefundAmounts>
  total: RefundAmounts
} {
  const perLine: Record<string, RefundAmounts> = {}
  const lines: { lineId: string; productId: string | null; description: string; qty: number; totalForeign: number; totalBase: number }[] = []
  for (const sel of selections) {
    const line = order.lines.find((l) => l.id === sel.lineId)
    if (!line) continue
    const amounts = refundLineAmounts(line, sel.qty, order.taxRatePercent)
    perLine[line.id] = amounts
    if (!(sel.qty > 0)) continue
    lines.push({
      lineId: line.id,
      productId: line.productId,
      description: line.description,
      qty: sel.qty,
      totalForeign: amounts.net,
      totalBase: round4(amounts.net / (order.fxRateToBase || 1)),
    })
  }
  return { lines, perLine, total: sumRefundAmounts(Object.values(perLine)) }
}

/**
 * A recorded refund as its credit note carries it: each stored (net) refund line with the VAT the ledger adds at the rate of the
 * order line it refunds (the order's default rate for a line that links to none, such as a shipping refund).
 */
export function creditNoteAmounts(
  order: { taxRatePercent: number | null; lines: ReadonlyArray<MoneyViewLine & { id: string }> },
  refund: { lines: ReadonlyArray<{ salesOrderLineId: string | null; totalForeign: number }> },
): { perLine: RefundAmounts[]; total: RefundAmounts } {
  const perLine = refund.lines.map((rl) => {
    const orderLine = rl.salesOrderLineId ? order.lines.find((l) => l.id === rl.salesOrderLineId) : undefined
    const rate = orderLine ? lineVatRate(orderLine, order.taxRatePercent) : Number(order.taxRatePercent ?? 0)
    return creditAmounts(round2(rl.totalForeign), rate)
  })
  return { perLine, total: sumRefundAmounts(perLine) }
}
