import Link from 'next/link'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { cn } from '@/lib/utils'
import { appendParams, currentParams, toneClass, type SummaryTone } from './report-utils'

export type ManufacturingAnalyticsReportKey = 'production-variance' | 'wip'

export type ManufacturingAnalyticsFilterValues = {
  dateFrom?: string
  dateTo?: string
  pageSize?: string
}

export type ManufacturingAnalyticsColumn<Row> = {
  key: string
  label: string
  align?: 'left' | 'right'
  render: (row: Row) => React.ReactNode
  footer?: React.ReactNode
}

type ManufacturingAnalyticsReportPageProps<Row> = {
  title: string
  description: string
  reportKey: ManufacturingAnalyticsReportKey
  filters: ManufacturingAnalyticsFilterValues
  pageInfo: PageInfo
  rows: Row[]
  rowKey: (row: Row, index: number) => string
  columns: Array<ManufacturingAnalyticsColumn<Row>>
  summary: Array<{ label: string; value: string; tone?: SummaryTone }>
  notices?: string[]
  showDateFilters?: boolean
}

export function ManufacturingAnalyticsReportPage<Row>({
  title,
  description,
  reportKey,
  filters,
  pageInfo,
  rows,
  rowKey,
  columns,
  summary,
  notices = [],
  showDateFilters = true,
}: ManufacturingAnalyticsReportPageProps<Row>) {
  const params = currentParams(filters)
  const csvHref = `/api/export/manufacturing-analytics?${appendParams(params, { report: reportKey })}`
  const previousHref = `?${appendParams(params, { page: pageInfo.page - 1 })}`
  const nextHref = `?${appendParams(params, { page: pageInfo.page + 1 })}`

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
          {showDateFilters && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="dateFrom">From (UTC)</Label>
                <Input id="dateFrom" name="dateFrom" type="date" defaultValue={filters.dateFrom ?? ''} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dateTo">To (UTC)</Label>
                <Input id="dateTo" name="dateTo" type="date" defaultValue={filters.dateTo ?? ''} className="h-9" />
              </div>
            </>
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
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-8 text-center text-sm text-muted-foreground">No rows for the selected filters.</TableCell>
              </TableRow>
            ) : rows.map((row, index) => (
              <TableRow key={rowKey(row, index)}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.align === 'right' ? 'text-right tabular-nums' : ''}>{column.render(row)}</TableCell>
                ))}
              </TableRow>
            ))}
            {rows.length > 0 && columns.some((column) => column.footer != null) && (
              <TableRow className="bg-muted/30 font-medium">
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.align === 'right' ? 'text-right tabular-nums' : ''}>{column.footer ?? null}</TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Link
          href={previousHref}
          aria-disabled={!pageInfo.hasPreviousPage}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), !pageInfo.hasPreviousPage && 'pointer-events-none opacity-50')}
        >
          Previous
        </Link>
        <Link
          href={nextHref}
          aria-disabled={!pageInfo.hasNextPage}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), !pageInfo.hasNextPage && 'pointer-events-none opacity-50')}
        >
          Next
        </Link>
      </div>
    </div>
  )
}
