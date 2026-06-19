import type { SalesOrderStatus } from '@/app/generated/prisma/client'

/**
 * Sales-order statuses at which the order has shipped all units and reached a
 * terminal post-shipment state, so the daily batch must recognize ALL remaining
 * deferred revenue on the final shipment (a true-up) rather than only the
 * proportional slice.
 *
 * Without truing up at every terminal-but-fully-shipped status, an order that
 * ships its final units while already COMPLETED / DELIVERED / PARTIALLY_REFUNDED
 * only ever recognizes the rounded proportional amount, so rounding drift strands
 * pence of unearned revenue in deferral permanently (cogs-audit scjz.41).
 *
 * REFUNDED and CANCELLED are full reversals (no revenue to recognize) and are
 * intentionally excluded; pre-shipment statuses are excluded because more
 * shipments may still arrive.
 */
export const FULLY_SHIPPED_TERMINAL_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'] as const

const FULLY_SHIPPED_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(FULLY_SHIPPED_TERMINAL_STATUSES)

/**
 * Whether `status` means the order has fully shipped and reached a terminal
 * post-shipment state that should true up any remaining deferred revenue.
 */
export function isFullyShippedTerminalStatus(status: SalesOrderStatus | string): boolean {
  return FULLY_SHIPPED_TERMINAL_STATUS_SET.has(status)
}
