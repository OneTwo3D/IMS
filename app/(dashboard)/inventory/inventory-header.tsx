'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { CsvImportButton } from '@/components/inventory/csv-import-button'
import { ProductForm } from '@/components/inventory/product-form'
import { createProduct } from '@/app/actions/products'
import { importProductsCsv } from '@/app/actions/import'

type VariableProduct = { id: string; sku: string; name: string }

type Props = {
  total: number
  variableProducts: VariableProduct[]
  stockUnitOptions: string[]
}

export function InventoryHeader({ total, variableProducts, stockUnitOptions }: Props) {
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

          <CsvImportButton
            label="Import CSV"
            action={importProductsCsv}
            onDone={() => router.refresh()}
            compact
          />

          <a
            href="/api/export/products?template=1"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-full' })}
          >
            <Download className="h-4 w-4 mr-1" />Template
          </a>

          <a
            href="/api/export/products"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-full' })}
          >
            <Download className="h-4 w-4 mr-1" />Export CSV
          </a>
        </div>
      </div>
      {showCreate && (
        <ProductForm
          action={createProduct}
          variableProducts={variableProducts}
          stockUnitOptions={stockUnitOptions}
          onClose={() => setShowCreate(false)}
          title="New Product"
        />
      )}
    </>
  )
}
