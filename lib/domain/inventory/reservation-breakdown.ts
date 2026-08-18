import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  RESERVATION_RELEASING_SHIPMENT_STATUS,
  UNCOMMITTED_SHIPMENT_STATUS,
} from '@/lib/domain/inventory/reservation-residual'

export type ReservationBreakdownSource =
  | 'sales_order'
  | 'stock_transfer'
  | 'production_order'
  | 'other'

export type ReservationBreakdownRow = {
  source: ReservationBreakdownSource
  productId: string
  warehouseId: string
  referenceId: string
  referenceLabel: string
  qty: string
  expectedDate: string | null
}

export type ReservationBreakdownResult = {
  productId: string
  warehouseId: string
  generatedAt: string
  stockLevelReservedQty: string
  knownReservedQty: string
  unattributedQty: string
  driftQty: string
  rows: ReservationBreakdownRow[]
}

type AllocationRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: DecimalInput
  order: {
    orderNumber: string | null
    externalOrderNumber: string | null
    expectedDelivery: Date | null
    status: string
    refundStatus: string
  }
  line: {
    sku: string | null
    description: string
  }
}

type ActiveShipmentLineRow = {
  lineId: string
  productId: string
  qty: DecimalInput
  shipment: {
    warehouseId: string
    status: string
  }
}

type ProductionOrderRow = {
  id: string
  reference: string
  orderType: 'ASSEMBLY' | 'DISASSEMBLY'
  outputProductId: string
  warehouseId: string
  qtyPlanned: DecimalInput
  scheduledAt: Date | null
  outputProduct: {
    productComponents: Array<{
      componentId: string
      qty: DecimalInput
    }>
  }
}

type StockLevelReservationRow = {
  reservedQty: DecimalInput
}

export type ReservationBreakdownClient = {
  orderAllocation: {
    findMany(args: unknown): Promise<AllocationRow[]>
  }
  shipmentLine: {
    findMany(args: unknown): Promise<ActiveShipmentLineRow[]>
  }
  productionOrder: {
    findMany(args: unknown): Promise<ProductionOrderRow[]>
  }
  stockLevel: {
    findUnique(args: unknown): Promise<StockLevelReservationRow | null>
  }
}

export type ReservationSourceLoadOptions = {
  productId?: string
  warehouseId?: string
}

const ZERO = new Prisma.Decimal(0)
const RESERVATION_EPSILON = new Prisma.Decimal('0.0001')

function stockKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function allocationKey(lineId: string, productId: string, warehouseId: string): string {
  return `${lineId}:${productId}:${warehouseId}`
}

function decimalString(value: Decimal): string {
  return value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toString()
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function positiveOrZero(value: Decimal): Decimal {
  return value.gt(0) ? value : ZERO
}

function sourceLabel(prefix: string, reference: string, detail?: string | null): string {
  return detail ? `${prefix} ${reference} - ${detail}` : `${prefix} ${reference}`
}

export async function loadReservationSourceRows(
  client: ReservationBreakdownClient = db as unknown as ReservationBreakdownClient,
  options: ReservationSourceLoadOptions = {},
): Promise<ReservationBreakdownRow[]> {
  // o3d-4kfh: ZERO-DEMAND ORDERS ARE INCLUDED, not excluded.
  //
  // A CANCELLED or fully-refunded order has no outstanding demand, which is why this query used to
  // drop it entirely. But demand is not the same thing as a reservation: a full refund on an order
  // that already has a PICKING or PACKED shipment leaves the COMMITTED portion reserved on the
  // stock level (allocation retains the committed set, and only dispatch decrements reservedQty).
  // Excluding those rows reported a real, correctly-held reservation as an unattributed balance —
  // the exact drift this breakdown exists to explain away. They are included below and credited
  // for their still-committed portion ONLY; any stale outstanding remainder stays unattributed,
  // because that part genuinely is a leak.
  const allocationWhere = {
    ...(options.productId ? { productId: options.productId } : {}),
    ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    qty: { gt: 0 },
  }
  // Every COMMITTED (non-PENDING) shipment line, tagged with its status so both readings come off
  // ONE query: SHIPPED is what has already given reservation back (the residual), non-PENDING is
  // what the warehouse is holding. A PICKING/PACKED shipment has not decremented reservedQty, so
  // netting it out of the residual would understate every picked order's live reservation.
  //
  // Deliberately NOT filtered by order status: the zero-demand rows above need their committed
  // lines too, and `lineId` is unique to one order, so no other order's shipment can be matched.
  const activeShipmentWhere = {
    ...(options.productId ? { productId: options.productId } : {}),
    shipment: {
      status: { not: UNCOMMITTED_SHIPMENT_STATUS },
      ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    },
  }
  const productionWhere = {
    status: 'IN_PROGRESS',
    ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    ...(options.productId
      ? {
          OR: [
            {
              orderType: 'ASSEMBLY',
              outputProduct: {
                productComponents: {
                  some: { componentId: options.productId },
                },
              },
            },
            {
              orderType: 'DISASSEMBLY',
              outputProductId: options.productId,
            },
          ],
        }
      : {}),
  }

  const [allocations, activeShipmentLines, productionOrders] = await Promise.all([
    client.orderAllocation.findMany({
      where: allocationWhere,
      select: {
        id: true,
        orderId: true,
        lineId: true,
        productId: true,
        warehouseId: true,
        qty: true,
        order: {
          select: {
            orderNumber: true,
            externalOrderNumber: true,
            expectedDelivery: true,
            status: true,
            refundStatus: true,
          },
        },
        line: {
          select: {
            sku: true,
            description: true,
          },
        },
      },
      orderBy: [{ orderId: 'asc' }, { lineId: 'asc' }, { productId: 'asc' }, { warehouseId: 'asc' }],
    }),
    client.shipmentLine.findMany({
      where: activeShipmentWhere,
      select: {
        lineId: true,
        productId: true,
        qty: true,
        shipment: {
          select: {
            warehouseId: true,
            status: true,
          },
        },
      },
    }),
    client.productionOrder.findMany({
      where: productionWhere,
      select: {
        id: true,
        reference: true,
        orderType: true,
        outputProductId: true,
        warehouseId: true,
        qtyPlanned: true,
        scheduledAt: true,
        outputProduct: {
          select: {
            productComponents: {
              select: {
                componentId: true,
                qty: true,
              },
            },
          },
        },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    }),
  ])

  // Two sums per allocation row off the SAME set of lines: everything committed, and the DISPATCHED
  // subset of it that has already given reservation back.
  const committedByAllocation = new Map<string, Decimal>()
  const dispatchedByAllocation = new Map<string, Decimal>()
  for (const shipmentLine of activeShipmentLines) {
    if (options.productId && shipmentLine.productId !== options.productId) continue
    if (options.warehouseId && shipmentLine.shipment.warehouseId !== options.warehouseId) continue
    const key = allocationKey(
      shipmentLine.lineId,
      shipmentLine.productId,
      shipmentLine.shipment.warehouseId,
    )
    const qty = toDecimal(shipmentLine.qty)
    committedByAllocation.set(key, (committedByAllocation.get(key) ?? ZERO).add(qty))
    if (shipmentLine.shipment.status === RESERVATION_RELEASING_SHIPMENT_STATUS) {
      dispatchedByAllocation.set(key, (dispatchedByAllocation.get(key) ?? ZERO).add(qty))
    }
  }

  // o3d-4kfh r3: THE TOLERANCE IS APPLIED AT THE SAME AGGREGATION STAGE AS THE SQL FAST PATH.
  //
  // `invariants.ts` builds the identical census in SQL, and there the tolerance is a
  // `HAVING SUM(...) > tolerance` — applied to the (product, warehouse) TOTAL of each UNION branch,
  // after aggregation. This function used to drop each ROW whose credited residual was <= 0.0001
  // BEFORE anything was summed, so two legitimate 0.0001 residuals contributed 0 here and 0.0002
  // there. `knownReservedQty` then differed between the two implementations of the same check, and
  // the SQL-shape assertion cannot see it because it compares query text, not results. Many
  // fractional KIT rows in one scope amplify the gap without limit.
  //
  // Rows are therefore collected first and filtered per BRANCH-scoped (product, warehouse) group,
  // where the branch is the UNION arm the SQL puts that row in — a scope dropped in one arm must
  // not silently remove a sibling counted in another. Rows that are exactly zero are still dropped
  // individually: they add nothing to either sum, so that costs no parity and keeps the breakdown
  // free of empty lines.
  type BranchedRow = { branch: string; productId: string; warehouseId: string; qty: Decimal; row: ReservationBreakdownRow }
  const branched: BranchedRow[] = []
  for (const allocation of allocations) {
    if (options.productId && allocation.productId !== options.productId) continue
    if (options.warehouseId && allocation.warehouseId !== options.warehouseId) continue

    const key = allocationKey(allocation.lineId, allocation.productId, allocation.warehouseId)
    const dispatched = dispatchedByAllocation.get(key) ?? ZERO
    // The LIVE reservation this row holds: whole claim minus what dispatch already gave back.
    const residual = positiveOrZero(toDecimal(allocation.qty).sub(dispatched))
    const zeroDemand = allocation.order.status === 'CANCELLED' || allocation.order.refundStatus === 'FULL'

    // o3d-4kfh: on a zero-demand order the row is credited ONLY for the part the warehouse is
    // still committed to (picked/packed but not yet dispatched). Anything above that is stale
    // outstanding quantity with no demand behind it — a genuine leak, correctly left to fall into
    // the unattributed bucket rather than being explained away.
    const committedResidual = positiveOrZero(
      (committedByAllocation.get(key) ?? ZERO).sub(dispatched),
    )
    const remaining = zeroDemand ? Prisma.Decimal.min(residual, committedResidual) : residual
    if (remaining.lte(ZERO)) continue

    const reference = allocation.order.orderNumber
      ?? allocation.order.externalOrderNumber
      ?? allocation.orderId
    const detail = allocation.line.sku ?? allocation.line.description
    branched.push({
      // The two sales-order UNION arms in the SQL: one for orders with outstanding demand, one for
      // the zero-demand orders it excludes.
      branch: zeroDemand ? 'sales_zero_demand' : 'sales_active',
      productId: allocation.productId,
      warehouseId: allocation.warehouseId,
      qty: remaining,
      row: {
        source: 'sales_order',
        productId: allocation.productId,
        warehouseId: allocation.warehouseId,
        referenceId: allocation.orderId,
        referenceLabel: sourceLabel(
          'SO',
          reference,
          zeroDemand
            ? `${detail} (committed shipment on ${allocation.order.status === 'CANCELLED' ? 'cancelled' : 'fully refunded'} order)`
            : detail,
        ),
        qty: decimalString(remaining),
        expectedDate: isoDate(allocation.order.expectedDelivery),
      },
    })
  }

  for (const order of productionOrders) {
    if (options.warehouseId && order.warehouseId !== options.warehouseId) continue
    if (order.orderType === 'ASSEMBLY') {
      for (const component of order.outputProduct.productComponents) {
        if (options.productId && component.componentId !== options.productId) continue
        const qty = toDecimal(order.qtyPlanned).mul(toDecimal(component.qty))
        if (qty.lte(ZERO)) continue
        branched.push({
          branch: 'production_assembly',
          productId: component.componentId,
          warehouseId: order.warehouseId,
          qty,
          row: {
            source: 'production_order',
            productId: component.componentId,
            warehouseId: order.warehouseId,
            referenceId: order.id,
            referenceLabel: sourceLabel('MO', order.reference, 'assembly component'),
            qty: decimalString(qty),
            expectedDate: isoDate(order.scheduledAt),
          },
        })
      }
    } else if (!options.productId || order.outputProductId === options.productId) {
      const qty = toDecimal(order.qtyPlanned)
      if (qty.lte(ZERO)) continue
      branched.push({
        branch: 'production_disassembly',
        productId: order.outputProductId,
        warehouseId: order.warehouseId,
        qty,
        row: {
          source: 'production_order',
          productId: order.outputProductId,
          warehouseId: order.warehouseId,
          referenceId: order.id,
          referenceLabel: sourceLabel('MO', order.reference, 'disassembly input'),
          qty: decimalString(qty),
          expectedDate: isoDate(order.scheduledAt),
        },
      })
    }
  }

  const branchTotals = new Map<string, Decimal>()
  for (const entry of branched) {
    const key = `${entry.branch}|${entry.productId}|${entry.warehouseId}`
    branchTotals.set(key, (branchTotals.get(key) ?? ZERO).add(entry.qty))
  }
  const rows = branched
    .filter((entry) => (
      (branchTotals.get(`${entry.branch}|${entry.productId}|${entry.warehouseId}`) ?? ZERO).gt(RESERVATION_EPSILON)
    ))
    .map((entry) => entry.row)

  return rows.sort((a, b) => {
    const sourceOrder = a.source.localeCompare(b.source)
    if (sourceOrder !== 0) return sourceOrder
    const referenceOrder = a.referenceLabel.localeCompare(b.referenceLabel)
    if (referenceOrder !== 0) return referenceOrder
    return a.productId.localeCompare(b.productId) || a.warehouseId.localeCompare(b.warehouseId)
  })
}

export async function getReservationBreakdown(params: {
  productId: string
  warehouseId: string
  includeUnattributed?: boolean
  client?: ReservationBreakdownClient
}): Promise<ReservationBreakdownResult> {
  const client = params.client ?? (db as unknown as ReservationBreakdownClient)
  const [stockLevel, knownRows] = await Promise.all([
    client.stockLevel.findUnique({
      where: {
        productId_warehouseId: {
          productId: params.productId,
          warehouseId: params.warehouseId,
        },
      },
      select: {
        reservedQty: true,
      },
    }),
    loadReservationSourceRows(client, {
      productId: params.productId,
      warehouseId: params.warehouseId,
    }),
  ])

  const stockLevelReservedQty = toDecimal(stockLevel?.reservedQty ?? 0)
  const knownReservedQty = knownRows.reduce(
    (sum, row) => sum.add(toDecimal(row.qty)),
    ZERO,
  )
  const unattributedQty = stockLevelReservedQty.sub(knownReservedQty)
  const rows = [...knownRows]

  if (params.includeUnattributed !== false && unattributedQty.abs().gt(RESERVATION_EPSILON)) {
    rows.push({
      source: 'other',
      productId: params.productId,
      warehouseId: params.warehouseId,
      referenceId: stockKey(params.productId, params.warehouseId),
      referenceLabel: 'Unattributed reserved balance',
      qty: decimalString(unattributedQty),
      expectedDate: null,
    })
  }

  return {
    productId: params.productId,
    warehouseId: params.warehouseId,
    generatedAt: new Date().toISOString(),
    stockLevelReservedQty: decimalString(stockLevelReservedQty),
    knownReservedQty: decimalString(knownReservedQty),
    unattributedQty: decimalString(unattributedQty),
    driftQty: decimalString(unattributedQty),
    rows,
  }
}
