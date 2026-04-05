'use client'

import { useState } from 'react'
import { Plus, Ship } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PoRow } from '@/app/actions/purchase-orders'
import type { SupplierRow } from '@/app/actions/suppliers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, PurchaseUnitRow } from '@/app/actions/settings'
import { CsvBar } from '@/components/ui/csv-bar'
import { importPurchaseOrdersCsv } from '@/app/actions/import'
import { PoListClient } from './po-list-client'
import { PoFormDialog } from './po-form'
import { FreightPoDialog } from './freight-po-form'

type Warehouse = { id: string; code: string; name: string }
type GoodsPo = { id: string; reference: string; supplierName: string; totalForeign: number; currency: string }

type Props = {
  initialPos: PoRow[]
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  purchaseUnits: PurchaseUnitRow[]
  goodsPos: GoodsPo[]
}

export function PurchaseOrdersClient({ initialPos, suppliers, products, warehouses, currencies, taxRates, purchaseUnits, goodsPos }: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [showFreight, setShowFreight] = useState(false)

  const currencySymbols: Record<string, string> = { GBP: '£' }
  for (const c of currencies) currencySymbols[c.code] = c.symbol

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFreight(true)}>
            <Ship className="h-4 w-4 mr-1" />
            Landed Cost PO
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New PO
          </Button>
        </div>
      </div>
      <CsvBar exportUrl="/api/export/purchase-orders" templateUrl="/api/export/purchase-orders?template=1" importAction={importPurchaseOrdersCsv} />
      <PoListClient initialPos={initialPos} currencySymbols={currencySymbols} />
      {showCreate && (
        <PoFormDialog
          suppliers={suppliers}
          products={products}
          warehouses={warehouses}
          currencies={currencies}
          taxRates={taxRates}
          purchaseUnits={purchaseUnits}
          onClose={() => setShowCreate(false)}
        />
      )}
      {showFreight && (
        <FreightPoDialog
          suppliers={suppliers}
          currencies={currencies}
          taxRates={taxRates}
          goodsPos={goodsPos}
          onClose={() => setShowFreight(false)}
        />
      )}
    </div>
  )
}
