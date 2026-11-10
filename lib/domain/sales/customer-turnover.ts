import { isInvoicedOrder } from '@/lib/domain/sales/invoiced-revenue-basis'
import { netOfRefunds } from '@/lib/domain/sales/refund-basis-analytics'

/**
 * One order's contribution to a customer's turnover, on the shared invoiced basis
 * (see invoiced-revenue-basis.ts), with its refunds netted the way the customer aging does.
 *
 * - Not invoiced (draft, cancelled, no invoice): contributes nothing (`null`).
 * - No refunds: the order total.
 * - Refunds on one basis: the order total on that basis less the credit (so a full refund is 0).
 * - Refunds whose basis is unproven or mixed: no sound subtraction exists, so the order total
 *   stands and `complete` is false, i.e. the sum is an upper bound.
 */
export function orderTurnoverBase(order: {
  status: string
  invoiceNumber?: string | null
  accountingInvoiceId?: string | null
  totalBase: unknown
  taxBase?: unknown
  refunds?: Array<{ totalBase: unknown; totalsBasis: string | null }>
}): { value: number; complete: boolean } | null {
  if (!isInvoicedOrder(order)) return null
  const total = Number(order.totalBase)
  const refunds = order.refunds ?? []
  if (refunds.length === 0) return { value: total, complete: true }
  const net = netOfRefunds(
    { totalBase: Number(order.totalBase), taxBase: Number(order.taxBase ?? 0) },
    refunds.map((r) => ({ totalBase: Number(r.totalBase), totalsBasis: r.totalsBasis })),
  )
  return net.netTotal == null ? { value: total, complete: false } : { value: net.netTotal, complete: true }
}
