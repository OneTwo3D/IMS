import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import type { SlowStockFilters, SlowStockReport } from '@/lib/domain/inventory/slow-stock-report'
import { InventoryHealthSourceLimitError } from '@/lib/domain/inventory/inventory-health-reports'

const row = {
  productId: 'p1', warehouseId: null, sku: 'SKU-1', productName: 'Widget', productType: 'SIMPLE' as const, categoryName: null,
  supplierNames: ['A', 'B'], warehouseCode: 'All', stockUnit: 'pcs', qty: '15', valueBase: '37.5',
  oldestLayerAt: '2025-06-01T00:00:00.000Z', oldestLayerAgeDays: 543, ageBand: '365+', lastSaleAt: null, daysSinceLastSale: null,
  soldQtyInWindow: '0', ratePer30Days: '0', monthsOfCover: null,
}

function report(includeCost: boolean): SlowStockReport {
  return {
    generatedAt: '2026-11-26T10:00:00.000Z', rateWindowDays: 90, rateWindowDateFrom: '2026-08-29', rateWindowDateTo: '2026-11-26',
    perWarehouse: false, costVisible: includeCost,
    rows: [{ ...row, valueBase: includeCost ? row.valueBase : null }],
    pageInfo: { page: 1, pageSize: 1, totalRows: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
    totals: { rows: 1, qty: '15', valueBase: includeCost ? '37.5' : null }, bandSummary: [], notices: [],
  }
}

async function exportFor(role: string, query = '') {
  const { getStockPositionExportResponse } = await import('../../app/api/export/stock-position/route.ts')
  const seen: SlowStockFilters[] = []
  const response = await getStockPositionExportResponse(new NextRequest(`http://localhost/api/export/stock-position?type=slow-stock${query}`), {
    requireApiAuth: async () => ({ user: { id: 'u1', role } }) as never,
    accessDenied: () => null as NextResponse | null,
    getSlowStockReport: async (filters: SlowStockFilters = {}) => { seen.push(filters); return report(filters.includeCost === true) },
    loadMpnByProductId: async () => new Map([['p1', 'MPN-1']]),
  })
  return { response, seen, text: await response.text() }
}

test('slow-stock CSV carries the value column and passes filters for a role that can see costs', async () => {
  const { response, seen, text } = await exportFor('FINANCE', '&minAgeDays=180&noSaleDays=90&minValue=10&perWarehouse=1')
  assert.equal(response.status, 200)
  assert.ok((response.headers.get('Content-Disposition') ?? '').includes('slow-stock-'))
  const [header, line] = text.split('\r\n')
  assert.ok(header.split(',').includes('valueBase'))
  assert.ok(line.includes('37.5') && line.includes('MPN-1') && line.includes('A; B'))
  assert.deepEqual([seen[0].includeCost, seen[0].minAgeDays, seen[0].noSaleDays, seen[0].minValueBase, seen[0].perWarehouse], [true, 180, 90, '10', true])
})

test('slow-stock CSV drops the value column and ignores the value filter for roles without inventory.prices', async () => {
  for (const role of ['WAREHOUSE', 'READONLY']) {
    const { seen, text } = await exportFor(role, '&minValue=10')
    assert.ok(!text.split('\r\n')[0].split(',').includes('valueBase'), role)
    assert.ok(!text.includes('37.5'), `${role}: no cost figure in the file`)
    assert.equal(seen[0].includeCost, false)
    assert.equal(seen[0].minValueBase, undefined)
  }
})

test('slow-stock CSV is the not-computed file when the source scan limit is hit', async () => {
  const { getStockPositionExportResponse } = await import('../../app/api/export/stock-position/route.ts')
  const response = await getStockPositionExportResponse(new NextRequest('http://localhost/api/export/stock-position?type=slow-stock'), {
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) as never,
    accessDenied: () => null as NextResponse | null,
    getSlowStockReport: async () => { throw new InventoryHealthSourceLimitError(100000, 'stock-level scan') },
  })
  assert.equal(response.headers.get('X-IMS-Report-Not-Computed'), '1')
  const lines = (await response.text()).split('\r\n')
  assert.ok(lines[0].startsWith('sku,mpn,') && lines[0].includes('valueBase'))
  assert.match(lines[1], /^REPORT NOT COMPUTED,/)
})
