import type { db } from '@/lib/db'
import { currencyMinorUnits, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirementQuantities } from '@/lib/products/fulfillment-requirement-snapshot'
import { isMirroredFeeLine } from '@/lib/domain/wms/mirrored-fee-line'
import { computeMixedScope, type MixedScope, type ScopeLineInput } from '@/lib/domain/wms/mixed-scope'

type ScopeReadClient = Pick<typeof db, 'salesOrder' | 'orderAllocation' | 'shipment' | 'salesOrderRefundLine'>

/** A stored money figure (major units, any numeric form) as whole minor units of the order currency, half-up. Unreadable reads as 0. */
function minor(value: unknown, minorUnits: number): number {
  try {
    return roundQuantity(toDecimal(value as never).mul(toDecimal(10).pow(minorUnits)), 0).toNumber()
  } catch {
    return 0
  }
}

/**
 * Read an order's allocations, shipments and money and compute the warehouse part (see mixed-scope.ts). The only database reader of the scope: every
 * caller (create, amend, revalidation, despatch) asks here, so "what is the WMS part of this order" has one answer.
 *
 * `wmsWarehouseId` is the IMS warehouse the warehouse order serves. Returns null when the order is gone.
 */
export async function loadMixedScopeForOrder(
  client: ScopeReadClient,
  orderId: string,
  wmsWarehouseId: string,
): Promise<MixedScope | null> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      currency: true,
      discountAmount: true,
      shippingForeign: true,
      taxForeign: true,
      lines: {
        select: {
          id: true, sku: true, description: true, qty: true, totalForeign: true, taxForeign: true, productId: true,
          wclcFeeKind: true, externalLineItemId: true, fulfillmentRequirements: true, product: { select: { type: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
  })
  if (!order) return null
  const [allocations, shipments, refundLines] = await Promise.all([
    client.orderAllocation.findMany({ where: { orderId }, select: { lineId: true, productId: true, warehouseId: true, qty: true } }),
    client.shipment.findMany({ where: { orderId }, select: { id: true, warehouseId: true, status: true } }),
    client.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, select: { salesOrderLineId: true, qty: true } }),
  ])
  const refunded = new Map<string, number>()
  for (const refundLine of refundLines) {
    if (!refundLine.salesOrderLineId) continue
    refunded.set(refundLine.salesOrderLineId, (refunded.get(refundLine.salesOrderLineId) ?? 0) + toDecimal(refundLine.qty).toNumber())
  }
  const trackedProductIds = order.lines
    .filter((line) => !!line.productId && isStockTrackedProductType(line.product?.type))
    .map((line) => line.productId as string)
  const graph = await loadFulfillmentProductGraph(client as never, trackedProductIds)
  const minorUnits = currencyMinorUnits(order.currency)
  const lines: ScopeLineInput[] = order.lines.map((line) => {
    const requirements: ScopeLineInput['requirements'] = []
    if (line.productId && isStockTrackedProductType(line.product?.type)) {
      for (const [productId, perUnit] of lineFulfillmentRequirementQuantities(line, 1, graph)) requirements.push({ productId, perUnit: perUnit.toString() })
    }
    return {
      lineId: line.id,
      sku: line.sku,
      description: line.description,
      orderedQty: toDecimal(line.qty).toNumber(),
      refundedQty: refunded.get(line.id) ?? 0,
      netMinor: minor(line.totalForeign, minorUnits),
      vatMinor: minor(line.taxForeign, minorUnits),
      requirements,
      isFee: isMirroredFeeLine(line),
    }
  })
  return computeMixedScope({
    wmsWarehouseId,
    lines,
    allocations: allocations.map((alloc) => ({ lineId: alloc.lineId, productId: alloc.productId, warehouseId: alloc.warehouseId, qty: alloc.qty.toString() })),
    shipments,
    money: {
      discountMinor: minor(order.discountAmount, minorUnits),
      shippingMinor: minor(order.shippingForeign, minorUnits),
      totalVatMinor: minor(order.taxForeign, minorUnits),
    },
    minorFactor: 10 ** minorUnits,
  })
}
