import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextRequest } from 'next/server'

import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) } })
mock.module('@/lib/domain/sales/sales-fulfillment-analytics', {
  namedExports: {
    getSalesAnalyticsReport: async () => { throw new SourceScanTooLargeError('Sales analytics source orders', 50000, { rowCount: 50001 }) },
    getCustomerAnalyticsReport: async () => ({}),
    getMarginAnalyticsReport: async () => ({}),
    getReturnsAnalyticsReport: async () => ({}),
    getFulfillmentAnalyticsReport: async () => ({}),
    getThroughputAnalyticsReport: async () => ({}),
  },
})

test('the sales-analytics export returns a CSV with the header row and a REPORT NOT COMPUTED row on a source-limit hit, not a 413', async () => {
  const { GET } = await import('../../app/api/export/sales-analytics/route.ts')
  const response = await GET(new NextRequest('http://localhost/api/export/sales-analytics?report=sales'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/csv/)
  assert.match(response.headers.get('Content-Disposition') ?? '', /filename="sales-analytics-\d{4}-\d{2}-\d{2}\.csv"/)
  assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
  assert.equal(response.headers.get('X-IMS-Report-Row-Limit'), '50000')
  const lines = (await response.text()).split('\r\n')
  assert.equal(lines.length, 2, 'header row plus the one notice row, no data rows or totals')
  assert.ok(lines[0].startsWith('key,label,groupBy,currency,'))
  assert.ok(lines[0].endsWith(',refundsUnknownBasis'), lines[0])
  assert.match(lines[1], /^REPORT NOT COMPUTED,"?This report hit its row limit \(50,000 rows\)/)
})
