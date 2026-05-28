'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Download, Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { CsvImportButton } from '@/components/inventory/csv-import-button'
import { ProductForm } from '@/components/inventory/product-form'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { createProduct } from '@/app/actions/products'
import { importProductsCsv } from '@/app/actions/import'

type VariableProduct = { id: string; sku: string; name: string }
type ProductCategoryOption = { id: string; name: string; parentId: string | null }

type Props = {
  total: number
  variableProducts: VariableProduct[]
  stockUnitOptions: string[]
  productCategories: ProductCategoryOption[]
}

export function InventoryHeader({ total, variableProducts, stockUnitOptions, productCategories }: Props) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)

  return (
    <>
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {total} product{total !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          <a href="/api/export/products?template=1" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Download className="h-4 w-4 mr-1" />Template
          </a>
          <a href="/api/export/products" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Download className="h-4 w-4 mr-1" />Export CSV
          </a>
          <CsvImportButton label="Import CSV" action={importProductsCsv} onDone={() => router.refresh()} />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Product
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:hidden">
          <Button size="sm" onClick={() => setShowCreate(true)} className="w-full">
            <Plus className="h-4 w-4 mr-1" />
            Add Product
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" className="w-full" aria-label="CSV actions" />}
            >
              <Ellipsis className="h-4 w-4 mr-1" />
              CSV
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => window.location.assign('/api/export/products?template=1')}>
                <Download className="mr-2 h-4 w-4" />
                Template
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.location.assign('/api/export/products')}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </DropdownMenuItem>
              <div className="px-1 py-1">
                <CsvImportButton
                  label="Import CSV"
                  action={importProductsCsv}
                  onDone={() => router.refresh()}
                  compact
                />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {showCreate && (
        <ProductForm
          action={createProduct}
          variableProducts={variableProducts}
          stockUnitOptions={stockUnitOptions}
          productCategories={productCategories}
          onClose={() => setShowCreate(false)}
          title="New Product"
        />
      )}
    </>
  )
}
