import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { InventoryHealthSourceLimitError } from '@/lib/domain/inventory/inventory-health-reports'
import {
  emptySlowStockReportForSourceLimit,
  getSlowStockReport,
  parseMinValue,
  parseNonNegativeInteger,
  type SlowStockFilters,
  type SlowStockReportRow,
} from '@/lib/domain/inventory/slow-stock-report'
import { hasPermission } from '@/lib/permissions'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'

export const metadata: Metadata = { title: 'Slow Stock' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function dateLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'Never'
}

export default async function SlowStockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireStockPositionReportAccess()
  // Cost and value are cost figures: shown only to roles holding inventory.prices (same gate as the reorder report's money columns).
  const costVisible = hasPermission(session.user.role, 'inventory.prices')
  const resolved = await searchParams
  const minValueRaw = one(resolved.minValue)
  const filters: SlowStockFilters = {
    warehouseId: one(resolved.warehouseId),
    categoryId: one(resolved.categoryId),
    supplierId: one(resolved.supplierId),
    productType: one(resolved.productType) as SlowStockFilters['productType'],
    perWarehouse: one(resolved.perWarehouse) === '1',
    minAgeDays: parseNonNegativeInteger(one(resolved.minAgeDays)),
    noSaleDays: parseNonNegativeInteger(one(resolved.noSaleDays)),
    minValueBase: costVisible && parseMinValue(minValueRaw) ? minValueRaw : undefined,
    includeCost: costVisible,
    page: Number(one(resolved.page) ?? 1),
    pageSize: Number(one(resolved.pageSize) ?? 100),
  }
  const [report, filterOptions, organisation] = await Promise.all([
    getSlowStockReport(filters).catch((error: unknown) => {
      if (error instanceof InventoryHealthSourceLimitError) return emptySlowStockReportForSourceLimit(filters, error)
      throw error
    }),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const filtersForUi: StockPositionFilterValues = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    perWarehouse: filters.perWarehouse,
    minAgeDays: filters.minAgeDays == null ? undefined : String(filters.minAgeDays),
    noSaleDays: filters.noSaleDays == null ? undefined : String(filters.noSaleDays),
    minValue: filters.minValueBase,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<SlowStockReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => (
      <span className="font-medium">
        {row.warehouseCode}
        {row.quarantineQty && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" title="Units in a quarantine warehouse: unsellable returns awaiting review">Quarantine {row.quarantineQty}</span>}
      </span>
    ) },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'qty', label: 'On hand', align: 'right', render: (row) => `${row.qty} ${row.stockUnit}`, footer: report.totals.qty },
    ...(costVisible ? [{
      key: 'value',
      label: `Value (${currency})`,
      align: 'right' as const,
      render: (row: SlowStockReportRow) => formatMoneyCode(Number(row.valueBase), currency),
      footer: formatMoneyCode(Number(report.totals.valueBase ?? '0'), currency),
    }] : []),
    {
      key: 'age',
      label: 'Oldest layer',
      align: 'right',
      render: (row) => row.oldestLayerAgeDays == null ? 'No layer' : `${row.oldestLayerAgeDays} days (${row.ageBand})`,
    },
    { key: 'lastSale', label: 'Last sale', render: (row) => dateLabel(row.lastSaleAt) },
    {
      key: 'rate',
      label: 'Sold per 30 days',
      align: 'right',
      render: (row) => row.ratePer30Days,
    },
    {
      key: 'cover',
      label: 'Months of cover',
      align: 'right',
      render: (row) => row.monthsOfCover ?? 'No sales',
    },
  ]

  return (
    <StockPositionReportPage
      title="Slow Stock (NRV review)"
      description="Current stock by product with on-hand value from FIFO layers, age of the oldest layer, last sale, recent sales rate and months of cover, to support the period-end lower-of-cost-and-NRV review. Read only: a write-down is still a manual stock adjustment."
      reportKey="slow-stock"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId ?? 'all'}`}
      columns={columns}
      summary={[
        { label: 'Rows', value: report.totals.rows.toLocaleString(), tone: report.totals.rows > 0 ? 'warning' : 'default' },
        { label: 'Quantity', value: report.totals.qty },
        ...(costVisible
          ? [{ label: `Value (${currency})`, value: formatMoneyCode(Number(report.totals.valueBase ?? '0'), currency), tone: 'warning' as const }]
          : []),
        ...(costVisible
          ? report.bandSummary.map((band) => ({ label: `Value ${band.band} days`, value: formatMoneyCode(Number(band.valueBase ?? '0'), currency) }))
          : report.bandSummary.map((band) => ({ label: `Rows ${band.band} days`, value: String(band.rows) }))),
      ]}
      notices={report.notices}
      dateMode="none"
      showIncludeZero={false}
      extraFilters={(
        <>
          <div className="space-y-1.5">
            <Label htmlFor="minAgeDays">Oldest layer at least (days)</Label>
            <Input id="minAgeDays" name="minAgeDays" type="number" min="0" step="1" list="slowAgeOptions" defaultValue={filtersForUi.minAgeDays ?? ''} className="h-9" />
            <datalist id="slowAgeOptions">
              <option value="90" />
              <option value="180" />
              <option value="365" />
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="noSaleDays">No sale in (days)</Label>
            <Input id="noSaleDays" name="noSaleDays" type="number" min="0" step="1" list="slowNoSaleOptions" defaultValue={filtersForUi.noSaleDays ?? ''} className="h-9" />
            <datalist id="slowNoSaleOptions">
              <option value="30" />
              <option value="90" />
              <option value="180" />
              <option value="365" />
            </datalist>
          </div>
          {costVisible && (
            <div className="space-y-1.5">
              <Label htmlFor="minValue">Minimum value ({currency})</Label>
              <Input id="minValue" name="minValue" type="number" min="0" step="0.01" defaultValue={filtersForUi.minValue ?? ''} className="h-9" />
            </div>
          )}
          <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground">
            <input type="checkbox" name="perWarehouse" value="1" defaultChecked={filters.perWarehouse} className="rounded border-input" />
            One row per warehouse
          </label>
        </>
      )}
    />
  )
}
