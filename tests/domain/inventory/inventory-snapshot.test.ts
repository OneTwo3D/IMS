import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, StockMovementType } from '../../../app/generated/prisma/client.ts'
import {
  backfillInventorySnapshots,
  buildInventoryReservationSnapshotRows,
  buildInventorySnapshotRows,
  getAverageInventoryValueBase,
  writeDailyInventorySnapshot,
  type InventorySnapshotTestClient,
} from '../../../lib/domain/inventory/inventory-snapshot.ts'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

const EXPECTED_RESERVATION_BACKFILL_LIMITATIONS = [
  'The mutation check assumes reservation-source writes use Prisma paths that maintain updatedAt values.',
  'Hard-deleted reservation source rows cannot be detected without a historical source audit table.',
  'Raw SQL updates that bypass updatedAt can make a supported day look safer than it is.',
]

function createSnapshotClient(input: {
  stockLevels?: Array<{ productId: string; warehouseId: string; quantity: Prisma.Decimal; reservedQty?: Prisma.Decimal }>
  costLayers?: Array<{ productId: string; warehouseId: string; remainingQty: Prisma.Decimal; unitCostBase: Prisma.Decimal }>
  movements?: Array<{
    id: string
    type: StockMovementType
    productId: string
    fromWarehouseId: string | null
    toWarehouseId: string | null
    qty: Prisma.Decimal
    totalValueBase: Prisma.Decimal | null
    createdAt: Date
  }>
  averageRows?: Array<{ snapshotDate: Date; valueBase: Prisma.Decimal }>
  salesOrderUpdatedAt?: Date | null
  allocationUpdatedAt?: Date | null
  productionUpdatedAt?: Date | null
  hasCommittedShipmentLine?: boolean
  hasAssemblyProductionOrder?: boolean
  allocations?: Array<{
    id: string
    orderId: string
    lineId: string
    productId: string
    warehouseId: string
    qty: Prisma.Decimal
    order: { orderNumber: string | null; externalOrderNumber: string | null; expectedDelivery: Date | null; status: string }
    line: { sku: string | null; description: string }
  }>
} = {}): InventorySnapshotTestClient & { upserts: unknown[]; reservationUpserts: unknown[]; reservationRunUpserts: unknown[] } {
  const upserts: unknown[] = []
  const reservationUpserts: unknown[] = []
  const reservationRunUpserts: unknown[] = []
  return {
    upserts,
    reservationUpserts,
    reservationRunUpserts,
    salesOrder: {
      aggregate: async () => ({ _max: { updatedAt: input.salesOrderUpdatedAt ?? null } }),
    },
    stockLevel: {
      findMany: async () => (input.stockLevels ?? []).map((level) => ({
        ...level,
        reservedQty: level.reservedQty ?? decimal('0'),
      })),
      findUnique: async () => null,
    },
    costLayer: {
      findMany: async () => input.costLayers ?? [],
    },
    stockMovement: {
      findMany: async (args) => {
        const query = args as {
          where?: { createdAt?: { gt?: Date; gte?: Date; lt?: Date; lte?: Date } }
          cursor?: { id: string }
          skip?: number
          take?: number
        } | undefined
        const range = query?.where?.createdAt ?? {}
        const movements = [...(input.movements ?? [])].sort((a, b) => (
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
        )).filter((movement) => (
          (!range.gt || movement.createdAt > range.gt) &&
          (!range.gte || movement.createdAt >= range.gte) &&
          (!range.lt || movement.createdAt < range.lt) &&
          (!range.lte || movement.createdAt <= range.lte)
        ))
        const cursorIndex = query?.cursor?.id == null
          ? -1
          : movements.findIndex((movement) => movement.id === query.cursor!.id)
        const startIndex = cursorIndex >= 0 ? cursorIndex + (query?.skip ?? 0) : 0
        return movements.slice(startIndex, query?.take == null ? undefined : startIndex + query.take)
      },
    },
    inventorySnapshot: {
      findMany: async () => input.averageRows ?? [],
      upsert: async (args) => {
        upserts.push(args)
        return {}
      },
    },
    inventoryReservationSnapshot: {
      upsert: async (args) => {
        reservationUpserts.push(args)
        return {}
      },
    },
    inventoryReservationSnapshotRun: {
      upsert: async (args) => {
        reservationRunUpserts.push(args)
        return {}
      },
    },
    orderAllocation: {
      findMany: async () => input.allocations ?? [],
      aggregate: async () => ({ _max: { updatedAt: input.allocationUpdatedAt ?? null } }),
    },
    shipmentLine: {
      findMany: async () => [],
      findFirst: async () => input.hasCommittedShipmentLine ? { id: 'shipment-line-1' } : null,
    },
    productionOrder: {
      findMany: async () => [],
      aggregate: async () => ({ _max: { updatedAt: input.productionUpdatedAt ?? null } }),
      findFirst: async () => input.hasAssemblyProductionOrder ? { id: 'production-order-1' } : null,
    },
    $transaction: async (operations) => Promise.all(operations),
  }
}

test('inventory snapshot rows value stock from remaining FIFO layers and report quantity drift', () => {
  const result = buildInventorySnapshotRows({
    snapshotDate: '2026-05-28',
    stockLevels: [
      { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') },
      { productId: 'product-2', warehouseId: 'warehouse-1', quantity: decimal('4') },
    ],
    costLayers: [
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('6'), unitCostBase: decimal('2') },
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('3') },
      { productId: 'product-2', warehouseId: 'warehouse-1', remainingQty: decimal('3'), unitCostBase: decimal('1') },
    ],
  })

  assert.equal(result.snapshotDate.toISOString(), '2026-05-28T00:00:00.000Z')
  assert.deepEqual(
    result.rows.map((row) => ({
      productId: row.productId,
      warehouseId: row.warehouseId,
      qty: row.qty.toFixed(4),
      valueBase: row.valueBase.toFixed(6),
      unitCostBase: row.unitCostBase?.toFixed(6) ?? null,
    })),
    [
      {
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        qty: '10.0000',
        valueBase: '24.000000',
        unitCostBase: '2.400000',
      },
      {
        productId: 'product-2',
        warehouseId: 'warehouse-1',
        qty: '4.0000',
        valueBase: '3.000000',
        unitCostBase: '0.750000',
      },
    ],
  )
  assert.deepEqual(result.drift, [
    {
      productId: 'product-2',
      warehouseId: 'warehouse-1',
      stockQty: '4.0000',
      costLayerQty: '3.0000',
      delta: '1.0000',
    },
  ])
})

test('daily inventory snapshot upserts by date/product/warehouse and returns drift counts', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('2'), reservedQty: decimal('0.5') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('2'), unitCostBase: decimal('5') }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('0.5'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'CONFIRMED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await writeDailyInventorySnapshot({
    client,
    snapshotDate: '2026-05-28',
  })

  assert.deepEqual(result, {
    snapshotDate: '2026-05-28',
    snapshotsWritten: 1,
    reservationSnapshotsWritten: 1,
    reservationSnapshotStockLevelCount: 1,
    driftCount: 0,
    driftTruncated: false,
    drift: [],
  })
  assert.equal(client.upserts.length, 1)
  assert.deepEqual(
    (client.upserts[0] as { where: { snapshotDate_productId_warehouseId: Record<string, unknown> } }).where
      .snapshotDate_productId_warehouseId,
    {
      snapshotDate: new Date('2026-05-28T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
    },
  )
  assert.equal(client.reservationUpserts.length, 1)
  const reservationCreate = (client.reservationUpserts[0] as {
    create: {
      snapshotDate: Date
      productId: string
      warehouseId: string
      reservedQty: Prisma.Decimal
      availableQty: Prisma.Decimal
      reservationSourceCount: number
    }
  }).create
  assert.deepEqual(
    {
      snapshotDate: reservationCreate.snapshotDate,
      productId: reservationCreate.productId,
      warehouseId: reservationCreate.warehouseId,
      reservedQty: reservationCreate.reservedQty.toFixed(4),
      availableQty: reservationCreate.availableQty.toFixed(4),
      reservationSourceCount: reservationCreate.reservationSourceCount,
    },
    {
      snapshotDate: new Date('2026-05-28T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      reservedQty: '0.5000',
      availableQty: '1.5000',
      reservationSourceCount: 1,
    },
  )
  assert.equal(client.reservationRunUpserts.length, 1)
  const reservationRunCreate = (client.reservationRunUpserts[0] as {
    create: {
      snapshotDate: Date
      stockLevelCount: number
      reservationSnapshotCount: number
      source: string
      checkMethod: string
      cutoffAt: Date
      reservationSourceCount: number
    }
  }).create
  assert.deepEqual({
    snapshotDate: reservationRunCreate.snapshotDate,
    stockLevelCount: reservationRunCreate.stockLevelCount,
    reservationSnapshotCount: reservationRunCreate.reservationSnapshotCount,
    source: reservationRunCreate.source,
    checkMethod: reservationRunCreate.checkMethod,
    cutoffAt: reservationRunCreate.cutoffAt,
    reservationSourceCount: reservationRunCreate.reservationSourceCount,
  }, {
    snapshotDate: new Date('2026-05-28T00:00:00.000Z'),
    stockLevelCount: 1,
    reservationSnapshotCount: 1,
    source: 'cron',
    checkMethod: 'daily_current_state_v1',
    cutoffAt: new Date('2026-05-29T00:00:00.000Z'),
    reservationSourceCount: 1,
  })
})

test('reservation snapshot rows round quantities, keep negative availability evidence, and skip zero noise', () => {
  const rows = buildInventoryReservationSnapshotRows({
    snapshotDate: '2026-05-28',
    stockLevels: [
      { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('1'), reservedQty: decimal('2.12345') },
      { productId: 'product-2', warehouseId: 'warehouse-1', quantity: decimal('5'), reservedQty: decimal('0') },
    ],
    reservationSources: [
      {
        source: 'sales_order',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        referenceId: 'order-1',
        referenceLabel: 'SO 1',
        qty: '1',
        expectedDate: null,
      },
      {
        source: 'production_order',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        referenceId: 'mo-1',
        referenceLabel: 'MO 1',
        qty: '1.1234',
        expectedDate: null,
      },
    ],
  })

  assert.deepEqual(
    rows.map((row) => ({
      productId: row.productId,
      warehouseId: row.warehouseId,
      reservedQty: row.reservedQty.toFixed(4),
      availableQty: row.availableQty.toFixed(4),
      reservationSourceCount: row.reservationSourceCount,
    })),
    [
      {
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        reservedQty: '2.1235',
        availableQty: '-1.1235',
        reservationSourceCount: 2,
      },
    ],
  )
})

test('historical backfill replays later movements backwards from current state', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('10'), unitCostBase: decimal('2') }],
    movements: [
      {
        id: 'movement-1',
        type: StockMovementType.SALE_DISPATCH,
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: decimal('2'),
        totalValueBase: decimal('4'),
        createdAt: new Date('2026-05-28T12:00:00.000Z'),
      },
    ],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-27',
    toDate: '2026-05-28',
  })

  assert.deepEqual(result, {
    fromDate: '2026-05-27',
    toDate: '2026-05-28',
    daysWritten: 2,
    snapshotsWritten: 2,
    missingValueMovementCount: 0,
    dryRun: false,
    valueReplayReliable: true,
    reservationBackfill: {
      enabled: false,
      reliability: 'not_attempted',
      totalDaysInRange: 0,
      supportedDaysWritten: 0,
      snapshotsWritten: 0,
      runMarkersWritten: 0,
      unsupportedDaysSkipped: 0,
      warnings: [],
      knownLimitations: [],
    },
  })
  const creates = client.upserts.map((upsert) => (upsert as { create: { snapshotDate: Date; qty: Prisma.Decimal; valueBase: Prisma.Decimal } }).create)
  assert.deepEqual(
    creates.map((row) => ({
      snapshotDate: row.snapshotDate.toISOString(),
      qty: row.qty.toFixed(4),
      valueBase: row.valueBase.toFixed(6),
    })),
    [
      { snapshotDate: '2026-05-28T00:00:00.000Z', qty: '10.0000', valueBase: '20.000000' },
      { snapshotDate: '2026-05-27T00:00:00.000Z', qty: '12.0000', valueBase: '24.000000' },
    ],
  )
})

test('reservation backfill writes sparse rows and run markers for reliable days', async () => {
  const client = createSnapshotClient({
    stockLevels: [
      { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1.25') },
      { productId: 'product-2', warehouseId: 'warehouse-1', quantity: decimal('3'), reservedQty: decimal('0') },
    ],
    costLayers: [
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') },
      { productId: 'product-2', warehouseId: 'warehouse-1', remainingQty: decimal('3'), unitCostBase: decimal('1') },
    ],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1.25'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.deepEqual(result.reservationBackfill, {
    enabled: true,
    reliability: 'reliable',
    totalDaysInRange: 1,
    supportedDaysWritten: 1,
    snapshotsWritten: 1,
    runMarkersWritten: 1,
    unsupportedDaysSkipped: 0,
    warnings: [],
    knownLimitations: EXPECTED_RESERVATION_BACKFILL_LIMITATIONS,
  })
  assert.equal(client.reservationUpserts.length, 1)
  const reservationCreate = (client.reservationUpserts[0] as {
    create: {
      snapshotDate: Date
      productId: string
      warehouseId: string
      reservedQty: Prisma.Decimal
      availableQty: Prisma.Decimal
      reservationSourceCount: number
    }
  }).create
  assert.deepEqual({
    snapshotDate: reservationCreate.snapshotDate.toISOString(),
    productId: reservationCreate.productId,
    warehouseId: reservationCreate.warehouseId,
    reservedQty: reservationCreate.reservedQty.toFixed(4),
    availableQty: reservationCreate.availableQty.toFixed(4),
    reservationSourceCount: reservationCreate.reservationSourceCount,
  }, {
    snapshotDate: '2026-05-28T00:00:00.000Z',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    reservedQty: '1.2500',
    availableQty: '2.7500',
    reservationSourceCount: 1,
  })
  assert.equal(client.reservationRunUpserts.length, 1)
  const reservationRunCreate = (client.reservationRunUpserts[0] as {
    create: {
      snapshotDate: Date
      source: string
      checkMethod: string
      cutoffAt: Date
      reservationSourceCount: number
    }
  }).create
  assert.deepEqual({
    snapshotDate: reservationRunCreate.snapshotDate.toISOString(),
    source: reservationRunCreate.source,
    checkMethod: reservationRunCreate.checkMethod,
    cutoffAt: reservationRunCreate.cutoffAt.toISOString(),
    reservationSourceCount: reservationRunCreate.reservationSourceCount,
  }, {
    snapshotDate: '2026-05-28T00:00:00.000Z',
    source: 'backfill',
    checkMethod: 'current_sources_updated_at_gate_v2',
    cutoffAt: '2026-05-29T00:00:00.000Z',
    reservationSourceCount: 1,
  })
})

test('reservation backfill warns and skips run marker when source state changed after cutoff', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    allocationUpdatedAt: new Date('2026-05-29T00:00:00.000Z'),
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.deepEqual(result.reservationBackfill, {
    enabled: true,
    reliability: 'warnings',
    totalDaysInRange: 1,
    supportedDaysWritten: 0,
    snapshotsWritten: 0,
    runMarkersWritten: 0,
    unsupportedDaysSkipped: 1,
    warnings: [{
      snapshotDate: '2026-05-28',
      code: 'reservation_source_changed_after_cutoff',
      message: 'Reservation sources changed on or after 2026-05-29T00:00:00.000Z; historical reserved quantities cannot be reconstructed from current allocation/shipment/production state for this day.',
    }],
    knownLimitations: EXPECTED_RESERVATION_BACKFILL_LIMITATIONS,
  })
  assert.equal(client.reservationUpserts.length, 0)
  assert.equal(client.reservationRunUpserts.length, 0)
})

test('reservation backfill checks each mutable reservation source path', async () => {
  for (const [field, updatedAt] of [
    ['salesOrderUpdatedAt', new Date('2026-05-29T00:00:00.000Z')],
    ['productionUpdatedAt', new Date('2026-05-29T00:00:00.000Z')],
  ] as const) {
    const client = createSnapshotClient({
      stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
      costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
      [field]: updatedAt,
      allocations: [{
        id: 'allocation-1',
        orderId: 'order-1',
        lineId: 'line-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        qty: decimal('1'),
        order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
        line: { sku: 'SKU-1', description: 'Widget' },
      }],
    })

    const result = await backfillInventorySnapshots({
      client,
      fromDate: '2026-05-28',
      toDate: '2026-05-28',
      includeReservationSnapshots: true,
    })

    assert.equal(result.reservationBackfill.reliability, 'warnings')
    assert.equal(result.reservationBackfill.unsupportedDaysSkipped, 1)
    assert.deepEqual(
      result.reservationBackfill.warnings.map((warning) => warning.code),
      ['reservation_source_changed_after_cutoff'],
    )
    assert.equal(client.reservationUpserts.length, 0)
    assert.equal(client.reservationRunUpserts.length, 0)
  }
})

test('reservation backfill skips days when shipment-line history is not provable', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    hasCommittedShipmentLine: true,
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.deepEqual(result.reservationBackfill.warnings, [{
    snapshotDate: '2026-05-28',
    code: 'timestampless_shipment_line_history_unavailable',
    message: 'Committed shipment lines exist but shipment_lines has no updatedAt column; historical reservation reconstruction cannot prove shipment-line membership for this day.',
  }])
  assert.equal(result.reservationBackfill.unsupportedDaysSkipped, 1)
  assert.equal(client.reservationRunUpserts.length, 0)
})

test('reservation backfill skips days when assembly BOM component history is not provable', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    hasAssemblyProductionOrder: true,
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.deepEqual(result.reservationBackfill.warnings, [{
    snapshotDate: '2026-05-28',
    code: 'assembly_component_history_unavailable',
    message: 'In-progress assembly production orders depend on current BOM component membership; historical reservation reconstruction cannot prove component reservations for this day.',
  }])
  assert.equal(result.reservationBackfill.unsupportedDaysSkipped, 1)
  assert.equal(client.reservationRunUpserts.length, 0)
})

test('reservation backfill writes negative availability as evidence with a warning', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('1'), reservedQty: decimal('2') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('1'), unitCostBase: decimal('2') }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('2'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.deepEqual(result.reservationBackfill.warnings, [{
    snapshotDate: '2026-05-28',
    code: 'negative_available_qty',
    message: '1 reservation snapshot row(s) have negative availableQty; the value is stored as evidence because reservation quantity exceeds historical on-hand quantity.',
  }])
  assert.equal(result.reservationBackfill.reliability, 'warnings')
  assert.equal(client.reservationUpserts.length, 1)
  const reservationCreate = (client.reservationUpserts[0] as {
    create: { availableQty: Prisma.Decimal; reservedQty: Prisma.Decimal }
  }).create
  assert.equal(reservationCreate.reservedQty.toFixed(4), '2.0000')
  assert.equal(reservationCreate.availableQty.toFixed(4), '-1.0000')
  assert.equal(client.reservationRunUpserts.length, 1)
})

test('reservation backfill handles mixed supported and unsupported days', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    allocationUpdatedAt: new Date('2026-05-29T12:00:00.000Z'),
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-29',
    includeReservationSnapshots: true,
  })

  assert.deepEqual({
    reliability: result.reservationBackfill.reliability,
    totalDaysInRange: result.reservationBackfill.totalDaysInRange,
    supportedDaysWritten: result.reservationBackfill.supportedDaysWritten,
    unsupportedDaysSkipped: result.reservationBackfill.unsupportedDaysSkipped,
    snapshotsWritten: result.reservationBackfill.snapshotsWritten,
    runMarkersWritten: result.reservationBackfill.runMarkersWritten,
    warningDates: result.reservationBackfill.warnings.map((warning) => warning.snapshotDate),
  }, {
    reliability: 'warnings',
    totalDaysInRange: 2,
    supportedDaysWritten: 1,
    unsupportedDaysSkipped: 1,
    snapshotsWritten: 1,
    runMarkersWritten: 1,
    warningDates: ['2026-05-28'],
  })
  assert.equal(client.reservationRunUpserts.length, 1)
})

test('reservation backfill reruns are idempotent by snapshot date and stock pair', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })
  await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    includeReservationSnapshots: true,
  })

  assert.equal(client.reservationUpserts.length, 2)
  assert.deepEqual(
    client.reservationUpserts.map((upsert) => (upsert as {
      where: { snapshotDate_productId_warehouseId: { snapshotDate: Date; productId: string; warehouseId: string } }
    }).where.snapshotDate_productId_warehouseId),
    [
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z'), productId: 'product-1', warehouseId: 'warehouse-1' },
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z'), productId: 'product-1', warehouseId: 'warehouse-1' },
    ],
  )
  assert.deepEqual(
    client.reservationUpserts.map((upsert) => {
      const update = (upsert as {
        update: { reservedQty: Prisma.Decimal; availableQty: Prisma.Decimal; reservationSourceCount: number }
      }).update
      return {
        reservedQty: update.reservedQty.toFixed(4),
        availableQty: update.availableQty.toFixed(4),
        reservationSourceCount: update.reservationSourceCount,
      }
    }),
    [
      { reservedQty: '1.0000', availableQty: '3.0000', reservationSourceCount: 1 },
      { reservedQty: '1.0000', availableQty: '3.0000', reservationSourceCount: 1 },
    ],
  )
  assert.equal(client.reservationRunUpserts.length, 2)
  assert.deepEqual(
    client.reservationRunUpserts.map((upsert) => (upsert as {
      where: { snapshotDate: Date }
    }).where),
    [
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z') },
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z') },
    ],
  )
  assert.deepEqual(
    client.reservationRunUpserts.map((upsert) => {
      const update = (upsert as {
        update: {
          source: string
          checkMethod: string
          cutoffAt: Date
          stockLevelCount: number
          reservationSnapshotCount: number
          reservationSourceCount: number
        }
      }).update
      return {
        source: update.source,
        checkMethod: update.checkMethod,
        cutoffAt: update.cutoffAt.toISOString(),
        stockLevelCount: update.stockLevelCount,
        reservationSnapshotCount: update.reservationSnapshotCount,
        reservationSourceCount: update.reservationSourceCount,
      }
    }),
    [
      {
        source: 'backfill',
        checkMethod: 'current_sources_updated_at_gate_v2',
        cutoffAt: '2026-05-29T00:00:00.000Z',
        stockLevelCount: 1,
        reservationSnapshotCount: 1,
        reservationSourceCount: 1,
      },
      {
        source: 'backfill',
        checkMethod: 'current_sources_updated_at_gate_v2',
        cutoffAt: '2026-05-29T00:00:00.000Z',
        stockLevelCount: 1,
        reservationSnapshotCount: 1,
        reservationSourceCount: 1,
      },
    ],
  )
})

test('average inventory value reads snapshot rows by date range and averages daily totals', async () => {
  const client = createSnapshotClient({
    averageRows: [
      { snapshotDate: new Date('2026-05-27T00:00:00.000Z'), valueBase: decimal('10') },
      { snapshotDate: new Date('2026-05-27T00:00:00.000Z'), valueBase: decimal('5') },
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z'), valueBase: decimal('21') },
    ],
  })

  assert.equal(
    await getAverageInventoryValueBase({
      client,
      fromDate: '2026-05-27',
      toDate: '2026-05-28',
    }),
    '18.000000',
  )
})

test('inventory snapshot date parser rejects non date-only strings', () => {
  assert.throws(
    () => buildInventorySnapshotRows({
      snapshotDate: '2026-05-28T00:00:00',
      stockLevels: [],
      costLayers: [],
    }),
    /YYYY-MM-DD/,
  )
})

test('inventory snapshot rows preserve explicit zero rows for idempotent rewrites', () => {
  const result = buildInventorySnapshotRows({
    snapshotDate: '2026-05-28',
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0') }],
    costLayers: [],
  })

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]!.qty.toFixed(4), '0.0000')
  assert.equal(result.rows[0]!.valueBase.toFixed(6), '0.000000')
  assert.equal(result.rows[0]!.unitCostBase, null)
})

test('inventory snapshot drift handles ids containing colons and tolerance boundary', () => {
  const atTolerance = buildInventorySnapshotRows({
    snapshotDate: '2026-05-28',
    stockLevels: [{ productId: 'product:1', warehouseId: 'warehouse:1', quantity: decimal('1.0001') }],
    costLayers: [{ productId: 'product:1', warehouseId: 'warehouse:1', remainingQty: decimal('1'), unitCostBase: decimal('2') }],
  })
  assert.deepEqual(atTolerance.drift, [])

  const aboveTolerance = buildInventorySnapshotRows({
    snapshotDate: '2026-05-28',
    stockLevels: [{ productId: 'product:1', warehouseId: 'warehouse:1', quantity: decimal('1.0002') }],
    costLayers: [{ productId: 'product:1', warehouseId: 'warehouse:1', remainingQty: decimal('1'), unitCostBase: decimal('2') }],
  })
  assert.deepEqual(aboveTolerance.drift, [{
    productId: 'product:1',
    warehouseId: 'warehouse:1',
    stockQty: '1.0002',
    costLayerQty: '1.0000',
    delta: '0.0002',
  }])
})

test('daily snapshot returns capped drift details with explicit truncation flag', async () => {
  const client = createSnapshotClient({
    stockLevels: Array.from({ length: 30 }, (_, index) => ({
      productId: `product-${String(index).padStart(2, '0')}`,
      warehouseId: 'warehouse-1',
      quantity: decimal('2'),
    })),
    costLayers: Array.from({ length: 30 }, (_, index) => ({
      productId: `product-${String(index).padStart(2, '0')}`,
      warehouseId: 'warehouse-1',
      remainingQty: decimal('1'),
      unitCostBase: decimal('1'),
    })),
  })

  const result = await writeDailyInventorySnapshot({
    client,
    snapshotDate: '2026-05-28',
  })

  assert.equal(result.driftCount, 30)
  assert.equal(result.driftTruncated, true)
  assert.equal(result.drift.length, 25)
})

test('historical backfill dry-run does not write and reports null-value movement bias', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('10'), unitCostBase: decimal('2') }],
    movements: [
      {
        id: 'movement-null',
        type: StockMovementType.SALE_DISPATCH,
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: decimal('2'),
        totalValueBase: null,
        createdAt: new Date('2026-05-28T12:00:00.000Z'),
      },
      {
        id: 'movement-marker',
        type: StockMovementType.WMS_RECEIPT_RECONCILIATION,
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: null,
        qty: decimal('0'),
        totalValueBase: null,
        createdAt: new Date('2026-05-28T13:00:00.000Z'),
      },
    ],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-27',
    toDate: '2026-05-28',
    dryRun: true,
  })

  assert.equal(client.upserts.length, 0)
  assert.equal(result.dryRun, true)
  assert.equal(result.missingValueMovementCount, 1)
  assert.equal(result.valueReplayReliable, false)
  assert.deepEqual(result.reservationBackfill, {
    enabled: false,
    reliability: 'not_attempted',
    totalDaysInRange: 0,
    supportedDaysWritten: 0,
    snapshotsWritten: 0,
    runMarkersWritten: 0,
    unsupportedDaysSkipped: 0,
    warnings: [],
    knownLimitations: [],
  })
})

test('reservation backfill dry-run reports supported reservation work without writing rows or run markers', async () => {
  const client = createSnapshotClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('2') }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('1'),
      order: { orderNumber: 'SO-1', externalOrderNumber: null, expectedDelivery: null, status: 'ALLOCATED' },
      line: { sku: 'SKU-1', description: 'Widget' },
    }],
  })

  const result = await backfillInventorySnapshots({
    client,
    fromDate: '2026-05-28',
    toDate: '2026-05-28',
    dryRun: true,
    includeReservationSnapshots: true,
  })

  assert.equal(client.reservationUpserts.length, 0)
  assert.equal(client.reservationRunUpserts.length, 0)
  assert.deepEqual(result.reservationBackfill, {
    enabled: true,
    reliability: 'reliable',
    totalDaysInRange: 1,
    supportedDaysWritten: 1,
    snapshotsWritten: 1,
    runMarkersWritten: 0,
    unsupportedDaysSkipped: 0,
    warnings: [],
    knownLimitations: EXPECTED_RESERVATION_BACKFILL_LIMITATIONS,
  })
})

test('historical backfill rejects inverted and future date ranges', async () => {
  const client = createSnapshotClient()
  await assert.rejects(
    () => backfillInventorySnapshots({ client, fromDate: '2026-05-29', toDate: '2026-05-28' }),
    /fromDate must be before/,
  )
  await assert.rejects(
    () => backfillInventorySnapshots({ client, fromDate: '2099-01-01', toDate: '2099-01-01' }),
    /cannot be in the future/,
  )
})

test('average inventory value divides by observed snapshot days, not calendar days (scjz.47)', async () => {
  const client = createSnapshotClient({
    averageRows: [
      { snapshotDate: new Date('2026-05-27T00:00:00.000Z'), valueBase: decimal('100') },
    ],
  })

  // One snapshot day in a 2-calendar-day range → average is 100/1, not 100/2.
  // Calendar-day division understated the average when days lack snapshots.
  assert.equal(
    await getAverageInventoryValueBase({ client, fromDate: '2026-05-27', toDate: '2026-05-28' }),
    '100.000000',
  )

  // Two distinct snapshot days → divide by 2.
  const twoDayClient = createSnapshotClient({
    averageRows: [
      { snapshotDate: new Date('2026-05-27T00:00:00.000Z'), valueBase: decimal('100') },
      { snapshotDate: new Date('2026-05-28T00:00:00.000Z'), valueBase: decimal('300') },
    ],
  })
  assert.equal(
    await getAverageInventoryValueBase({ client: twoDayClient, fromDate: '2026-05-27', toDate: '2026-05-31' }),
    '200.000000',
  )

  assert.equal(
    await getAverageInventoryValueBase({ client: createSnapshotClient(), fromDate: '2026-05-27', toDate: '2026-05-28' }),
    '0.000000',
  )
  await assert.rejects(
    () => getAverageInventoryValueBase({ client, fromDate: '2026-05-29', toDate: '2026-05-28' }),
    /fromDate must be before/,
  )
})
