import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getLandedCostReport,
  inventoryCostingFiltersForUi,
  inventoryCostingFiltersFromSearch,
  type InventoryCostingSearchParams,
  type LandedCostReportRow,
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

export const metadata: Metadata = { title: 'Landed Cost Analysis' }

export default async function LandedCostPage({ searchParams }: { searchParams: Promise<InventoryCostingSearchParams> }) {
  await requireInventoryCostingReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryCostingFiltersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getLandedCostReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryCostingColumn<LandedCostReportRow>> = [
    {
      key: 'po',
      label: 'PO',
      render: (row) => <Link href={`/purchase-orders/${row.poId}`} className="font-medium text-primary hover:underline">{row.poReference}</Link>,
      footer: 'Totals',
    },
    {
      key: 'product',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
    },
    { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
    { key: 'method', label: 'Method', render: (row) => row.landedCostMethod },
    { key: 'qty', label: 'Qty', align: 'right', render: (row) => row.qty, footer: report.totals.qty },
    {
      key: 'goods',
      label: `Goods value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.goodsValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.goodsValueBase), currency),
    },
    {
      key: 'landed',
      label: `Landed value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.landedValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.landedValueBase), currency),
    },
    {
      key: 'uplift',
      label: 'Uplift',
      align: 'right',
      render: (row) => row.landedUpliftPct == null
        ? formatMoneyCode(Number(row.landedUpliftUnitBase), currency)
        : `${formatMoneyCode(Number(row.landedUpliftUnitBase), currency)} / ${row.landedUpliftPct}%`,
    },
    { key: 'revaluations', label: 'Revaluations', align: 'right', render: (row) => row.revaluationCount },
  ]

  return (
    <InventoryCostingReportPage
      title="Landed Cost Analysis"
      description="Purchase-order landed cost uplift by SKU, supplier, and allocation method, including retrospective revaluation evidence."
      reportKey="landed-cost"
      filters={inventoryCostingFiltersForUi(filters)}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.poId}:${row.productId}:${index}`}
      columns={columns}
      summary={[
        { label: `Goods value (${currency})`, value: formatMoneyCode(Number(report.totals.goodsValueBase), currency) },
        { label: `Landed value (${currency})`, value: formatMoneyCode(Number(report.totals.landedValueBase), currency) },
        { label: `Uplift (${currency})`, value: formatMoneyCode(Number(report.totals.upliftBase), currency), tone: Number(report.totals.upliftBase) > 0 ? 'warning' : 'default' },
        { label: 'Revaluation runs', value: String(report.totals.revaluationRuns) },
      ]}
      notices={report.notices}
      dateMode="period"
      showLandedCostMethod
    />
  )
}
