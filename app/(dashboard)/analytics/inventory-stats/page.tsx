import type { Metadata } from 'next'
import { getStockOnHand, getStockMovements, getStockAllocations, getReorderInventory } from '@/app/actions/inventory-stats'
import { getSavedViews } from '@/app/actions/sales-stats'
import { InventoryStatsClient } from './inventory-stats-client'

export const metadata: Metadata = { title: 'Inventory Report' }

export default async function InventoryStatsPage() {
  const [stockOnHand, movements, allocations, reorder, savedViews] = await Promise.all([
    getStockOnHand(),
    getStockMovements(),
    getStockAllocations(),
    getReorderInventory(),
    getSavedViews(),
  ])
  return <InventoryStatsClient stockOnHand={stockOnHand} movements={movements} allocations={allocations} reorder={reorder} savedViews={savedViews} />
}
