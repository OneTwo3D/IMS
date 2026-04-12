'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CsvBar } from '@/components/ui/csv-bar'
import { importTransfersCsv } from '@/app/actions/import'
import { TransferFormDialog } from './transfer-form'
import { TransferList } from './transfer-list'
import type { TransferRow } from '@/app/actions/transfers'
import type { ProductRow } from '@/app/actions/products'
import type { StockLevelEntry } from '@/app/actions/stock'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  warehouses: Warehouse[]
  products: ProductRow[]
  initialTransfers: TransferRow[]
  stockLevels: Record<string, Record<string, StockLevelEntry>>
}

export function TransfersClient({ warehouses, products, initialTransfers, stockLevels }: Props) {
  const [transfers, setTransfers] = useState(initialTransfers)
  const [showCreate, setShowCreate] = useState(false)

  function handleCreated(t: TransferRow) {
    setTransfers((prev) => [t, ...prev])
  }

  function handleUpdated(t: TransferRow) {
    setTransfers((prev) => prev.map((x) => (x.id === t.id ? t : x)))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Warehouse Transfers</h1>
        <div className="flex items-center gap-2">
          <CsvBar exportUrl="/api/export/transfers" templateUrl="/api/export/transfers?template=1" importAction={importTransfersCsv} />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Transfer
          </Button>
        </div>
      </div>
      <TransferList
        transfers={transfers}
        warehouses={warehouses}
        products={products}
        stockLevels={stockLevels}
        onTransferUpdated={handleUpdated}
      />
      {showCreate && (
        <TransferFormDialog
          warehouses={warehouses}
          products={products}
          stockLevels={stockLevels}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
