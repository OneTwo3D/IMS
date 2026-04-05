import type { Metadata } from 'next'
import { getSalesOrders } from '@/app/actions/sales'
import { listProducts } from '@/app/actions/products'
import { getWarehouses, getStockLevelMap, getAvgCogsMap } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getUsers } from '@/app/actions/settings'
import { getCustomers } from '@/app/actions/customers'
import { auth } from '@/lib/auth'
import { SalesPageClient } from './sales-page-client'

export const metadata: Metadata = { title: 'Sales Orders' }

export default async function SalesPage() {
  const [orders, { products }, warehouses, currencies, taxRates, customers, stockLevels, avgCogs, users, session] = await Promise.all([
    getSalesOrders(),
    listProducts({ pageSize: 1000, type: 'ALL' }),
    getWarehouses(),
    getCurrencies(true),
    getTaxRates(),
    getCustomers(),
    getStockLevelMap(),
    getAvgCogsMap(),
    getUsers(),
    auth(),
  ])

  const stockable = products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY', 'KIT'].includes(p.type),
  )

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
    />
  )
}
