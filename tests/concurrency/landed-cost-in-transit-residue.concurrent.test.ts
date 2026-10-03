import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  INVENTORY_ACCOUNT, TRANSIT_ACCOUNT, layerUnitCost, loadEnv, netInventoryJournalDelta, netTransitDelta, postJournals,
  recalculate, reclassJournals, reclassSubledger, seedWorld, setJournalPosting, snapshotUnitCost,
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
})
