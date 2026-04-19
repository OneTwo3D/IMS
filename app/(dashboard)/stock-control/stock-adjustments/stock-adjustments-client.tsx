'use client'

import { useState } from 'react'
import { ChevronDown, Download, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CsvBar } from '@/components/ui/csv-bar'
import { CsvImportButton } from '@/components/inventory/csv-import-button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { importAdjustmentsCsv, importOpeningStockCsv } from '@/app/actions/import'
import { BulkAdjustmentDialog } from '../bulk-adjustment-form'
import { AdjustmentHistory } from '../adjustment-history'
import type { ProductRow } from '@/app/actions/products'
import type { AdjustmentReasonOption, AdjustmentMovementRow } from '@/app/actions/stock'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  warehouses: Warehouse[]
  products: ProductRow[]
  reasons: AdjustmentReasonOption[]
  history: AdjustmentMovementRow[]
}

function buildStockLevelsExportUrl(selectedWarehouseIds: string[], includeBundles: boolean) {
  const params = new URLSearchParams()
  if (selectedWarehouseIds.length > 0) {
    params.set('warehouses', selectedWarehouseIds.join(','))
  }
  if (!includeBundles) {
    params.set('includeBundles', '0')
  }
  const query = params.toString()
  return `/api/export/stock-levels${query ? `?${query}` : ''}`
}

function StockLevelsExportMenu({ warehouses }: { warehouses: Warehouse[] }) {
  const allWarehouseIds = warehouses.map((warehouse) => warehouse.id)
  const [selectedWarehouseIds, setSelectedWarehouseIds] = useState<string[]>(allWarehouseIds)
  const [includeBundles, setIncludeBundles] = useState(true)

  function toggleWarehouse(warehouseId: string, checked: boolean) {
    setSelectedWarehouseIds((current) => {
      if (checked) {
        return current.includes(warehouseId) ? current : [...current, warehouseId]
      }
      return current.filter((id) => id !== warehouseId)
    })
  }

  function selectAllWarehouses() {
    setSelectedWarehouseIds(allWarehouseIds)
  }

  function clearWarehouseSelection() {
    setSelectedWarehouseIds([])
  }

  function downloadExport() {
    if (selectedWarehouseIds.length === 0) return
    window.location.assign(buildStockLevelsExportUrl(selectedWarehouseIds, includeBundles))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="h-8" aria-label="Stock levels export filters" />}
      >
        <Download className="h-4 w-4" />
        Stock Levels
        <ChevronDown className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Warehouses</DropdownMenuLabel>
        <DropdownMenuItem closeOnClick={false} onClick={selectAllWarehouses}>
          Select all
        </DropdownMenuItem>
        <DropdownMenuItem closeOnClick={false} onClick={clearWarehouseSelection}>
          Clear selection
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {warehouses.map((warehouse) => (
          <DropdownMenuCheckboxItem
            key={warehouse.id}
            checked={selectedWarehouseIds.includes(warehouse.id)}
            closeOnClick={false}
            onCheckedChange={(checked) => toggleWarehouse(warehouse.id, Boolean(checked))}
          >
            {warehouse.code} — {warehouse.name}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Options</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={includeBundles}
          closeOnClick={false}
          onCheckedChange={(checked) => setIncludeBundles(Boolean(checked))}
        >
          Include bundles
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={selectedWarehouseIds.length === 0} onClick={downloadExport}>
          <Download className="mr-2 h-4 w-4" />
          Download CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function StockAdjustmentsClient({ warehouses, products, reasons, history }: Props) {
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock Adjustments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Bulk inventory adjustments — enter quantities to add or remove per product
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CsvBar
            exportUrl="/api/export/adjustments"
            templateUrl="/api/export/adjustments?template=1"
            importAction={importAdjustmentsCsv}
          />
          <StockLevelsExportMenu warehouses={warehouses} />
          <CsvImportButton label="Import Opening Stock" action={importOpeningStockCsv} />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Adjustment
          </Button>
        </div>
      </div>
      <AdjustmentHistory initialRows={history} />
      {showCreate && (
        <BulkAdjustmentDialog
          warehouses={warehouses}
          products={products}
          reasons={reasons}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
