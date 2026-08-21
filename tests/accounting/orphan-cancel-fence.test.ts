import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'

import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { PermissionDeniedError, isAuthorizationDenial } from '@/lib/auth/session-gates'
import { hasPermission, type Permission } from '@/lib/permissions'

// ---------------------------------------------------------------------------
// o3d-osl8 round 5, finding 2 — cancelOrphanedAccountingSyncRows against a connector switch
// landing underneath it.
//
// THE BUG. The action sampled the active connector, derived a cancellation scope from that sample,
// and then ran an unfenced updateMany. If another administrator switched Xero → QuickBooks in
// between, the QuickBooks-scoped (or unscoped) update marked QuickBooks PENDING rows CANCELLED
// AFTER QuickBooks had become the active connector — discarding the live queue of the connector
// now in use. The re-read that followed only adjusted the survivor COUNT: nothing un-cancels a
// row, and the permanent activity log would have described healthy work as abandoned.
//
// THE FIX, two parts, tested separately because they fail differently:
//   • the whole read-decide-update runs in one transaction holding the connector-selection
//     advisory lock, which the plugin-state writers also take;
//   • before commit, the selection is re-read and the transaction ABORTS if it moved — which
//     still holds if some future writer forgets the lock.
//
// The switch is injected exactly where the finding says it lands: between scope resolution and the
// update.
// ---------------------------------------------------------------------------

type UpdateArgs = { where: unknown; data: Record<string, unknown> }

const state = {
  role: 'ADMIN' as string,
  /** Which accounting plugin is enabled. Mutated mid-action by the tests. */
  activeConnector: null as string | null,
  /** Runs the moment the fenced updateMany is issued — the exact window round 5 described. */
  onUpdate: null as null | (() => void),
  /**
   * Runs when the survivor COUNT is issued — i.e. AFTER the generation check and BEFORE the
   * transaction commits. That is the window round 6, finding 2 is about, and it is the one the
   * generation check cannot see: there is nothing left to re-check after it.
   */
  onCount: null as null | (() => void),
  updates: [] as UpdateArgs[],
  counts: [] as unknown[],
  /** Raw statements the transaction issued, in order. The lock must be the first. */
  raw: [] as string[],
  /** Every operation the transaction performed, in order, for sequencing assertions. */
  ops: [] as string[],
  /** How the transaction ended. */
  transactions: [] as Array<'committed' | 'rolled-back'>,
  activity: [] as Array<{ action: string; description: string }>,
  pending: 3,
  processing: 0,
  /**
   * A SIMULATED Postgres row lock on the plugin setting rows.
   *
   * `SELECT ... FOR UPDATE` takes it; the transaction ending releases it. `commitBypassingWrite`
   * models a writer that never takes the ADVISORY lock — the quiesce harness, a fixture upsert,
   * the full reset — and can therefore only be stopped by this. It is a model, not Postgres: what
   * it proves is that the action takes the row lock before it reads and holds it to commit, which
   * is the part of the protocol that lives in our code. That the lock then blocks is Postgres's
   * job and is NOT exercised here (see the file footer).
   */
  rowLockHeld: false,
  rowLockWaiters: [] as Array<() => void>,
  /** Set to the number of ops that had run when a bypassing write actually landed. */
  bypassLandedAfterOps: null as number | null,
  /** Reads of the plugin state that did NOT go through the transaction. Must stay at zero. */
  pluginReadsOutsideTx: 0,
}

function reset() {
  state.role = 'ADMIN'
  state.activeConnector = null
  state.onUpdate = null
  state.onCount = null
  state.updates = []
  state.counts = []
  state.raw = []
  state.ops = []
  state.transactions = []
  state.activity = []
  state.pending = 3
  state.processing = 0
  state.rowLockHeld = false
  state.rowLockWaiters = []
  state.bypassLandedAfterOps = null
  state.pluginReadsOutsideTx = 0
}

function takeRowLock() {
  state.rowLockHeld = true
}

function releaseRowLock() {
  state.rowLockHeld = false
  const waiters = state.rowLockWaiters
  state.rowLockWaiters = []
  for (const wake of waiters) wake()
}

/**
 * A plugin-key writer that takes NO advisory lock. It blocks only on the simulated row lock, so it
 * lands the instant the cancel transaction ends — or immediately, if the row lock was never taken.
 */
function commitBypassingWrite(to: string | null): Promise<void> {
  const apply = () => {
    state.activeConnector = to
    state.bypassLandedAfterOps = state.ops.length
  }
  if (!state.rowLockHeld) {
    apply()
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    state.rowLockWaiters.push(() => { apply(); resolve() })
  })
}

/** The plugin setting rows as `SELECT key, value FROM settings ... FOR UPDATE` would return them. */
function pluginRows() {
  return [
    { key: 'plugin_mintsoft_enabled', value: 'false' },
    { key: 'plugin_quickbooks_enabled', value: String(state.activeConnector === 'quickbooks') },
    { key: 'plugin_shiphero_enabled', value: 'false' },
    { key: 'plugin_shopify_enabled', value: 'false' },
    { key: 'plugin_woocommerce_enabled', value: 'false' },
    { key: 'plugin_xero_enabled', value: String(state.activeConnector === 'xero') },
  ]
}

const accountingSyncLog = {
  updateMany: async (args: UpdateArgs) => {
    state.ops.push('updateMany')
    state.updates.push(args)
    // The switch lands HERE: after the action resolved its scope, while the update is in flight.
    state.onUpdate?.()
    return { count: state.pending }
  },
  count: async (args: unknown) => {
    state.ops.push('count')
    state.counts.push(args)
    // POST-CHECK, PRE-COMMIT. The generation check has already run and passed by the time the
    // survivor count is issued.
    state.onCount?.()
    return state.processing
  },
  groupBy: async () => [],
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog,
      // Interactive transaction, with rollback modelled: the callback throwing is what discards
      // the update, and that is the property under test.
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        try {
          const result = await callback({ accountingSyncLog, $executeRaw: rawInTx, $queryRaw: queryInTx })
          state.transactions.push('committed')
          return result
        } catch (error) {
          state.transactions.push('rolled-back')
          throw error
        } finally {
          // The transaction ending is what releases the row locks it held. Recorded as an OP so a
          // write that lands "after commit" is distinguishable from one that lands during the last
          // statement — without this marker the two have the same op count and the post-commit
          // assertion below is vacuous.
          state.ops.push('tx-end')
          releaseRowLock()
        }
      },
    },
  },
})

/** Renders a tagged template back into inspectable SQL text. */
function renderSql(strings: TemplateStringsArray, values: unknown[]) {
  return strings.raw.map((s, i) => s + (i < values.length ? String(values[i]) : '')).join('')
}

/** Records the raw SQL a transaction issues, tagged-template style. */
async function rawInTx(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = renderSql(strings, values)
  state.raw.push(sql)
  state.ops.push(/pg_advisory_xact_lock/.test(sql) ? 'advisory-lock' : 'materialise-rows')
  return 1
}

/**
 * The `SELECT ... FOR UPDATE` read of the plugin rows. Takes the simulated row lock, and answers
 * from the CURRENT connector selection — so a switch that managed to land is visible to it.
 */
async function queryInTx(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = renderSql(strings, values)
  state.raw.push(sql)
  state.ops.push('select-plugin-rows-for-update')
  if (/FOR UPDATE/i.test(sql)) takeRowLock()
  return pluginRows()
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: state.role } }),
    requirePermission: async (permission: Permission) => {
      if (!hasPermission(state.role, permission)) {
        throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
      }
      return { user: { id: 'u1', role: state.role } }
    },
    freshAuthFailureResult: () => null,
    PermissionDeniedError,
    isAuthorizationDenial,
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: {
    // The POOLED, unlocked read. Counted rather than removed: the cancel must not use it, and a
    // double that simply threw would say "it was not called" without saying what called it.
    isIntegrationPluginEnabled: async (id: string) => {
      state.pluginReadsOutsideTx += 1
      return state.activeConnector === id
    },
    // The REAL key map, re-exported rather than invented: the settings writer's refusal is keyed on
    // it, and a double that made the keys up would prove the refusal against names that do not
    // exist. (Audited in round 9 — this export was MISSING, so the guard test below crashed on
    // `Object.values(undefined)` rather than exercising anything.)
    INTEGRATION_PLUGIN_SETTING_KEYS,
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; description: string }) => { state.activity.push(entry) },
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function cancel(connector?: string) {
  const { cancelOrphanedAccountingSyncRows } = await import('@/app/actions/accounting-sync')
  return cancelOrphanedAccountingSyncRows(connector)
}

test.beforeEach(reset)

test('the whole decision runs in ONE transaction, and BOTH locks are taken before anything is read', async () => {
  state.activeConnector = 'xero'

  await cancel('quickbooks')

  assert.deepEqual(state.transactions, ['committed'], 'exactly one transaction, and it committed')

  // The order is the property. An advisory lock taken after the read protects nothing, and a row
  // lock taken after the read protects nothing either.
  assert.deepEqual(
    state.ops,
    [
      'advisory-lock',
      'materialise-rows',
      'select-plugin-rows-for-update',
      'updateMany',
      'select-plugin-rows-for-update',
      'count',
      'tx-end',
    ],
    'lock, materialise, locked read, update, locked re-read (the fence), count — in that order',
  )

  assert.match(state.raw[0], /pg_advisory_xact_lock/)
  assert.ok(
    state.raw[0].includes(String(ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY)),
    'and it is the SAME lock the plugin-state writers take — a private key would serialize nothing',
  )

  // Round 6, finding 2. The advisory lock binds only writers that take it, and three real ones do
  // not (the quiesce harness, the e2e fixtures, the full reset). `FOR UPDATE` on the plugin rows is
  // what binds those, because it is Postgres rather than a convention.
  assert.match(state.raw[2], /FOR UPDATE/i, 'the selection is read under a row lock, not a bare SELECT')
  assert.match(state.raw[2], /plugin_xero_enabled|ANY\(/, 'and it is the plugin rows that are locked')
  // Materialised first, because FOR UPDATE locks only rows that EXIST — an absent
  // plugin_quickbooks_enabled would otherwise be INSERTable by a bypassing writer mid-transaction.
  assert.match(state.raw[1], /INSERT INTO settings/i)
  assert.match(state.raw[1], /ON CONFLICT \(key\) DO NOTHING/i, 'idempotent: it writes the value an absent row already means')

  assert.equal(state.updates.length, 1, 'the update ran inside it')
})

test('the selection is read THROUGH the transaction, never through the pooled client', async () => {
  // The round 5 code read it with getActiveConnector() on the ordinary pooled client and argued
  // that a single definition of "which connector is active" beat the extra connection. The cost of
  // that was the whole of finding 2: a pooled read holds no lock, so nothing it observes is fenced.
  // If this ever regresses, `isIntegrationPluginEnabled` starts being called again.
  state.activeConnector = 'xero'
  state.pluginReadsOutsideTx = 0

  await cancel('quickbooks')

  assert.equal(state.pluginReadsOutsideTx, 0, 'no unlocked read decided anything')
  assert.equal(
    state.ops.filter((op) => op === 'select-plugin-rows-for-update').length,
    2,
    'both the decision and the fence read the LOCKED rows',
  )
})

test('a writer that skips the advisory lock cannot land in the post-check/pre-commit window', async () => {
  // THE WINDOW ROUND 6, FINDING 2 IS ABOUT, and the one round 5 left open while describing itself
  // as closed. The generation check verifies at one instant and the transaction commits at another.
  // A writer that never takes the advisory lock — the full-chain quiesce harness writing
  // plugin_xero_enabled over raw SQL, an e2e fixture upsert, resetDatabase deleting every settings
  // row — could commit a switch in between, and the rows just marked CANCELLED then belonged to the
  // connector that had just become ACTIVE. Nothing re-checks after the check.
  //
  // Injected AFTER the fence has already passed (the survivor count is the first thing that runs
  // past it), which is what makes this test different from the four below: there is no later check
  // that could catch it. Only the row lock can.
  state.activeConnector = 'xero'
  let bypass: Promise<void> = Promise.resolve()
  state.onCount = () => { bypass = commitBypassingWrite('quickbooks') }

  const result = await cancel('quickbooks')
  await bypass

  assert.equal(result.success, true, 'the cancel was correct when it started and is allowed to finish')
  assert.equal(result.cancelled, 3)
  assert.deepEqual(state.transactions, ['committed'])
  assert.equal(
    state.ops[(state.bypassLandedAfterOps ?? 0) - 1],
    'tx-end',
    'the bypassing switch landed only AFTER the transaction ended — it was held off by the row lock, '
      + 'not merely un-noticed. Without the FOR UPDATE it lands during the count, which is PAST the '
      + 'generation check: QuickBooks becomes active while its own queue is being retired, and '
      + 'nothing left in the transaction can notice.',
  )
  assert.equal(state.bypassLandedAfterOps, state.ops.length, 'and it was the last thing to happen')
})

test('a switch landing between scope resolution and the update ABORTS — the new active queue survives', async () => {
  // Xero is active; the operator cancels the QuickBooks orphans. Mid-update another administrator
  // switches to QuickBooks. Those rows are now the LIVE queue.
  state.activeConnector = 'xero'
  state.onUpdate = () => { state.activeConnector = 'quickbooks' }

  const result = await cancel('quickbooks')

  assert.equal(result.success, false)
  assert.equal(result.cancelled, 0, 'and it reports discarding nothing, because it discarded nothing')
  assert.match(result.error ?? '', /connector changed/i)
  assert.deepEqual(state.transactions, ['rolled-back'], 'the update was rolled back, not merely re-counted')
  assert.deepEqual(
    state.activity.map((a) => a.action),
    ['accounting_sync_orphans_cancel_aborted'],
    'no "cancelled N rows" is written — the permanent log must not claim work was discarded',
  )
  assert.match(state.activity[0].description, /now ACTIVE/, 'and it says why, for the operator who saw nothing happen')
})

test('the UNSCOPED cancel is fenced too — it is the one that can wipe every connector at once', async () => {
  // With Xero active, `cancel()` scopes to "not xero". If QuickBooks becomes active mid-flight the
  // same update has just retired the incoming connector's queue.
  state.activeConnector = 'xero'
  state.onUpdate = () => { state.activeConnector = 'quickbooks' }

  const result = await cancel()

  assert.equal(result.success, false)
  assert.deepEqual(state.transactions, ['rolled-back'])
})

test('a switch that lands in the OTHER direction aborts as well — "none" is a different selection', async () => {
  // Both accounting plugins turned off mid-cancel. The scope was derived against xero-active; with
  // no connector active an unscoped cancel is refused outright, so completing under the old sample
  // would apply a rule the current state forbids.
  state.activeConnector = 'xero'
  state.onUpdate = () => { state.activeConnector = null }

  const result = await cancel()

  assert.equal(result.success, false)
  assert.deepEqual(state.transactions, ['rolled-back'])
  assert.match(state.activity[0].description, /changed from xero to none/)
})

test('an undisturbed cancel still commits, cancels, and logs exactly as before', async () => {
  // The fence must not turn ordinary use into a refusal.
  state.activeConnector = 'xero'
  state.pending = 4
  state.processing = 2

  const result = await cancel('quickbooks')

  assert.deepEqual(result, { success: true, cancelled: 4, inFlightNotCancelled: 2 })
  assert.deepEqual(state.transactions, ['committed'])
  assert.deepEqual(state.activity.map((a) => a.action), ['accounting_sync_orphans_cancelled'])
  // Round 2/3 invariants, unchanged by the fence.
  assert.match(JSON.stringify(state.updates[0].where), /"status":"PENDING"/)
  assert.ok(!JSON.stringify(state.updates[0].where).includes('PROCESSING'), 'PROCESSING is still never retired')
  assert.equal(state.updates[0].data.status, 'CANCELLED')
  assert.match(state.activity[0].description, /2 row\(s\) were NOT cancelled/)
})

test('the pre-existing refusals still refuse, and no longer write anything at all', async () => {
  state.activeConnector = 'xero'
  const active = await cancel('xero')
  assert.equal(active.success, false)
  assert.match(active.error ?? '', /active connector/)
  assert.deepEqual(state.updates, [], 'refused before any update')

  reset()
  state.activeConnector = null
  const unscoped = await cancel()
  assert.equal(unscoped.success, false)
  assert.match(unscoped.error ?? '', /specify which connector/)
  assert.deepEqual(state.updates, [], 'a transient both-plugins-off state still cannot wipe every queue')
})

test('the LOCKED resolution and the POOLED one answer identically for every combination', async () => {
  // Round 6 replaced the cancel's pooled getActiveConnector() with resolveActiveAccountingConnector
  // over a locked read. Two sources for one question is only safe while it is ONE rule, and the
  // objection round 5 raised against exactly this — "two definitions of which connector is active
  // is a worse bug than the extra connection" — is correct in general. It is answered by keeping
  // the rule in one pure function and pinning the agreement here, over every input, rather than by
  // asserting it in a comment.
  const { getAccountingIntegrationConnector } = await import('@/app/actions/accounting-sync')
  const { resolveActiveAccountingConnector } = await import('@/lib/integration-plugin-selection-lock')

  for (const [xero, quickbooks] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    // The pooled path is driven by isIntegrationPluginEnabled, which this file's double answers
    // from state.activeConnector — so it can only express one at a time. The both-on case is
    // therefore checked against the resolver alone, and it is the case that matters most: it is
    // the invalid state finding 1 could produce, and Xero-first is what silently picks a winner.
    if (xero && quickbooks) {
      assert.equal(resolveActiveAccountingConnector({ xero, quickbooks }), 'xero')
      continue
    }
    state.activeConnector = xero ? 'xero' : quickbooks ? 'quickbooks' : null
    const pooled = await getAccountingIntegrationConnector()
    assert.equal(
      pooled?.id ?? null,
      resolveActiveAccountingConnector({ xero, quickbooks }),
      `xero=${xero} quickbooks=${quickbooks}`,
    )
  }
})

test('the generic key-value writer is still not a way around the lock', async () => {
  // The generic settings writer takes no connector-selection lock, so it must REFUSE the plugin keys
  // rather than quietly providing an unlocked, non-atomic path to the same rows.
  //
  // WHAT THIS TEST USED TO BE, and why it was wrong TWICE. First it grepped app/actions/settings.ts
  // for the strings ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY and pg_advisory_xact_lock — a spelling
  // check, which would have failed the moment round 6 factored the lock into a shared helper. Then
  // it grepped the body of `setSetting` for INTEGRATION_PLUGIN_SETTING_KEYS — still a spelling
  // check, and it broke silently in round 9 when `setSetting` became a one-line delegate to
  // `setSettings` and the guard moved with the write. A source scan pinned to one function name
  // cannot survive that function being refactored; the BEHAVIOUR can.
  const { setSetting, setSettings } = await import('@/app/actions/settings')
  const transactionsBefore = state.transactions.length

  await assert.rejects(
    () => setSetting('plugin_xero_enabled', 'true'),
    /must be written atomically and under the connector-selection lock/,
  )
  // ...and through the multi-key form, including when a plugin key is smuggled in alongside
  // innocent ones.
  await assert.rejects(
    () => setSettings({ public_app_url: 'https://x', plugin_quickbooks_enabled: 'true' }),
    /must be written atomically and under the connector-selection lock/,
  )

  // Refused BEFORE the transaction is even opened, so the innocent key beside it is not written
  // either — a partial apply there would be the multi-key version of the same defect.
  assert.equal(
    state.transactions.length,
    transactionsBefore,
    'nothing in a refused batch reaches the database',
  )
})

// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT PROVEN HERE, stated because the previous round overstated it.
//
// PROVEN: the action takes the advisory lock and the row lock BEFORE it reads, reads the selection
// through the transaction, holds both to commit, and rolls back rather than committing a decision
// made against a selection that moved. All of that lives in our code and all of it is asserted
// above against the statements the action really issues.
//
// NOT PROVEN: that `pg_advisory_xact_lock` and `SELECT ... FOR UPDATE` actually block a second
// session. That is Postgres's behaviour, the row lock above is a model of it, and no test in this
// file runs against a live database — so the protocol is verified STRUCTURALLY and its enforcement
// is taken on Postgres's documented semantics. Two concurrent connections contending for real would
// need a live-Postgres test in tests/concurrency/ (the *.concurrent.test.ts convention).
// ---------------------------------------------------------------------------

test('the cancel RECORDS that no remote call was made, on the same update as the status (o3d-o97 r6)', async () => {
  // The only positive evidence anywhere in the system that a cancelled row's journal is in NO
  // ledger. `recreateMissingDailyBatchLogs` rebuilds a daily batch only when it can see this, and
  // refuses on every other cancelled row — so a sweep that stopped writing it would not corrupt
  // anything, it would quietly strand every batch lost to a connector switch.
  //
  // It must be written by the SAME statement as the status and under the SAME `status: 'PENDING'`
  // predicate, because that predicate is the entire proof: a PENDING row is pre-call, nothing was
  // sent. A second statement, or a wider predicate, would let a row carry the claim without it.
  state.activeConnector = 'xero'
  state.pending = 4
  state.processing = 0

  const result = await cancel('quickbooks')

  assert.equal(result.success, true)
  assert.equal(state.updates.length, 1, 'one statement, so the claim cannot outlive its predicate')
  assert.match(JSON.stringify(state.updates[0].where), /"status":"PENDING"/)
  assert.equal(state.updates[0].data.status, 'CANCELLED')
  assert.equal(
    state.updates[0].data.abandonedBeforeRemoteCall,
    true,
    'without this the recreate sweep can never tell this row from one abandoned mid-flight',
  )
})
