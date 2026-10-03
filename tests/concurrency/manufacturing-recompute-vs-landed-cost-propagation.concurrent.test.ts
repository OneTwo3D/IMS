import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-nrl4 PR A, Codex HIGH on #729 — A MANUFACTURING COST EDIT MUST NOT READ SOURCE-LINE TOTALS BEFORE IT
 * LOCKS THE OUTPUT LAYERS.
 *
 * `recalculateManufacturingCostLayers` recomputes an output layer's unit cost from the sum of its
 * `cost_layer_source_lines.totalCostBase`. Landed-cost PROPAGATION bumps those totals and the output layer
 * while holding the layer. If the recompute READ the totals first and only blocked at its first
 * `UPDATE cost_layers`, a propagation committing in between made it resume with the OLD total and overwrite
 * the uplift, while the revaluation's journal stayed committed.
 *
 * THE ARM: a real revaluation (scope lock + `recalculateLandedCosts`, propagating into the output layer)
 * is PARKED before commit holding the output layer; a real `updateManufacturingCostLines` starts. It must
 * park on the layer LOCK statement (`SELECT ... FOR NO KEY UPDATE`, which is where nothing has been read
 * yet), observed in pg_stat_activity / pg_blocking_pids with both ends named; on release the result must
 * KEEP the uplift. Before the fix the same run parks on `UPDATE cost_layers` (after a stale read) and ends
 * with the uplift erased.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }
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
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
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


const BASE_UNIT = 5
const FREIGHT = 20
const LINE_QTY = 10
const OUTPUT_QTY = 2
const SOURCE_QTY = 2

async function seedWorld(label: string) {
  const { db } = await import('@/lib/db')
  const tag = `NRL4M-${label}-${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const now = new Date()
  const w1 = await db.warehouse.create({ data: { code: `${tag}-1`.slice(0, 40), name: `${tag} w1`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true }, select: { id: true } })
  const component = await db.product.create({ data: { sku: `${tag}-c`, name: `component ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const finished = await db.product.create({ data: { sku: `${tag}-f`, name: `finished ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 50, subtotalBase: 50, taxForeign: 0, taxBase: 0, totalForeign: 50, totalBase: 50,
      destinationWarehouseId: w1.id, receivedAt: now,
      lines: { create: [{ productId: component.id, description: component.id, qty: LINE_QTY, unitCostForeign: BASE_UNIT, unitCostBase: BASE_UNIT, totalForeign: 50, totalBase: 50, landedUnitCostBase: BASE_UNIT, qtyReceived: LINE_QTY, qtyReturned: 0, sortOrder: 0 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const source = await db.costLayer.create({
    data: { productId: component.id, warehouseId: w1.id, receivedQty: LINE_QTY, remainingQty: LINE_QTY - SOURCE_QTY, unitCostBase: BASE_UNIT, receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0]!.id },
    select: { id: true },
  })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: FREIGHT, subtotalBase: FREIGHT, taxForeign: 0, taxBase: 0, totalForeign: FREIGHT, totalBase: FREIGHT,
      freightCostLines: { create: [{ description: 'Freight', amountForeign: FREIGHT, amountBase: FREIGHT, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: false }] },
    },
    select: { id: true },
  })
  const bom = await db.bom.create({ data: { name: `bom ${tag}` }, select: { id: true } })
  const production = await db.productionOrder.create({
    data: {
      reference: `MO-${tag}`, bomId: bom.id, outputProductId: finished.id, warehouseId: w1.id, qtyPlanned: OUTPUT_QTY, qtyProduced: OUTPUT_QTY,
      status: 'COMPLETED', completedAt: now,
      manufacturingCostLines: { create: [{ description: 'overhead', amountForeign: 4, amountBase: 4, sortOrder: 0 }] },
    },
    select: { id: true },
  })
  // The output layer: (component total 10.00 + overhead 4.00) / 2 = 7.00 per unit.
  const output = await db.costLayer.create({
    data: { productId: finished.id, warehouseId: w1.id, receivedQty: OUTPUT_QTY, remainingQty: OUTPUT_QTY, unitCostBase: 7, productionOrderId: production.id },
    select: { id: true },
  })
  const sourceLine = await db.costLayerSourceLine.create({
    data: { costLayerId: output.id, sourceProductId: component.id, sourceCostLayerId: source.id, qty: SOURCE_QTY, unitCostBase: BASE_UNIT, totalCostBase: BASE_UNIT * SOURCE_QTY },
    select: { id: true },
  })
  return { tag, freightId: freight.id, productionId: production.id, outputId: output.id, sourceId: source.id, sourceLineId: sourceLine.id }
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


test('o3d-nrl4 PR A: a manufacturing cost edit locks the output layers before it reads their source-line totals', { skip }, async () => {
  const databaseUrl = loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  const { db } = await import('@/lib/db')
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')

  const world = await seedWorld('m1')
  const probe = await rawSession(databaseUrl)
  const propagated = deferred<number>()
  const release = deferred()
  try {
    // The revaluation: scope lock (which includes the output layer through its source line), recalculation
    // PROPAGATING into the output layer, then parked before commit.
    const revaluation = db.$transaction(async (tx) => {
      const pid = await txPid(tx)
      try {
        const run = await lockAndRecalculate(tx, world.freightId)
        assert.ok(run.scope.costLayerIds.includes(world.outputId), 'PRECONDITION: the output layer is in the revaluation scope')
      } catch (error) {
        propagated.reject(error)
        throw error
      }
      propagated.resolve(pid)
      await release.promise
    }, TX).then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }))
    const revaluationPid = await propagated.promise
    const mid = await db.costLayer.findUniqueOrThrow({ where: { id: world.outputId }, select: { unitCostBase: true } })

    let finished = false
    const editing = updateManufacturingCostLines(world.productionId, [{ description: 'overhead', amountForeign: 6 }])
      .finally(() => { finished = true })
    const blocked = await waitForBlocked(probe, { blockedBy: revaluationPid, waitingOn: /cost_layers/i, describe: 'manufacturing edit', finished: () => finished })
    console.log(`MFG PRECONDITION: edit backend ${blocked.pid} parked behind the propagation (pid ${revaluationPid}) on [${blocked.query.slice(0, 90)}]`)
    assert.match(blocked.query, /SELECT id FROM cost_layers[\s\S]*FOR NO KEY UPDATE/i,
      'the edit must park on the output-layer LOCK statement, i.e. before it has read any source-line total')

    release.resolve()
    assert.deepEqual(await revaluation, { ok: true })
    const result = await editing
    assert.equal(result.success, true, String(result.error))

    // The uplift: freight 20 over 10 units = +2/unit on the component; 2 units consumed => source line +4.
    const line = await db.costLayerSourceLine.findUniqueOrThrow({ where: { id: world.sourceLineId }, select: { totalCostBase: true } })
    const output = await db.costLayer.findUniqueOrThrow({ where: { id: world.outputId }, select: { unitCostBase: true } })
    console.log(`MFG RESULT: output unit mid-propagation=${mid.unitCostBase} source line total=${line.totalCostBase} final output unit=${output.unitCostBase}`)
    assert.equal(Number(line.totalCostBase), BASE_UNIT * SOURCE_QTY + 2 * SOURCE_QTY, 'PRECONDITION: propagation really raised the source line')
    // (component 14.00 + overhead 6.00) / 2 = 10.00. A stale read would give (10 + 6) / 2 = 8.00.
    assert.equal(Number(output.unitCostBase), (Number(line.totalCostBase) + 6) / OUTPUT_QTY, 'the manufacturing recompute kept the landed-cost uplift')
  } finally {
    release.resolve()
    await probe.end()
  }
})
