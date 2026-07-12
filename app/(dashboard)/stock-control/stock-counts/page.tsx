import type { Metadata } from 'next'
import { getWarehouses, getActiveAdjustmentReasons } from '@/app/actions/stock'
import { getStockCounts } from '@/app/actions/stock-counts'
import { StockCountsClient } from './stock-counts-client'

export const metadata: Metadata = { title: 'Stock Counts' }

export default async function StockCountsPage() {
  const [counts, warehouses, reasons] = await Promise.all([
    getStockCounts(),
    getWarehouses(),
    getActiveAdjustmentReasons(),
  ])
  return <StockCountsClient initialCounts={counts} warehouses={warehouses} reasons={reasons} />
}
