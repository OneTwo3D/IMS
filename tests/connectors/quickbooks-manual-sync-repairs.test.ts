import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r3 finding 2, the second wiring point. The cron is where the sweep matters unattended,
// but the MANUAL sync is where it matters to a person: the ambiguity warning asks an operator to
// link a bill by hand, and the obvious next thing they do is press Sync. If that path does not
// sweep, the row they have just made repairable waits for the next cron cycle while the UI reports
// a successful sync — which reads as "and nothing was left over".
// ---------------------------------------------------------------------------

const calls: string[] = []
const activities: Array<{ action: string; metadata?: Record<string, unknown> }> = []

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'user-1' }),
    requireFreshPermission: async () => ({ id: 'user-1' }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/db', {
  namedExports: { db: { setting: { findUnique: async () => ({ value: 'true' }) } } },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { activities.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/connectors/quickbooks', {
  namedExports: {
    getAuthorizationUrl: async () => '',
    disconnect: async () => {},
    isConnected: async () => ({ connected: true }),
    syncChartOfAccounts: async () => ({ synced: 0, errors: [] }),
    getQuickBooksTaxCodes: async () => [],
    processPendingQuickBooksSync: async () => {
      calls.push('process')
      return { succeeded: 2, failed: 0, skipped: 0 }
    },
  },
})
mock.module('@/lib/connectors/quickbooks/sync-processor', {
  namedExports: {
    repairQuickBooksBackReferences: async () => {
      calls.push('repair')
      return { scanned: 5, checked: 2, repaired: 2, failed: 0, skippedAmbiguous: 1 }
    },
  },
})

test('[o3d-9kek r3 f2] the manual QuickBooks sync also runs the back-reference repair sweep', async () => {
  calls.length = 0
  activities.length = 0
  const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')

  const result = await triggerQuickBooksSync()
  assert.equal(result.success, true)
  assert.deepEqual(calls, ['process', 'repair'], 'sweep after processing, so this cycle\'s rows are included')

  // Surfaced, not swallowed: the activity entry is the operator's record that the retry ran.
  const logged = activities.find((entry) => entry.action === 'quickbooks_manual_sync')
  assert.ok(logged)
  assert.deepEqual(logged.metadata?.backReferenceRepair, { scanned: 5, checked: 2, repaired: 2, failed: 0, skippedAmbiguous: 1 })
})
