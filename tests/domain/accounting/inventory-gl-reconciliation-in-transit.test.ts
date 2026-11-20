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
let run: { id: string; inTransitCovered: boolean; cutoffAt: Date | null } | null = { id: 'r', inTransitCovered: true, cutoffAt: null }
let transitRows: Array<{ valueBase: string; valueReplayReliable: boolean }> = []
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
  run = { id: 'r', inTransitCovered: true, cutoffAt: null }
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

test('a run from before the line existed is valued from the movement ledger as of its cutoff, never read as zero', async () => {
  reset()
  run = { id: 'r', inTransitCovered: false, cutoffAt: new Date('2026-07-10T23:00:00.000Z') }
  measured = [{ transferId: 't1', value: '400', nullValueMovements: 0 }]
  const r = await load()
  assert.ok(r.available)
  assert.equal(r.inTransitValue, 400)
  assert.equal(r.action, 'balanced')
  assert.ok(ledgerAsked, 'the ledger was asked')
})

test('an in-transit figure that rests on valueless movements is withheld, not compared', async () => {
  reset(); transitRows = [{ valueBase: '400', valueReplayReliable: false }]
  const r = await load()
  assert.deepEqual(r, { available: false, reason: 'unreliable_subledger_snapshot' })
})
