import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  CSV_EXPORT_METADATA_HEADER,
  csvBufferedStreamResponse,
  csvResponse,
  parseCsv,
  toCsv,
} from '@/lib/csv'

test('csvResponse exposes export metadata once without changing the CSV row schema', async () => {
  const response = csvResponse(
    toCsv([{ sku: 'SKU-1', qty: '10.000000' }], ['sku', 'qty']),
    'stock.csv',
    { generatedAt: '2026-06-09T10:00:00.000Z', source: 'snapshot' },
  )

  assert.deepEqual(parseCsv(await response.text()), [{ sku: 'SKU-1', qty: '10.000000' }])
  assert.deepEqual(JSON.parse(response.headers.get(CSV_EXPORT_METADATA_HEADER) ?? '{}'), {
    generatedAt: '2026-06-09T10:00:00.000Z',
    source: 'snapshot',
  })
})

test('csvBufferedStreamResponse exposes export metadata once without adding metadata columns', async () => {
  const response = csvBufferedStreamResponse(
    [{ createdAt: '2026-06-09T10:00:00.000Z', sku: 'SKU-1' }],
    ['createdAt', 'sku'],
    'ledger.csv',
    { generatedAt: '2026-06-09T10:05:00.000Z', openingQty: '1.000000', closingQty: '2.000000' },
  )

  assert.deepEqual(parseCsv(await response.text()), [{ createdAt: '2026-06-09T10:00:00.000Z', sku: 'SKU-1' }])
  assert.deepEqual(JSON.parse(response.headers.get(CSV_EXPORT_METADATA_HEADER) ?? '{}'), {
    generatedAt: '2026-06-09T10:05:00.000Z',
    openingQty: '1.000000',
    closingQty: '2.000000',
  })
})

test('inventory report export route schemas do not repeat report metadata per CSV row', async () => {
  const stockPosition = await readFile('app/api/export/stock-position/route.ts', 'utf8')
  assert.doesNotMatch(stockPosition, /'totalValueBase', 'asOf', 'source', 'generatedAt', 'reservationQtySource'/)
  assert.doesNotMatch(stockPosition, /'movementCount', 'dateFrom', 'dateTo', 'generatedAt'/)

  const inventoryLedger = await readFile('app/api/export/inventory-ledger/route.ts', 'utf8')
  assert.doesNotMatch(inventoryLedger, /'note', 'openingQty', 'movementQty', 'closingQty'/)
  assert.doesNotMatch(inventoryLedger, /'completedAt', 'generatedAt'/)

  const inventoryCosting = await readFile('app/api/export/inventory-costing/route.ts', 'utf8')
  assert.doesNotMatch(inventoryCosting, /'asOf', 'sku'/)
  assert.doesNotMatch(inventoryCosting, /'dateFrom', 'dateTo', 'groupBy', 'groupLabel'/)
  assert.doesNotMatch(inventoryCosting, /'dateFrom', 'dateTo', 'poReference'/)
})
