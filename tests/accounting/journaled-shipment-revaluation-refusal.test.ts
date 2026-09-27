import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShipmentCogsRevaluationSyncPayload,
  JournaledShipmentRevaluationContextError,
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

function doubleTx(shipments: ShipmentRow[], over: { savepointProbe?: 'accepts' | 'rejects-25P01' | 'absent' } = {}) {
  const updates: unknown[] = []
  const queued: unknown[] = []
  const rawStatements: string[] = []
  const probeStatements: string[] = []
  const reads: string[] = []
  const tx = {
    $queryRawUnsafe: async (sql: string) => {
      reads.push(sql)
      return shipments.map((shipment) => ({ id: shipment.id }))
    },
    // o3d-c08y r2: the entry precondition asks Postgres whether this client is inside a transaction by
    // ATTEMPTING a savepoint. A real transaction client accepts it; an autocommit one raises 25P01.
    ...(over.savepointProbe === 'absent' ? {} : {
      $executeRawUnsafe: async (sql: string) => {
        probeStatements.push(sql)
        if (over.savepointProbe === 'rejects-25P01' && sql.startsWith('SAVEPOINT')) {
          throw new Error('ERROR: 25P01: there is no transaction in progress')
        }
        return 0
      },
    }),
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
  return { tx, updates, queued, rawStatements, probeStatements, reads }
}

function options(queued: unknown[], logged: JournaledShipmentRevaluationRefusal[]) {
  return {
    // o3d-j625 r12 (merge): `connector` is REQUIRED on an injected chart (o3d-j625 r2, Codex HIGH 1) — an
    // injected chart that does not say whose it is cannot be routed, and an optional field here would let
    // the enqueue resolve the connector for itself, which is the defect that requirement closes.
    accountingSettings: { connector: 'xero' as const, inventoryAccount: '630', cogsAccount: '500' },
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

// ---------------------------------------------------------------------------
// o3d-c08y ROUND 2: THE ENTRY PRECONDITION.
//
// The refusal above works by poisoning the enclosing transaction. Round 1's comments said it used
// "the same mechanism as the transfer re-layering refusal", but it did not check the two client
// properties that make that mechanism inert — and where the transfer refusal THROWS on a client with
// no raw access, this one SKIPPED the abort and threw a refusal a caller could swallow while still
// committing a negative cost layer. These check the precondition itself, and that it is checked BEFORE
// anything is read.
// ---------------------------------------------------------------------------

test('o3d-c08y r2: a client with NO raw access is refused at entry, before anything is read', async () => {
  const { tx, reads, updates, queued } = doubleTx(
    [{ id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' }],
    { savepointProbe: 'absent' },
  )
  // Also drop $executeRaw: with neither, there is nothing to abort with at all.
  delete (tx as { $executeRaw?: unknown }).$executeRaw

  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, [])),
    (error: unknown) => {
      assert.ok(error instanceof JournaledShipmentRevaluationContextError, `wrong error: ${String(error)}`)
      assert.equal(error.reason, 'no_raw_access')
      assert.match(error.message, /layer-1/)
      return true
    },
  )
  assert.deepEqual(reads, [], 'it refused before reading any shipment — the precondition is at ENTRY')
  assert.deepEqual(updates, [])
  assert.deepEqual(queued, [])
})

test('o3d-c08y r2: an AUTOCOMMIT client is refused at entry — its caller\'s layer write is already committed', async () => {
  const { tx, reads, probeStatements, queued } = doubleTx(
    // A POSITIVE revaluation: the refusal path is never reached, and it is still refused. The check is
    // unconditional on purpose — a call site that cannot be refused effectively is a defect whether or
    // not this particular revaluation happens to go negative.
    [{ id: 'ship-ok', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '9.000000' }],
    { savepointProbe: 'rejects-25P01' },
  )

  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, [])),
    (error: unknown) => {
      assert.ok(error instanceof JournaledShipmentRevaluationContextError, `wrong error: ${String(error)}`)
      assert.equal(error.reason, 'not_in_transaction')
      return true
    },
  )
  assert.ok(
    probeStatements.some((statement) => statement.startsWith('SAVEPOINT')),
    `PRECONDITION: the transaction probe was actually issued: ${JSON.stringify(probeStatements)}`,
  )
  assert.deepEqual(reads, [], 'and nothing was read')
  assert.deepEqual(queued, [])
})

test('o3d-c08y r2: an OPEN SAVEPOINT is refused — rolling back to it would clear the abort', async () => {
  const { withSavepoint } = await import('@/lib/db/savepoint')
  const { tx, reads, queued } = doubleTx([
    { id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' },
  ])

  await withSavepoint(tx, async () => {
    await assert.rejects(
      () => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, [])),
      (error: unknown) => {
        assert.ok(error instanceof JournaledShipmentRevaluationContextError, `wrong error: ${String(error)}`)
        assert.equal(error.reason, 'open_savepoint')
        assert.match(error.message, /1 savepoint is open/)
        return true
      },
    )
  })
  assert.deepEqual(reads, [], 'and nothing was read')
  assert.deepEqual(queued, [])
})

test('o3d-c08y r2: POSITIVE CONTROL — the same client OUTSIDE a savepoint revalues normally', async () => {
  // Without this, the three refusals above are indistinguishable from a function that now refuses
  // everything.
  const { tx, updates, queued, probeStatements } = doubleTx([
    { id: 'ship-ok', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '9.000000' },
  ])
  const result = await refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', options(queued, []))

  assert.equal(result.shipmentsUpdated, 1)
  assert.deepEqual(updates, [{ where: { id: 'ship-ok' }, data: { cogsBatchAmount: 9 } }])
  assert.equal(queued.length, 1, 'and the revaluation posted as before')
  assert.ok(probeStatements.some((statement) => statement.startsWith('SAVEPOINT')), 'the probe ran and accepted')
})

test('o3d-c08y r2: the refusal itself will not fall back to a SKIP when the abort cannot be issued', async () => {
  // The second lock on the same door: the entry precondition refuses a raw-less client, and if one ever
  // reached the refusal anyway it must not quietly skip the abort — which is what round 1 did.
  const { tx, queued } = doubleTx([
    { id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' },
  ])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  // Pass the precondition, then take $executeRaw away between the probe and the refusal.
  const guarded = {
    ...tx,
    shipmentLine: {
      findMany: async (args: { where: { shipmentId: string } }) => {
        delete (guarded as { $executeRaw?: unknown }).$executeRaw
        return tx.shipmentLine.findMany(args)
      },
    },
  }

  await assert.rejects(
    () => refreshShipmentCogsForCostLayerChange(guarded as never, 'layer-1', options(queued, logged)),
    (error: unknown) => {
      assert.ok(error instanceof JournaledShipmentRevaluationContextError, `wrong error: ${String(error)}`)
      assert.equal(error.reason, 'no_raw_access')
      assert.match(error.message, /REFUSED/, 'and it still reports the refusal it was making')
      return true
    },
  )
  assert.equal(logged.length, 1, 'the ERROR entry is still written — the operator still learns of the credit line')
})

// ---------------------------------------------------------------------------
// o3d-c08y ROUND 2: THE REMEDY MUST NAME AN ACTION THE OPERATOR CAN ACTUALLY TAKE.
// Round 1 said "save again" for every operation that can reach the refusal.
// ---------------------------------------------------------------------------

async function refusalMessageFor(context: Record<string, unknown>): Promise<string> {
  const { tx, queued } = doubleTx([{ id: 'ship-J', cogsBatchAmount: '4.00', journaled: true, unitCostBase: '-6.000000' }])
  const logged: JournaledShipmentRevaluationRefusal[] = []
  await assert.rejects(() => refreshShipmentCogsForCostLayerChange(tx as never, 'layer-1', {
    ...options(queued, logged),
    revaluationContext: context as never,
  }))
  assert.equal(logged.length, 1, 'PRECONDITION: the refusal was reached and reported')
  return logged[0].message
}

test('o3d-c08y r2: a SAVE is told to correct the credit line and save again', async () => {
  const message = await refusalMessageFor({
    source: 'landed_cost_recalc', operation: 'save', primaryPoReference: 'PO-1', freightPoId: 'fpo-1',
    creditCostLines: [{ freightCostLineId: 'fcl-1', purchaseOrderId: 'fpo-1', purchaseOrderReference: 'PO-F-1', amountBase: '-10.00' }],
  })
  assert.match(message, /line fcl-1 on PO-F-1 \(-10\.00\)/, 'naming the credit line')
  assert.match(message, /and save again\./)
})

test('o3d-c08y r2: a freight-PO CANCELLATION is not told to "save again" — it is told to cancel again once the credit elsewhere is corrected', async () => {
  // The cancelled PO is excluded from the recalc, so the credit named here is on ANOTHER document and
  // there is no save of this one to repeat.
  const message = await refusalMessageFor({
    source: 'landed_cost_recalc', operation: 'cancel_freight_po', primaryPoReference: 'PO-1', freightPoId: 'fpo-cancel',
    creditCostLines: [{ freightCostLineId: 'fcl-other', purchaseOrderId: 'fpo-2', purchaseOrderReference: 'PO-F-2', amountBase: '-10.00' }],
  })
  assert.match(message, /This CANCELLATION is refused/)
  assert.match(message, /cancel this freight PO again/)
  assert.match(message, /line fcl-other on PO-F-2/, 'and names the credit that is still there')
  assert.doesNotMatch(message, /save again/, 'there is no save of a cancellation to repeat')
})

test('o3d-c08y r2: a PRODUCTION-ORDER recompute is pointed at the component purchase order, not at a freight line of its own', async () => {
  // Manufacturing rejects negative cost lines, so "correct the negative freight or additional cost"
  // named nothing the operator could find on the production order.
  const message = await refusalMessageFor({
    source: 'manufacturing_recompute', operation: 'recompute_production_order', productionOrderId: 'po-prod-1',
  })
  assert.match(message, /production order po-prod-1/, 'the driver is named')
  assert.match(message, /A production order cannot be recosted below zero/)
  assert.match(message, /the purchase order that supplied it/)
  assert.match(message, /recompute this production order/)
  assert.doesNotMatch(message, /save again/)
})
