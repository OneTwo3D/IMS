import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ACC-M7 at the loader: the inventory reconciliation will not sweep a residue that recurs every day. The cap is on the NET sweep of
 * posted (or still postable) sweeps; FAILED and cancelled sweeps do not count.
 */
type Snap = { balanceDate: Date; accountCode: string; amountBase: string; externalAccountId: string }
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
type Sweep = { status: string; payload: unknown }
let priorSweeps: Sweep[] = []
let subledger = '1000'
const BALANCE_DATE = '2026-07-10' // BST

const snaps: Snap[] = [
  { balanceDate: day(BALANCE_DATE), accountCode: '630', amountBase: '1000', externalAccountId: 'a-630' },
  { balanceDate: day(BALANCE_DATE), accountCode: '631', amountBase: '0', externalAccountId: 'a-631' },
]
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccount: { findMany: async ({ where }: { where: { code: string } }) => [{ code: where.code, externalAccountId: `a-${where.code}`, type: 'INVENTORY' }] },
      accountingToken: { findUnique: async () => ({ tenantId: 't1' }) },
      accountingAccountBalanceSnapshot: {
        findFirst: async ({ where }: { where: { externalAccountId: string } }) => {
          const s = snaps.find((x) => x.externalAccountId === where.externalAccountId)
          return s ? { id: s.accountCode, connector: 'xero', externalAccountId: s.externalAccountId, accountCode: s.accountCode, accountName: s.accountCode, balanceDate: s.balanceDate, currency: 'GBP', amountForeign: s.amountBase, amountBase: s.amountBase, sourcePayloadRef: `xero:trial-balance:${BALANCE_DATE}`, tenantId: 't1', financialYearEnd: null, parserVersion: 2, syncRunId: null, fetchedAt: s.balanceDate } : null
        },
      },
      inventorySnapshot: { findMany: async () => [{ valueBase: subledger, valueReplayReliable: true }] },
      inventorySnapshotRun: { findUnique: async () => ({ id: 'r', inTransitCovered: true, cutoffAt: null, source: 'cron' }) },
      inventoryTransitSnapshot: { findMany: async () => [] },
      accountingSyncLog: { findMany: async ({ where }: { where: { status: { in: string[] } } }) => priorSweeps.filter((row) => where.status.in.includes(row.status)) },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
const settings = { inventoryAccount: '630', allocatedInventoryAccount: '631' }
mock.module('@/lib/accounting', { namedExports: { getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }), getAccountingSettingsFor: async () => settings, getAccountingSettings: async () => settings } })

const load = async () => (await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')).loadInventoryGlReconciliation({ now: day(BALANCE_DATE) })
const reset = () => { priorSweeps = []; subledger = '1000' }
const sweep = (status: string, line: { debit?: number; credit?: number }): Sweep => ({ status, payload: { lines: [{ accountCode: '630', ...line }] } })

test('ACC-M7: with a small residue and no prior sweeps the comparison sweeps', async () => {
  reset(); subledger = '1000.40'
  const r = await load()
  assert.equal(r.available && r.action, 'sweep')
  assert.equal(r.available && r.recurringSweepCap, undefined)
})

test('ACC-M7: a one-directional residue that has used the cap is a flag carrying the cap, not a plain gap', async () => {
  reset(); subledger = '1000.40'
  priorSweeps = Array.from({ length: 12 }, () => sweep('SYNCED', { debit: 0.4 }))
  const r = await load()
  assert.equal(r.available && r.action, 'flag')
  assert.equal(r.available && r.recurringSweepCap?.cap, 5)
  assert.equal(r.available && r.recurringSweepCap?.priorSweptNet, 4.8)
})

test('ACC-M7: residue that alternates in sign nets to nothing and is still swept', async () => {
  reset(); subledger = '1000.40'
  priorSweeps = Array.from({ length: 30 }, (_, i) => sweep('SYNCED', i % 2 === 0 ? { debit: 0.4 } : { credit: 0.4 }))
  const r = await load()
  assert.equal(r.available && r.action, 'sweep', 'the absolute total is 12.00 but the net is 0.00: rounding, not a recurring error')
})

test('ACC-M7: FAILED and CANCELLED sweeps never posted and do not use the cap', async () => {
  reset(); subledger = '1000.40'
  priorSweeps = [
    ...Array.from({ length: 12 }, () => sweep('FAILED', { debit: 0.4 })),
    ...Array.from({ length: 12 }, () => sweep('CANCELLED', { debit: 0.4 })),
  ]
  const r = await load()
  assert.equal(r.available && r.action, 'sweep')
})
