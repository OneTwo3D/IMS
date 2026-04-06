import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/server'
import { getSupplierRfqDetail } from '@/app/actions/supplier-portal'
import { SupplierRfqClient } from './rfq-client'

export const metadata: Metadata = { title: 'RFQ Detail — Supplier Portal' }

type Props = { params: Promise<{ id: string }> }

export default async function SupplierRfqDetailPage({ params }: Props) {
  const session = await requireAuth()
  if (session.user.role !== 'SUPPLIER') redirect('/dashboard')

  const { id } = await params
  const data = await getSupplierRfqDetail(id)
  if (!data) notFound()

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-2">
        <Link href="/supplier/rfqs" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold font-mono">{data.po.reference}</h1>
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800">
          {data.po.status === 'RFQ_SENT' ? 'Awaiting Quote' : data.po.status}
        </span>
      </div>
      <SupplierRfqClient po={data.po} lines={data.lines} />
    </div>
  )
}
