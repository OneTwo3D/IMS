import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ACC-M7 / ACC-M12 at the loader: the inventory reconciliation measures both sides over the same day, adds back stock on a dispatched
 * transfer, and will not sweep a residue that recurs every day.
 */
type Snap = { balanceDate: Date; accountCode: string; amountBase: string; externalAccountId: string }
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
let straddleMovements = 0
let transferOut: string | null = null
let transferIn: string | null = null
let priorSweeps: Array<{ payload: unknown }> = []
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
      inventorySnapshotRun: { findUnique: async () => ({ id: 'r' }) },
      stockMovement: {
        count: async () => straddleMovements,
        aggregate: async ({ where }: { where: { type: string } }) => ({ _sum: { totalValueBase: where.type === 'TRANSFER_OUT' ? transferOut : transferIn } }),
      },
      costLayerRevaluation: { count: async () => 0 },
      accountingSyncLog: { findMany: async () => priorSweeps },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
const settings = { inventoryAccount: '630', allocatedInventoryAccount: '631' }
mock.module('@/lib/accounting', { namedExports: { getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }), getAccountingSettingsFor: async () => settings, getAccountingSettings: async () => settings } })

const load = async () => (await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')).loadInventoryGlReconciliation({ now: day(BALANCE_DATE) })
const reset = () => { straddleMovements = 0; transferOut = null; transferIn = null; priorSweeps = []; subledger = '1000' }

test('ACC-M7: stock moving in the BST hour the UTC and business days disagree withholds the comparison', async () => {
  reset(); straddleMovements = 3
  assert.deepEqual(await load(), { available: false, reason: 'snapshot_window_straddles_business_day' })
})

test('ACC-M7: with nothing moving in that hour the comparison is made', async () => {
  reset()
  const r = await load()
  assert.equal(r.available, true)
  assert.equal(r.available && r.action, 'balanced')
})

test('ACC-M7: a residue within the per-day limit is not swept once the trailing sweeps have used the cap', async () => {
  reset(); subledger = '1000.40'
  const first = await load()
  assert.equal(first.available && first.action, 'sweep')
  priorSweeps = Array.from({ length: 12 }, () => ({ payload: { lines: [{ accountCode: '630', debit: 0.4 }] } }))
  const recurring = await load()
  assert.equal(recurring.available && recurring.action, 'flag', 'twelve prior sweeps of 0.40 are a recurring error, not rounding')
})

test('ACC-M12: value dispatched on a transfer and not yet received is part of the subledger compared with the GL', async () => {
  reset(); subledger = '940'; transferOut = '100'; transferIn = '40'
  const r = await load()
  assert.equal(r.available && r.subledgerValue, 1000)
  assert.equal(r.available && r.action, 'balanced', 'was a 60.00 flag: the stock is out of the snapshot but still in the Inventory account')
})
