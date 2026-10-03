import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import * as realRecreationNs from '@/lib/domain/inventory/transfer-cost-layer-recreation'
import {
  TX_OPTIONS, deferred, imsValue, inTransitLineCount, ledgerRowCount, loadEnv, lockAndRecalculate, netInventoryJournalDelta, postJournals,
  rawSession, recalculate, seedWorld, setJournalPosting, txPid, waitForBlocked, type World,
} from './in-transit-residue-fixtures'

/**
 * o3d-nrl4 PR B — THE IN-TRANSIT RESIDUE AGAINST THE WRITERS THAT LAND OR CANCEL THE UNITS, ON REAL LOCKS.
 *
 * THE INVARIANT, in every arm: the GL delta the revaluation posts equals the change in IMS value
 * (Σ remaining x cost over the layers + the snapshot value of the units still on a truck). Never both
 * posted (a unit landing at the old snapshot while the revaluation also posts its residue leaves the GL
 * ABOVE IMS), never neither (the original defect: GL BELOW IMS, invisibly).
 *
 * Landing a unit moves it from "on a truck" to "on a layer" and posts nothing, so the IMS value does not
 * change when it lands: only the revaluation changes it, by exactly the cost uplift on every unit.
 *
 *   C1  a receipt holds the transfer and is PARKED after it created the destination layer; the recalculation
 *       starts behind it. The receipt commits; the recalculation (which had planned its scope before the
 *       receipt landed) finds the new LAYER, which joins the scope (layers are step 6, still ahead), measures
 *       the committed state (a RECEIVED transfer: no residue, propagation carries it) and posts once.
 *   C2  the recalculation holds the scope and is PARKED before its commit; a receipt starts behind it. The
 *       recalculation commits; the receipt then reads the REVALUED snapshot, so the destination layer is at
 *       the new cost and the receipt posts nothing extra.
 *   C3  an alignment-shaped writer (transfer lock, destination layer, source line, ASN credit) is parked; the
 *       recalculation queues behind it and measures the residue PAST THE CREDIT.
 *   C4  a real `cancelDispatchedTransfer` is parked after it laid the replacement layer; same shape as C1, and
 *       the CANCELLED dispatch contributes no residue.
 *
 * NOTHING ORDERS ANYTHING BY A WALL-CLOCK SLEEP: a lock another session holds orders it, and the "now
 * blocked" fact is read from pg_stat_activity with both ends named, under a failing deadline.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

/**
 * THE ONE SEAM: park a landing path AFTER it created its layers and BEFORE it commits, holding the transfer
 * lock. The hook decides only WHEN; the layers and rows are written by production code.
 */
let parkAfterRecreation: { reached: (pid: number) => void; gate: Promise<void> } | null = null
mock.module('@/lib/domain/inventory/transfer-cost-layer-recreation', {
  namedExports: {
    ...realRecreationNs,
    recreateTransferCostLayersFromSnapshotSlice: async (
      ...args: Parameters<typeof realRecreationNs.recreateTransferCostLayersFromSnapshotSlice>
    ) => {
      const answer = await realRecreationNs.recreateTransferCostLayersFromSnapshotSlice(...args)
      const park = parkAfterRecreation
      if (park) {
        parkAfterRecreation = null
        park.reached(await txPid(args[0]))
        await park.gate
      }
      return answer
    },
  },
})

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }))

/** GL delta from ALL journals for the order vs the IMS value change since `valueBefore`. */
async function assertInvariant(world: World, valueBefore: number, expectedUplift: number, label: string) {
  const valueAfter = await imsValue(world)
  const gl = await netInventoryJournalDelta(world.goodsId)
  console.log(`${label} INVARIANT: IMS value ${valueBefore} -> ${valueAfter} (change ${valueAfter - valueBefore}); GL Inventory delta from the revaluation = ${gl}`)
  assert.equal(valueAfter - valueBefore, expectedUplift, 'precondition: the IMS value moved by the cost uplift on every unit')
  assert.equal(gl, valueAfter - valueBefore, 'GL delta equals the change in IMS value: never both posted, never neither')
}

test('o3d-nrl4 PR B: the in-transit residue against landing and cancelling writers', { skip }, async (t) => {
  const databaseUrl = loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  await setJournalPosting(true)
  const { db } = await import('@/lib/db')

  await t.test('C1: receipt first (parked after laying the layer), recalculation parked behind it: it measures the committed state and posts once', async () => {
    const { receiveTransfer } = await import('@/app/actions/transfers')
    const world = await seedWorld('c1')
    const valueBefore = await imsValue(world)
    const reached = deferred<number>()
    const gate = deferred()
    parkAfterRecreation = { reached: reached.resolve, gate: gate.promise }
    const probe = await rawSession(databaseUrl)
    try {
      let receiptDone = false
      const receipt = settle(receiveTransfer(world.transferId)).then((o) => { receiptDone = true; return o })
      const receiptPid = await reached.promise
      let recalcDone = false
      const recalc = settle(recalculate(world)).then((o) => { recalcDone = true; return o })
      const blocked = await waitForBlocked(probe, { blockedBy: receiptPid, waitingOn: /stock_transfers/i, describe: 'C1', finished: () => recalcDone })
      console.log(`C1 PRECONDITION: receipt parked on pid ${receiptPid} (receipt finished = ${receiptDone}); recalculation pid ${blocked.pid} blocked on [${blocked.query.slice(0, 60)}]; in-transit lines now = ${await inTransitLineCount(world.layerId)}`)
      gate.resolve()
      const receiptOutcome = await receipt
      assert.equal(receiptOutcome.ok && receiptOutcome.value.success, true, 'the receipt committed')
      const first = await recalc
      // The destination layer the receipt laid is a NEW LAYER, which joins the scope (layers are step 6, still ahead of
      // the locks the recalculation holds); only a new transfer or order is refused. So it measures the committed state.
      assert.equal(first.ok, true, `the recalculation proceeds on the committed state: ${first.ok ? '' : String((first as { error: unknown }).error)}`)
      const result = (first as { value: { result: Awaited<ReturnType<typeof recalculate>>['result'] } }).value.result
      assert.deepEqual(await ledgerRowCount(world), { syncLogs: 0, subledger: 0 }, 'the receipt itself posted nothing')
      assert.equal(await inTransitLineCount(world.layerId), 0, 'nothing is in transit any more: the residue is zero (a RECEIVED transfer contributes none)')
      await postJournals(result)
      assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, 'the whole 200 reaches the destination layer by propagation, once')
      assert.equal((await db.costLayer.findFirstOrThrow({ where: { productId: world.productId, warehouseId: world.w2 }, select: { unitCostBase: true } })).unitCostBase.toString(), '12')
      await assertInvariant(world, valueBefore, 200, 'C1')
    } finally {
      parkAfterRecreation = null
      gate.resolve()
      await probe.end()
    }
  })

  await t.test('C2: recalculation first (parked before commit), receipt parked behind it: the destination layer is at the NEW cost and nothing extra posts', async () => {
    const { receiveTransfer } = await import('@/app/actions/transfers')
    const world = await seedWorld('c2')
    const valueBefore = await imsValue(world)
    const reached = deferred<number>()
    const gate = deferred()
    const probe = await rawSession(databaseUrl)
    try {
      const recalc = settle(db.$transaction(async (tx) => {
        const out = await lockAndRecalculate(tx, world.freightId)
        reached.resolve(await txPid(tx))
        await gate.promise
        return out
      }, TX_OPTIONS))
      const recalcPid = await reached.promise
      let receiptDone = false
      const receipt = settle(receiveTransfer(world.transferId)).then((o) => { receiptDone = true; return o })
      const blocked = await waitForBlocked(probe, { blockedBy: recalcPid, waitingOn: /stock_transfers/i, describe: 'C2', finished: () => receiptDone })
      console.log(`C2 PRECONDITION: recalculation parked on pid ${recalcPid} with residue computed; receipt pid ${blocked.pid} blocked on [${blocked.query.slice(0, 60)}]; in-transit lines = ${await inTransitLineCount(world.layerId)}`)
      gate.resolve()
      const recalcOutcome = await recalc
      assert.equal(recalcOutcome.ok, true, `the recalculation commits: ${recalcOutcome.ok ? '' : String((recalcOutcome as { error: unknown }).error)}`)
      const receiptOutcome = await receipt
      assert.equal(receiptOutcome.ok && receiptOutcome.value.success, true, 'the receipt then proceeds')
      const before = await ledgerRowCount(world)
      const destination = await db.costLayer.findFirst({ where: { productId: world.productId, warehouseId: world.w2 }, select: { unitCostBase: true, receivedQty: true } })
      assert.equal(Number(destination!.unitCostBase), 12, 'the receipt costed the destination layer from the REVALUED snapshot')
      assert.deepEqual(before, { syncLogs: 0, subledger: 0 }, 'the receipt posted nothing; the recalculation has not posted its journal yet')
      await postJournals((recalcOutcome as { value: { result: unknown } }).value.result)
      await assertInvariant(world, valueBefore, 200, 'C2')
    } finally {
      gate.resolve()
      await probe.end()
    }
  })

  await t.test('C3: an alignment-shaped writer (transfer, destination layer, source line, ASN credit 40) parked; the recalculation queues behind it and measures the residue past the credit', async () => {
    const world = await seedWorld('c3')
    const valueBefore = await imsValue(world)
    const reached = deferred<number>()
    const gate = deferred()
    const probe = await rawSession(databaseUrl)
    try {
      const writer = settle(db.$transaction(async (tx) => {
        // The alignment's own order: the transfer first ...
        await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${world.transferId} FOR UPDATE`
        // ... then what it lands: a destination layer for 40 units, linked, and the credit on the ASN line
        // (stock_transfer_lines.qtyReceived is deliberately NOT touched: that is the alignment's shape).
        const dest = await tx.costLayer.create({
          data: { productId: world.productId, warehouseId: world.w2, receivedQty: 40, remainingQty: 40, unitCostBase: world.unitCost },
          select: { id: true },
        })
        await tx.costLayerSourceLine.create({
          data: { costLayerId: dest.id, sourceProductId: world.productId, sourceCostLayerId: world.layerId, qty: 40, unitCostBase: world.unitCost, totalCostBase: 40 * world.unitCost },
        })
        await tx.wmsAsnMap.create({
          data: {
            connector: 'mintsoft', // wms-connector-boundary-ok: o3d-nrl4 PR B: a test fixture row, not a core flow branch
            externalAsnId: `${world.tag}-${randomUUID()}`, sourceType: 'STOCK_TRANSFER', sourceId: world.transferId, warehouseId: world.w2, status: 'OPEN',
            lines: {
              create: [{
                externalAsnLineId: `${world.tag}-1`, sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: world.transferLineId,
                productId: world.productId, sku: world.tag, expectedQty: '100.0000', qtyAccountedViaSnapshot: '40.0000', qtyAccountedViaReceipt: '0.0000',
              }],
            },
          },
        })
        reached.resolve(await txPid(tx))
        await gate.promise
      }, TX_OPTIONS))
      const writerPid = await reached.promise
      let recalcDone = false
      const recalc = settle(recalculate(world)).then((o) => { recalcDone = true; return o })
      const blocked = await waitForBlocked(probe, { blockedBy: writerPid, waitingOn: /stock_transfers/i, describe: 'C3', finished: () => recalcDone })
      console.log(`C3 PRECONDITION: alignment-shaped writer parked on pid ${writerPid}; recalculation pid ${blocked.pid} blocked on [${blocked.query.slice(0, 60)}]; qtyReceived stays 0`)
      gate.resolve()
      assert.equal((await writer).ok, true)
      const first = await recalc
      assert.equal(first.ok, true, `the recalculation proceeds on the committed state: ${first.ok ? '' : String((first as { error: unknown }).error)}`)
      const retry = { result: (first as { value: { result: Awaited<ReturnType<typeof recalculate>>['result'] } }).value.result }
      assert.deepEqual(await ledgerRowCount(world), { syncLogs: 0, subledger: 0 }, 'the alignment itself posted nothing')
      await postJournals(retry.result)
      const run = await db.landedCostRevaluationRun.findFirstOrThrow({ where: { primaryPoId: world.goodsId }, orderBy: { createdAt: 'desc' }, select: { afterJson: true } })
      const itemised = (run.afterJson as { inTransitResidue: Array<{ qty: string; delta: string }> }).inTransitResidue
      console.log(`C3: residue items = ${JSON.stringify(itemised)}`)
      assert.equal(Number(itemised[0]!.qty), 60, 'the 40 credited units are LANDED, whatever qtyReceived says')
      assert.equal(retry.result.inventoryTransitAdjustments[0]!.totalDelta, 200, '80 propagated to the aligned layer + 120 residue')
      await assertInvariant(world, valueBefore, 200, 'C3')
    } finally {
      gate.resolve()
      await probe.end()
    }
  })

  await t.test('C4: a REAL cancelDispatchedTransfer (parked after laying the replacement layer), recalculation behind it: the CANCELLED dispatch contributes no residue and posts once', async () => {
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')
    const world = await seedWorld('c4')
    const valueBefore = await imsValue(world)
    const reached = deferred<number>()
    const gate = deferred()
    parkAfterRecreation = { reached: reached.resolve, gate: gate.promise }
    const probe = await rawSession(databaseUrl)
    try {
      const cancel = settle(cancelDispatchedTransfer(world.transferId))
      const cancelPid = await reached.promise
      let recalcDone = false
      const recalc = settle(recalculate(world)).then((o) => { recalcDone = true; return o })
      const blocked = await waitForBlocked(probe, { blockedBy: cancelPid, waitingOn: /stock_transfers/i, describe: 'C4', finished: () => recalcDone })
      console.log(`C4 PRECONDITION: cancellation parked on pid ${cancelPid}; recalculation pid ${blocked.pid} blocked on [${blocked.query.slice(0, 60)}]`)
      gate.resolve()
      const cancelOutcome = await cancel
      assert.equal(cancelOutcome.ok && cancelOutcome.value.success, true, `the cancellation committed: ${JSON.stringify(cancelOutcome)}`)
      const first = await recalc
      assert.equal(first.ok, true, `the recalculation proceeds on the committed state: ${first.ok ? '' : String((first as { error: unknown }).error)}`)
      const retry = { result: (first as { value: { result: Awaited<ReturnType<typeof recalculate>>['result'] } }).value.result }
      assert.deepEqual(await ledgerRowCount(world), { syncLogs: 0, subledger: 0 }, 'the cancellation itself posted nothing')
      await postJournals(retry.result)
      assert.equal(await inTransitLineCount(world.layerId), 0, 'the cancelled dispatch is not in transit: residue zero')
      assert.equal(retry.result.inventoryTransitAdjustments[0]!.totalDelta, 200, 'posted once, onto the replacement layer, not twice')
      await assertInvariant(world, valueBefore, 200, 'C4')
    } finally {
      parkAfterRecreation = null
      gate.resolve()
      await probe.end()
    }
  })
})
