import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getCustomerDetail } from '@/app/actions/customers'
import { CustomerDetailClient } from './customer-detail-client'

export const metadata: Metadata = { title: 'Customer Detail' }

type Props = { params: Promise<{ id: string }> }

export default async function CustomerDetailPage({ params }: Props) {
  const { id } = await params
  const customer = await getCustomerDetail(id)
  if (!customer) notFound()

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/sales/contacts" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold">{customer.fullName}</h1>
      </div>
      <CustomerDetailClient customer={customer} />
    </div>
  )
}
