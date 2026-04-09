import type { Metadata } from 'next'
import { listProducts, getVariableProducts } from '@/app/actions/products'
import type { SortField, SortDir } from '@/app/actions/products'
import { getStockUnitOptions } from '@/app/actions/settings'
import { ProductFilters } from './product-filters'
import { ProductTable } from '@/components/inventory/product-table'
import { InventoryHeader } from './inventory-header'
import type { ProductType } from '@/app/generated/prisma/client'

export const metadata: Metadata = { title: 'Inventory' }

type SearchParams = {
  search?: string
  type?: string
  active?: string
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

  const [result, variableProducts, stockUnitOptions] = await Promise.all([
    listProducts({
      search: sp.search,
      type: sp.type as ProductType | 'ALL' | undefined,
      active: sp.active as 'true' | 'false' | 'all' | undefined,
      page,
      sort: (sp.sort as SortField) || undefined,
      dir: (sp.dir as SortDir) || undefined,
    }),
    getVariableProducts(),
    getStockUnitOptions(),
  ])

  return (
    <div className="space-y-4">
      <InventoryHeader total={result.total} variableProducts={variableProducts} stockUnitOptions={stockUnitOptions} />

      <ProductFilters
        search={sp.search}
        type={sp.type}
        active={sp.active}
      />

      <ProductTable
        products={result.products}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        searchParams={{ search: sp.search, type: sp.type, active: sp.active, sort: sp.sort, dir: sp.dir }}
      />
    </div>
  )
}
