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
  type InventoryInvariantShipmentLineRow,
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
  'allocation_committed_shipment_uncovered',
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
    // o3d-4kfh r3: the committed-coverage census is a PAIR, and a clean fixture must supply both —
    // an allocation set with no shipment lines would read as "nothing committed", which is not the
    // same thing as "every commitment backed" and would make the check vacuous here.
    orderAllocations: [
      { lineId: 'sales-line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 },
    ],
    committedShipmentLines: [
      {
        lineId: 'sales-line-1',
        productId: 'product-1',
        qty: 2,
        product: { sku: 'SKU-1' },
        shipment: { orderId: 'order-1', warehouseId: 'warehouse-1' },
      },
    ],
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

test('forecasting-only historical-import SALE_DISPATCH movements are exempt from the COGS-evidence guard', () => {
  // These are zero-cost, warehouse-less demand records seeded for forecasting; they
  // carry no cogs_entries by design and must not be flagged (matches the DB trigger
  // exemption in migration 20260616120000).
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: ['WcHistorical', 'CsvHistorical', 'WcInitialImport'].map((referenceType, i) => ({
      id: `movement-historical-${i}`,
      type: 'SALE_DISPATCH',
      productId: `product-${i}`,
      fromWarehouseId: null,
      toWarehouseId: null,
      qty: 1,
      referenceType,
      referenceId: `${referenceType}-ref-${i}`,
      _count: { cogsEntries: 0 },
      product: { id: `product-${i}`, sku: `HIST-${i}`, type: 'SIMPLE' },
    })),
    shippedShipmentLines: [],
  })

  assert.equal(findings.some((finding) => finding.code === 'stock_movement_missing_cogs_entry'), false)
})

test('new-migration trigger exemption clause is locked (narrowed to warehouse-less SALE_DISPATCH)', () => {
  const migration = readFileSync(
    'prisma/migrations/20260616120000_exempt_historical_imports_from_cogs_guard/migration.sql',
    'utf8',
  )
  assert.match(migration, /CREATE OR REPLACE FUNCTION assert_stock_movement_reporting_evidence/)
  // The exemption must be the narrowed shape, not a blanket referenceType skip.
  assert.match(migration, /NEW\.type = 'SALE_DISPATCH'/)
  assert.match(migration, /NEW\."fromWarehouseId" IS NULL/)
  assert.match(migration, /NEW\."toWarehouseId" IS NULL/)
  assert.match(migration, /COALESCE\(NEW\."referenceType", ''\) IN \('WcHistorical', 'WcInitialImport', 'CsvHistorical'\)/)
  // The inbound cost-layer branch must remain untouched.
  assert.match(migration, /Inbound stock movement % \(%\) requires matching cost-layer evidence/)
})

test('COGS-evidence guard is NOT evaded by borrowing a historical referenceType', () => {
  // Each of these still REQUIRES COGS evidence — only a warehouse-less SALE_DISPATCH
  // with a historical referenceType is exempt.
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [
      // warehouse-backed SALE_DISPATCH with a historical referenceType → NOT exempt
      { id: 'm-wh-sale', type: 'SALE_DISPATCH', productId: 'p1', fromWarehouseId: 'warehouse-1', toWarehouseId: null, qty: 1, referenceType: 'WcHistorical', referenceId: 'r1', _count: { cogsEntries: 0 }, product: { id: 'p1', sku: 'P1', type: 'SIMPLE' } },
      // PRODUCTION_OUT with a historical referenceType → NOT exempt
      { id: 'm-prodout', type: 'PRODUCTION_OUT', productId: 'p2', fromWarehouseId: 'warehouse-1', toWarehouseId: null, qty: 1, referenceType: 'WcInitialImport', referenceId: 'r2', _count: { cogsEntries: 0 }, product: { id: 'p2', sku: 'P2', type: 'SIMPLE' } },
      // outbound ADJUSTMENT with a historical referenceType → NOT exempt
      { id: 'm-adj', type: 'ADJUSTMENT', productId: 'p3', fromWarehouseId: 'warehouse-1', toWarehouseId: null, qty: 1, referenceType: 'CsvHistorical', referenceId: 'r3', _count: { cogsEntries: 0 }, product: { id: 'p3', sku: 'P3', type: 'SIMPLE' } },
      // warehouse-less SALE_DISPATCH with null referenceType → NOT exempt
      { id: 'm-null-ref', type: 'SALE_DISPATCH', productId: 'p4', fromWarehouseId: 'warehouse-1', toWarehouseId: null, qty: 1, referenceType: null, referenceId: null, _count: { cogsEntries: 0 }, product: { id: 'p4', sku: 'P4', type: 'SIMPLE' } },
      // warehouse-less SALE_DISPATCH with an unrecognised referenceType → NOT exempt
      { id: 'm-other-ref', type: 'SALE_DISPATCH', productId: 'p5', fromWarehouseId: 'warehouse-1', toWarehouseId: null, qty: 1, referenceType: 'SalesOrder', referenceId: 'r5', _count: { cogsEntries: 0 }, product: { id: 'p5', sku: 'P5', type: 'SIMPLE' } },
    ],
    shippedShipmentLines: [],
  })

  const flagged = findings.filter((f) => f.code === 'stock_movement_missing_cogs_entry').length
  assert.equal(flagged, 5)
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
          refundStatus: { not: 'FULL' },
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
  assert.match(sql, /so\."refundStatus" <> 'FULL'/)
  assert.match(sql, /ABS\(sm\.qty\) \* sm\."unitCostBase"/)
  assert.match(sql, /sl\."reservedQty" - sl\.quantity > \?::numeric/)
  assert.match(sql, /sm\.qty > \?::numeric/)
  assert.match(sql, /relativeTolerance/)
  assert.match(sql, /relativeTolerance', \?::numeric/)
  assert.doesNotMatch(sql, /PARTIALLY_REFUNDED/)
})

test('o3d-4kfh: the reservation census credits COMMITTED reservations on zero-demand orders', async () => {
  // The SQL twin of the reservation-breakdown tests. A CANCELLED / fully-refunded order still holds
  // its PICKING/PACKED commitment on reservedQty (allocation retains the committed set; only
  // dispatch decrements the stock level), so omitting those rows made knownReservedQty short by
  // exactly that amount and reported a correctly-held reservation as a CRITICAL mismatch.
  //
  // Asserted on the generated SQL because this branch has no in-process evaluator to exercise — the
  // arithmetic is done by Postgres. Its behaviour is covered by the identical TS implementation in
  // reservation-breakdown.test.ts, and the query is executed against a real database by the
  // invariant report itself.
  let capturedQuery: unknown
  const client: InventoryInvariantSqlClient = {
    async $queryRaw<T = unknown>(query: unknown) {
      capturedQuery = query
      return [] as T
    },
  }

  await collectSqlInventoryInvariantFindingsPage(client, { limit: 10 })
  const sql = String((capturedQuery as { sql?: string }).sql ?? '')

  // ONE shipment-line CTE, split into the two readings the contract defines.
  assert.match(sql, /WHERE s\.status::text <> 'PENDING'/)
  assert.match(sql, /SUM\(sl\.qty\) FILTER \(WHERE s\.status::text = \?\)/)
  // The active branch still nets DISPATCHED only — a PICKING/PACKED shipment has released nothing.
  assert.match(sql, /SUM\(GREATEST\(oa\.qty - COALESCE\(csl\."dispatchedQty", 0\), 0\)\)/)
  // And the zero-demand branch credits the still-committed portion, bounded by the residual.
  assert.match(sql, /\(so\.status = 'CANCELLED' OR so\."refundStatus" = 'FULL'\)/)
  assert.match(
    sql,
    /LEAST\(\s*GREATEST\(oa\.qty - COALESCE\(csl\."dispatchedQty", 0\), 0\),\s*GREATEST\(COALESCE\(csl\."committedQty", 0\) - COALESCE\(csl\."dispatchedQty", 0\), 0\)\s*\)/,
  )
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
  // o3d-4kfh r3: a committed shipment line with NO allocation row behind it at its
  // (line, warehouse, product) — the census case, so this code is in the canonical set above.
  rows.committedShipmentLines!.push({
    lineId: 'sales-line-uncovered',
    productId: 'product-1',
    qty: 3,
    product: { sku: 'SKU-1' },
    shipment: { orderId: 'order-3', warehouseId: 'warehouse-1' },
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
          { id: 'line-a', productId: 'prod-a', qty: 5 },
          { id: 'line-b', productId: 'prod-b', qty: 2 },
        ],
      },
    ],
  })
  const stranded = findings.filter((f) => f.code === 'transfer_stranded_in_transit')
  assert.equal(stranded.length, 2)
  assert.deepEqual(stranded.map((f) => f.productId).sort(), ['prod-a', 'prod-b'])
  assert.equal(stranded[0].severity, 'warning')
  assert.equal(stranded[0].warehouseId, 'wh-source')
  const details = stranded[0].details as { transferId: string; transferLineId: string; reference: string; dispatchedAt: string }
  assert.equal(details.transferId, 'transfer-1')
  assert.equal(details.transferLineId, 'line-a')
  assert.equal(details.reference, 'TR-001')
  assert.equal(details.dispatchedAt, dispatchedAt.toISOString())
  // Message uses the date-only format to match the SQL collector arm.
  assert.match(stranded[0].message, /in transit since 2026-05-01 —/)
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

test('o3d-4kfh r3: a committed shipment larger than its allocation row is a critical finding', () => {
  // Finding 3's exact shape: committed 10 against a row of 5. Every consumer of the contract
  // computes `qty - committed` and floors at zero, so the five surplus units do not overflow
  // anywhere — they vanish, and are then taken out of whatever shared reservedQty is present at
  // dispatch. The reservation census cannot see it because it credits only the residual that
  // still exists.
  const rows = cleanRows()
  rows.orderAllocations = [
    { lineId: 'sales-line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  rows.committedShipmentLines = [
    {
      lineId: 'sales-line-1',
      productId: 'product-1',
      qty: 10,
      product: { sku: 'SKU-1' },
      shipment: { orderId: 'order-1', warehouseId: 'warehouse-1' },
    },
  ]

  const findings = evaluateInventoryInvariantRows(rows)
  const finding = findings.find((candidate) => candidate.code === 'allocation_committed_shipment_uncovered')

  assert.ok(finding, 'the sweep must surface an over-commitment nothing else can detect')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.productId, 'product-1')
  assert.equal(finding.warehouseId, 'warehouse-1')
  assert.deepEqual(finding.details, {
    lineId: 'sales-line-1',
    sku: 'SKU-1',
    committedQty: 10,
    allocatedQty: 5,
    delta: 5,
  })
})

test('o3d-4kfh r3: a commitment in ANOTHER warehouse is not credited to the row', () => {
  // The grain is (line, warehouse, product), not (line, product). A shipment picked from
  // warehouse-2 is not covered by an allocation in warehouse-1 — that mismatch is precisely the
  // deallocate/re-allocate-elsewhere corruption, and a line-level check would have missed it.
  const rows = cleanRows()
  rows.orderAllocations = [
    { lineId: 'sales-line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  rows.committedShipmentLines = [
    {
      lineId: 'sales-line-1',
      productId: 'product-1',
      qty: 2,
      product: { sku: 'SKU-1' },
      shipment: { orderId: 'order-1', warehouseId: 'warehouse-2' },
    },
  ]

  const finding = evaluateInventoryInvariantRows(rows)
    .find((candidate) => candidate.code === 'allocation_committed_shipment_uncovered')

  assert.ok(finding)
  assert.equal(finding.warehouseId, 'warehouse-2')
  assert.deepEqual(finding.details, {
    lineId: 'sales-line-1',
    sku: 'SKU-1',
    committedQty: 2,
    allocatedQty: 0,
    delta: 2,
  })
})

test('o3d-4kfh r3: the committed-coverage census does not run on a half-collected row set', () => {
  // Collected as a pair. Allocations without shipment lines would read as "nothing committed";
  // shipment lines without allocations would report EVERY commitment as unbacked. Either half
  // alone is worse than not running.
  const allocationsOnly = cleanRows()
  allocationsOnly.committedShipmentLines = undefined
  const shipmentsOnly = cleanRows()
  shipmentsOnly.orderAllocations = undefined
  shipmentsOnly.committedShipmentLines = [
    {
      lineId: 'sales-line-1',
      productId: 'product-1',
      qty: 99,
      product: { sku: 'SKU-1' },
      shipment: { orderId: 'order-1', warehouseId: 'warehouse-1' },
    },
  ]

  for (const rows of [allocationsOnly, shipmentsOnly]) {
    assert.equal(
      evaluateInventoryInvariantRows(rows)
        .some((finding) => finding.code === 'allocation_committed_shipment_uncovered'),
      false,
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-aqke — THE KIT HALF OF THE COMMITTED-COVERAGE CENSUS.
//
// `allocation_committed_shipment_uncovered` is flat: per (lineId, warehouseId, productId). A kit
// committed as 2xA + 1xB against a 2xA + 2xB recipe is covered on every one of those pairs and is
// still half a kit. The transition seams refuse it; the SWEEP reported nothing.

type CensusShipmentLine = {
  lineId: string
  productId: string
  sku: string
  qty: number
  status: string
  warehouseId: string
  orderId: string
  lineProductId: string
  lineSku: string
  lineProductType?: 'KIT' | 'SIMPLE'
}

/**
 * The double answers the two reads the census makes, and HONOURS both filters production relies on
 * — non-PENDING, and "the sales line's product is a KIT". Those filters are the entire reason an
 * unpaged read is affordable, so a double that ignored them would leave the scoping untested and
 * make the census look cheaper than it is.
 */
function kitCensusClient(input: {
  shipmentLines: CensusShipmentLine[]
  kits: Record<string, Array<{ componentId: string; qty: number }>>
  onGraphRead?: () => void
}) {
  const seenWhere: unknown[] = []
  const client = {
    shipmentLine: {
      findMany: async ({ where }: {
        where: {
          shipment: { status: { not: string }; warehouseId?: string }
          line: { product: { type: string } }
        }
      }) => {
        seenWhere.push(where)
        return input.shipmentLines
          .filter((line) => line.status !== where.shipment.status.not)
          .filter((line) => where.shipment.warehouseId == null || line.warehouseId === where.shipment.warehouseId)
          .filter((line) => (line.lineProductType ?? 'KIT') === where.line.product.type)
          .map((line) => ({
            lineId: line.lineId,
            productId: line.productId,
            qty: line.qty,
            product: { sku: line.sku },
            line: { productId: line.lineProductId, sku: line.lineSku, description: line.lineSku },
            shipment: { orderId: line.orderId, warehouseId: line.warehouseId },
          }))
      },
    },
    product: {
      findMany: async ({ where, select }: { where: { id: { in: string[] } }; select: Record<string, unknown> }) => {
        input.onGraphRead?.()
        return where.id.in.flatMap((id) => {
          const components = input.kits[id]
          if (!('productComponents' in select)) return [{ id, fulfillmentGraphVersion: 0 }]
          return [{
            id,
            type: components ? 'KIT' : 'SIMPLE',
            fulfillmentGraphVersion: 0,
            productComponents: (components ?? []).map((component, index) => ({
              componentId: component.componentId,
              qty: component.qty,
              component: { sku: component.componentId.toUpperCase(), type: 'SIMPLE', oversellAllowed: false },
              sortOrder: index,
            })),
          }]
        })
      },
    },
  }
  return { client, seenWhere }
}

const committedKitLine = (overrides: Partial<CensusShipmentLine>): CensusShipmentLine => ({
  lineId: 'line-1',
  productId: 'comp-a',
  sku: 'COMP-A',
  qty: 2,
  status: 'PICKING',
  warehouseId: 'warehouse-1',
  orderId: 'order-1',
  lineProductId: 'kit-1',
  lineSku: 'KIT-1',
  ...overrides,
})

test('o3d-aqke: a committed KIT set that is half a kit is reported by the census', async () => {
  const { collectDisproportionateCommittedKitFindings } = await import('@/lib/domain/inventory/invariants')
  const { client } = kitCensusClient({
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 2 }] },
    shipmentLines: [
      committedKitLine({ productId: 'comp-a', sku: 'COMP-A', qty: 2 }),
      committedKitLine({ productId: 'comp-b', sku: 'COMP-B', qty: 1 }),
    ],
  })

  const findings = await collectDisproportionateCommittedKitFindings(client)

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'allocation_committed_kit_disproportionate')
  assert.equal(findings[0].severity, 'critical')
  assert.equal(findings[0].productId, 'comp-b', 'comp-b is the short one: 1 committed where 2 are required')
  assert.equal(findings[0].warehouseId, 'warehouse-1')
  assert.deepEqual(
    (findings[0].details as { components: unknown[] }).components,
    [
      { productId: 'comp-a', sku: 'COMP-A', requiredPerKit: '2', committedQty: 2 },
      { productId: 'comp-b', sku: 'COMP-B', requiredPerKit: '2', committedQty: 1 },
    ],
  )
})

test('o3d-aqke: a fractional KIT the column rounded is NOT reported (o3d-i4qd)', async () => {
  const { collectDisproportionateCommittedKitFindings } = await import('@/lib/domain/inventory/invariants')
  // 0.5 kits of (0.3333 x comp-a + 1 x comp-b): 0.16665 stored as 0.1667 beside an exact 0.5.
  const { client } = kitCensusClient({
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 0.3333 }, { componentId: 'comp-b', qty: 1 }] },
    shipmentLines: [
      committedKitLine({ productId: 'comp-a', sku: 'COMP-A', qty: 0.1667 }),
      committedKitLine({ productId: 'comp-b', sku: 'COMP-B', qty: 0.5 }),
    ],
  })

  const findings = await collectDisproportionateCommittedKitFindings(client)

  assert.deepEqual(findings, [], 'the census must not report what Decimal(12,4) itself rounded')
})

test('o3d-aqke: the census reads only non-PENDING lines on KIT sales lines', async () => {
  const { collectDisproportionateCommittedKitFindings } = await import('@/lib/domain/inventory/invariants')
  let graphReads = 0
  const { client, seenWhere } = kitCensusClient({
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 2 }] },
    onGraphRead: () => { graphReads += 1 },
    shipmentLines: [
      // A PENDING draft is not a commitment, and a SIMPLE line has one requirement of factor 1.
      committedKitLine({ productId: 'comp-a', qty: 2, status: 'PENDING' }),
      committedKitLine({ productId: 'comp-b', qty: 1, status: 'PENDING' }),
      committedKitLine({ lineId: 'line-2', productId: 'simple-1', qty: 5, lineProductType: 'SIMPLE' }),
    ],
    ...{},
  })

  const findings = await collectDisproportionateCommittedKitFindings(client, { warehouseId: 'warehouse-1' })

  assert.deepEqual(findings, [])
  assert.equal(graphReads, 0, 'no committed kit lines means the graph is never walked at all')
  assert.deepEqual(seenWhere, [{
    shipment: { status: { not: 'PENDING' }, warehouseId: 'warehouse-1' },
    line: { product: { type: 'KIT' } },
  }])
})

test('o3d-aqke: a graph the census cannot walk is REPORTED, not thrown', async () => {
  const { collectDisproportionateCommittedKitFindings } = await import('@/lib/domain/inventory/invariants')
  const { client } = kitCensusClient({
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2 }] },
    shipmentLines: [committedKitLine({ productId: 'comp-a', qty: 2 })],
  })
  client.product.findMany = async () => { throw new Error('graph is mid-edit') }

  const findings = await collectDisproportionateCommittedKitFindings(client)

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'allocation_committed_kit_census_unavailable')
  assert.equal(findings[0].severity, 'warning')
  assert.equal((findings[0].details as { reason: string }).reason, 'graph is mid-edit')
})

test('o3d-aqke: runInventoryInvariantReport surfaces the kit census in row mode', async () => {
  // The wiring, not the pass: a report run the ordinary way must include the finding and count it.
  const { client: kitClient } = kitCensusClient({
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 2 }] },
    shipmentLines: [
      committedKitLine({ productId: 'comp-a', qty: 2 }),
      committedKitLine({ productId: 'comp-b', qty: 1 }),
    ],
  })
  const client = {
    stockLevel: { async findMany() { return [] } },
    costLayer: { async findMany() { return [] } },
    stockMovement: { async findMany() { return [] } },
    shipmentLine: {
      async findMany(args: { where?: { line?: unknown } }): Promise<InventoryInvariantShipmentLineRow[]> {
        // The row collector asks for SHIPPED lines; the kit census asks for non-PENDING KIT lines.
        if (args.where?.line) {
          return await kitClient.shipmentLine.findMany(args as never) as unknown as InventoryInvariantShipmentLineRow[]
        }
        return []
      },
    },
    product: kitClient.product,
  }

  const report = await runInventoryInvariantReport({ client })

  assert.equal(report.summary.total, 1)
  assert.equal(report.summary.critical, 1)
  assert.equal(report.findings[0].code, 'allocation_committed_kit_disproportionate')
  assert.equal(report.findings[0].productId, 'comp-b')
})

test('o3d-aqke: the FLAT committed-coverage branch cannot see a half kit — the gap being closed', () => {
  // Same commitment as the census test above, with allocation rows that match it exactly. Every
  // (lineId, warehouseId, productId) pair is covered, so the flat branch is silent — which is the
  // whole reason the graph-aware pass exists rather than a tightening of this one.
  const findings = evaluateInventoryInvariantRows({
    stockLevels: [],
    costLayers: [],
    stockMovements: [],
    shippedShipmentLines: [],
    orderAllocations: [
      { lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 2 },
      { lineId: 'line-1', productId: 'comp-b', warehouseId: 'warehouse-1', qty: 1 },
    ],
    committedShipmentLines: [
      {
        lineId: 'line-1',
        productId: 'comp-a',
        qty: 2,
        product: { sku: 'COMP-A' },
        shipment: { orderId: 'order-1', warehouseId: 'warehouse-1' },
      },
      {
        lineId: 'line-1',
        productId: 'comp-b',
        qty: 1,
        product: { sku: 'COMP-B' },
        shipment: { orderId: 'order-1', warehouseId: 'warehouse-1' },
      },
    ],
  })

  assert.deepEqual(
    findings.filter((finding) => finding.code === 'allocation_committed_shipment_uncovered'),
    [],
    'covered product-by-product, and still half a kit',
  )
})
