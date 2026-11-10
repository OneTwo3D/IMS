import { isInvoicedOrder } from '@/lib/domain/sales/invoiced-revenue-basis'

/**
 * One order's contribution to a customer's turnover: VAT-INCLUSIVE, like every other report's
 * invoiced total, on the shared invoiced basis (invoiced-revenue-basis.ts), with refunds netted.
 *
 * Every order contributes in the SAME unit, the gross order total less gross credit:
 *  - not invoiced (draft, cancelled, no invoice): nothing (`null`);
 *  - a GROSS-basis credit comes off as it stands;
 *  - a NET-basis credit comes off as its gross equivalent: the credited share of the sales line's
 *    own STORED gross, i.e. amount x (net + tax) / net using the line's stored `totalBase` (ex-VAT)
 *    and `taxBase`. The stored tax is what was charged. The linked `TaxRate.rate` is deliberately
 *    not read, because a rate can be edited after the sale;
 *  - that is done only when exact: every credit line must name a sales line with a positive stored
 *    net and a stored non-negative tax, no credit line may exceed its sales line's net, and the
 *    credit lines must add up to the credit's header total;
 *  - any credit that cannot be placed exactly (unproven basis, no lines, missing or zero stored
 *    amounts, lines that do not add up) is not guessed at: it comes off nothing and `complete` is
 *    false, so the sum is an upper bound.
 */
export type TurnoverRefund = {
  totalBase: unknown
  totalsBasis: string | null
  lines?: Array<{
    totalBase: unknown
    salesOrderLine?: { totalBase?: unknown; taxBase?: unknown } | null
  }>
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** The gross equivalent of a NET credit, or `null` when it cannot be established exactly. */
function netCreditAsGross(refund: TurnoverRefund): number | null {
  const lines = refund.lines ?? []
  if (lines.length === 0) return null
  let net = 0
  let gross = 0
  for (const line of lines) {
    const sales = line.salesOrderLine
    if (!sales || sales.totalBase == null || sales.taxBase == null) return null
    const lineNet = Number(sales.totalBase)
    const lineTax = Number(sales.taxBase)
    const amount = Number(line.totalBase)
    if (!Number.isFinite(lineNet) || !Number.isFinite(lineTax) || !Number.isFinite(amount)) return null
    // A line is placeable when it reverses a non-zero stored net, the stored tax has the same sign as
    // that net, and the credit is a share of it (0 to 100%). That includes a negative line against a
    // negative (discount) sales line, which is what makes a mixed-sign credit placeable line by line.
    if (lineNet === 0 || lineTax * lineNet < 0) return null
    const share = amount / lineNet
    if (share < 0 || share > 1.0001) return null
    net += amount
    gross += (amount * (lineNet + lineTax)) / lineNet
  }
  if (Math.abs(net - Number(refund.totalBase)) > 0.005) return null
  return round2(gross)
}

/**
 * What the published figure is relative to the truth:
 *  - `exact`: every credit was placed;
 *  - `upper`: some credit could not be placed, and every such credit is positive, so the true figure is at most the one shown;
 *  - `indeterminate`: an unplaced credit is zero, negative or not a number, so the true figure could be higher OR lower.
 */
export type TurnoverBound = 'exact' | 'upper' | 'indeterminate'

/** What `refundCreditsAsGross` needs of each refund: its basis and total, and each line's stored net and tax. */
export const REFUND_TURNOVER_SELECT = {
  select: {
    totalBase: true,
    totalsBasis: true,
    lines: { select: { totalBase: true, salesOrderLine: { select: { totalBase: true, taxBase: true } } } },
  },
} as const

/**
 * The credit an order's refunds represent in VAT-INCLUSIVE terms, and how far to trust it:
 * `credit` is the sum of the credits that could be placed exactly, `bound` is `exact` when all were,
 * `upper` when the unplaced ones are all positive (the true credit is at least `credit`, so what is
 * owed or earned is at most the figure shown), and `indeterminate` otherwise. Shared by customer
 * turnover and the aging reports so every screen reads a credit the same way.
 */
export function refundCreditsAsGross(refunds: TurnoverRefund[] | undefined): { credit: number; bound: TurnoverBound } {
  let credit = 0
  let bound: TurnoverBound = 'exact'
  for (const refund of refunds ?? []) {
    const placed = refund.totalsBasis === 'GROSS'
      ? Number(refund.totalBase)
      : refund.totalsBasis === 'NET' ? netCreditAsGross(refund) : null
    if (placed == null) {
      // Unplaced: a positive credit leaves the figure too high (upper bound); anything else could move it either way.
      // A credit with any negative line is mixed-sign, so even a positive total proves nothing about its gross value.
      const total = Number(refund.totalBase)
      const mixed = (refund.lines ?? []).some((l) => !(Number(l.totalBase) >= 0))
      if (!(Number.isFinite(total) && total > 0) || mixed) bound = 'indeterminate'
      else if (bound === 'exact') bound = 'upper'
    } else credit += placed
  }
  return { credit: round2(credit), bound }
}

export function orderTurnoverBase(order: {
  status: string
  invoiceNumber?: string | null
  accountingInvoiceId?: string | null
  shoppingLinks?: ReadonlyArray<{ connector: string }>
  totalBase: unknown
  refunds?: TurnoverRefund[]
}): { value: number; complete: boolean; bound: TurnoverBound } | null {
  if (!isInvoicedOrder(order)) return null
  const { credit, bound } = refundCreditsAsGross(order.refunds)
  return { value: round2(Number(order.totalBase) - credit), complete: bound === 'exact', bound }
}
