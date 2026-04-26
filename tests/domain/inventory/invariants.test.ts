import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateInventoryInvariantRows,
  type InventoryInvariantRows,
} from '@/lib/domain/inventory/invariants'

function cleanRows(): InventoryInvariantRows {
  return {
    stockLevels: [
      {
        id: 'stock-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        quantity: 10,
        reservedQty: 2,
        product: {
          id: 'product-1',
          sku: 'SKU-1',
          name: 'Stock item',
          type: 'SIMPLE',
          oversellAllowed: false,
        },
      },
      {
        id: 'stock-kit',
        productId: 'kit-1',
        warehouseId: 'warehouse-1',
        quantity: 0,
        reservedQty: 0,
        product: {
          id: 'kit-1',
          sku: 'KIT-1',
          name: 'Virtual kit',
          type: 'KIT',
          oversellAllowed: true,
        },
      },
    ],
    costLayers: [
      {
        id: 'layer-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        receivedQty: 12,
        remainingQty: 10,
        product: {
          id: 'product-1',
          sku: 'SKU-1',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [
      {
        id: 'shipment-line-1',
        shipmentId: 'shipment-1',
        lineId: 'sales-line-1',
        productId: 'product-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 3 }],
        product: {
          id: 'product-1',
          sku: 'SKU-1',
          type: 'SIMPLE',
        },
        shipment: {
          orderId: 'order-1',
          warehouseId: 'warehouse-1',
        },
      },
    ],
  }
}

test('clean inventory rows produce no findings', () => {
  assert.deepEqual(evaluateInventoryInvariantRows(cleanRows()), [])
})

test('broken stock levels and cost layers produce structured findings', () => {
  const rows = cleanRows()
  rows.stockLevels.push(
    {
      id: 'stock-negative',
      productId: 'product-negative',
      warehouseId: 'warehouse-1',
      quantity: -1,
      reservedQty: 0,
      product: {
        id: 'product-negative',
        sku: 'NEG-QTY',
        type: 'SIMPLE',
        oversellAllowed: false,
      },
    },
    {
      id: 'reserved-negative',
      productId: 'product-reserved-negative',
      warehouseId: 'warehouse-1',
      quantity: 1,
      reservedQty: -0.5,
      product: {
        id: 'product-reserved-negative',
        sku: 'NEG-RESERVED',
        type: 'SIMPLE',
        oversellAllowed: false,
      },
    },
    {
      id: 'reserved-over',
      productId: 'product-reserved-over',
      warehouseId: 'warehouse-1',
      quantity: 3,
      reservedQty: 4,
      product: {
        id: 'product-reserved-over',
        sku: 'OVER-RESERVED',
        type: 'SIMPLE',
        oversellAllowed: false,
      },
    },
  )
  rows.costLayers.push(
    {
      id: 'layer-negative',
      productId: 'product-negative-layer',
      warehouseId: 'warehouse-1',
      receivedQty: 5,
      remainingQty: -1,
      product: {
        id: 'product-negative-layer',
        sku: 'NEG-LAYER',
        type: 'SIMPLE',
      },
    },
    {
      id: 'layer-over',
      productId: 'product-over-layer',
      warehouseId: 'warehouse-1',
      receivedQty: 5,
      remainingQty: 6,
      product: {
        id: 'product-over-layer',
        sku: 'OVER-LAYER',
        type: 'SIMPLE',
      },
    },
  )

  const findings = evaluateInventoryInvariantRows(rows)
  const codes = findings.map((finding) => finding.code)

  assert.ok(codes.includes('stock_negative_quantity'))
  assert.ok(codes.includes('stock_negative_reserved_quantity'))
  assert.ok(codes.includes('stock_reserved_exceeds_quantity'))
  assert.ok(codes.includes('cost_layer_negative_remaining_quantity'))
  assert.ok(codes.includes('cost_layer_remaining_exceeds_received'))
  assert.ok(findings.every((finding) => finding.severity === 'critical' || finding.severity === 'warning'))
})

test('reserved quantity can exceed stock when product explicitly allows oversell', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [
      {
        id: 'oversell-stock',
        productId: 'oversell-product',
        warehouseId: 'warehouse-1',
        quantity: 1,
        reservedQty: 3,
        product: {
          id: 'oversell-product',
          sku: 'OVERSELL',
          type: 'SIMPLE',
          oversellAllowed: true,
        },
      },
    ],
    costLayers: [
      {
        id: 'oversell-layer',
        productId: 'oversell-product',
        warehouseId: 'warehouse-1',
        receivedQty: 1,
        remainingQty: 1,
        product: {
          id: 'oversell-product',
          sku: 'OVERSELL',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(
    findings.some((finding) => finding.code === 'stock_reserved_exceeds_quantity'),
    false,
  )
})

test('stockable quantity must reconcile to remaining cost layers', () => {
  const rows = cleanRows()
  rows.stockLevels[0] = {
    ...rows.stockLevels[0],
    quantity: 11,
  }

  const findings = evaluateInventoryInvariantRows(rows)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'stock_cost_layer_quantity_mismatch')
  assert.equal(findings[0]?.severity, 'warning')
})

test('remaining cost layers without matching stock levels are reported', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [
      {
        id: 'orphan-layer',
        productId: 'orphan-product',
        warehouseId: 'warehouse-1',
        receivedQty: 5,
        remainingQty: 5,
        product: {
          id: 'orphan-product',
          sku: 'ORPHAN',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'stock_cost_layer_quantity_mismatch')
  assert.equal(findings[0]?.productId, 'orphan-product')
  assert.equal(findings[0]?.warehouseId, 'warehouse-1')
})

test('non-stockable products are excluded from cost-layer reconciliation', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [
      {
        id: 'non-inventory-stock',
        productId: 'non-inventory',
        warehouseId: 'warehouse-1',
        quantity: 99,
        reservedQty: 0,
        product: {
          id: 'non-inventory',
          sku: 'SERVICE',
          type: 'NON_INVENTORY',
          oversellAllowed: true,
        },
      },
    ],
    costLayers: [],
    shippedShipmentLines: [],
  })

  assert.deepEqual(findings, [])
})

test('shipped stockable lines require COGS snapshots', () => {
  const rows = cleanRows()
  rows.shippedShipmentLines.push({
    id: 'shipment-line-missing',
    shipmentId: 'shipment-2',
    lineId: 'sales-line-2',
    productId: 'product-1',
    qty: 1,
    costLayerSnapshot: null,
    product: {
      id: 'product-1',
      sku: 'SKU-1',
      type: 'SIMPLE',
    },
    shipment: {
      orderId: 'order-2',
      warehouseId: 'warehouse-1',
    },
  })

  const findings = evaluateInventoryInvariantRows(rows)
  const missingSnapshot = findings.find((finding) => finding.code === 'shipped_line_missing_cogs_snapshot')

  assert.ok(missingSnapshot)
  assert.equal(missingSnapshot.severity, 'critical')
  assert.equal(missingSnapshot.productId, 'product-1')
})
