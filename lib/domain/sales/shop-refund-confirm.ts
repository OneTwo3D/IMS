import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { toDecimal } from '@/lib/domain/math/decimal'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { activeRefundParkWhere } from '@/lib/domain/sales/refund-park-recovery'
import { confirmShopRefundSettlement } from '@/lib/domain/sales/shop-refund-tasks'

/**
 * "Confirm this WooCommerce refund settles IMS refund <credit note>" (zvec.19), without the sign-in and permission gates (the server action holds them:
 * the same permission as recording a refund by hand).
 *
 * A refund recorded in IMS on a WooCommerce order writes nothing to WooCommerce, and IMS cannot tell the refund a person later makes there from a
 * separate refund with the same amount (it writes no marker), so the import parks it QUARANTINED instead of linking it. This is the person's answer
 * "it IS the payment of that IMS refund": ONE transaction, under the per-refund advisory lock and then the order lock (the refund writer's order),
 * re-reads the park, re-checks the match, sets the WooCommerce refund id on the IMS refund, resolves the "Refund in WooCommerce" task and the park and
 * writes the audit entry. No credit note is raised: the IMS refund already has it. The link is applied once however many confirmations race: the
 * second finds the IMS refund no longer waiting and changes nothing.
 */

export type ConfirmParkedRefundResult = { success: true; notice: string; orderId: string } | { success: false; error: string }

function parkedGross(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null
  const amount = (payload as { amount?: unknown }).amount
  if (typeof amount === 'string' && amount.trim()) return amount.trim()
  if (typeof amount === 'number' && Number.isFinite(amount)) return String(amount)
  return null
}

export async function confirmParkedRefundSettlement(
  client: typeof db,
  input: { parkId: string; imsRefundId: string; userId: string },
): Promise<ConfirmParkedRefundResult> {
  if (typeof input.parkId !== 'string' || input.parkId === '' || typeof input.imsRefundId !== 'string' || input.imsRefundId === '') {
    return { success: false, error: 'Name the parked refund and the IMS refund it settles.' }
  }
  const parkWhere = { ...activeRefundParkWhere(), status: 'QUARANTINED' as const }
  const park = await client.shoppingSyncLog.findFirst({ where: { id: input.parkId, ...parkWhere }, select: { id: true, entityId: true, externalId: true, payload: true } })
  if (!park?.entityId || !park.externalId) return { success: false, error: 'This refund is no longer quarantined (already resolved, retried, or removed).' }
  const wcRefundId = Number(park.externalId)
  if (!Number.isSafeInteger(wcRefundId) || wcRefundId <= 0) return { success: false, error: `The parked row has no usable WooCommerce refund id (${park.externalId}).` }
  const grossText = parkedGross(park.payload)
  if (grossText == null) return { success: false, error: 'This park does not carry the WooCommerce refund it came from, so its amount cannot be checked. Retry on this row re-reads the refund from WooCommerce and stores it on the row.' }
  const amount = toDecimal(grossText).abs()
  if (!amount.isFinite() || amount.lte(0)) return { success: false, error: `The parked WooCommerce refund has no usable amount (${grossText}).` }
  const orderId = park.entityId
  const externalId = park.externalId

  try {
    return await client.$transaction(async (tx): Promise<ConfirmParkedRefundResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${wcRefundId}`}))`
      await lockSalesOrder(tx, orderId)
      const fresh = await tx.shoppingSyncLog.findFirst({ where: { id: input.parkId, ...parkWhere, entityId: orderId }, select: { id: true } })
      if (!fresh) return { success: false, error: 'This refund is no longer quarantined (already resolved, retried, or removed).' }
      const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { currency: true, orderNumber: true } })
      if (!order) return { success: false, error: 'The order this refund belongs to no longer exists.' }
      const settled = await confirmShopRefundSettlement(tx, { orderId, orderCurrency: order.currency, imsRefundId: input.imsRefundId, wcRefundId, amountForeign: amount, userId: input.userId })
      if (!settled.ok) return { success: false, error: settled.error }
      await tx.shoppingSyncLog.updateMany({
        where: { ...activeRefundParkWhere(), externalId, entityId: orderId },
        data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
      })
      await logActivityInTransaction(tx, {
        userId: input.userId,
        entityType: 'SALES_ORDER',
        entityId: orderId,
        tag: 'sync',
        action: 'wc_refund_confirmed_settles_ims_refund',
        level: 'INFO',
        description: `WooCommerce refund ${wcRefundId} (${amount.toFixed(2)} ${order.currency}) was confirmed by a person as the payment of an IMS refund${settled.creditNoteNumber ? ` (credit note ${settled.creditNoteNumber})` : ''} on order ${order.orderNumber ?? orderId}. It was linked to that refund, no second credit note was raised, and the Refund in WooCommerce task and the parked row were resolved.`,
        metadata: { shoppingSyncLogId: park.id, externalRefundId: wcRefundId, imsRefundId: input.imsRefundId, taskId: settled.taskId, userId: input.userId },
      })
      return { success: true, orderId, notice: 'Linked. The WooCommerce refund now belongs to that IMS refund, no second credit note was raised, and the task is done.' }
    }, { maxWait: 5_000, timeout: 20_000 })
  } catch (error) {
    if (isExternalRefundIdUniqueConflict(error)) return { success: false, error: `WooCommerce refund ${wcRefundId} was recorded in IMS while you were confirming it. Nothing was changed.` }
    throw error
  }
}
