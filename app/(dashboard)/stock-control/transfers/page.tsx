import type { Metadata } from 'next'
import { getWarehouses, getStockLevelMap } from '@/app/actions/stock'
import { listProducts } from '@/app/actions/products'
import { getTransfers } from '@/app/actions/transfers'
import { TransfersClient } from './transfers-client'

export const metadata: Metadata = { title: 'Warehouse Transfers' }

export default async function WarehouseTransfersPage() {
  const [warehouses, { products }, transfers, stockLevels] = await Promise.all([
    getWarehouses(),
    listProducts({ active: 'true', type: 'ALL', pageSize: 1000 }),
    getTransfers(),
    getStockLevelMap(),
  ])

  const stockable = products.filter(
    (p) => p.type !== 'VARIABLE' && p.type !== 'NON_INVENTORY' && p.type !== 'KIT'
  )

  return (
    <TransfersClient
      warehouses={warehouses}
      products={stockable}
      initialTransfers={transfers}
      stockLevels={stockLevels}
    />
  )
}
