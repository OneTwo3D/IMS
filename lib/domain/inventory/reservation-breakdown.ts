import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

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
  const allocationWhere = {
    ...(options.productId ? { productId: options.productId } : {}),
    ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    qty: { gt: 0 },
    order: { status: { not: 'CANCELLED' }, refundStatus: { not: 'FULL' } },
  }
  const activeShipmentWhere = {
    ...(options.productId ? { productId: options.productId } : {}),
    shipment: {
      status: { not: 'PENDING' },
      ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
      order: { status: { not: 'CANCELLED' }, refundStatus: { not: 'FULL' } },
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

  const committedByAllocation = new Map<string, Decimal>()
  for (const shipmentLine of activeShipmentLines) {
    if (options.productId && shipmentLine.productId !== options.productId) continue
    if (options.warehouseId && shipmentLine.shipment.warehouseId !== options.warehouseId) continue
    const key = allocationKey(
      shipmentLine.lineId,
      shipmentLine.productId,
      shipmentLine.shipment.warehouseId,
    )
    committedByAllocation.set(
      key,
      (committedByAllocation.get(key) ?? ZERO).add(toDecimal(shipmentLine.qty)),
    )
  }

  const rows: ReservationBreakdownRow[] = []
  for (const allocation of allocations) {
    if (options.productId && allocation.productId !== options.productId) continue
    if (options.warehouseId && allocation.warehouseId !== options.warehouseId) continue
    if (allocation.order.status === 'CANCELLED' || allocation.order.refundStatus === 'FULL') continue

    const committed = committedByAllocation.get(
      allocationKey(allocation.lineId, allocation.productId, allocation.warehouseId),
    ) ?? ZERO
    const remaining = positiveOrZero(toDecimal(allocation.qty).sub(committed))
    if (remaining.lte(RESERVATION_EPSILON)) continue

    const reference = allocation.order.orderNumber
      ?? allocation.order.externalOrderNumber
      ?? allocation.orderId
    rows.push({
      source: 'sales_order',
      productId: allocation.productId,
      warehouseId: allocation.warehouseId,
      referenceId: allocation.orderId,
      referenceLabel: sourceLabel('SO', reference, allocation.line.sku ?? allocation.line.description),
      qty: decimalString(remaining),
      expectedDate: isoDate(allocation.order.expectedDelivery),
    })
  }

  for (const order of productionOrders) {
    if (options.warehouseId && order.warehouseId !== options.warehouseId) continue
    if (order.orderType === 'ASSEMBLY') {
      for (const component of order.outputProduct.productComponents) {
        if (options.productId && component.componentId !== options.productId) continue
        const qty = toDecimal(order.qtyPlanned).mul(toDecimal(component.qty))
        if (qty.lte(RESERVATION_EPSILON)) continue
        rows.push({
          source: 'production_order',
          productId: component.componentId,
          warehouseId: order.warehouseId,
          referenceId: order.id,
          referenceLabel: sourceLabel('MO', order.reference, 'assembly component'),
          qty: decimalString(qty),
          expectedDate: isoDate(order.scheduledAt),
        })
      }
    } else if (!options.productId || order.outputProductId === options.productId) {
      const qty = toDecimal(order.qtyPlanned)
      if (qty.lte(RESERVATION_EPSILON)) continue
      rows.push({
        source: 'production_order',
        productId: order.outputProductId,
        warehouseId: order.warehouseId,
        referenceId: order.id,
        referenceLabel: sourceLabel('MO', order.reference, 'disassembly input'),
        qty: decimalString(qty),
        expectedDate: isoDate(order.scheduledAt),
      })
    }
  }

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
