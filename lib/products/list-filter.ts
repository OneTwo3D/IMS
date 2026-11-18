import type { Prisma, ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import { COMPONENT_PRODUCT_STATUSES } from '@/lib/products/lifecycle'

/**
 * The filter the product list applies, as one pure builder, so the list and the "Edit by CSV" selection ("all products
 * matching the current filter") can never disagree about which rows a filter means. Kept out of the 'use server' action
 * file, which may only export async functions.
 */
export type ProductListFilter = {
  search?: string
  type?: ProductType | 'ALL'
  active?: 'true' | 'false' | 'all'
  lifecycleStatus?: ProductLifecycleStatus | 'ALL'
  categoryId?: string
  supplierId?: string
}

export function buildProductListWhere(params: ProductListFilter): Prisma.ProductWhereInput {
  return {
    ...(params.search
      ? {
          OR: [
            { sku: { contains: params.search, mode: 'insensitive' as const } },
            { name: { contains: params.search, mode: 'insensitive' as const } },
            { barcode: { contains: params.search, mode: 'insensitive' as const } },
            { mpn: { contains: params.search, mode: 'insensitive' as const } },
            { variants: { some: { sku: { contains: params.search, mode: 'insensitive' as const } } } },
            { variants: { some: { mpn: { contains: params.search, mode: 'insensitive' as const } } } },
          ],
        }
      : {}),
    // By default exclude VARIANT products; pass type='ALL' to include everything
    ...(params.type === 'ALL'
      ? {}
      : params.type
      ? { type: params.type as ProductType }
      : { parentId: null }),
    ...(params.lifecycleStatus && params.lifecycleStatus !== 'ALL'
      ? { lifecycleStatus: params.lifecycleStatus }
      : params.active === 'true'
      ? { lifecycleStatus: { in: COMPONENT_PRODUCT_STATUSES } }
      : params.active === 'false'
      ? { lifecycleStatus: 'ARCHIVED' as const }
      : {}),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.supplierId ? { preferredSupplierId: params.supplierId } : {}),
  }
}
