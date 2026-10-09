import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'

/**
 * THE XERO BALANCE-SNAPSHOT STAMP: written INSIDE the transaction that stores the snapshots, and only by
 * a clean scheduled pull that stored a snapshot for every configured account.
 *
 * The fence double runs the callback against a fake transaction and COMMITS its writes only when the
 * callback returns and the fence says ok; a refused fence discards them. So "same transaction" is
 * observable: the stamp is among the committed writes of the very call that persisted the snapshots, and
 * a refusal takes it away with them.
 *
 * Mutation (verified red, see the PR): the stamp upsert moved to after `withXeroConnectionFence`
 * returns => "[snapshots] the stamp commits with the snapshots, in the same fenced call" fails.
 */

type Write = { call: number; kind: 'snapshots' | 'stamp'; detail: string }
const committed: Write[] = []
let fenceCalls = 0
let fenceOk = true
let xeroGetResult: { ok: boolean; data?: unknown; error?: string } = { ok: true }
let chart: Array<{ externalAccountId: string; code: string | null; name: string }> = []
let storedCount: (n: number) => number = (n) => n

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccount: { findMany: async () => chart },
      // A stamp written through the shared client, i.e. OUTSIDE the fenced transaction, lands here with call 0.
      setting: { upsert: async ({ where }: { where: { key: string } }) => { committed.push({ call: 0, kind: 'stamp', detail: where.key }) } },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_inventory_account: '200',
      xero_allocated_inventory_account: '',
      xero_cogs_account: '500',
      xero_transit_account: '',
    }),
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => xeroGetResult,
    xeroGetCached: async () => ({ ok: true, data: { Organisations: [{ BaseCurrency: 'GBP' }] } }),
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ organisation: 'org-1' }),
    withXeroConnectionFence: async (_connection: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      fenceCalls += 1
      const call = fenceCalls
      const pending: Write[] = []
      const tx = {
        setting: {
          upsert: async ({ where }: { where: { key: string } }) => { pending.push({ call, kind: 'stamp', detail: where.key }) },
        },
        recordSnapshots: (n: number) => { pending.push({ call, kind: 'snapshots', detail: String(n) }) },
      }
      const value = await fn(tx)
      if (!fenceOk) return { ok: false, error: 'the Xero connection changed during the pull' }
      committed.push(...pending)
      return { ok: true, value }
    },
  },
})
mock.module('@/lib/domain/accounting/account-balance-snapshots', {
  namedExports: {
    balanceDateString: (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)),
    persistAccountingAccountBalanceSnapshots: async (inputs: unknown[], tx: { recordSnapshots: (n: number) => void }) => {
      const persisted = storedCount(inputs.length)
      tx.recordSnapshots(persisted)
      return { attempted: inputs.length, persisted, snapshots: [] }
    },
  },
})

function trialBalance(rows: Array<{ id: string; label: string; debit: string }>) {
  return {
    ok: true,
    data: {
      Reports: [{
        Rows: [{
          RowType: 'Section',
          Rows: rows.map((row) => ({
            RowType: 'Row',
            Cells: [
              { Value: row.label, Attributes: [{ Id: 'account', Value: row.id }] },
              { Value: row.debit },
              { Value: '0' },
            ],
          })),
        }],
      }],
    },
  }
}

const BOTH_ACCOUNTS = [
  { externalAccountId: 'acc-200', code: '200', name: 'Inventory' },
  { externalAccountId: 'acc-500', code: '500', name: 'Cost of goods sold' },
]

function reset() {
  committed.length = 0
  fenceCalls = 0
  fenceOk = true
  chart = BOTH_ACCOUNTS
  storedCount = (n) => n
  xeroGetResult = trialBalance([
    { id: 'acc-200', label: '200 - Inventory', debit: '100.00' },
    { id: 'acc-500', label: '500 - Cost of goods sold', debit: '40.00' },
  ])
}

async function pull(options: { recordScheduledPullSuccess?: boolean } = {}) {
  const { syncXeroAccountBalanceSnapshots } = await import('@/lib/connectors/xero/account-balances')
  return syncXeroAccountBalanceSnapshots({ balanceDate: '2026-10-07', syncRunId: 'run-1', ...options })
}

test('[snapshots] the stamp commits with the snapshots, in the same fenced call', async () => {
  reset()
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: ${JSON.stringify(result)} committed=${JSON.stringify(committed)}`)
  assert.deepEqual(result.errors, [])
  assert.equal(result.persisted, 2)
  const stamp = committed.filter((write) => write.kind === 'stamp')
  const snapshots = committed.filter((write) => write.kind === 'snapshots')
  assert.equal(snapshots.length, 1)
  assert.equal(stamp.length, 1)
  assert.equal(stamp[0]!.detail, XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING)
  assert.equal(stamp[0]!.call, snapshots[0]!.call, 'one fenced call, one commit')
  assert.equal(fenceCalls, 1)
})

test('[snapshots] an on-demand refresh (flag absent) never advances the stamp', async () => {
  reset()
  const result = await pull()
  console.log(`precondition: persisted=${result.persisted} committed=${JSON.stringify(committed)}`)
  assert.equal(result.persisted, 2)
  assert.equal(committed.filter((write) => write.kind === 'snapshots').length, 1)
  assert.equal(committed.filter((write) => write.kind === 'stamp').length, 0)
})

test('[snapshots] a fetch that failed stores nothing and stamps nothing', async () => {
  reset()
  xeroGetResult = { ok: false, error: 'Xero HTTP 503' }
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: ${JSON.stringify(result)} fenceCalls=${fenceCalls}`)
  assert.equal(result.errors.length, 1)
  assert.equal(fenceCalls, 0)
  assert.equal(committed.length, 0)
})

test('[snapshots] an empty report (nothing parsed) is an error, not "no balances": no stamp', async () => {
  reset()
  xeroGetResult = trialBalance([])
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: errors=${result.errors.length} persisted=${result.persisted}`)
  assert.ok(result.errors.length > 0)
  assert.equal(committed.filter((write) => write.kind === 'stamp').length, 0)
})

test('[snapshots] a configured account missing from the chart stores a partial set: no stamp', async () => {
  reset()
  chart = [BOTH_ACCOUNTS[0]!]
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: persisted=${result.persisted} of 2 configured`)
  assert.equal(result.persisted, 1)
  assert.equal(committed.filter((write) => write.kind === 'snapshots').length, 1)
  assert.equal(committed.filter((write) => write.kind === 'stamp').length, 0)
})

test('[snapshots] nothing to store (no configured account in the chart) is not a success: no stamp', async () => {
  reset()
  chart = []
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: ${JSON.stringify(result)}`)
  assert.equal(result.persisted, 0)
  assert.equal(committed.filter((write) => write.kind === 'stamp').length, 0)
})

test('[snapshots] a refused fence (the connection moved) discards the stamp with the snapshots', async () => {
  reset()
  fenceOk = false
  const result = await pull({ recordScheduledPullSuccess: true })
  console.log(`precondition: ${JSON.stringify(result)} fenceCalls=${fenceCalls}`)
  assert.equal(fenceCalls, 1, 'the fence was reached, so the stamp was attempted')
  assert.equal(result.errors.length, 1)
  assert.equal(committed.length, 0, 'neither the snapshots nor the stamp survive a refusal')
})
