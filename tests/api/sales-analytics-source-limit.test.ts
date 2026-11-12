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

test('the sales-analytics export refuses a source-limit hit with 413 and the row-limit body', async () => {
  const { GET } = await import('../../app/api/export/sales-analytics/route.ts')
  const response = await GET(new NextRequest('http://localhost/api/export/sales-analytics?report=sales'))
  assert.equal(response.status, 413)
  const body = await response.json() as { error: string; rowLimit: number; reportNotComputed: boolean }
  assert.match(body.error, /^This report hit its row limit \(50,000 rows\)/)
  assert.equal(body.rowLimit, 50000)
  assert.equal(body.reportNotComputed, true)
})
