import type { Metadata } from 'next'
import { getPaymentMatchingOverview } from '@/app/actions/payment-matching'
import { PaymentMatchingClient } from './payment-matching-client'

export const metadata: Metadata = { title: 'Payment matching' }

export const dynamic = 'force-dynamic'

export default async function PaymentMatchingPage() {
  const overview = await getPaymentMatchingOverview()
  return <PaymentMatchingClient overview={overview} />
}
