import type { db } from '@/lib/db'
import { currencyMinorUnits, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirementQuantities } from '@/lib/products/fulfillment-requirement-snapshot'
import { isMirroredFeeLine } from '@/lib/domain/wms/mirrored-fee-line'
import { computeMixedScope, type MixedScope, type ScopeLineInput } from '@/lib/domain/wms/mixed-scope'

type ScopeReadClient = Pick<typeof db, 'salesOrder' | 'orderAllocation' | 'shipment' | 'salesOrderRefundLine' | 'wmsOrderPushLink' | 'wmsOrderPushScopeLine'>

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
  // FULL is decided from the allocations and shipments ALONE, before any kit graph or requirement snapshot is read: a single-warehouse order must never be
  // blocked by a graph the part computation would have needed (a circular kit, an unreadable snapshot), so it stays development's payload.
  const [firstAllocations, firstShipments] = await Promise.all([
    client.orderAllocation.findMany({ where: { orderId }, select: { warehouseId: true, qty: true } }),
    client.shipment.findMany({ where: { orderId }, select: { warehouseId: true, _count: { select: { lines: true } } } }),
  ])
  const elsewhere = firstAllocations.some((row) => row.warehouseId !== wmsWarehouseId && toDecimal(row.qty).toNumber() > 1e-6)
    || firstShipments.some((row) => row.warehouseId !== wmsWarehouseId && row._count.lines > 0)
  if (!elsewhere) return { mode: 'FULL' }
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
  const [allocations, shipments, recorded, refundLines] = await Promise.all([
    client.orderAllocation.findMany({ where: { orderId }, select: { lineId: true, productId: true, warehouseId: true, qty: true } }),
    client.shipment.findMany({ where: { orderId }, select: { id: true, warehouseId: true, status: true, _count: { select: { lines: true } } } }),
    client.wmsOrderPushLink.findUnique({ where: { orderId }, select: { scopeShippingCarried: true } }),
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
    shipments: shipments.map((shipment) => ({ id: shipment.id, warehouseId: shipment.warehouseId, status: String(shipment.status), lineCount: shipment._count.lines })),
    shippingCarried: recorded?.scopeShippingCarried ?? null,
    money: {
      discountMinor: minor(order.discountAmount, minorUnits),
      shippingMinor: minor(order.shippingForeign, minorUnits),
      totalVatMinor: minor(order.taxForeign, minorUnits),
    },
    minorFactor: 10 ** minorUnits,
  })
}

/**
 * The scope RECORDED as sent (the link's current scope version, its snapshot lines and its money), rebuilt with the order's CURRENT unit prices, or null when
 * none is recorded. A header-only amendment (address, service, notes) of a pushed part is built from this when the CURRENT scope cannot be sent (HOLD, REFUSED,
 * EMPTY): the line set stays exactly what the warehouse holds, and everything else still reaches it.
 */
export async function loadRecordedScopeForOrder(client: ScopeReadClient, orderId: string): Promise<MixedScope | null> {
  const link = await client.wmsOrderPushLink.findUnique({
    where: { orderId },
    select: { id: true, scopeMode: true, scopeVersion: true, scopeHash: true, scopeDiscountMinor: true, scopeShippingMinor: true, scopeVatMinor: true, scopeShippingCarried: true },
  })
  if (!link || link.scopeMode !== 'MIXED' || link.scopeVersion === 0) return null
  const [sent, order] = await Promise.all([
    client.wmsOrderPushScopeLine.findMany({ where: { linkId: link.id, scopeVersion: link.scopeVersion }, select: { orderLineId: true, sku: true, quantity: true } }),
    client.salesOrder.findUnique({ where: { id: orderId }, select: { currency: true, lines: { select: { id: true, description: true, qty: true, totalForeign: true, taxForeign: true } } } }),
  ])
  if (!order || sent.length === 0) return null
  const minorUnits = currencyMinorUnits(order.currency)
  const factor = 10 ** minorUnits
  const lines = sent.flatMap((row) => {
    const line = order.lines.find((candidate) => candidate.id === row.orderLineId)
    if (!line) return []
    const ordered = toDecimal(line.qty).toNumber() || 1
    return [{
      lineId: row.orderLineId, sku: row.sku, description: line.description || null, quantity: toDecimal(row.quantity).toNumber(),
      unitPriceExVat: minor(line.totalForeign, minorUnits) / factor / ordered, unitPriceVat: minor(line.taxForeign, minorUnits) / factor / ordered,
    }]
  })
  if (lines.length !== sent.length) return null
  return {
    mode: 'MIXED', lines, discountMinor: link.scopeDiscountMinor ?? 0, shippingMinor: link.scopeShippingMinor ?? 0, vatMinor: link.scopeVatMinor ?? 0,
    shippingCarried: link.scopeShippingCarried ?? (link.scopeShippingMinor ?? 0) > 0, hash: link.scopeHash ?? '',
  }
}
