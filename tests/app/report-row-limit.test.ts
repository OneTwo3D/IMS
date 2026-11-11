import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SourceScanTooLargeError, hasSourceLimitNotice, isSourceLimitNotice, sourceLimitExportBody, sourceLimitNotice, withoutSourceLimitNotices,
} from '@/lib/security/source-scan-error'

mock.module('next/link', {
  defaultExport: ({ children, href }: { children?: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
})
mock.module('@/lib/page-title', { namedExports: { PageTitle: ({ title }: { title: string }) => React.createElement('h1', null, title) } })
mock.module('@/components/ui/tooltip', {
  namedExports: {
    Tooltip: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
    TooltipTrigger: ({ children }: { children?: React.ReactNode }) => React.createElement('button', null, children),
    TooltipContent: ({ children }: { children?: React.ReactNode }) => React.createElement('span', { 'data-tooltip': true }, children),
  },
})

const error = new SourceScanTooLargeError('Sales analytics source orders', 50000, { rowCount: 50001 })

test('the row-limit notice says what happened and what to do, and is recognisable', () => {
  const notice = sourceLimitNotice(error)
  assert.match(notice, /^This report hit its row limit \(50,000 rows\); narrow the date range or filters\./)
  assert.ok(notice.includes('Sales analytics source orders exceed 50,000'), 'keeps the detail of which source')
  assert.equal(isSourceLimitNotice(notice), true)
  assert.equal(isSourceLimitNotice('Rounded to 2 dp.'), false)
  assert.equal(hasSourceLimitNotice(['Rounded to 2 dp.', notice]), true)
  assert.deepEqual(withoutSourceLimitNotices(['a', notice]), ['a'])
})

test('CSV exports refuse a limit-hit report with a row-limit body instead of emitting zeros', () => {
  const body = sourceLimitExportBody(error)
  assert.equal(body.reportNotComputed, true)
  assert.equal(body.rowLimit, 50000)
  assert.match(body.error, /^This report hit its row limit/)
})

test('a sales report that hit the limit renders an alert, dashes and "not computed", never zeros or "No rows"', async () => {
  const { emptySalesAnalyticsReportForSourceLimit } = await import('@/lib/domain/sales/sales-fulfillment-analytics')
  const { SalesAnalyticsReportPage } = await import('@/app/(dashboard)/analytics/_components/sales-analytics-report')
  const report = emptySalesAnalyticsReportForSourceLimit<{ key: string }>({}, error, { revenue: '0.00' })
  assert.ok(hasSourceLimitNotice(report.notices))

  const html = renderToStaticMarkup(
    React.createElement(SalesAnalyticsReportPage<{ key: string }>, {
      title: 'Sales Analytics',
      description: 'd',
      reportKey: 'sales',
      filters: {},
      pageInfo: report.pageInfo,
      rows: report.rows,
      rowKey: (r) => r.key,
      columns: [{ key: 'k', label: 'K', render: (r) => r.key }],
      summary: [{ label: 'Invoiced revenue', value: report.totals.revenue }],
      notices: report.notices,
    }),
  )
  assert.match(html, /role="alert"/)
  assert.match(html, /This report hit its row limit \(50,000 rows\); narrow the date range or filters\./)
  assert.match(html, /Report not computed/)
  assert.ok(!html.includes('No rows for the selected filters'), 'no "No rows" claim')
  assert.ok(!html.includes('>0.00<'), 'no zero revenue tile')
  assert.ok(!/>0 rows</.test(html) && !/Page \d+ of/.test(html), 'no row or page count')
  assert.match(html, />—</, 'the tile shows a dash')
})

test('a normal empty report still says "No rows" and shows its figures', async () => {
  const { SalesAnalyticsReportPage } = await import('@/app/(dashboard)/analytics/_components/sales-analytics-report')
  const html = renderToStaticMarkup(
    React.createElement(SalesAnalyticsReportPage<{ key: string }>, {
      title: 'Sales Analytics', description: 'd', reportKey: 'sales', filters: {},
      pageInfo: { page: 1, pageSize: 100, totalRows: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      rows: [], rowKey: (r) => r.key, columns: [{ key: 'k', label: 'K', render: (r) => r.key }],
      summary: [{ label: 'Invoiced revenue', value: '0.00' }], notices: ['Rounded to 2 dp.'],
    }),
  )
  assert.ok(!html.includes('role="alert"'))
  assert.match(html, /No rows for the selected filters/)
  assert.ok(html.includes('>0.00<'))
})

mock.module('@/app/(dashboard)/analytics/_components/stock-position-filter-combobox', {
  namedExports: { StockPositionFilterCombobox: () => null },
})

test('a not-computed stock-position report (aging, dead stock) shows dashes, not zero totals, in numeric footers', async () => {
  const { StockPositionReportPage } = await import('@/app/(dashboard)/analytics/_components/stock-position-report')
  const render = (notices: string[]) => renderToStaticMarkup(
    React.createElement(StockPositionReportPage<{ key: string }>, {
      title: 'Inventory Aging', description: 'd', reportKey: 'inventory-aging', filters: {},
      filterOptions: { warehouses: [], categories: [], suppliers: [], productTypes: [] } as never,
      pageInfo: { page: 1, pageSize: 100, totalRows: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      rows: [], rowKey: (r) => r.key, dateMode: 'none', notices,
      columns: [{ key: 'v', label: 'Value', align: 'right', render: () => null, footer: '0.00' }],
      summary: [],
    }),
  )
  const limited = render([sourceLimitNotice(error)])
  assert.ok(!limited.includes('0.00'), 'no zero footer when not computed')
  assert.ok(!/>0 rows</.test(limited) && !/Page \d+ of/.test(limited), 'no row or page count when not computed')
  assert.match(limited, /Report not computed/)
  assert.ok(render([]).includes('0.00'), 'a computed report still shows its footer')
})

test('a not-computed inventory-costing report (COGS, turnover) shows dashes in footers and no row or page count', async () => {
  const { InventoryCostingReportPage } = await import('@/app/(dashboard)/analytics/_components/inventory-costing-report')
  const render = (notices: string[]) => renderToStaticMarkup(
    React.createElement(InventoryCostingReportPage<{ key: string }>, {
      title: 'COGS', description: 'd', reportKey: 'cogs', filters: {},
      filterOptions: { warehouses: [], categories: [], suppliers: [], productTypes: [] } as never,
      pageInfo: { page: 1, pageSize: 100, totalRows: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      rows: [], rowKey: (r) => r.key, dateMode: 'period', notices,
      columns: [{ key: 'v', label: 'Value', align: 'right', render: () => null, footer: '0.00' }],
      summary: [],
    }),
  )
  const limited = render([sourceLimitNotice(error)])
  assert.ok(!limited.includes('0.00'), 'no zero footer')
  assert.ok(!/>0 rows</.test(limited) && !/Page \d+ of/.test(limited), 'no row or page count')
  assert.match(limited, /Report not computed/)
  const normal = render([])
  assert.ok(normal.includes('0.00') && /Page 1 of 1/.test(normal) && />0 rows</.test(normal), 'a computed report keeps them')
})
