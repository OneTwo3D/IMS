import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek — the sweep's two anti-starvation dependencies are WIRED in the Xero binding, and there
// is NO QuickBooks binding at all.
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
//
// THE SECOND TEST ASSERTS AN ABSENCE, which is the r6 correction. A QuickBooks binding briefly
// existed on this branch and was removed: the candidate query is scoped by `connector` alone, and a
// QuickBooks external id is only meaningful inside ONE realm, so after a reconnect to a different
// company the sweep could write a retired realm's id onto a live document — and the global unique
// index does not stop it, because when no local row holds the orphaned id the write succeeds.
// Re-adding it is a one-line change that no other test would notice, so the absence is asserted
// here. Precondition for re-adding: o3d-s36z.
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

test('[o3d-9kek] the Xero sweep binding passes a persisted cursor store and the confirming logger', async () => {
  captured.length = 0
  cursorStoreConnectors.length = 0
  const mod = await import('@/lib/connectors/xero/sync-processor')
  await mod.repairXeroBackReferences()

  assert.equal(captured.length, 1)
  const { deps } = captured[0]
  assert.equal(deps.connector, 'xero')
  // r3 finding 4: without this the run restarts at the head every time, so a failing head starves
  // everything behind it across runs — and no per-row marker can fix it, because those rows are
  // precisely the ones that must NOT be marked.
  assert.equal(deps.cursorStore, CURSOR_STORE, 'the sweep must resume where the last run stopped')
  assert.deepEqual(cursorStoreConnectors, ['xero'], 'one cursor per connector, never shared')
  // r2 finding 3: the deferral is only justified by a warning that actually landed, and the plain
  // logActivity swallows its write errors — awaiting it proves nothing.
  assert.equal(deps.logActivity, logActivityPersisted, 'the deferral needs a CONFIRMED warning')
})

test('[o3d-9kek r6] QuickBooks exports NO back-reference sweep binding, and never runs the sweep', async () => {
  captured.length = 0
  cursorStoreConnectors.length = 0

  const processor = await import('@/lib/connectors/quickbooks/sync-processor') as Record<string, unknown>
  const index = await import('@/lib/connectors/quickbooks') as Record<string, unknown>

  for (const [label, mod] of [['sync-processor', processor], ['connector index', index]] as const) {
    const sweepExports = Object.keys(mod).filter((name) => /repair.*BackReference/i.test(name))
    assert.deepEqual(
      sweepExports,
      [],
      `${label} must not export a back-reference repair sweep for QuickBooks: the sweep is scoped by connector `
      + 'alone and a QuickBooks id is realm-local, so it can stamp a previous realm\'s id onto a live document. '
      + 'Close o3d-s36z before re-adding it.',
    )
  }

  // Nothing merely importing the QuickBooks processor may reach the sweep either — a module-level
  // call or a re-export under a different name would be caught here rather than in production.
  assert.deepEqual(captured, [], 'no QuickBooks sweep run')
  assert.deepEqual(cursorStoreConnectors, [], 'no QuickBooks sweep cursor')
})
