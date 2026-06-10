import type { Metadata } from 'next'
import { getSalesOrders } from '@/app/actions/sales'
import { listProducts } from '@/app/actions/products'
import { getWarehouses, getScopedStockLevelMap, getAvgCogsMap } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getUsers } from '@/app/actions/settings'
import { getCustomers } from '@/app/actions/customers'
import { getOrganisation } from '@/app/actions/company'
import { auth } from '@/lib/auth'
import { SalesPageClient } from './sales-page-client'

export const metadata: Metadata = { title: 'Sales Orders' }

export default async function SalesPage() {
  const [orders, { products }, warehouses, currencies, taxRates, customers, avgCogs, users, session, organisation] = await Promise.all([
    getSalesOrders(),
    listProducts({ pageSize: 1000, type: 'ALL', active: 'true' }),
    getWarehouses(),
    getCurrencies(true),
    getTaxRates(),
    getCustomers(),
    getAvgCogsMap(),
    getUsers(),
    auth(),
    getOrganisation(),
  ])

  const stockable = products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY'].includes(p.type) && (p.lifecycleStatus === 'ACTIVE' || p.lifecycleStatus === 'EOL'),
  )
  const stockLevels = await getScopedStockLevelMap({
    productIds: stockable.map((product) => product.id),
    warehouseIds: warehouses.map((warehouse) => warehouse.id),
  })

  return (
    <SalesPageClient
      initialOrders={orders}
      products={stockable}
      warehouses={warehouses}
      currencies={currencies}
      taxRates={taxRates}
      customers={customers}
      stockLevels={stockLevels}
      avgCogs={avgCogs}
      users={users}
      currentUserName={session?.user?.name ?? session?.user?.email ?? ''}
      companyHomeCountry={organisation.country}
    />
  )
}
