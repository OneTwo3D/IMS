import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import {
  emptyReorderReportForSourceLimit,
  getReorderReport,
  type ReorderReportRow,
} from '@/lib/domain/inventory/replenishment-reports'
import { ReorderActionsToolbar } from './reorder-actions-client'
import type { ReorderActionFilters } from '@/app/actions/forecasting'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireReplenishmentReportAccess } from '@/lib/security/replenishment-report-page-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { hasPermission } from '@/lib/permissions'
import { getForecastSettings } from '@/app/actions/forecasting'
import { HistoricalImportTrigger } from './historical-import-trigger'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'

export const metadata: Metadata = { title: 'Reorder Planning' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const ABC_CLASSES = ['A', 'B', 'C'] as const
const URGENCIES = ['critical', 'reorder', 'watch'] as const

function abcClassFromSearch(value: string | undefined): StockPositionFilters['abcClass'] {
  return (ABC_CLASSES as readonly string[]).includes(value ?? '') ? (value as StockPositionFilters['abcClass']) : undefined
}

function urgencyFromSearch(value: string | undefined): StockPositionFilters['urgency'] {
  return (URGENCIES as readonly string[]).includes(value ?? '') ? (value as StockPositionFilters['urgency']) : undefined
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  const search = one(searchParams.search)?.trim().slice(0, 100)
  return {
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    thresholdDays: positiveInteger(one(searchParams.thresholdDays)),
    abcClass: abcClassFromSearch(one(searchParams.abcClass)),
    urgency: urgencyFromSearch(one(searchParams.urgency)),
    search: search || undefined,
    targetCoverWeeks: positiveInteger(one(searchParams.targetCoverWeeks)),
    includeZero: one(searchParams.includeZero) === '1',
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

const ABC_BADGE: Record<ReorderReportRow['abcClass'], string> = {
  A: 'bg-amber-100 text-amber-800 border-amber-200',
  B: 'bg-slate-100 text-slate-700 border-slate-200',
  C: 'bg-gray-100 text-gray-600 border-gray-200',
}

function urgencyLabel(urgency: ReorderReportRow['urgency']): string {
  return urgency === 'critical' ? 'Critical' : urgency === 'reorder' ? 'Reorder' : 'Watch'
}

export default async function ReorderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireReplenishmentReportAccess()
  // The historical-sales import writes data (StockMovement) and reuses the WC sync
  // pipeline, so it's gated on `sync` (ADMIN/MANAGER) — FINANCE can read the report
  // but not import. Only load forecast settings (analytics-gated) when we'll render
  // the trigger, so FINANCE never hits the analytics permission check.
  const canImportHistory = hasPermission(session.user.role, 'sync')
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, importSettings] = await Promise.all([
    getReorderReport(filters).catch((error: unknown) => {
      if (isSourceScanTooLargeError(error)) return emptyReorderReportForSourceLimit(filters, error)
      throw error
    }),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    canImportHistory ? getForecastSettings() : Promise.resolve(null),
  ])
  const filtersForUi: StockPositionFilterValues = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    thresholdDays: filters.thresholdDays == null ? undefined : String(filters.thresholdDays),
    abcClass: filters.abcClass,
    urgency: filters.urgency,
    search: filters.search,
    targetCoverWeeks: filters.targetCoverWeeks == null ? undefined : String(filters.targetCoverWeeks),
    includeZero: filters.includeZero,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<ReorderReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'supplier', label: 'Supplier / source', render: (row) => row.supplierName ?? 'Unassigned' },
    { key: 'neededFor', label: 'Needed for', render: (row) => row.neededFor.join(', ') },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'abcClass', label: 'ABC', render: (row) => <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${ABC_BADGE[row.abcClass]}`}>{row.abcClass}</span> },
    { key: 'available', label: 'Available', align: 'right', render: (row) => `${row.availableQty} ${row.stockUnit}`, footer: report.totals.availableQty },
    { key: 'warehouseAvailability', label: 'Warehouse availability', render: (row) => row.warehouseAvailabilityBreakdown || 'None' },
    { key: 'inbound', label: 'Inbound PO', align: 'right', render: (row) => row.inboundOpenPoQty, footer: report.totals.inboundOpenPoQty },
    { key: 'demand', label: 'Daily demand', align: 'right', render: (row) => row.averageDailyDemand },
    { key: 'leadTime', label: 'Lead time', align: 'right', render: (row) => `${row.leadTimeDays} days` },
    { key: 'reorderPoint', label: 'Reorder point', align: 'right', render: (row) => row.reorderPoint },
    { key: 'suggested', label: 'Suggested qty', align: 'right', render: (row) => row.suggestedReorderQty, footer: report.totals.suggestedReorderQty },
    { key: 'urgency', label: 'Status', render: (row) => urgencyLabel(row.urgency) },
  ]

  const toolbarRows = report.rows.map((row) => ({ productId: row.productId, productType: row.productType }))
  // audit-pcc0: pass the same filters that produced the visible report so the PO/MO
  // buttons compute draft quantities from identical getReorderReport semantics.
  const actionFilters: ReorderActionFilters = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    thresholdDays: filters.thresholdDays,
    targetCoverWeeks: filters.targetCoverWeeks,
    abcClass: filters.abcClass,
    urgency: filters.urgency,
    search: filters.search,
  }
  return (
    <div className="space-y-3">
      <ReorderActionsToolbar rows={toolbarRows} filters={actionFilters} />
    <StockPositionReportPage
      title="Reorder Planning"
      description="Demand-driven replenishment suggestions using sales velocity, supplier lead time, safety stock, available stock, and inbound open POs."
      reportKey="reorder"
      exportBasePath="/api/export/replenishment"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.productId}
      columns={columns}
      summary={[
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'Available', value: report.totals.availableQty },
        { label: 'Inbound open PO', value: report.totals.inboundOpenPoQty },
        { label: 'Suggested reorder', value: report.totals.suggestedReorderQty, tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
      dateMode="none"
      showIncludeZero
      includeZeroLabel="Show all products (incl. zero reorder)"
      showDemandWindowDays
      headerActions={importSettings ? <HistoricalImportTrigger settings={importSettings} /> : null}
      extraFilters={
        <>
          <div className="space-y-1.5">
            <label htmlFor="urgency" className="text-sm font-medium">Status</label>
            <select id="urgency" name="urgency" defaultValue={filtersForUi.urgency ?? ''} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">All statuses</option>
              <option value="critical">Critical</option>
              <option value="reorder">Reorder</option>
              <option value="watch">Watch</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="abcClass" className="text-sm font-medium">ABC class</label>
            <select id="abcClass" name="abcClass" defaultValue={filtersForUi.abcClass ?? ''} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">All classes</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="search" className="text-sm font-medium">Search</label>
            <input id="search" name="search" type="search" defaultValue={filtersForUi.search ?? ''} placeholder="SKU, name, supplier…" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="targetCoverWeeks" className="text-sm font-medium">Weeks of supply</label>
            <input id="targetCoverWeeks" name="targetCoverWeeks" type="number" min="1" max="52" step="1" list="targetCoverWeeksOptions" defaultValue={filtersForUi.targetCoverWeeks ?? '8'} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" />
            <datalist id="targetCoverWeeksOptions">
              <option value="4" />
              <option value="6" />
              <option value="8" />
              <option value="12" />
              <option value="16" />
            </datalist>
          </div>
        </>
      }
    />
    </div>
  )
}
