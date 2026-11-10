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

test('the COGS export refuses a source-limit hit with 413 and the row-limit body, not a 500', async () => {
  const response = await getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=cogs'),
    { ...deps, getCogsReport: async () => { throw limitError } },
  )
  assert.equal(response.status, 413)
  const body = await response.json() as { error: string; rowLimit: number; reportNotComputed: boolean }
  assert.match(body.error, /^This report hit its row limit \(100,000 rows\)/)
  assert.equal(body.rowLimit, 100000)
  assert.equal(body.reportNotComputed, true)
})

test('the COGS export still rethrows an unrelated failure', async () => {
  await assert.rejects(() => getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=cogs'),
    { ...deps, getCogsReport: async () => { throw new Error('database unavailable') } },
  ), /database unavailable/)
})

test('the turnover export also refuses any source-limit error with 413', async () => {
  const response = await getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=inventory-turnover'),
    { ...deps, getInventoryTurnoverReport: async () => { throw limitError } },
  )
  assert.equal(response.status, 413)
})

test('the COGS and turnover page fallbacks are not-computed reports carrying the row-limit notice', () => {
  for (const report of [emptyCogsReportForSourceLimit({}, limitError), emptyInventoryTurnoverReportForSourceLimit({}, limitError)]) {
    assert.deepEqual(report.rows, [])
    assert.equal(report.notices.length, 1)
    assert.match(report.notices[0], /^This report hit its row limit \(100,000 rows\); narrow the date range or filters\./)
  }
})
