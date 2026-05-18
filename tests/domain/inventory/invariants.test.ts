import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectInventoryInvariantRows,
  collectSqlInventoryInvariantFindingCollection,
  collectSqlInventoryInvariantFindings,
  collectSqlInventoryInvariantFindingsPage,
  evaluateInventoryInvariantRows,
  runInventoryInvariantReport,
  type InventoryInvariantFinding,
  type InventoryInvariantRows,
  type InventoryInvariantSqlClient,
} from '@/lib/domain/inventory/invariants'

const CANONICAL_INVENTORY_INVARIANT_CODES = new Set([
  'stock_negative_quantity',
  'stock_negative_reserved_quantity',
  'stock_reserved_exceeds_quantity',
  'cost_layer_negative_received_quantity',
  'cost_layer_negative_remaining_quantity',
  'cost_layer_remaining_exceeds_received',
  'stock_cost_layer_quantity_mismatch',
  'stock_movement_negative_quantity',
  'shipped_line_missing_cogs_snapshot',
])

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

test('exact negative checks mirror DB quantity constraints at the tolerance boundary', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [
      {
        id: 'received-small-negative',
        productId: 'product-small-negative',
        warehouseId: 'warehouse-1',
        receivedQty: -0.00005,
        remainingQty: 0,
        product: {
          id: 'product-small-negative',
          sku: 'SMALL-NEG-RECEIVED',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [
      {
        id: 'movement-small-negative',
        type: 'ADJUSTMENT',
        productId: 'product-small-negative',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: -0.00005,
        product: {
          id: 'product-small-negative',
          sku: 'SMALL-NEG-MOVE',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-negative',
        type: 'ADJUSTMENT',
        productId: 'product-negative',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: -0.001,
        product: {
          id: 'product-negative',
          sku: 'NEG-MOVE',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  const codes = findings.map((finding) => finding.code)
  assert.ok(codes.includes('cost_layer_negative_received_quantity'))
  assert.ok(codes.includes('stock_movement_negative_quantity'))
  assert.equal(findings.filter((finding) => finding.code === 'stock_movement_negative_quantity').length, 2)
})

test('clean stock movements do not generate findings', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-zero',
        type: 'ADJUSTMENT',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 0,
        product: {
          id: 'product-1',
          sku: 'ZERO-MOVE',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-positive',
        type: 'TRANSFER_IN',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: 1,
        product: {
          id: 'product-1',
          sku: 'POS-MOVE',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(
    findings.some((finding) => finding.code === 'stock_movement_negative_quantity'),
    false,
  )
})

test('negative transfer movements produce one finding per warehouse side', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-transfer-negative',
        type: 'TRANSFER_OUT',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-from',
        toWarehouseId: 'warehouse-to',
        qty: -1,
        product: {
          id: 'product-1',
          sku: 'NEG-TRANSFER',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.deepEqual(
    findings.map((finding) => finding.warehouseId).sort(),
    ['warehouse-from', 'warehouse-to'],
  )
  assert.deepEqual(
    findings.map((finding) => (finding.details as { warehouseRole: string }).warehouseRole).sort(),
    ['from', 'to'],
  )
})

test('quantity tolerance is configurable for arithmetic-drift checks', () => {
  const rows: InventoryInvariantRows = {
    stockLevels: [
      {
        id: 'stock-small-negative',
        productId: 'product-small-negative',
        warehouseId: 'warehouse-1',
        quantity: -0.25,
        reservedQty: -0.25,
        product: {
          id: 'product-small-negative',
          sku: 'SMALL-NEG',
          type: 'SIMPLE',
          oversellAllowed: false,
        },
      },
    ],
    costLayers: [
      {
        id: 'layer-small-negative',
        productId: 'product-small-negative',
        warehouseId: 'warehouse-1',
        receivedQty: 1,
        remainingQty: -0.25,
        product: {
          id: 'product-small-negative',
          sku: 'SMALL-NEG',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [],
    shippedShipmentLines: [],
  }

  assert.ok(evaluateInventoryInvariantRows(rows, { quantityTolerance: 0 }).length > 0)
  assert.deepEqual(evaluateInventoryInvariantRows(rows, { quantityTolerance: 0.5 }), [])
})

test('PR47 quantity constraints map to inventory invariant findings', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [
      {
        id: 'stock-negative',
        productId: 'product-stock-negative',
        warehouseId: 'warehouse-1',
        quantity: -1,
        reservedQty: 0,
        product: {
          id: 'product-stock-negative',
          sku: 'NEG-STOCK',
          type: 'SIMPLE',
          oversellAllowed: true,
        },
      },
      {
        id: 'reserved-negative',
        productId: 'product-reserved-negative',
        warehouseId: 'warehouse-1',
        quantity: 1,
        reservedQty: -1,
        product: {
          id: 'product-reserved-negative',
          sku: 'NEG-RES',
          type: 'SIMPLE',
          oversellAllowed: false,
        },
      },
    ],
    costLayers: [
      {
        id: 'received-negative',
        productId: 'product-received-negative',
        warehouseId: 'warehouse-1',
        receivedQty: -1,
        remainingQty: 0,
        product: {
          id: 'product-received-negative',
          sku: 'NEG-RECEIVED',
          type: 'SIMPLE',
        },
      },
      {
        id: 'remaining-negative',
        productId: 'product-remaining-negative',
        warehouseId: 'warehouse-1',
        receivedQty: 1,
        remainingQty: -1,
        product: {
          id: 'product-remaining-negative',
          sku: 'NEG-REMAINING',
          type: 'SIMPLE',
        },
      },
      {
        id: 'remaining-over',
        productId: 'product-remaining-over',
        warehouseId: 'warehouse-1',
        receivedQty: 1,
        remainingQty: 2,
        product: {
          id: 'product-remaining-over',
          sku: 'OVER-REMAINING',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [
      {
        id: 'movement-negative',
        type: 'ADJUSTMENT',
        productId: 'product-movement-negative',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: -1,
        product: {
          id: 'product-movement-negative',
          sku: 'NEG-MOVE',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  const codes = new Set(findings.map((finding) => finding.code))
  assert.deepEqual(
    codes,
    new Set([
      'stock_negative_quantity',
      'stock_negative_reserved_quantity',
      'cost_layer_negative_received_quantity',
      'cost_layer_negative_remaining_quantity',
      'cost_layer_remaining_exceeds_received',
      'stock_movement_negative_quantity',
      'stock_cost_layer_quantity_mismatch',
    ]),
  )
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

test('inventory SQL collector keeps partially refunded orders eligible for shipped COGS checks', async () => {
  let capturedQuery: unknown
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>(query: unknown) {
      capturedQuery = query
      return [] as T
    },
  }

  await collectSqlInventoryInvariantFindingsPage(client, { limit: 10 })

  const sql = String((capturedQuery as { sql?: string }).sql ?? '')
  assert.match(sql, /so\.status <> 'REFUNDED'/)
  assert.doesNotMatch(sql, /PARTIALLY_REFUNDED/)
})

function findingKey(finding: InventoryInvariantFinding): string {
  return [
    finding.severity,
    finding.code,
    finding.productId ?? '',
    finding.warehouseId ?? '',
  ].join(':')
}

test('SQL inventory collector output matches evaluator output for seeded findings', async () => {
  const rows = cleanRows()
  rows.stockLevels[0] = {
    ...rows.stockLevels[0],
    quantity: 11,
  }
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
      id: 'stock-reserved-negative',
      productId: 'product-reserved-negative',
      warehouseId: 'warehouse-1',
      quantity: 1,
      reservedQty: -1,
      product: {
        id: 'product-reserved-negative',
        sku: 'NEG-RESERVED',
        type: 'SIMPLE',
        oversellAllowed: false,
      },
    },
    {
      id: 'stock-reserved-over',
      productId: 'product-reserved-over',
      warehouseId: 'warehouse-1',
      quantity: 1,
      reservedQty: 2,
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
      id: 'layer-negative-received',
      productId: 'product-negative-received',
      warehouseId: 'warehouse-1',
      receivedQty: -1,
      remainingQty: 0,
      product: {
        id: 'product-negative-received',
        sku: 'NEG-RECEIVED',
        type: 'SIMPLE',
      },
    },
    {
      id: 'layer-negative-remaining',
      productId: 'product-negative-remaining',
      warehouseId: 'warehouse-1',
      receivedQty: 5,
      remainingQty: -1,
      product: {
        id: 'product-negative-remaining',
        sku: 'NEG-REMAINING',
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

  const expected = evaluateInventoryInvariantRows(rows)
  const expectedKeys = new Set(expected.map(findingKey))
  assert.deepEqual(new Set(expected.map((finding) => finding.code)), CANONICAL_INVENTORY_INVARIANT_CODES)
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>() {
      const rows = expected.map((finding, index) => ({
        sortKey: `${finding.code}:${String(index).padStart(3, '0')}`,
        severity: finding.severity,
        code: finding.code,
        productId: finding.productId ?? null,
        warehouseId: finding.warehouseId ?? null,
        message: finding.message,
        details: finding.details,
      }))
      assert.equal(new Set(rows.map((row) => row.sortKey)).size, rows.length)
      return rows as T
    },
  }

  const actual = await collectSqlInventoryInvariantFindings(client)

  assert.deepEqual(new Set(actual.map((finding) => finding.code)), CANONICAL_INVENTORY_INVARIANT_CODES)
  assert.deepEqual(
    new Set(actual.map(findingKey)),
    expectedKeys,
  )
})

test('SQL inventory collector supports cursor pagination and bounded report collection', async () => {
  const queries: unknown[] = []
  const pages = [
    [
      {
        sortKey: 'a',
        severity: 'critical',
        code: 'stock_negative_quantity',
        productId: 'product-a',
        warehouseId: 'warehouse-1',
        message: 'Stock quantity is negative for A',
        details: { stockLevelId: 'stock-a', sku: 'A', quantity: -1 },
      },
      {
        sortKey: 'b',
        severity: 'warning',
        code: 'stock_cost_layer_quantity_mismatch',
        productId: 'product-b',
        warehouseId: 'warehouse-1',
        message: 'Stock quantity does not match remaining cost-layer quantity for B',
        details: { stockLevelId: 'stock-b', sku: 'B', quantity: 2, remainingCostLayerQty: 1, delta: 1 },
      },
    ],
    [
      {
        sortKey: 'b',
        severity: 'warning',
        code: 'stock_cost_layer_quantity_mismatch',
        productId: 'product-b',
        warehouseId: 'warehouse-1',
        message: 'Stock quantity does not match remaining cost-layer quantity for B',
        details: { stockLevelId: 'stock-b', sku: 'B', quantity: 2, remainingCostLayerQty: 1, delta: 1 },
      },
    ],
  ]
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>(query: unknown) {
      queries.push(query)
      return (pages[queries.length - 1] ?? []) as T
    },
  }

  const findings = await collectSqlInventoryInvariantFindings(client, {
    pageSize: 1,
    maxFindings: 2,
  })

  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map((finding) => finding.code), [
    'stock_negative_quantity',
    'stock_cost_layer_quantity_mismatch',
  ])
  assert.equal(queries.length, 2)
  assert.ok((queries[1] as { values?: unknown[] }).values?.includes('a'))
})

test('SQL inventory collector surfaces truncation as a critical finding', async () => {
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>() {
      return [
        {
          sortKey: 'a',
          severity: 'critical',
          code: 'stock_negative_quantity',
          productId: 'product-a',
          warehouseId: 'warehouse-1',
          message: 'Stock quantity is negative for A',
          details: { stockLevelId: 'stock-a', sku: 'A', quantity: -1 },
        },
        {
          sortKey: 'b',
          severity: 'critical',
          code: 'stock_negative_quantity',
          productId: 'product-b',
          warehouseId: 'warehouse-1',
          message: 'Stock quantity is negative for B',
          details: { stockLevelId: 'stock-b', sku: 'B', quantity: -1 },
        },
      ] as T
    },
  }

  const collection = await collectSqlInventoryInvariantFindingCollection(client, {
    pageSize: 1,
    maxFindings: 1,
  })

  assert.equal(collection.truncated, true)
  assert.equal(collection.nextCursor, 'a')
  assert.deepEqual(collection.findings.map((finding) => finding.code), [
    'stock_negative_quantity',
    'invariant_report_truncated',
  ])
  assert.equal(collection.findings[1]?.severity, 'critical')
})

test('SQL inventory collector page accepts filters and returns a next cursor', async () => {
  let capturedQuery: unknown
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>(query: unknown) {
      capturedQuery = query
      return [
        {
          sortKey: 'warning-row',
          severity: 'warning',
          code: 'stock_cost_layer_quantity_mismatch',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          message: 'Stock quantity does not match remaining cost-layer quantity for SKU-1',
          details: { stockLevelId: 'stock-1', sku: 'SKU-1', quantity: 2, remainingCostLayerQty: 1, delta: 1 },
        },
        {
          sortKey: 'warning-row-2',
          severity: 'warning',
          code: 'stock_cost_layer_quantity_mismatch',
          productId: 'product-2',
          warehouseId: 'warehouse-1',
          message: 'Stock quantity does not match remaining cost-layer quantity for SKU-2',
          details: { stockLevelId: 'stock-2', sku: 'SKU-2', quantity: 3, remainingCostLayerQty: 1, delta: 2 },
        },
      ] as T
    },
  }

  const page = await collectSqlInventoryInvariantFindingsPage(client, {
    limit: 1,
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    severity: 'warning',
  })

  assert.equal(page.findings.length, 1)
  assert.equal(page.nextCursor, 'warning-row')
  assert.equal(page.hasMore, true)
  const values = (capturedQuery as { values?: unknown[] }).values ?? []
  assert.ok(values.includes('product-1'))
  assert.ok(values.includes('warehouse-1'))
  assert.ok(values.includes('warning'))
})

test('inventory report uses SQL collector when a SQL client is provided', async () => {
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>() {
      return [
        {
          sortKey: 'stock_negative_quantity:stock-1',
          severity: 'critical',
          code: 'stock_negative_quantity',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          message: 'Stock quantity is negative for SKU-1',
          details: { stockLevelId: 'stock-1', sku: 'SKU-1', quantity: -1 },
        },
      ] as T
    },
  }

  const report = await runInventoryInvariantReport({
    sqlClient: client,
    collectionMode: 'sql',
    limit: 25,
  })

  assert.equal(report.summary.total, 1)
  assert.equal(report.summary.critical, 1)
  assert.equal(report.findings[0]?.code, 'stock_negative_quantity')
})

test('inventory report keeps row-collector fallback for evaluator fixtures', async () => {
  const client = {
    stockLevel: {
      async findMany() {
        return cleanRows().stockLevels
      },
    },
    costLayer: {
      async findMany() {
        return cleanRows().costLayers
      },
    },
    stockMovement: {
      async findMany() {
        return []
      },
    },
    shipmentLine: {
      async findMany() {
        return cleanRows().shippedShipmentLines
      },
    },
  }

  const report = await runInventoryInvariantReport({ client })

  assert.equal(report.summary.total, 0)
})

test('inventory report rejects row-mode filters instead of silently ignoring them', async () => {
  const client = {
    stockLevel: { async findMany() { return [] } },
    costLayer: { async findMany() { return [] } },
    stockMovement: { async findMany() { return [] } },
    shipmentLine: { async findMany() { return [] } },
  }

  await assert.rejects(
    runInventoryInvariantReport({
      client,
      collectionMode: 'rows',
      productId: 'product-1',
    }),
    /row collection mode does not support productId/,
  )
})

test('inventory report fails fast when SQL mode receives only a row mock client', async () => {
  const client = {
    stockLevel: { async findMany() { return [] } },
    costLayer: { async findMany() { return [] } },
    stockMovement: { async findMany() { return [] } },
    shipmentLine: { async findMany() { return [] } },
  }

  await assert.rejects(
    runInventoryInvariantReport({
      client,
      collectionMode: 'sql',
    }),
    /\$queryRaw-capable client/,
  )
})
