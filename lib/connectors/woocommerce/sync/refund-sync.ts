/**
 * WooCommerce → IMS refund sync.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { WcRefund } from './types'

export async function syncWcRefund(
  wcOrderId: number,
  wcRefund: WcRefund,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Find the IMS order
    const so = await db.salesOrder.findUnique({
      where: { wcOrderId },
      select: {
        id: true,
        wcOrderNumber: true,
        fxRateToGbp: true,
        totalGbp: true,
        lines: { select: { id: true, productId: true, wcLineItemId: true, description: true, qty: true, totalGbp: true } },
      },
    })
    if (!so) return { success: false, error: `IMS order not found for WC order ${wcOrderId}` }

    // Check if already processed
    const existing = await db.salesOrderRefund.findFirst({ where: { wcRefundId: wcRefund.id } })
    if (existing) return { success: true } // already synced

    const fxRate = Number(so.fxRateToGbp) || 1
    const refundAmountForeign = Math.abs(parseFloat(wcRefund.amount) || 0)

    // Determine if restock is needed
    // Restock if any refund line item has qty != 0
    const hasQtyRefund = wcRefund.line_items.some((l) => Math.abs(l.quantity) > 0)

    // Map refund lines
    const refundLines: { productId: string | null; description: string; qty: number; totalGbp: number }[] = []

    if (wcRefund.line_items.length > 0 && hasQtyRefund) {
      // Line-item refund with quantities
      for (const rl of wcRefund.line_items) {
        const qty = Math.abs(rl.quantity)
        if (qty === 0) continue

        // Match by wcLineItemId
        const imsLine = so.lines.find((l) => l.wcLineItemId === rl.id)
        const refundTotal = Math.abs(parseFloat(rl.total) || 0)
        const refundGbp = Math.round((refundTotal / fxRate) * 10000) / 10000

        refundLines.push({
          productId: imsLine?.productId ?? null,
          description: rl.name || imsLine?.description || 'Refund item',
          qty,
          totalGbp: refundGbp,
        })
      }
    } else {
      // Monetary-only refund (no line items or all qty=0)
      // Create a single refund line with the full amount
      refundLines.push({
        productId: null,
        description: wcRefund.reason || 'WooCommerce refund',
        qty: 0,
        totalGbp: Math.round((refundAmountForeign / fxRate) * 10000) / 10000,
      })
    }

    // Find return warehouse (default return warehouse)
    let returnWarehouseId: string | undefined
    if (hasQtyRefund) {
      const returnWh = await db.warehouse.findFirst({
        where: { defaultReturnWarehouse: true, active: true },
        select: { id: true },
      })
      returnWarehouseId = returnWh?.id
    }

    // Use the createRefund action
    const { createRefund } = await import('@/app/actions/sales')
    const result = await createRefund(
      so.id,
      refundLines.filter((l) => l.qty > 0 || l.totalGbp > 0),
      wcRefund.reason || 'WooCommerce refund',
      returnWarehouseId,
      { internalBypassToken: INTERNAL_ACTION_BYPASS, externalRefundId: wcRefund.id },
    )

    if (!result.success) {
      await db.wcSyncLog.create({
        data: {
          direction: 'FROM_WC',
          status: 'FAILED',
          entityType: 'SalesOrder',
          entityId: so.id,
          wcId: wcRefund.id,
          errorMessage: result.error,
          syncedAt: new Date(),
        },
      })
      return { success: false, error: result.error }
    }

    await db.wcSyncLog.create({
      data: {
        direction: 'FROM_WC',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: so.id,
        wcId: wcRefund.id,
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'refund_synced',
      tag: 'sync',
      level: 'INFO',
      description: `Synced WC refund for order #${so.wcOrderNumber} — ${refundAmountForeign.toFixed(2)} ${hasQtyRefund ? '(with restock)' : '(monetary only)'}`,
      metadata: { wcRefundId: wcRefund.id, amount: refundAmountForeign, hasRestock: hasQtyRefund },
      resolveUser: false,
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Check for new refunds on synced orders and process them.
 */
export async function syncRefundsForOrder(wcOrderId: number): Promise<number> {
  // Fetch refunds from WC
  const { data, error } = await wcFetch(`/orders/${wcOrderId}/refunds`)
  if (error || !data) return 0

  const refunds = data as WcRefund[]
  let synced = 0

  for (const refund of refunds) {
    // Check if already synced
    const exists = await db.salesOrderRefund.findFirst({ where: { wcRefundId: refund.id } })
    if (exists) continue

    const result = await syncWcRefund(wcOrderId, refund)
    if (result.success) synced++
  }

  return synced
}
