import { Prisma } from '@/app/generated/prisma/client'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'

import { db } from '@/lib/db'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  loadTransferLineOutstandingQty,
  requireOutstandingQty,
  sumTransferLineOutstandingQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'

const OPEN_PO_STATUSES = INCOMING_PO_STATUSES
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
      // `id` so the landed quantity can be loaded for these exact lines (o3d-zzgp).
      select: { id: true, qty: true, qtyReceived: true },
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
      // `sourceType`/`sourceLineId` so an ASN row that MIRRORS a transfer line this
      // function is already counting can be told apart from one that stands alone
      // (o3d-zzgp).
      select: {
        sourceType: true,
        sourceLineId: true,
        expectedQty: true,
        qtyAccountedViaSnapshot: true,
        qtyAccountedViaReceipt: true,
      },
    }),
  ])

  const purchaseOrders = poLines.reduce(
    (sum, line) => sum.add(Prisma.Decimal.max(0, toDecimal(line.qty).minus(line.qtyReceived))),
    new Prisma.Decimal(0),
  )
  // o3d-zzgp. TWO defects in one expression, and fixing either alone leaves a wrong
  // number:
  //
  //  (a) `qty − qtyReceived` is not "outstanding". The WMS stock-sync alignment
  //      brings units in and lays their cost layers by crediting
  //      `wms_asn_line_maps.qtyAccountedViaSnapshot`; it never touches `qtyReceived`.
  //      A line landed entirely that way read as fully outstanding.
  //  (b) an in-transit transfer line with an open ASN was counted TWICE — once here
  //      and again in the `wmsAsn` arm below, which sums the SAME ASN rows.
  //
  // Fixing (a) alone would have halved the over-statement and left the double-count;
  // fixing (b) alone would have left a fully-aligned line reading as 100% incoming.
  // Both together give: the transfer line is the authority for every line whose
  // parent transfer is IN_TRANSIT, and its ASN rows are that line's mirror.
  const outstandingByTransferLineId = await loadTransferLineOutstandingQty(client, transferLines)
  const stockTransfers = sumTransferLineOutstandingQty(
    transferLines.map((line) => requireOutstandingQty(outstandingByTransferLineId, line.id)),
  )
  const productionOrders = productionRows.reduce(
    (sum, order) => sum.add(Prisma.Decimal.max(0, toDecimal(order.qtyPlanned).minus(order.qtyProduced))),
    new Prisma.Decimal(0),
  )
  // The ASN arm covers only what the arms above do NOT already speak for. An ASN row
  // whose source transfer line is in `transferLines` is a mirror of a quantity the
  // `stockTransfers` arm has just counted, so counting it again is the (b) above.
  //
  // The exclusion is keyed on the LINE BEING PRESENT, not on its outstanding quantity
  // being positive: a line that has fully landed while its sibling keeps the transfer
  // IN_TRANSIT contributes zero here AND zero there, which is right — its units have
  // arrived. Keying it on "outstanding > 0" would let the mirror row re-assert them.
  //
  // A row whose parent transfer is NOT in-transit (received, or cancelled with the
  // ASN left open) is not excluded, because no arm above counted it and it is then
  // the only evidence that something is still due in.
  //
  // DELIBERATELY NOT EXTENDED TO PURCHASE-ORDER ASN ROWS. The same double-count
  // exists between the `purchaseOrders` arm and PO-sourced ASN rows, and the same
  // alignment path credits `qtyAccountedViaSnapshot` without writing
  // `purchase_order_lines.qtyReceived` — but a PO line has no landed-quantity
  // definition to read yet, so correcting it needs its own module. Tracked separately
  // (o3d-zzgp follow-up); the asymmetry here is a scope boundary, not an oversight.
  const transferLineIdsCountedAbove = new Set(transferLines.map((line) => line.id))
  const wmsAsn = asnLines.reduce(
    (sum, line) => {
      if (line.sourceType === 'STOCK_TRANSFER_LINE' && transferLineIdsCountedAbove.has(line.sourceLineId)) {
        return sum
      }
      return sum.add(Prisma.Decimal.max(
        0,
        toDecimal(line.expectedQty)
          .minus(line.qtyAccountedViaSnapshot)
          .minus(line.qtyAccountedViaReceipt),
      ))
    },
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
