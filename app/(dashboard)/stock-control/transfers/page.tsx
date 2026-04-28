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
  const isStockableProduct = (product: { type: string }) => (
    product.type !== 'VARIABLE' && product.type !== 'NON_INVENTORY' && product.type !== 'KIT'
  )
  const stockable = products.filter(isStockableProduct)
  const productById = new Map(products.map((product) => [product.id, product]))
  const stockProductIds = Array.from(new Set([
    ...stockable.map((product) => product.id),
    ...transfers.flatMap((transfer) => transfer.lines.map((line) => line.productId))
      .filter((productId) => {
        const product = productById.get(productId)
        return !product || isStockableProduct(product)
      }),
  ]))
  const [mintsoftAsnStates, stockLevels] = await Promise.all([
    getMintsoftTransferAsnStates(transfers.map((transfer) => transfer.id)),
    getScopedStockLevelMap({
      productIds: stockProductIds,
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
