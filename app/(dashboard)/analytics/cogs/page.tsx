import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getCogsReport,
  inventoryCostingFiltersForUi,
  inventoryCostingFiltersFromSearch,
  type CogsReportRow,
  type InventoryCostingSearchParams,
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

export const metadata: Metadata = { title: 'COGS Report' }

export default async function CogsPage({ searchParams }: { searchParams: Promise<InventoryCostingSearchParams> }) {
  await requireInventoryCostingReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryCostingFiltersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getCogsReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryCostingColumn<CogsReportRow>> = [
    {
      key: 'group',
      label: 'Group',
      render: (row) => row.productId && row.sku
        ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName ?? row.groupLabel} />
        : <span className="font-medium">{row.groupLabel}</span>,
      footer: 'Totals',
    },
    { key: 'qty', label: 'Qty', align: 'right', render: (row) => row.qty, footer: report.totals.qty },
    {
      key: 'cogs',
      label: `COGS (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.cogsBase), currency),
      footer: formatMoneyCode(Number(report.totals.cogsBase), currency),
    },
    {
      key: 'revenue',
      label: `Revenue (${currency})`,
      align: 'right',
      render: (row) => row.revenueBase == null ? 'Unmatched' : formatMoneyCode(Number(row.revenueBase), currency),
      footer: formatMoneyCode(Number(report.totals.revenueBase), currency),
    },
    {
      key: 'margin',
      label: `Margin (${currency})`,
      align: 'right',
      render: (row) => row.grossMarginBase == null ? 'Unmatched' : formatMoneyCode(Number(row.grossMarginBase), currency),
      footer: formatMoneyCode(Number(report.totals.grossMarginBase), currency),
    },
    { key: 'marginPct', label: 'Margin %', align: 'right', render: (row) => row.grossMarginPct == null ? 'Unmatched' : `${row.grossMarginPct}%` },
    { key: 'movements', label: 'Movements', align: 'right', render: (row) => row.movementCount },
  ]

  return (
    <InventoryCostingReportPage
      title="COGS Report"
      description="Cost of goods sold grouped by product, category, warehouse, customer, or channel. Revenue and margin are shown only where sales movement references match cleanly."
      reportKey="cogs"
      filters={inventoryCostingFiltersForUi({ ...filters, groupBy: report.groupBy })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.groupKey}
      columns={columns}
      summary={[
        { label: `COGS (${currency})`, value: formatMoneyCode(Number(report.totals.cogsBase), currency) },
        { label: `Revenue (${currency})`, value: formatMoneyCode(Number(report.totals.revenueBase), currency) },
        { label: `Gross margin (${currency})`, value: formatMoneyCode(Number(report.totals.grossMarginBase), currency) },
        { label: 'Revenue matched rows', value: `${report.totals.revenueCapturedRows}/${report.pageInfo.totalRows}` },
      ]}
      notices={report.notices}
      dateMode="period"
      showGroupBy
    />
  )
}
