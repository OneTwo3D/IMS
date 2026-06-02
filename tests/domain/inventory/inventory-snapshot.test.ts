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
        const query = args as { cursor?: { id: string }; skip?: number; take?: number } | undefined
        const movements = [...(input.movements ?? [])].sort((a, b) => (
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
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
    },
    shipmentLine: {
      findMany: async () => [],
    },
    productionOrder: {
      findMany: async () => [],
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
    create: { snapshotDate: Date; stockLevelCount: number; reservationSnapshotCount: number }
  }).create
  assert.deepEqual(reservationRunCreate, {
    snapshotDate: new Date('2026-05-28T00:00:00.000Z'),
    stockLevelCount: 1,
    reservationSnapshotCount: 1,
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

test('average inventory value divides by calendar days and handles empty ranges', async () => {
  const client = createSnapshotClient({
    averageRows: [
      { snapshotDate: new Date('2026-05-27T00:00:00.000Z'), valueBase: decimal('100') },
    ],
  })

  assert.equal(
    await getAverageInventoryValueBase({ client, fromDate: '2026-05-27', toDate: '2026-05-28' }),
    '50.000000',
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
