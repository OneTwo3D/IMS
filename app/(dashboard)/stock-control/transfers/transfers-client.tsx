'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CsvBar } from '@/components/ui/csv-bar'
import { importTransfersCsv } from '@/app/actions/import'
import type { MintsoftTransferAsnState } from '@/app/actions/mintsoft-sync'
import { TransferFormDialog } from './transfer-form'
import { TransferList } from './transfer-list'
import type { TransferRow } from '@/app/actions/transfers'
import type { ProductRow } from '@/app/actions/products'
import type { StockLevelEntry } from '@/lib/domain/inventory/stock-level-map'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  warehouses: Warehouse[]
  products: ProductRow[]
  initialTransfers: TransferRow[]
  mintsoftAsnStates: Record<string, MintsoftTransferAsnState>
  stockLevels: Record<string, Record<string, StockLevelEntry>>
}

export function TransfersClient({ warehouses, products, initialTransfers, mintsoftAsnStates, stockLevels }: Props) {
  const [transfers, setTransfers] = useState(initialTransfers)
  const [showCreate, setShowCreate] = useState(false)
  const warehouseCount = warehouses.length
  const canCreateTransfer = warehouseCount >= 2

  useEffect(() => {
    setTransfers(initialTransfers)
  }, [initialTransfers])

  function handleCreated(t: TransferRow) {
    setTransfers((prev) => [t, ...prev])
  }

  function handleUpdated(t: TransferRow) {
    setTransfers((prev) => prev.map((x) => (x.id === t.id ? t : x)))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <CsvBar exportUrl="/api/export/transfers" templateUrl="/api/export/transfers?template=1" importAction={importTransfersCsv} />
          <Button
            size="sm"
            onClick={() => setShowCreate(true)}
            disabled={!canCreateTransfer}
            title={!canCreateTransfer ? 'At least two active warehouses are required to create transfers.' : undefined}
          >
            <Plus className="h-4 w-4 mr-1" />
            New Transfer
          </Button>
        </div>
      </div>
      {!canCreateTransfer && (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">
            {warehouseCount === 0
              ? 'Warehouse transfers are unavailable because no warehouses are configured yet.'
              : 'Warehouse transfers require at least two active warehouses.'}{' '}
            <Link href="/settings/inventory" className="text-primary hover:underline">
              Configure warehouses in Inventory Settings
            </Link>
            .
          </p>
        </Card>
      )}
      <TransferList
        transfers={transfers}
        warehouses={warehouses}
        products={products}
        mintsoftAsnStates={mintsoftAsnStates}
        stockLevels={stockLevels}
        onTransferUpdated={handleUpdated}
      />
      {showCreate && canCreateTransfer && (
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
