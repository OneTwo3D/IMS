import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { SNAPSHOT_RUNNING_MARK } from '../../lib/domain/sales/despatch-instant'
import { transitionShipmentStatus } from '../../lib/domain/sales/shipment-service'

/**
 * THE #1095 ROUND-2 FOLLOW-UPS, AGAINST A REAL DATABASE. Gated on RUN_DB_RETENTION_TESTS (npm run test:db). No network.
 *
 *   item 1  a lock holder that fails AFTER it took the lock (here: the 4 h cap, shrunk) stops the snapshot, writes an ERROR row and fails the run; a run past half
 *           of the cap writes a WARNING row.
 *   item 2  the floor lock is taken whatever the switches say (a switch flipped mid-run can never leave a run unfenced).
 *   item 3  stored despatched units are re-applied only while the warehouse stamp stored with them is unchanged (real refused_actions rows and sweep deps).
 *   item 4  a despatch refused because the snapshot holds the lock returns at once (it never waits holding the order lock), and applies once the snapshot is done.
 *   item 7  the stale-lock-date readiness flag is derived from the reading the despatch uses (an unparseable value read just now is flagged).
 *   item 6  the latest snapshot run's age is judged for readiness.
 *   item 8c the snapshot backfill takes the lock.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/despatch-snapshot-followups.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY } = await import('../../lib/db/advisory-locks')
  return { db, KEY: INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY }
}
type Ctx = Awaited<ReturnType<typeof load>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// A real past day far enough back not to collide with the other DB tests' days (the despatch-switch tests use 400 days ago).
const SNAPSHOT_DAY = new Date(Date.now() - 410 * 86_400_000).toISOString().slice(0, 10)

async function cleanSnapshot(ctx: Ctx) {
  const date = new Date(`${SNAPSHOT_DAY}T00:00:00Z`)
  await ctx.db.inventorySnapshot.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventoryReservationSnapshot.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventorySnapshotRun.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventoryReservationSnapshotRun.deleteMany({ where: { snapshotDate: date } })
}

/** Is some backend HOLDING the snapshot floor lock exclusively right now? */
async function exclusiveHolders(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock' AND objid = ${ctx.KEY}`
  return Number(rows[0].n)
}

async function withSettings<T>(ctx: Ctx, values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(values)
  const previous = await ctx.db.setting.findMany({ where: { key: { in: keys } } })
  for (const [key, value] of Object.entries(values)) await ctx.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try {
    return await fn()
  } finally {
    await ctx.db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of previous) await ctx.db.setting.create({ data: { key: row.key, value: row.value } })
  }
}

// ---- item 1 ------------------------------------------------------------------------------------------------------------------------------------

test('[db] item 1: a lock holder that fails AFTER taking the lock stops the snapshot, writes an ERROR row and fails the run (no run row, no green)', { skip }, async () => {
  const ctx = await load()
  const { writeDailyInventorySnapshot, InventorySnapshotLockLostError } = await import('../../lib/domain/inventory/inventory-snapshot')
  await cleanSnapshot(ctx)
  const since = new Date()
  let reachedRunRow = false
  try {
    await assert.rejects(
      writeDailyInventorySnapshot({
        snapshotDate: SNAPSHOT_DAY,
        lockHoldMaxMs: 700, // the 4 h cap, shrunk: the holder's transaction times out and releases the lock while the run is still going
        lockHeartbeatMs: 100,
        onStage: async (stage) => {
          if (stage === 'before-snapshot-rows') await sleep(1800)
          if (stage === 'before-run-row') reachedRunRow = true
        },
      }),
      (error: unknown) => error instanceof InventorySnapshotLockLostError,
    )
    assert.equal(reachedRunRow, false, 'the snapshot stopped writing as soon as the lock was lost')
    assert.equal(await ctx.db.inventorySnapshotRun.count({ where: { snapshotDate: new Date(`${SNAPSHOT_DAY}T00:00:00Z`) } }), 0, 'no coverage marker for a day that was not fenced')
    const errors = await ctx.db.activityLog.findMany({ where: { action: 'inventory_snapshot_unfenced', level: 'ERROR', createdAt: { gte: since } } })
    assert.equal(errors.length, 1)
    assert.equal(await ctx.db.activityLog.count({ where: { action: 'inventory_snapshot_duration', createdAt: { gte: since } } }), 0, 'the duration row never claims a lock that was lost')
    assert.equal(await exclusiveHolders(ctx), 0)
  } finally {
    await cleanSnapshot(ctx)
    await ctx.db.activityLog.deleteMany({ where: { action: { in: ['inventory_snapshot_unfenced', 'inventory_snapshot_slow'] }, createdAt: { gte: since } } })
  }
})

test('[db] item 1: a run that passes half of the cap writes a WARNING while it is still going, and a run inside the cap is clean', { skip }, async () => {
  const ctx = await load()
  const { writeDailyInventorySnapshot } = await import('../../lib/domain/inventory/inventory-snapshot')
  await cleanSnapshot(ctx)
  const since = new Date()
  try {
    const result = await writeDailyInventorySnapshot({
      snapshotDate: SNAPSHOT_DAY,
      lockHoldMaxMs: 20_000,
      onStage: async (stage) => { if (stage === 'before-snapshot-rows') await sleep(10_800) },
    })
    assert.equal(result.snapshotDate, SNAPSHOT_DAY)
    const warnings = await ctx.db.activityLog.findMany({ where: { action: 'inventory_snapshot_slow', level: 'WARNING', createdAt: { gte: since } } })
    assert.equal(warnings.length, 1)
    assert.equal(await ctx.db.activityLog.count({ where: { action: 'inventory_snapshot_unfenced', createdAt: { gte: since } } }), 0)
    assert.equal(await ctx.db.activityLog.count({ where: { action: 'inventory_snapshot_duration', createdAt: { gte: since } } }), 1)
  } finally {
    await cleanSnapshot(ctx)
    await ctx.db.activityLog.deleteMany({ where: { action: { in: ['inventory_snapshot_duration', 'inventory_snapshot_slow'] }, createdAt: { gte: since } } })
  }
})

// ---- item 2 ------------------------------------------------------------------------------------------------------------------------------------

test('[db] item 2: the floor lock is held for the whole run with the despatch switch OFF and the cron OFF (a switch turned on mid-run is never unfenced)', { skip }, async () => {
  const ctx = await load()
  const { writeDailyInventorySnapshot } = await import('../../lib/domain/inventory/inventory-snapshot')
  await cleanSnapshot(ctx)
  const since = new Date()
  const heldAt: Record<string, number> = {}
  try {
    await withSettings(ctx, { wms_despatch_date_enabled: 'false', cron_inventory_snapshot_enabled: 'false' }, async () => {
      await writeDailyInventorySnapshot({
        snapshotDate: SNAPSHOT_DAY,
        onStage: async (stage) => { heldAt[stage] = await exclusiveHolders(ctx) },
      })
    })
    assert.equal(heldAt['before-state-read'], 1)
    assert.equal(heldAt['before-run-row'], 1)
    assert.equal(await exclusiveHolders(ctx), 0, 'released afterwards')
  } finally {
    await cleanSnapshot(ctx)
    await ctx.db.activityLog.deleteMany({ where: { action: 'inventory_snapshot_duration', createdAt: { gte: since } } })
  }
})

// ---- item 8c -----------------------------------------------------------------------------------------------------------------------------------

test('[db] item 8c: a writing snapshot backfill takes the floor lock; a dry run does not', { skip }, async () => {
  const ctx = await load()
  const { backfillInventorySnapshots } = await import('../../lib/domain/inventory/inventory-snapshot')
  await cleanSnapshot(ctx)
  const since = new Date()
  const real: number[] = []
  const dry: number[] = []
  try {
    await backfillInventorySnapshots({ fromDate: SNAPSHOT_DAY, toDate: SNAPSHOT_DAY, onStage: async () => { real.push(await exclusiveHolders(ctx)) } })
    assert.ok(real.length > 0 && real.every((n) => n === 1), JSON.stringify(real))
    await backfillInventorySnapshots({ fromDate: SNAPSHOT_DAY, toDate: SNAPSHOT_DAY, dryRun: true, onStage: async () => { dry.push(await exclusiveHolders(ctx)) } })
    assert.deepEqual(dry, [], 'a dry run takes no lock (and so has no fence points)')
  } finally {
    await cleanSnapshot(ctx)
    await ctx.db.activityLog.deleteMany({ where: { action: 'inventory_snapshot_duration', createdAt: { gte: since } } })
  }
})

// ---- item 4 ------------------------------------------------------------------------------------------------------------------------------------

class RollbackProbe extends Error {}
async function withRollback<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let captured: T | undefined
  try {
    await ctx.db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}
const D = (value: string | number) => new Prisma.Decimal(String(value))

async function seedShipment(tx: Tx) {
  const suffix = randomUUID().slice(0, 8)
  const product = await tx.product.create({ data: { sku: `SF-${suffix}`, name: `sf ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  const wh = await tx.warehouse.create({ data: { code: `SF${suffix}`, name: `sf ${suffix}` }, select: { id: true } })
  await tx.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, quantity: D(10), reservedQty: D(2) } })
  await tx.costLayer.create({ data: { productId: product.id, warehouseId: wh.id, receivedQty: D(10), remainingQty: D(10), unitCostBase: D(3), receivedAt: new Date(Date.now() - 40 * 86_400_000) } })
  const order = await tx.salesOrder.create({
    data: {
      orderNumber: `SF-${suffix}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D(1), createdAt: new Date(Date.now() - 20 * 86_400_000),
      subtotalForeign: D(20), totalForeign: D(20), subtotalBase: D(20), taxBase: D(0), totalBase: D(20), shipFromWarehouseId: wh.id,
      lines: { create: [{ productId: product.id, sku: product.sku, description: 'l', qty: D(2), unitPriceForeign: D(10), unitPriceBase: D(10), taxForeign: D(0), taxBase: D(0), totalForeign: D(20), totalBase: D(20) }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await tx.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: wh.id, qty: D(2), createdAt: new Date(Date.now() - 10 * 86_400_000) } })
  const shipment = await tx.shipment.create({ data: { orderId: order.id, warehouseId: wh.id, status: 'PACKED', lines: { create: [{ lineId, productId: product.id, qty: D(2) }] } }, select: { id: true } })
  return { shipmentId: shipment.id }
}

test('[db] item 4: a warehouse-dated despatch behind a running snapshot is refused AT ONCE (it never waits holding the order lock) and applies once the snapshot is done', { skip }, async () => {
  const ctx = await load()
  let release!: () => void
  const mayRelease = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const lockHeld = new Promise<void>((resolve) => { held = resolve })
  // The snapshot's holder: the exclusive lock on its own connection.
  const holder = ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ctx.KEY})`
    held()
    await mayRelease
  }, { timeout: 60_000 })
  try {
    await lockHeld
    const attempt = async (tx: Tx, fx: { shipmentId: string }) => transitionShipmentStatus(tx, {
      shipmentId: fx.shipmentId, targetStatus: 'SHIPPED', completion: { completionAuthority: 'EXTERNAL', storefrontCompletion: false }, allowRecordWhenNotReady: true,
      despatchedAt: new Date(Date.now() - 86_400_000),
    })
    const refused = await withRollback(ctx, async (tx) => {
      const fx = await seedShipment(tx)
      const startedAt = Date.now()
      // Before the fix this BLOCKED until the snapshot committed (the race below is what shows it).
      const result = await Promise.race([attempt(tx, fx), sleep(8_000).then(() => 'blocked' as const)])
      const status = (await tx.shipment.findUniqueOrThrow({ where: { id: fx.shipmentId }, select: { status: true } })).status as string
      return { result, tookMs: Date.now() - startedAt, status }
    })
    assert.notEqual(refused.result, 'blocked', 'the despatch waited for the snapshot lock')
    assert.equal((refused.result as { success: boolean }).success, false)
    assert.ok(((refused.result as { error: string }).error).startsWith(SNAPSHOT_RUNNING_MARK))
    assert.ok(refused.tookMs < 5_000, `refused in ${refused.tookMs} ms`)
    assert.equal(refused.status, 'PACKED', 'nothing moved')
    // The snapshot is done: the same despatch applies.
    release()
    await holder
    const applied = await withRollback(ctx, async (tx) => attempt(tx, await seedShipment(tx)))
    assert.equal((applied as { success: boolean }).success, true, JSON.stringify(applied))
  } finally {
    release()
    await holder.catch(() => undefined)
  }
})

// ---- item 3 ------------------------------------------------------------------------------------------------------------------------------------

test('[db] item 3: a held despatch is re-applied from its stored units only while the warehouse stamp stored with them is unchanged (real standing row)', { skip }, async () => {
  const ctx = await load()
  const { recordRefusedAction } = await import('../../lib/domain/refused-actions')
  const { createPrismaDispatchDeps, reconcileOneOrder } = await import('../../lib/domain/wms/dispatch-sweep')
  const orderId = `kbn7o-${randomUUID()}`
  const key = 'wms_despatch_quantity_check_enabled'
  try {
    await withSettings(ctx, { [key]: 'true' }, async () => {
      await recordRefusedAction(ctx.db, {
        entityType: 'SALES_ORDER', entityId: orderId, action: 'WMS_DESPATCH_QUANTITY', gate: 'WMS_QUANTITY_MISMATCH', permanence: 'RETRYABLE', severity: 'HIGH',
        intent: { mismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }], despatched: [{ sku: 'SKU-C', qty: 4 }], stamp: { lastUpdated: '2026-11-19T10:30:00', parts: null } }, detail: 'held',
      })
      const applied: unknown[] = []
      const real = createPrismaDispatchDeps('mintsoft', {} as never)
      const deps = { ...real, applyDispatch: async (_o: string, _t: unknown, options: { despatchedQuantities?: unknown }) => { applied.push(options?.despatchedQuantities); return { success: true } } }
      const candidate = { linkId: `link-${orderId}`, orderId, externalOrderNumber: 'SO-5001' }
      const read = (lastUpdated: string | null) => ({
        externalOrderId: 'M-1', externalOrderNumber: 'SO-5001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
        mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }], dispatched: true, raw: null, lastUpdated,
      })
      // The warehouse changed the order since the units were stored (LastUpdated moved) and this read carries no items: held, never applied on the stale units.
      assert.equal((await reconcileOneOrder(deps as never, candidate as never, read('2026-11-19T15:00:00') as never)).action, 'pending')
      assert.deepEqual(applied, [])
      // No stamp on the read: cannot be proven unchanged, held.
      assert.equal((await reconcileOneOrder(deps as never, candidate as never, read(null) as never)).action, 'pending')
      // Unchanged: applied from the stored units.
      assert.equal((await reconcileOneOrder(deps as never, candidate as never, read('2026-11-19T10:30:00') as never)).action, 'dispatched')
      assert.deepEqual(applied, [[{ sku: 'SKU-C', qty: 4 }]])
    })
  } finally {
    await ctx.db.refusedAction.deleteMany({ where: { entityId: orderId } })
  }
})

// ---- items 6 and 7 -----------------------------------------------------------------------------------------------------------------------------

test('[db] item 7: a lock date read just now that does not parse flags the readiness warning (derived from readStoredLockDate)', { skip }, async () => {
  const ctx = await load()
  const { getWmsDespatchDateStatus } = await import('../../lib/domain/wms/despatch-flags')
  const fresh = new Date(Date.now() - 3_600_000).toISOString()
  await withSettings(ctx, { wms_despatch_date_enabled: 'true', cron_inventory_snapshot_enabled: 'true', xero_books_lock_date: 'not-a-day', xero_books_lock_date_read_at: fresh }, async () => {
    assert.equal((await getWmsDespatchDateStatus()).lockDateStale, true)
  })
  await withSettings(ctx, { wms_despatch_date_enabled: 'true', cron_inventory_snapshot_enabled: 'true', xero_books_lock_date: '2026-11-15', xero_books_lock_date_read_at: fresh }, async () => {
    assert.equal((await getWmsDespatchDateStatus()).lockDateStale, false)
  })
})

test('[db] item 6: readiness judges the age of the latest snapshot run row while the switch is effective', { skip }, async () => {
  const ctx = await load()
  const { getWmsDespatchDateReadiness } = await import('../../lib/domain/wms/despatch-flags')
  const { classifyDespatchDatePrerequisite } = await import('../../lib/ops/rollout-readiness')
  // A run row dated tomorrow is the LATEST whatever the other tests left; its updatedAt is set by hand.
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const date = new Date(`${day}T00:00:00Z`)
  await ctx.db.inventorySnapshotRun.deleteMany({ where: { snapshotDate: date } })
  try {
    await ctx.db.inventorySnapshotRun.create({ data: { snapshotDate: date, stockLevelCount: 0, snapshotCount: 0 } })
    await withSettings(ctx, { wms_despatch_date_enabled: 'true', cron_inventory_snapshot_enabled: 'true' }, async () => {
      await ctx.db.$executeRaw`UPDATE inventory_snapshot_runs SET "updatedAt" = now() - interval '30 hours' WHERE "snapshotDate" = ${date}`
      const stale = await getWmsDespatchDateReadiness()
      assert.equal(stale.snapshotRunStale, true)
      assert.deepEqual(classifyDespatchDatePrerequisite(stale).map((f) => f.id), ['wms-despatch-date:snapshot-stale'])
      await ctx.db.$executeRaw`UPDATE inventory_snapshot_runs SET "updatedAt" = now() - interval '2 hours' WHERE "snapshotDate" = ${date}`
      const fresh = await getWmsDespatchDateReadiness()
      assert.equal(fresh.snapshotRunStale, false)
      assert.deepEqual(classifyDespatchDatePrerequisite(fresh), [])
    })
    // Not effective (cron off): not judged here (the cron-disabled warning says so).
    await withSettings(ctx, { wms_despatch_date_enabled: 'true', cron_inventory_snapshot_enabled: 'false' }, async () => {
      assert.equal((await getWmsDespatchDateReadiness()).snapshotRunStale, undefined)
    })
  } finally {
    await ctx.db.inventorySnapshotRun.deleteMany({ where: { snapshotDate: date } })
  }
})
