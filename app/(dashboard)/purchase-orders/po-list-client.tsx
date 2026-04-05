'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { PoRow, PoStatus } from '@/app/actions/purchase-orders'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChevronRight, Search } from 'lucide-react'

const STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  RFQ_SENT: 'RFQ Sent',
  PO_SENT: 'PO Sent',
  PARTIALLY_RECEIVED: 'Part. Received',
  RECEIVED: 'Received',
  INVOICED: 'Invoiced',
  PARTIALLY_RETURNED: 'Part. Returned',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}

const STATUS_CLASS: Record<PoStatus, string> = {
  DRAFT: 'text-muted-foreground',
  RFQ_SENT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-200',
  PO_SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-blue-200',
  PARTIALLY_RECEIVED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RECEIVED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-200',
  INVOICED: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200',
  PARTIALLY_RETURNED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RETURNED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200',
  CANCELLED: 'text-destructive',
}

const ALL_STATUSES: PoStatus[] = ['DRAFT', 'RFQ_SENT', 'PO_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']

type SecondaryFilter = 'INVOICED' | 'RETURNED'

type Props = { initialPos: PoRow[]; currencySymbols?: Record<string, string> }

export function PoListClient({ initialPos, currencySymbols = {} }: Props) {
  const sym = (code: string) => currencySymbols[code] ?? (code === 'GBP' ? '£' : code)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PoStatus | 'ALL'>('ALL')
  const [invoicedFilter, setInvoicedFilter] = useState(false)
  const [returnedFilter, setReturnedFilter] = useState(false)

  const filtered = initialPos.filter((po) => {
    if (statusFilter !== 'ALL' && po.status !== statusFilter) return false
    if (invoicedFilter && !po.isInvoiced) return false
    if (returnedFilter && !(po.isPartiallyReturned || po.isFullyReturned)) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        po.reference.toLowerCase().includes(q) ||
        po.supplierName.toLowerCase().includes(q) ||
        (po.supplierRef ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search reference, supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            variant={statusFilter === 'ALL' ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setStatusFilter('ALL')}
          >
            All
          </Button>
          {ALL_STATUSES.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABELS[s]}
            </Button>
          ))}
          <span className="w-px h-5 bg-border mx-1" />
          <Button
            variant={invoicedFilter ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setInvoicedFilter((v) => !v)}
          >
            Invoiced
          </Button>
          <Button
            variant={returnedFilter ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setReturnedFilter((v) => !v)}
          >
            Returned
          </Button>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No purchase orders found.</p>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Reference</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Supplier</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Expected</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Lines</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((po) => (
                <tr key={po.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-2 font-mono text-xs font-medium">
                    <Link href={`/purchase-orders/${po.id}`} className="hover:underline">
                      {po.reference}
                    </Link>
                    {po.type === 'FREIGHT' && (
                      <span className="ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        LC
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{po.supplierName}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[po.status]}`}>
                        {STATUS_LABELS[po.status]}
                      </span>
                      {po.isInvoiced && po.status !== 'INVOICED' && (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200">
                          Invoiced
                        </span>
                      )}
                      {po.isPartiallyReturned && po.status !== 'PARTIALLY_RETURNED' && (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200">
                          Part. Returned
                        </span>
                      )}
                      {po.isFullyReturned && po.status !== 'RETURNED' && (
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200">
                          Returned
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="font-semibold">
                      {po.totalForeign.toFixed(2)}{sym(po.currency)}
                    </span>
                    {po.currency !== 'GBP' && (
                      <span className="text-muted-foreground text-xs font-normal ml-1">
                        (£{po.totalGbp.toFixed(2)})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {po.expectedDelivery
                      ? new Date(po.expectedDelivery).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {timeAgo(po.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{po.lineCount}</td>
                  <td className="px-3 py-2">
                    <Link href={`/purchase-orders/${po.id}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
