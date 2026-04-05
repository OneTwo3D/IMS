'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Download, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProductLink } from '@/components/inventory/product-link'
import type {
  SalesStatRow, SalesStatSummary,
  ShipmentRow, InvoiceRow, RefundRow, CustomerAgingRow,
} from '@/app/actions/sales-stats'

type Tab = 'products' | 'shipments' | 'invoices' | 'refunds' | 'aging'

type Props = {
  productStats: { rows: SalesStatRow[]; summary: SalesStatSummary }
  shipments: ShipmentRow[]
  invoices: InvoiceRow[]
  refunds: RefundRow[]
  aging: CustomerAgingRow[]
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'aging', label: 'Customer Aging' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

export function SalesStatsClient({ productStats, shipments, invoices, refunds, aging }: Props) {
  const [tab, setTab] = useState<Tab>('products')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const q = search.toLowerCase()
  const { rows, summary } = productStats

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sales Statistics</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-3">
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Net Revenue</p>
          <p className="text-xl font-bold">{fmtGbp(summary.totalNetRevenue)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">COGS</p>
          <p className="text-xl font-bold">{fmtGbp(summary.totalCogs)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Gross Profit</p>
          <p className="text-xl font-bold text-green-600">{fmtGbp(summary.totalGrossProfit)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Avg Margin</p>
          <p className="text-xl font-bold">{summary.avgMarginPct}%</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Orders / Qty</p>
          <p className="text-xl font-bold">{summary.totalOrders} / {summary.totalQtySold}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.key} type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 text-xs pl-7 w-48" />
          </div>
        </div>
      </div>

      {/* Tab content */}
      {tab === 'products' && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Sold</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Refunded</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Net Qty</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Gross Rev</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Discounts</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Refunds</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Net Revenue</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">COGS</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Profit</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Margin</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Orders</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.filter((r) => !q || r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)).map((r) => (
                <tr key={r.productId} className="hover:bg-muted/30">
                  <td className="px-3 py-2"><ProductLink productId={r.productId} sku={r.sku} name={r.name} /></td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">{r.qtySold}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-orange-600">{r.qtyRefunded > 0 ? r.qtyRefunded : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">{r.netQty}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(r.grossRevenue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-destructive">{r.discounts > 0 ? fmtGbp(r.discounts) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-orange-600">{r.refunds > 0 ? fmtGbp(r.refunds) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono font-medium">{fmtGbp(r.netRevenue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{r.cogs > 0 ? fmtGbp(r.cogs) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={r.grossProfit >= 0 ? 'text-green-600' : 'text-destructive'}>{fmtGbp(r.grossProfit)}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={r.marginPct >= 0 ? '' : 'text-destructive'}>{r.marginPct}%</span></td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{r.orderCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30 text-sm font-medium">
              <tr>
                <td className="px-3 py-2">Totals</td>
                <td className="px-3 py-2 text-right tabular-nums">{summary.totalQtySold}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums font-mono">{fmtGbp(summary.totalGrossRevenue)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-destructive">{fmtGbp(summary.totalDiscounts)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-orange-600">{fmtGbp(summary.totalRefunds)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono">{fmtGbp(summary.totalNetRevenue)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-muted-foreground">{fmtGbp(summary.totalCogs)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-green-600">{fmtGbp(summary.totalGrossProfit)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{summary.avgMarginPct}%</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{summary.totalOrders}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {tab === 'shipments' && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Shipped</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Service</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Tracking</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Warehouse</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Items</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shipments.filter((s) => !q || s.orderNumber.toLowerCase().includes(q) || s.customerName.toLowerCase().includes(q)).map((s) => (
                <tr key={s.orderId} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${s.orderId}`} className="hover:underline">{s.orderNumber}</Link></td>
                  <td className="px-3 py-2 text-xs">{s.customerName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(s.shippedAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{s.shippingService ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{s.trackingNumber ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{s.warehouse ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">{s.lineCount}</td>
                  <td className="px-3 py-2 text-right text-xs font-mono">{fmtGbp(s.totalGbp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shipments.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No shipments found.</p>}
        </div>
      )}

      {tab === 'invoices' && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Paid</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {invoices.filter((i) => !q || i.invoiceNumber.toLowerCase().includes(q) || i.customerName.toLowerCase().includes(q)).map((i) => (
                <tr key={i.orderId} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs font-medium">{i.invoiceNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${i.orderId}`} className="hover:underline">{i.orderNumber}</Link></td>
                  <td className="px-3 py-2 text-xs">{i.customerName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(i.invoicedAt)}</td>
                  <td className="px-3 py-2 text-right text-xs font-mono">{fmtGbp(i.totalGbp)}</td>
                  <td className="px-3 py-2 text-xs">{i.paidAt ? <span className="text-green-600">{fmtDate(i.paidAt)}</span> : <span className="text-orange-600">Unpaid</span>}</td>
                  <td className="px-3 py-2 text-right text-xs font-mono"><span className={i.balance > 0.01 ? 'text-destructive font-medium' : 'text-green-600'}>{i.balance > 0.01 ? fmtGbp(i.balance) : 'Settled'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {invoices.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No invoices found.</p>}
        </div>
      )}

      {tab === 'refunds' && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Credit Note</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Reason</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {refunds.filter((r) => !q || (r.creditNoteNumber ?? '').toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q)).map((r) => (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs font-medium">{r.creditNoteNumber ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${r.orderId}`} className="hover:underline">{r.orderNumber}</Link></td>
                  <td className="px-3 py-2 text-xs">{r.customerName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.refundedAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-40">{r.reason ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-xs font-mono text-destructive">{fmtGbp(r.totalGbp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {refunds.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No refunds found.</p>}
        </div>
      )}

      {tab === 'aging' && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Invoiced</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Paid</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Outstanding</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Overdue (30d+)</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Oldest Unpaid</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {aging.filter((a) => !q || a.customerName.toLowerCase().includes(q)).map((a) => (
                <tr key={a.customerId || a.customerName} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">{a.customerName}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.totalInvoiced)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-green-600">{fmtGbp(a.totalPaid)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.outstanding > 0.01 ? 'text-orange-600 font-medium' : ''}>{a.outstanding > 0.01 ? fmtGbp(a.outstanding) : '—'}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.overdueAmount > 0 ? 'text-destructive font-medium' : ''}>{a.overdueAmount > 0 ? fmtGbp(a.overdueAmount) : '—'}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={a.oldestUnpaidDays > 60 ? 'text-destructive font-medium' : a.oldestUnpaidDays > 30 ? 'text-orange-600' : 'text-muted-foreground'}>{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays}d` : '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {aging.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No invoice data found.</p>}
        </div>
      )}
    </div>
  )
}
