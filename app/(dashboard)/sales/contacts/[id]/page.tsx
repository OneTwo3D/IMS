import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { authorizePage } from '@/lib/auth/server'
import { AccessDenied } from '@/components/auth/access-denied'
import { getCustomerDetail } from '@/app/actions/customers'
import { getCustomerIdentity, getCustomerTimeline } from '@/app/actions/customer-identity'
import { CustomerDetailClient } from './customer-detail-client'
import { CustomerIdentityPanel } from './customer-identity-panel'
import { CustomerTimeline } from './customer-timeline'

export const metadata: Metadata = { title: 'Customer Detail' }

type Props = { params: Promise<{ id: string }> }

export default async function CustomerDetailPage({ params }: Props) {
  // Every sales user may open the customer page (the identity, company group and timeline sections included); merge and unmerge are gated again, by role, in their actions.
  const gate = await authorizePage('sales')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />
  const { id } = await params
  const customer = await getCustomerDetail(id)
  if (!customer) notFound()
  const [identity, timeline] = await Promise.all([getCustomerIdentity(id), getCustomerTimeline(id)])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/sales/contacts" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold">{customer.fullName}</h1>
      </div>
      <CustomerDetailClient customer={customer} clusterMembers={(identity?.members ?? []).filter((m) => !m.anonymised).map((m) => ({ id: m.id, fullName: m.fullName, email: m.email }))} />
      {identity && <CustomerIdentityPanel identity={identity} />}
      {timeline && <CustomerTimeline customerId={id} initial={timeline} showPersonScope={(identity?.members.length ?? 1) > 1} />}
    </div>
  )
}
