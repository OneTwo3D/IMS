import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-i0o6 r3 (Codex round 2, HIGH 1) — THE FACADE ENQUEUE TAKES THE PIN TOO, BECAUSE THAT IS THE
 * ROUTE THE PROVED ALLOCATION CREDIT ACTUALLY TAKES.
 *
 * Round 2 pinned `queueAccountingSyncTx` — the in-transaction enqueue — and filed the facade as
 * later work. The filing did not hold. A refund's allocation credit is staged inside the refund
 * transaction, where the A2 debit is proved against ONE connector and the journal's account codes
 * are read from THAT connector's settings; the resulting `UNEARNED_REV_REVERSAL` is then queued,
 * later and outside that transaction, by `queueRefundAccountingActions` — through the facade.
 * Unpinned, the facade resolved "the active connector" all over again, so a switch between staging
 * and the hand-off queued the credit on one ledger with the account codes and the proof of another.
 *
 * Two halves, tested here:
 *   1. a pinned enqueue is answered BY AND FOR the named connector, never by whichever is active;
 *   2. an UNPINNED enqueue is unchanged — every existing caller keeps the active-connector
 *      resolution by simply not passing the parameter, which is what makes the pin safe to add.
 */

const queued: Array<{ queue: 'xero' | 'quickbooks'; type: string; referenceId: string }> = []
let enabledPlugins: string[] = ['xero']
let xeroSyncEnabled = 'true'
let quickbooksSyncEnabled = 'true'

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => enabledPlugins.includes(id),
  },
})

mock.module('@/lib/connectors/xero/queue', {
  namedExports: {
    queueXeroSync: async (params: { type: string; referenceId: string }) => {
      if (xeroSyncEnabled !== 'true') return { queued: false, reason: 'not-configured' }
      queued.push({ queue: 'xero', type: params.type, referenceId: params.referenceId })
      return { queued: true }
    },
  },
})

mock.module('@/lib/connectors/quickbooks/queue', {
  namedExports: {
    queueQuickBooksSync: async (params: { type: string; referenceId: string }) => {
      if (quickbooksSyncEnabled !== 'true') return { queued: false, reason: 'not-configured' }
      queued.push({ queue: 'quickbooks', type: params.type, referenceId: params.referenceId })
      return { queued: true }
    },
  },
})

const REQUEST = {
  type: 'UNEARNED_REV_REVERSAL' as const,
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  payload: { lines: [{ accountCode: '631', credit: 20 }, { accountCode: '630', debit: 20 }] },
}

function reset(): void {
  queued.length = 0
  enabledPlugins = ['xero']
  xeroSyncEnabled = 'true'
  quickbooksSyncEnabled = 'true'
}

test('o3d-i0o6 r3: a PINNED facade enqueue writes to the ledger the proof was made on, not the active one', async () => {
  reset()
  // The switch that happens between staging and the hand-off: QuickBooks is active now.
  enabledPlugins = ['quickbooks']

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero' })

  assert.equal(outcome.connector, 'xero', 'the answer is about the PROVED ledger')
  assert.equal(outcome.queued, true)
  assert.deepEqual(
    queued.map((row) => row.queue),
    ['xero'],
    'and the row was written there — never on the connector that happens to be switched on now',
  )
})

test('o3d-i0o6 r3: a pinned enqueue whose connector no longer posts writes NOTHING, and says so', async () => {
  reset()
  enabledPlugins = ['quickbooks']
  xeroSyncEnabled = 'false'

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero' })

  assert.equal(outcome.queued, false, 'nothing is queued anywhere')
  assert.equal(outcome.connector, 'xero', 'and the refusal is reported against the pinned ledger')
  assert.deepEqual(queued, [], 'it did NOT fall back to the active connector')
})

test('o3d-i0o6 r3: an UNPINNED enqueue still resolves the active connector, exactly as before', async () => {
  reset()
  enabledPlugins = ['quickbooks']

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync(REQUEST)

  assert.equal(outcome.connector, 'quickbooks')
  assert.deepEqual(queued.map((row) => row.queue), ['quickbooks'])
})
