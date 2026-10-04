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
