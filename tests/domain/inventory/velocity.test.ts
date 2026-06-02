import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bucketInventoryAging,
  calculateAbcAnalysis,
  calculateDailyVelocity,
  calculateDeadStock,
  calculateInventoryTurnover,
  classifyVelocityQuartiles,
  normalizeVelocityWindow,
  type DailyVelocityRow,
} from '@/lib/domain/inventory/velocity'

const JAN_1 = new Date('2026-01-01T00:00:00.000Z')
const JAN_31 = new Date('2026-01-31T00:00:00.000Z')

test('daily velocity aggregates only sales inside the window with Decimal-safe totals', () => {
  const rows = calculateDailyVelocity([
    {
      productId: 'p1',
      sku: 'A-1',
      productName: 'Fast item',
      categoryName: 'Finished goods',
      supplierNames: ['Supplier A'],
      qty: '0.1',
      cogsBase: '0.333333',
      revenueBase: '1.25',
      occurredAt: '2026-01-05T12:00:00.000Z',
    },
    {
      productId: 'p1',
      sku: 'A-1',
      productName: 'Fast item',
      qty: '0.2',
      cogsBase: '0.666667',
      revenueBase: '2.75',
      occurredAt: '2026-01-10T12:00:00.000Z',
    },
    {
      productId: 'p1',
      sku: 'A-1',
      productName: 'Fast item',
      qty: '99',
      cogsBase: '99',
      revenueBase: '99',
      occurredAt: '2025-12-31T23:59:59.000Z',
    },
  ], { dateFrom: JAN_1, dateTo: JAN_31 })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.qtySold, '0.3')
  assert.equal(rows[0]?.cogsBase, '1')
  assert.equal(rows[0]?.revenueBase, '4')
  assert.equal(rows[0]?.dailyQtyVelocity, '0.009677')
  assert.equal(rows[0]?.dailyCogsVelocity, '0.032258')
  assert.equal(rows[0]?.firstSaleAt, '2026-01-05T12:00:00.000Z')
  assert.equal(rows[0]?.lastSaleAt, '2026-01-10T12:00:00.000Z')
})

test('date-only velocity windows include the full dateTo UTC day', () => {
  const window = normalizeVelocityWindow({ dateFrom: '2026-01-01', dateTo: '2026-01-31' })
  assert.equal(window.days, 31)
  assert.equal(window.dateTo.toISOString(), '2026-01-31T23:59:59.999Z')

  const rows = calculateDailyVelocity([
    {
      productId: 'p1',
      sku: 'JAN',
      productName: 'January item',
      qty: '31',
      occurredAt: '2026-01-31T15:00:00.000Z',
    },
  ], { dateFrom: '2026-01-01', dateTo: '2026-01-31' })

  assert.equal(rows[0]?.dailyQtyVelocity, '1')
})

test('daily velocity rejects negative demand values and defaults omitted money fields to zero', () => {
  assert.throws(
    () => calculateDailyVelocity([
      {
        productId: 'p1',
        sku: 'REFUND',
        productName: 'Refund item',
        qty: '-1',
        cogsBase: '10',
        revenueBase: '20',
        occurredAt: '2026-01-05T00:00:00.000Z',
      },
    ], { dateFrom: JAN_1, dateTo: JAN_31 }),
    /negative qty for SKU REFUND/,
  )

  const rows = calculateDailyVelocity([
    {
      productId: 'p1',
      sku: 'NO-COGS',
      productName: 'No COGS item',
      qty: '1',
      occurredAt: '2026-01-05T00:00:00.000Z',
    },
  ], { dateFrom: JAN_1, dateTo: JAN_31 })

  assert.equal(rows[0]?.cogsBase, '0')
  assert.equal(rows[0]?.revenueBase, '0')
})

test('velocity rankings classify the top and bottom quartiles', () => {
  const rows = ['1', '2', '3', '4'].map((dailyQtyVelocity, index) => ({
    productId: `p${index + 1}`,
    sku: `SKU-${index + 1}`,
    productName: `Item ${index + 1}`,
    categoryName: null,
    supplierNames: [],
    qtySold: dailyQtyVelocity,
    cogsBase: dailyQtyVelocity,
    revenueBase: dailyQtyVelocity,
    dailyQtyVelocity,
    dailyCogsVelocity: dailyQtyVelocity,
    firstSaleAt: null,
    lastSaleAt: null,
  }))

  const rankings = classifyVelocityQuartiles(rows)

  assert.deepEqual(rankings.map((row) => [row.sku, row.quartile]), [
    ['SKU-4', 'fast'],
    ['SKU-3', 'upper_mid'],
    ['SKU-2', 'lower_mid'],
    ['SKU-1', 'slow'],
  ])
})

test('velocity rankings classify low-cardinality active sets with the fastest row as fast', () => {
  assert.deepEqual(
    classifyVelocityQuartiles([
      velocityRow('p1', 'A', '3'),
      velocityRow('p2', 'B', '2'),
      velocityRow('p3', 'C', '1'),
    ]).map((row) => [row.sku, row.quartile]),
    [
      ['A', 'fast'],
      ['B', 'upper_mid'],
      ['C', 'lower_mid'],
    ],
  )

  assert.equal(classifyVelocityQuartiles([velocityRow('p1', 'ONLY', '1')])[0]?.quartile, 'fast')
})

test('ABC analysis classifies cumulative COGS contribution with configurable cutoffs', () => {
  const rows = calculateAbcAnalysis([
    velocityRow('p1', 'A', '80'),
    velocityRow('p2', 'B', '15'),
    velocityRow('p3', 'C', '5'),
  ])

  assert.deepEqual(rows.map((row) => [row.sku, row.abcClass, row.contributionPct, row.cumulativePct]), [
    ['A', 'A', '80', '80'],
    ['B', 'B', '15', '95'],
    ['C', 'C', '5', '100'],
  ])
})

test('ABC analysis rejects zero-total basis and keeps low-N threshold breakers in the higher class', () => {
  assert.throws(
    () => calculateAbcAnalysis([
      velocityRow('p1', 'A', '0'),
      velocityRow('p2', 'B', '0'),
    ]),
    /without positive cogs basis values/,
  )

  assert.equal(calculateAbcAnalysis([velocityRow('p1', 'ONLY', '100')])[0]?.abcClass, 'A')
  assert.equal(calculateAbcAnalysis([velocityRow('p1', 'A', '90'), velocityRow('p2', 'B', '10')])[0]?.abcClass, 'A')
  assert.throws(
    () => calculateAbcAnalysis([velocityRow('p1', 'A', '1')], { aCutoff: '0.95', bCutoff: '0.8' }),
    /got A=0.95, B=0.8/,
  )
})

test('dead-stock excludes recently stocked never-sold products by default', () => {
  const velocityRows = calculateDailyVelocity([
    {
      productId: 'sold-old',
      sku: 'SOLD',
      productName: 'Sold item',
      qty: '1',
      cogsBase: '10',
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  ], { dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-06-01T00:00:00.000Z' })

  const rows = calculateDeadStock([
    {
      productId: 'sold-old',
      sku: 'SOLD',
      productName: 'Sold item',
      qty: '5',
      valueBase: '25',
      firstStockedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      productId: 'new-never-sold',
      sku: 'NEW',
      productName: 'New item',
      qty: '5',
      valueBase: '100',
      firstStockedAt: '2026-05-15T00:00:00.000Z',
    },
  ], velocityRows, {
    asOf: '2026-06-01T00:00:00.000Z',
    thresholdDays: 90,
    velocityWindow: { dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-06-01T00:00:00.000Z' },
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.sku, 'SOLD')
  assert.equal(rows[0]?.daysSinceLastSale, 151)
})

test('dead-stock requires a velocity window at least as wide as the threshold and rejects future dates', () => {
  assert.throws(
    () => calculateDeadStock([
      {
        productId: 'p1',
        sku: 'SKU-1',
        productName: 'Item',
        qty: '1',
        valueBase: '10',
        firstStockedAt: '2026-01-01T00:00:00.000Z',
      },
    ], [], {
      asOf: '2026-06-01T00:00:00.000Z',
      thresholdDays: 90,
      velocityWindow: { dateFrom: '2026-05-01', dateTo: '2026-06-01' },
    }),
    /windowDays=32, thresholdDays=90/,
  )

  assert.throws(
    () => calculateDeadStock([
      {
        productId: 'future-sale',
        sku: 'FUTURE',
        productName: 'Future item',
        qty: '1',
        valueBase: '10',
        firstStockedAt: '2026-01-01T00:00:00.000Z',
      },
    ], [velocityRow('future-sale', 'FUTURE', '1', { lastSaleAt: '2026-06-02T00:00:00.000Z' })], {
      asOf: '2026-06-01T00:00:00.000Z',
      thresholdDays: 90,
      velocityWindow: { dateFrom: '2026-01-01', dateTo: '2026-06-01' },
    }),
    /lastSaleAt must be on or before asOf/,
  )
})

test('dead-stock exact threshold boundary is inclusive', () => {
  const rows = calculateDeadStock([
    {
      productId: 'p1',
      sku: 'SKU-1',
      productName: 'Item',
      qty: '1',
      valueBase: '10',
      firstStockedAt: '2026-01-01T00:00:00.000Z',
    },
  ], [velocityRow('p1', 'SKU-1', '1', { lastSaleAt: '2026-03-03T00:00:00.000Z' })], {
    asOf: '2026-06-01T00:00:00.000Z',
    thresholdDays: 90,
    velocityWindow: { dateFrom: '2026-01-01', dateTo: '2026-06-01' },
  })

  assert.equal(rows[0]?.daysSinceLastSale, 90)
})

test('inventory turnover returns ratio and days inventory outstanding', () => {
  const result = calculateInventoryTurnover({
    cogsBase: '1200',
    averageInventoryValueBase: '300',
    periodDays: 30,
  })

  assert.deepEqual(result, {
    turnoverRatio: '4',
    daysInventoryOutstanding: '7.5',
  })
})

test('aging buckets preserve total on-hand quantity and value per SKU', () => {
  const rows = bucketInventoryAging([
    {
      productId: 'p1',
      sku: 'SKU-1',
      productName: 'Layered item',
      qty: '2',
      valueBase: '20',
      receivedAt: '2026-05-20T00:00:00.000Z',
    },
    {
      productId: 'p1',
      sku: 'SKU-1',
      productName: 'Layered item',
      qty: '3',
      valueBase: '45',
      receivedAt: '2026-03-15T00:00:00.000Z',
    },
  ], '2026-06-01T00:00:00.000Z')

  assert.deepEqual(rows.map((row) => [row.bucket, row.qty, row.valueBase]), [
    ['0-30', '2', '20'],
    ['61-90', '3', '45'],
  ])
})

test('aging bucket validation rejects misordered, duplicate, and mid-array open buckets', () => {
  assert.throws(
    () => bucketInventoryAging([], '2026-06-01T00:00:00.000Z', [
      { label: '31-60', maxDays: 60 },
      { label: '0-30', maxDays: 30 },
    ]),
    /maxDays must be greater than the previous bucket/,
  )
  assert.throws(
    () => bucketInventoryAging([], '2026-06-01T00:00:00.000Z', [
      { label: 'Open', maxDays: null },
      { label: '0-30', maxDays: 30 },
    ]),
    /Only the last aging bucket may have maxDays: null/,
  )
  assert.throws(
    () => bucketInventoryAging([], '2026-06-01T00:00:00.000Z', [
      { label: '0-30', maxDays: 30 },
      { label: '0-30', maxDays: 60 },
    ]),
    /label must be unique/,
  )
})

test('empty sales arrays return no velocity rows', () => {
  assert.deepEqual(calculateDailyVelocity([], { dateFrom: JAN_1, dateTo: JAN_31 }), [])
})

function velocityRow(productId: string, sku: string, cogsBase: string, overrides: Partial<DailyVelocityRow> = {}): DailyVelocityRow {
  return { ...velocityRowBase(productId, sku, cogsBase), ...overrides }
}

function velocityRowBase(productId: string, sku: string, cogsBase: string): DailyVelocityRow {
  return {
    productId,
    sku,
    productName: sku,
    categoryName: null,
    supplierNames: [],
    qtySold: cogsBase,
    cogsBase,
    revenueBase: cogsBase,
    dailyQtyVelocity: cogsBase,
    dailyCogsVelocity: cogsBase,
    firstSaleAt: null,
    lastSaleAt: null,
  }
}
