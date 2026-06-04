/**
 * WooCommerce → IMS refund sync.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { WcRefund } from './types'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

function parseDecimalAbs(value: string | number | null | undefined) {
  const decimal = toDecimal(value ?? 0)
  return decimal.lt(0) ? decimal.neg() : decimal
}

export async function syncWcRefund(
  externalOrderId: number,
  wcRefund: WcRefund,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Find the IMS order
    const so = await db.salesOrder.findFirst({
      where: {
        shoppingLinks: {
          some: {
            connector: 'woocommerce',
            externalOrderId: String(externalOrderId),
          },
        },
      },
      select: {
        id: true,
        externalOrderNumber: true,
        fxRateToBase: true,
        totalBase: true,
        lines: { select: { id: true, productId: true, externalLineItemId: true, description: true, qty: true, totalBase: true } },
      },
    })
    if (!so) return { success: false, error: `IMS order not found for WC order ${externalOrderId}` }

    // Check if already processed
    const existing = await db.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id } })
    if (existing) return { success: true } // already synced

    const fxRate = toDecimal(so.fxRateToBase).gt(0) ? toDecimal(so.fxRateToBase) : toDecimal(1)
    const refundAmountForeign = parseDecimalAbs(wcRefund.amount)

    // Determine if restock is needed
    // Restock if any refund line item has qty != 0
    const hasQtyRefund = wcRefund.line_items.some((l) => Math.abs(l.quantity) > 0)

    // Map refund lines
    const refundLines: {
      lineId?: string
      productId: string | null
      description: string
      qty: number
      totalForeign?: number
      totalBase: number
      lineKind?: 'sale' | 'shipping'
    }[] = []

    if (wcRefund.line_items.length > 0 && hasQtyRefund) {
      // Line-item refund with quantities
      for (const rl of wcRefund.line_items) {
        const qty = Math.abs(rl.quantity)
        if (qty === 0) continue

        // Match by externalLineItemId
        const imsLine = so.lines.find((l) => l.externalLineItemId === rl.id)
        const refundTotal = parseDecimalAbs(rl.total)
        const refundGbp = divideRoundedNumber(refundTotal, fxRate, 4)

        refundLines.push({
          lineId: imsLine?.id,
          productId: imsLine?.productId ?? null,
          description: rl.name || imsLine?.description || 'Refund item',
          qty,
          totalForeign: roundDecimalNumber(refundTotal, 4),
          totalBase: refundGbp,
          lineKind: 'sale',
        })
      }
    }

    for (const shippingLine of wcRefund.shipping_lines ?? []) {
      const shippingRefundTotal = parseDecimalAbs(shippingLine.total)
      if (shippingRefundTotal.lte(0.000001)) continue
      refundLines.push({
        productId: null,
        description: shippingLine.method_title || 'Shipping refund',
        qty: 0,
        totalForeign: roundDecimalNumber(shippingRefundTotal, 4),
        totalBase: divideRoundedNumber(shippingRefundTotal, fxRate, 4),
        lineKind: 'shipping',
      })
    }

    if (refundLines.length === 0) {
      refundLines.push({
        productId: null,
        description: wcRefund.reason || 'WooCommerce refund',
        qty: 0,
        totalForeign: roundDecimalNumber(refundAmountForeign, 4),
        totalBase: divideRoundedNumber(refundAmountForeign, fxRate, 4),
        lineKind: 'sale',
      })
    }

    const mappedRefundTotalForeign = roundDecimalNumber(
      refundLines.reduce((sum, line) => sum.add(toDecimal(line.totalForeign ?? 0).abs()), toDecimal(0)),
      4,
    )
    if (refundLines.length > 0 && toDecimal(mappedRefundTotalForeign).sub(refundAmountForeign).abs().gt(0.01)) {
      const error = `WooCommerce refund ${wcRefund.id} amount mismatch: mapped ${mappedRefundTotalForeign.toFixed(2)} but refund total is ${refundAmountForeign.toDecimalPlaces(2).toFixed(2)}`
      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'PENDING',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          payload: wcRefund as never,
          errorMessage: error,
        },
      })
      return {
        success: false,
        error,
      }
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
      refundLines.filter((l) => l.qty > 0 || l.totalBase > 0),
      wcRefund.reason || 'WooCommerce refund',
      returnWarehouseId,
      { internalBypassToken: INTERNAL_ACTION_BYPASS, externalRefundId: wcRefund.id },
    )

    if (!result.success) {
      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'FAILED',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          errorMessage: result.error,
          syncedAt: new Date(),
        },
      })
      return { success: false, error: result.error }
    }

    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: so.id,
        externalId: String(wcRefund.id),
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'refund_synced',
      tag: 'sync',
      level: 'INFO',
      description: `Synced WC refund for order #${so.externalOrderNumber} — ${refundAmountForeign.toFixed(2)} ${hasQtyRefund ? '(with restock)' : '(monetary only)'}`,
      metadata: { externalRefundId: wcRefund.id, amount: refundAmountForeign, hasRestock: hasQtyRefund },
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
export async function syncRefundsForOrder(externalOrderId: number): Promise<number> {
  // Fetch refunds from WC
  const { data, error } = await wcFetch(`/orders/${externalOrderId}/refunds`)
  if (error || !data) return 0

  const refunds = data as WcRefund[]
  let synced = 0

  for (const refund of refunds) {
    // Check if already synced
    const exists = await db.salesOrderRefund.findFirst({ where: { externalRefundId: refund.id } })
    if (exists) continue

    const result = await syncWcRefund(externalOrderId, refund)
    if (result.success) synced++
  }

  return synced
}
