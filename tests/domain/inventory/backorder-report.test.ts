import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBackorderReport,
  type BackorderReportRows,
} from '@/lib/domain/inventory/backorder-report'

function rows(overrides: Partial<BackorderReportRows> = {}): BackorderReportRows {
  return {
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      sku: 'SKU-1',
      description: 'Stock product',
      qty: 5,
      product: {
        id: 'product-1',
        sku: 'SKU-1',
        type: 'SIMPLE',
        oversellAllowed: true,
      },
    }],
    allocations: [],
    shipmentLines: [],
    requirementsByLine: new Map([['line-1', [{ productId: 'product-1', factor: 1 }]]]),
    ...overrides,
  }
}

test('fully allocated stock-tracked lines have no unallocated demand', () => {
  const report = buildBackorderReport(rows({
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 5 }],
  }))

  assert.deepEqual(report.lines[0], {
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    sku: 'SKU-1',
    description: 'Stock product',
    orderedQty: 5,
    shippedQty: 0,
    committedShipmentQty: 0,
    allocatedQty: 5,
    unallocatedQty: 0,
    requiresStock: true,
    backorderEligible: false,
    reason: 'fully_covered',
  })
  assert.equal(report.summary.backorderLines, 0)
})

test('partially allocated oversell-allowed lines report backorderable demand', () => {
  const report = buildBackorderReport(rows({
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 2 }],
  }))

  assert.equal(report.lines[0].orderedQty, 5)
  assert.equal(report.lines[0].allocatedQty, 2)
  assert.equal(report.lines[0].unallocatedQty, 3)
  assert.equal(report.lines[0].backorderEligible, true)
  assert.equal(report.lines[0].reason, 'stock_shortage')
  assert.equal(report.summary.unallocatedQty, 3)
})

test('committed shipment quantities reduce remaining demand before allocations are compared', () => {
  const report = buildBackorderReport(rows({
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 5 }],
    shipmentLines: [
      {
        lineId: 'line-1',
        productId: 'product-1',
        qty: 2,
        shipment: { status: 'SHIPPED' },
      },
    ],
  }))

  assert.equal(report.lines[0].orderedQty, 5)
  assert.equal(report.lines[0].shippedQty, 2)
  assert.equal(report.lines[0].committedShipmentQty, 2)
  assert.equal(report.lines[0].allocatedQty, 3)
  assert.equal(report.lines[0].unallocatedQty, 0)
  assert.equal(report.lines[0].reason, 'fully_covered')
})

test('active non-pending shipments are committed even before they are shipped', () => {
  const report = buildBackorderReport(rows({
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 3 }],
    shipmentLines: [
      {
        lineId: 'line-1',
        productId: 'product-1',
        qty: 2,
        shipment: { status: 'PACKED' },
      },
    ],
  }))

  assert.equal(report.lines[0].shippedQty, 0)
  assert.equal(report.lines[0].committedShipmentQty, 2)
  assert.equal(report.lines[0].allocatedQty, 3)
  assert.equal(report.lines[0].unallocatedQty, 0)
})

test('non-inventory lines are distinguished from stock shortages', () => {
  const report = buildBackorderReport(rows({
    lines: [{
      id: 'line-service',
      orderId: 'order-1',
      productId: 'service-1',
      sku: 'SERV-1',
      description: 'Consulting',
      qty: 5,
      product: {
        id: 'service-1',
        sku: 'SERV-1',
        type: 'NON_INVENTORY',
        oversellAllowed: true,
      },
    }],
    requirementsByLine: new Map([['line-service', [{ productId: 'service-1', factor: 1 }]]]),
  }))

  assert.equal(report.lines[0].requiresStock, false)
  assert.equal(report.lines[0].unallocatedQty, 0)
  assert.equal(report.lines[0].backorderEligible, false)
  assert.equal(report.lines[0].reason, 'not_stock_tracked')
})

test('oversell-disabled shortages are visible but not backorder eligible', () => {
  const report = buildBackorderReport(rows({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      sku: 'SKU-1',
      description: 'Stock product',
      qty: 5,
      product: {
        id: 'product-1',
        sku: 'SKU-1',
        type: 'SIMPLE',
        oversellAllowed: false,
      },
    }],
  }))

  assert.equal(report.lines[0].unallocatedQty, 5)
  assert.equal(report.lines[0].backorderEligible, false)
  assert.equal(report.lines[0].reason, 'stock_shortage')
})

test('kit lines calculate allocation coverage from component requirements', () => {
  const report = buildBackorderReport(rows({
    lines: [{
      id: 'line-kit',
      orderId: 'order-1',
      productId: 'kit-1',
      sku: 'KIT-1',
      description: 'Bundle',
      qty: 2,
      product: {
        id: 'kit-1',
        sku: 'KIT-1',
        type: 'KIT',
        oversellAllowed: true,
      },
    }],
    allocations: [
      { lineId: 'line-kit', productId: 'component-1', qty: 4 },
      { lineId: 'line-kit', productId: 'component-2', qty: 1 },
    ],
    requirementsByLine: new Map([
      ['line-kit', [
        { productId: 'component-1', factor: 2 },
        { productId: 'component-2', factor: 1 },
      ]],
    ]),
  }))

  assert.equal(report.lines[0].allocatedQty, 1)
  assert.equal(report.lines[0].unallocatedQty, 1)
  assert.equal(report.lines[0].backorderEligible, true)
})

test('missing product references are not treated as stock backorders', () => {
  const report = buildBackorderReport(rows({
    lines: [{
      id: 'line-missing',
      orderId: 'order-1',
      productId: null,
      sku: null,
      description: 'Deleted product',
      qty: 2,
      product: null,
    }],
    requirementsByLine: new Map(),
  }))

  assert.equal(report.lines[0].requiresStock, false)
  assert.equal(report.lines[0].unallocatedQty, 0)
  assert.equal(report.lines[0].backorderEligible, false)
  assert.equal(report.lines[0].reason, 'missing_product')
})
