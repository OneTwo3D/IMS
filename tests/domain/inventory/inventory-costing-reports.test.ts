import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LandedCostMethod } from '@/app/generated/prisma/client'
import {
  aggregateCogsRows,
  aggregateLandedCostMethods,
  inventoryCostingFiltersFromSearch,
  type CogsAggregationInput,
  type LandedCostAggregationInput,
} from '@/lib/domain/inventory/inventory-costing-reports'

describe('inventory costing report aggregations', () => {
  it('aggregates COGS by product without recalculating cost from movement quantities', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-1',
        qty: '1.0000',
        cogsBase: '2.500000',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueBase: '10.000000',
      },
      {
        id: 'movement-2',
        qty: '2.0000',
        cogsBase: '5.250000',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueBase: '20.000000',
      },
    ]

    const [row] = aggregateCogsRows(rows, 'product')

    assert.equal(row?.groupKey, 'product-a')
    assert.equal(row?.qty, '3.0000')
    assert.equal(row?.cogsBase, '7.750000')
    assert.equal(row?.revenueBase, '30.000000')
    assert.equal(row?.grossMarginBase, '22.250000')
    assert.equal(row?.grossMarginPct, '74.17')
    assert.equal(row?.revenueCaptured, true)
  })

  it('marks grouped COGS revenue as uncaptured when any member cannot be matched', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-1',
        qty: '1',
        cogsBase: '3',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: '10',
      },
      {
        id: 'movement-2',
        qty: '1',
        cogsBase: '4',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: null,
      },
    ]

    const [row] = aggregateCogsRows(rows, 'product')

    assert.equal(row?.cogsBase, '7.000000')
    assert.equal(row?.revenueBase, null)
    assert.equal(row?.grossMarginBase, null)
    assert.equal(row?.revenueCaptured, false)
  })

  it('summarises landed-cost uplift by allocation method', () => {
    const rows: LandedCostAggregationInput[] = [
      { method: LandedCostMethod.BY_VALUE, qty: '5', goodsValueBase: '100', landedValueBase: '115' },
      { method: LandedCostMethod.BY_VALUE, qty: '2', goodsValueBase: '20', landedValueBase: '26' },
      { method: LandedCostMethod.EQUAL_SPLIT, qty: '1', goodsValueBase: '10', landedValueBase: '11.5' },
    ]

    const summary = aggregateLandedCostMethods(rows)

    assert.deepEqual(summary, [
      {
        method: LandedCostMethod.BY_VALUE,
        poLineCount: 2,
        goodsValueBase: '120.000000',
        landedValueBase: '141.000000',
        upliftBase: '21.000000',
      },
      {
        method: LandedCostMethod.EQUAL_SPLIT,
        poLineCount: 1,
        goodsValueBase: '10.000000',
        landedValueBase: '11.500000',
        upliftBase: '1.500000',
      },
    ])
  })

  it('normalises invalid filter enum values', () => {
    const filters = inventoryCostingFiltersFromSearch({
      groupBy: 'unknown',
      landedCostMethod: 'BAD',
      page: '2',
      pageSize: '250',
    })

    assert.equal(filters.groupBy, undefined)
    assert.equal(filters.landedCostMethod, undefined)
    assert.equal(filters.page, 2)
    assert.equal(filters.pageSize, 250)
  })
})
