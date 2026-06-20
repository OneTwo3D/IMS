import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '../../../app/generated/prisma/client.ts'
import {
  getOnHandAsOf,
  InventoryAsOfFutureError,
  type OnHandAsOfClient,
} from '../../../lib/domain/inventory/get-on-hand-as-of.ts'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

type SnapshotFixture = {
  snapshotDate: Date
  productId: string
  warehouseId: string
  qty: Prisma.Decimal
  valueBase: Prisma.Decimal
  categoryId?: string
}

type MovementFixture = {
  id: string
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: Prisma.Decimal
  totalValueBase: Prisma.Decimal | null
  createdAt: Date
  type?: 'ADJUSTMENT' | 'SALE_DISPATCH' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'OPENING_STOCK'
  categoryId?: string
}

function createClient(input: {
  snapshots?: SnapshotFixture[]
  movements?: MovementFixture[]
  stockLevels?: Array<{ productId: string; warehouseId: string; quantity: Prisma.Decimal; categoryId?: string }>
  costLayers?: Array<{
    productId: string
    warehouseId: string
    remainingQty: Prisma.Decimal
    unitCostBase: Prisma.Decimal
    categoryId?: string
  }>
  postAsOfRevaluations?: Array<{ productId?: string; warehouseId?: string; effectiveAt: Date }>
} = {}): OnHandAsOfClient {
  return {
    inventorySnapshot: {
      findFirst: async (args: unknown) => {
        const query = args as {
          where?: { snapshotDate?: { lte?: Date; gt?: Date } }
          orderBy?: { snapshotDate?: 'asc' | 'desc' }
        }
        const dateFilter = query.where?.snapshotDate
        const rows = [...(input.snapshots ?? [])]
          .filter((row) => (
            (!dateFilter?.lte || row.snapshotDate <= dateFilter.lte) &&
            (!dateFilter?.gt || row.snapshotDate > dateFilter.gt)
          ))
          .sort((a, b) => query.orderBy?.snapshotDate === 'asc'
            ? a.snapshotDate.getTime() - b.snapshotDate.getTime()
            : b.snapshotDate.getTime() - a.snapshotDate.getTime())
        return rows[0] ? { snapshotDate: rows[0].snapshotDate } : null
      },
      findMany: async (args: unknown) => {
        const query = args as {
          where?: {
            snapshotDate?: Date
            productId?: string
            warehouseId?: string
            product?: { categoryId?: string }
          }
        }
        const where = query.where ?? {}
        return (input.snapshots ?? [])
          .filter((row) => (
            (!where.snapshotDate || row.snapshotDate.getTime() === where.snapshotDate.getTime()) &&
            (!where.productId || row.productId === where.productId) &&
            (!where.warehouseId || row.warehouseId === where.warehouseId) &&
            (!where.product?.categoryId || row.categoryId === where.product.categoryId)
          ))
          .map(({ productId, warehouseId, qty, valueBase }) => ({ productId, warehouseId, qty, valueBase }))
      },
    },
    stockMovement: {
      findMany: async (args: unknown) => {
        const query = args as {
          where?: {
            createdAt?: { gt?: Date; gte?: Date; lt?: Date; lte?: Date }
            productId?: string
            product?: { categoryId?: string }
            OR?: Array<{ fromWarehouseId?: string; toWarehouseId?: string }>
          }
          cursor?: { id: string }
          skip?: number
          take?: number
        }
        const where = query.where ?? {}
        const range = where.createdAt ?? {}
        const warehouseIds = new Set(where.OR?.flatMap((clause) => [
          clause.fromWarehouseId,
          clause.toWarehouseId,
        ]).filter((value): value is string => typeof value === 'string') ?? [])
        const rows = [...(input.movements ?? [])]
          .filter((movement) => (
            (!range.gt || movement.createdAt > range.gt) &&
            (!range.gte || movement.createdAt >= range.gte) &&
            (!range.lt || movement.createdAt < range.lt) &&
            (!range.lte || movement.createdAt <= range.lte) &&
            (!where.productId || movement.productId === where.productId) &&
            (!where.product?.categoryId || movement.categoryId === where.product.categoryId) &&
            (warehouseIds.size === 0 ||
              (movement.fromWarehouseId != null && warehouseIds.has(movement.fromWarehouseId)) ||
              (movement.toWarehouseId != null && warehouseIds.has(movement.toWarehouseId)))
          ))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        const startIndex = query.cursor
          ? rows.findIndex((movement) => movement.id === query.cursor?.id) + (query.skip ?? 0)
          : 0
        const page = rows.slice(
          Math.max(0, startIndex),
          query.take == null ? undefined : Math.max(0, startIndex) + query.take,
        )
        return page.map(({ id, createdAt, type, productId, fromWarehouseId, toWarehouseId, qty, totalValueBase }) => ({
          id,
          createdAt,
          type: type ?? 'ADJUSTMENT',
          productId,
          fromWarehouseId,
          toWarehouseId,
          qty,
          totalValueBase,
        }))
      },
    },
    stockLevel: {
      findMany: async (args: unknown) => {
        const query = args as {
          where?: { productId?: string; warehouseId?: string; product?: { categoryId?: string } }
        }
        const where = query.where ?? {}
        return (input.stockLevels ?? [])
          .filter((row) => (
            (!where.productId || row.productId === where.productId) &&
            (!where.warehouseId || row.warehouseId === where.warehouseId) &&
            (!where.product?.categoryId || row.categoryId === where.product.categoryId)
          ))
          .map(({ productId, warehouseId, quantity }) => ({ productId, warehouseId, quantity }))
      },
    },
    costLayer: {
      findMany: async (args: unknown) => {
        const query = args as {
          where?: { productId?: string; warehouseId?: string; product?: { categoryId?: string } }
        }
        const where = query.where ?? {}
        return (input.costLayers ?? [])
          .filter((row) => (
            (!where.productId || row.productId === where.productId) &&
            (!where.warehouseId || row.warehouseId === where.warehouseId) &&
            (!where.product?.categoryId || row.categoryId === where.product.categoryId)
          ))
          .map(({ productId, warehouseId, remainingQty, unitCostBase }) => ({
            productId,
            warehouseId,
            remainingQty,
            unitCostBase,
          }))
      },
    },
    costLayerRevaluation: {
      count: async (args: unknown) => {
        const where = (args as { where?: { effectiveAt?: { gt?: Date; gte?: Date }; costLayer?: { productId?: string; warehouseId?: string } } }).where ?? {}
        const { gt, gte } = where.effectiveAt ?? {}
        const cl = where.costLayer ?? {}
        return (input.postAsOfRevaluations ?? []).filter((row) => (
          (!gt || row.effectiveAt > gt) &&
          (!gte || row.effectiveAt >= gte) &&
          (!cl.productId || row.productId === cl.productId) &&
          (!cl.warehouseId || row.warehouseId === cl.warehouseId)
        )).length
      },
    },
  } as unknown as OnHandAsOfClient
}

test('getOnHandAsOf returns the snapshot row on a snapshot day', async () => {
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [{
      id: 'later',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('15'),
      createdAt: new Date('2026-05-28T10:00:00.000Z'),
    }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'snapshot_forward_replay')
  assert.equal(result.anchorDate, '2026-05-27')
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '10.000000',
    valueBase: '20.000000',
    unitCostBase: '2.000000',
  }])
  // No in-scope layer was revalued after asOf → point-in-time reliable.
  assert.equal(result.postAsOfRevaluationCount, 0)
  assert.equal(result.valueReplayReliable, true)
})

test('getOnHandAsOf flags current-reverse valuation unreliable when a layer was revalued after asOf (scjz.43)', async () => {
  // No snapshot → current_reverse_replay, which values from CURRENT layers; a later
  // revaluation means the reversed-to-asOf basis is post-revaluation, not point-in-time.
  const client = createClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('10'), unitCostBase: decimal('12') }],
    movements: [],
    postAsOfRevaluations: [{ productId: 'product-1', warehouseId: 'warehouse-1', effectiveAt: new Date('2026-05-29T00:00:00.000Z') }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'current_reverse_replay')
  assert.equal(result.postAsOfRevaluationCount, 1)
  assert.equal(result.valueReplayReliable, false)
})

test('getOnHandAsOf does not flag a current-reverse valuation for a revaluation at/before asOf (scjz.43)', async () => {
  const client = createClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('10'), unitCostBase: decimal('10') }],
    movements: [],
    // Revaluation effective on/before asOf is already reflected in the basis — fine.
    postAsOfRevaluations: [{ productId: 'product-1', warehouseId: 'warehouse-1', effectiveAt: new Date('2026-05-20T00:00:00.000Z') }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'current_reverse_replay')
  assert.equal(result.postAsOfRevaluationCount, 0)
  assert.equal(result.valueReplayReliable, true)
})

test('getOnHandAsOf does NOT flag a prior-snapshot valuation for a later revaluation (scjz.43)', async () => {
  // A prior snapshot is frozen at/before asOf, so a later revaluation does not
  // change its value — must stay reliable (Codex round-4: don't over-flag snapshots).
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [],
    postAsOfRevaluations: [{ productId: 'product-1', warehouseId: 'warehouse-1', effectiveAt: new Date('2026-05-29T00:00:00.000Z') }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'snapshot_forward_replay')
  assert.equal(result.postAsOfRevaluationCount, 0)
  assert.equal(result.valueReplayReliable, true)
})

test('getOnHandAsOf replays movements forward from the nearest prior snapshot', async () => {
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [
      {
        id: 'prior-day-tail',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: decimal('99'),
        totalValueBase: decimal('99'),
        createdAt: new Date('2026-05-27T23:59:59.999Z'),
      },
      {
        id: 'next-day-midnight',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: decimal('1'),
        totalValueBase: decimal('2'),
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
      },
      {
        id: 'inbound',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: decimal('5'),
        totalValueBase: decimal('15'),
        createdAt: new Date('2026-05-28T09:00:00.000Z'),
      },
      {
        id: 'outbound',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: null,
        qty: decimal('3'),
        totalValueBase: decimal('6'),
        createdAt: new Date('2026-05-28T10:00:00.000Z'),
      },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: new Date('2026-05-28T12:00:00.000Z'),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'snapshot_forward_replay')
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '13.000000',
    valueBase: '31.000000',
    unitCostBase: '2.384615',
  }])
})

test('getOnHandAsOf reverses from the first later snapshot before the first snapshot date', async () => {
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-30T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('50'),
    }],
    movements: [
      {
        id: 'future-inbound',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: decimal('2'),
        totalValueBase: decimal('10'),
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      },
      {
        id: 'next-day-inbound',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-1',
        qty: decimal('50'),
        totalValueBase: decimal('250'),
        createdAt: new Date('2026-05-31T00:00:00.000Z'),
      },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-29',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'future_snapshot_reverse_replay')
  assert.equal(result.anchorDate, '2026-05-30')
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '8.000000',
    valueBase: '40.000000',
    unitCostBase: '5.000000',
  }])
})

test('getOnHandAsOf uses live state for asOf now and reconciles to StockLevel quantity', async () => {
  const client = createClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('7') }],
    costLayers: [
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('3') },
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('3'), unitCostBase: decimal('2') },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: new Date('2026-06-01T12:00:00.000Z'),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'current')
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '7.000000',
    valueBase: '18.000000',
    unitCostBase: '2.571429',
  }])
  // Stock qty (7) reconciles with the cost-layer qty (4+3) — no drift.
  assert.equal(result.currentValueDriftCount, 0)
  assert.equal(result.valueReplayReliable, true)
})

test('getOnHandAsOf flags live valuation as unreliable when cost layers diverge from stock qty (scjz.44)', async () => {
  const client = createClient({
    // Stock says 7 on hand, but cost layers only cover 5 (stock/cost-layer desync).
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('7') }],
    costLayers: [
      { productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('5'), unitCostBase: decimal('3') },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: new Date('2026-06-01T12:00:00.000Z'),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'current')
  assert.equal(result.currentValueDriftCount, 1)
  assert.equal(result.valueReplayReliable, false)
})

test('getOnHandAsOf flags an orphan cost layer (value with no stock row) as drift (scjz.44)', async () => {
  const client = createClient({
    stockLevels: [],
    // Cost layer with positive value but no stock_levels row — value with no qty.
    costLayers: [
      { productId: 'orphan-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('9') },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: new Date('2026-06-01T12:00:00.000Z'),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.currentValueDriftCount, 1)
  assert.equal(result.valueReplayReliable, false)
})

test('getOnHandAsOf falls back to current reverse replay when no snapshots exist', async () => {
  const client = createClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('10') }],
    costLayers: [{ productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: decimal('10'), unitCostBase: decimal('10') }],
    movements: [{
      id: 'inbound-after-as-of',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('50'),
      createdAt: new Date('2026-05-30T10:00:00.000Z'),
    }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-29',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'current_reverse_replay')
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '5.000000',
    valueBase: '50.000000',
    unitCostBase: '10.000000',
  }])
})

test('getOnHandAsOf reports value replay uncertainty for null-value movements', async () => {
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [{
      id: 'legacy-outbound',
      type: 'SALE_DISPATCH',
      productId: 'product-1',
      fromWarehouseId: 'warehouse-1',
      toWarehouseId: null,
      qty: decimal('2'),
      totalValueBase: null,
      createdAt: new Date('2026-05-28T10:00:00.000Z'),
    }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-28',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.missingValueMovementCount, 1)
  assert.equal(result.orphanWarehouseMovementCount, 0)
  assert.equal(result.valueReplayReliable, false)
  assert.deepEqual(result.missingValueMovementSample, [{
    id: 'legacy-outbound',
    createdAt: '2026-05-28T10:00:00.000Z',
    type: 'SALE_DISPATCH',
    productId: 'product-1',
  }])
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '8.000000',
    valueBase: '20.000000',
    unitCostBase: '2.500000',
  }])
})

test('getOnHandAsOf replays stock movements across cursor pages', async () => {
  const movements = Array.from({ length: 1005 }, (_, index): MovementFixture => ({
    id: `movement-${String(index).padStart(4, '0')}`,
    productId: 'product-1',
    fromWarehouseId: null,
    toWarehouseId: 'warehouse-1',
    qty: decimal('0.001'),
    totalValueBase: decimal('0.001'),
    createdAt: new Date(`2026-05-28T00:${String(index % 60).padStart(2, '0')}:00.000Z`),
  }))
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('0'),
      valueBase: decimal('0'),
    }],
    movements,
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-28',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.source, 'snapshot_forward_replay')
  assert.equal(result.missingValueMovementCount, 0)
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '1.005000',
    valueBase: '1.005000',
    unitCostBase: '1.000000',
  }])
})

test('getOnHandAsOf rejects invalid and future as-of inputs with explicit errors', async () => {
  const client = createClient()

  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: 'not-a-date', now: () => new Date('2026-06-01T12:00:00.000Z') }),
    /must use YYYY-MM-DD/,
  )
  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: '2026-05-28T12:00:00Z', now: () => new Date('2026-06-01T12:00:00.000Z') }),
    /must use YYYY-MM-DD/,
  )
  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: '2026-02-30', now: () => new Date('2026-06-01T12:00:00.000Z') }),
    /Invalid inventory as-of date/,
  )
  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: '2026-13-01', now: () => new Date('2026-06-01T12:00:00.000Z') }),
    /Invalid inventory as-of date/,
  )
  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: new Date('garbage'), now: () => new Date('2026-06-01T12:00:00.000Z') }),
    /Invalid inventory as-of date/,
  )
  await assert.rejects(
    () => getOnHandAsOf({ client, asOf: '2026-06-02', now: () => new Date('2026-06-01T12:00:00.000Z') }),
    InventoryAsOfFutureError,
  )
})

test('getOnHandAsOf applies product, warehouse, category, and excludeZero filters', async () => {
  const client = createClient({
    snapshots: [
      {
        snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        qty: decimal('10'),
        valueBase: decimal('20'),
        categoryId: 'category-a',
      },
      {
        snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
        productId: 'product-2',
        warehouseId: 'warehouse-2',
        qty: decimal('0'),
        valueBase: decimal('0'),
        categoryId: 'category-b',
      },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    categoryId: 'category-a',
    excludeZero: true,
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '10.000000',
    valueBase: '20.000000',
    unitCostBase: '2.000000',
  }])

  const emptyResult = await getOnHandAsOf({
    client,
    asOf: '2026-05-27',
    productId: 'product-2',
    excludeZero: true,
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })
  assert.deepEqual(emptyResult.rows, [])
})

test('getOnHandAsOf applies transfer movements to both warehouses and reports orphan warehouse movements separately', async () => {
  const client = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('50'),
    }],
    movements: [
      {
        id: 'transfer',
        type: 'TRANSFER_OUT',
        productId: 'product-1',
        fromWarehouseId: 'warehouse-1',
        toWarehouseId: 'warehouse-2',
        qty: decimal('3'),
        totalValueBase: decimal('15'),
        createdAt: new Date('2026-05-28T09:00:00.000Z'),
      },
      {
        id: 'orphan',
        type: 'ADJUSTMENT',
        productId: 'product-1',
        fromWarehouseId: null,
        toWarehouseId: null,
        qty: decimal('1'),
        totalValueBase: decimal('1'),
        createdAt: new Date('2026-05-28T10:00:00.000Z'),
      },
    ],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-28',
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  })

  assert.equal(result.missingValueMovementCount, 0)
  assert.equal(result.orphanWarehouseMovementCount, 1)
  assert.equal(result.valueReplayReliable, false)
  assert.deepEqual(result.rows, [
    {
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: '7.000000',
      valueBase: '35.000000',
      unitCostBase: '5.000000',
    },
    {
      productId: 'product-1',
      warehouseId: 'warehouse-2',
      qty: '3.000000',
      valueBase: '15.000000',
      unitCostBase: '5.000000',
    },
  ])
})

function captureMovementRanges(base: OnHandAsOfClient): {
  client: OnHandAsOfClient
  ranges: Array<{ gt?: Date; gte?: Date; lt?: Date; lte?: Date }>
} {
  const ranges: Array<{ gt?: Date; gte?: Date; lt?: Date; lte?: Date }> = []
  const baseFindMany = (base as { stockMovement: { findMany: (args: unknown) => Promise<unknown> } }).stockMovement.findMany
  const client = {
    ...base,
    stockMovement: {
      findMany: async (args: unknown) => {
        const createdAt = (args as { where?: { createdAt?: { gt?: Date; gte?: Date; lt?: Date; lte?: Date } } }).where?.createdAt
        if (createdAt) ranges.push(createdAt)
        return baseFindMany(args)
      },
    },
  } as unknown as OnHandAsOfClient
  return { client, ranges }
}

test('getOnHandAsOf forward replay bounds a date-only as-of with a half-open next-day boundary', async () => {
  const base = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [{
      id: 'm1',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('15'),
      createdAt: new Date('2026-05-28T09:00:00.000Z'),
    }],
  })
  const { client, ranges } = captureMovementRanges(base)

  await getOnHandAsOf({ client, asOf: '2026-05-28', now: () => new Date('2026-06-01T12:00:00.000Z') })

  // The upper bound must be the half-open next-day midnight, not an inclusive
  // lte on the .999Z end-of-day proxy (which drops .999xxx microsecond rows).
  assert.ok(ranges.length > 0)
  for (const range of ranges) {
    assert.equal(range.lte, undefined)
    assert.deepEqual(range.lt, new Date('2026-05-29T00:00:00.000Z'))
  }
})

test('getOnHandAsOf forward replay keeps an inclusive bound for a precise instant as-of', async () => {
  const base = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-27T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [{
      id: 'm1',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('15'),
      createdAt: new Date('2026-05-28T09:00:00.000Z'),
    }],
  })
  const { client, ranges } = captureMovementRanges(base)

  const asOf = new Date('2026-05-28T12:00:00.000Z')
  await getOnHandAsOf({ client, asOf, now: () => new Date('2026-06-01T12:00:00.000Z') })

  assert.ok(ranges.length > 0)
  for (const range of ranges) {
    assert.equal(range.lt, undefined)
    assert.deepEqual(range.lte, asOf)
  }
})

test('getOnHandAsOf reverse replay reverses out only movements from the next day for a date-only as-of', async () => {
  const base = createClient({
    snapshots: [{
      snapshotDate: new Date('2026-05-30T00:00:00.000Z'),
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: decimal('10'),
      valueBase: decimal('20'),
    }],
    movements: [{
      id: 'm1',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('15'),
      createdAt: new Date('2026-05-29T09:00:00.000Z'),
    }],
  })
  const { client, ranges } = captureMovementRanges(base)

  const result = await getOnHandAsOf({ client, asOf: '2026-05-28', now: () => new Date('2026-06-01T12:00:00.000Z') })

  assert.equal(result.source, 'future_snapshot_reverse_replay')
  // Lower bound is the next-day midnight (half-open gte), not a gt on .999Z, so
  // a same-day .999xxx movement is not wrongly reversed out of on-hand.
  assert.ok(ranges.length > 0)
  for (const range of ranges) {
    assert.equal(range.gt, undefined)
    assert.deepEqual(range.gte, new Date('2026-05-29T00:00:00.000Z'))
  }
})

test('getOnHandAsOf current reverse replay reverses a midnight movement when now is exactly next-day midnight', async () => {
  // No snapshots -> current reverse replay. Date-only as-of 2026-05-28 with now
  // at exactly 2026-05-29T00:00:00.000Z yields { gte: 2026-05-29T00:00, lte: now }
  // — a single inclusive instant that must still reverse out the 29th's movement.
  const client = createClient({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('15') }],
    costLayers: [{
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      remainingQty: decimal('15'),
      unitCostBase: decimal('2'),
    }],
    movements: [{
      id: 'midnight',
      productId: 'product-1',
      fromWarehouseId: null,
      toWarehouseId: 'warehouse-1',
      qty: decimal('5'),
      totalValueBase: decimal('10'),
      createdAt: new Date('2026-05-29T00:00:00.000Z'),
    }],
  })

  const result = await getOnHandAsOf({
    client,
    asOf: '2026-05-28',
    now: () => new Date('2026-05-29T00:00:00.000Z'),
  })

  assert.equal(result.source, 'current_reverse_replay')
  // Current stock is 15; the +5 movement on the 29th must be reversed out for
  // the as-of-28 state, leaving 10.
  assert.deepEqual(result.rows, [{
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: '10.000000',
    valueBase: '20.000000',
    unitCostBase: '2.000000',
  }])
})
