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
import { refundableNet } from '@/lib/domain/sales/refund-line-net'
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

/** An earlier refund line against an order line, as stored. */
export type PriorRefundLine = { salesOrderLineId: string | null; qty: number; totalForeign: number; totalBase: number }

/**
 * What refunding `qty` units of an order line credits: cut from what the line has LEFT (the same function the refund service runs under
 * the order lock, lib/domain/sales/refund-line-net.ts), so the figures shown are the ones that will be written unless another refund lands first.
 */
export function refundLineAmounts(
  line: Pick<MoneyViewLine, 'qty' | 'totalForeign' | 'taxForeign' | 'taxRatePercent'> & { id?: string },
  qty: number,
  orderRate: number | null,
  priorRefundLines: ReadonlyArray<PriorRefundLine> = [],
  minorUnits = 2,
): RefundAmounts {
  // (a non-positive qty, or a line with nothing left, is cut to 0 by refundableNet)
  const prior = priorRefundLines.filter((p) => line.id != null && p.salesOrderLineId === line.id)
  const net = refundableNet({
    line: { qty: line.qty, net: line.totalForeign },
    prior: { qty: prior.reduce((s, p) => s + p.qty, 0), net: prior.reduce((s, p) => s + p.totalForeign, 0) },
    qty,
    minorUnits,
  })
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
 * The refund dialog's lines AS SENT to createRefund, and the figures it shows. What is sent is a PREVIEW: the server cuts each line again
 * from what the order line has left, under the order lock, with the same function. What is displayed is what is sent.
 */
export function buildRefundRequest(
  order: {
    taxRatePercent: number | null
    fxRateToBase: number
    currencyMinorUnits?: number
    priorRefundLines?: ReadonlyArray<PriorRefundLine>
    lines: ReadonlyArray<MoneyViewLine & { id: string; productId: string | null; description: string; totalBase?: number }>
  },
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
    const amounts = refundLineAmounts(line, sel.qty, order.taxRatePercent, order.priorRefundLines ?? [], order.currencyMinorUnits ?? 2)
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
 * A recorded refund line as its credit note posts it, resolved on the SERVER from what is persisted (see credit-note-display.ts):
 * `postedNet` is the column the credit note actually carries (the base column on a base-currency order, the foreign one otherwise) and
 * `vatRate` the rate of the tax code the line was snapshotted under, or null when that code cannot be priced.
 */
export type CreditNoteLineFacts = { salesOrderLineId: string | null; postedNet: number; vatRate: number | null }

/**
 * A recorded refund as its credit note carries it: the posted net of each line with the VAT the ledger adds at the rate of its persisted
 * posting tax code. A line whose code cannot be priced falls back to the refunded order line's own rate (the order's default rate for a
 * line that links to none, such as a shipping refund).
 */
export function creditNoteAmounts(
  order: { taxRatePercent: number | null; lines: ReadonlyArray<MoneyViewLine & { id: string }> },
  refund: { lines: ReadonlyArray<CreditNoteLineFacts> },
): { perLine: RefundAmounts[]; total: RefundAmounts } {
  const rateOf = (rl: CreditNoteLineFacts): number => {
    const orderLine = rl.salesOrderLineId ? order.lines.find((l) => l.id === rl.salesOrderLineId) : undefined
    return rl.vatRate ?? (orderLine ? lineVatRate(orderLine, order.taxRatePercent) : Number(order.taxRatePercent ?? 0))
  }
  // Per-line figures are for display (each rounded to the minor unit); the TOTAL is summed from the unrounded 4 dp amounts and rounded once, so
  // many tiny lines do not drift by a rounding error each.
  const perLine = refund.lines.map((rl) => creditAmounts(round2(rl.postedNet), rateOf(rl)))
  const rawNet = refund.lines.reduce((s, rl) => s + rl.postedNet, 0)
  const rawVat = refund.lines.reduce((s, rl) => s + rl.postedNet * rateOf(rl), 0)
  return { perLine, total: { net: round2(rawNet), vat: round2(rawVat), gross: round2(rawNet + rawVat) } }
}
