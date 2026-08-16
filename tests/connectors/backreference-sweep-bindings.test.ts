import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek — the sweep's two anti-starvation dependencies are WIRED, in both connectors.
//
// repairAccountingBackReferences takes them as optional deps, and every test of the sweep itself
// injects its own. So a binding that quietly stopped passing one would leave every sweep test green
// while production regressed:
//
//   • cursorStore absent → the scan restarts at the head on every invocation, and a persistently
//     failing oldest `limit` rows eat the whole budget forever (r3 finding 4);
//   • logActivity wired to the plain logActivity instead of logActivityPersisted → it always
//     resolves, so it always answers "persisted", and an ambiguity whose warning was LOST is still
//     deferred for 24 hours — the exact combination r2 finding 3 exists to forbid.
//
// Both are invisible to the sweep's own tests by construction. This asserts them at the seam.
// ---------------------------------------------------------------------------

const CURSOR_STORE = { load: async () => null, save: async () => {} }
const captured: Array<{ connector: string; deps: Record<string, unknown> }> = []
const cursorStoreConnectors: string[] = []

const logActivityPersisted = async () => true

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityPersisted },
})
mock.module('@/lib/domain/accounting/back-reference-sweep', {
  namedExports: {
    DEFAULT_BACK_REFERENCE_SWEEP_LIMIT: 200,
    createBackReferenceSweepCursorStore: (_db: unknown, connector: string) => {
      cursorStoreConnectors.push(connector)
      return CURSOR_STORE
    },
    repairAccountingBackReferences: async (deps: Record<string, unknown>) => {
      captured.push({ connector: deps.connector as string, deps })
      return { scanned: 0, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0, followUpsDiscarded: 0 }
    },
  },
})

for (const [label, modulePath, exportName, connector] of [
  ['Xero', '@/lib/connectors/xero/sync-processor', 'repairXeroBackReferences', 'xero'],
  ['QuickBooks', '@/lib/connectors/quickbooks/sync-processor', 'repairQuickBooksBackReferences', 'quickbooks'],
] as const) {
  test(`[o3d-9kek] the ${label} sweep binding passes a persisted cursor store and the confirming logger`, async () => {
    captured.length = 0
    cursorStoreConnectors.length = 0
    const mod = await import(modulePath) as Record<string, () => Promise<unknown>>
    await mod[exportName]()

    assert.equal(captured.length, 1)
    const { deps } = captured[0]
    assert.equal(deps.connector, connector)
    // r3 finding 4: without this the run restarts at the head every time, so a failing head starves
    // everything behind it across runs — and no per-row marker can fix it, because those rows are
    // precisely the ones that must NOT be marked.
    assert.equal(deps.cursorStore, CURSOR_STORE, 'the sweep must resume where the last run stopped')
    assert.deepEqual(cursorStoreConnectors, [connector], 'one cursor per connector, never shared')
    // r2 finding 3: the deferral is only justified by a warning that actually landed, and the plain
    // logActivity swallows its write errors — awaiting it proves nothing.
    assert.equal(deps.logActivity, logActivityPersisted, 'the deferral needs a CONFIRMED warning')
  })
}
