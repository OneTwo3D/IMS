import type { Metadata } from 'next'
import { getPurchaseProductStats, getReceivedGoods, getPurchaseBills, getSupplierAging, getPurchaseDetails } from '@/app/actions/purchase-stats'
import { getSavedViews } from '@/app/actions/sales-stats'
import { PurchaseStatsClient } from './purchase-stats-client'

export const metadata: Metadata = { title: 'Purchase Statistics' }

export default async function PurchaseStatsPage() {
  const [products, received, bills, aging, details, savedViews] = await Promise.all([
    getPurchaseProductStats(),
    getReceivedGoods(),
    getPurchaseBills(),
    getSupplierAging(),
    getPurchaseDetails(),
    getSavedViews(),
  ])
  return <PurchaseStatsClient products={products} received={received} bills={bills} aging={aging} details={details} savedViews={savedViews} />
}
