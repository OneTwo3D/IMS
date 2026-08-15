import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

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
  /** Runs the moment the fenced updateMany is issued — the exact window the finding describes. */
  onUpdate: null as null | (() => void),
  updates: [] as UpdateArgs[],
  counts: [] as unknown[],
  /** Raw statements the transaction issued, in order. The lock must be the first. */
  raw: [] as string[],
  /** How the transaction ended. */
  transactions: [] as Array<'committed' | 'rolled-back'>,
  activity: [] as Array<{ action: string; description: string }>,
  pending: 3,
  processing: 0,
}

function reset() {
  state.role = 'ADMIN'
  state.activeConnector = null
  state.onUpdate = null
  state.updates = []
  state.counts = []
  state.raw = []
  state.transactions = []
  state.activity = []
  state.pending = 3
  state.processing = 0
}

const accountingSyncLog = {
  updateMany: async (args: UpdateArgs) => {
    state.updates.push(args)
    // The switch lands HERE: after the action resolved its scope, while the update is in flight.
    state.onUpdate?.()
    return { count: state.pending }
  },
  count: async (args: unknown) => {
    state.counts.push(args)
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
          const result = await callback({ accountingSyncLog, $executeRaw: rawInTx })
          state.transactions.push('committed')
          return result
        } catch (error) {
          state.transactions.push('rolled-back')
          throw error
        }
      },
    },
  },
})

/** Records the raw SQL a transaction issues, tagged-template style. */
async function rawInTx(strings: TemplateStringsArray, ...values: unknown[]) {
  state.raw.push(strings.raw.map((s, i) => s + (i < values.length ? String(values[i]) : '')).join(''))
  return 1
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
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id },
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

test('the whole decision runs in ONE transaction, and the lock is taken before anything is read', async () => {
  state.activeConnector = 'xero'

  await cancel('quickbooks')

  assert.deepEqual(state.transactions, ['committed'], 'exactly one transaction, and it committed')
  assert.equal(state.raw.length, 1, 'one statement before the work: the lock')
  assert.match(state.raw[0], /pg_advisory_xact_lock/)
  assert.ok(
    state.raw[0].includes(String(ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY)),
    'and it is the SAME lock the plugin-state writers take — a private key would serialize nothing',
  )
  assert.equal(state.updates.length, 1, 'the update ran inside it')
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

test('the connector-selection writers take the SAME lock — otherwise it serializes nothing', async () => {
  // The lock only binds writers that take it. Both paths that change which accounting connector is
  // active must, or the fence below them is doing all the work alone.
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')

  for (const file of [['app', 'actions', 'settings.ts'], ['app', 'actions', 'onboarding.ts']]) {
    const src = read(...file)
    assert.match(src, /ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY/, `${file.join('/')} must take the selection lock`)
    assert.match(src, /pg_advisory_xact_lock/, `${file.join('/')} must actually issue it`)
  }

  // And the generic key-value writer must no longer be a way around them.
  const settings = read('app', 'actions', 'settings.ts')
  const setSetting = settings.slice(settings.indexOf('export async function setSetting'))
  assert.match(
    setSetting.slice(0, setSetting.indexOf('\n}\n')),
    /INTEGRATION_PLUGIN_SETTING_KEYS/,
    'setSetting must refuse the plugin keys rather than writing them unlocked',
  )
})
