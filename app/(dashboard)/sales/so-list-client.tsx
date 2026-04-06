'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { SoRow, SoStatus } from '@/app/actions/sales'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChevronRight, Search } from 'lucide-react'

const STATUS_LABELS: Record<SoStatus, string> = {
  DRAFT: 'Draft',
  PENDING_PAYMENT: 'Pending Payment',
  ON_HOLD: 'On Hold',
  PROCESSING: 'Processing',
  ALLOCATED: 'Allocated',
  PICKING: 'Picking',
  PACKING: 'Packing',
  SHIPPED: 'Shipped',
  COMPLETED: 'Completed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Part. Refunded',
}

const STATUS_CLASS: Record<SoStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200',
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  ON_HOLD: 'bg-muted text-muted-foreground border-muted',
  PROCESSING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  ALLOCATED: 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900 dark:text-cyan-200',
  PICKING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PACKING: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200',
  COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  DELIVERED: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-200',
  CANCELLED: 'text-destructive border-destructive/30',
  REFUNDED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
}

const FILTER_STATUSES: SoStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED']

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

type Props = { initialOrders: SoRow[]; currencySymbols?: Record<string, string> }

export function SoListClient({ initialOrders, currencySymbols = {} }: Props) {
  const sym = (code: string) => currencySymbols[code] ?? (code === 'GBP' ? '£' : code)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<SoStatus | 'ALL'>('ALL')

  const filtered = initialOrders.filter((so) => {
    if (statusFilter !== 'ALL' && so.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (so.wcOrderNumber ?? '').toLowerCase().includes(q) ||
        (so.customerName ?? '').toLowerCase().includes(q) ||
        (so.customerEmail ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant={statusFilter === 'ALL' ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setStatusFilter('ALL')}>
            All
          </Button>
          {FILTER_STATUSES.map((s) => (
            <Button key={s} variant={statusFilter === s ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setStatusFilter(s)}>
              {STATUS_LABELS[s]}
            </Button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No sales orders found.</p>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Order</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Customer</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Warehouse</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Items</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((so) => (
                <tr key={so.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-2 font-mono text-xs font-medium">
                    <Link href={`/sales/${so.id}`} className="hover:underline">
                      {so.wcOrderNumber ?? so.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div>{so.customerName ?? '—'}</div>
                    {so.customerEmail && <div className="text-xs text-muted-foreground">{so.customerEmail}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[so.status]}`}>
                      {STATUS_LABELS[so.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="font-semibold">
                      {so.totalForeign.toFixed(2)}{sym(so.currency)}
                    </span>
                    {so.currency !== 'GBP' && (
                      <span className="text-muted-foreground text-xs font-normal ml-1">
                        (£{so.totalGbp.toFixed(2)})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{so.shipFromWarehouseName ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{timeAgo(so.createdAt)}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{so.lineCount}</td>
                  <td className="px-3 py-2">
                    <Link href={`/sales/${so.id}`}>
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
