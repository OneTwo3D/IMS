import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectInventoryInvariantRows,
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
    stockMovements: [],
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
      id: 'layer-negative-received',
      productId: 'product-negative-received',
      warehouseId: 'warehouse-1',
      receivedQty: -2,
      remainingQty: 0,
      product: {
        id: 'product-negative-received',
        sku: 'NEG-RECEIVED',
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
  rows.stockMovements.push({
    id: 'movement-negative',
    type: 'ADJUSTMENT',
    productId: 'product-movement-negative',
    fromWarehouseId: 'warehouse-1',
    toWarehouseId: null,
    qty: -3,
    product: {
      id: 'product-movement-negative',
      sku: 'NEG-MOVE',
      type: 'SIMPLE',
    },
  })

  const findings = evaluateInventoryInvariantRows(rows)
  const codes = findings.map((finding) => finding.code)

  assert.ok(codes.includes('stock_negative_quantity'))
  assert.ok(codes.includes('stock_negative_reserved_quantity'))
  assert.ok(codes.includes('stock_reserved_exceeds_quantity'))
  assert.ok(codes.includes('cost_layer_negative_received_quantity'))
  assert.ok(codes.includes('cost_layer_negative_remaining_quantity'))
  assert.ok(codes.includes('cost_layer_remaining_exceeds_received'))
  assert.ok(codes.includes('stock_movement_negative_quantity'))
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
    stockMovements: [],
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
    stockMovements: [],
    shippedShipmentLines: [],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'stock_cost_layer_quantity_mismatch')
  assert.equal(findings[0]?.productId, 'orphan-product')
  assert.equal(findings[0]?.warehouseId, 'warehouse-1')
})

test('remaining cost layers without matching stock levels are reported once per product warehouse', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [
      {
        id: 'orphan-layer-1',
        productId: 'orphan-product',
        warehouseId: 'warehouse-1',
        receivedQty: 5,
        remainingQty: 3,
        product: {
          id: 'orphan-product',
          sku: 'ORPHAN',
          type: 'SIMPLE',
        },
      },
      {
        id: 'orphan-layer-2',
        productId: 'orphan-product',
        warehouseId: 'warehouse-1',
        receivedQty: 5,
        remainingQty: 2,
        product: {
          id: 'orphan-product',
          sku: 'ORPHAN',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [],
    shippedShipmentLines: [],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'stock_cost_layer_quantity_mismatch')
  assert.deepEqual(findings[0]?.details, {
    sku: 'ORPHAN',
    productType: 'SIMPLE',
    quantity: 0,
    remainingCostLayerQty: 5,
    delta: -5,
    exception: 'Products without FIFO cost layers are excluded; FIFO cost-layer products are expected to reconcile within tolerance.',
  })
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
    stockMovements: [],
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

test('malformed COGS snapshots are treated as missing', () => {
  const rows = cleanRows()
  rows.shippedShipmentLines[0] = {
    ...rows.shippedShipmentLines[0],
    costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2 }],
  }

  const findings = evaluateInventoryInvariantRows(rows)
  const missingSnapshot = findings.find((finding) => finding.code === 'shipped_line_missing_cogs_snapshot')

  assert.ok(missingSnapshot)
  assert.equal(missingSnapshot.productId, 'product-1')
})

test('inventory row collection excludes fully refunded orders from shipped COGS checks', async () => {
  let shipmentLineArgs: unknown
  let stockMovementArgs: unknown
  const client = {
    stockLevel: {
      async findMany() {
        return []
      },
    },
    costLayer: {
      async findMany() {
        return []
      },
    },
    stockMovement: {
      async findMany(args: unknown) {
        stockMovementArgs = args
        return []
      },
    },
    shipmentLine: {
      async findMany(args: unknown) {
        shipmentLineArgs = args
        return []
      },
    },
  }

  await collectInventoryInvariantRows(client)

  assert.deepEqual(shipmentLineArgs, {
    where: {
      shipment: {
        status: 'SHIPPED',
        order: {
          status: { not: 'REFUNDED' },
        },
      },
    },
    select: {
      id: true,
      shipmentId: true,
      lineId: true,
      productId: true,
      qty: true,
      costLayerSnapshot: true,
      product: {
        select: {
          id: true,
          sku: true,
          type: true,
        },
      },
      shipment: {
        select: {
          orderId: true,
          warehouseId: true,
        },
      },
    },
  })
  assert.deepEqual(stockMovementArgs, {
    where: {
      qty: { lt: 0 },
    },
    select: {
      id: true,
      type: true,
      productId: true,
      fromWarehouseId: true,
      toWarehouseId: true,
      qty: true,
      product: {
        select: {
          id: true,
          sku: true,
          type: true,
        },
      },
    },
  })
})
