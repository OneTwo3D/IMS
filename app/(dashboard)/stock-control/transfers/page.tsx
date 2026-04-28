import type { Metadata } from 'next'
import { getMintsoftTransferAsnStates } from '@/app/actions/mintsoft-sync'
import { getWarehouses, getScopedStockLevelMap } from '@/app/actions/stock'
import { listProducts } from '@/app/actions/products'
import { getTransfers } from '@/app/actions/transfers'
import { TransfersClient } from './transfers-client'

export const metadata: Metadata = { title: 'Warehouse Transfers' }

export default async function WarehouseTransfersPage() {
  const [warehouses, { products }, transfers] = await Promise.all([
    getWarehouses(),
    listProducts({ active: 'true', type: 'ALL', pageSize: 1000 }),
    getTransfers(),
  ])
  const stockable = products.filter(
    (p) => p.type !== 'VARIABLE' && p.type !== 'NON_INVENTORY' && p.type !== 'KIT'
  )
  const [mintsoftAsnStates, stockLevels] = await Promise.all([
    getMintsoftTransferAsnStates(transfers.map((transfer) => transfer.id)),
    getScopedStockLevelMap({
      productIds: stockable.map((product) => product.id),
      warehouseIds: warehouses.map((warehouse) => warehouse.id),
    }),
  ])

  return (
    <TransfersClient
      warehouses={warehouses}
      products={stockable}
      initialTransfers={transfers}
      mintsoftAsnStates={mintsoftAsnStates}
      stockLevels={stockLevels}
    />
  )
}
