import type { Metadata } from 'next'
import { getProductSalesStats, getShipments, getInvoiceStats, getRefundStats, getCustomerAging, getSavedViews } from '@/app/actions/sales-stats'
import { SalesStatsClient } from './sales-stats-client'

export const metadata: Metadata = { title: 'Sales Statistics' }

export default async function SalesStatsPage() {
  const [productStats, shipments, invoices, refunds, aging, savedViews] = await Promise.all([
    getProductSalesStats(),
    getShipments(),
    getInvoiceStats(),
    getRefundStats(),
    getCustomerAging(),
    getSavedViews(),
  ])

  return (
    <SalesStatsClient
      productStats={productStats}
      shipments={shipments}
      invoices={invoices}
      refunds={refunds}
      aging={aging}
      savedViews={savedViews}
    />
  )
}
