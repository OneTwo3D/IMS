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
      reference: true,
      supplierId: true,
      supplier: { select: { name: true } },
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

  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM "products"
    WHERE id IN (${Prisma.join(productIds)})
    ORDER BY id ASC
    FOR UPDATE
  `)

  const changingProducts = await tx.product.findMany({
    where: {
      id: { in: productIds },
      preferredSupplierLocked: false,
      OR: [
        { preferredSupplierId: null },
        { preferredSupplierId: { not: po.supplierId } },
      ],
    },
    select: {
      id: true,
      sku: true,
      preferredSupplierId: true,
      preferredSupplier: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  })

  const sortedChangingProducts = [...changingProducts].sort((a, b) => a.id.localeCompare(b.id))

  if (sortedChangingProducts.length === 0) {
    return { productIds, updatedCount: 0 }
  }

  const result = await tx.product.updateMany({
    where: {
      id: { in: sortedChangingProducts.map((product) => product.id) },
      preferredSupplierLocked: false,
    },
    data: {
      preferredSupplierId: po.supplierId,
      preferredSupplierUpdatedAt: placedAt,
    },
  })

  await Promise.all(sortedChangingProducts.map((product) => tx.activityLog.create({
    data: {
      entityType: 'PRODUCT',
      entityId: product.id,
      action: 'preferred_supplier_changed',
      tag: 'inventory',
      level: 'INFO',
      description: `Preferred supplier for ${product.sku} changed by ${po.reference}: ${product.preferredSupplier?.name ?? 'none'} to ${po.supplier.name}`,
      metadata: {
        sku: product.sku,
        previousSupplierId: product.preferredSupplierId,
        previousSupplierName: product.preferredSupplier?.name ?? null,
        newSupplierId: po.supplierId,
        newSupplierName: po.supplier.name,
        triggeredByPoId: po.id,
        triggeredByPoReference: po.reference,
        placedAt: placedAt.toISOString(),
      },
    },
  })))

  return { productIds, updatedCount: result.count }
}
