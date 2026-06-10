import { Prisma } from '@/app/generated/prisma/client'

import { db } from '@/lib/db'
import { toDecimal } from '@/lib/domain/math/decimal'

const OPEN_PO_STATUSES = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const
const OPEN_PRODUCTION_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const
// Only WMS-confirmed ASNs count as incoming stock. Pre-confirmation create states
// can dead-letter indefinitely and should not block EOL auto-archive forever.
const OPEN_WMS_ASN_STATUSES = ['OPEN', 'PARTIALLY_BOOKED_IN'] as const

export type ProductIncomingStockBreakdown = {
  purchaseOrders: string
  stockTransfers: string
  productionOrders: string
  wmsAsn: string
  total: string
}

type ArchiveClient = typeof db | Prisma.TransactionClient
type ArchiveRootClient = Pick<typeof db, 'product' | '$transaction'>
type ArchiveCandidate = {
  id: string
  sku: string
  name: string
}

function emptyIncomingStockBreakdown(): Record<keyof ProductIncomingStockBreakdown, Prisma.Decimal> {
  return {
    purchaseOrders: new Prisma.Decimal(0),
    stockTransfers: new Prisma.Decimal(0),
    productionOrders: new Prisma.Decimal(0),
    wmsAsn: new Prisma.Decimal(0),
    total: new Prisma.Decimal(0),
  }
}

function stringifyIncomingStockBreakdown(
  breakdown: Record<keyof ProductIncomingStockBreakdown, Prisma.Decimal>,
): ProductIncomingStockBreakdown {
  return {
    purchaseOrders: breakdown.purchaseOrders.toString(),
    stockTransfers: breakdown.stockTransfers.toString(),
    productionOrders: breakdown.productionOrders.toString(),
    wmsAsn: breakdown.wmsAsn.toString(),
    total: breakdown.total.toString(),
  }
}

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

async function getProductFamilyIncomingStock(
  productIds: string[],
  options: { client: ArchiveClient },
): Promise<ProductIncomingStockBreakdown> {
  const totals = emptyIncomingStockBreakdown()

  for (const productId of productIds) {
    const incoming = await getProductIncomingStock(productId, options)
    totals.purchaseOrders = totals.purchaseOrders.add(incoming.purchaseOrders)
    totals.stockTransfers = totals.stockTransfers.add(incoming.stockTransfers)
    totals.productionOrders = totals.productionOrders.add(incoming.productionOrders)
    totals.wmsAsn = totals.wmsAsn.add(incoming.wmsAsn)
    totals.total = totals.total.add(incoming.total)
  }

  return stringifyIncomingStockBreakdown(totals)
}

export type ArchiveExhaustedEolProductsResult = {
  scanned: number
  archived: number
  skippedWithStock: number
  skippedWithIncoming: number
}

export async function archiveExhaustedEolProducts(
  options: { batchSize?: number; limit?: number; now?: Date; client?: ArchiveRootClient } = {},
): Promise<ArchiveExhaustedEolProductsResult> {
  const now = options.now ?? new Date()
  const client = options.client ?? db
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? options.limit ?? 500))
  const result: ArchiveExhaustedEolProductsResult = {
    scanned: 0,
    archived: 0,
    skippedWithStock: 0,
    skippedWithIncoming: 0,
  }
  let lastSeenId: string | null = null

  for (;;) {
    const candidates: ArchiveCandidate[] = await client.product.findMany({
      where: {
        lifecycleStatus: 'EOL',
        ...(lastSeenId ? { id: { gt: lastSeenId } } : {}),
      },
      select: { id: true, sku: true, name: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })
    if (candidates.length === 0) break

    for (const candidate of candidates) {
      lastSeenId = candidate.id
      result.scanned++

      const archived = await client.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "products" WHERE id = ${candidate.id} FOR UPDATE`)
        const product = await tx.product.findUnique({
          where: { id: candidate.id },
          select: {
            lifecycleStatus: true,
            type: true,
            stockLevels: { select: { quantity: true } },
            variants: {
              select: {
                id: true,
                stockLevels: { select: { quantity: true } },
              },
            },
          },
        })
        if (!product || product.lifecycleStatus !== 'EOL') return 'changed'

        const ownStockQty = product.stockLevels.reduce(
          (sum, level) => sum.add(level.quantity),
          new Prisma.Decimal(0),
        )
        const variantStockQty = product.type === 'VARIABLE'
          ? product.variants.reduce(
              (sum, variant) => sum.add(variant.stockLevels.reduce(
                (variantSum, level) => variantSum.add(level.quantity),
                new Prisma.Decimal(0),
              )),
              new Prisma.Decimal(0),
            )
          : new Prisma.Decimal(0)
        const stockQty = ownStockQty.add(variantStockQty)
        if (stockQty.gt(0)) return 'stock'

        const incomingProductIds = product.type === 'VARIABLE'
          ? [candidate.id, ...product.variants.map((variant) => variant.id)]
          : [candidate.id]
        const incoming = await getProductFamilyIncomingStock(incomingProductIds, { client: tx })
        if (toDecimal(incoming.total).gt(0)) return 'incoming'

        await tx.product.update({
          where: { id: candidate.id },
          data: {
            active: false,
            lifecycleStatus: 'ARCHIVED',
            updatedAt: now,
          },
        })
        await tx.activityLog.create({
          data: {
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
              incoming,
              triggeredBy: 'product-lifecycle-archive-cron',
            },
          },
        })
        return 'archived'
      })

      if (archived === 'stock') result.skippedWithStock++
      else if (archived === 'incoming') result.skippedWithIncoming++
      else if (archived === 'archived') result.archived++
    }
  }

  return result
}
