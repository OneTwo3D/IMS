import type { Metadata } from 'next'
import { requireOverviewAnalyticsAccess } from '@/lib/security/overview-analytics-page-access'
import { getProductSalesStats, getShipments, getDetails, getInvoiceStats, getRefundStats, getCustomerAging, getSavedViews } from '@/app/actions/sales-stats'
import { SalesStatsClient } from './sales-stats-client'

export const metadata: Metadata = { title: 'Sales Statistics' }

export default async function SalesStatsPage() {
  await requireOverviewAnalyticsAccess()
  const [productStats, shipments, details, invoices, refunds, aging, savedViews] = await Promise.all([
    getProductSalesStats(),
    getShipments(),
    getDetails(),
    getInvoiceStats(),
    getRefundStats(),
    getCustomerAging(),
    getSavedViews(),
  ])

  return (
    <SalesStatsClient
      productStats={productStats}
      shipments={shipments}
      details={details}
      invoices={invoices}
      refunds={refunds}
      aging={aging}
      savedViews={savedViews}
    />
  )
}
