import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { getInventoryCostingExportResponse } from '../../app/api/export/inventory-costing/route.ts'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { emptyCogsReportForSourceLimit, emptyInventoryTurnoverReportForSourceLimit } from '@/lib/domain/inventory/inventory-costing-reports'

const deps = {
  requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) as never,
  accessDenied: () => null as NextResponse | null,
}
const limitError = new SourceScanTooLargeError('COGS report refund source rows', 100000, { rowCount: 100001 })

test('the COGS export returns a REPORT NOT COMPUTED CSV on a source-limit hit, not a 413 or a 500', async () => {
  const response = await getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=cogs'),
    { ...deps, getCogsReport: async () => { throw limitError } },
  )
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/csv/)
  assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
  assert.equal(response.headers.get('X-IMS-Report-Row-Limit'), '100000')
  const lines = (await response.text()).split('\r\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].startsWith('groupLabel,sku,mpn,'))
  assert.ok(lines[0].endsWith(',revenueCaptured'), lines[0])
  assert.match(lines[1], /^REPORT NOT COMPUTED,"?This report hit its row limit \(100,000 rows\)/)
})

test('the COGS export still rethrows an unrelated failure', async () => {
  await assert.rejects(() => getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=cogs'),
    { ...deps, getCogsReport: async () => { throw new Error('database unavailable') } },
  ), /database unavailable/)
})

test('the turnover export also returns a REPORT NOT COMPUTED CSV for any source-limit error', async () => {
  const response = await getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=inventory-turnover'),
    { ...deps, getInventoryTurnoverReport: async () => { throw limitError } },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
  const lines = (await response.text()).split('\r\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].startsWith('groupLabel,sku,mpn,'))
  assert.ok(lines[0].endsWith(',snapshotDayCount'), lines[0])
  assert.ok(lines[1].startsWith('REPORT NOT COMPUTED,'))
})

test('the COGS and turnover page fallbacks are not-computed reports carrying the row-limit notice', () => {
  for (const report of [emptyCogsReportForSourceLimit({}, limitError), emptyInventoryTurnoverReportForSourceLimit({}, limitError)]) {
    assert.deepEqual(report.rows, [])
    assert.equal(report.notices.length, 1)
    assert.match(report.notices[0], /^This report hit its row limit \(100,000 rows\); narrow the date range or filters\./)
  }
})
