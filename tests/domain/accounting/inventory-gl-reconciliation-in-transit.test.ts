import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ACC-M12 at the loader: the sub-ledger the Inventory GL is compared with is the snapshot's on-hand value PLUS the stock in
 * transit on dispatched transfers, shown as its own line. Without the line the comparison flags the dispatched value as a gap
 * for every day a transfer is on its way.
 */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const BALANCE_DATE = '2026-07-10'
let onHand = '600'
let run: { id: string; inTransitCovered: boolean; cutoffAt: Date | null; source: string } | null = { id: 'r', inTransitCovered: true, cutoffAt: null, source: 'cron' }
let transitRows: Array<{ transferId?: string; valueBase: string; valueReplayReliable: boolean }> = []
let measured: Array<{ transferId: string; value: string; nullValueMovements: number }> = []
let ledgerAsked = false

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccount: { findMany: async ({ where }: { where: { code: string } }) => [{ code: where.code, externalAccountId: `a-${where.code}`, type: 'INVENTORY' }] },
      accountingToken: { findUnique: async () => ({ tenantId: 't1' }) },
      accountingAccountBalanceSnapshot: {
        findFirst: async ({ where }: { where: { externalAccountId: string } }) => {
          const amount = where.externalAccountId === 'a-630' ? '1000' : '0'
          return { id: where.externalAccountId, connector: 'xero', externalAccountId: where.externalAccountId, accountCode: where.externalAccountId.slice(2), accountName: 'x', balanceDate: day(BALANCE_DATE), currency: 'GBP', amountForeign: amount, amountBase: amount, sourcePayloadRef: `xero:trial-balance:${BALANCE_DATE}`, tenantId: 't1', financialYearEnd: null, parserVersion: 2, syncRunId: null, fetchedAt: day(BALANCE_DATE) }
        },
      },
      inventorySnapshot: { findMany: async () => [{ valueBase: onHand, valueReplayReliable: true }] },
      inventorySnapshotRun: { findUnique: async () => run },
      inventoryTransitSnapshot: { findMany: async () => transitRows },
      accountingSyncLog: { findMany: async () => [] },
      $queryRaw: async () => { ledgerAsked = true; return measured },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
const settings = { inventoryAccount: '630', allocatedInventoryAccount: '631' }
mock.module('@/lib/accounting', { namedExports: { getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }), getAccountingSettingsFor: async () => settings, getAccountingSettings: async () => settings } })

const load = async () => (await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')).loadInventoryGlReconciliation({ now: day(BALANCE_DATE) })
const reset = () => {
  onHand = '600'
  run = { id: 'r', inTransitCovered: true, cutoffAt: null, source: 'cron' }
  transitRows = []
  measured = []
  ledgerAsked = false
}

test('GL 1000 = on-hand 600 + in transit 400: balanced, with the in-transit value as its own line', async () => {
  reset(); transitRows = [{ valueBase: '250', valueReplayReliable: true }, { valueBase: '150', valueReplayReliable: true }]
  const r = await load()
  assert.ok(r.available)
  assert.equal(r.onHandValue, 600)
  assert.equal(r.inTransitValue, 400)
  assert.equal(r.subledgerValue, 1000)
  assert.equal(r.action, 'balanced')
})

test('the same day without the in-transit line is a 400 gap the reconciliation flags (what the bug looked like)', async () => {
  reset()
  const r = await load()
  assert.ok(r.available)
  assert.equal(r.inTransitValue, 0)
  assert.equal(r.action, 'flag')
  assert.equal(r.delta, -400)
})

test('a BACKFILL run from before the line existed is valued from the movement ledger at its cutoff, never read as zero', async () => {
  reset()
  run = { id: 'r', inTransitCovered: false, cutoffAt: new Date('2026-07-10T23:00:00.000Z'), source: 'backfill' }
  measured = [{ transferId: 't1', value: '400', nullValueMovements: 0 }]
  const r = await load()
  assert.ok(r.available)
  assert.equal(r.inTransitValue, 400)
  assert.equal(r.action, 'balanced')
  assert.ok(ledgerAsked, 'the ledger was asked')
})

test('an OLD CRON run (on-hand read at an unrecorded instant after midnight) does not measure transit: a transfer received between midnight and the capture is no new gap and no sweep', async () => {
  reset()
  // The destination already holds the received units (on-hand 1000 = GL 1000); at midnight the same transfer, 400, was still in transit.
  onHand = '1000.40'
  run = { id: 'r', inTransitCovered: false, cutoffAt: new Date('2026-07-10T23:00:00.000Z'), source: 'cron' }
  measured = [{ transferId: 't1', value: '400', nullValueMovements: 0 }]
  const mod = await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')
  const r = await load()
  assert.ok(r.available)
  assert.equal(ledgerAsked, false, 'transit is not measurable for this date, so the ledger is not asked')
  assert.equal(r.inTransitValue, undefined)
  assert.equal(r.subledgerValue, 1000.4, 'the comparison is the on-hand one it always was')
  assert.equal(r.action, 'sweep', 'exactly the pre-change behaviour: a sub-penny residue sweeps; there is no extra 400 gap')
  assert.equal(r.delta, 0.4)
  assert.ok(mod.buildInventoryReconciliationSweepJournal(r, { inventoryAccount: '630', roundingAccount: '999', currency: 'GBP' }), 'the rounding sweep is unchanged')
})

test('a transfer with a valueless movement is left out and named; the reconciliation still runs and the date is not swept', async () => {
  reset()
  onHand = '600.40'
  transitRows = [{ transferId: 'ok', valueBase: '400', valueReplayReliable: true }, { transferId: 'legacy', valueBase: '25', valueReplayReliable: false }]
  const mod = await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')
  const r = await load()
  assert.ok(r.available, 'one legacy transfer does not switch the reconciliation off')
  assert.equal(r.inTransitValue, 400)
  assert.deepEqual(r.unvaluedTransitTransfers, ['legacy'])
  assert.equal(r.sweepWithheld, 'unvalued_transit_transfers')
  assert.equal(mod.buildInventoryReconciliationSweepJournal(r, { inventoryAccount: '630', roundingAccount: '999', currency: 'GBP' }), null)
  const { inventoryGlReconciliationFinding } = await import('../../../lib/domain/accounting/invariants.ts')
  assert.equal(inventoryGlReconciliationFinding(r), null, 'the gap itself is rounding scale: no critical')
})
