import { Prisma } from '@/app/generated/prisma/client'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { toDecimal } from '@/lib/domain/math/decimal'

const OPEN_PO_STATUSES = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const
const OPEN_PRODUCTION_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const
const OPEN_WMS_ASN_STATUSES = ['CREATE_PENDING', 'CREATE_IN_FLIGHT', 'OPEN', 'PARTIALLY_BOOKED_IN'] as const

export type ProductIncomingStockBreakdown = {
  purchaseOrders: string
  stockTransfers: string
  productionOrders: string
  wmsAsn: string
  total: string
}

type ArchiveClient = typeof db | Prisma.TransactionClient

export async function getProductIncomingStock(
  productId: string,
  options: { client?: ArchiveClient } = {},
): Promise<ProductIncomingStockBreakdown> {
  const client = options.client ?? db
  const [poLines, transferLines, productionRows, asnLines] = await Promise.all([
    client.purchaseOrderLine.findMany({
      where: {
        productId,
        po: { type: 'GOODS', status: { in: [...OPEN_PO_STATUSES] } },
      },
      select: { qty: true, qtyReceived: true },
    }),
    client.stockTransferLine.findMany({
      where: {
        productId,
        transfer: { status: 'IN_TRANSIT' },
      },
      select: { qty: true, qtyReceived: true },
    }),
    client.productionOrder.findMany({
      where: {
        outputProductId: productId,
        status: { in: [...OPEN_PRODUCTION_STATUSES] },
      },
      select: { qtyPlanned: true, qtyProduced: true },
    }),
    client.wmsAsnLineMap.findMany({
      where: {
        productId,
        asn: { status: { in: [...OPEN_WMS_ASN_STATUSES] } },
      },
      select: { expectedQty: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
    }),
  ])

  const purchaseOrders = poLines.reduce(
    (sum, line) => sum.add(Prisma.Decimal.max(0, toDecimal(line.qty).minus(line.qtyReceived))),
    new Prisma.Decimal(0),
  )
  const stockTransfers = transferLines.reduce(
    (sum, line) => sum.add(Prisma.Decimal.max(0, toDecimal(line.qty).minus(line.qtyReceived))),
    new Prisma.Decimal(0),
  )
  const productionOrders = productionRows.reduce(
    (sum, order) => sum.add(Prisma.Decimal.max(0, toDecimal(order.qtyPlanned).minus(order.qtyProduced))),
    new Prisma.Decimal(0),
  )
  const wmsAsn = asnLines.reduce(
    (sum, line) => sum.add(Prisma.Decimal.max(
      0,
      toDecimal(line.expectedQty)
        .minus(line.qtyAccountedViaSnapshot)
        .minus(line.qtyAccountedViaReceipt),
    )),
    new Prisma.Decimal(0),
  )
  const total = purchaseOrders.add(stockTransfers).add(productionOrders).add(wmsAsn)

  return {
    purchaseOrders: purchaseOrders.toString(),
    stockTransfers: stockTransfers.toString(),
    productionOrders: productionOrders.toString(),
    wmsAsn: wmsAsn.toString(),
    total: total.toString(),
  }
}

export type ArchiveExhaustedEolProductsResult = {
  scanned: number
  archived: number
  skippedWithStock: number
  skippedWithIncoming: number
}

export async function archiveExhaustedEolProducts(
  options: { limit?: number; now?: Date } = {},
): Promise<ArchiveExhaustedEolProductsResult> {
  const now = options.now ?? new Date()
  const candidates = await db.product.findMany({
    where: { lifecycleStatus: 'EOL' },
    select: { id: true, sku: true, name: true },
    orderBy: { updatedAt: 'asc' },
    take: options.limit ?? 500,
  })

  const result: ArchiveExhaustedEolProductsResult = {
    scanned: candidates.length,
    archived: 0,
    skippedWithStock: 0,
    skippedWithIncoming: 0,
  }

  for (const candidate of candidates) {
    const archived = await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT id FROM "products" WHERE id = ${candidate.id} FOR UPDATE`)
      const product = await tx.product.findUnique({
        where: { id: candidate.id },
        select: {
          lifecycleStatus: true,
          stockLevels: { select: { quantity: true } },
        },
      })
      if (!product || product.lifecycleStatus !== 'EOL') return 'changed'

      const stockQty = product.stockLevels.reduce(
        (sum, level) => sum.add(level.quantity),
        new Prisma.Decimal(0),
      )
      if (stockQty.gt(0)) return 'stock'

      const incoming = await getProductIncomingStock(candidate.id, { client: tx })
      if (toDecimal(incoming.total).gt(0)) return 'incoming'

      await tx.product.update({
        where: { id: candidate.id },
        data: {
          active: false,
          lifecycleStatus: 'ARCHIVED',
          updatedAt: now,
        },
      })
      return { archived: true, incoming }
    })

    if (archived === 'stock') result.skippedWithStock++
    else if (archived === 'incoming') result.skippedWithIncoming++
    else if (typeof archived === 'object' && archived.archived) {
      result.archived++
      await logActivity({
        entityType: 'PRODUCT',
        entityId: candidate.id,
        action: 'archived',
        tag: 'inventory',
        level: 'INFO',
        description: `Archived exhausted EOL product ${candidate.sku}`,
        metadata: {
          sku: candidate.sku,
          name: candidate.name,
          previousStatus: 'EOL',
          newStatus: 'ARCHIVED',
          incoming: archived.incoming,
          triggeredBy: 'product-lifecycle-archive-cron',
        },
      })
    }
  }

  return result
}
