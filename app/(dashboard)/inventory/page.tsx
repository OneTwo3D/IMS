import type { Metadata } from 'next'
import { listProductCategories, listProducts, getVariableProducts } from '@/app/actions/products'
import type { SortField, SortDir } from '@/app/actions/products'
import { getStockUnitOptions } from '@/app/actions/settings'
import { ProductFilters } from './product-filters'
import { ProductTable } from '@/components/inventory/product-table'
import { InventoryHeader } from './inventory-header'
import type { ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'

export const metadata: Metadata = { title: 'Inventory' }

type SearchParams = {
  search?: string
  type?: string
  lifecycleStatus?: string
  categoryId?: string
  page?: string
  sort?: string
  dir?: string
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const page = parseInt(sp.page ?? '1')

  const [result, variableProducts, stockUnitOptions, categories] = await Promise.all([
    listProducts({
      search: sp.search,
      type: sp.type as ProductType | 'ALL' | undefined,
      lifecycleStatus: sp.lifecycleStatus as ProductLifecycleStatus | 'ALL' | undefined,
      categoryId: sp.categoryId,
      page,
      sort: (sp.sort as SortField) || undefined,
      dir: (sp.dir as SortDir) || undefined,
    }),
    getVariableProducts(),
    getStockUnitOptions(),
    listProductCategories(),
  ])

  return (
    <div className="space-y-4">
      <InventoryHeader total={result.total} variableProducts={variableProducts} stockUnitOptions={stockUnitOptions} productCategories={categories} />

      <ProductFilters
        search={sp.search}
        type={sp.type}
        lifecycleStatus={sp.lifecycleStatus ?? 'ALL'}
        categoryId={sp.categoryId}
        productCategories={categories}
      />

      <ProductTable
        products={result.products}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        searchParams={{ search: sp.search, type: sp.type, lifecycleStatus: sp.lifecycleStatus, categoryId: sp.categoryId, sort: sp.sort, dir: sp.dir }}
      />
    </div>
  )
}
