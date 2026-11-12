import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { ManufacturingAnalyticsSourceLimitError } from '@/lib/domain/manufacturing/manufacturing-analytics'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

const limitError = new SourceScanTooLargeError('Report source rows', 50000, { rowCount: 50001 })
const boom = async () => { throw limitError }

mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) } })
mock.module('@/lib/db', { namedExports: { db: { product: { findMany: async () => [] } } } })
mock.module('@/lib/security/purchasing-analytics-access', { namedExports: { canAccessPurchasingAnalytics: () => true } })
mock.module('@/lib/security/finance-analytics-access', { namedExports: { canAccessFinanceAnalytics: () => true } })
mock.module('@/lib/security/replenishment-report-access', { namedExports: { canAccessReplenishmentReports: () => true } })
mock.module('@/lib/security/manufacturing-analytics-access', { namedExports: { canAccessManufacturingAnalytics: () => true } })
mock.module('@/lib/domain/purchasing/purchasing-analytics', {
  namedExports: { getOpenPurchaseOrdersReport: boom, getSupplierPerformanceReport: boom, getPurchasePriceVarianceReport: boom, getSpendReport: boom, getLeadTimeReport: boom },
})
mock.module('@/lib/domain/finance/finance-period-analytics', {
  namedExports: { getVatReport: boom, getArAgingReport: boom, getApAgingReport: boom, getCurrencySummaryReport: boom, getFxGainLossReport: boom },
})
mock.module('@/lib/domain/inventory/replenishment-reports', {
  namedExports: { getReorderReport: boom, getBackorderDemandReport: boom, getComponentShortageReport: boom },
})
mock.module('@/lib/domain/manufacturing/manufacturing-analytics', {
  namedExports: { getProductionVarianceReport: async () => { throw new ManufacturingAnalyticsSourceLimitError('too many') }, getWipReport: async () => { throw new ManufacturingAnalyticsSourceLimitError('too many') }, ManufacturingAnalyticsSourceLimitError },
})

async function assertNotComputed(response: Response, firstColumn: string, filenameStem: string, limit = '50000') {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/csv/)
  assert.ok((response.headers.get('Content-Disposition') ?? '').includes(`filename="${filenameStem}-`), 'usual filename')
  assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
  assert.equal(response.headers.get('X-IMS-Report-Row-Limit'), limit)
  assert.ok(response.headers.get('X-IMS-Export-Metadata'), 'the existing metadata header is reused')
  const lines = (await response.text()).split('\r\n')
  assert.equal(lines.length, 2, 'header row and the one notice row only')
  assert.ok(lines[0].startsWith(`${firstColumn},`), lines[0])
  assert.match(lines[1], /^REPORT NOT COMPUTED,"?This report hit its row limit/)
}

test('purchasing exports return the not-computed CSV for every report', async () => {
  const { GET } = await import('../../app/api/export/purchasing-analytics/route.ts')
  const first: Record<string, string> = { 'open-pos': 'reference', 'supplier-performance': 'supplierName', ppv: 'supplierName', spend: 'period', 'lead-times': 'supplierName' }
  for (const [report, col] of Object.entries(first)) {
    await assertNotComputed(await GET(new NextRequest(`http://localhost/api/export/purchasing-analytics?report=${report}`)), col, report)
  }
})

test('finance exports return the not-computed CSV for every report', async () => {
  const { GET } = await import('../../app/api/export/finance-analytics/route.ts')
  const first: Record<string, string> = { vat: 'side', 'ar-aging': 'partyName', 'ap-aging': 'partyName', 'currency-summary': 'currency', 'fx-gain-loss': 'side' }
  for (const [report, col] of Object.entries(first)) {
    await assertNotComputed(await GET(new NextRequest(`http://localhost/api/export/finance-analytics?report=${report}`)), col, report)
  }
})

test('replenishment exports return the not-computed CSV for every report', async () => {
  const { GET } = await import('../../app/api/export/replenishment/route.ts')
  for (const type of ['reorder', 'backorder', 'component-shortage']) {
    await assertNotComputed(await GET(new NextRequest(`http://localhost/api/export/replenishment?type=${type}`)), 'sku', type)
  }
})

test('manufacturing exports return the not-computed CSV (also with ?metadata=1, without a second notice block)', async () => {
  const { GET } = await import('../../app/api/export/manufacturing-analytics/route.ts')
  for (const report of ['production-variance', 'wip']) {
    await assertNotComputed(await GET(new NextRequest(`http://localhost/api/export/manufacturing-analytics?report=${report}&metadata=1`)), 'productionOrderReference', report, String(new ManufacturingAnalyticsSourceLimitError('x').limit))
  }
})

test('stock-position exports return the not-computed CSV for the health reports', async () => {
  const { getStockPositionExportResponse } = await import('../../app/api/export/stock-position/route.ts')
  const { InventoryHealthSourceLimitError } = await import('@/lib/domain/inventory/inventory-health-reports')
  const deps = {
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) as never,
    accessDenied: () => null as NextResponse | null,
    getInventoryAgingReport: async () => { throw new InventoryHealthSourceLimitError(50000, 'rows') },
    getDeadStockReport: async () => { throw new InventoryHealthSourceLimitError(50000, 'rows') },
  }
  for (const type of ['inventory-aging', 'dead-stock']) {
    const response = await getStockPositionExportResponse(new NextRequest(`http://localhost/api/export/stock-position?type=${type}`), deps)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
    assert.ok((response.headers.get('Content-Disposition') ?? '').includes(`filename="${type}-`))
    const lines = (await response.text()).split('\r\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[0].startsWith('sku,mpn,'))
    assert.match(lines[1], /^REPORT NOT COMPUTED,/)
  }
})
