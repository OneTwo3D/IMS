import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { getInventoryCostingExportResponse, INVENTORY_VALUATION_CSV_HEADERS } from '../../app/api/export/inventory-costing/route.ts'
import { getInventoryLedgerExportResponse, STOCK_MOVEMENT_LEDGER_CSV_HEADERS } from '../../app/api/export/inventory-ledger/route.ts'
import { getStockPositionExportResponse, STOCK_ON_HAND_CSV_HEADERS } from '../../app/api/export/stock-position/route.ts'
import {
  CSV_EXPORT_METADATA_ENCODING,
  CSV_EXPORT_METADATA_ENCODING_HEADER,
  CSV_EXPORT_METADATA_HEADER,
  CSV_EXPORT_METADATA_MAX_JSON_BYTES,
  CSV_EXPORT_METADATA_TRUNCATED_HEADER,
  csvBufferedStreamResponse,
  csvResponse,
  parseCsv,
  toCsv,
} from '@/lib/csv'

function decodeMetadata(response: Response): Record<string, unknown> {
  assert.equal(response.headers.get(CSV_EXPORT_METADATA_ENCODING_HEADER), CSV_EXPORT_METADATA_ENCODING)
  const encoded = response.headers.get(CSV_EXPORT_METADATA_HEADER)
  assert.ok(encoded)
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
}

const authorizedRouteDeps = {
  requireApiAuth: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }) as never,
  accessDenied: () => null,
  loadMpnByProductId: async () => new Map([['product-1', 'MPN-1']]),
}

test('csvResponse exposes encoded export metadata once and keeps metadata visible in the downloaded CSV', async () => {
  const response = csvResponse(
    toCsv([{ sku: 'SKU-1', qty: '10.000000' }], ['sku', 'qty']),
    'stock.csv',
    { generatedAt: '2026-06-09T10:00:00.000Z', source: 'snapshot', generatedBy: 'café Admin' },
  )
  const body = await response.text()

  assert.deepEqual(parseCsv(body), [{ sku: 'SKU-1', qty: '10.000000' }])
  assert.deepEqual(decodeMetadata(response), {
    generatedAt: '2026-06-09T10:00:00.000Z',
    source: 'snapshot',
    generatedBy: 'café Admin',
  })
  assert.match(body, /\r\n# IMS export metadata\r\n/)
  assert.match(body, /\r\n# generatedBy,café Admin/)
  assert.match(response.headers.get('Access-Control-Expose-Headers') ?? '', new RegExp(CSV_EXPORT_METADATA_HEADER))
})

test('csvBufferedStreamResponse exposes encoded metadata without adding data columns', async () => {
  const response = csvBufferedStreamResponse(
    [{ createdAt: '2026-06-09T10:00:00.000Z', sku: 'SKU-1' }],
    ['createdAt', 'sku'],
    'ledger.csv',
    { generatedAt: '2026-06-09T10:05:00.000Z', openingQty: '1.000000', closingQty: '2.000000' },
  )
  const body = await response.text()

  assert.deepEqual(parseCsv(body), [{ createdAt: '2026-06-09T10:00:00.000Z', sku: 'SKU-1' }])
  assert.deepEqual(decodeMetadata(response), {
    generatedAt: '2026-06-09T10:05:00.000Z',
    openingQty: '1.000000',
    closingQty: '2.000000',
  })
  assert.match(body, /\r\n# openingQty,1.000000/)
})

test('oversized metadata is capped before it becomes an HTTP header', () => {
  const response = csvResponse(
    toCsv([], ['sku']),
    'stock.csv',
    {
      generatedAt: '2026-06-09T10:00:00.000Z',
      perWarehouseTotals: Array.from({ length: 500 }, (_, index) => ({ warehouseId: `warehouse-${index}`, qty: index })),
    },
  )
  const decoded = decodeMetadata(response)

  assert.equal(response.headers.get(CSV_EXPORT_METADATA_TRUNCATED_HEADER), 'true')
  assert.equal(decoded.metadataTruncated, true)
  assert.equal(decoded.generatedAt, '2026-06-09T10:00:00.000Z')
  assert.equal(typeof decoded.originalByteLength, 'number')
  assert.ok((decoded.originalByteLength as number) > CSV_EXPORT_METADATA_MAX_JSON_BYTES)
  assert.ok(Buffer.byteLength(response.headers.get(CSV_EXPORT_METADATA_HEADER) ?? '', 'utf8') < CSV_EXPORT_METADATA_MAX_JSON_BYTES)
})

test('representative affected export routes keep report metadata out of CSV data rows', async () => {
  const stockResponse = await getStockPositionExportResponse(
    new NextRequest('http://localhost/api/export/stock-position?type=stock-on-hand'),
    {
      ...authorizedRouteDeps,
      getStockOnHandReport: async () => ({
        rows: [{
          productId: 'product-1',
          sku: 'SKU-1',
          productName: 'Product',
          productType: 'SIMPLE',
          categoryName: 'Category',
          supplierNames: ['Supplier'],
          warehouseCode: 'WH',
          warehouseName: 'Warehouse',
          stockUnit: 'pcs',
          quantity: '10.000000',
          reservedQty: '2.000000',
          availableQty: '8.000000',
          unitCostBase: '1.000000',
          totalValueBase: '10.000000',
          reservationQtySource: 'snapshot',
          reservationSnapshotDate: '2026-06-09',
          reservationSourceCount: 1,
        }],
        pageInfo: { totalRows: 1 },
        asOf: '2026-06-09',
        source: 'snapshot',
        generatedAt: '2026-06-09T10:00:00.000Z',
      }) as never,
    },
  )
  const stockBody = await stockResponse.text()
  assert.equal(stockBody.split('\r\n')[0], STOCK_ON_HAND_CSV_HEADERS.join(','))
  assert.deepEqual(Object.keys(parseCsv(stockBody)[0] ?? {}), STOCK_ON_HAND_CSV_HEADERS)
  assert.deepEqual(decodeMetadata(stockResponse), {
    asOf: '2026-06-09',
    source: 'snapshot',
    generatedAt: '2026-06-09T10:00:00.000Z',
  })

  const ledgerResponse = await getInventoryLedgerExportResponse(
    new NextRequest('http://localhost/api/export/inventory-ledger?report=stock-movements'),
    {
      ...authorizedRouteDeps,
      getInventoryLedgerExportRowCount: async () => 1,
      getStockMovementLedgerReport: async () => ({
        rows: [{
          productId: 'product-1',
          createdAt: '2026-06-09T10:00:00.000Z',
          type: 'SALE_DISPATCH',
          sku: 'SKU-1',
          productName: 'Product',
          stockUnit: 'pcs',
          warehouseCode: 'WH',
          warehouseName: 'Warehouse',
          qty: '1.000000',
          signedQty: '-1.000000',
          unitCostBase: '1.000000',
          totalValueBase: '1.000000',
          signedValueBase: '-1.000000',
          referenceType: 'SHIPMENT',
          referenceId: 'shipment-1',
          note: '',
        }],
        generatedAt: '2026-06-09T10:05:00.000Z',
        totals: { openingQty: '10.000000', closingQty: '9.000000' },
      }) as never,
    },
  )
  assert.equal((await ledgerResponse.text()).split('\r\n')[0], STOCK_MOVEMENT_LEDGER_CSV_HEADERS.join(','))
  assert.deepEqual(decodeMetadata(ledgerResponse), {
    generatedAt: '2026-06-09T10:05:00.000Z',
    openingQty: '10.000000',
    closingQty: '9.000000',
  })

  const costingResponse = await getInventoryCostingExportResponse(
    new NextRequest('http://localhost/api/export/inventory-costing?report=inventory-valuation'),
    {
      ...authorizedRouteDeps,
      getInventoryValuationReport: async () => ({
        rows: [{
          productId: 'product-1',
          sku: 'SKU-1',
          productName: 'Product',
          categoryName: 'Category',
          supplierNames: ['Supplier'],
          warehouseCode: 'WH',
          warehouseName: 'Warehouse',
          qty: '10.000000',
          stockUnit: 'pcs',
          unitCostBase: '1.000000',
          totalValueBase: '10.000000',
          glBalanceBase: '10.000000',
          glVarianceBase: '0.000000',
        }],
        pageInfo: { totalRows: 1 },
        asOf: '2026-06-09',
        source: 'snapshot',
        valueReplayReliable: true,
        generatedAt: '2026-06-09T10:10:00.000Z',
      }) as never,
    },
  )
  assert.equal((await costingResponse.text()).split('\r\n')[0], INVENTORY_VALUATION_CSV_HEADERS.join(','))
  assert.deepEqual(decodeMetadata(costingResponse), {
    asOf: '2026-06-09',
    source: 'snapshot',
    valueReplayReliable: true,
    generatedAt: '2026-06-09T10:10:00.000Z',
  })
})
