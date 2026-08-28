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
// here.
//
// THE PRECONDITION IT NAMED HAS BEEN MET AND WAS THE WRONG ONE (o3d-0bfh r5, Codex HIGH). This said
// "Precondition for re-adding: o3d-s36z". o3d-s36z CLOSED on 2026-08-21, and a row's realm is now
// durably recorded (`AccountingSyncLog.connectionProvenance`, o3d-dzip) — so the CANDIDATE FENCE is
// derivable today. The SELECT side was never the whole problem: QuickBooks does not enforce the
// connection verdict at POST time (o3d-8prh, open — `accounting-posting-intent` and
// `accounting-egress-authorization` are imported by the Xero connector and by nothing under
// lib/connectors/quickbooks/), and this connector's own `enqueueFollowUpSyncLog` mints no
// `connectionProvenance`, so every row a sweep created would be born `no-origin-recorded` and posted
// unchecked. A stale precondition on a money path is an invitation: whoever read the old line would
// find it satisfied and wire the binding. The real order of work is in the block at the end of
// lib/connectors/quickbooks/sync-processor.ts.
// ---------------------------------------------------------------------------

const CURSOR_STORE = { load: async () => null, save: async () => {} }
const captured: Array<{ connector: string; deps: Record<string, unknown> }> = []
const cursorStoreConnectors: string[] = []

const logActivityPersisted = async () => true

// ---------------------------------------------------------------------------
// WHAT THE BEHAVIOURAL TEST BELOW NEEDS, AND ONLY THAT.
//
// The real `enqueueFollowUps` has to RUN for its answer to be worth anything, so the modules under
// it are doubled rather than the function itself. Two of them carry meaning:
//
//   • `registerDeferredOrderReceipts` is the deferred-receipt dependency whose answer the whole
//     obligation rests on. Made to report UNSETTLED, it is the fact the assertion follows.
//   • the database is a permissive recorder. Nothing is asserted about it: it exists so the
//     INVOICE_PDF enqueue on the way to the re-drive can complete, and it deliberately answers the
//     benign shape for every call so that no branch of the enqueue can be the thing this test is
//     really measuring.
// ---------------------------------------------------------------------------
const deferredReceipts = {
  settled: true,
  obligation: null as {
    syncLogId: string
    generation: Date | null
    /** o3d-0bfh r16: the caller's settlement prerequisite, present only when one was handed over. */
    settlementPrerequisite?: () => Promise<boolean>
  } | null,
}

mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
  namedExports: {
    // o3d-0bfh r15: the OBLIGATION the binding handed down is recorded. It is the value the re-drive
    // clears under the sales-order lock, so a binding that dropped it would leave the marker to be
    // cleared unfenced by the caller — the finding — with `settled` still travelling correctly.
    registerDeferredOrderReceipts: async (
      _orderId: string,
      _posted: unknown,
      obligation: NonNullable<typeof deferredReceipts.obligation> | null,
    ) => {
      deferredReceipts.obligation = obligation
      return { settled: deferredReceipts.settled, reason: 'registered', release: 'released' }
    },
  },
})

const dbCalls: string[] = []
function tableDouble(table: string): Record<string, unknown> {
  return new Proxy({}, {
    get: (_target, method: string) => async (..._args: unknown[]) => {
      dbCalls.push(`${table}.${method}`)
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'create') return { id: `${table}-created` }
      if (method === 'updateMany') return { count: 1 }
      return null
    },
  })
}
const dbDouble: Record<string, unknown> = new Proxy({}, {
  get: (_target, key: string) => {
    if (key === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(dbDouble)
    if (key === '$executeRaw' || key === '$executeRawUnsafe' || key === '$queryRaw' || key === '$queryRawUnsafe') {
      return async () => 0
    }
    if (key === 'then') return undefined
    return tableDouble(key)
  },
})

mock.module('@/lib/db', { namedExports: { db: dbDouble } })
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

// ---------------------------------------------------------------------------
// o3d-0bfh r2 (Codex MEDIUM) — THE IDENTITY TEST DID NOT ENFORCE IDENTITY.
//
// What stood here compared the dependency across two invocations and checked its `.name`. Neither
// assertion reaches the thing that matters. Renaming the implementation and adding a module-level
// `async function enqueueFollowUps(...)` that awaits it and returns a hardcoded
// `{ deferredReceiptsSettled: true }` passes BOTH — a module-level function is one object across
// calls (the old comment said so itself, as a "residual") and it carries exactly that name. That
// mutation recreates the original financial regression with the test still green, which makes
// passing-by-reference current practice rather than something enforced.
//
// SO THE ASSERTION IS BEHAVIOURAL, AT THE SEAM. The real deferred-receipt dependency is made to
// report UNSETTLED and the CAPTURED dependency — the exact object the binding handed the sweep — is
// invoked. The unsettled answer must come back out unchanged. Anything in between that drops,
// fabricates or narrows it fails here, whatever it is called and however it is hoisted, and it
// keeps working across refactors that an identity check would break on.
//
// MUTATION RUN: `enqueueFollowUps` renamed to `enqueueFollowUpsImpl`, with a new module-level
// `async function enqueueFollowUps(...)` that awaits it and returns a hardcoded
// `{ deferredReceiptsSettled: true }`. Verified in one run: the old identity + `.name` assertions
// BOTH pass under it, and the unsettled test below FAILS. That is the whole finding.
// ---------------------------------------------------------------------------

/**
 * Clear what the re-drive double captured. A function rather than an inline `= null`, so the
 * property's DECLARED type survives: an assignment narrows it to `null` for the rest of the test
 * body and TypeScript then refuses to read the fields the assertions are about.
 */
function forgetCapturedObligation(): void {
  deferredReceipts.obligation = null
}

/** The generation the sweep claims before its enqueue — the value that must reach the re-drive. */
const SWEEP_GENERATION = new Date('2026-08-01T00:00:00.000Z')

test('[o3d-0bfh r2] an UNSETTLED deferred receipt reaches the sweep unchanged through the binding', async () => {
  captured.length = 0
  deferredReceipts.settled = false
  dbCalls.length = 0

  const mod = await import('@/lib/connectors/xero/sync-processor')
  await mod.repairXeroBackReferences()
  assert.equal(captured.length, 1)

  const enqueueFollowUps = captured[0].deps.enqueueFollowUps as (
    entryId: string,
    type: string,
    referenceType: string,
    referenceId: string,
    payload: Record<string, unknown>,
    syncResult: { externalId?: string; invoiceNumber?: string },
    origin: { payload: unknown; connectionProvenance: string | null; backReferenceEvidenceCompactedAt: Date | null },
    followUpObligation: Date | null,
  ) => Promise<{ deferredReceiptsSettled: boolean; obligationFenced: boolean }>
  assert.equal(typeof enqueueFollowUps, 'function')

  deferredReceipts.obligation = null
  const outcome = await enqueueFollowUps(
    'log-1', 'SALES_INVOICE', 'SalesOrder', 'so-1', {}, { externalId: 'XINV-1' },
    // The seventh argument is the posting row's ORIGIN record (o3d-bqw7 r2). It is supplied because
    // the signature demands it, not because this test is about it: what is under test is that the
    // SETTLEMENT ANSWER survives the seam, and an origin that records nothing is the least
    // interesting one to send through it.
    { payload: {}, connectionProvenance: null, backReferenceEvidenceCompactedAt: null },
    // o3d-0bfh r15: the EIGHTH is the obligation generation the sweep claimed. It has to reach the
    // re-drive, because that is what clears the marker inside the order lock.
    SWEEP_GENERATION,
  )

  assert.deepEqual(
    outcome,
    { deferredReceiptsSettled: false, obligationFenced: true },
    'the sweep discharges a durable money obligation on this answer: an adapter that hardcoded true '
      + 'here is the exact regression o3d-0bfh fixed, and it would be invisible to every other test',
  )
  assert.deepEqual(
    deferredReceipts.obligation,
    { syncLogId: 'log-1', connector: 'xero', generation: SWEEP_GENERATION, recovery: { consumer: 'sweep' } },
    'o3d-0bfh r15: and the GENERATION reaches the re-drive, which is what lets the release be taken '
      + 'inside the same transaction as the receipt re-read. A binding that dropped it would leave '
      + 'the marker to be cleared outside the lock, which is the whole finding.',
  )
  // The real implementation was reached rather than something that short-circuits before the
  // re-drive: an enqueue that never ran could report false for the wrong reason.
  assert.ok(dbCalls.length > 0, 'the enqueue actually ran against the database seam')
})

test('[o3d-0bfh r2] and a SETTLED one is not turned into a refusal either', async () => {
  // The other direction, so the test above cannot be satisfied by a binding that answers false
  // unconditionally — which would strand every repaired row instead of losing it.
  captured.length = 0
  deferredReceipts.settled = true

  const mod = await import('@/lib/connectors/xero/sync-processor')
  await mod.repairXeroBackReferences()

  const enqueueFollowUps = captured[0].deps.enqueueFollowUps as (
    ...args: unknown[]
  ) => Promise<{ deferredReceiptsSettled: boolean; obligationFenced: boolean }>
  const outcome = await enqueueFollowUps('log-1', 'SALES_INVOICE', 'SalesOrder', 'so-1', {}, { externalId: 'XINV-1' },
    { payload: {}, connectionProvenance: null, backReferenceEvidenceCompactedAt: null }, SWEEP_GENERATION)

  assert.deepEqual(outcome, { deferredReceiptsSettled: true, obligationFenced: true })
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
      + 'alone and a QuickBooks id is realm-local, so it can stamp a previous realm\'s id onto a live document, '
      + 'and this connector checks no connection verdict at post time. o3d-s36z has closed and is NOT the '
      + 'remaining blocker — o3d-8prh is; read the block at the end of the QuickBooks sync-processor for the '
      + 'order of work before re-adding it (o3d-8prh).',
    )
  }

  // Nothing merely importing the QuickBooks processor may reach the sweep either — a module-level
  // call or a re-export under a different name would be caught here rather than in production.
  assert.deepEqual(captured, [], 'no QuickBooks sweep run')
  assert.deepEqual(cursorStoreConnectors, [], 'no QuickBooks sweep cursor')
})

// ---------------------------------------------------------------------------
// o3d-0bfh r16 (Codex HIGH) — AND THE CALLER'S SETTLEMENT PREREQUISITE REACHES THE FENCE TOO.
//
// r15 got the generation down to the re-drive so the clear could be taken under the sales-order
// lock. That put the clear BEFORE the sweep's own terminal warnings, which are what permit the row
// to be settled at all — so the sweep now hands its condition down alongside the generation, and the
// fence answers it between its re-read and its release.
//
// This is the same class of seam assertion as the one above and needs to be made here for the same
// reason: the sweep's own tests inject their own enqueue, so a binding that accepted the argument
// and dropped it on the floor would leave all of them green while the release went back to
// outrunning the warning. Nothing in the RETURN VALUE would differ.
// ---------------------------------------------------------------------------

test('[o3d-0bfh r16] the SETTLEMENT PREREQUISITE the sweep hands down reaches the deferred-receipt fence', async () => {
  captured.length = 0
  deferredReceipts.settled = true
  forgetCapturedObligation()

  const mod = await import('@/lib/connectors/xero/sync-processor')
  await mod.repairXeroBackReferences()

  const enqueueFollowUps = captured[0].deps.enqueueFollowUps as (
    ...args: unknown[]
  ) => Promise<{ deferredReceiptsSettled: boolean; obligationFenced: boolean }>

  const prerequisite = async () => true
  await enqueueFollowUps(
    'log-1', 'SALES_INVOICE', 'SalesOrder', 'so-1', {}, { externalId: 'XINV-1' },
    { payload: {}, connectionProvenance: null, backReferenceEvidenceCompactedAt: null },
    SWEEP_GENERATION,
    // The NINTH argument: what the sweep must have made durable before that generation is cleared.
    prerequisite,
  )

  assert.equal(
    deferredReceipts.obligation?.settlementPrerequisite, prerequisite,
    'the fence has to be able to ASK it — a binding that drops it releases the obligation before the '
      + 'sweep has written the notice that permits the settlement, which is exactly r16',
  )
  assert.deepEqual(deferredReceipts.obligation?.generation, SWEEP_GENERATION, 'still alongside the generation')
})

test('[o3d-0bfh r16] and the POST path hands none, so it stays on the single fenced pass', async () => {
  // The control, and it is what keeps the field's ABSENCE meaningful: this processor has no
  // settlement write left after the enqueue, so it states no condition, and the fence must not
  // acquire a second pass — or a `settlementPrerequisite: undefined` key — on its account.
  captured.length = 0
  forgetCapturedObligation()

  const mod = await import('@/lib/connectors/xero/sync-processor')
  await mod.repairXeroBackReferences()

  const enqueueFollowUps = captured[0].deps.enqueueFollowUps as (
    ...args: unknown[]
  ) => Promise<{ deferredReceiptsSettled: boolean; obligationFenced: boolean }>
  await enqueueFollowUps('log-1', 'SALES_INVOICE', 'SalesOrder', 'so-1', {}, { externalId: 'XINV-1' },
    { payload: {}, connectionProvenance: null, backReferenceEvidenceCompactedAt: null }, SWEEP_GENERATION)

  assert.equal('settlementPrerequisite' in (deferredReceipts.obligation ?? {}), false,
    'not even as an explicitly-undefined key: absence is what selects the single-pass fence')
})
