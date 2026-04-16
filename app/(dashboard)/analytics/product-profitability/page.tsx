import type { Metadata } from 'next'
import { getProductProfitability } from '@/app/actions/product-profitability'
import { ProductProfitabilityClient } from './product-profitability-client'

export const metadata: Metadata = { title: 'Product Profitability' }

export default async function ProductProfitabilityPage() {
  const data = await getProductProfitability()
  return <ProductProfitabilityClient data={data} />
}
