import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// DRIVEN BY THE REGISTRY (o3d-0bfh r8, Codex MEDIUM). The declarations below are not restated here:
// a connector's entry in ACCOUNTING_FOLLOW_UP_RECOVERY is the claim, and the tests at the bottom of
// this file are what CHECKS it, by invoking the real cron route and asserting whether that
// connector's sweep binding was actually reached. Adding a connector to the registry adds a contract
// assertion for it automatically — and it fails until somebody wires the mock for it here, which is
// the right way round.
//
// It is imported before every mock.module below on purpose: this module reads no database and mocks
// nothing, so loading it early cannot be affected by, or affect, the doubles.
import { ACCOUNTING_FOLLOW_UP_RECOVERY } from '@/lib/domain/accounting/follow-up-obligation-registry'

// ---------------------------------------------------------------------------
// o3d-9kek — which cron branch runs the back-reference repair sweep.
//
// XERO RUNS IT. audit-H3: a document whose back-reference was never written (the process died after
// the connector post, or the retries exhausted to FAILED) is otherwise orphaned forever.
//
// A connector without a binding is deliberate where its external ids could collide across tenants:
// repairAccountingBackReferences scopes its candidate query by `connector` and nothing else, so a
// connector whose ids are small per-tenant integers could, after a reconnect to a different tenant,
// write a retired tenant's id onto a live document. The global unique index does not cover it: it
// only stops a second local row taking an id another row holds. Failing to repair is acceptable;
// repairing onto the wrong document is not.
// ---------------------------------------------------------------------------

type Call = { connector: string; what: 'process' | 'repair' }

const calls: Call[] = []
let enabledPlugin = 'xero'

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

test('[o3d-9kek] the Xero cron branch DOES run it (its ids are GUIDs, so it has no cross-tenant exposure)', async () => {
  const body = await runCron('xero')

  assert.deepEqual(calls.filter((call) => call.what === 'repair'), [{ connector: 'xero', what: 'repair' }])
  // Reported, not swallowed: an operator reading the cron result must be able to see what the
  // repair pass did.
  assert.deepEqual(body.backReferenceRepair, REPAIR_RESULT)
})

// ---------------------------------------------------------------------------
// THE CONTRACT, DRIVEN BY THE REGISTRY (o3d-0bfh r8, Codex MEDIUM).
//
// The two tests above assert the behaviour this file has always been about, connector by connector.
// What they did NOT do is tie that behaviour to the DECLARATION an operator is shown. The registry
// says of each connector either "a sweep re-reads the retained marker" or "nothing does, here is
// what a human must do instead"; nothing executed anything to find out whether that was true, and
// the registry test could only check that a file with the right name mentioned the right strings.
//
// So the loop below asks the real entry point. For every connector in the registry it drives the
// actual cron GET under that connector's branch and asserts that the connector's own sweep double —
// the exact function, not a name in a text scan — was called if and only if the connector declares
// `consumer: 'sweep'`. A connector added to the registry gets an assertion here whether or not
// anybody remembers to write one.
// ---------------------------------------------------------------------------

/** Which connectors this file has doubles for. Asserted to cover the registry, never to define it. */
// This list is asserted to COVER the registry, never to define it, so a connector declared without a
// double here still fails — which is the property.
const CONTRACTED_CONNECTORS = ['xero'] as const

test('[o3d-0bfh r8] CONTRACT: every registry entry is checked against what the real cron route does', async () => {
  const declared = Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY)
  assert.ok(declared.length > 0, 'the registry must declare something, or this loop asserts nothing')
  for (const connector of declared) {
    assert.ok(
      (CONTRACTED_CONNECTORS as readonly string[]).includes(connector),
      `${connector} is declared in ACCOUNTING_FOLLOW_UP_RECOVERY but this file has no double for it, so its `
        + 'declaration is checked by nothing. Add the double and list it in CONTRACTED_CONNECTORS.',
    )
  }

  for (const [connector, recovery] of Object.entries(ACCOUNTING_FOLLOW_UP_RECOVERY)) {
    await runCron(connector)

    const swept = calls.some((call) => call.connector === connector && call.what === 'repair')
    // The precondition: this run really did reach the connector's branch. Without it a route that
    // returned `skipped` early would satisfy every `consumer: 'none'` entry for the wrong reason.
    assert.ok(
      calls.some((call) => call.connector === connector && call.what === 'process'),
      `the cron route never reached the ${connector} branch, so this run establishes nothing about it`,
    )
    assert.equal(
      swept, recovery.consumer === 'sweep',
      recovery.consumer === 'sweep'
        ? `${connector} declares consumer: 'sweep', but driving the real cron route did not call its sweep. The `
          + 'operator is being told a payment will be re-enqueued by something that never runs.'
        : `${connector} declares consumer: 'none' — and its remedy tells a human to act by hand — but driving the `
          + 'real cron route DID call a sweep for it. The declaration and the code have drifted.',
    )
  }
})
