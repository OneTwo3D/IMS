'use client'

import { useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { Filter, X, ArrowUp, ArrowDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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

// ---------------------------------------------------------------------------
// Generic filterable + sortable table
// ---------------------------------------------------------------------------

type ColDef<T> = {
  key: string
  label: string
  align?: 'left' | 'right'
  width?: string
  render: (row: T) => React.ReactNode
  getValue: (row: T) => string | number  // for filtering + sorting
  className?: string
  footerRender?: () => React.ReactNode
}

type SortDir = 'asc' | 'desc'

function FilterableTable<T extends { _key: string }>({
  columns,
  data,
  emptyMessage,
}: {
  columns: ColDef<T>[]
  data: T[]
  emptyMessage?: string
}) {
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const setFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({})
  }, [])

  function handleSort(key: string) {
    if (sortCol === key) {
      setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  const filtered = useMemo(() => {
    let result = data
    for (const col of columns) {
      const f = filters[col.key]?.toLowerCase()
      if (!f) continue
      result = result.filter((row) => {
        const val = String(col.getValue(row)).toLowerCase()
        // Support numeric comparisons: >100, <50, >=10
        if (f.startsWith('>=')) { const n = parseFloat(f.slice(2)); return !isNaN(n) && Number(col.getValue(row)) >= n }
        if (f.startsWith('<=')) { const n = parseFloat(f.slice(2)); return !isNaN(n) && Number(col.getValue(row)) <= n }
        if (f.startsWith('>')) { const n = parseFloat(f.slice(1)); return !isNaN(n) && Number(col.getValue(row)) > n }
        if (f.startsWith('<')) { const n = parseFloat(f.slice(1)); return !isNaN(n) && Number(col.getValue(row)) < n }
        if (f.startsWith('=')) { const n = parseFloat(f.slice(1)); return !isNaN(n) && Number(col.getValue(row)) === n }
        return val.includes(f)
      })
    }

    if (sortCol) {
      const col = columns.find((c) => c.key === sortCol)
      if (col) {
        result = [...result].sort((a, b) => {
          const va = col.getValue(a)
          const vb = col.getValue(b)
          const cmp = typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb))
          return sortDir === 'asc' ? cmp : -cmp
        })
      }
    }

    return result
  }, [data, filters, sortCol, sortDir, columns])

  return (
    <div className="rounded-md border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
        <span className="text-xs text-muted-foreground">{filtered.length} of {data.length} rows</span>
        <div className="flex items-center gap-1.5">
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive" onClick={clearFilters}>
              <X className="h-3 w-3 mr-0.5" />Clear ({activeFilterCount})
            </Button>
          )}
          <Button variant={showFilters ? 'default' : 'outline'} size="sm" className="h-6 text-xs" onClick={() => setShowFilters((v) => !v)}>
            <Filter className="h-3 w-3 mr-0.5" />Filter
          </Button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/50">
          <tr>
            {columns.map((col) => (
              <th key={col.key}
                className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none ${col.align === 'right' ? 'text-right' : 'text-left'} ${col.width ?? ''}`}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-0.5">
                  {col.label}
                  {sortCol === col.key && (
                    sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                  )}
                </span>
              </th>
            ))}
          </tr>
          {showFilters && (
            <tr className="bg-muted/20">
              {columns.map((col) => (
                <th key={col.key} className="px-2 py-1">
                  <Input
                    value={filters[col.key] ?? ''}
                    onChange={(e) => setFilter(col.key, e.target.value)}
                    placeholder={col.align === 'right' ? '>0, <100…' : 'Filter…'}
                    className="h-6 text-[11px] bg-background"
                  />
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody className="divide-y">
          {filtered.map((row) => (
            <tr key={row._key} className="hover:bg-muted/30">
              {columns.map((col) => (
                <td key={col.key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''} ${col.className ?? ''}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {columns.some((c) => c.footerRender) && (
          <tfoot className="border-t bg-muted/30 text-sm font-medium">
            <tr>
              {columns.map((col) => (
                <td key={col.key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>
                  {col.footerRender?.() ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {filtered.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-8">{emptyMessage ?? 'No data found.'}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SalesStatsClient({ productStats, shipments, invoices, refunds, aging }: Props) {
  const [tab, setTab] = useState<Tab>('products')
  const { rows, summary } = productStats

  // Wrap data with _key for FilterableTable
  const productData = useMemo(() => rows.map((r) => ({ ...r, _key: r.productId })), [rows])
  const shipmentData = useMemo(() => shipments.map((s) => ({ ...s, _key: s.orderId })), [shipments])
  const invoiceData = useMemo(() => invoices.map((i) => ({ ...i, _key: i.orderId })), [invoices])
  const refundData = useMemo(() => refunds.map((r) => ({ ...r, _key: r.id })), [refunds])
  const agingData = useMemo(() => aging.map((a) => ({ ...a, _key: a.customerId || a.customerName })), [aging])

  // Column definitions
  const productCols: ColDef<SalesStatRow & { _key: string }>[] = [
    { key: 'product', label: 'Product', getValue: (r) => `${r.sku} ${r.name}`,
      render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />,
      footerRender: () => <span>Totals</span> },
    { key: 'qtySold', label: 'Sold', align: 'right', width: 'w-16', getValue: (r) => r.qtySold,
      render: (r) => <span className="tabular-nums text-xs">{r.qtySold}</span>,
      footerRender: () => <span className="tabular-nums">{summary.totalQtySold}</span> },
    { key: 'qtyRefunded', label: 'Refunded', align: 'right', width: 'w-16', getValue: (r) => r.qtyRefunded,
      render: (r) => <span className="tabular-nums text-xs text-orange-600">{r.qtyRefunded > 0 ? r.qtyRefunded : '—'}</span> },
    { key: 'netQty', label: 'Net Qty', align: 'right', width: 'w-16', getValue: (r) => r.netQty,
      render: (r) => <span className="tabular-nums text-xs font-medium">{r.netQty}</span> },
    { key: 'grossRevenue', label: 'Gross Rev', align: 'right', width: 'w-24', getValue: (r) => r.grossRevenue,
      render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.grossRevenue)}</span>,
      footerRender: () => <span className="tabular-nums font-mono">{fmtGbp(summary.totalGrossRevenue)}</span> },
    { key: 'discounts', label: 'Discounts', align: 'right', width: 'w-20', getValue: (r) => r.discounts,
      render: (r) => <span className="tabular-nums text-xs font-mono text-destructive">{r.discounts > 0 ? fmtGbp(r.discounts) : '—'}</span>,
      footerRender: () => <span className="tabular-nums font-mono text-destructive">{fmtGbp(summary.totalDiscounts)}</span> },
    { key: 'refunds', label: 'Refunds', align: 'right', width: 'w-20', getValue: (r) => r.refunds,
      render: (r) => <span className="tabular-nums text-xs font-mono text-orange-600">{r.refunds > 0 ? fmtGbp(r.refunds) : '—'}</span>,
      footerRender: () => <span className="tabular-nums font-mono text-orange-600">{fmtGbp(summary.totalRefunds)}</span> },
    { key: 'netRevenue', label: 'Net Revenue', align: 'right', width: 'w-24', getValue: (r) => r.netRevenue,
      render: (r) => <span className="tabular-nums text-xs font-mono font-medium">{fmtGbp(r.netRevenue)}</span>,
      footerRender: () => <span className="tabular-nums font-mono">{fmtGbp(summary.totalNetRevenue)}</span> },
    { key: 'cogs', label: 'COGS', align: 'right', width: 'w-20', getValue: (r) => r.cogs,
      render: (r) => <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.cogs > 0 ? fmtGbp(r.cogs) : '—'}</span>,
      footerRender: () => <span className="tabular-nums font-mono text-muted-foreground">{fmtGbp(summary.totalCogs)}</span> },
    { key: 'grossProfit', label: 'Profit', align: 'right', width: 'w-24', getValue: (r) => r.grossProfit,
      render: (r) => <span className={`tabular-nums text-xs font-mono ${r.grossProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>{fmtGbp(r.grossProfit)}</span>,
      footerRender: () => <span className="tabular-nums font-mono text-green-600">{fmtGbp(summary.totalGrossProfit)}</span> },
    { key: 'marginPct', label: 'Margin', align: 'right', width: 'w-16', getValue: (r) => r.marginPct,
      render: (r) => <span className={`tabular-nums text-xs ${r.marginPct < 0 ? 'text-destructive' : ''}`}>{r.marginPct}%</span>,
      footerRender: () => <span className="tabular-nums">{summary.avgMarginPct}%</span> },
    { key: 'orderCount', label: 'Orders', align: 'right', width: 'w-16', getValue: (r) => r.orderCount,
      render: (r) => <span className="tabular-nums text-xs text-muted-foreground">{r.orderCount}</span>,
      footerRender: () => <span className="tabular-nums text-muted-foreground">{summary.totalOrders}</span> },
  ]

  const shipmentCols: ColDef<ShipmentRow & { _key: string }>[] = [
    { key: 'order', label: 'Order', getValue: (r) => r.orderNumber,
      render: (r) => <Link href={`/sales/${r.orderId}`} className="font-mono text-xs hover:underline">{r.orderNumber}</Link> },
    { key: 'customer', label: 'Customer', getValue: (r) => r.customerName, render: (r) => <span className="text-xs">{r.customerName}</span> },
    { key: 'shipped', label: 'Shipped', getValue: (r) => r.shippedAt, render: (r) => <span className="text-xs text-muted-foreground">{fmtDate(r.shippedAt)}</span> },
    { key: 'service', label: 'Service', getValue: (r) => r.shippingService ?? '', render: (r) => <span className="text-xs text-muted-foreground">{r.shippingService ?? '—'}</span> },
    { key: 'tracking', label: 'Tracking', getValue: (r) => r.trackingNumber ?? '', render: (r) => <span className="text-xs font-mono text-muted-foreground">{r.trackingNumber ?? '—'}</span> },
    { key: 'warehouse', label: 'Warehouse', getValue: (r) => r.warehouse ?? '', render: (r) => <span className="text-xs">{r.warehouse ?? '—'}</span> },
    { key: 'items', label: 'Items', align: 'right', width: 'w-16', getValue: (r) => r.lineCount, render: (r) => <span className="tabular-nums text-xs">{r.lineCount}</span> },
    { key: 'total', label: 'Total', align: 'right', getValue: (r) => r.totalGbp, render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.totalGbp)}</span> },
  ]

  const invoiceCols: ColDef<InvoiceRow & { _key: string }>[] = [
    { key: 'invoice', label: 'Invoice', getValue: (r) => r.invoiceNumber, render: (r) => <span className="font-mono text-xs font-medium">{r.invoiceNumber}</span> },
    { key: 'order', label: 'Order', getValue: (r) => r.orderNumber,
      render: (r) => <Link href={`/sales/${r.orderId}`} className="font-mono text-xs hover:underline">{r.orderNumber}</Link> },
    { key: 'customer', label: 'Customer', getValue: (r) => r.customerName, render: (r) => <span className="text-xs">{r.customerName}</span> },
    { key: 'date', label: 'Date', getValue: (r) => r.invoicedAt, render: (r) => <span className="text-xs text-muted-foreground">{fmtDate(r.invoicedAt)}</span> },
    { key: 'total', label: 'Total', align: 'right', getValue: (r) => r.totalGbp, render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.totalGbp)}</span> },
    { key: 'paid', label: 'Paid', getValue: (r) => r.paidAt ?? 'Unpaid',
      render: (r) => r.paidAt ? <span className="text-xs text-green-600">{fmtDate(r.paidAt)}</span> : <span className="text-xs text-orange-600">Unpaid</span> },
    { key: 'balance', label: 'Balance', align: 'right', getValue: (r) => r.balance,
      render: (r) => <span className={`tabular-nums text-xs font-mono ${r.balance > 0.01 ? 'text-destructive font-medium' : 'text-green-600'}`}>{r.balance > 0.01 ? fmtGbp(r.balance) : 'Settled'}</span> },
  ]

  const refundCols: ColDef<RefundRow & { _key: string }>[] = [
    { key: 'cn', label: 'Credit Note', getValue: (r) => r.creditNoteNumber ?? '', render: (r) => <span className="font-mono text-xs font-medium">{r.creditNoteNumber ?? '—'}</span> },
    { key: 'order', label: 'Order', getValue: (r) => r.orderNumber,
      render: (r) => <Link href={`/sales/${r.orderId}`} className="font-mono text-xs hover:underline">{r.orderNumber}</Link> },
    { key: 'customer', label: 'Customer', getValue: (r) => r.customerName, render: (r) => <span className="text-xs">{r.customerName}</span> },
    { key: 'date', label: 'Date', getValue: (r) => r.refundedAt, render: (r) => <span className="text-xs text-muted-foreground">{fmtDate(r.refundedAt)}</span> },
    { key: 'reason', label: 'Reason', getValue: (r) => r.reason ?? '', render: (r) => <span className="text-xs text-muted-foreground truncate max-w-40 block">{r.reason ?? '—'}</span> },
    { key: 'amount', label: 'Amount', align: 'right', getValue: (r) => r.totalGbp, render: (r) => <span className="tabular-nums text-xs font-mono text-destructive">{fmtGbp(r.totalGbp)}</span> },
  ]

  const agingCols: ColDef<CustomerAgingRow & { _key: string }>[] = [
    { key: 'customer', label: 'Customer', getValue: (r) => r.customerName, render: (r) => <span className="font-medium">{r.customerName}</span> },
    { key: 'invoiced', label: 'Total Invoiced', align: 'right', getValue: (r) => r.totalInvoiced, render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.totalInvoiced)}</span> },
    { key: 'paid', label: 'Total Paid', align: 'right', getValue: (r) => r.totalPaid, render: (r) => <span className="tabular-nums text-xs font-mono text-green-600">{fmtGbp(r.totalPaid)}</span> },
    { key: 'outstanding', label: 'Outstanding', align: 'right', getValue: (r) => r.outstanding,
      render: (r) => <span className={`tabular-nums text-xs font-mono ${r.outstanding > 0.01 ? 'text-orange-600 font-medium' : ''}`}>{r.outstanding > 0.01 ? fmtGbp(r.outstanding) : '—'}</span> },
    { key: 'overdue', label: 'Overdue (30d+)', align: 'right', getValue: (r) => r.overdueAmount,
      render: (r) => <span className={`tabular-nums text-xs font-mono ${r.overdueAmount > 0 ? 'text-destructive font-medium' : ''}`}>{r.overdueAmount > 0 ? fmtGbp(r.overdueAmount) : '—'}</span> },
    { key: 'oldest', label: 'Oldest Unpaid', align: 'right', getValue: (r) => r.oldestUnpaidDays,
      render: (r) => <span className={`tabular-nums text-xs ${r.oldestUnpaidDays > 60 ? 'text-destructive font-medium' : r.oldestUnpaidDays > 30 ? 'text-orange-600' : 'text-muted-foreground'}`}>{r.oldestUnpaidDays > 0 ? `${r.oldestUnpaidDays}d` : '—'}</span> },
  ]

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
      </div>

      {/* Tab content */}
      {tab === 'products' && <FilterableTable columns={productCols} data={productData} emptyMessage="No product sales data." />}
      {tab === 'shipments' && <FilterableTable columns={shipmentCols} data={shipmentData} emptyMessage="No shipments found." />}
      {tab === 'invoices' && <FilterableTable columns={invoiceCols} data={invoiceData} emptyMessage="No invoices found." />}
      {tab === 'refunds' && <FilterableTable columns={refundCols} data={refundData} emptyMessage="No refunds found." />}
      {tab === 'aging' && <FilterableTable columns={agingCols} data={agingData} emptyMessage="No invoice data found." />}
    </div>
  )
}
