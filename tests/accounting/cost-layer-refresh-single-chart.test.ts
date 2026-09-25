import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r4 (SWEEP 1) — ONE CHART PER SHIPMENT-COGS REFRESH, AND EVERY CONNECTOR QUESTION ASKED OF IT.
 *
 * `refreshShipmentCogsForCostLayerChange` decides, per un-journaled shipment, whether the daily batch owns
 * the revaluation delta — and if it does, the caller REMOVES the delta from its COGS journal. That was
 * asked with `isDailyBatchPostingEnabled()`, a fresh resolution of the active connector, after the chart
 * the journal is built from had already been read. These tests pin that the question is now asked of the
 * CHART's connector, and that the active-connector form is not consulted at all.
 */

const asked: { forChart: Array<string | null>; active: number; verdicts: Array<[string | null, string]>; settingsReads: number } = {
  forChart: [], active: 0, verdicts: [], settingsReads: 0,
}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => { asked.settingsReads++; return { inventoryAccount: '120', cogsAccount: '500', connector: 'quickbooks' } },
    isDailyBatchPostingEnabled: async () => { asked.active++; return true },
    isDailyBatchPostingEnabledForChart: async (connector: string | null) => { asked.forChart.push(connector); return false },
    accountingPostingVerdictForChart: async (connector: string | null, type: string) => {
      asked.verdicts.push([connector, type])
      return { verdict: 'not-configured', connector }
    },
    queueAccountingSyncTx: async () => true,
  },
})

/**
 * o3d-j625 r12 (merging o3d-c08y) — THE DOUBLE NOW ANSWERS THE CONTEXT PROBE.
 *
 * c08y made `refreshShipmentCogsForCostLayerChange` refuse, before reading anything, on a client where a
 * journaled-shipment refusal could not abort the enclosing transaction: no `$executeRaw`, no raw escape
 * hatch to probe with, or a client that is provably NOT inside a transaction. That refusal is correct and
 * this file is not the place to weaken it — so the double answers the probe the way a real transaction
 * client does. `$executeRawUnsafe` accepts the `SAVEPOINT`/`RELEASE SAVEPOINT` pair
 * (`isClientInsideTransaction`) rather than ignoring every statement, so "inside a transaction" is
 * something this double SAYS rather than something the subject assumes; `$executeRaw` exists because the
 * refusal path needs it. The shipments here are never negative, so the refusal itself never fires — what
 * is under test is which CHART the questions are asked of.
 */
function tx(journaled: boolean) {
  return {
    $executeRaw: async () => 0,
    $executeRawUnsafe: async (sql: string) => {
      if (!/^\s*(SAVEPOINT|RELEASE SAVEPOINT)\s/i.test(sql)) {
        throw new Error(`cost-layer-refresh-single-chart double: unexpected raw statement ${JSON.stringify(sql)}`)
      }
      return 0
    },
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }, { id: 'shipment-2' }],
    shipment: {
      findUnique: async () => ({
        cogsBatchAmount: '20.00',
        shipmentJournalDate: journaled ? new Date('2026-01-02T00:00:00.000Z') : null,
        order: { id: 'order-1', accountingInvoiceId: 'INV-1' },
      }),
      update: async () => undefined,
    },
    shipmentLine: { findMany: async () => [{ costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }] }] },
    cogsSubledgerMovement: { upsert: async () => undefined },
  }
}

function reset() {
  asked.forChart = []
  asked.active = 0
  asked.verdicts = []
  asked.settingsReads = 0
}

test('[o3d-j625 r4] un-journaled shipments: batch ownership is asked OF THE INJECTED CHART, never of the active connector', async () => {
  reset()
  const { refreshShipmentCogsForCostLayerChange } = await import('@/lib/cost-layers')
  const result = await refreshShipmentCogsForCostLayerChange(tx(false) as never, 'layer-1', {
    accountingSettings: { inventoryAccount: '120', cogsAccount: '500', connector: 'xero' },
  })
  assert.equal(result.shipmentsUpdated, 2, 'PRECONDITION: both shipments were refreshed')
  assert.deepEqual(asked.forChart, ['xero'], 'asked once, of the chart the caller built its journal from')
  assert.equal(asked.active, 0, 'the active-connector resolver is not consulted')
  assert.equal(result.cogsRevaluationDelta.toString(), '0', 'and a "no" keeps the delta in the caller’s journal')
})

test('[o3d-j625 r4] with no injected chart, the refresh reads ONE chart for the whole call and asks every question of it', async () => {
  reset()
  const { refreshShipmentCogsForCostLayerChange } = await import('@/lib/cost-layers')
  await refreshShipmentCogsForCostLayerChange(tx(true) as never, 'layer-1', {})
  assert.equal(asked.settingsReads, 1, 'one chart read for two journaled shipments, not one per shipment')
  assert.deepEqual(asked.verdicts, [['quickbooks', 'COGS_REVERSAL'], ['quickbooks', 'COGS_REVERSAL']], 'each reversal verdict is asked of that chart')
  assert.equal(asked.active, 0)
})
