import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-nrl4 PR A / o3d-t3mbr — THE LANDED-COST REVALUATION SCOPE LOCK, OBSERVED ON REAL LOCKS.
 *
 * `recalculateLandedCosts` rewrites a primary order's cost layers, the layers they feed, and every
 * snapshot naming them, including in-transit `stock_transfer_lines`. It took no transfer lock and no
 * layer lock, while every path that lands or cancels a transfer holds `stock_transfers` first.
 * `lockLandedCostRevaluationScope` (lib/domain/wms/transfer-asn-lock-order.ts) now takes, in the global
 * order, the transfers (2a), the orders with their cost rows (2b-2d) and the cost layers (6) over the
 * closure the recalculation will touch, and refuses with LandedCostScopeRacedError when the closure grew
 * while it was locking.
 *
 * NOTHING HERE READS SOURCE TEXT, AND NOTHING ORDERS ANYTHING BY A WALL-CLOCK SLEEP. Every ordering is
 * established by a LOCK another session holds, and every "the path is now blocked" is read from
 * pg_stat_activity / pg_blocking_pids with BOTH ends named (this test's holder pid, and the statement the
 * blocked backend is running) under a polling deadline that FAILS LOUD. The 25 ms pause inside the poll
 * is a poll interval, not an ordering.
 *
 *   L0  the closure: layers reached through source lines (a destination layer, a manufactured output),
 *       transfers reached through their snapshots; an unrelated layer and transfer are NOT in it.
 *   L1  a session holding the transfer: the recalculation waits on `stock_transfers` and holds NOTHING
 *       else (order, primary order and layer all still lockable) -> transfers are step 2a.
 *   L2  an alignment-shaped session (transfer, then the order) races the recalculation, 20 times: no 40P01.
 *   L3  a dispatch committing between discovery and lock -> LandedCostScopeRacedError, nothing written.
 *   L4  a consumer drawing from the layer blocks behind the scope lock BEFORE any write, then consumes
 *       at the NEW cost.
 *   C*  the three production callers take the same lock first and turn a race into a retry message.
 *   G   golden: the recalculation's results are UNCHANGED by taking the lock (no accounting change).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }
/** Long enough to survive a loaded box, short enough to fail rather than hang. */
const BLOCK_WAIT_MS = 20_000

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  return process.env.DATABASE_URL
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

/** A dedicated connection, so a lock this session takes is genuinely its own. */
async function rawSession(databaseUrl: string): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  return client as unknown as RawClient
}

async function rawPid(session: RawClient): Promise<number> {
  const { rows } = await session.query('SELECT pg_backend_pid()::int AS pid')
  return Number(rows[0]!.pid)
}

/** The pid of the backend an interactive transaction is pinned to (Prisma pins one for its whole life). */
async function txPid(tx: unknown): Promise<number> {
  const rows = await (tx as { $queryRawUnsafe: <T>(sql: string) => Promise<T> })
    .$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid')
  const pid = Number(rows[0]?.pid)
  assert.ok(Number.isInteger(pid) && pid > 0, `pg_backend_pid() returned no usable pid: ${JSON.stringify(rows)}`)
  return pid
}

/**
 * Wait until a backend BLOCKED BY `blockedBy` (a pid this test's own session holds a fixture-unique row
 * with) is running a statement matching `waitingOn`. Both ends named; a deadline that throws; and, when
 * the caller can say the path under test has already finished, an immediate failure instead of a wait
 * for a block that can no longer happen.
 */
async function waitForBlocked(probe: RawClient, params: {
  blockedBy: number
  waitingOn: RegExp
  describe: string
  finished?: () => boolean
}): Promise<{ pid: number; query: string }> {
  const deadline = Date.now() + BLOCK_WAIT_MS
  for (;;) {
    const { rows } = await probe.query(
      `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock'
          AND $1::int = ANY(pg_blocking_pids(a.pid))
        ORDER BY a.pid`,
      [params.blockedBy],
    )
    const hit = rows.find((row) => params.waitingOn.test(String(row.query)))
    if (hit) return { pid: Number(hit.pid), query: String(hit.query) }
    if (params.finished?.()) {
      throw new Error(`${params.describe}: the path under test FINISHED without ever blocking on ${params.waitingOn} behind pid ${params.blockedBy}, so no lock ordering was exercised.`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${params.describe}: no backend blocked by pid ${params.blockedBy} was running a statement matching ${params.waitingOn} within ${BLOCK_WAIT_MS} ms. Rows blocked by it: ${JSON.stringify(rows)}. The path never reached that lock, so this arm proves nothing about acquisition order.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Is the row lockable right now, from a session that holds nothing? false = somebody holds it (55P03). */
async function lockable(probe: RawClient, sql: string, values: unknown[]): Promise<boolean> {
  await probe.query('BEGIN')
  try {
    await probe.query(`${sql} FOR UPDATE NOWAIT`, values)
    return true
  } catch (error) {
    if ((error as { code?: string }).code !== '55P03') throw error
    return false
  } finally {
    await probe.query('ROLLBACK')
  }
}

type World = {
  tag: string
  supplierId: string
  productId: string
  w1: string
  w2: string
  goodsId: string
  goodsLineId: string
  layerId: string
  freightId: string
  transferId: string
  transferLineId: string
}

const FREIGHT = 20
const LINE_QTY = 10
const IN_TRANSIT_QTY = 4
const REMAINING = 6
const BASE_UNIT = 5

/**
 * ONE goods order (10 @ 5.00) whose single cost layer has 6 left on hand and 4 dispatched on an
 * IN_TRANSIT transfer, linked to ONE freight order carrying 20.00 BY_VALUE that has not yet been applied:
 * the revaluation will take the layer from 5.00 to 7.00.
 */
async function seedWorld(label: string, options: { freightStatus?: 'PO_SENT' | 'RECEIVED' | 'PARTIALLY_RECEIVED' } = {}): Promise<World> {
  const { db } = await import('@/lib/db')
  const tag = `NRL4A-${label}-${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const now = new Date()
  const w1 = await db.warehouse.create({ data: { code: `${tag}-1`.slice(0, 40), name: `${tag} w1`, type: 'STANDARD' }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${tag}-2`.slice(0, 40), name: `${tag} w2`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true }, select: { id: true } })
  const product = await db.product.create({ data: { sku: tag, name: `product ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 50, subtotalBase: 50, taxForeign: 0, taxBase: 0, totalForeign: 50, totalBase: 50,
      destinationWarehouseId: w1.id, receivedAt: now,
      lines: {
        create: [{
          productId: product.id, description: product.id, qty: LINE_QTY, unitCostForeign: BASE_UNIT, unitCostBase: BASE_UNIT,
          totalForeign: 50, totalBase: 50, landedUnitCostBase: BASE_UNIT, qtyReceived: LINE_QTY, qtyReturned: 0, sortOrder: 0,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const layer = await db.costLayer.create({
    data: {
      productId: product.id, warehouseId: w1.id, receivedQty: LINE_QTY, remainingQty: REMAINING, unitCostBase: BASE_UNIT,
      receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0]!.id, isOpeningStock: false,
    },
    select: { id: true },
  })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: options.freightStatus ?? 'PO_SENT', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: FREIGHT, subtotalBase: FREIGHT, taxForeign: 0, taxBase: 0, totalForeign: FREIGHT, totalBase: FREIGHT,
      freightCostLines: { create: [{ description: 'Freight', amountForeign: FREIGHT, amountBase: FREIGHT, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: false }] },
    },
    select: { id: true },
  })
  const transfer = await db.stockTransfer.create({
    data: {
      reference: `T-${tag}`, fromWarehouseId: w1.id, toWarehouseId: w2.id, status: 'IN_TRANSIT', dispatchedAt: now,
      lines: {
        create: [{
          productId: product.id, sku: tag, productName: tag, qty: `${IN_TRANSIT_QTY}.0000`, qtyReceived: '0.0000',
          costLayerSnapshot: [{ costLayerId: layer.id, qty: `${IN_TRANSIT_QTY}.000000`, unitCostBase: `${BASE_UNIT}.000000` }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return {
    tag, supplierId: supplier.id, productId: product.id, w1: w1.id, w2: w2.id, goodsId: goods.id, goodsLineId: goods.lines[0]!.id,
    layerId: layer.id, freightId: freight.id, transferId: transfer.id, transferLineId: transfer.lines[0]!.id,
  }
}

/** A committed dispatch from `layerId`: a new IN_TRANSIT transfer whose snapshot names the layer. */
async function commitDispatchFrom(world: World, layerId: string, label: string, options: { decrement?: boolean } = {}): Promise<string> {
  const { db } = await import('@/lib/db')
  const t2 = await db.stockTransfer.create({
    data: {
      reference: `T2-${label}-${world.tag}`, fromWarehouseId: world.w1, toWarehouseId: world.w2, status: 'IN_TRANSIT', dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: world.productId, sku: world.tag, productName: world.tag, qty: '1.0000', qtyReceived: '0.0000',
          costLayerSnapshot: [{ costLayerId: layerId, qty: '1.000000', unitCostBase: `${BASE_UNIT}.000000` }],
        }],
      },
    },
    select: { id: true },
  })
  if (options.decrement !== false) await db.costLayer.update({ where: { id: layerId }, data: { remainingQty: { decrement: 1 } } })
  return t2.id
}

async function layerUnitCost(layerId: string): Promise<number> {
  const { db } = await import('@/lib/db')
  const row = await db.costLayer.findUniqueOrThrow({ where: { id: layerId }, select: { unitCostBase: true } })
  return Number(row.unitCostBase)
}

/** The recalculation exactly as the three callers run it: scope lock, then `recalculateLandedCosts`, all on `tx`. */
async function lockAndRecalculate(tx: unknown, freightId: string) {
  const { lockLandedCostRevaluationScope } = await import('@/lib/domain/wms/transfer-asn-lock-order')
  const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  const scope = await lockLandedCostRevaluationScope(tx as never, { freightPoId: freightId })
  const result = await recalculateLandedCosts(tx as never, freightId, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  })
  return { scope, result }
}

test('o3d-nrl4 PR A: the landed-cost revaluation scope lock', { skip }, async (t) => {
  const databaseUrl = loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  const { db } = await import('@/lib/db')

  await t.test('L0: the closure follows source lines (destination layer, manufactured output) and snapshots, and nothing else', async () => {
    const world = await seedWorld('l0')
    const { lockLandedCostRevaluationScope, LANDED_COST_PROPAGATION_MAX_DEPTH } = await import('@/lib/domain/wms/transfer-asn-lock-order')
    // D: the destination layer a receipt of T would create (linked to L by a source line); T2 sits in
    // transit FROM D. M: a manufactured output that consumed L. U/TU: an unrelated layer and transfer.
    const dest = await db.costLayer.create({ data: { productId: world.productId, warehouseId: world.w2, receivedQty: 4, remainingQty: 0, unitCostBase: 5 }, select: { id: true } })
    await db.costLayerSourceLine.create({ data: { costLayerId: dest.id, sourceProductId: world.productId, sourceCostLayerId: world.layerId, qty: 4, unitCostBase: 5, totalCostBase: 20 } })
    const t2 = await commitDispatchFrom(world, dest.id, 'l0', { decrement: false })
    const output = await db.costLayer.create({ data: { productId: world.productId, warehouseId: world.w1, receivedQty: 2, remainingQty: 2, unitCostBase: 5 }, select: { id: true } })
    await db.costLayerSourceLine.create({ data: { costLayerId: output.id, sourceProductId: world.productId, sourceCostLayerId: world.layerId, qty: 1, unitCostBase: 5, totalCostBase: 5 } })
    const unrelated = await db.costLayer.create({ data: { productId: world.productId, warehouseId: world.w1, receivedQty: 3, remainingQty: 0, unitCostBase: 5 }, select: { id: true } })
    const unrelatedTransfer = await commitDispatchFrom(world, unrelated.id, 'l0u', { decrement: false })

    const scope = await db.$transaction((tx) => lockLandedCostRevaluationScope(tx, { freightPoId: world.freightId }), TX)
    console.log(`L0 PRECONDITION: closure = ${scope.costLayerIds.length} layer(s), ${scope.transferIds.length} transfer(s), ${scope.purchaseOrderIds.length} order(s); depth cap ${LANDED_COST_PROPAGATION_MAX_DEPTH}`)
    assert.deepEqual(scope.costLayerIds, [world.layerId, dest.id, output.id].sort(), 'primary layer + destination layer + manufactured output')
    assert.deepEqual(scope.transferIds, [world.transferId, t2].sort(), 'the in-transit transfer of the primary layer + the transfer out of the destination layer')
    assert.ok(!scope.costLayerIds.includes(unrelated.id) && !scope.transferIds.includes(unrelatedTransfer), 'an unrelated layer/transfer is not locked')
    assert.deepEqual(scope.purchaseOrderIds, [world.freightId, world.goodsId].sort(), 'the freight order and its primary')
    assert.equal(LANDED_COST_PROPAGATION_MAX_DEPTH, 20)
  })

  await t.test('L1: with the transfer held elsewhere the recalculation waits on stock_transfers and holds nothing else', async () => {
    const world = await seedWorld('l1')
    const holder = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    try {
      const holderPid = await rawPid(holder)
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
      let finished = false
      const running = db.$transaction((tx) => lockAndRecalculate(tx, world.freightId), TX)
        .then((v) => { finished = true; return { ok: true as const, value: v } }, (e) => { finished = true; return { ok: false as const, error: e } })
      const blocked = await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'L1', finished: () => finished })
      // What did the blocked path already hold? Probe from a session that holds nothing.
      const orderFree = await lockable(probe, 'SELECT id FROM purchase_orders WHERE id = ANY($1::text[]) ORDER BY id', [[world.goodsId, world.freightId]])
      const linesFree = await lockable(probe, 'SELECT id FROM purchase_order_lines WHERE "poId" = $1', [world.goodsId])
      const layerFree = await lockable(probe, 'SELECT id FROM cost_layers WHERE id = $1', [world.layerId])
      console.log(`L1 PRECONDITION: backend ${blocked.pid} blocked by holder ${holderPid} on [${blocked.query.slice(0, 60)}]; orders free=${orderFree} lines free=${linesFree} layer free=${layerFree}`)
      assert.equal(orderFree, true, 'the path must not hold the purchase orders while it waits for the transfer (2a precedes 2b)')
      assert.equal(linesFree, true, 'the path must not hold purchase_order_lines while it waits for the transfer')
      assert.equal(layerFree, true, 'the path must not hold the cost layer while it waits for the transfer (2a precedes 6)')
      await holder.query('COMMIT')
      const outcome = await running
      assert.equal(outcome.ok, true, `the recalculation completes once the transfer is released: ${outcome.ok ? '' : String(outcome.error)}`)
      assert.equal(await layerUnitCost(world.layerId), BASE_UNIT + FREIGHT / LINE_QTY)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end(); await probe.end()
    }
  })

  await t.test('L2: an alignment-shaped session (transfer, then the order) against the recalculation, 20 times: no deadlock', async () => {
    const ITERATIONS = 20
    const deadlocks: string[] = []
    let blockedBeforeOrder = 0
    for (let i = 0; i < ITERATIONS; i += 1) {
      const world = await seedWorld(`l2-${i}`)
      const alignment = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const alignmentPid = await rawPid(alignment)
        await alignment.query('BEGIN')
        // THE ALIGNMENT'S ORDER: stock_transfers (2a) first ...
        await alignment.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = db.$transaction((tx) => lockAndRecalculate(tx, world.freightId), TX)
          .then((v) => { finished = true; return { ok: true as const, value: v } }, (e) => { finished = true; return { ok: false as const, error: e } })
        await waitForBlocked(probe, { blockedBy: alignmentPid, waitingOn: /stock_transfers/i, describe: `L2 #${i}`, finished: () => finished })
        blockedBeforeOrder += 1
        // ... and ONLY NOW its purchase order and that order's cost rows (2b-2d). If the recalculation took
        // the orders BEFORE the transfers it is sitting on them here and this is a cycle.
        try {
          await alignment.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [world.goodsId])
          await alignment.query('SELECT id FROM purchase_order_lines WHERE "poId" = $1 ORDER BY id FOR UPDATE', [world.goodsId])
          await alignment.query('COMMIT')
        } catch (error) {
          if ((error as { code?: string }).code === '40P01') deadlocks.push(`#${i}: alignment side aborted 40P01`)
          else throw error
          await alignment.query('ROLLBACK').catch(() => {})
        }
        const outcome = await running
        if (!outcome.ok) {
          const code = (outcome.error as { code?: string; cause?: { code?: string } })
          if (code.code === '40P01' || /deadlock detected/i.test(String(outcome.error))) deadlocks.push(`#${i}: recalculation side aborted 40P01`)
          else throw outcome.error
        }
      } finally {
        await alignment.query('ROLLBACK').catch(() => {})
        await alignment.end(); await probe.end()
      }
    }
    console.log(`L2 PRECONDITION: ${blockedBeforeOrder}/${ITERATIONS} iterations had the recalculation parked on stock_transfers before the alignment asked for its order; deadlocks=${deadlocks.length}`)
    assert.equal(blockedBeforeOrder, ITERATIONS)
    assert.deepEqual(deadlocks, [], 'no 40P01 in either direction')
  })

  await t.test('L3: a dispatch committing between discovery and lock is refused by name, and nothing is written', async () => {
    const { LandedCostScopeRacedError } = await import('@/lib/domain/wms/transfer-asn-lock-order')
    const world = await seedWorld('l3')
    const holder = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    try {
      const holderPid = await rawPid(holder)
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
      let finished = false
      const running = db.$transaction((tx) => lockAndRecalculate(tx, world.freightId), TX)
        .then((v) => { finished = true; return { ok: true as const, value: v } }, (e) => { finished = true; return { ok: false as const, error: e } })
      // Parked on the transfer lock means discovery (which precedes it) has ALREADY RUN against the old world.
      await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'L3', finished: () => finished })
      const t2 = await commitDispatchFrom(world, world.layerId, 'l3')
      console.log(`L3 PRECONDITION: discovery done (path parked on the transfer); dispatch transfer ${t2} committed in the window`)
      await holder.query('COMMIT')
      const outcome = await running
      assert.equal(outcome.ok, false, 'the recalculation must refuse, not run on a scope that no longer matches')
      const error = outcome.ok ? null : outcome.error
      assert.ok(error instanceof LandedCostScopeRacedError, `refused by name, got: ${String(error)}`)
      assert.deepEqual(error.unlockedTransferIds, [t2], 'exactly the late dispatch is outside the locked set')
      assert.deepEqual(error.unlockedCostLayerIds, [])
      assert.match(error.message, /Retry the action/)
      assert.equal(await layerUnitCost(world.layerId), BASE_UNIT, 'nothing was written: the layer still has its old cost')
      const runs = await db.landedCostRevaluationRun.count({ where: { freightPoId: world.freightId } })
      assert.equal(runs, 0, 'no revaluation run was recorded')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end(); await probe.end()
    }
  })

  await t.test('L4: a consumer drawing from the layer blocks behind the scope lock before any write, then consumes at the new cost', async () => {
    const world = await seedWorld('l4')
    const probe = await rawSession(databaseUrl)
    const locked = deferred<number>()
    const release = deferred()
    try {
      const recalc = db.$transaction(async (tx) => {
        const pid = await txPid(tx)
        const { lockLandedCostRevaluationScope } = await import('@/lib/domain/wms/transfer-asn-lock-order')
        const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
        await lockLandedCostRevaluationScope(tx, { freightPoId: world.freightId })
        locked.resolve(pid) // locks held, NOTHING written yet
        await release.promise
        return recalculateLandedCosts(tx, world.freightId, undefined, { triggeredById: null, reason: 'freight_purchase_order_costs_updated' })
      }, TX).then((v) => ({ ok: true as const, value: v }), (e) => ({ ok: false as const, error: e }))
      const recalcPid = await locked.promise

      let consumerDone = false
      const { consumeFifoLayers } = await import('@/lib/cost-layers')
      const consumer = db.$transaction((tx) => consumeFifoLayers(tx, world.productId, world.w1, 2), TX)
        .then((v) => { consumerDone = true; return { ok: true as const, value: v } }, (e) => { consumerDone = true; return { ok: false as const, error: e } })
      const blocked = await waitForBlocked(probe, { blockedBy: recalcPid, waitingOn: /cost_layers[\s\S]*FOR UPDATE/i, describe: 'L4', finished: () => consumerDone })
      console.log(`L4 PRECONDITION: consumer backend ${blocked.pid} blocked by the scope lock holder ${recalcPid} with no write yet`)
      release.resolve()
      const recalcOutcome = await recalc
      assert.equal(recalcOutcome.ok, true, `recalc committed: ${recalcOutcome.ok ? '' : String(recalcOutcome.error)}`)
      const consumed = await consumer
      assert.equal(consumed.ok, true, `consumer completed after the commit: ${consumed.ok ? '' : String(consumed.error)}`)
      if (consumed.ok) {
        assert.equal(Number(consumed.value.totalCost), 2 * (BASE_UNIT + FREIGHT / LINE_QTY), 'it consumed at the NEW unit cost, not the pre-revaluation one')
      }
    } finally {
      release.resolve()
      await probe.end()
    }
  })

  await t.test('C1: updateFreightPoCosts takes the transfer first, and a scope race is a retry message, not a crash', async () => {
    const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
    const lines = [{ description: 'Freight', amountForeign: 30, vatable: false, distributionMethod: 'BY_VALUE' }]
    // (a) order
    {
      const world = await seedWorld('c1a')
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = updateFreightPoCosts(world.freightId, lines).finally(() => { finished = true })
        const blocked = await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C1a', finished: () => finished })
        const orderFree = await lockable(probe, 'SELECT id FROM purchase_orders WHERE id = ANY($1::text[]) ORDER BY id', [[world.goodsId, world.freightId]])
        const layerFree = await lockable(probe, 'SELECT id FROM cost_layers WHERE id = $1', [world.layerId])
        console.log(`C1a PRECONDITION: updateFreightPoCosts backend ${blocked.pid} parked on stock_transfers; orders free=${orderFree} layer free=${layerFree}`)
        assert.equal(orderFree, true, 'updateFreightPoCosts holds no order while waiting for the transfer')
        assert.equal(layerFree, true, 'updateFreightPoCosts holds no layer while waiting for the transfer')
        await holder.query('COMMIT')
        const result = await running
        assert.deepEqual(result, { success: true })
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT + 30 / LINE_QTY)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
    // (b) race -> retry message
    {
      const world = await seedWorld('c1b')
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = updateFreightPoCosts(world.freightId, lines).finally(() => { finished = true })
        await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C1b', finished: () => finished })
        const t2 = await commitDispatchFrom(world, world.layerId, 'c1b')
        await holder.query('COMMIT')
        const result = await running
        console.log(`C1b PRECONDITION: late dispatch ${t2} committed while the action was parked; result=${JSON.stringify(result)}`)
        assert.equal(result.success, false)
        assert.match(String(result.error), /Retry the action/)
        assert.doesNotMatch(String(result.error), /^Error:|LandedCostScopeRacedError/, 'a clean operator message, not a stringified exception')
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT, 'rolled back: nothing changed')
        const costLine = await db.freightCostLine.findFirstOrThrow({ where: { poId: world.freightId }, select: { amountBase: true } })
        assert.equal(Number(costLine.amountBase), FREIGHT, 'the freight cost lines were not replaced either')
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
  })

  await t.test('C2: createFreightPo locks the scope FIRST (it locked nothing before), and a scope race rolls the creation back with a retry message', async () => {
    const { createFreightPo } = await import('@/app/actions/purchase-orders')
    function input(world: World) {
      return {
        supplierId: world.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [world.goodsId],
        costLines: [{ description: 'Freight', amountForeign: 30, vatable: false, distributionMethod: 'BY_VALUE' }],
      }
    }
    // (a) order: the action parks on the transfer holding no order and no layer
    {
      const world = await seedWorld('c2a')
      // Detach the fixture's own freight order so this primary has no link yet.
      await db.landedCostLink.deleteMany({ where: { primaryPoId: world.goodsId } })
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = createFreightPo(input(world)).finally(() => { finished = true })
        const blocked = await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C2a', finished: () => finished })
        const orderFree = await lockable(probe, 'SELECT id FROM purchase_orders WHERE id = $1', [world.goodsId])
        const layerFree = await lockable(probe, 'SELECT id FROM cost_layers WHERE id = $1', [world.layerId])
        console.log(`C2a PRECONDITION: createFreightPo backend ${blocked.pid} parked on stock_transfers; primary free=${orderFree} layer free=${layerFree}`)
        assert.equal(orderFree, true)
        assert.equal(layerFree, true)
        await holder.query('COMMIT')
        const result = await running
        assert.equal(result.success, true, `createFreightPo succeeds once the transfer is released: ${result.error}`)
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT + 30 / LINE_QTY)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
    // (b) race -> whole creation rolled back
    {
      const world = await seedWorld('c2b')
      await db.landedCostLink.deleteMany({ where: { primaryPoId: world.goodsId } })
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = createFreightPo(input(world)).finally(() => { finished = true })
        await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C2b', finished: () => finished })
        const t2 = await commitDispatchFrom(world, world.layerId, 'c2b')
        await holder.query('COMMIT')
        const result = await running
        console.log(`C2b PRECONDITION: late dispatch ${t2} committed while createFreightPo was parked; result=${JSON.stringify({ success: result.success, error: result.error })}`)
        assert.equal(result.success, false)
        assert.match(String(result.error), /Retry the action/)
        const links = await db.landedCostLink.count({ where: { primaryPoId: world.goodsId } })
        assert.equal(links, 0, 'the freight order and its link rolled back with the refusal')
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
  })

  await t.test('C3: cancelling a FREIGHT order takes the whole scope (it locked only the parent), and a scope race is a retry message', async () => {
    const { cancelPurchaseOrderService } = await import('@/lib/domain/purchasing/cancellation-service')
    // First apply the freight so there is an uplift for the cancellation to revert.
    const prepare = async (label: string) => {
      // PARTIALLY_RECEIVED: the purchase-order state machine only lets that kind of freight order be cancelled.
      const world = await seedWorld(label, { freightStatus: 'PARTIALLY_RECEIVED' })
      await db.$transaction((tx) => lockAndRecalculate(tx, world.freightId), TX)
      assert.equal(await layerUnitCost(world.layerId), BASE_UNIT + FREIGHT / LINE_QTY, `${label} precondition: the freight was applied`)
      return world
    }
    // (a) order
    {
      const world = await prepare('c3a')
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = cancelPurchaseOrderService(world.freightId).finally(() => { finished = true })
        const blocked = await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C3a', finished: () => finished })
        const orderFree = await lockable(probe, 'SELECT id FROM purchase_orders WHERE id = ANY($1::text[]) ORDER BY id', [[world.goodsId, world.freightId]])
        const layerFree = await lockable(probe, 'SELECT id FROM cost_layers WHERE id = $1', [world.layerId])
        console.log(`C3a PRECONDITION: cancellation backend ${blocked.pid} parked on stock_transfers; orders free=${orderFree} layer free=${layerFree}`)
        assert.equal(orderFree, true, 'cancellation holds no order while waiting for the transfer')
        assert.equal(layerFree, true)
        await holder.query('COMMIT')
        const result = await running
        assert.equal(result.success, true, `cancellation succeeds once released: ${result.error}`)
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT, 'the uplift was reverted')
        const status = await db.purchaseOrder.findUniqueOrThrow({ where: { id: world.freightId }, select: { status: true } })
        assert.equal(status.status, 'CANCELLED')
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
    // (b) race -> retry message, order not cancelled
    {
      const world = await prepare('c3b')
      const holder = await rawSession(databaseUrl)
      const probe = await rawSession(databaseUrl)
      try {
        const holderPid = await rawPid(holder)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [world.transferId])
        let finished = false
        const running = cancelPurchaseOrderService(world.freightId).finally(() => { finished = true })
        await waitForBlocked(probe, { blockedBy: holderPid, waitingOn: /stock_transfers/i, describe: 'C3b', finished: () => finished })
        const t2 = await commitDispatchFrom(world, world.layerId, 'c3b')
        await holder.query('COMMIT')
        const result = await running
        console.log(`C3b PRECONDITION: late dispatch ${t2} committed while the cancellation was parked; result=${JSON.stringify({ success: result.success, error: result.error })}`)
        assert.equal(result.success, false)
        assert.match(String(result.error), /Retry the action/)
        const status = await db.purchaseOrder.findUniqueOrThrow({ where: { id: world.freightId }, select: { status: true } })
        assert.equal(status.status, 'PARTIALLY_RECEIVED', 'the cancellation rolled back')
        assert.equal(await layerUnitCost(world.layerId), BASE_UNIT + FREIGHT / LINE_QTY, 'the uplift is still applied')
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end(); await probe.end()
      }
    }
  })

  await t.test('G: golden — taking the lock changes none of the recalculation\'s results (no accounting change in this PR)', async () => {
    const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
    const plain = await seedWorld('gplain')
    const locked = await seedWorld('glocked')
    const plainResult = await db.$transaction((tx) => recalculateLandedCosts(tx, plain.freightId, undefined, {
      triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
    }), TX)
    const lockedRun = await db.$transaction((tx) => lockAndRecalculate(tx, locked.freightId), TX)

    const normalise = (r: typeof plainResult, world: World) => ({
      warnings: r.warnings,
      cogs: r.cogsAdjustments.map((a) => ({ ref: a.primaryPoRef.replace(world.tag, 'TAG'), totalDelta: a.totalDelta })),
      inventory: r.inventoryTransitAdjustments.map((a) => ({ ref: a.primaryPoRef.replace(world.tag, 'TAG'), totalDelta: a.totalDelta })),
      revalidate: r.revalidatePoIds.length,
      auditRuns: r.auditRunIds.length,
    })
    const a = normalise(plainResult, plain)
    const b = normalise(lockedRun.result, locked)
    console.log(`G PRECONDITION: unlocked = ${JSON.stringify(a)}; locked = ${JSON.stringify(b)}`)
    assert.deepEqual(b, a, 'identical results with and without the scope lock')
    // And the literal golden, so "identical" cannot mean "identically wrong": 6 on hand x (7.00 - 5.00) =
    // 12.00 inventory; the 4 in transit are excluded from COGS and (still, until PR B) post nothing.
    assert.deepEqual(a.inventory.map((x) => x.totalDelta), [12])
    assert.deepEqual(a.cogs, [])
    for (const world of [plain, locked]) {
      assert.equal(await layerUnitCost(world.layerId), 7)
      const line = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: world.goodsLineId }, select: { landedUnitCostBase: true } })
      assert.equal(Number(line.landedUnitCostBase), 7)
      const tl = await db.stockTransferLine.findUniqueOrThrow({ where: { id: world.transferLineId }, select: { costLayerSnapshot: true } })
      assert.equal(Number((tl.costLayerSnapshot as Array<{ unitCostBase: string }>)[0]!.unitCostBase), 7, 'the in-transit snapshot is rewritten as before')
    }
  })
})
