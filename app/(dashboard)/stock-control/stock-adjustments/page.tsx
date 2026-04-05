import type { Metadata } from 'next'
import { getWarehouses, getActiveAdjustmentReasons, getAdjustmentHistory } from '@/app/actions/stock'
import { listProducts } from '@/app/actions/products'
import { StockAdjustmentsClient } from './stock-adjustments-client'

export const metadata: Metadata = { title: 'Stock Control' }

export default async function StockControlPage() {
  const [warehouses, { products }, reasons, history] = await Promise.all([
    getWarehouses(),
    listProducts({ active: 'true', type: 'ALL', pageSize: 1000 }),
    getActiveAdjustmentReasons(),
    getAdjustmentHistory(),
  ])

  const stockable = products.filter(
    (p) => p.type !== 'VARIABLE' && p.type !== 'NON_INVENTORY' && p.type !== 'KIT'
  )

  return (
    <StockAdjustmentsClient
      warehouses={warehouses}
      products={stockable}
      reasons={reasons}
      history={history}
    />
  )
}
