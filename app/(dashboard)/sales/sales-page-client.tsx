'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SoRow } from '@/app/actions/sales'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow } from '@/app/actions/settings'
import type { CustomerRow } from '@/app/actions/customers'
import type { StockLevelEntry } from '@/app/actions/stock'
import type { UserOption } from '@/app/actions/settings'
import { CsvBar } from '@/components/ui/csv-bar'
import { importSalesOrdersCsv } from '@/app/actions/import'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { SoListClient } from './so-list-client'
import { SoFormDialog } from './so-form'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  initialOrders: SoRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  customers: CustomerRow[]
  stockLevels: Record<string, Record<string, StockLevelEntry>>
  avgCogs: Record<string, number>
  users: UserOption[]
  currentUserName: string
  companyHomeCountry?: string | null
}

export function SalesPageClient({ initialOrders, products, warehouses, currencies, taxRates, customers, stockLevels, avgCogs, users, currentUserName, companyHomeCountry }: Props) {
  const baseCurrency = useBaseCurrency()
  const [showCreate, setShowCreate] = useState(false)

  const currencySymbols: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  for (const c of currencies) currencySymbols[c.code] = c.symbol

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sales Orders</h1>
        <div className="flex items-center gap-2">
          <CsvBar exportUrl="/api/export/sales" templateUrl="/api/export/sales?template=1" importAction={importSalesOrdersCsv} />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Order
          </Button>
        </div>
      </div>
      <SoListClient initialOrders={initialOrders} currencySymbols={currencySymbols} />
      {showCreate && (
        <SoFormDialog
          products={products}
          warehouses={warehouses}
          currencies={currencies}
          taxRates={taxRates}
          customers={customers}
          stockLevels={stockLevels}
          avgCogs={avgCogs}
          users={users}
          currentUserName={currentUserName}
          companyHomeCountry={companyHomeCountry}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
