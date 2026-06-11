import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'
import {
  financeAnalyticsEmptyTotals,
  loadVatReportForPage,
} from '@/app/(dashboard)/analytics/_components/finance-analytics-page-utils'
import {
  getArAgingReport,
  getCurrencySummaryReport,
} from '@/lib/domain/finance/finance-period-analytics'
import {
  loadSalesReportForPage,
  salesAnalyticsEmptyTotals,
} from '@/app/(dashboard)/analytics/_components/sales-analytics-page-utils'
import {
  loadOpenPurchaseOrdersReportForPage,
  purchasingAnalyticsEmptyTotals,
} from '@/app/(dashboard)/analytics/_components/purchasing-analytics-page-utils'

type ExactKeys<Actual, Expected> =
  Exclude<keyof Actual, keyof Expected> extends never
    ? Exclude<keyof Expected, keyof Actual> extends never
      ? true
      : never
    : never

const arAgingEmptyTotalsKeysMatchReportTotals: ExactKeys<
  typeof financeAnalyticsEmptyTotals.arAging,
  Awaited<ReturnType<typeof getArAgingReport>>['totals']
> = true

const currencySummaryEmptyTotalsKeysMatchReportTotals: ExactKeys<
  typeof financeAnalyticsEmptyTotals.currencySummary,
  Awaited<ReturnType<typeof getCurrencySummaryReport>>['totals']
> = true

test('finance analytics page loaders return typed empty reports for source scan limits', async () => {
  const report = await loadVatReportForPage(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30', page: 2, pageSize: 100 },
    async () => {
      throw new SourceScanTooLargeError('VAT report source rows', 50000)
    },
  )

  assert.deepEqual(report.rows, [])
  assert.deepEqual(report.totals, financeAnalyticsEmptyTotals.vat)
  assert.equal(report.pageInfo.totalRows, 0)
  assert.equal(report.notices[0], 'VAT report source rows exceed 50,000; Narrow the filters and retry.')
})

test('finance empty totals keys match report totals types', () => {
  assert.equal(arAgingEmptyTotalsKeysMatchReportTotals, true)
  assert.equal(currencySummaryEmptyTotalsKeysMatchReportTotals, true)
})

test('sales analytics page loaders return typed empty reports for source scan limits', async () => {
  const report = await loadSalesReportForPage(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30', pageSize: 100 },
    async () => {
      throw new SourceScanTooLargeError('Sales analytics source orders', 50000)
    },
  )

  assert.deepEqual(report.rows, [])
  assert.deepEqual(report.totals, salesAnalyticsEmptyTotals.sales)
  assert.equal(report.notices[0], 'Sales analytics source orders exceed 50,000; Narrow the filters and retry.')
})

test('purchasing analytics page loaders return typed empty reports for source scan limits', async () => {
  const report = await loadOpenPurchaseOrdersReportForPage(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30', pageSize: 100 },
    async () => {
      throw new SourceScanTooLargeError('Open purchase order source rows', 50000)
    },
  )

  assert.deepEqual(report.rows, [])
  assert.deepEqual(report.totals, purchasingAnalyticsEmptyTotals.openPurchaseOrders)
  assert.equal(report.notices[0], 'Open purchase order source rows exceed 50,000; Narrow the filters and retry.')
})

test('analytics page loaders rethrow non-source-limit errors', async () => {
  const error = new Error('database unavailable')

  await assert.rejects(
    () => loadSalesReportForPage({}, async () => {
      throw error
    }),
    error,
  )
})
