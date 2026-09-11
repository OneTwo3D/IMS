import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'

/**
 * o3d-i0o6 r8 (Codex round 7, HIGH) — THE ACTIVE-LEDGER CHECK IS FENCED BY THE PLUGIN-SELECTION
 * LOCK, HELD THROUGH THE QUEUE INSERT.
 *
 * WHAT ROUND 7 ESTABLISHED, AND WHERE IT STOPPED. r7's rule is right and is unchanged: a credit may
 * only be queued to a ledger something still drains, so a pinned enqueue whose connector is no longer
 * the ACTIVE one must refuse rather than write. What r7 enforced it with was an UNLOCKED snapshot —
 * `getActiveAccountingConnectorId()` over the pooled client — and then both enqueue paths awaited
 * further work before their INSERT:
 *
 *   * the in-transaction enqueue checked at lib/accounting.ts:533 and did not create until ~:660,
 *     via the posting context, the id-provenance read, the base currency, the follow-up scope lock
 *     and the prior-attempt query;
 *   * the facade checked at lib/accounting.ts:312 and then handed off to `queueXeroSync` /
 *     `queueQuickBooksSync`, which open their OWN transaction and take an order lock, a scope lock
 *     and a stale-discount check before inserting.
 *
 * A connector switch committing anywhere in either window put the row onto the now-inactive
 * connector anyway. `assertAllocationReversalQueued` then asked the database for the row — the right
 * question, because the enqueue's boolean lies — found it, and the caller added its amount to
 * `SalesOrder.allocationReversalAmount`, which is exactly what a later refund nets its open Allocated
 * Inventory balance against. Unposted pounds read as relief; every later refund under-credits
 * Allocated Inventory by that much. That is the money consequence r7 set out to make impossible, and
 * it stayed reachable through the gap between r7's check and r7's write.
 *
 * WHAT THIS FILE PINS. That the verdict is taken from the LOCKED read, and that the lock is taken on
 * the same transaction that does the insert, before it:
 *
 *   1. the plugin-selection advisory lock and the `FOR UPDATE` read of the plugin rows are issued on
 *      the INSERTING transaction, and issued BEFORE the insert. Because both are transactional, that
 *      alone is the fence: PostgreSQL will not let any writer commit a change to those rows until the
 *      transaction ends, which is after the row is durable;
 *   2. the decision follows the LOCKED read even when the POOLED read disagrees with it — which is
 *      precisely the production window, where the facade's pooled snapshot was taken before the
 *      switch committed and the locked read is taken after;
 *   3. on both enqueue paths, the in-transaction and the facade one;
 *   4. and the refusal is `refused`, never `not-configured`: the posting is still owed.
 *
 * WHAT IT DOES NOT PROVE. That the locks actually block a concurrent writer — that is a PostgreSQL
 * property and no double can exhibit it. `tests/concurrency/pinned-ledger-fence.concurrent.test.ts`
 * races it against a real database.
 */

/** The `settings` table, as far as this file is concerned. One place the truth lives. */
const settingsTable = new Map<string, string>()

/**
 * A POOLED read that has gone stale, modelling the one thing the fence exists for.
 *
 * `null` means "read the table", which is what a pooled read normally does and what keeps the two
 * sources from drifting in every test that is not about the window. Set to a state, and
 * `isIntegrationPluginEnabled` answers from THAT while the locked read still answers from the table —
 * which is exactly the production interleaving: the facade's snapshot was taken before the switch
 * committed, and the locked read inside the inserting transaction is taken after it.
 *
 * This is the fixture modelling the WINDOW, not modelling the LOCK. The fence's verdict must come
 * from the locked read; if the code instead trusts the snapshot, these tests fail.
 */
let stalePooledSelection: Record<string, boolean> | null = null

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => (
      stalePooledSelection
        ? stalePooledSelection[id] === true
        : settingsTable.get(INTEGRATION_PLUGIN_SETTING_KEYS[id as 'xero']) === 'true'
    ),
  },
})

mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({ xero_sync_enabled: 'true' }),
  },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({ quickbooks_sync_enabled: 'true' }),
  },
})
// ALLOCATION_REVERSAL and UNEARNED_REV_REVERSAL are in neither connector's SYNC_TYPE_SETTING map, so
// their posting mode is the unconditional 'submitted' — there is no per-type setting to stub, and the
// only gate in front of the fence is the connector's own `*_sync_enabled`, left on above so that a
// refusal below can only have come from the fence.
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: {
    resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }),
    // The facade path's own order guard. `false` is "not an order-scoped reference", which is what
    // this reference type is — see the ALLOCATION_REVERSAL/SalesOrderRefund request below.
    lockOrderForAccountingEnqueue: async () => false,
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => undefined,
  },
})
mock.module('@/lib/connectors/accounting-id-provenance', {
  namedExports: { activeAccountingIdProvenance: async () => ({}) },
})
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

/** Rows written by whichever path is under test, with the connector each was written under. */
const created: Array<{ connector: string; type: string }> = []
/** The operations the INSERTING transaction issued, in order. */
let trace: string[] = []

/**
 * A transaction double that answers the locked plugin read FROM THE TABLE and records what it was
 * asked, in order.
 *
 * It does NOT pretend to lock anything — it cannot, and a double that reported "locked" would be the
 * fixture answering a question only PostgreSQL can answer. What it can establish, and what is
 * sufficient given the concurrency test, is that the lock statements are issued ON THIS TRANSACTION
 * and BEFORE its insert: everything else about a transactional lock follows from Postgres.
 */
function transactionDouble() {
  return {
    $executeRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.raw.join(' ')
      if (sql.includes('pg_advisory_xact_lock') && values[0] === ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY) {
        trace.push('plugin-selection-advisory-lock')
      } else if (/insert into settings/i.test(sql)) {
        trace.push('materialise-plugin-rows')
      } else if (sql.includes('pg_advisory_xact_lock')) {
        trace.push('follow-up-scope-lock')
      } else {
        trace.push('other-execute-raw')
      }
      return 1
    },
    $queryRaw: async (query: TemplateStringsArray) => {
      const sql = query.raw.join(' ')
      if (/from settings/i.test(sql) && /for update/i.test(sql)) {
        trace.push('locked-plugin-read')
        return [...settingsTable].map(([key, value]) => ({ key, value }))
      }
      trace.push('other-query-raw')
      return []
    },
    accountingSyncLog: {
      findMany: async () => [],
      create: async ({ data }: { data: { connector: string; type: string } }) => {
        trace.push('insert-accounting-sync-log')
        created.push({ connector: data.connector, type: data.type })
        return { id: `log-${created.length}`, ...data }
      },
    },
    activityLog: { create: async () => ({ id: 'activity-1' }) },
  }
}

/**
 * The facade's connector queues open their OWN transaction. Doubled here so the facade path can be
 * driven end to end — the point of the facade half of this file is that the fence is inside THAT
 * transaction, not in the facade.
 */
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async <T>(fn: (tx: ReturnType<typeof transactionDouble>) => Promise<T>): Promise<T> =>
        fn(transactionDouble()),
      accountingSyncLog: { findMany: async () => [] },
    },
  },
})

const TX_REQUEST = {
  type: 'ALLOCATION_REVERSAL' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  payload: { lines: [{ accountCode: '630', debit: 16 }, { accountCode: '631', credit: 16 }] },
  unlockedOrderScopeReason: 'test harness: the order guard is doubled to a non-order scope',
}

const FACADE_REQUEST = {
  type: 'UNEARNED_REV_REVERSAL' as const,
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  payload: { lines: [{ accountCode: '630', debit: 20 }, { accountCode: '631', credit: 20 }] },
}

function reset(selection: { xero: boolean; quickbooks: boolean }): void {
  settingsTable.clear()
  settingsTable.set(INTEGRATION_PLUGIN_SETTING_KEYS.xero, String(selection.xero))
  settingsTable.set(INTEGRATION_PLUGIN_SETTING_KEYS.quickbooks, String(selection.quickbooks))
  stalePooledSelection = null
  created.length = 0
  trace = []
}

// ---------------------------------------------------------------------------------------------
// THE IN-TRANSACTION ENQUEUE
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r8] the in-transaction enqueue takes the plugin-selection lock on the INSERTING transaction, before the insert', async () => {
  reset({ xero: true, quickbooks: false })
  const { queueAccountingSyncTx } = await import('@/lib/accounting')

  const queued = await queueAccountingSyncTx(transactionDouble() as never, { ...TX_REQUEST, connector: 'xero' })

  assert.equal(queued, true, 'the control: xero is the active ledger, so the credit IS queued')
  assert.equal(created.length, 1)

  const lockAt = trace.indexOf('plugin-selection-advisory-lock')
  const readAt = trace.indexOf('locked-plugin-read')
  const insertAt = trace.indexOf('insert-accounting-sync-log')
  assert.ok(lockAt >= 0, `the selection advisory lock was never taken: ${trace.join(' -> ')}`)
  assert.ok(readAt > lockAt, 'the plugin rows are read AFTER the advisory lock — a lock taken after the read it protects protects nothing')
  assert.ok(insertAt > readAt,
    'the insert must come after the locked read, on the SAME transaction: that is what holds the '
    + `verdict to the commit rather than sampling it. Trace: ${trace.join(' -> ')}`)
})

test('[o3d-i0o6 r8] the in-transaction enqueue refuses on the LOCKED read, even where the pooled read still says the pin is active', async () => {
  // THE WINDOW, as production produces it. The switch to QuickBooks has committed; a pooled read
  // taken before that commit — the shape of every read r7's check was made of — still answers 'xero'.
  reset({ xero: false, quickbooks: true })
  stalePooledSelection = { xero: true, quickbooks: false }

  const { queueAccountingSyncTx } = await import('@/lib/accounting')
  // A holder rather than a bare `let`: the assignment happens in a callback, which control-flow
  // narrowing cannot see, and `reported` would otherwise narrow to `never` after the null check.
  const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } } = {}
  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    connector: 'xero',
    reportOutcome: (outcome) => { answered.outcome = outcome },
  })

  assert.equal(queued, false, 'nothing may be queued to a ledger the selection has moved off')
  assert.deepEqual(created, [],
    'and NOTHING was written. A PENDING xero row here is one `assertAllocationReversalQueued` finds '
    + 'and counts as posted relief, so every later refund under-credits Allocated Inventory by it')
  assert.ok(answered.outcome, 'the enqueue must answer')
  assert.equal(answered.outcome.reason, 'refused',
    '`refused`, never `not-configured` — the posting is still owed, and `not-configured` is the one '
    + 'no-op the refund obligation ledger may settle an obligation with')
  assert.equal(answered.outcome.connector, 'xero', 'and the answer is about the PROVED ledger')
})

test('[o3d-i0o6 r8] an UNPINNED in-transaction enqueue takes no selection lock at all', async () => {
  // The guarantee that makes the fence safe to add: every existing caller keeps the active-connector
  // resolution by not passing a pin, and pays nothing — no advisory lock, no row locks, no new
  // serialisation on the ordinary queue traffic.
  reset({ xero: true, quickbooks: false })
  const { queueAccountingSyncTx } = await import('@/lib/accounting')

  const queued = await queueAccountingSyncTx(transactionDouble() as never, TX_REQUEST)

  assert.equal(queued, true)
  assert.equal(created.length, 1)
  assert.ok(!trace.includes('plugin-selection-advisory-lock'),
    `an unpinned enqueue must not take the selection lock: ${trace.join(' -> ')}`)
})

// ---------------------------------------------------------------------------------------------
// THE FACADE
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r8] the facade hands the pin to the connector queue, which locks the selection on its own inserting transaction', async () => {
  reset({ xero: true, quickbooks: false })
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync({ ...FACADE_REQUEST, connector: 'xero' })

  assert.equal(outcome.queued, true, 'the control: the pinned ledger is the active one')
  assert.deepEqual(created, [{ connector: 'xero', type: 'UNEARNED_REV_REVERSAL' }])
  const lockAt = trace.indexOf('plugin-selection-advisory-lock')
  const insertAt = trace.indexOf('insert-accounting-sync-log')
  assert.ok(lockAt >= 0,
    'the facade\'s own check is a POOLED read taken before the hand-off; the connector queue must '
    + `re-take the verdict under the lock inside the transaction that inserts. Trace: ${trace.join(' -> ')}`)
  assert.ok(insertAt > lockAt, 'and hold it across the insert')
})

test('[o3d-i0o6 r8] the facade path refuses inside the queue transaction when the selection moved after its own pooled check', async () => {
  // THE FACADE'S WINDOW. `queueAccountingSync` asks `pinnedLedgerIsServiced` over the pool and then
  // awaits an import, a settings read, a provenance read, a transaction, an order lock and a
  // stale-discount check before the insert. The pooled answer here is 'xero, still active' — so the
  // facade's own check PASSES, exactly as it did in production — and the switch has since committed.
  reset({ xero: false, quickbooks: true })
  stalePooledSelection = { xero: true, quickbooks: false }

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...FACADE_REQUEST, connector: 'xero' })

  assert.deepEqual(created, [],
    'nothing may be written: the facade\'s pooled check cannot survive to the insert, so the queue '
    + 'itself has to refuse under the lock')
  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'refused', 'the posting is owed, not decided')
  assert.equal(outcome.connector, 'xero')
})

test('[o3d-i0o6 r8] an UNPINNED facade enqueue takes no selection lock', async () => {
  reset({ xero: true, quickbooks: false })
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync(FACADE_REQUEST)

  assert.equal(outcome.queued, true)
  assert.deepEqual(created, [{ connector: 'xero', type: 'UNEARNED_REV_REVERSAL' }])
  assert.ok(!trace.includes('plugin-selection-advisory-lock'),
    `unpinned traffic must be untouched: ${trace.join(' -> ')}`)
})

test('[o3d-i0o6 r8] a pin naming another ledger cannot get a row out of this queue', async () => {
  // Unreachable through the facade, which routes by the pin. Asserted because the queues are the
  // things that WRITE, and a queue that ignored a pin it cannot satisfy would write a Xero row for a
  // QuickBooks proof — the original defect, one layer down.
  reset({ xero: true, quickbooks: false })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync({ ...FACADE_REQUEST, pinnedLedger: 'quickbooks' })

  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'refused')
  assert.deepEqual(created, [], 'no xero row for a quickbooks pin')
})

test('[o3d-i0o6 r8] the QuickBooks queue is fenced too', async () => {
  // Cross-ported rather than left as "Xero is the one that matters today": the defect is about ANY
  // two connectors, and a fence on one of them is not a fence.
  reset({ xero: true, quickbooks: false })
  stalePooledSelection = { xero: false, quickbooks: true }

  const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')
  const outcome = await queueQuickBooksSync({ ...FACADE_REQUEST, pinnedLedger: 'quickbooks' })

  assert.deepEqual(created, [],
    'the locked read says xero is active (xero-first over the table), so a quickbooks pin refuses')
  assert.equal(outcome.reason, 'refused')

  // And the control, so the refusal above is a narrowing rather than a blanket.
  reset({ xero: false, quickbooks: true })
  const allowed = await queueQuickBooksSync({ ...FACADE_REQUEST, pinnedLedger: 'quickbooks' })
  assert.equal(allowed.queued, true)
  assert.deepEqual(created, [{ connector: 'quickbooks', type: 'UNEARNED_REV_REVERSAL' }])
})
