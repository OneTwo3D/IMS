import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek — which cron branch runs the back-reference repair sweep, and which deliberately does
// not.
//
// XERO RUNS IT. audit-H3: a document whose back-reference was never written (the process died after
// the connector post, or the retries exhausted to FAILED) is otherwise orphaned forever.
//
// QUICKBOOKS DELIBERATELY DOES NOT (r6). A binding existed briefly on this branch and was removed.
// repairAccountingBackReferences scopes its candidate query by `connector` and nothing else, and a
// QuickBooks external id is a small integer that only means anything inside ONE realm; disconnecting
// removes the expected-realm pin, so after reconnecting to company B an unresolved company-A row is
// still a candidate and the sweep would write company A's id onto a live document. The payment
// poller then treats that id as a company-B document and can mark the WRONG bill or order paid. The
// global unique index does not cover it: it only stops a second local row taking an id another row
// holds, and after a realm switch no local row holds the orphaned id at all.
//
// Failing to repair is acceptable; repairing onto the wrong document is not. So this file asserts
// the ABSENCE as firmly as the presence — re-adding the binding is one line, and no other test in
// the suite would go red.
//
// THE PRECONDITION THIS COMMENT USED TO NAME IS THE WRONG ONE (o3d-0bfh r6, Codex MEDIUM). It said
// o3d-s36z (connector-tenant isolation); that CLOSED on 2026-08-21 and a row's realm is recorded
// now, so a maintainer checking it would find it satisfied and add back the one line this file
// exists to forbid. The real prerequisites are POST-TIME AUTHORIZATION (o3d-8prh) and ORIGIN
// PROPAGATION on the follow-up rows a sweep would create — see the block at the end of
// lib/connectors/quickbooks/sync-processor.ts.
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
// The QuickBooks processor double DOES offer a sweep. That is the point: if the cron branch ever
// imports and calls one again, this double records it and the test below fails. A double that
// omitted the export would fail with an import error instead, which reads as a broken test rather
// than as the regression it is.
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

test('[o3d-9kek r6] the QuickBooks cron branch does NOT run the back-reference repair sweep', async () => {
  const body = await runCron('quickbooks')

  assert.deepEqual(calls, [
    { connector: 'quickbooks', what: 'process' },
  ], 'the sweep must not be bound for QuickBooks: it can attribute a previous realm\'s external id (o3d-s36z)')
  // Nothing to report, and reporting an absent sweep as an empty result would read as "it ran and
  // found nothing" — which is the opposite of the truth.
  assert.equal('backReferenceRepair' in body, false)
})

test('[o3d-9kek] the Xero cron branch DOES run it — Xero is the connector with no realm exposure', async () => {
  const body = await runCron('xero')

  assert.deepEqual(calls.filter((call) => call.what === 'repair'), [{ connector: 'xero', what: 'repair' }])
  // Reported, not swallowed: an operator reading the cron result must be able to see what the
  // repair pass did.
  assert.deepEqual(body.backReferenceRepair, REPAIR_RESULT)
})
