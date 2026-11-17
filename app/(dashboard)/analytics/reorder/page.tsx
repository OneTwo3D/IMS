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
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'
import { requireReplenishmentReportAccess } from '@/lib/security/replenishment-report-page-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { hasPermission } from '@/lib/permissions'
import { getForecastSettings } from '@/app/actions/forecasting'
import { HistoricalImportTrigger } from './historical-import-trigger'
import { ReorderSelectionProvider } from '@/lib/analytics/reorder-selection-context'
import { parseSelectedParam } from '@/lib/analytics/reorder-selection'
import { ReorderCoverageProvider, ReorderCoverageWeeksCell, ReorderOrderQtyCell } from './reorder-coverage-cells'
import { ReorderSupplierSelect } from './reorder-supplier-select'
import { ReorderSelectAllCheckbox, ReorderRowCheckbox } from './reorder-selection-checkboxes'
import { currentParams } from '../_components/report-utils'
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
    ...(one(searchParams.ignoreStockouts) === '1' ? { ignoreStockouts: true } : {}),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

const THRESHOLD_FIELD_LABELS = { reorderPoint: 'reorder point', safetyStockQty: 'safety stock', reorderQty: 'reorder quantity' } as const

const ABC_BADGE: Record<ReorderReportRow['abcClass'], string> = {
  A: 'bg-amber-100 text-amber-800 border-amber-200',
  B: 'bg-slate-100 text-slate-700 border-slate-200',
  C: 'bg-gray-100 text-gray-600 border-gray-200',
}

const MUTED_DASH = '\u2014'

/** Latest PO date with a red Overdue badge, or an em dash and a muted reason when no date exists. */
function LatePoBadge({ row }: { row: ReorderReportRow }) {
  if (Number(row.lateInboundQty) <= 0) return null
  return (
    <span className="mt-0.5 block w-fit rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800" title="Open PO quantity past its expected delivery date. Not counted in the dates here until it is received or re-dated.">
      Late PO: {row.lateInboundQty} due {row.lateInboundDueDate}
    </span>
  )
}

function LatestPoDateCell({ row }: { row: ReorderReportRow }) {
  return (
    <div>
      <LatestPoDateText row={row} />
      <LatePoBadge row={row} />
      {row.reorderNote ? <span className="mt-0.5 block max-w-[16rem] text-[11px] text-amber-800">{row.reorderNote}</span> : null}
    </div>
  )
}

function LatestPoDateText({ row }: { row: ReorderReportRow }) {
  if (row.latestPoDate == null) {
    return (
      <span className="text-muted-foreground" title={row.timingBasis === 'no_demand' ? 'No sales demand, so no run-out date' : `No depletion within ${PROJECTION_HORIZON_LABEL}`}>
        {MUTED_DASH} <span className="text-[10px]">{row.timingBasis === 'no_demand' ? 'no demand' : 'beyond horizon'}</span>
      </span>
    )
  }
  return (
    <span className={row.latestPoOverdue ? 'font-medium text-red-700' : undefined}>
      {row.latestPoDate}
      {row.latestPoOverdue ? (
        <span className="ml-1.5 inline-flex items-center rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-800">Overdue</span>
      ) : null}
    </span>
  )
}

const PROJECTION_HORIZON_LABEL = '365 days'

/** Daily demand, with a badge when stockout days were removed from (or the 90% guard blocked) its average. */
function DailyDemandCell({ row }: { row: ReorderReportRow }) {
  const adjustment = row.stockoutAdjustment
  if (!adjustment) return <>{row.averageDailyDemand}</>
  return (
    <div>
      {row.averageDailyDemand}
      <span
        className="mt-0.5 block text-[10px] text-muted-foreground"
        title={adjustment.clamped
          ? 'Out of stock for 90% or more of the demand window: the unadjusted demand is used.'
          : `Averaged over ${adjustment.effectiveDays} days: ${adjustment.stockoutDays} stockout day(s) in the window are excluded.`}
      >
        {adjustment.clamped ? 'stockouts not excluded (>= 90%)' : `${adjustment.stockoutDays} stockout day(s) excluded`}
      </span>
    </div>
  )
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
    ignoreStockouts: filters.ignoreStockouts,
    pageSize: String(filters.pageSize ?? 100),
  }
  // Carry the filters that shape one product's figures into the demand chart drill-down.
  const chartQuery = currentParams({
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    thresholdDays: filters.thresholdDays,
    targetCoverWeeks: filters.targetCoverWeeks,
    ignoreStockouts: filters.ignoreStockouts,
  }).toString()
  const columns: Array<StockPositionColumn<ReorderReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'supplier', label: 'Supplier / source', render: (row) => row.supplierName == null ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" title="No supplier is set, so a draft PO cannot be raised for this row">Unassigned</span> : row.productType === 'BOM' ? row.supplierName : <ReorderSupplierSelect productId={row.productId} sku={row.sku} defaultSupplierId={row.supplierId} defaultSupplierName={row.supplierName} options={row.supplierOptions} /> },
    { key: 'neededFor', label: 'Needed for', render: (row) => row.neededFor.join(', ') },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'abcClass', label: 'ABC', render: (row) => <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${ABC_BADGE[row.abcClass]}`}>{row.abcClass}</span> },
    { key: 'available', label: 'Available', align: 'right', render: (row) => `${row.availableQty} ${row.stockUnit}`, footer: report.totals.availableQty },
    { key: 'warehouseAvailability', label: 'Warehouse availability', render: (row) => row.warehouseAvailabilityBreakdown || 'None' },
    { key: 'inbound', label: 'Inbound PO', align: 'right', render: (row) => row.inboundOpenPoQty, footer: report.totals.inboundOpenPoQty },
    { key: 'demand', label: 'Daily demand', align: 'right', render: (row) => <DailyDemandCell row={row} /> },
    { key: 'leadTime', label: 'Lead time', align: 'right', render: (row) => `${row.leadTimeDays} days` },
    { key: 'latestPoDate', label: 'Latest PO date', render: (row) => <LatestPoDateCell row={row} /> },
    { key: 'requiredReceipt', label: 'Required receipt', render: (row) => row.requiredReceiptDate ?? MUTED_DASH },
    {
      key: 'reorderPoint',
      label: 'Reorder point',
      align: 'right',
      render: (row) => row.thresholdOverrides.length > 0 ? (
        <span
          title={`This warehouse overrides the product value for: ${row.thresholdOverrides.map((f) => THRESHOLD_FIELD_LABELS[f]).join(', ')}. Safety stock ${row.safetyStockQty}, reorder quantity ${row.configuredReorderQty}.`}
        >
          {row.reorderPoint}
          <span className="ml-1 rounded bg-sky-100 px-1 py-0.5 text-[10px] font-semibold text-sky-800">Override</span>
        </span>
      ) : row.reorderPoint,
    },
    { key: 'suggested', label: 'Suggested qty', align: 'right', render: (row) => row.suggestedReorderQty, footer: report.totals.suggestedReorderQty },
    {
      key: 'orderQty',
      label: 'Order qty',
      align: 'right',
      render: (row) => <ReorderOrderQtyCell productId={row.productId} suggestedQty={row.suggestedReorderQty} averageDailyDemand={row.averageDailyDemand} label={row.sku} />,
    },
    {
      key: 'coverageWeeks',
      label: 'Coverage weeks',
      align: 'right',
      render: (row) => <ReorderCoverageWeeksCell productId={row.productId} suggestedQty={row.suggestedReorderQty} averageDailyDemand={row.averageDailyDemand} label={row.sku} />,
    },
    { key: 'urgency', label: 'Status', render: (row) => urgencyLabel(row.urgency) },
    {
      key: 'demandChart',
      label: 'Chart',
      render: (row) => (
        <Link
          href={`/analytics/reorder/${encodeURIComponent(row.productId)}${chartQuery ? `?${chartQuery}` : ''}`}
          aria-label={`Demand chart for ${row.sku}`}
          title={`Demand chart for ${row.sku}`}
          className="inline-flex text-muted-foreground hover:text-foreground"
        >
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
        </Link>
      ),
    },
  ]

  const toolbarRows = report.rows.map((row) => ({
    productId: row.productId,
    productType: row.productType,
    suggestedReorderQty: Number(row.suggestedReorderQty) || 0,
  }))
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
    // The draft PO / MO quantities must use the demand the operator is looking at.
    ...(filters.ignoreStockouts ? { ignoreStockouts: true } : {}),
  }
  const visibleProductIds = report.rows.map((row) => row.productId)
  // Hydrate selection from the URL, but only for ids still on the current page
  // (single-page selection model — off-page ids are dropped on navigation).
  const visibleProductIdSet = new Set(visibleProductIds)
  const initialSelected = parseSelectedParam(one(resolvedSearchParams.selected)).filter((id) => visibleProductIdSet.has(id))
  return (
    <div className="space-y-3">
      <ReorderSelectionProvider visibleIds={visibleProductIds} initialSelected={initialSelected}>
      <ReorderCoverageProvider>
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
          <label className="flex items-center gap-2 self-end pb-2 text-sm" title="Remove days with no on-hand stock (from the daily inventory snapshots) from the demand average. Days without a snapshot are not counted as stockouts.">
            <input type="checkbox" name="ignoreStockouts" value="1" defaultChecked={filtersForUi.ignoreStockouts} className="rounded border-input" />
            Ignore stockouts
          </label>
        </>
      }
      selectionColumn={{
        header: <ReorderSelectAllCheckbox />,
        cell: (row) => <ReorderRowCheckbox productId={row.productId} label={row.sku} />,
      }}
    />
      </ReorderCoverageProvider>
      </ReorderSelectionProvider>
    </div>
  )
}
