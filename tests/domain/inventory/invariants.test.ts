import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  'stock_reserved_source_mismatch',
  'cost_layer_negative_received_quantity',
  'cost_layer_negative_remaining_quantity',
  'cost_layer_remaining_exceeds_received',
  'stock_cost_layer_quantity_mismatch',
  'stock_movement_negative_quantity',
  'stock_movement_value_mismatch',
  'stock_movement_value_partial',
  'stock_movement_missing_cost_layer',
  'stock_movement_missing_cogs_entry',
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
    reservationSources: [
      {
        source: 'sales_order',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        referenceId: 'order-1',
        referenceLabel: 'SO order-1',
        qty: '2',
        expectedDate: null,
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

test('reservation source mismatch produces a critical invariant finding', () => {
  const rows = cleanRows()
  rows.reservationSources = [
    {
      source: 'sales_order',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      referenceId: 'order-1',
      referenceLabel: 'SO order-1',
      qty: '1.25',
      expectedDate: null,
    },
  ]

  const findings = evaluateInventoryInvariantRows(rows)
  const finding = findings.find((candidate) => candidate.code === 'stock_reserved_source_mismatch')

  assert.ok(finding)
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.productId, 'product-1')
  assert.equal(finding.warehouseId, 'warehouse-1')
  assert.equal((finding.details as { reservedQty: number; knownReservedQty: number }).reservedQty, 2)
  assert.equal((finding.details as { reservedQty: number; knownReservedQty: number }).knownReservedQty, 1.25)
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
  assert.equal(
    findings.some((finding) => finding.code.startsWith('stock_movement_value_')),
    false,
  )
})

test('stock movement value fields must reconcile within reporting tolerance', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-value-mismatch',
        type: 'SALE_DISPATCH',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 2,
        unitCostBase: 5,
        totalValueBase: 11,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-1',
          sku: 'VALUE-MISMATCH',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-value-partial',
        type: 'SALE_DISPATCH',
        productId: 'product-2',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 2,
        unitCostBase: 5,
        totalValueBase: null,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-2',
          sku: 'VALUE-PARTIAL',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-value-clean',
        type: 'SALE_DISPATCH',
        productId: 'product-3',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 2,
        unitCostBase: 5,
        totalValueBase: 10,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-3',
          sku: 'VALUE-CLEAN',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.deepEqual(findings.map((finding) => finding.code).sort(), [
    'stock_movement_value_mismatch',
    'stock_movement_value_partial',
  ])
})

test('inbound and outbound stock movements require reporting evidence rows', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [
      {
        id: 'stock-clean-in',
        productId: 'product-clean-in',
        warehouseId: 'warehouse-1',
        quantity: 2,
        reservedQty: 0,
        product: {
          id: 'product-clean-in',
          sku: 'CLEAN-IN',
          type: 'SIMPLE',
          oversellAllowed: false,
        },
      },
    ],
    costLayers: [
      {
        id: 'layer-production-clean',
        productId: 'product-clean-in',
        warehouseId: 'warehouse-1',
        receivedQty: 2,
        remainingQty: 2,
        productionOrderId: 'production-clean',
        product: {
          id: 'product-clean-in',
          sku: 'CLEAN-IN',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [
      {
        id: 'movement-missing-layer',
        type: 'PRODUCTION_IN',
        productId: 'product-missing-in',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: 2,
        referenceType: 'ProductionOrder',
        referenceId: 'production-missing',
        product: {
          id: 'product-missing-in',
          sku: 'MISSING-IN',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-clean-layer',
        type: 'PRODUCTION_IN',
        productId: 'product-clean-in',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: 2,
        referenceType: 'ProductionOrder',
        referenceId: 'production-clean',
        product: {
          id: 'product-clean-in',
          sku: 'CLEAN-IN',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-missing-cogs',
        type: 'SALE_DISPATCH',
        productId: 'product-missing-out',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 1,
        referenceType: 'SalesOrder',
        referenceId: 'order-1',
        _count: { cogsEntries: 0 },
        product: {
          id: 'product-missing-out',
          sku: 'MISSING-OUT',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-clean-cogs',
        type: 'PRODUCTION_OUT',
        productId: 'product-clean-out',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 1,
        referenceType: 'ProductionOrder',
        referenceId: 'production-clean',
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-clean-out',
          sku: 'CLEAN-OUT',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.deepEqual(findings.map((finding) => finding.code).sort(), [
    'stock_movement_missing_cogs_entry',
    'stock_movement_missing_cost_layer',
  ])
})

test('purchase receipt evidence must belong to the referenced purchase order', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [
      {
        id: 'wrong-po-layer',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        receivedQty: 2,
        remainingQty: 2,
        poLineId: 'po-2-line',
        poLine: { poId: 'po-2' },
        product: {
          id: 'product-1',
          sku: 'PO-LINK',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [
      {
        id: 'movement-po-1',
        type: 'PURCHASE_RECEIPT',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: 2,
        referenceType: 'PurchaseOrder',
        referenceId: 'po-1',
        product: {
          id: 'product-1',
          sku: 'PO-LINK',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(findings.some((finding) => finding.code === 'stock_movement_missing_cost_layer'), true)
})

test('adjustment movements require cost-layer or COGS evidence by direction', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [
      {
        id: 'stock-in',
        productId: 'product-in',
        warehouseId: 'warehouse-1',
        quantity: 2,
        reservedQty: 0,
        product: {
          id: 'product-in',
          sku: 'ADJ-IN',
          type: 'SIMPLE',
          oversellAllowed: false,
        },
      },
    ],
    costLayers: [
      {
        id: 'adjustment-layer',
        productId: 'product-in',
        warehouseId: 'warehouse-1',
        receivedQty: 2.00005,
        remainingQty: 2,
        adjustmentMovementId: 'adjustment-in',
        product: {
          id: 'product-in',
          sku: 'ADJ-IN',
          type: 'SIMPLE',
        },
      },
    ],
    stockMovements: [
      {
        id: 'adjustment-in',
        type: 'ADJUSTMENT',
        productId: 'product-in',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: 2,
        product: {
          id: 'product-in',
          sku: 'ADJ-IN',
          type: 'SIMPLE',
        },
      },
      {
        id: 'adjustment-out',
        type: 'ADJUSTMENT',
        productId: 'product-out',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 1,
        _count: { cogsEntries: 0 },
        product: {
          id: 'product-out',
          sku: 'ADJ-OUT',
          type: 'SIMPLE',
        },
      },
      {
        id: 'adjustment-out-clean',
        type: 'ADJUSTMENT',
        productId: 'product-out-clean',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 1,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-out-clean',
          sku: 'ADJ-OUT-CLEAN',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.deepEqual(findings.map((finding) => finding.code), ['stock_movement_missing_cogs_entry'])
})

test('missing COGS count instrumentation fails closed for enforced movement types', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-missing-count',
        type: 'SALE_DISPATCH',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 1,
        product: {
          id: 'product-1',
          sku: 'MISSING-COUNT',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(findings.some((finding) => finding.code === 'stock_movement_missing_cogs_entry'), true)
})

test('stock movement reporting guarantee migration locks reviewed trigger clauses', () => {
  const migration = readFileSync(
    'prisma/migrations/20260602103000_stock_movement_reporting_guarantees/migration.sql',
    'utf8',
  )

  assert.match(migration, /DROP TRIGGER IF EXISTS stock_movements_reporting_evidence_guard/)
  assert.match(migration, /UPDATE OF type, "productId", "fromWarehouseId", "toWarehouseId"/)
  assert.match(migration, /ABS\(cl\."receivedQty" - NEW\.qty\) <= 0\.0001/)
  assert.match(migration, /FROM "purchase_order_lines" pol/)
  assert.match(migration, /pol\."poId" = NEW\."referenceId"/)
  assert.match(migration, /cl\."production_order_id" = NEW\."referenceId"/)
  assert.match(migration, /NEW\.type = 'ADJUSTMENT'/)
})

test('stock movement value invariant compares against absolute movement quantity', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-negative-valued',
        type: 'ADJUSTMENT',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: -2,
        unitCostBase: 5,
        totalValueBase: 10,
        product: {
          id: 'product-1',
          sku: 'NEGATIVE-VALUED',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.equal(
    findings.some((finding) => finding.code === 'stock_movement_value_mismatch'),
    false,
  )
})

test('stock movement value invariant keeps boundary and symmetric partial contracts', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      {
        id: 'movement-value-boundary',
        type: 'SALE_DISPATCH',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 2,
        unitCostBase: 5,
        totalValueBase: 10.01,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-1',
          sku: 'VALUE-BOUNDARY',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-value-small-relative',
        type: 'SALE_DISPATCH',
        productId: 'product-2',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 0.01,
        unitCostBase: 0.5,
        totalValueBase: 0.005002,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-2',
          sku: 'VALUE-SMALL',
          type: 'SIMPLE',
        },
      },
      {
        id: 'movement-value-total-only',
        type: 'SALE_DISPATCH',
        productId: 'product-3',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: 2,
        unitCostBase: null,
        totalValueBase: 10,
        _count: { cogsEntries: 1 },
        product: {
          id: 'product-3',
          sku: 'VALUE-TOTAL-ONLY',
          type: 'SIMPLE',
        },
      },
    ],
    shippedShipmentLines: [],
  })

  assert.deepEqual(findings.map((finding) => finding.code).sort(), [
    'stock_movement_value_mismatch',
    'stock_movement_value_partial',
  ])
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
  assert.deepEqual((stockMovementArgs as { select: unknown }).select, {
    id: true,
    type: true,
    productId: true,
    fromWarehouseId: true,
    toWarehouseId: true,
    qty: true,
    referenceType: true,
    referenceId: true,
    unitCostBase: true,
    totalValueBase: true,
    _count: {
      select: {
        cogsEntries: true,
      },
    },
    product: {
      select: {
        id: true,
        sku: true,
        type: true,
      },
    },
  })
  const stockMovementWhere = (stockMovementArgs as { where: { AND: unknown[] } }).where
  assert.equal(Array.isArray(stockMovementWhere.AND), true)
  assert.ok((stockMovementWhere.AND[0] as { createdAt?: { gte?: unknown } }).createdAt?.gte instanceof Date)
  assert.deepEqual(stockMovementWhere.AND[1], {
    OR: [
      { qty: { lt: 0 } },
      { unitCostBase: { not: null } },
      { totalValueBase: { not: null } },
      { type: { in: ['PURCHASE_RECEIPT', 'PRODUCTION_IN', 'SALE_DISPATCH', 'PURCHASE_REVERSAL', 'PRODUCTION_OUT', 'ADJUSTMENT'] } },
    ],
  })
})

test('inventory row collection can disable the stock movement lookback for historical audits', async () => {
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
      async findMany() {
        return []
      },
    },
  }

  await collectInventoryInvariantRows(client, { stockMovementLookbackDays: null })

  assert.deepEqual((stockMovementArgs as { where: { AND: unknown[] } }).where.AND[0], {})
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
  assert.match(sql, /ABS\(sm\.qty\) \* sm\."unitCostBase"/)
  assert.match(sql, /sl\."reservedQty" - sl\.quantity > \?::numeric/)
  assert.match(sql, /sm\.qty > \?::numeric/)
  assert.match(sql, /relativeTolerance/)
  assert.match(sql, /relativeTolerance', \?::numeric/)
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
  rows.stockMovements.push(
    {
      id: 'movement-value-mismatch',
      type: 'SALE_DISPATCH',
      productId: 'product-value-mismatch',
      fromWarehouseId: 'warehouse-1',
      toWarehouseId: null,
      qty: 2,
      unitCostBase: 5,
      totalValueBase: 11,
      product: {
        id: 'product-value-mismatch',
        sku: 'VALUE-MISMATCH',
        type: 'SIMPLE',
      },
    },
    {
      id: 'movement-value-partial',
      type: 'SALE_DISPATCH',
      productId: 'product-value-partial',
      fromWarehouseId: 'warehouse-1',
      toWarehouseId: null,
      qty: 2,
      unitCostBase: 5,
      totalValueBase: null,
      product: {
        id: 'product-value-partial',
        sku: 'VALUE-PARTIAL',
        type: 'SIMPLE',
      },
    },
    {
      id: 'movement-missing-layer',
      type: 'PURCHASE_RECEIPT',
      productId: 'product-missing-layer',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: 2,
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      product: {
        id: 'product-missing-layer',
        sku: 'MISSING-LAYER',
        type: 'SIMPLE',
      },
    },
    {
      id: 'movement-missing-cogs',
      type: 'PRODUCTION_OUT',
      productId: 'product-missing-cogs',
      fromWarehouseId: 'warehouse-1',
      toWarehouseId: null,
      qty: 2,
      referenceType: 'ProductionOrder',
      referenceId: 'production-1',
      _count: { cogsEntries: 0 },
      product: {
        id: 'product-missing-cogs',
        sku: 'MISSING-COGS',
        type: 'SIMPLE',
      },
    },
  )
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

test('audit-C5: stranded in-transit transfers surface a per-line warning finding', () => {
  const dispatchedAt = new Date('2026-05-01T00:00:00.000Z')
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [],
    shippedShipmentLines: [],
    strandedTransfers: [
      {
        id: 'transfer-1',
        reference: 'TR-001',
        fromWarehouseId: 'wh-source',
        dispatchedAt,
        lines: [
          { productId: 'prod-a', qty: 5 },
          { productId: 'prod-b', qty: 2 },
        ],
      },
    ],
  })
  const stranded = findings.filter((f) => f.code === 'transfer_stranded_in_transit')
  assert.equal(stranded.length, 2)
  assert.deepEqual(stranded.map((f) => f.productId).sort(), ['prod-a', 'prod-b'])
  assert.equal(stranded[0].severity, 'warning')
  assert.equal(stranded[0].warehouseId, 'wh-source')
  const details = stranded[0].details as { transferId: string; reference: string; dispatchedAt: string }
  assert.equal(details.transferId, 'transfer-1')
  assert.equal(details.reference, 'TR-001')
  assert.equal(details.dispatchedAt, dispatchedAt.toISOString())
})

test('audit-C5: no stranded-transfer findings when none are passed (clean path)', () => {
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [],
    shippedShipmentLines: [],
  })
  assert.equal(findings.filter((f) => f.code === 'transfer_stranded_in_transit').length, 0)
})
