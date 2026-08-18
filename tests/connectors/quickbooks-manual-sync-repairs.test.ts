import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r6 — the MANUAL QuickBooks sync must not run the back-reference repair sweep either.
//
// This is the tempting one. The manual sync is the button an operator presses right after linking a
// bill by hand, so an earlier revision of this branch bound the sweep here as well as in the cron.
// It was removed for the same reason: repairAccountingBackReferences is scoped by `connector` alone,
// a QuickBooks external id is only meaningful inside one realm, and disconnecting drops the
// expected-realm pin — so after a reconnect to a different company the sweep can write a retired
// company's id onto a live document, which the payment poller then acts on as current. Failing to
// repair is acceptable; repairing onto the wrong document is not.
//
// The operator is not left guessing: updateBackReference's ambiguity and failure warnings say in as
// many words that nothing retries a QuickBooks back-reference and the link must be made by hand.
// This asserts the absence, because re-adding the call is one line and no other test would notice.
// Precondition for re-adding it: o3d-s36z (connector-tenant isolation).
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
// Deliberately still offered by the double, so a re-added call is RECORDED rather than failing as a
// missing import — the failure must read as "the binding came back", not as "the test is broken".
mock.module('@/lib/connectors/quickbooks/sync-processor', {
  namedExports: {
    repairQuickBooksBackReferences: async () => {
      calls.push('repair')
      return { scanned: 5, checked: 2, repaired: 2, failed: 0, skippedAmbiguous: 1 }
    },
  },
})

test('[o3d-9kek r6] the manual QuickBooks sync does NOT run the back-reference repair sweep', async () => {
  calls.length = 0
  activities.length = 0
  const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')

  const result = await triggerQuickBooksSync()
  assert.equal(result.success, true)
  assert.deepEqual(calls, ['process'], 'no sweep: it can attribute a previous realm\'s external id (o3d-s36z)')

  const logged = activities.find((entry) => entry.action === 'quickbooks_manual_sync')
  assert.ok(logged)
  // Not reported as an empty repair result either — that would read as "a sweep ran and found
  // nothing", which is precisely the false reassurance this removal exists to avoid.
  assert.equal('backReferenceRepair' in (logged.metadata ?? {}), false)
})
