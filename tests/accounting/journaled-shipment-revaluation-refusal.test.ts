import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShipmentCogsRevaluationSyncPayload,
  JournaledShipmentRevaluationRefusedError,
  refreshShipmentCogsForCostLayerChange,
  type JournaledShipmentRevaluationRefusal,
} from '@/lib/cost-layers'

/**
 * o3d-c08y — A LANDED-COST REVALUATION MAY NOT TAKE AN ALREADY-JOURNALED SHIPMENT BELOW ZERO.
 *
 * THE DEFECT (observed on a scratch database, SCEN=J): one unit bought at 4.00, shipped and journaled;
 * a freight credit of -10.00 revalues the layer to -6.00. The shipment's revaluation journal gates
 * each leg on its own side being positive, so the 4.00 reversal posted and the -6.00 repost was
 * DROPPED — while `refreshShipmentCogsForCostLayerChange` still reported the whole -10.00 as
 * shipment-owned, and the recalc subtracted it from its own COGS journal. 6.00 posted nowhere, the
 * COGS subledger recorded -10.00, and nothing said so.
 *
 * THE FIX REFUSES, since a negative basis is not represented (o3d-gd2f): report on a connection of
 * its own, abort the enclosing transaction, throw — before this function writes anything. The
 * real-database proof that the abort rolls the whole revaluation back is
 * tests/concurrency/journaled-shipment-revaluation-refusal.concurrent.test.ts.
 */

type ShipmentRow = { id: string; cogsBatchAmount: string; journaled: boolean; unitCostBase: string }

function doubleTx(shipments: ShipmentRow[]) {
  const updates: unknown[] = []
  const queued: unknown[] = []
  const rawStatements: string[] = []
  const tx = {
    $queryRawUnsafe: async () => shipments.map((shipment) => ({ id: shipment.id })),
    // The abort statement is REQUIRED to fail, as it does on Postgres.
    $executeRaw: async (strings: TemplateStringsArray) => {
      rawStatements.push(strings.join('?'))
      throw new Error('invalid input syntax for type integer')
    },
    shipment: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = shipments.find((shipment) => shipment.id === where.id)!
        return {
          cogsBatchAmount: row.cogsBatchAmount,
          shipmentJournalDate: row.journaled ? new Date('2026-01-02T00:00:00.000Z') : null,
          order: { id: `order-${row.id}`, accountingInvoiceId: 'INV-1' },
        }
      },
      update: async (args: unknown) => { updates.push(args) },
    },
    shipmentLine: {
      findMany: async ({ where }: { where: { shipmentId: string } }) => {
        const row = shipments.find((shipment) => shipment.id === where.shipmentId)!
        return [{ costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '1.000000', unitCostBase: row.unitCostBase }] }]
      },
    },
    cogsSubledgerMovement: { upsert: async ({ create }: { create: unknown }) => create },
  }
  return { tx, updates, queued, rawStatements }
}

function options(queued: unknown[], logged: JournaledShipmentRevaluationRefusal[]) {
  return {
    accountingSettings: { inventoryAccount: '630', cogsAccount: '500' },
    isReversalPostingEnabled: async () => true,
    isDailyBatchPostingEnabled: async () => true,
    queueAccountingSync: async (_tx: unknown, params: unknown) => { queued.push(params); return true },
    logRefusal: async (refusal: JournaledShipmentRevaluationRefusal) => { logged.push(refusal); return true },
    revaluationContext: {
      source: 'landed_cost_recalc' as const,
      primaryPoReference: 'PO-1',
      freightPoId: 'fpo-1',
      creditCostLines: [{ freightCostLineId: 'fcl-1', purchaseOrderId: 'fpo-1', purchaseOrderReference: 'PO-F-1', amountBase: '-10.00' }],
    },
  }
}

test('SCEN=J: a journaled shipment revalued from 4.00 to -6.00 is REFUSED — no reversal, no COGS change, an ERROR naming the credit line', async () => {
  const { tx, updates, queued, rawStatements } = doubleTx([
    { id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []

  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, logged)),
    (error: unknown) => {
      assert.ok(error instanceof JournaledShipmentRevaluationRefusedError, `wrong error: ${String(error)}`)
      assert.deepEqual(error.shipments, [{ shipmentId: 'ship-J', oldCogsBase: '4.00', newCogsBase: '-6.00' }])
      assert.equal(error.costLayerId, 'layer-1')
      assert.equal(error.loggedToActivity, true)
      return true
    },
  )

  assert.deepEqual(queued, [], 'a COGS_REVERSAL was queued: the half-reversal is back')
  assert.deepEqual(updates, [], 'the shipment COGS was rewritten before the refusal')
  assert.equal(rawStatements.length, 1, 'the enclosing transaction was not aborted')
  assert.equal(logged.length, 1)
  assert.match(logged[0].message, /ship-J \(COGS 4\.00 -> -6\.00\)/)
  assert.match(logged[0].message, /line fcl-1 on PO-F-1 \(-10\.00\)/, 'the refusal does not name the credit line to correct')
  assert.match(logged[0].message, /NOTHING WAS CHANGED/)
})

test('the pre-pass refuses BEFORE any shipment is written, even when the negative one is not first', async () => {
  const { tx, updates, queued } = doubleTx([
    { id: 'ship-ok', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '3.000000' },
    { id: 'ship-neg', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, logged)),
    JournaledShipmentRevaluationRefusedError,
  )
  assert.deepEqual(updates, [], 'the first shipment was written before the second was refused')
  assert.deepEqual(queued, [])
})

test('a journaled shipment whose OLD COGS is already negative is refused too — its reversal leg would be dropped the same way', async () => {
  const { tx, queued } = doubleTx([
    { id: 'ship-legacy', cogsBatchAmount: '-2.00', journaled: true, unitCostBase: '3.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, logged)),
    JournaledShipmentRevaluationRefusedError,
  )
  assert.deepEqual(queued, [])
})

test('POSITIVE CONTROL: the same journaled shipment revalued to a positive basis posts both legs, and is not refused', async () => {
  const { tx, updates, queued, rawStatements } = doubleTx([
    { id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '2.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, logged))
  assert.equal(result.cogsRevaluationDelta.toString(), '-2')
  assert.equal(queued.length, 1)
  const lines = (queued[0] as { payload: { lines: Array<{ debit?: number; credit?: number }> } }).payload.lines
  assert.equal(lines.length, 4, 'both the reversal and the repost are posted')
  assert.equal(updates.length, 1)
  assert.deepEqual(logged, [])
  assert.deepEqual(rawStatements, [])
})

test('an UN-journaled shipment driven negative is NOT refused here — the daily batch refuses its Group B basis (o3d-sidy)', async () => {
  const { tx, updates, queued } = doubleTx([
    { id: 'ship-open', cogsBatchAmount: '4.00', journaled: false, unitCostBase: '-6.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, logged))
  assert.equal(result.shipmentsUpdated, 1)
  assert.deepEqual(queued, [])
  assert.deepEqual(updates, [{ where: { id: 'ship-open' }, data: { cogsBatchAmount: -6 } }])
  assert.deepEqual(logged, [])
})

test('the refusal is thrown even when the ERROR entry cannot be written, and says so', async () => {
  const { tx, queued } = doubleTx([
    { id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' },
  ])
  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
      ...options(queued, []),
      logRefusal: async () => { throw new Error('activity log down') },
    }),
    (error: unknown) => error instanceof JournaledShipmentRevaluationRefusedError && error.loggedToActivity === false,
  )
})

test('BACKSTOP: the revaluation journal builder refuses a negative side instead of dropping its legs', () => {
  for (const [oldCogsBase, newCogsBase] of [['4.00', '-6.00'], ['-2.00', '3.00'], ['-2.00', '-6.00']]) {
    assert.throws(
      () => buildShipmentCogsRevaluationSyncPayload({
        shipmentId: 'ship-J', costLayerId: 'layer-1', inventoryAccount: '630', cogsAccount: '500', oldCogsBase, newCogsBase,
      }),
      /o3d-c08y/,
      `${oldCogsBase} -> ${newCogsBase} built a journal`,
    )
  }
  // Zero is still a legitimate side (scjz.35): only its legs are dropped.
  assert.ok(buildShipmentCogsRevaluationSyncPayload({
    shipmentId: 'ship-J', costLayerId: 'layer-1', inventoryAccount: '630', cogsAccount: '500', oldCogsBase: '4.00', newCogsBase: '0.00',
  }))
})
