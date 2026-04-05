'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProductForm } from '@/components/inventory/product-form'
import { createProduct } from '@/app/actions/products'

type VariableProduct = { id: string; sku: string; name: string }

type Props = {
  total: number
  variableProducts: VariableProduct[]
  stockUnitOptions: string[]
}

export function InventoryHeader({ total, variableProducts, stockUnitOptions }: Props) {
  const [showCreate, setShowCreate] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {total} product{total !== 1 ? 's' : ''}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Product
        </Button>
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
