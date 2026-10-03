import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as realAccountingNs from '@/lib/accounting'
import {
  INVENTORY_ACCOUNT, TRANSIT_ACCOUNT, addProductionOutput, addReplacementLayer, addTransferOut, inTransitLineCount, layerUnitCost, ledgerRowCount,
  loadEnv, netInventoryJournalDelta, netTransitDelta, postJournals, recalculate, reclassJournals, reclassSubledger, revaluationRuns,
  seedWorld, setJournalPosting, snapshotUnitCost,
} from './in-transit-residue-fixtures'

/**
 * o3d-nrl4 PR B — IN-TRANSIT RESIDUE CAPITALISATION, ON A REAL DATABASE.
 *
 * THE DEFECT. A landed-cost revaluation that lands while units are IN TRANSIT had nowhere to post their
 * share: the source layer's remaining quantity is 0 for dispatched units, propagation reaches only layers
 * linked by a cost-layer source line (an in-transit unit has none until it lands), and the transfer
 * snapshot is rewritten to the new cost so the later receipt creates the destination layer at the new cost
 * and no journal follows. The freight bill's debit stayed in Stock in Transit and Inventory stayed
 * understated, in a way no reconciliation sees (the missing posting is absent from both ledgers).
 *
 * THE CONTRACT (D1). Transfers post no GL entry, so in-transit units are still in GL Inventory: their
 * share of a revaluation is DR Inventory / CR Transit AT REVALUATION TIME, the entry on-hand units get. The
 * later receipt or cancellation posts nothing. Each revaluation measures the state at that moment, so a
 * second revaluation, a reversal and a freight cancellation each post their own signed difference.
 *
 * Every arm prints its PRECONDITION. The journals are produced by PRODUCTION code
 * (`queueLandedCostAdjustmentJournals`) against a real database; the only thing a fixture writes is the world.
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
 * THE ONE SEAM IN THIS FILE, OFF unless U10 switches it on. `queueLandedCostAdjustmentJournals` reads the
 * accounting settings once, then opens a transaction per journal. Retiring the connector between the two
 * is the production race a refusal exists for (the enqueue re-asks under the plugin-selection lock), and
 * the only thing this hook decides is WHEN: every refusal, its reason and its owed report are produced by
 * production code.
 */
let retireConnectorAfterSettingsRead = false
mock.module('@/lib/accounting', {
  namedExports: {
    ...realAccountingNs,
    getAccountingSettings: async (...args: Parameters<typeof realAccountingNs.getAccountingSettings>) => {
      const settings = await realAccountingNs.getAccountingSettings(...args)
      if (retireConnectorAfterSettingsRead) {
        retireConnectorAfterSettingsRead = false
        await setJournalPosting(false)
      }
      return settings
    },
  },
})

test('o3d-nrl4 PR B: in-transit residue capitalisation', { skip }, async (t) => {
  loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  await setJournalPosting(true)

  await t.test('U1 (S1): 100 @ 10 all in transit, linked freight 200 before receipt -> DR Inventory / CR Transit 200', async () => {
    const world = await seedWorld('u1')
    const { result } = await recalculate(world)
    const outcome = await postJournals(result)
    const journals = await reclassJournals(world.goodsId)
    const subledger = await reclassSubledger(world.goodsId)
    console.log(`U1 PRECONDITION: in-transit lines = 1, layer remaining = 0, adjustments = ${JSON.stringify(result.inventoryTransitAdjustments.map((a) => a.totalDelta))}, journals = ${journals.length}, owed = ${outcome.owed}`)
    assert.equal(await layerUnitCost(world.layerId), 12, 'the layer was revalued 10 -> 12')
    assert.equal(await snapshotUnitCost(world.transferLineId), 12, 'the in-transit snapshot follows')
    assert.equal(result.inventoryTransitAdjustments.length, 1, 'one inventory/transit adjustment for the order')
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200)
    assert.equal(journals.length, 1, 'exactly one STOCK_IN_TRANSIT journal')
    assert.deepEqual(journals[0]!.debit, [{ accountCode: INVENTORY_ACCOUNT, amount: 200 }], 'DR Inventory 200')
    assert.deepEqual(journals[0]!.credit, [{ accountCode: TRANSIT_ACCOUNT, amount: 200 }], 'CR Transit 200')
    assert.equal(outcome.owed, 0)
    assert.deepEqual(subledger.map((row) => row.baseDelta), [-200], 'the transit subledger leg is -200 (CR Transit)')
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
    assert.equal(await netTransitDelta(world.goodsId), -200, 'the freight bill debit of +200 in Transit is cleared to 0')
    assert.equal(subledger[0]!.key, journals[0]!.key, 'one accounting_sync_logs row and one transit_subledger_movements row share the idempotency key')
  })

  /** The one journal a single revaluation of `world` posts, unpacked: [account, signed amount]. */
  const reclassOf = async (goodsId: string) => (await reclassJournals(goodsId)).map((journal) => ({
    debit: journal.debit, credit: journal.credit,
    amount: Math.abs((journal.debit[0]?.amount ?? 0)),
  }))

  await t.test('U2: partial manual receipt of 40 -> 80 propagated + 120 residue = 200 (ignoring the landed quantity would give 280)', async () => {
    const world = await seedWorld('u2', { qtyReceived: 40, landedLayerQty: 40 })
    const lines = await inTransitLineCount(world.layerId)
    const { result } = await recalculate(world)
    await postJournals(result)
    const run = (await revaluationRuns(world.goodsId))[0]!
    const itemised = (run.afterJson as { inTransitResidue: Array<{ qty: string; delta: string }> }).inTransitResidue
    console.log(`U2 PRECONDITION: in-transit lines = ${lines}, landed layer = ${world.destLayerId ? 'present' : 'MISSING'}, adjustments = ${JSON.stringify(result.inventoryTransitAdjustments.map((a) => a.totalDelta))}, residue items = ${JSON.stringify(itemised)}`)
    assert.equal(lines, 1)
    assert.equal(await layerUnitCost(world.destLayerId!), 12, 'the landed 40 were propagated to their destination layer (80)')
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, '80 propagated + 120 residue')
    assert.equal(itemised.length, 1)
    assert.equal(Number(itemised[0]!.qty), 60, 'only the 60 units that had NOT landed are residue')
    assert.equal(Number(itemised[0]!.delta), 120)
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
  })

  await t.test('U3: an alignment credit of 40 with qtyReceived 0 -> residue 60 (offsetting by qtyReceived alone would give 280)', async () => {
    const world = await seedWorld('u3', { qtyReceived: 0, alignmentCredit: 40, landedLayerQty: 40 })
    const lines = await inTransitLineCount(world.layerId)
    const { result } = await recalculate(world)
    await postJournals(result)
    const run = (await revaluationRuns(world.goodsId))[0]!
    const itemised = (run.afterJson as { inTransitResidue: Array<{ qty: string }> }).inTransitResidue
    console.log(`U3 PRECONDITION: in-transit lines = ${lines}, qtyReceived = 0, alignment credit = 40, residue items = ${JSON.stringify(itemised)}`)
    assert.equal(lines, 1)
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, '80 propagated to the aligned layer + 120 residue')
    assert.equal(Number(itemised[0]!.qty), 60)
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
  })

  await t.test('U4: two sequential revaluations (+2, then +1) while in transit post 200 then 100, and the receipt posts nothing', async () => {
    const { db } = await import('@/lib/db')
    const { receiveTransfer } = await import('@/app/actions/transfers')
    const world = await seedWorld('u4')
    const first = await recalculate(world)
    await postJournals(first.result)
    await db.freightCostLine.update({ where: { id: world.freightCostLineId }, data: { amountForeign: 300, amountBase: 300 } })
    const second = await recalculate(world)
    await postJournals(second.result)
    const journals = await reclassJournals(world.goodsId)
    console.log(`U4 PRECONDITION: in-transit lines = ${await inTransitLineCount(world.layerId)}, journals = ${JSON.stringify(journals.map((j) => j.credit))}`)
    assert.deepEqual(journals.map((j) => j.debit[0]!.amount), [200, 100], 'each revaluation posts its own difference')
    assert.equal(await netInventoryJournalDelta(world.goodsId), 300)
    assert.equal(await snapshotUnitCost(world.transferLineId), 13)

    const before = await ledgerRowCount(world)
    const received = await receiveTransfer(world.transferId)
    assert.equal(received.success, true, `the receipt must succeed: ${received.message}`)
    const after = await ledgerRowCount(world)
    const destination = await db.costLayer.findFirst({ where: { productId: world.productId, warehouseId: world.w2 }, select: { unitCostBase: true, receivedQty: true } })
    console.log(`U4: ledger rows before receipt ${JSON.stringify(before)}, after ${JSON.stringify(after)}; destination layer ${JSON.stringify(destination)}`)
    assert.deepEqual(after, before, 'the receipt posts nothing: no sync log, no subledger row')
    assert.equal(Number(destination!.unitCostBase), 13, 'the destination layer is created at the revalued cost')
    assert.equal(Number(destination!.receivedQty), 100)
    assert.equal(await netInventoryJournalDelta(world.goodsId), 300, 'and Inventory still carries exactly the capitalised 300')
  })

  await t.test('U5: freight cancelled while in transit posts the NEGATIVE share (DR Transit / CR Inventory 200)', async () => {
    const { db } = await import('@/lib/db')
    const world = await seedWorld('u5')
    const first = await recalculate(world)
    await postJournals(first.result)
    await db.purchaseOrder.update({ where: { id: world.freightId }, data: { status: 'CANCELLED' } })
    const second = await recalculate(world, 'freight_purchase_order_cancelled')
    await postJournals(second.result)
    const journals = await reclassJournals(world.goodsId)
    const subledger = await reclassSubledger(world.goodsId)
    console.log(`U5 PRECONDITION: in-transit lines = ${await inTransitLineCount(world.layerId)}, second adjustment = ${JSON.stringify(second.result.inventoryTransitAdjustments.map((a) => a.totalDelta))}, journals = ${journals.length}`)
    assert.equal(journals.length, 2)
    assert.equal(Math.abs(second.result.inventoryTransitAdjustments[0]!.totalDelta), 200, 'the amount is the same size')
    assert.equal(second.result.inventoryTransitAdjustments[0]!.totalDelta < 0, true, 'and it is a DECREASE')
    assert.deepEqual(journals[1]!.debit, [{ accountCode: TRANSIT_ACCOUNT, amount: 200 }], 'DR Transit 200')
    assert.deepEqual(journals[1]!.credit, [{ accountCode: INVENTORY_ACCOUNT, amount: 200 }], 'CR Inventory 200')
    assert.deepEqual(subledger.map((row) => row.baseDelta), [-200, 200])
    assert.equal(await netInventoryJournalDelta(world.goodsId), 0, 'Inventory is back to what it was')
    assert.equal(await netTransitDelta(world.goodsId), 0)
    assert.equal(await layerUnitCost(world.layerId), 10)
    assert.equal(await snapshotUnitCost(world.transferLineId), 10)
  })

  await t.test('U6: a chained transfer — in-transit units of a DESTINATION layer reached by propagation are capitalised via the recursion', async () => {
    const world = await seedWorld('u6', { transferStatus: 'RECEIVED', qtyReceived: 100, landedLayerQty: 100 })
    const { db } = await import('@/lib/db')
    await db.costLayer.update({ where: { id: world.destLayerId! }, data: { remainingQty: 0 } })
    await addTransferOut(world, world.destLayerId!, 100, 10)
    const rootLines = await inTransitLineCount(world.layerId)
    const outputLines = await inTransitLineCount(world.destLayerId!)
    const { result } = await recalculate(world)
    await postJournals(result)
    const run = (await revaluationRuns(world.goodsId))[0]!
    const itemised = (run.afterJson as { inTransitResidue: Array<{ costLayerId: string; qty: string; delta: string }> }).inTransitResidue
    console.log(`U6 PRECONDITION: root in-transit lines = ${rootLines}, output in-transit lines = ${outputLines}, residue items = ${JSON.stringify(itemised)}`)
    assert.equal(rootLines, 0, 'the ROOT layer has nothing in transit: only the output does')
    assert.equal(outputLines, 1)
    assert.equal(await layerUnitCost(world.destLayerId!), 12)
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, 'the recursion posts the output layer\'s in-transit share')
    assert.deepEqual(itemised.map((i) => i.costLayerId), [world.destLayerId])
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
  })

  await t.test('U7: a manufactured OUTPUT in transit — the component freight reaches it through the source line and its residue posts', async () => {
    const world = await seedWorld('u7', { transferQty: 0 })
    const { db } = await import('@/lib/db')
    const { outputLayerId } = await addProductionOutput(world, { consumedQty: 100, outputQty: 50, outputRemaining: 0 })
    await db.costLayer.update({ where: { id: world.layerId }, data: { remainingQty: 0 } })
    await addTransferOut(world, outputLayerId, 50, 20, 'IN_TRANSIT', world.w1, world.w2)
    const outputLines = await inTransitLineCount(outputLayerId)
    const { result } = await recalculate(world)
    await postJournals(result)
    console.log(`U7 PRECONDITION: output in-transit lines = ${outputLines}, adjustments = ${JSON.stringify(result.inventoryTransitAdjustments.map((a) => a.totalDelta))}, cogs = ${JSON.stringify(result.cogsAdjustments.map((a) => a.totalDelta))}`)
    assert.equal(outputLines, 1)
    assert.equal(await layerUnitCost(outputLayerId), 24, 'component +2 x 100 consumed / 50 produced = +4 on the output (20 -> 24)')
    assert.equal(result.cogsAdjustments.length, 0, 'manufacturing-consumed units are not COGS')
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, '50 in-transit output units x +4')
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
  })

  await t.test('U8: a CANCELLED dispatch contributes ZERO residue — its units are in the replacement layer, posted once (200, not 400)', async () => {
    const world = await seedWorld('u8', { transferStatus: 'CANCELLED' })
    const { replacementLayerId } = await addReplacementLayer(world, 100)
    const lines = await inTransitLineCount(world.layerId)
    const { result } = await recalculate(world)
    await postJournals(result)
    const run = (await revaluationRuns(world.goodsId))[0]!
    const itemised = (run.afterJson as { inTransitResidue: unknown[] }).inTransitResidue
    console.log(`U8 PRECONDITION: IN_TRANSIT lines = ${lines} (a CANCELLED transfer's snapshot does name the layer), replacement layer present, adjustments = ${JSON.stringify(result.inventoryTransitAdjustments.map((a) => a.totalDelta))}`)
    assert.equal(lines, 0)
    assert.equal(await layerUnitCost(replacementLayerId), 12)
    assert.equal(result.inventoryTransitAdjustments[0]!.totalDelta, 200, 'posted once, by propagation onto the replacement layer')
    assert.equal(itemised.length, 0)
    assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
  })

  await t.test('U9: the residue is itemised in afterJson (transferLineId, qty, delta), with the run still readable by the audit view', async () => {
    const world = await seedWorld('u9', { qtyReceived: 40, landedLayerQty: 40 })
    const { result } = await recalculate(world)
    const run = (await revaluationRuns(world.goodsId))[0]!
    const itemised = (run.afterJson as { inTransitResidue: Array<Record<string, string>> }).inTransitResidue
    console.log(`U9 PRECONDITION: audit run found, afterJson.inTransitResidue = ${JSON.stringify(itemised)}, journal total = ${result.inventoryTransitAdjustments[0]?.totalDelta}`)
    assert.equal(itemised.length, 1)
    assert.deepEqual(
      { transferLineId: itemised[0]!.transferLineId, qty: Number(itemised[0]!.qty), delta: Number(itemised[0]!.delta), unitDelta: Number(itemised[0]!.unitDelta), costLayerId: itemised[0]!.costLayerId },
      { transferLineId: world.transferLineId, qty: 60, delta: 120, unitDelta: 2, costLayerId: world.layerId },
    )
    // The itemisation substantiates the journal: residue 120 + the propagated landed share 80 = the 200 posted.
    const propagated = (run.afterJson as { propagatedOutputLayers: Array<{ inventoryDelta: string }> }).propagatedOutputLayers
    assert.equal(Number(itemised[0]!.delta) + propagated.reduce((sum, p) => sum + Number(p.inventoryDelta), 0), result.inventoryTransitAdjustments[0]!.totalDelta)
  })

  await t.test('U10: connector retired between the settings read and the enqueue -> owed is REPORTED, the outbox row still holds the 200, and re-running it posts it once', async () => {
    const { db } = await import('@/lib/db')
    const { LandedCostJournalOutboxPayloadSchema } = await import('@/lib/domain/integrations/outbox-registry')
    const { landedCostOutboxPayloadToRecalcResult } = await import('@/lib/domain/purchasing/landed-cost-journal-outbox')
    const world = await seedWorld('u10')
    try {
      const { result } = await recalculate(world)
      retireConnectorAfterSettingsRead = true
      const outcome = await postJournals(result)
      retireConnectorAfterSettingsRead = false
      const journalsWhileRetired = await reclassJournals(world.goodsId)
      const outbox = await db.integrationOutbox.findMany({
        where: { connector: 'accounting', operation: 'landed-cost.adjustment-journal', payloadJson: { path: ['inventoryTransitAdjustments', '0', 'primaryPoId'], equals: world.goodsId } },
        select: { payloadJson: true, status: true },
      })
      console.log(`U10 PRECONDITION: owed = ${outcome.owed}, journals while retired = ${journalsWhileRetired.length}, outbox rows = ${outbox.length}`)
      assert.equal(outcome.owed, 1, 'the refused residue journal is REPORTED as owed (so the drain retries instead of marking the job done)')
      assert.equal(journalsWhileRetired.length, 0, 'nothing was queued')
      assert.equal(await ledgerRowCount(world).then((r) => r.subledger), 0, 'and no subledger row claims it was')
      assert.equal(outbox.length, 1, 'the durable outbox row exists')
      const payload = LandedCostJournalOutboxPayloadSchema.parse(outbox[0]!.payloadJson)
      assert.equal(payload.inventoryTransitAdjustments[0]!.totalDelta, 200, 'and it still holds the whole residue')
      // The drain re-runs the stored payload once the connector is back: the posting is recovered, once.
      await setJournalPosting(true)
      const replay = await postJournals(landedCostOutboxPayloadToRecalcResult(payload))
      const replayAgain = await postJournals(landedCostOutboxPayloadToRecalcResult(payload))
      assert.equal(replay.owed, 0)
      assert.equal(replayAgain.owed, 0)
      assert.equal((await reclassJournals(world.goodsId)).length, 1, 'recovered exactly once (idempotent on its key)')
      assert.equal(await netInventoryJournalDelta(world.goodsId), 200)
    } finally {
      retireConnectorAfterSettingsRead = false
      await setJournalPosting(true)
    }
  })

})
