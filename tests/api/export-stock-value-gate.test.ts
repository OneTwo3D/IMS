import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

// The getters here are fakes that ALWAYS return value figures, so the assertions prove the export itself drops the value columns
// (and passes includeCost=false to the report) for roles without inventory.prices, not that a fake happened to omit them.
const SENTINEL = '98765.43'
const pageInfo = { page: 1, pageSize: 1, totalRows: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }
const NO_VALUE_ROLES = ['WAREHOUSE', 'READONLY']
const VALUE_ROLES = ['ADMIN', 'MANAGER', 'FINANCE']

const base = { productId: 'p1', sku: 'SKU-1', productName: 'Widget', productType: 'SIMPLE', categoryName: null, supplierNames: [], warehouseId: 'w1', warehouseCode: 'WH1', warehouseName: 'Main', stockUnit: 'pcs' }

const stockPositionDeps = (seen: Array<{ includeCost?: boolean }>) => ({
  accessDenied: () => null as NextResponse | null,
  loadMpnByProductId: async () => new Map([['p1', 'MPN-1']]),
  getStockOnHandReport: async (filters: { includeCost?: boolean } = {}) => {
    seen.push(filters)
    return {
      asOf: 'x', source: 'x', generatedAt: 'x', pageInfo,
      rows: [{ ...base, quantity: '1', reservedQty: '0', availableQty: '1', reservationQtySource: 'current', reservationSnapshotDate: null, reservationSourceCount: null, unitCostBase: SENTINEL, totalValueBase: SENTINEL }],
    }
  },
  getInventoryAgingReport: async (filters: { includeCost?: boolean } = {}) => {
    seen.push(filters)
    return { pageInfo, rows: [{ ...base, bucket: '0-30', minAgeDays: 0, maxAgeDays: 30, qty: '1', valueBase: SENTINEL, source: 'cost_layer' }] }
  },
  getDeadStockReport: async (filters: { includeCost?: boolean } = {}) => {
    seen.push(filters)
    return { pageInfo, rows: [{ ...base, qty: '1', valueBase: SENTINEL, daysSinceLastSale: 100, lastSaleAt: null, firstStockedAt: null }] }
  },
})

async function stockPositionExport(role: string, type: string) {
  const { getStockPositionExportResponse } = await import('../../app/api/export/stock-position/route.ts')
  const seen: Array<{ includeCost?: boolean }> = []
  const response = await getStockPositionExportResponse(new NextRequest(`http://localhost/api/export/stock-position?type=${type}`), {
    requireApiAuth: async () => ({ user: { id: 'u1', role } }) as never,
    ...stockPositionDeps(seen),
  } as never)
  return { seen, text: await response.text() }
}

for (const type of ['stock-on-hand', 'inventory-aging', 'dead-stock']) {
  test(`${type} export has no value columns for WAREHOUSE and READONLY`, async () => {
    for (const role of NO_VALUE_ROLES) {
      const { seen, text } = await stockPositionExport(role, type)
      const header = text.split('\r\n')[0]!.split(',')
      assert.ok(header.includes('sku'), role)
      assert.ok(!header.some((column) => /value|unitcost/i.test(column)), `${role}: ${header.join(',')}`)
      assert.ok(!text.includes(SENTINEL), `${role}: no cost figure in the file`)
      assert.equal(seen[0]!.includeCost, false, role)
    }
  })

  test(`${type} export keeps the value columns for inventory.prices roles`, async () => {
    for (const role of VALUE_ROLES) {
      const { seen, text } = await stockPositionExport(role, type)
      assert.ok(text.split('\r\n')[0]!.split(',').some((column) => /value/i.test(column)), role)
      assert.ok(text.includes(SENTINEL), role)
      assert.equal(seen[0]!.includeCost, true, role)
    }
  })
}

const ledgerRow = { id: 'm1', createdAt: 'x', type: 'ADJUSTMENT', ...base, qty: '1', signedQty: '1', unitCostBase: SENTINEL, totalValueBase: SENTINEL, signedValueBase: SENTINEL, referenceType: null, referenceId: null, note: null, reasonName: 'Damaged', reasonMatched: true }
const ledgerDeps = (seen: Array<{ includeCost?: boolean; minValue?: string }>) => ({
  accessDenied: () => null as NextResponse | null,
  getInventoryLedgerExportRowCount: async () => 1,
  loadMpnByProductId: async () => new Map<string, string>(),
  getStockMovementLedgerReport: async (filters: { includeCost?: boolean } = {}) => { seen.push(filters); return { rows: [ledgerRow], generatedAt: 'x', totals: {} } },
  getStockAdjustmentReport: async (filters: { includeCost?: boolean } = {}) => { seen.push(filters); return { rows: [ledgerRow], generatedAt: 'x', totals: {} } },
  getStockTransferReport: async (filters: { includeCost?: boolean } = {}) => {
    seen.push(filters)
    return { generatedAt: 'x', rows: [{ reference: 'TR-1', status: 'COMPLETED', fromWarehouseCode: 'A', fromWarehouseName: 'A', toWarehouseCode: 'B', toWarehouseName: 'B', dispatchedAt: null, completedAt: null, daysInTransit: 0, overdue: false, requestedQty: '1', receivedQty: '1', driftQty: '0', movementOutQty: '1', movementInQty: '1', movementValueBase: SENTINEL }] }
  },
  getStockCountReport: async (filters: { includeCost?: boolean } = {}) => {
    seen.push(filters)
    return { generatedAt: 'x', rows: [{ reference: 'SC-1', status: 'COMPLETED', warehouseCode: 'A', warehouseName: 'A', sku: 'S', productId: 'p1', expectedQty: '1', countedQty: '1', varianceQty: '0', linkedAdjustmentValueBase: SENTINEL, adjustmentEvidence: 'linked', completedAt: null }] }
  },
})

async function ledgerExport(role: string, report: string) {
  const { getInventoryLedgerExportResponse } = await import('../../app/api/export/inventory-ledger/route.ts')
  const seen: Array<{ includeCost?: boolean }> = []
  const response = await getInventoryLedgerExportResponse(new NextRequest(`http://localhost/api/export/inventory-ledger?report=${report}&minValue=10`), {
    requireApiAuth: async () => ({ user: { id: 'u1', role } }) as never,
    ...ledgerDeps(seen),
  } as never)
  return { seen, text: await response.text() }
}

for (const report of ['stock-movements', 'stock-adjustments', 'transfers', 'stock-counts']) {
  test(`${report} ledger export has no value columns for WAREHOUSE and READONLY`, async () => {
    for (const role of NO_VALUE_ROLES) {
      const { seen, text } = await ledgerExport(role, report)
      const header = text.split('\r\n')[0]!.split(',')
      assert.ok(header.length > 3, role)
      assert.ok(!header.some((column) => /value|unitcost/i.test(column)), `${role}: ${header.join(',')}`)
      assert.ok(!text.includes(SENTINEL), `${role}: no cost figure in the file`)
      assert.equal(seen[0]!.includeCost, false, role)
    }
  })

  test(`${report} ledger export keeps the value columns for inventory.prices roles`, async () => {
    for (const role of VALUE_ROLES) {
      const { seen, text } = await ledgerExport(role, report)
      assert.ok(text.split('\r\n')[0]!.split(',').some((column) => /value/i.test(column)), role)
      assert.ok(text.includes(SENTINEL), role)
      assert.equal(seen[0]!.includeCost, true, role)
    }
  })
}
