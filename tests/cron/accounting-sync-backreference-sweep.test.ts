import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r3 finding 2 — QuickBooks DECLARED its back-reference failures repairable and no
// QuickBooks sweep existed.
//
// updateBackReference swallows its write failures (including the load-bearing P2002 from the
// bill's unique index) and logs "the back-reference repair sweep will retry it"; the PO-ambiguity
// path logs "link the bill manually" and returns success. Both are only defensible if something
// actually comes back to the row — and repairAccountingBackReferences was bound for Xero alone,
// while the QuickBooks cron branch merely processed pending rows. Those rows therefore stayed
// unlinked permanently, even after the ambiguity cleared, and the message the operator read was
// false.
//
// This asserts the WIRING, because the wiring is the defect. A test of the sweep function in
// isolation passes just as happily when nobody calls it.
// ---------------------------------------------------------------------------

type Call = { connector: string; what: 'process' | 'repair' }

const calls: Call[] = []
let enabledPlugin = 'quickbooks'

const REPAIR_RESULT = { scanned: 3, checked: 1, repaired: 1, failed: 0, skippedAmbiguous: 0 }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', {
  namedExports: { enforceCronRateLimit: async () => null, CRON_RATE_LIMIT_FIVE_MINUTE_MAX: 12 },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (plugin: string) => plugin === enabledPlugin },
})
mock.module('@/lib/accounting', { namedExports: { isAccountingConnectorConnected: async () => true } })
mock.module('@/lib/db', {
  namedExports: {
    db: { setting: { findUnique: async () => ({ value: 'true' }) } },
  },
})
mock.module('@/lib/domain/purchasing/landed-cost-journal-outbox', {
  namedExports: { processLandedCostJournalOutbox: async () => ({ drained: 0 }) },
})
mock.module('@/lib/connectors/quickbooks/sync-processor', {
  namedExports: {
    processPendingQuickBooksSync: async () => {
      calls.push({ connector: 'quickbooks', what: 'process' })
      return { succeeded: 1, failed: 0, skipped: 0 }
    },
    repairQuickBooksBackReferences: async () => {
      calls.push({ connector: 'quickbooks', what: 'repair' })
      return REPAIR_RESULT
    },
  },
})
mock.module('@/lib/connectors/xero/sync-processor', {
  namedExports: {
    processPendingXeroSync: async () => {
      calls.push({ connector: 'xero', what: 'process' })
      return { succeeded: 1, failed: 0, skipped: 0 }
    },
    repairXeroBackReferences: async () => {
      calls.push({ connector: 'xero', what: 'repair' })
      return REPAIR_RESULT
    },
    reenqueueMissingCreditNoteAllocations: async () => ({ checked: 0, enqueued: 0, failed: 0 }),
  },
})

function cronRequest(): Request {
  return new Request('https://ims.example.com/api/cron/accounting-sync', { headers: new Headers({ host: 'ims.example.com' }) })
}

async function runCron(plugin: string): Promise<Record<string, unknown>> {
  enabledPlugin = plugin
  calls.length = 0
  const { GET } = await import('@/app/api/cron/accounting-sync/route')
  const response = await GET(cronRequest())
  return await response.json() as Record<string, unknown>
}

test('[o3d-9kek r3 f2] the QuickBooks cron branch RUNS the back-reference repair sweep', async () => {
  const body = await runCron('quickbooks')

  assert.deepEqual(calls, [
    { connector: 'quickbooks', what: 'process' },
    { connector: 'quickbooks', what: 'repair' },
  ], 'the sweep must run AFTER processing, so rows this cycle posted are examined too')
  // Reported, not swallowed: an operator reading the cron result must be able to see that the
  // retry the warnings promise actually happened, and what it did.
  assert.deepEqual(body.backReferenceRepair, REPAIR_RESULT)
})

test('[o3d-9kek r3 f2] the Xero branch is unchanged — both connectors sweep, neither by copy', async () => {
  const body = await runCron('xero')

  assert.deepEqual(calls.filter((call) => call.what === 'repair'), [{ connector: 'xero', what: 'repair' }])
  assert.deepEqual(body.backReferenceRepair, REPAIR_RESULT)
})
