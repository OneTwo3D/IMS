import { Prisma, StockMovementType } from '../../../app/generated/prisma/client.ts'
import type { OnHandAsOfClient } from '../../../lib/domain/inventory/get-on-hand-as-of.ts'
import { backfillInventorySnapshots } from '../../../lib/domain/inventory/inventory-snapshot.ts'

/** In-memory store, writer client and as-of reader client shared by the London business-day tests (the REAL backfill writer and reader run against them). */

export const D = (v: string | number) => new Prisma.Decimal(v)

export type Move = { id: string; type: StockMovementType; productId: string; fromWarehouseId: string | null; toWarehouseId: string | null; qty: Prisma.Decimal; totalValueBase: Prisma.Decimal | null; createdAt: Date }

export function inbound(id: string, qty: number, at: string): Move {
  return { id, type: StockMovementType.PURCHASE_RECEIPT, productId: 'p1', fromWarehouseId: null, toWarehouseId: 'w1', qty: D(qty), totalValueBase: D(qty), createdAt: new Date(at) }
}
export function outbound(id: string, qty: number, at: string): Move {
  return { id, type: StockMovementType.SALE_DISPATCH, productId: 'p1', fromWarehouseId: 'w1', toWarehouseId: null, qty: D(qty), totalValueBase: D(qty), createdAt: new Date(at) }
}

export type Store = {
  snapshots: Array<{ snapshotDate: Date; productId: string; warehouseId: string; qty: Prisma.Decimal; valueBase: Prisma.Decimal }>
  runs: Map<string, Date>
  /** The backfill writer's own result (reliability flags and counts). */
  result?: Awaited<ReturnType<typeof backfillInventorySnapshots>>
}

export function inRange(at: Date, r: { gt?: Date; gte?: Date; lt?: Date; lte?: Date }): boolean {
  return (!r.gt || at > r.gt) && (!r.gte || at >= r.gte) && (!r.lt || at < r.lt) && (!r.lte || at <= r.lte)
}

export function movementFindMany(moves: Move[], desc: boolean) {
  return async (args: unknown) => {
    const q = args as { where?: { createdAt?: { gt?: Date; gte?: Date; lt?: Date; lte?: Date } }; cursor?: { id: string }; skip?: number; take?: number; orderBy?: unknown }
    const rows = moves.filter((m) => inRange(m.createdAt, q.where?.createdAt ?? {}))
      .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)) * (desc ? -1 : 1))
    const orderDesc = JSON.stringify(q.orderBy ?? '').includes('desc')
    const ordered = orderDesc === desc ? rows : [...rows].reverse()
    const start = q.cursor ? ordered.findIndex((m) => m.id === q.cursor!.id) + (q.skip ?? 0) : 0
    return ordered.slice(Math.max(0, start), q.take == null ? undefined : Math.max(0, start) + q.take)
  }
}

export async function backfill(moves: Move[], current: number, fromDate: string, toDate: string): Promise<Store> {
  const store: Store = { snapshots: [], runs: new Map() }
  const client = {
    stockLevel: { findMany: async () => [{ productId: 'p1', warehouseId: 'w1', quantity: D(current), reservedQty: D(0) }], findUnique: async () => null },
    costLayer: { findMany: async () => [{ productId: 'p1', warehouseId: 'w1', remainingQty: D(current), unitCostBase: D(1) }] },
    costLayerRevaluation: { count: async () => 0, findMany: async () => [] },
    stockMovement: { findMany: movementFindMany(moves, true) },
    inventorySnapshot: {
      findMany: async () => [],
      upsert: async (args: unknown) => {
        const c = (args as { create: Store['snapshots'][number] }).create
        store.snapshots = store.snapshots.filter((s) => s.snapshotDate.getTime() !== c.snapshotDate.getTime())
        store.snapshots.push({ snapshotDate: c.snapshotDate, productId: c.productId, warehouseId: c.warehouseId, qty: new Prisma.Decimal(c.qty as never), valueBase: new Prisma.Decimal(c.valueBase as never) })
        return {}
      },
    },
    inventorySnapshotRun: {
      upsert: async (args: unknown) => {
        const c = (args as { create: { snapshotDate: Date; cutoffAt: Date } }).create
        store.runs.set(c.snapshotDate.toISOString().slice(0, 10), c.cutoffAt)
        return {}
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  }
  store.result = await backfillInventorySnapshots({ client: client as never, fromDate, toDate })
  return store
}

export function readerClient(store: Store, moves: Move[], current: number): OnHandAsOfClient {
  return {
    inventorySnapshotRun: {
      findUnique: async (args: unknown) => {
        const cutoffAt = store.runs.get((args as { where: { snapshotDate: Date } }).where.snapshotDate.toISOString().slice(0, 10))
        return cutoffAt ? { cutoffAt } : null
      },
    },
    inventorySnapshot: {
      findFirst: async (args: unknown) => {
        const q = args as { where: { snapshotDate: { lte?: Date; lt?: Date; gt?: Date; gte?: Date } }; orderBy: { snapshotDate: 'asc' | 'desc' } }
        const f = q.where.snapshotDate
        const rows = store.snapshots.filter((s) => inRange(s.snapshotDate, f))
          .sort((a, b) => (a.snapshotDate.getTime() - b.snapshotDate.getTime()) * (q.orderBy.snapshotDate === 'asc' ? 1 : -1))
        return rows[0] ? { snapshotDate: rows[0].snapshotDate } : null
      },
      findMany: async (args: unknown) => {
        const d = (args as { where: { snapshotDate: Date } }).where.snapshotDate
        return store.snapshots.filter((s) => s.snapshotDate.getTime() === d.getTime())
      },
      count: async () => 0,
    },
    stockMovement: { findMany: movementFindMany(moves, false) },
    stockLevel: { findMany: async () => [{ productId: 'p1', warehouseId: 'w1', quantity: D(current) }] },
    costLayer: { findMany: async () => [{ productId: 'p1', warehouseId: 'w1', remainingQty: D(current), unitCostBase: D(1) }] },
    costLayerRevaluation: { count: async () => 0 },
  } as unknown as OnHandAsOfClient
}

export const NOW = () => new Date('2027-12-01T12:00:00.000Z')
