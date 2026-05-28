import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Prisma, StockMovementType } from '../../../app/generated/prisma/client.ts'
import {
  STOCK_MOVEMENT_VALUE_SOURCE_BY_TYPE,
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
  buildStockMovementValueFieldsFromTotal,
} from '../../../lib/domain/inventory/stock-movement-value.ts'

test('stock movement value fields round unit cost and total value to six decimals', () => {
  assert.deepEqual(
    buildStockMovementValueFields({ qty: '3.3333', unitCostBase: '1.2345678' }),
    {
      unitCostBase: '1.234568',
      totalValueBase: '4.115186',
    },
  )
})

test('stock movement value fields use ROUND_HALF_UP at six-decimal midpoint', () => {
  assert.deepEqual(
    buildStockMovementValueFields({ qty: '1', unitCostBase: '1.2345675' }),
    {
      unitCostBase: '1.234568',
      totalValueBase: '1.234568',
    },
  )
})

test('stock movement value fields derive weighted unit cost from consumed layers', () => {
  assert.deepEqual(
    buildStockMovementValueFieldsFromConsumed([
      { qty: new Prisma.Decimal('2'), unitCostBase: new Prisma.Decimal('1.25') },
      { qty: new Prisma.Decimal('3'), unitCostBase: new Prisma.Decimal('2.50') },
    ]),
    {
      unitCostBase: '2.000000',
      totalValueBase: '10.000000',
    },
  )
})

test('stock movement value fields support zero-cost historical demand rows', () => {
  assert.deepEqual(
    buildStockMovementValueFieldsFromTotal({ qty: 4, totalValueBase: 0 }),
    {
      unitCostBase: '0.000000',
      totalValueBase: '0.000000',
    },
  )
})

test('stock movement value fields reject zero quantity with non-zero total value', () => {
  assert.throws(
    () => buildStockMovementValueFieldsFromTotal({ qty: 0, totalValueBase: 100 }),
    /total value requires a non-zero quantity/,
  )
})

test('stock movement value fields normalize negative quantities to movement magnitudes', () => {
  assert.deepEqual(
    buildStockMovementValueFieldsFromTotal({ qty: -4, totalValueBase: -10 }),
    {
      unitCostBase: '2.500000',
      totalValueBase: '10.000000',
    },
  )
})

test('stock movement value fields reject negative unit costs', () => {
  assert.throws(
    () => buildStockMovementValueFields({ qty: 1, unitCostBase: -1 }),
    /unit cost must be zero or greater/,
  )
})

test('stock movement value fields turn empty FIFO consumption into explicit zero value', () => {
  assert.deepEqual(
    buildStockMovementValueFieldsFromConsumed([]),
    {
      unitCostBase: '0.000000',
      totalValueBase: '0.000000',
    },
  )
})

test('stock movement value fields preserve ROUND_HALF_UP six-decimal precision for large Decimal input', () => {
  assert.deepEqual(
    buildStockMovementValueFields({
      qty: new Prisma.Decimal('999999.9999'),
      unitCostBase: new Prisma.Decimal('123456.1234564'),
    }),
    {
      unitCostBase: '123456.123456',
      totalValueBase: '123456123443.654388',
    },
  )
})

test('all stock movement enum values are covered by the reporting value contract', () => {
  assert.deepEqual(Object.keys(StockMovementType).sort(), [
    'ADJUSTMENT',
    'KIT_ASSEMBLY_IN',
    'KIT_ASSEMBLY_OUT',
    'OPENING_STOCK',
    'PRODUCTION_IN',
    'PRODUCTION_OUT',
    'PURCHASE_RECEIPT',
    'RETURN_INBOUND',
    'SALE_DISPATCH',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'WMS_RECEIPT_RECONCILIATION',
  ])
  assert.deepEqual(
    Object.keys(STOCK_MOVEMENT_VALUE_SOURCE_BY_TYPE).sort(),
    Object.keys(StockMovementType).sort(),
  )
})

test('active stock movement writer files route reporting values through the helper', () => {
  const writerFilesByType: Partial<Record<StockMovementType, string[]>> = {
    ADJUSTMENT: ['app/actions/stock.ts', 'app/actions/purchase-orders.ts'],
    OPENING_STOCK: ['app/actions/stock.ts'],
    PRODUCTION_IN: ['app/actions/manufacturing.ts'],
    PRODUCTION_OUT: ['app/actions/manufacturing.ts'],
    PURCHASE_RECEIPT: ['app/actions/purchase-orders.ts', 'lib/domain/wms/booked-in-service.ts'],
    RETURN_INBOUND: ['lib/domain/sales/refund-service.ts'],
    SALE_DISPATCH: [
      'app/actions/wc-import.ts',
      'lib/connectors/woocommerce/orders.ts',
      'lib/domain/sales/shipment-service.ts',
    ],
    TRANSFER_IN: ['app/actions/transfers.ts', 'lib/domain/wms/booked-in-service.ts'],
    TRANSFER_OUT: ['app/actions/transfers.ts'],
    WMS_RECEIPT_RECONCILIATION: ['lib/domain/wms/booked-in-service.ts'],
  }

  for (const [type, files] of Object.entries(writerFilesByType)) {
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    assert.match(source, new RegExp(`type:\\s*['"]${type}['"]`), `${type} must have an active writer`)
    assert.match(source, /buildStockMovementValueFields/, `${type} writer must use the value helper`)
  }

  assert.match(STOCK_MOVEMENT_VALUE_SOURCE_BY_TYPE.KIT_ASSEMBLY_IN, /reserved legacy type/)
  assert.match(STOCK_MOVEMENT_VALUE_SOURCE_BY_TYPE.KIT_ASSEMBLY_OUT, /reserved legacy type/)
})
