import type { SalesOrderStatus } from '@/app/generated/prisma/client'

/**
 * Sales-order statuses at which the order has shipped all units and reached a
 * terminal post-shipment state, so the daily batch must recognize ALL remaining
 * deferred revenue on the final shipment (a true-up) rather than only the
 * proportional slice.
 *
 * Without truing up at every terminal-but-fully-shipped status, an order that
 * ships its final units while already COMPLETED / DELIVERED only ever recognizes
 * the rounded proportional amount, so rounding drift strands pence of unearned
 * revenue in deferral permanently (cogs-audit scjz.41).
 *
 * REFUNDED and CANCELLED are full reversals (no revenue to recognize) and are
 * intentionally excluded; pre-shipment statuses are excluded because more
 * shipments may still arrive. PARTIALLY_REFUNDED is intentionally NOT included:
 * the refund workflow can set it from pre-shipment states (refunding unshipped
 * lines) and already posts an UNEARNED_REV_REVERSAL that remainingDeferred does
 * not subtract, so truing up there would over-recognize. A refund-reversal-aware
 * true-up for partially-refunded orders is tracked separately (scjz.68).
 */
export const FULLY_SHIPPED_TERMINAL_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const

const FULLY_SHIPPED_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(FULLY_SHIPPED_TERMINAL_STATUSES)

/**
 * Whether `status` means the order has fully shipped and reached a terminal
 * post-shipment state that should true up any remaining deferred revenue.
 */
export function isFullyShippedTerminalStatus(status: SalesOrderStatus | string): boolean {
  return FULLY_SHIPPED_TERMINAL_STATUS_SET.has(status)
}

/**
 * scjz.68: sum the debit posted to the unearned-revenue account in an
 * UNEARNED_REV_REVERSAL journal payload (DR unearned / CR sales). This is the amount of
 * deferred revenue a refund of unshipped lines already reversed, which the daily-batch
 * true-up must subtract from the deferred base so it never re-recognizes it.
 */
export function extractUnearnedReversalDebit(payload: unknown, unearnedAccountCode: string): number {
  const lines = (payload as { lines?: Array<{ accountCode?: string; debit?: number }> } | null)?.lines
  if (!Array.isArray(lines)) return 0
  return lines.reduce((sum, line) => (
    line.accountCode === unearnedAccountCode ? sum + (Number(line.debit) || 0) : sum
  ), 0)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Decide how much deferred revenue a single Group-B shipment recognizes within
 * its order's daily-batch run, applying the terminal-status true-up.
 *
 * On the final shipment of a fully-shipped terminal order, recognize ALL the
 * remaining deferred revenue (`remainingDeferred - runningRevenue`) so rounding
 * drift never strands pence in deferral permanently (cogs-audit scjz.41).
 * Otherwise recognize the proportional slice, capped at the remaining deferred
 * so an order never recognizes more than it deferred.
 *
 * Shared by the cron daily-sync (the posting path) and the daily-batch preview
 * so the preview matches what actually posts (cogs-audit scjz.69). `round2`
 * here mirrors the rounding both call sites use, so results are bit-identical.
 */
export function recognizeShipmentRevenue(params: {
  proportionalRevenue: number
  remainingDeferred: number
  runningRevenue: number
  isFinalShipmentOfFullyShippedTerminalOrder: boolean
}): number {
  const cap = round2(Math.max(0, params.remainingDeferred - params.runningRevenue))
  if (params.isFinalShipmentOfFullyShippedTerminalOrder) {
    return cap
  }
  return Math.min(params.proportionalRevenue, cap)
}
