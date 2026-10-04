/**
 * ONE WRITER OF A WOOCOMMERCE ORDER'S STATUS AT A TIME (o3d-6ldlj, Codex round 2).
 *
 * `order.cancel`, `order.hold` and `order.complete` jobs have separate claims, so nothing stopped a hold PUT that
 * was in flight from landing AFTER the cancel PUT of the same order (both rows SUCCEEDED, WooCommerce on-hold,
 * IMS cancelled). This gate sequences them PER ORDER: a job may be claimed only while no OTHER status job for the
 * same order is PROCESSING inside its lease. Used as `claimGate` of `claimIntegrationOutboxWork`, which takes a
 * per-order advisory lock and runs this check and the claim in one transaction, so two claimers cannot both pass.
 *
 * LEASE-BOUNDED: a claim older than the drain lease belongs to a dead (or fenced) worker and never blocks the
 * order for ever; the stale-claim park surfaces it. A deferred job is left untouched (no attempt consumed) and is
 * found by the next cron drain (every 5 minutes).
 */
import { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } from '@/lib/domain/integrations/outbox-leases'
import type { IntegrationOutboxClient, IntegrationOutboxRow } from '@/lib/domain/integrations/outbox'

export const WC_ORDER_STATUS_WRITER_OPERATIONS = ['order.cancel', 'order.hold', 'order.complete'] as const

export function wcOrderIdOf(row: Pick<IntegrationOutboxRow, 'payloadJson'>): string | null {
  const id = (row.payloadJson as { orderId?: unknown } | null)?.orderId
  return typeof id === 'string' && id.length > 0 ? id : null
}

export const wcOrderStatusClaimGate = {
  keyOf: (row: IntegrationOutboxRow): string | null => {
    const orderId = wcOrderIdOf(row)
    return orderId === null ? null : `woocommerce-order-status:${orderId}`
  },
  mayClaim: async (tx: IntegrationOutboxClient, row: IntegrationOutboxRow, now: Date): Promise<boolean> => {
    const orderId = wcOrderIdOf(row)
    if (orderId === null) return true
    const leaseStart = new Date(now.getTime() - INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default)
    const busy = await tx.integrationOutbox.findMany({
      where: {
        connector: 'woocommerce',
        operation: { in: [...WC_ORDER_STATUS_WRITER_OPERATIONS] },
        status: 'PROCESSING',
        lockedAt: { gt: leaseStart },
        id: { not: row.id },
        payloadJson: { path: ['orderId'], equals: orderId },
      },
      take: 1,
    })
    return busy.length === 0
  },
}

/**
 * CLAIM EACH JOB WHEN ITS ATTEMPT IS READY TO START (o3d-6ldlj, Codex round 3), and stop claiming after a wall-clock
 * budget. A drain used to claim up to 25 rows at once (one shared `lockedAt`) and process them one after another;
 * with slow WooCommerce calls a job at the back could wait longer than the 10 minute lease before its 2 minute
 * attempt began, so the cron could park a LIVE queued job as dead, or the per-order gate could treat its aged claim as
 * inactive and admit another writer. Now `lockedAt` is always within ONE attempt deadline of the write, so "a claim
 * older than the lease is a dead worker" holds by construction. The budget keeps a whole drain well inside the
 * lease: the last job starts before the budget and ends within one attempt deadline of it (4 + 2 minutes < 10).
 */
export const WC_DRAIN_CLAIM_BUDGET_MS = 4 * 60_000
/** How many due candidates a drain looks at per claim (oldest first). */
export const WC_DRAIN_SCAN_WINDOW = 25
