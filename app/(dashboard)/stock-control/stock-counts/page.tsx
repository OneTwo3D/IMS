import type { Metadata } from 'next'
import { getWarehouses, getActiveAdjustmentReasons, getStockAdjustmentReasonCostRequired } from '@/app/actions/stock'
import { getStockCounts, getStockCountSmallVarianceThreshold } from '@/app/actions/stock-counts'
import { parseVarianceSort, parseVarianceTab } from '@/lib/domain/inventory/stock-count-triage'
import { StockCountsClient } from './stock-counts-client'

export const metadata: Metadata = { title: 'Stock Counts' }

type SearchParams = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function StockCountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const [counts, warehouses, reasons, threshold, reasonCostRequired] = await Promise.all([
    getStockCounts(),
    getWarehouses(),
    getActiveAdjustmentReasons(),
    getStockCountSmallVarianceThreshold(),
    getStockAdjustmentReasonCostRequired(),
  ])
  return (
    <StockCountsClient
      initialCounts={counts}
      warehouses={warehouses}
      reasons={reasons}
      smallVarianceThreshold={threshold}
      initialVarianceTab={parseVarianceTab(first(params.vtab))}
      initialVarianceSort={parseVarianceSort(first(params.vsort))}
      initialOpenCountId={first(params.count) ?? null}
      reasonCostRequired={reasonCostRequired}
    />
  )
}
