import Link from 'next/link'
import { Download } from 'lucide-react'
import { StockCountStatus, StockMovementType, StockTransferStatus } from '@/app/generated/prisma/client'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PageInfo, StockPositionFilterOptions } from '@/lib/domain/inventory/stock-position-reports'
import { cn } from '@/lib/utils'
import { StockPositionFilterCombobox } from './stock-position-filter-combobox'

export type InventoryLedgerColumn<Row> = {
  key: string
  label: string
  align?: 'left' | 'right'
  render: (row: Row) => React.ReactNode
  footer?: React.ReactNode
}

export type InventoryLedgerReportKey = 'stock-movements' | 'stock-adjustments' | 'transfers' | 'stock-counts'

export type InventoryLedgerFilterValues = {
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  product?: string
  type?: string
  status?: string
  reference?: string
  minValue?: string
  pageSize?: string
}

type InventoryLedgerReportPageProps<Row> = {
  title: string
  description: string
  reportKey: InventoryLedgerReportKey
  filters: InventoryLedgerFilterValues
  filterOptions: StockPositionFilterOptions
  pageInfo: PageInfo
  rows: Row[]
  rowKey: (row: Row, index: number) => string
  columns: Array<InventoryLedgerColumn<Row>>
  summary: Array<{ label: string; value: string; tone?: 'default' | 'warning' | 'danger' }>
  notices?: string[]
  statusKind?: 'transfer' | 'stock-count'
  showMovementType?: boolean
  showMinValue?: boolean
}

function appendParams(base: URLSearchParams, updates: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(base)
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  return params.toString()
}

function currentParams(filters: InventoryLedgerFilterValues): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '') continue
    params.set(key, String(value))
  }
  return params
}

function toneClass(tone: 'default' | 'warning' | 'danger' = 'default'): string {
  if (tone === 'danger') return 'text-destructive'
  if (tone === 'warning') return 'text-orange-600'
  return 'text-foreground'
}

function statusOptions(kind: 'transfer' | 'stock-count' | undefined): string[] {
  if (kind === 'transfer') return Object.values(StockTransferStatus)
  if (kind === 'stock-count') return Object.values(StockCountStatus)
  return []
}

export function InventoryLedgerReportPage<Row>({
  title,
  description,
  reportKey,
  filters,
  filterOptions,
  pageInfo,
  rows,
  rowKey,
  columns,
  summary,
  notices = [],
  statusKind,
  showMovementType = false,
  showMinValue = false,
}: InventoryLedgerReportPageProps<Row>) {
  const params = currentParams(filters)
  const csvHref = `/api/export/inventory-ledger?${appendParams(params, { report: reportKey })}`
  const previousHref = `?${appendParams(params, { page: pageInfo.page - 1 })}`
  const nextHref = `?${appendParams(params, { page: pageInfo.page + 1 })}`
  const statuses = statusOptions(statusKind)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
        <a href={csvHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit')}>
          <Download className="mr-2 h-4 w-4" />
          CSV
        </a>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {summary.map((item) => (
          <div key={item.label} className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className={`mt-1 text-xl font-semibold tabular-nums ${toneClass(item.tone)}`}>{item.value}</p>
          </div>
        ))}
      </div>

      <form className="rounded-md border bg-muted/20 p-3">
        <input type="hidden" name="page" value="1" />
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="space-y-1.5">
            <Label htmlFor="dateFrom">From (UTC)</Label>
            <Input id="dateFrom" name="dateFrom" type="date" defaultValue={filters.dateFrom ?? ''} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dateTo">To (UTC)</Label>
            <Input id="dateTo" name="dateTo" type="date" defaultValue={filters.dateTo ?? ''} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="warehouseId">Warehouse</Label>
            <StockPositionFilterCombobox
              key={`warehouse:${filters.warehouseId ?? ''}`}
              id="warehouseId"
              name="warehouseId"
              type="warehouse"
              allLabel="All warehouses"
              value={filters.warehouseId}
              initialOptions={filterOptions.warehouses}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product">Product</Label>
            <Input id="product" name="product" defaultValue={filters.product ?? ''} className="h-9" placeholder="SKU or name" />
          </div>
          {showMovementType && (
            <div className="space-y-1.5">
              <Label htmlFor="movementType">Movement type</Label>
              <select id="movementType" name="type" defaultValue={filters.type ?? ''} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">All movement types</option>
                {Object.values(StockMovementType).map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          )}
          {statuses.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <select id="status" name="status" defaultValue={filters.status ?? ''} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">All statuses</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="reference">Reference</Label>
            <Input id="reference" name="reference" defaultValue={filters.reference ?? ''} className="h-9" placeholder="ID, type or note" />
          </div>
          {showMinValue && (
            <div className="space-y-1.5">
              <Label htmlFor="minValue">Min value</Label>
              <Input id="minValue" name="minValue" inputMode="decimal" defaultValue={filters.minValue ?? ''} className="h-9" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="pageSize">Rows</Label>
            <select id="pageSize" name="pageSize" defaultValue={filters.pageSize ?? '100'} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="250">250</option>
              <option value="500">500</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Link href={`/analytics/${reportKey}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Reset</Link>
          <Button size="sm" type="submit">Apply</Button>
        </div>
      </form>

      {notices.length > 0 && (
        <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-900/50 dark:bg-orange-950/30 dark:text-orange-100">
          {notices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      )}

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>{pageInfo.totalRows.toLocaleString()} rows</span>
          <span>Page {pageInfo.page} of {pageInfo.totalPages}</span>
        </div>
        <Table containerClassName="max-h-[calc(100vh-22rem)]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : ''}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={rowKey(row, index)}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.align === 'right' ? 'text-right tabular-nums' : ''}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">No rows match the current filters.</TableCell>
              </TableRow>
            )}
          </TableBody>
          {columns.some((column) => column.footer != null) && (
            <tfoot className="border-t bg-muted/30 font-medium">
              <tr>
                {columns.map((column) => (
                  <td key={column.key} className={`px-3 py-2 text-sm ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {column.footer ?? null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Link
          href={pageInfo.hasPreviousPage ? previousHref : '#'}
          aria-disabled={!pageInfo.hasPreviousPage}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), !pageInfo.hasPreviousPage && 'pointer-events-none opacity-50')}
        >
          Previous
        </Link>
        <Link
          href={pageInfo.hasNextPage ? nextHref : '#'}
          aria-disabled={!pageInfo.hasNextPage}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), !pageInfo.hasNextPage && 'pointer-events-none opacity-50')}
        >
          Next
        </Link>
      </div>
    </div>
  )
}
