import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  emptyInventoryTurnoverReportForSourceLimit,
  getInventoryTurnoverReport,
  INVENTORY_TURNOVER_GROUP_OPTIONS,
  InventoryTurnoverSourceLimitError,
  inventoryCostingFiltersForUi,
  inventoryCostingFiltersFromSearch,
  type InventoryCostingSearchParams,
  type InventoryTurnoverReportRow,
} from '@/lib/domain/inventory/inventory-costing-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireInventoryCostingReportAccess } from '@/lib/security/inventory-costing-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryCostingReportPage,
  type InventoryCostingColumn,
} from '../_components/inventory-costing-report'

export const metadata: Metadata = { title: 'Inventory Turnover' }

export default async function InventoryTurnoverPage({ searchParams }: { searchParams: Promise<InventoryCostingSearchParams> }) {
  await requireInventoryCostingReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryCostingFiltersFromSearch(resolvedSearchParams)
  const [rawReport, filterOptions, organisation] = await Promise.all([
    getInventoryTurnoverReport(filters).catch((error: unknown) => {
      if (error instanceof InventoryTurnoverSourceLimitError) return emptyInventoryTurnoverReportForSourceLimit(filters, error)
      throw error
    }),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const report = rawReport
  const currency = organisation.baseCurrency
  const blankMetric = '-'
  const columns: Array<InventoryCostingColumn<InventoryTurnoverReportRow>> = [
    {
      key: 'group',
      label: 'Group',
      render: (row) => row.productId && row.sku
        ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName ?? row.groupLabel} />
        : <span className="font-medium">{row.groupLabel}</span>,
      footer: 'Totals',
    },
    {
      key: 'cogs',
      label: `Sales COGS (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.cogsBase), currency),
      footer: formatMoneyCode(Number(report.totals.cogsBase), currency),
    },
    {
      key: 'averageInventoryValue',
      label: `Avg inventory (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.averageInventoryValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.averageInventoryValueBase), currency),
    },
    {
      key: 'turnover',
      label: 'Turnover',
      align: 'right',
      render: (row) => row.turnoverRatio ?? blankMetric,
      footer: report.totals.turnoverRatio ?? blankMetric,
    },
    {
      key: 'dio',
      label: 'DIO',
      align: 'right',
      render: (row) => row.daysInventoryOutstanding ?? blankMetric,
      footer: report.totals.daysInventoryOutstanding ?? blankMetric,
    },
    { key: 'cogsEntries', label: 'COGS rows', align: 'right', render: (row) => row.cogsEntryCount, footer: report.totals.cogsEntryCount },
    { key: 'snapshotDays', label: 'Snapshot days', align: 'right', render: (row) => `${row.snapshotDayCount}/${report.periodDays}`, footer: `${report.totals.snapshotDayCount}/${report.periodDays}` },
  ]

  return (
    <InventoryCostingReportPage
      title="Inventory Turnover"
      description="Sales COGS divided by average daily inventory value from inventory snapshots, with days-inventory-outstanding for each group."
      reportKey="inventory-turnover"
      filters={inventoryCostingFiltersForUi({ ...filters, groupBy: report.groupBy })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.groupKey}
      columns={columns}
      summary={[
        { label: `Sales COGS (${currency})`, value: formatMoneyCode(Number(report.totals.cogsBase), currency) },
        { label: `Avg inventory (${currency})`, value: formatMoneyCode(Number(report.totals.averageInventoryValueBase), currency) },
        { label: 'Turnover', value: report.totals.turnoverRatio ?? blankMetric },
        { label: 'DIO', value: report.totals.daysInventoryOutstanding ?? blankMetric },
        { label: 'Period days', value: String(report.periodDays) },
        { label: 'Snapshot days', value: `${report.totals.snapshotDayCount}/${report.periodDays}` },
      ]}
      notices={report.notices}
      dateMode="period"
      showGroupBy
      groupByOptions={INVENTORY_TURNOVER_GROUP_OPTIONS}
    />
  )
}
