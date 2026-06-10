import { Prisma } from '@/app/generated/prisma/client'

export type PreferredSupplierUpdateResult = {
  productIds: string[]
  updatedCount: number
}

export async function updatePreferredSuppliersForPlacedPurchaseOrder(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  placedAt: Date,
): Promise<PreferredSupplierUpdateResult> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: {
      id: true,
      supplierId: true,
      type: true,
      skipPreferredSupplierUpdate: true,
      lines: { select: { productId: true } },
    },
  })

  if (!po || po.type !== 'GOODS' || po.skipPreferredSupplierUpdate) {
    return { productIds: [], updatedCount: 0 }
  }

  const productIds = Array.from(new Set(po.lines.map((line) => line.productId))).sort()
  if (productIds.length === 0) {
    return { productIds: [], updatedCount: 0 }
  }

  await tx.$executeRaw(Prisma.sql`
    SELECT id
    FROM "products"
    WHERE id IN (${Prisma.join(productIds)})
    ORDER BY id ASC
    FOR UPDATE
  `)

  const result = await tx.product.updateMany({
    where: {
      id: { in: productIds },
      preferredSupplierLocked: false,
    },
    data: {
      preferredSupplierId: po.supplierId,
      preferredSupplierUpdatedAt: placedAt,
    },
  })

  return { productIds, updatedCount: result.count }
}
