import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { NextRequest } from 'next/server'

/**
 * o3d-s8n.3: the Ignore stockouts toggle reaches getReorderReport from every entry point, and without the
 * toggle every entry point passes exactly the filters it always did (so a report, a CSV and a draft PO are
 * unchanged until a user turns it on).
 */
const reportCalls: Array<Record<string, unknown>> = []
const emptyReport = {
  generatedAt: '2027-01-06T00:00:00.000Z', demandWindowDateFrom: '2026-10-09', demandWindowDateTo: '2027-01-06', rows: [],
  pageInfo: { page: 1, pageSize: 100, totalRows: 0, totalPages: 1 }, totals: { availableQty: '0', inboundOpenPoQty: '0', suggestedReorderQty: '0' }, notices: [],
}

mock.module('@/lib/domain/inventory/replenishment-reports', {
  namedExports: {
    getReorderReport: async (filters: Record<string, unknown>) => { reportCalls.push(filters); return emptyReport },
    getBackorderDemandReport: async () => emptyReport,
    getComponentShortageReport: async () => emptyReport,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { role: 'ADMIN' } }),
  },
})
mock.module('@/lib/security/replenishment-report-access', { namedExports: { canAccessReplenishmentReports: () => true } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/db', { namedExports: { db: { purchaseOrder: { findMany: async () => [] }, productionOrder: { findMany: async () => [] }, product: { findMany: async () => [] } } } })

test('draft PO generation passes ignoreStockouts through, and only the literal true', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  reportCalls.length = 0
  await createReorderPOs([], { filters: { thresholdDays: 60, ignoreStockouts: true } })
  assert.equal(reportCalls[0]!.ignoreStockouts, true)
  assert.equal(reportCalls[0]!.thresholdDays, 60)
  await createReorderPOs([], { filters: { thresholdDays: 60, ignoreStockouts: 'yes' as never } })
  assert.equal('ignoreStockouts' in reportCalls[1]!, false)
})

test('draft PO and MO generation without the toggle pass no ignoreStockouts key at all', async () => {
  const { createReorderPOs, createReorderMOs } = await import('@/app/actions/forecasting')
  reportCalls.length = 0
  await createReorderPOs([], { filters: { thresholdDays: 60 } })
  await createReorderPOs([])
  await createReorderMOs([], { filters: { thresholdDays: 60, ignoreStockouts: false } })
  assert.equal(reportCalls.length, 3)
  for (const call of reportCalls) assert.equal('ignoreStockouts' in call, false)
})

test('draft MO generation passes ignoreStockouts through', async () => {
  const { createReorderMOs } = await import('@/app/actions/forecasting')
  reportCalls.length = 0
  await createReorderMOs([], { filters: { ignoreStockouts: true } })
  assert.equal(reportCalls[0]!.ignoreStockouts, true)
})

test('CSV export reads ignoreStockouts=1 from the query and ignores anything else', async () => {
  const { GET } = await import('@/app/api/export/replenishment/route')
  reportCalls.length = 0
  await GET(new NextRequest('http://localhost/api/export/replenishment?type=reorder&ignoreStockouts=1&thresholdDays=30'))
  await GET(new NextRequest('http://localhost/api/export/replenishment?type=reorder&ignoreStockouts=true'))
  await GET(new NextRequest('http://localhost/api/export/replenishment?type=reorder'))
  assert.equal(reportCalls[0]!.ignoreStockouts, true)
  assert.equal(reportCalls[0]!.thresholdDays, 30)
  assert.equal(reportCalls[0]!.includeZero, true)
  assert.equal('ignoreStockouts' in reportCalls[1]!, false)
  assert.equal('ignoreStockouts' in reportCalls[2]!, false)
})

test('the demand chart route carries the toggle from searchParams and omits it when off', async () => {
  const { chartFiltersFromSearch } = await import('@/app/(dashboard)/analytics/reorder/[productId]/chart-params')
  assert.equal(chartFiltersFromSearch({ ignoreStockouts: '1' }).ignoreStockouts, true)
  assert.equal('ignoreStockouts' in chartFiltersFromSearch({ ignoreStockouts: '0' }), false)
  assert.equal('ignoreStockouts' in chartFiltersFromSearch({}), false)
})
