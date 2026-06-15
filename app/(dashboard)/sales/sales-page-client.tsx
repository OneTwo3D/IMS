'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SoRow } from '@/app/actions/sales'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow } from '@/app/actions/settings'
import type { CustomerRow } from '@/app/actions/customers'
import type { StockLevelEntry } from '@/lib/domain/inventory/stock-level-map'
import type { UserOption } from '@/app/actions/settings'
import { CsvBar } from '@/components/ui/csv-bar'
import { importSalesOrdersCsv } from '@/app/actions/import'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { SoListClient } from './so-list-client'
import { SoFormDialog } from './so-form'

type Warehouse = { id: string; code: string; name: string; isDefault?: boolean }

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
  const currencyPositions: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) currencySymbols[c.code] = c.symbol
  for (const c of currencies) currencyPositions[c.code] = c.symbolPosition

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <CsvBar exportUrl="/api/export/sales" templateUrl="/api/export/sales?template=1" importAction={importSalesOrdersCsv} />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Order
          </Button>
        </div>
      </div>
      <SoListClient initialOrders={initialOrders} currencySymbols={currencySymbols} currencyPositions={currencyPositions} />
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
