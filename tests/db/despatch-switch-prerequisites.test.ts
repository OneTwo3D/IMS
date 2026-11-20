import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE PREREQUISITES OF THE TWO WAREHOUSE DESPATCH SWITCHES, AGAINST A REAL DATABASE (committing, each test cleans up what it wrote). Gated on
 * RUN_DB_RETENTION_TESTS (npm run test:db). No network.
 *
 *   MED1  a backdated despatch and the daily inventory snapshot exclude each other (advisory lock): a despatch can never commit between the snapshot's
 *         state read and its run row.
 *   MED3  a despatch held on a quantity mismatch stays held when a later read carries no items; the standing row is closed only by a despatch.
 *   MED5  `wms_despatch_date_enabled` has no effect while the inventory snapshot cron is off.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/despatch-switch-prerequisites.test.ts would have been skipped. Fix the invocation (npm run test:db).')
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until some backend is WAITING for the snapshot floor lock (the proof that two parties really contend for it). */
async function waitForLockWaiter(ctx: Ctx, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await ctx.db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${ctx.KEY}`
    if (Number(rows[0].n) > 0) return
    if (Date.now() > deadline) throw new Error('nobody waited for the inventory snapshot floor lock: the two parties do not exclude each other')
    await sleep(50)
  }
}

const SNAPSHOT_DAY = '2001-03-04'

async function cleanSnapshot(ctx: Ctx) {
  const date = new Date(`${SNAPSHOT_DAY}T00:00:00Z`)
  await ctx.db.inventorySnapshot.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventoryReservationSnapshot.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventorySnapshotRun.deleteMany({ where: { snapshotDate: date } })
  await ctx.db.inventoryReservationSnapshotRun.deleteMany({ where: { snapshotDate: date } })
}

test('[db] MED1: the daily snapshot waits for a backdated despatch in flight, so the despatch is in the snapshot or after its run row (never between)', { skip }, async () => {
  const ctx = await load()
  const { loadDespatchInstantFloors } = await import('../../lib/domain/sales/despatch-instant')
  const { writeDailyInventorySnapshot } = await import('../../lib/domain/inventory/inventory-snapshot')
  await cleanSnapshot(ctx)
  let releaseDespatch!: () => void
  const despatchMayCommit = new Promise<void>((resolve) => { releaseDespatch = resolve })
  let despatchHoldsLock!: () => void
  const lockHeld = new Promise<void>((resolve) => { despatchHoldsLock = resolve })
  // The despatch transaction: reads its floors (taking the shared lock), then "writes its movement" for as long as it likes before committing.
  const despatch = ctx.db.$transaction(async (tx) => {
    await loadDespatchInstantFloors(tx, { orderId: `no-order-${randomUUID()}`, lineIds: [] })
    despatchHoldsLock()
    await despatchMayCommit
  }, { timeout: 60_000 })
  try {
    await lockHeld
    let snapshotSettled = false
    const snapshot = writeDailyInventorySnapshot({ snapshotDate: SNAPSHOT_DAY }).finally(() => { snapshotSettled = true })
    await waitForLockWaiter(ctx)
    assert.equal(snapshotSettled, false, 'the snapshot must not read its state while a despatch is uncommitted')
    assert.equal(await ctx.db.inventorySnapshotRun.count({ where: { snapshotDate: new Date(`${SNAPSHOT_DAY}T00:00:00Z`) } }), 0, 'no run row yet')
    releaseDespatch()
    await despatch
    await snapshot
    assert.equal(await ctx.db.inventorySnapshotRun.count({ where: { snapshotDate: new Date(`${SNAPSHOT_DAY}T00:00:00Z`) } }), 1, 'the run row is written once the despatch has committed')
  } finally {
    releaseDespatch()
    await despatch.catch(() => undefined)
    await cleanSnapshot(ctx)
  }
})

test('[db] MED1: a backdated despatch that arrives while the snapshot is writing reads the floor the snapshot COMMITS, not the one before it', { skip }, async () => {
  const ctx = await load()
  const { loadDespatchInstantFloors } = await import('../../lib/domain/sales/despatch-instant')
  const { INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY } = await import('../../lib/db/advisory-locks')
  await cleanSnapshot(ctx)
  const date = new Date(`${SNAPSHOT_DAY}T00:00:00Z`)
  const cutoffAt = new Date('2001-03-05T00:00:00Z')
  let snapshotLockHeld!: () => void
  const held = new Promise<void>((resolve) => { snapshotLockHeld = resolve })
  let commitSnapshot!: () => void
  const mayCommit = new Promise<void>((resolve) => { commitSnapshot = resolve })
  // The snapshot's transaction, as writeDailyInventorySnapshot runs it: exclusive lock first, run row written, committed last.
  const snapshot = ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY})`
    await tx.inventorySnapshotRun.create({ data: { snapshotDate: date, stockLevelCount: 0, snapshotCount: 0, cutoffAt } })
    snapshotLockHeld()
    await mayCommit
  }, { timeout: 60_000 })
  try {
    await held
    const floors = ctx.db.$transaction((tx) => loadDespatchInstantFloors(tx, { orderId: `no-order-${randomUUID()}`, lineIds: [] }), { timeout: 60_000 })
    await waitForLockWaiter(ctx)
    commitSnapshot()
    await snapshot
    const read = await floors
    // The floor is the NEWEST run: other runs in a shared database can only be older than this far-past date only if there are none newer, so compare the instant it names.
    const latest = await ctx.db.inventorySnapshotRun.findFirstOrThrow({ orderBy: { snapshotDate: 'desc' } })
    assert.equal(read.afterSnapshot?.getTime(), (latest.cutoffAt ?? cutoffAt).getTime())
    assert.ok(read.afterSnapshot !== null)
  } finally {
    commitSnapshot()
    await snapshot.catch(() => undefined)
    await cleanSnapshot(ctx)
  }
})

test('[db] MED3: a despatch held on a quantity mismatch stays held on a read with no items, and its standing row is closed only by a despatch', { skip }, async () => {
  const ctx = await load()
  const { recordRefusedAction } = await import('../../lib/domain/refused-actions')
  const { createPrismaDispatchDeps, reconcileOneOrder } = await import('../../lib/domain/wms/dispatch-sweep')
  const orderId = `yw405-${randomUUID()}`
  const keys = ['wms_despatch_quantity_check_enabled']
  const previous = await ctx.db.setting.findMany({ where: { key: { in: keys } } })
  await ctx.db.setting.upsert({ where: { key: keys[0] }, create: { key: keys[0], value: 'true' }, update: { value: 'true' } })
  try {
    await recordRefusedAction(ctx.db, {
      entityType: 'SALES_ORDER', entityId: orderId, action: 'WMS_DESPATCH_QUANTITY', gate: 'WMS_QUANTITY_MISMATCH', permanence: 'RETRYABLE', severity: 'HIGH',
      intent: { mismatches: [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }] }, detail: 'held',
    })
    const applied: unknown[] = []
    const real = createPrismaDispatchDeps('mintsoft', {} as never)
    const deps = { ...real, applyDispatch: async (...args: unknown[]) => { applied.push(args); return { success: true } } }
    const candidate = { linkId: `link-${orderId}`, orderId, externalOrderNumber: 'SO-5001' }
    const noItems = {
      externalOrderId: 'M-1', externalOrderNumber: 'SO-5001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
      mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN', carrier: 'DPD', despatchedAt: '2026-11-19T10:00:00' }], dispatched: true, raw: null,
    }
    const outcome = await reconcileOneOrder(deps as never, candidate as never, noItems as never)
    assert.equal(outcome.action, 'pending', JSON.stringify(outcome))
    assert.equal(applied.length, 0, 'a held despatch is never applied on IMS\'s own quantities')
    // A neutral outcome does not close the row (which would reopen as a new episode and restart the two-hour alert).
    await real.resolveRefusedActions?.(orderId, { dispatched: false })
    assert.equal(await ctx.db.refusedAction.count({ where: { entityId: orderId, action: 'WMS_DESPATCH_QUANTITY', resolvedAt: null } }), 1)
    // With the check off, nothing is held on this basis.
    await ctx.db.setting.update({ where: { key: keys[0] }, data: { value: 'false' } })
    assert.equal(await real.hasOpenQuantityHold?.(orderId), false)
    await ctx.db.setting.update({ where: { key: keys[0] }, data: { value: 'true' } })
    assert.equal(await real.hasOpenQuantityHold?.(orderId), true)
    // A despatch closes it.
    await real.resolveRefusedActions?.(orderId, { dispatched: true })
    assert.equal(await ctx.db.refusedAction.count({ where: { entityId: orderId, action: 'WMS_DESPATCH_QUANTITY', resolvedAt: null } }), 0)
    assert.equal(await real.hasOpenQuantityHold?.(orderId), false)
  } finally {
    await ctx.db.refusedAction.deleteMany({ where: { entityId: orderId } })
    if (previous.length === 0) await ctx.db.setting.deleteMany({ where: { key: { in: keys } } })
    else for (const row of previous) await ctx.db.setting.update({ where: { key: row.key }, data: { value: row.value } })
  }
})

test('[db] MED5: wms_despatch_date_enabled has no effect while the inventory snapshot cron is disabled, and the readiness report says so', { skip }, async () => {
  const ctx = await load()
  const { getWmsDespatchDateStatus, isWmsDespatchDateEnabled } = await import('../../lib/domain/wms/despatch-flags')
  const { classifyDespatchDatePrerequisite } = await import('../../lib/ops/rollout-readiness')
  const keys = ['wms_despatch_date_enabled', 'cron_inventory_snapshot_enabled']
  const previous = await ctx.db.setting.findMany({ where: { key: { in: keys } } })
  const put = (key: string, value: string) => ctx.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try {
    await put(keys[0], 'true')
    await put(keys[1], 'false')
    assert.equal(await isWmsDespatchDateEnabled(), false, 'the switch is on but the snapshot job is off: no effect')
    const off = await getWmsDespatchDateStatus()
    assert.deepEqual(off, { switchOn: true, snapshotCronEnabled: false, effective: false })
    const warnings = classifyDespatchDatePrerequisite(off)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].severity, 'warning')
    assert.match(warnings[0].message, /NO EFFECT/)
    await put(keys[1], 'true')
    assert.equal(await isWmsDespatchDateEnabled(), true)
    assert.deepEqual(classifyDespatchDatePrerequisite(await getWmsDespatchDateStatus()), [])
  } finally {
    await ctx.db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of previous) await ctx.db.setting.create({ data: { key: row.key, value: row.value } })
  }
})
