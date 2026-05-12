import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBackorderReport,
  collectBackorderReportRows,
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

test('variable parent lines are not stock tracked', () => {
  const report = buildBackorderReport(rows({
    lines: [{
      id: 'line-variable',
      orderId: 'order-1',
      productId: 'variable-1',
      sku: 'VAR-1',
      description: 'Variable parent',
      qty: 2,
      product: {
        id: 'variable-1',
        sku: 'VAR-1',
        type: 'VARIABLE',
        oversellAllowed: true,
      },
    }],
    requirementsByLine: new Map([['line-variable', [{ productId: 'variable-1', factor: 1 }]]]),
  }))

  assert.equal(report.lines[0].requiresStock, false)
  assert.equal(report.lines[0].unallocatedQty, 0)
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

test('oversell-disabled kit shortage is visible but not backorder eligible', () => {
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
        oversellAllowed: false,
      },
    }],
    allocations: [
      { lineId: 'line-kit', productId: 'component-1', qty: 2 },
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
  assert.equal(report.lines[0].backorderEligible, false)
  assert.equal(report.lines[0].reason, 'stock_shortage')
})

test('over-shipped data drift is capped at ordered quantity', () => {
  const report = buildBackorderReport(rows({
    shipmentLines: [
      {
        lineId: 'line-1',
        productId: 'product-1',
        qty: 7,
        shipment: { status: 'SHIPPED' },
      },
    ],
  }))

  assert.equal(report.lines[0].orderedQty, 5)
  assert.equal(report.lines[0].shippedQty, 5)
  assert.equal(report.lines[0].committedShipmentQty, 5)
  assert.equal(report.lines[0].allocatedQty, 0)
  assert.equal(report.lines[0].unallocatedQty, 0)
})

test('pending shipment lines do not count as committed demand', () => {
  const report = buildBackorderReport(rows({
    shipmentLines: [
      {
        lineId: 'line-1',
        productId: 'product-1',
        qty: 2,
        shipment: { status: 'PENDING' },
      },
      {
        lineId: 'line-1',
        productId: 'product-1',
        qty: 1,
        shipment: { status: 'PACKED' },
      },
    ],
  }))

  assert.equal(report.lines[0].shippedQty, 0)
  assert.equal(report.lines[0].committedShipmentQty, 1)
  assert.equal(report.lines[0].unallocatedQty, 4)
})

test('quantity tolerance suppresses dust backorders', () => {
  const tiny = buildBackorderReport(rows({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      sku: 'SKU-1',
      description: 'Stock product',
      qty: 1.00005,
      product: {
        id: 'product-1',
        sku: 'SKU-1',
        type: 'SIMPLE',
        oversellAllowed: true,
      },
    }],
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 1 }],
  }))
  const material = buildBackorderReport(rows({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      sku: 'SKU-1',
      description: 'Stock product',
      qty: 1.0002,
      product: {
        id: 'product-1',
        sku: 'SKU-1',
        type: 'SIMPLE',
        oversellAllowed: true,
      },
    }],
    allocations: [{ lineId: 'line-1', productId: 'product-1', qty: 1 }],
  }))

  assert.equal(tiny.lines[0].unallocatedQty, 0)
  assert.equal(tiny.lines[0].reason, 'fully_covered')
  assert.equal(material.lines[0].unallocatedQty, 0.0002)
  assert.equal(material.lines[0].reason, 'stock_shortage')
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

test('report lines preserve collector ordering', () => {
  const report = buildBackorderReport(rows({
    lines: [
      {
        id: 'line-a',
        orderId: 'order-1',
        productId: 'product-a',
        sku: 'A',
        description: 'A',
        qty: 1,
        product: {
          id: 'product-a',
          sku: 'A',
          type: 'SIMPLE',
          oversellAllowed: true,
        },
      },
      {
        id: 'line-b',
        orderId: 'order-1',
        productId: 'product-b',
        sku: 'B',
        description: 'B',
        qty: 1,
        product: {
          id: 'product-b',
          sku: 'B',
          type: 'SIMPLE',
          oversellAllowed: true,
        },
      },
    ],
    requirementsByLine: new Map([
      ['line-a', [{ productId: 'product-a', factor: 1 }]],
      ['line-b', [{ productId: 'product-b', factor: 1 }]],
    ]),
  }))

  assert.deepEqual(report.lines.map((line) => line.lineId), ['line-a', 'line-b'])
})

test('collector uses the order-scoped query shapes and expands kit requirements', async () => {
  const calls: Record<string, unknown> = {}
  const client = {
    salesOrderLine: {
      findMany: async (args: unknown) => {
        calls.salesOrderLine = args
        return [
          {
            id: 'line-kit',
            orderId: 'order-1',
            productId: 'kit-1',
            sku: 'KIT-1',
            description: 'Kit',
            qty: 2,
            product: {
              id: 'kit-1',
              sku: 'KIT-1',
              type: 'KIT',
              oversellAllowed: true,
            },
          },
        ]
      },
    },
    orderAllocation: {
      findMany: async (args: unknown) => {
        calls.orderAllocation = args
        return [{ lineId: 'line-kit', productId: 'component-1', qty: 2 }]
      },
    },
    shipmentLine: {
      findMany: async (args: unknown) => {
        calls.shipmentLine = args
        return []
      },
    },
    product: {
      findMany: async (args: unknown) => {
        calls.product = args
        return [
          {
            id: 'kit-1',
            type: 'KIT',
            productComponents: [
              {
                componentId: 'component-1',
                qty: 2,
                component: { type: 'SIMPLE' },
              },
            ],
          },
        ]
      },
    },
  }

  const collected = await collectBackorderReportRows(
    'order-1',
    client as unknown as Parameters<typeof collectBackorderReportRows>[1],
  )

  assert.deepEqual(calls.salesOrderLine, {
    where: { orderId: 'order-1' },
    select: {
      id: true,
      orderId: true,
      productId: true,
      sku: true,
      description: true,
      qty: true,
      product: {
        select: {
          id: true,
          sku: true,
          type: true,
          oversellAllowed: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  })
  assert.deepEqual(calls.orderAllocation, {
    where: { orderId: 'order-1' },
    select: {
      lineId: true,
      productId: true,
      qty: true,
    },
  })
  assert.deepEqual(calls.shipmentLine, {
    where: { shipment: { orderId: 'order-1' } },
    select: {
      lineId: true,
      productId: true,
      qty: true,
      shipment: { select: { status: true } },
    },
  })
  assert.deepEqual(calls.product, {
    where: { id: { in: ['kit-1'] } },
    select: {
      id: true,
      type: true,
      productComponents: {
        select: {
          componentId: true,
          qty: true,
          component: { select: { type: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  assert.deepEqual(collected.requirementsByLine.get('line-kit'), [
    { productId: 'component-1', factor: 2 },
  ])
})
