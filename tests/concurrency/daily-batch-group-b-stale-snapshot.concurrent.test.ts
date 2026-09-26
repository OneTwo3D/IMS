import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'

/**
 * o3d-c08y round 2, Codex HIGH — THE COST-LAYER LOCK MUST ACTUALLY SERIALIZE THE BATCH AGAINST A REAL
 * LANDED-COST REVALUATION. Needs real Postgres: the property is a lock wait and what is visible after
 * it.
 *
 * THE DEFECT, measured end to end before the fix (probe kept outside the repository at
 * /var/tmp/ims-session-park-20260913/c08y2-probe/race.ts; own throwaway scratch database, network
 * trapped): with a revaluation held open, the real `runDailyBatchSync`
 * parked at `SELECT id FROM "cost_layers" … FOR UPDATE` — observed in `pg_stat_activity` — and then
 * posted DAILY_BATCH_GROUP_B COGS £4.00 from the window it had read BEFORE the lock, stamped
 * `shipmentJournalDate`, wrote `cogsBatchAmount` back to 4.00 over the committed -6.00 and recorded a
 * 4.00 DISPATCH subledger row, with `result.errors` empty. After the fix the same interleaving refuses
 * the order by name and stamps nothing.
 *
 * WHAT IS ASSERTED HERE, with the real `recalculateLandedCosts` on one connection and the real
 * `lockCostLayersForGroupBWindow` on another:
 *  1. the lock BLOCKS while the revaluation holds the layer (proved from `pg_stat_activity`, not from a
 *     sleep), and the read that follows it returns the COMMITTED NEGATIVE snapshot — never the positive
 *     one the probe saw;
 *  2. the other way round: a batch that takes the lock first and journals the shipment makes the
 *     revaluation block and then REFUSE (`JournaledShipmentRevaluationRefusedError`), leaving the layer
 *     and the snapshot as they were.
 * Together those are the two halves of "a revaluation and Group B can no longer disagree".
 *
 * The full `runDailyBatchSync` is deliberately NOT run here: this tier shares one scratch database and
 * runs its files in parallel, and a real batch run would journal other files' fixtures. The end-to-end
 * run is the probe above; what this file proves is the ordering property on real locks.
 *
 * No network: fetch and the connector transport throw. No email is sent.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }

const NO_NETWORK = 'o3d-c08y r2 test: an outbound network call was attempted.'
globalThis.fetch = (async () => { throw new Error(NO_NETWORK) }) as typeof fetch
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(NO_NETWORK) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Every order this file seeded, deleted when the file ends (a journaled shipment with no mirrored event is a reconciliation finding). */
const seededOrderIds: string[] = []

async function deleteSeededOrders() {
  if (seededOrderIds.length === 0) return
  const { db } = await import('@/lib/db')
  const shipments = await db.shipment.findMany({ where: { orderId: { in: seededOrderIds } }, select: { id: true } })
  const shipmentIds = shipments.map((shipment) => shipment.id)
  await db.shipmentLine.deleteMany({ where: { shipmentId: { in: shipmentIds } } })
  await db.shipment.deleteMany({ where: { id: { in: shipmentIds } } })
  await db.orderAllocation.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  await db.salesOrderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  const deleted = await db.salesOrder.deleteMany({ where: { id: { in: seededOrderIds } } })
  assert.equal(deleted.count, seededOrderIds.length, 'the seeded orders were not all removed')
}

/**
 * One unit bought at 4.00, shipped and NOT journaled — the case `refreshShipmentCogsForCostLayerChange`
 * deliberately hands to the daily batch — with a linked freight PO carrying a -10.00 credit line.
 */
async function seed(label: string) {
  const { db } = await import('@/lib/db')
  const tag = `C08Y2-${label}-${process.pid}-${Date.now()}`
  const now = new Date()
  const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, availableForSale: true, active: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true } })
  const customer = await db.customer.create({ data: { firstName: 'C08Y2', lastName: tag, email: `${tag.toLowerCase()}@example.invalid`, active: true } })
  const product = await db.product.create({ data: {
    sku: tag, name: `product ${tag}`, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: 10,
    salesPriceTaxInclusive: false, taxCategory: 'STANDARD', stockUnit: 'pcs', oversellAllowed: false, active: true,
  } })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 4, subtotalBase: 4, taxForeign: 0, taxBase: 0, totalForeign: 4, totalBase: 4,
      destinationWarehouseId: warehouse.id, receivedAt: now,
      lines: { create: [{ productId: product.id, description: product.name, qty: 1, unitCostForeign: 4, unitCostBase: 4, totalForeign: 4, totalBase: 4, landedUnitCostBase: 4, qtyReceived: 1, qtyReturned: 0, sortOrder: 0 }] },
    },
    include: { lines: true },
  })
  const layer = await db.costLayer.create({ data: {
    productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 0, unitCostBase: 4,
    receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0].id, isOpeningStock: false,
  } })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: -10, subtotalBase: -10, taxForeign: 0, taxBase: 0, totalForeign: -10, totalBase: -10, receivedAt: now,
      freightCostLines: { create: [{ description: 'Freight credit', amountForeign: -10, amountBase: -10, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: true }] },
    },
    include: { freightCostLines: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${tag}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, customerId: customer.id,
      customerName: 'C08Y2', customerEmail: customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, totalForeign: 10,
      subtotalBase: 10, shippingBase: 0, taxBase: 0, totalBase: 10, shipFromWarehouseId: warehouse.id, shippedAt: now,
      revenueDeferredDate: new Date(now.getTime() - 10_000), inventoryAllocatedDate: new Date(now.getTime() - 9_000),
      unearnedRevenueAmount: 10, accountingInvoiceId: `INV-${tag}`,
      lines: { create: [{ productId: product.id, sku: product.sku, description: product.name, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10, cogsBase: 4 }] },
    },
    include: { lines: true },
  })
  seededOrderIds.push(order.id)
  const snapshot = [{ costLayerId: layer.id, qty: '1.000000', unitCostBase: '4.000000' }]
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id, warehouseId: warehouse.id, status: 'SHIPPED', shippedAt: now,
      shipmentJournalDate: null, cogsBatchAmount: 4,
      lines: { create: [{ lineId: order.lines[0].id, productId: product.id, qty: 1, costLayerSnapshot: snapshot as never }] },
    },
  })
  await db.orderAllocation.create({ data: {
    orderId: order.id, lineId: order.lines[0].id, productId: product.id, warehouseId: warehouse.id,
    qty: 1, costLayerSnapshot: snapshot as never,
  } })
  return { tag, goods, layer, freight, shipment, order, creditLineId: freight.freightCostLines[0].id }
}

/**
 * THE STATEMENT **THIS TEST'S OWN BACKEND** IS BLOCKED ON — SCOPED BY pid, NOT BY TEXT (o3d-4shlo).
 *
 * `pg_stat_activity` is DATABASE-WIDE and this tier runs its files CONCURRENTLY against ONE scratch
 * database, so "some backend is waiting on a lock" says nothing about this transaction. Two rounds of
 * narrowing by TEXT were both wrong for the same reason:
 *
 *   · o3d-3ixpg / o3d-j625 r12 — the original returned `rows[0].query` from ANY waiting backend.
 *     Measured: it returned `SELECT pg_advisory_xact_lock($1, $2)` from
 *     tests/concurrency/posting-refusal-record-race (which holds posting keys for 500ms on purpose),
 *     and the assertion below then failed about another file's transaction. Two subtests red with
 *     nothing wrong in either subject.
 *   · o3d-4shlo — the fix for that took the pattern the caller was about to assert about
 *     (`/cost_layers/`, and `/cost_layers|shipments/` at the second call site) and polled until a wait
 *     matching it appeared. A TABLE NAME IS NOT AN IDENTITY EITHER: any other file touching
 *     `cost_layers` satisfies it. MEASURED (the reproduction on this issue): with two foreign backends
 *     contending on one `cost_layers` row, the text-scoped probe returned the FOREIGN waiter's
 *     statement (`SELECT id FROM "cost_layers" WHERE id = $1 FOR UPDATE`, pid 2334944) on its FIRST
 *     poll, the caller released its held transaction before its own batch had reached the lock at all,
 *     and the batch (pid 2334967) then took no lock and never waited on one — while every assertion in
 *     the subtest passed, including `assert.match(lockWaitStatement, /cost_layers/)`.
 *     A guard that passes with the ordering removed is not a guard.
 *
 * SO THE SCOPE IS TWO BACKEND pids, AND BOTH COME FROM INSIDE THE TRANSACTIONS THEMSELVES.
 * `backendPid(tx)` runs `pg_backend_pid()` on the interactive transaction's own connection — Prisma
 * pins one pooled connection for the life of an interactive transaction, so that pid is the backend
 * which executes every later statement of that same transaction, including the one that blocks.
 * (Asserted, not assumed: `backendPid` is called twice inside one transaction in the third subtest
 * below and the two answers must agree.) The probe then requires BOTH:
 *   · `pg_stat_activity.pid` = the pid of the transaction the caller says is about to block, and
 *   · `pg_blocking_pids(pid)` CONTAINS the pid of the transaction the caller says is holding the lock.
 * That is "MY transaction is waiting on THEIR lock" — the ordering itself — and it is the shape the
 * other files in this tier already use (transfer-asn-lock-order, wms-default-delta-scope-lock,
 * pending-asn-disposal-race all name the blocker's pid).
 *
 * WHAT THIS GUARANTEES: a pid cannot be another connection's, so no other file's wait can satisfy it,
 * whatever table that file touches; and a wait of ours on something OTHER than the named holder does
 * not satisfy it either. WHAT IT DOES NOT: it does not identify WHICH lock, so the caller still
 * asserts the statement — but now about a statement that is certainly its own.
 *
 * It is not weaker than either predecessor: if that backend never waits on that holder, the budget is
 * exhausted and this THROWS, so an ordering that was never exercised still fails. The refusal reports
 * how many times it polled, every FOREIGN wait it declined, and every wait of OUR OWN whose blocker
 * was somebody else — so "the tier was busy" is visible rather than inferred.
 */
async function backendPid(tx: unknown): Promise<number> {
  const rows = await (tx as { $queryRawUnsafe: <T>(sql: string) => Promise<T> })
    .$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid')
  const pid = Number(rows[0]?.pid)
  assert.ok(Number.isInteger(pid) && pid > 0, `pg_backend_pid() returned no usable pid: ${JSON.stringify(rows)}`)
  return pid
}

/** What a poll declined and why — read by the scoping subtest, printed in the refusal. */
type DeclinedWaits = {
  polls: number
  /** Lock waits belonging to other backends entirely (another file in this tier). */
  foreign: Map<number, string>
  /** Lock waits of OUR backend that some other backend was holding up. */
  wrongBlocker: Map<number, number[]>
}

function declinedWaits(): DeclinedWaits {
  return { polls: 0, foreign: new Map(), wrongBlocker: new Map() }
}

async function waitForLockWait(
  who: { pid: number; blockedBy: number },
  options: { attempts?: number; declined?: DeclinedWaits } = {},
): Promise<string> {
  const attempts = options.attempts ?? 600
  const { db } = await import('@/lib/db')
  const declined = options.declined ?? declinedWaits()
  assert.notEqual(who.pid, who.blockedBy, 'a transaction cannot be blocked by itself')
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Unscoped on purpose, then filtered HERE: the rows that are not ours are the diagnostic.
    const rows = await db.$queryRawUnsafe<Array<{ pid: number; query: string; blockers: number[] }>>(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
    )
    declined.polls = attempt + 1
    for (const row of rows) {
      const blockers = (row.blockers ?? []).map(Number)
      if (Number(row.pid) !== who.pid) {
        declined.foreign.set(Number(row.pid), row.query)
        continue
      }
      if (blockers.includes(who.blockedBy)) return row.query
      declined.wrongBlocker.set(Number(row.pid), blockers)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `PRECONDITION FAILED: backend ${who.pid} — the connection this test's own transaction is pinned to — never `
    + `blocked on a lock held by backend ${who.blockedBy} in ${declined.polls} polls, so no ordering was `
    + `exercised. Foreign lock waits declined meanwhile (pid => statement): `
    + `${JSON.stringify([...declined.foreign])}. Waits of our own backend with other blockers: `
    + `${JSON.stringify([...declined.wrongBlocker])}`,
  )
}

const recalcLinked = async (tx: unknown, freightPoId: string) => {
  const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  return recalculateLandedCosts(tx as never, freightPoId, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  })
}

test('o3d-c08y r2: the Group B cost-layer lock serializes the batch against a landed-cost revaluation', { skip }, async (t) => {
  loadEnv()
  await assertScratchDatabaseBeforeAnyWrite()
  t.after(deleteSeededOrders)

  await t.test('the batch blocks on the lock and then reads the COMMITTED negative snapshot, not the probe\'s positive one', async () => {
    const fixture = await seed('blocks')
    const { db } = await import('@/lib/db')
    const {
      DAILY_BATCH_GROUP_B_SHIPMENT_WHERE,
      lockCostLayersForGroupBWindow,
      assertGroupBSnapshotsWereLocked,
    } = await import('@/lib/domain/accounting/daily-batch-group-b-lock')

    const revaluationWrote = deferred()
    const releaseRevaluation = deferred()
    let revaluationError: unknown = null
    const revaluationBackend = deferred<number>()
    const revaluation = db.$transaction(async (tx) => {
      revaluationBackend.resolve(await backendPid(tx))
      await recalcLinked(tx, fixture.freight.id)
      revaluationWrote.resolve()
      await releaseRevaluation.promise
    }, TX).catch((error) => { revaluationError = error })
    await revaluationWrote.promise

    let probeUnitCost: string | null = null
    let readUnitCost: string | null = null
    let lockWaitStatement: string | null = null
    const batchBackend = deferred<number>()
    const batch = db.$transaction(async (tx) => {
      // THE pid OF THE BACKEND THAT IS ABOUT TO BLOCK, taken INSIDE the transaction that will block on
      // the lock below — not from a fresh connection, which the pool may place on a different backend.
      batchBackend.resolve(await backendPid(tx))

      // PROBE — before the lock, so it still sees the positive basis the revaluation has not committed.
      const candidates = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: fixture.shipment.id },
        select: { id: true, orderId: true, lines: { select: { costLayerSnapshot: true } } },
      })
      assert.equal(candidates.length, 1, 'PRECONDITION: the fixture is selectable by Group B')
      probeUnitCost = String((candidates[0].lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase)

      // LOCK — this is where the real batch was observed to park.
      const locked = await lockCostLayersForGroupBWindow(tx, { candidates })
      assert.ok(locked.has(fixture.layer.id), 'PRECONDITION: the revalued layer is in the locked set')

      // READ — under the lock.
      const shipments = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: { in: candidates.map((row) => row.id) } },
        select: { id: true, cogsBatchAmount: true, lines: { select: { costLayerSnapshot: true } } },
      })
      assert.equal(shipments.length, 1, 'the shipment still qualifies')
      readUnitCost = String((shipments[0].lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase)
      assertGroupBSnapshotsWereLocked(locked, [
        { what: 'the shipment lines it would post', rows: shipments.flatMap((shipment) => shipment.lines) },
      ])
      return Number(shipments[0].cogsBatchAmount)
    }, TX)

    lockWaitStatement = await waitForLockWait({
      pid: await batchBackend.promise,          // the batch: the transaction that must block
      blockedBy: await revaluationBackend.promise, // the revaluation: the transaction holding the layer
    })
    releaseRevaluation.resolve()
    const reloadedCogs = await batch
    await revaluation

    assert.equal(revaluationError, null, `PRECONDITION: the revaluation committed: ${String(revaluationError)}`)
    // The probe already established WHOSE wait this is (the batch transaction's own backend). This
    // establishes WHICH lock it was: the Group B `FOR UPDATE`, a statement only the subject issues.
    assert.match(
      lockWaitStatement, /SELECT id FROM "cost_layers" WHERE id IN [\s\S]*FOR UPDATE/,
      `PRECONDITION: what THIS transaction blocked on was the cost-layer lock, so the ordering under test `
      + `was exercised: ${lockWaitStatement}`,
    )
    assert.equal(probeUnitCost, '4.000000', 'PRECONDITION: the probe really did see the stale positive basis')
    assert.equal(readUnitCost, '-6.000000', 'the read under the lock returns the COMMITTED negative basis (o3d-c08y r2)')
    assert.equal(reloadedCogs, -6, 'and the cogsBatchAmount it would post with is the committed one')
  })

  await t.test('the other way round: the batch locks first, journals the shipment, and the revaluation is REFUSED', async () => {
    const fixture = await seed('reverse')
    const { db } = await import('@/lib/db')
    const { JournaledShipmentRevaluationRefusedError } = await import('@/lib/cost-layers')
    const {
      DAILY_BATCH_GROUP_B_SHIPMENT_WHERE,
      lockCostLayersForGroupBWindow,
    } = await import('@/lib/domain/accounting/daily-batch-group-b-lock')

    const batchHoldsLock = deferred()
    const releaseBatch = deferred()
    const batchBackend = deferred<number>()
    const batch = db.$transaction(async (tx) => {
      batchBackend.resolve(await backendPid(tx))
      const candidates = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: fixture.shipment.id },
        select: { id: true, orderId: true, lines: { select: { costLayerSnapshot: true } } },
      })
      await lockCostLayersForGroupBWindow(tx, { candidates })
      // What Group B does at the end of a successful window.
      await tx.shipment.update({
        where: { id: fixture.shipment.id },
        data: { shipmentJournalDate: new Date(), cogsBatchAmount: 4, allocatedReliefAmount: 4 },
      })
      batchHoldsLock.resolve()
      await releaseBatch.promise
    }, TX)
    await batchHoldsLock.promise

    let refusal: unknown = null
    const revaluationBackend = deferred<number>()
    const revaluation = db.$transaction(async (tx) => {
      // Same discipline the other way round: here it is the REVALUATION that blocks, so its own
      // transaction reports the pid.
      revaluationBackend.resolve(await backendPid(tx))
      return recalcLinked(tx, fixture.freight.id)
    }, TX).catch((error) => { refusal = error })

    const lockWaitStatement = await waitForLockWait({
      pid: await revaluationBackend.promise, // this time the revaluation is the one that must block
      blockedBy: await batchBackend.promise, // on the rows the batch holds
    })
    releaseBatch.resolve()
    await batch
    await revaluation

    // Scoped to the revaluation's OWN backend, so an OR here is the two rows it may contend for first
    // (the locked layer, or the row the batch updated) — not two ways for a foreign wait to qualify.
    assert.match(
      lockWaitStatement, /cost_layers|shipments/,
      `PRECONDITION: the revaluation's own backend waited, and on one of the rows the batch holds: ${lockWaitStatement}`,
    )
    assert.ok(
      refusal instanceof JournaledShipmentRevaluationRefusedError,
      `the revaluation is refused once the shipment is journaled: ${String(refusal)}`,
    )
    const layer = await db.costLayer.findUniqueOrThrow({ where: { id: fixture.layer.id }, select: { unitCostBase: true } })
    assert.equal(Number(layer.unitCostBase), 4, 'and the refused revaluation left the layer as it was')
    const shipment = await db.shipment.findUniqueOrThrow({
      where: { id: fixture.shipment.id }, select: { cogsBatchAmount: true, lines: { select: { costLayerSnapshot: true } } },
    })
    assert.equal(Number(shipment.cogsBatchAmount), 4, 'and the journaled COGS as it was')
    assert.equal(
      String((shipment.lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase), '4.000000',
      'and the snapshot as it was',
    )
  })
  /**
   * o3d-4shlo — THE PROBE ITSELF, UNDER TEST. The two subtests above rest entirely on
   * `waitForLockWait` having established that THIS test's transaction blocked on THAT transaction's lock;
   * a probe that accepts any backend's wait lets them pass with the ordering removed. That is not a
   * theory: with the text-scoped probe this file shipped with, the reproduction on o3d-4shlo took the
   * cost-layer lock out of the batch entirely and every assertion still passed (see the helper above).
   * So the scoping is asserted here rather than asserted about.
   *
   * ARRANGEMENT: two raw backends contend for one `cost_layers` row — exactly what a sibling file in this
   * tier looks like from `pg_stat_activity`. The waiter's statement MATCHES the text pattern the previous
   * two versions of this probe polled for, and that is asserted, so this is not a subtest that would pass
   * with the foreign wait absent. Meanwhile one backend of OURS is held open in a transaction that waits
   * on nothing at all.
   *
   * REQUIRED, in this order:
   *   1. asked about OUR idle backend, the probe declines the foreign wait and exhausts its budget;
   *   2. asked about the FOREIGN waiter's own pid and its real holder, the SAME probe returns at once —
   *      so step 1 failed on identity, not because the query or the polling is broken;
   *   3. with a backend of OURS genuinely blocked — but blocked by a DIFFERENT backend from the one named —
   *      the probe still refuses, and reports our own wait under `wrongBlocker`. That is the half a pid
   *      alone does not cover: our transaction waiting on somebody else's lock is not the ordering either;
   *   4. and naming the real holder of that same wait returns it. Both halves of the filter are therefore
   *      shown to be load-bearing, each with its own positive control.
   */
  await t.test('o3d-4shlo: the probe refuses ANOTHER backend\'s lock wait, even one its old text pattern matched', async () => {
    const { db } = await import('@/lib/db')
    const { default: pg } = await import('pg')
    const tag = `C08Y2-scope-${process.pid}-${Date.now()}`
    const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, availableForSale: false, active: false } })
    const product = await db.product.create({ data: {
      sku: tag, name: `product ${tag}`, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: 1,
      salesPriceTaxInclusive: false, taxCategory: 'STANDARD', stockUnit: 'pcs', oversellAllowed: false, active: false,
    } })
    const contested = await db.costLayer.create({ data: {
      productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 1, unitCostBase: 1,
    } })
    // A SECOND row for step 3, so that our own blocked backend queues behind `holder` ALONE.
    const contestedAlone = await db.costLayer.create({ data: {
      productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 1, unitCostBase: 1,
    } })

    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `${tag}-holder` })
    const waiter = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `${tag}-waiter` })
    const releaseOurBackend = deferred()
    const ourBackend = deferred<number>()
    let pinnedPidAgreed = false
    // A backend of OURS, held open in a transaction that waits on nothing.
    const ourIdleTransaction = db.$transaction(async (tx) => {
      const first = await backendPid(tx)
      const second = await backendPid(tx)
      // Prisma pins one connection per interactive transaction — the premise the fix rests on.
      pinnedPidAgreed = first === second
      ourBackend.resolve(first)
      await releaseOurBackend.promise
    }, TX)

    try {
      await holder.connect()
      await waiter.connect()
      const holderPid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const foreignPid = Number((await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM "cost_layers" WHERE id = ANY($1) FOR UPDATE', [[contested.id, contestedAlone.id]])
      await waiter.query('BEGIN')
      const foreignBlocked = waiter
        .query('SELECT id FROM "cost_layers" WHERE id = $1 FOR UPDATE', [contested.id])
        .catch(() => undefined)

      // PRECONDITION: the foreign wait is really there before the probe is asked anything.
      let foreignWaitVisible = false
      for (let attempt = 0; attempt < 400 && !foreignWaitVisible; attempt++) {
        const rows = await db.$queryRawUnsafe<Array<{ pid: number }>>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
        )
        foreignWaitVisible = rows.some((row) => Number(row.pid) === foreignPid)
        if (!foreignWaitVisible) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(foreignWaitVisible, `PRECONDITION: the foreign backend ${foreignPid} is visibly blocked on a lock`)

      const ourPid = await ourBackend.promise
      assert.ok(pinnedPidAgreed, 'PRECONDITION: pg_backend_pid() is stable inside one interactive transaction')
      assert.ok(
        ourPid !== foreignPid && ourPid !== holderPid,
        `PRECONDITION: the contending backends (${holderPid}, ${foreignPid}) are not ours (${ourPid})`,
      )

      // 1. OUR backend is not waiting on anything, so the foreign wait must NOT satisfy the probe.
      const declined = declinedWaits()
      await assert.rejects(
        () => waitForLockWait({ pid: ourPid, blockedBy: holderPid }, { attempts: 20, declined }),
        /PRECONDITION FAILED: backend \d+ [\s\S]*never blocked on a lock held by backend \d+/,
        'the probe must NOT accept a wait belonging to another backend',
      )
      // Not vacuous: the wait it declined is present, and it is one the OLD text-scoped probe accepted.
      const declinedStatement = declined.foreign.get(foreignPid)
      assert.ok(
        declinedStatement !== undefined,
        `the foreign wait must have been SEEN and declined; declined pids: ${JSON.stringify([...declined.foreign.keys()])}`,
      )
      assert.match(
        declinedStatement, /cost_layers/,
        'and it is a statement the previous text-scoped probe (/cost_layers/) would have returned',
      )
      assert.equal(declined.wrongBlocker.size, 0, 'our own backend was not blocked on anything at all')

      // 2. THE POSITIVE CONTROL — the same probe, asked about the backend that really is waiting and the
      //    backend that really is holding, returns immediately. So step 1 was identity, not a dead rig.
      const control = declinedWaits()
      const controlStatement = await waitForLockWait({ pid: foreignPid, blockedBy: holderPid }, { attempts: 20, declined: control })
      assert.match(controlStatement, /cost_layers/, 'the control finds the wait it is entitled to find')
      console.log(
        `# o3d-4shlo scoping: refused in ${declined.polls} polls, declining `
        + `${declined.foreign.size} foreign wait(s) ${JSON.stringify([...declined.foreign.keys()])}; ours = ${ourPid}. `
        + `Control (pid ${foreignPid} blocked by ${holderPid}) matched in ${control.polls} poll(s).`,
      )

      // 3. OUR backend, genuinely blocked — but NOT by the backend we are about to name.
      //    MEASURED while building this, twice: (a) naming `waiter` does NOT refuse, because Postgres
      //    counts a backend AHEAD OF US IN THE WAIT QUEUE for the same row as a blocker, so
      //    `pg_blocking_pids` legitimately named it; (b) on the contended row it then named the waiter
      //    and not the holder. So this step blocks on `contestedAlone`, which only `holder` holds and
      //    nobody is queued for, and names our own IDLE transaction — which holds no conflicting lock at
      //    all and can never appear in anyone's blocker list.
      const ourBlockedBackend = deferred<number>()
      const ourBlockedTransaction = db.$transaction(async (tx) => {
        ourBlockedBackend.resolve(await backendPid(tx))
        await tx.$queryRawUnsafe('SELECT id FROM "cost_layers" WHERE id = $1 FOR UPDATE', contestedAlone.id)
      }, TX).catch(() => undefined)
      const ourBlockedPid = await ourBlockedBackend.promise
      const wrong = declinedWaits()
      await assert.rejects(
        () => waitForLockWait({ pid: ourBlockedPid, blockedBy: ourPid }, { attempts: 20, declined: wrong }),
        /never blocked on a lock held by backend \d+/,
        'our own backend waiting on somebody ELSE\'s lock is not the ordering either',
      )
      const actualBlockers = wrong.wrongBlocker.get(ourBlockedPid)
      assert.deepEqual(
        actualBlockers, [holderPid],
        `PRECONDITION: our backend ${ourBlockedPid} really was blocked, by ${holderPid} and nobody else — never `
        + `by ${ourPid}: ${JSON.stringify([...wrong.wrongBlocker])}`,
      )

      // 4. THE SECOND POSITIVE CONTROL — the same wait, with its real holder named, is returned.
      const blockerControl = declinedWaits()
      const ourStatement = await waitForLockWait(
        { pid: ourBlockedPid, blockedBy: holderPid }, { attempts: 20, declined: blockerControl },
      )
      assert.match(ourStatement, /cost_layers/, 'the blocker control finds the wait it is entitled to find')
      console.log(
        `# o3d-4shlo blocker scoping: our backend ${ourBlockedPid} blocked by `
        + `${JSON.stringify(actualBlockers)}; naming ${ourPid} refused after ${wrong.polls} polls, naming `
        + `${holderPid} matched in ${blockerControl.polls} poll(s).`,
      )

      await holder.query('ROLLBACK')
      await foreignBlocked
      await ourBlockedTransaction
      await waiter.query('ROLLBACK').catch(() => undefined)
    } finally {
      releaseOurBackend.resolve()
      await ourIdleTransaction.catch(() => undefined)
      await holder.end().catch(() => undefined)
      await waiter.end().catch(() => undefined)
      await db.costLayer.delete({ where: { id: contested.id } }).catch(() => undefined)
      await db.costLayer.delete({ where: { id: contestedAlone.id } }).catch(() => undefined)
      await db.product.delete({ where: { id: product.id } }).catch(() => undefined)
      await db.warehouse.delete({ where: { id: warehouse.id } }).catch(() => undefined)
    }
  })
})
