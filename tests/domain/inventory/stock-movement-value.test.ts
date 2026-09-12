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

test('total value stays consistent with the rounded unit cost (DB reporting-value invariant)', () => {
  // £10 over 3 units → 3.333333 unit cost. The stored total must equal
  // ROUND(qty * unitCostBase, 6) = 9.999999 (NOT the raw 10.000000), or the
  // stock_movements_reporting_value_consistent CHECK fails — which is what broke
  // confirming supplier returns that consumed mixed-cost FIFO layers.
  const fields = buildStockMovementValueFieldsFromTotal({ qty: 3, totalValueBase: 10 })
  assert.deepEqual(fields, { unitCostBase: '3.333333', totalValueBase: '9.999999' })
  // Mirror the DB CHECK exactly: totalValueBase === ROUND(qty * unitCostBase, 6).
  const dbCheck = new Prisma.Decimal(3).mul(fields.unitCostBase).toDecimalPlaces(6).toFixed(6)
  assert.equal(fields.totalValueBase, dbCheck)
})

test('mixed-cost FIFO consumption satisfies the reporting-value DB invariant', () => {
  const fields = buildStockMovementValueFieldsFromConsumed([
    { qty: new Prisma.Decimal('1'), unitCostBase: new Prisma.Decimal('1') },
    { qty: new Prisma.Decimal('2'), unitCostBase: new Prisma.Decimal('2') },
  ])
  // total 5 over qty 3 → unit 1.666667, total ROUND(3 * 1.666667, 6) = 5.000001.
  assert.deepEqual(fields, { unitCostBase: '1.666667', totalValueBase: '5.000001' })
  const dbCheck = new Prisma.Decimal('3').mul(fields.unitCostBase).toDecimalPlaces(6).toFixed(6)
  assert.equal(fields.totalValueBase, dbCheck)
})

test('FIFO fractional shortfall: value fields stay consistent with the movement row qty', () => {
  // FIFO consumeFifoLayersStrict tolerates a sub-0.0001 shortfall, so the
  // consumed qty (2.4999) can be slightly below the movement's stored row qty
  // (2.5). The DB CHECK stock_movements_reporting_value_consistent evaluates
  // ROUND(<row qty> * unitCostBase, 6), so the value fields MUST be built
  // against the row qty (2.5), not the consumed qty, or the check fails.
  const consumed = [
    { qty: new Prisma.Decimal('1.2'), unitCostBase: new Prisma.Decimal('1.0') },
    { qty: new Prisma.Decimal('1.2999'), unitCostBase: new Prisma.Decimal('2.0') },
  ]
  const rowQty = new Prisma.Decimal('2.5')
  const fields = buildStockMovementValueFieldsFromConsumed(consumed, rowQty)
  // Mirror the DB CHECK exactly against the ROW qty.
  const dbCheck = rowQty.mul(fields.unitCostBase).toDecimalPlaces(6).toFixed(6)
  assert.equal(fields.totalValueBase, dbCheck)

  // Without the row qty (legacy behaviour) the fields are built against the
  // consumed qty (2.4999); that total would NOT satisfy the check against the
  // stored row qty (2.5) — which is exactly the fractional-shortfall bug.
  const legacy = buildStockMovementValueFieldsFromConsumed(consumed)
  const legacyAgainstRowQty = rowQty.mul(legacy.unitCostBase).toDecimalPlaces(6).toFixed(6)
  assert.notEqual(legacy.totalValueBase, legacyAgainstRowQty)
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

// o3d-gd2f. Four subsystems disagreed about the sign of a credit-derived
// (negative-basis) cost layer: the movement value absolutised it, cogs_entries kept it,
// and both connector journals emit a COGS pair only above zero. These pin the ONE thing
// that is well-defined without deciding how a negative basis should behave: the builder
// must not silently discard the sign the caller established. The sibling
// buildStockMovementValueFields has always thrown on a negative unit cost; the
// from-total form now enforces the same invariant.

test('o3d-gd2f: a positive quantity with a negative total is REFUSED, not absolutised', () => {
  // On the pre-fix builder this returned { unitCostBase: '2.500000', totalValueBase:
  // '10.000000' } — a -£10 basis booked as a +£10 movement that looks entirely ordinary.
  assert.throws(
    () => buildStockMovementValueFieldsFromTotal({ qty: 4, totalValueBase: -10 }),
    (error: unknown) => {
      assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
      assert.match(error.message, /unit cost must be zero or greater/)
      // The message must name the offending pair, or an operator cannot act on it.
      assert.match(error.message, /-10\.000000/)
      assert.match(error.message, /4\.000000/)
      return true
    },
  )
})

test('o3d-gd2f: an inconsistent negative-quantity/positive-total pair is REFUSED', () => {
  // The mirror of the case above. qty is a magnitude (a negative stored qty is itself a
  // CRITICAL stock_movement_negative_quantity invariant finding), so this pair is
  // incoherent rather than an outbound convention, and the implied unit cost is negative.
  assert.throws(
    () => buildStockMovementValueFieldsFromTotal({ qty: -4, totalValueBase: 10 }),
    /unit cost must be zero or greater/,
  )
})

test('o3d-gd2f: FIFO consumption of a negative-cost layer is REFUSED at the shared builder', () => {
  // The path the round-5 transfer-receipt refusal never covered: a layer already carrying
  // a negative unitCostBase (recalculateLandedCosts distributes credit freight lines with
  // no positivity filter and grossUnitCostBase has no floor) being consumed by an ordinary
  // sale, TRANSFER_OUT, supplier return, manufacturing run or stock adjustment. Pre-fix
  // this produced a POSITIVE movement value while cogsEntryDataFromConsumed wrote the same
  // consumption NEGATIVE into cogs_entries.
  assert.throws(
    () => buildStockMovementValueFieldsFromConsumed([
      { qty: new Prisma.Decimal('4'), unitCostBase: new Prisma.Decimal('-1') },
    ], new Prisma.Decimal('4')),
    /unit cost must be zero or greater/,
  )
})

test('o3d-gd2f: a mixed-cost consumption that still NETS positive is unaffected', () => {
  // The refusal must be about the net basis, not about any negative appearing anywhere:
  // this is the precondition that proves the guard is not simply rejecting everything.
  const fields = buildStockMovementValueFieldsFromConsumed([
    { qty: new Prisma.Decimal('4'), unitCostBase: new Prisma.Decimal('3') },
    { qty: new Prisma.Decimal('1'), unitCostBase: new Prisma.Decimal('-1') },
  ], new Prisma.Decimal('5'))
  // net total 11 over 5 units → 2.200000, and the DB CHECK still holds.
  assert.deepEqual(fields, { unitCostBase: '2.200000', totalValueBase: '11.000000' })
  const dbCheck = new Prisma.Decimal('5').mul(fields.unitCostBase).toDecimalPlaces(6).toFixed(6)
  assert.equal(fields.totalValueBase, dbCheck)
})

test('o3d-gd2f: zero-value and zero-cost movements are still accepted', () => {
  // The other half of "the guard is not vacuous the other way": a £0 balancing layer
  // (the transfer helper's BALANCE_AT_ZERO_COST policy) and the historical-import
  // zero-cost sentinel must both keep working.
  assert.deepEqual(
    buildStockMovementValueFieldsFromTotal({ qty: 7, totalValueBase: 0 }),
    { unitCostBase: '0.000000', totalValueBase: '0.000000' },
  )
  assert.deepEqual(
    buildStockMovementValueFieldsFromConsumed([
      { qty: new Prisma.Decimal('2'), unitCostBase: new Prisma.Decimal('0') },
    ], new Prisma.Decimal('2')),
    { unitCostBase: '0.000000', totalValueBase: '0.000000' },
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
    'PURCHASE_REVERSAL',
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
    OPENING_STOCK: ['lib/domain/inventory/opening-stock.ts'],
    PRODUCTION_IN: ['app/actions/manufacturing.ts'],
    PRODUCTION_OUT: ['app/actions/manufacturing.ts'],
    PURCHASE_RECEIPT: ['app/actions/purchase-orders.ts', 'lib/domain/wms/booked-in-service.ts'],
    PURCHASE_REVERSAL: ['lib/domain/purchasing/po-cancellation.ts'],
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
