'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CsvBar } from '@/components/ui/csv-bar'
import { importAdjustmentsCsv } from '@/app/actions/import'
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
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Adjustment
        </Button>
      </div>
      <CsvBar
        exportUrl="/api/export/adjustments"
        templateUrl="/api/export/adjustments?template=1"
        importAction={importAdjustmentsCsv}
        extraButtons={
          <a href="/api/export/stock-levels" className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-muted transition-colors">
            Stock Levels
          </a>
        }
      />
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
