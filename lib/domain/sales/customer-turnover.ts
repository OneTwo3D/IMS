import { isInvoicedOrder } from '@/lib/domain/sales/invoiced-revenue-basis'

/**
 * One order's contribution to a customer's turnover: VAT-INCLUSIVE, like every other report's
 * invoiced total, on the shared invoiced basis (invoiced-revenue-basis.ts), with refunds netted.
 *
 * Every order contributes in the SAME unit, the gross order total less gross credit:
 *  - not invoiced (draft, cancelled, no invoice): nothing (`null`);
 *  - a GROSS-basis credit comes off as it stands;
 *  - a NET-basis credit comes off as its gross equivalent, computed line by line at the refunded
 *    line's own tax rate, but ONLY when that is exact: every credit line must name a sales line
 *    whose rate is known, and the credit lines must add up to the credit's header total;
 *  - any credit that cannot be placed exactly (unproven basis, no lines, a line with no known rate,
 *    lines that do not add up) is not guessed at: it comes off nothing and `complete` is false,
 *    so the sum is an upper bound.
 */
export type TurnoverRefund = {
  totalBase: unknown
  totalsBasis: string | null
  lines?: Array<{
    totalBase: unknown
    salesOrderLine?: { taxBase?: unknown; taxRate?: { rate: unknown } | null } | null
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
    if (!sales) return null
    // A line with no tax rate row is untaxed only if it carries no tax; otherwise its rate is unknown.
    const rate = sales.taxRate ? Number(sales.taxRate.rate) : Number(sales.taxBase ?? NaN) === 0 ? 0 : NaN
    if (!Number.isFinite(rate) || rate < 0) return null
    const amount = Number(line.totalBase)
    net += amount
    gross += amount * (1 + rate)
  }
  if (Math.abs(net - Number(refund.totalBase)) > 0.005) return null
  return round2(gross)
}

export function orderTurnoverBase(order: {
  status: string
  invoiceNumber?: string | null
  accountingInvoiceId?: string | null
  totalBase: unknown
  refunds?: TurnoverRefund[]
}): { value: number; complete: boolean } | null {
  if (!isInvoicedOrder(order)) return null
  let value = Number(order.totalBase)
  let complete = true
  for (const refund of order.refunds ?? []) {
    const credit = refund.totalsBasis === 'GROSS'
      ? Number(refund.totalBase)
      : refund.totalsBasis === 'NET' ? netCreditAsGross(refund) : null
    if (credit == null) complete = false
    else value -= credit
  }
  return { value: round2(value), complete }
}
