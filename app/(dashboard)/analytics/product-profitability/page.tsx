import type { Metadata } from 'next'
import { requireOverviewAnalyticsAccess } from '@/lib/security/overview-analytics-page-access'
import { getProductProfitability } from '@/app/actions/product-profitability'
import { ProductProfitabilityClient } from './product-profitability-client'

export const metadata: Metadata = { title: 'Product Profitability' }

export default async function ProductProfitabilityPage() {
  await requireOverviewAnalyticsAccess()
  const data = await getProductProfitability()
  return <ProductProfitabilityClient data={data} />
}
