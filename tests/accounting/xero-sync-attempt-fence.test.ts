import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz — the Xero processor's half of the attempt fence, driven through the real
 * `processPendingXeroSync` loop.
 *
 * The row used here is a COGS_JOURNAL that already carries an externalTransactionId, so the loop
 * takes the "already posted, just record it" branch: no remote call, no back-reference, no
 * follow-ups. That leaves exactly the two writes under test — the claim, and the writeback.
 */

// Direct path: the outbox variant adds an IntegrationOutbox round-trip that says nothing about the
// sync-row fence.
process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
/** Runs once, on the next db.$transaction — i.e. between the claim and the writeback. */
let interleave: (() => void) | null = null
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

/**
 * o3d-e2mz r5: the SALES ORDER behind a row, which the fence-loss recovery now reads to decide
 * whether there is still a sale for the work to belong to. `null` makes the read THROW, which is the
 * unreadable case.
 *
 * A DOUBLE CORRECTION, not an addition: without this delegate every SalesOrder-referenced test in
 * this file was silently taking the unreadable branch (the stub had no `salesOrder`, so the read
 * threw), and the "a live sale still settles" property could not have been observed at all.
 */
let salesOrders: Map<string, { status: string }> | null = null

/**
 * o3d-e2mz r6: the ORDER of what the evidence write does, in one list — `lock`, then `read`, then the
 * row write. The fix is that the read is taken under the order's row lock INSIDE the writing
 * transaction, so a harness with no `$queryRaw` would send every SalesOrder test straight down the
 * unreadable fallback and prove nothing at all (the same defect r5 had to correct in this file, one
 * delegate over).
 */
const orderLockLog: string[] = []

/** o3d-e2mz r7: how many of the next `$queryRaw` row-lock attempts must FAIL. */
let queryRawFailures = 0

const dbStub = {
  accountingSyncLog,
  /**
   * o3d-550x / o3d-clxw r4, merged since this file was written: the posted-document record is ONE
   * shared writer (`recordPostedSyncResult`) that files its conflict evidence in the same transaction
   * and stamps `syncedAt` from the DATABASE clock through raw SQL. A harness without these delegates
   * makes that writer throw, and every fence-loss test below would then be about a run that never
   * recorded anything.
   */
  activityLog: { create: async () => ({ id: 'activity-1' }), findFirst: async () => null },
  accountingEvent: { findMany: async () => [], updateMany: async () => ({ count: 0 }), findFirst: async () => null },
  accountingEventLog: { createMany: async () => ({ count: 0 }) },
  $executeRaw: async () => 1,
  salesOrder: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      orderLockLog.push(`read:${where.id}`)
      if (!salesOrders) throw new Error('sales order read unavailable')
      return salesOrders.get(where.id) ?? null
    },
  },
  // lockSalesOrder issues `SELECT id FROM "sales_orders" WHERE id = $1 FOR UPDATE`.
  $queryRaw: async (query: { values?: unknown[] }) => {
    orderLockLog.push(`lock:${String(query?.values?.[0] ?? '')}`)
    // o3d-e2mz r7: a failing LOCK is how the evidence write's transaction dies WITHOUT the sale being
    // unreadable — a lock timeout, or a deadlock with the very cancellation the lock serialises
    // against. r6 read every such failure as "the sale cannot be read".
    if (queryRawFailures > 0) {
      queryRawFailures -= 1
      throw new Error('could not lock the sales order row')
    }
    return []
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const hook = interleave
    interleave = null
    hook?.()
    return fn(dbStub)
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
// The mirrored accounting event is a separate table with its own tests; the fence is about the row.
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})
// o3d-e2mz r4: only the fence-loss REMEDY tests at the end of this file reach `processEntry` (every
// other test uses a row that already carries an external id and short-circuits before it). These two
// stubs are what let one of them drive a sync type that posts SUCCESSFULLY WITHOUT creating any
// ledger document — the case the generic "reverse or credit-note it" sentence was wrong about.
mock.module('@/lib/connectors/xero/auth', {
  namedExports: { getGrantedScopes: async () => null },
})
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async () => ({ success: true }) },
})

async function loadProcessor() {
  return (await import('@/lib/connectors/xero/sync-processor')).processPendingXeroSync
}

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  interleave = null
  activity.length = 0
  orderLockLog.length = 0
  queryRawFailures = 0
  salesOrders = new Map([['order-1', { status: 'PROCESSING' }]])
}

const POSTED_ROW = {
  id: 'log-1',
  type: 'COGS_JOURNAL',
  referenceType: 'CogsEntry',
  referenceId: 'cogs-1',
  externalTransactionId: 'XERO-1',
}


/**
 * The claim predicate as ONE object. `stampingCustodyOnClaim` composes the caller's predicate with
 * the custody refusal as `{ AND: [caller, refusal] }` (o3d-anu8 r3) — AND-ed rather than spread,
 * because both halves already carry an `OR` and a spread would silently replace one with the other.
 * Flattening here keeps these assertions about the CALLER's half, which is what they are about.
 */
function flattenWhere(where: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' && Array.isArray(value)) {
      for (const arm of value as Array<Record<string, unknown>>) Object.assign(flat, flattenWhere(arm))
      continue
    }
    flat[key] = value
  }
  return flat
}

test('claiming a row mints a new attempt: the claim CASes on the revision it read and bumps it', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  const claimWhere = flattenWhere(store.updateManyWheres[0] as Record<string, unknown>)
  assert.equal(claimWhere.attemptRevision, 3, 'the claim must be a compare-and-swap on the revision that was read')
  assert.equal(store.get('log-1')?.attemptRevision, 4, 'a claim must move the row to a new attempt')
  assert.equal(store.get('log-1')?.status, 'SYNCED')
})

/**
 * SUPERSEDED AND REWRITTEN ON THE REBASE, WITH THE REASON.
 *
 * Seven tests stood here, pinning the round-1..r3 behaviour of `recordSyncLogPosted` (the SYNCED
 * write fenced on the attempt revision) and `recordPostedDocumentEvidence` (a five-then-seven-way
 * outcome enum describing what the recovery managed to persist).
 *
 * Neither function exists any more, and NOT because this branch changed its mind: o3d-550x merged
 * ONE shared posted-document writer, `recordPostedSyncResult`, reached here through
 * `recordPostedDocumentDurably`. It records the post UNCONDITIONALLY — its only precondition is that
 * the row does not already name a DIFFERENT document — and files its own conflict evidence inside the
 * transaction that observed the conflict. That is the same end state this branch's r2 recovery
 * arrived at by a longer route ("evidence of a post must never be conditional on winning a race"),
 * reached in one write instead of two, and re-adding the fenced writer beside it would be a second
 * implementation of the SYNCED write.
 *
 * What the attempt revision still buys is what these replacements pin: an operator who decided about
 * attempt N has to be TOLD that attempt N posted. `heldClaimWhere` cannot see that — a decision moves
 * the revision and can leave the claim instant untouched.
 */

test('a decision landing between the claim and the writeback is REPORTED, and the document is still recorded', async () => {
  // The o3d-osl8 race: the operator settles the PROCESSING row as "did not post" while this worker
  // holds the attempt. The settlement bumps the revision — and the worker's post is nonetheless real.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      // The operator asserted "never posted", so they left no document id behind.
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-1', 'the document that exists must be named on the row')
  assert.equal(row?.status, 'SYNCED', 'the delete guard must see a posted document, not a cancelled row')

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation, 'losing the fence after a post must be reported, not swallowed')
  assert.equal(escalation.level, 'ERROR')
  assert.equal(escalation.metadata?.externalId, 'XERO-1')
  assert.equal(escalation.metadata?.claimedAttemptRevision, 4, 'the attempt the operator judged')
  assert.equal(escalation.metadata?.currentAttemptRevision, 5, 'and the attempt the row had moved to')
  assert.match(escalation.description, /XERO-1/)
})

test('an attempt that has NOT moved is not escalated — the ordinary post says nothing', async () => {
  // The counter-guard. Without it the test above would pass with the revision comparison deleted and
  // an ERROR raised on every single successful post.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])

  const result = await (await loadProcessor())()

  assert.equal(result.succeeded, 1)
  assert.equal(store.get('log-1')?.status, 'SYNCED')
  assert.equal(
    activity.find((entry) => entry.action === 'xero_sync_post_fenced_out'),
    undefined,
    'nothing moved, so there is nobody to tell',
  )
})

test('a SECOND move of the row does not discard the id of a document that is known to have posted', async () => {
  // o3d-e2mz Finding 2, restated against the merged writer. Round 1 fenced the recording write on the
  // revision it had just read, so a row that moved AGAIN between that read and that write refused it —
  // the mechanism built to protect the evidence destroying the only durable record of the document.
  // `recordPostedSyncResult` cannot do that: it never asks about the revision at all.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
    // ...and the row moves a SECOND time, before the escalation reads it.
    interleave = () => {
      Object.assign(store.get('log-1')!, { attemptRevision: 9, errorMessage: 'Reset by an operator' })
    }
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-1', 'the id of a document known to exist must not depend on winning a race')
  assert.equal(row?.status, 'SYNCED')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.level, 'ERROR', 'and the move is still reported')
})

test('a stale PROCESSING claim is reclaimed onto a new attempt, so the old holder cannot write', async () => {
  const stale = new Date(Date.now() - 60 * 60 * 1000)
  reset([syncLogRow({ ...POSTED_ROW, status: 'PROCESSING', attemptRevision: 3, processingStartedAt: stale })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  assert.equal(store.get('log-1')?.attemptRevision, 4, 'PROCESSING -> PROCESSING must still be a NEW attempt')
})

test('a failure from an attempt the row has moved past does not revive it — with the CLAIM still matching', async () => {
  // REWRITTEN ON THE REBASE, and the reason is worth stating. The original fixture put the row at
  // CANCELLED, which o3d-550x's `heldClaimWhere` (merged since) refuses on `status: 'PROCESSING'`
  // alone — the attempt revision would never have been consulted and the test would have passed
  // with the whole of o3d-e2mz reverted.
  //
  // So the row here is PROCESSING at THE VERY INSTANT this worker stamped: the held-claim fence
  // MATCHES and cannot be what refuses the write. Only the revision can. That is also the case the
  // claim instant genuinely cannot cover — two claims inside one millisecond carry the same
  // `processingStartedAt`, while the revision is a counter and cannot collide.
  const { applyMainSyncFailureRetry } = await import('@/lib/connectors/xero/sync-processor')
  const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
  const claimedAt = new Date('2026-08-20T09:00:00.000Z')
  const settledStore = createSyncLogStore([syncLogRow({
    ...POSTED_ROW,
    status: 'PROCESSING',
    processingStartedAt: claimedAt,
    attemptRevision: 5,
    retryCount: 2,
    errorMessage: 'Operator verified: never posted',
  })])
  const tx = { accountingSyncLog: settledStore.delegate } as never

  await applyMainSyncFailureRetry(
    tx,
    { id: 'log-1', attemptRevision: 4 },
    { retryCount: 2, type: 'COGS_JOURNAL', referenceType: 'CogsEntry', referenceId: 'cogs-1' },
    'Xero timed out',
    {},
    claimHeldFrom(claimedAt),
  )

  assert.equal(settledStore.get('log-1')?.status, 'PROCESSING', 'the write was refused on the REVISION')
  assert.equal(settledStore.get('log-1')?.retryCount, 2, 'the settled row must not be advanced by a stale attempt')
  assert.equal(settledStore.get('log-1')?.errorMessage, 'Operator verified: never posted')
})

test('a follow-up failure from an attempt that was settled mid-flight does not revive the row', async () => {
  const { markSyncLogForFollowUpRetry } = await import('@/lib/connectors/xero/sync-processor')
  const settledStore = createSyncLogStore([syncLogRow({
    ...POSTED_ROW,
    status: 'CANCELLED',
    attemptRevision: 5,
    retryCount: 2,
    errorMessage: 'Operator verified: never posted',
  })])
  const client = { accountingSyncLog: settledStore.delegate } as never

  const outcome = await markSyncLogForFollowUpRetry({ id: 'log-1', attemptRevision: 4 }, { retryCount: 2 }, new Error('pdf failed'), client)

  assert.equal(settledStore.get('log-1')?.status, 'CANCELLED')
  assert.equal(settledStore.get('log-1')?.retryCount, 2)
  // The caller's outbox decision must still be driven by what is PERSISTED, not by the stale view.
  assert.equal(outcome.finalFailure, false)
})

/**
 * SUPERSEDED, WITH THE REASON. A test stood here pinning `NOT_RECORDED` — one of the seven outcomes
 * the round-3 evidence enum could report. The enum went with `recordPostedDocumentEvidence`; the
 * merged writer answers the same question with `PostedSyncRecord` (`recorded` / `ROW_MISSING` /
 * `ANOTHER_DOCUMENT_NAMED`) and files the evidence itself, and its outcomes are covered by
 * tests/accounting/xero-claim-fence.test.ts, which is where that writer lives.
 */

/**
 * Move the row onto a DIFFERENT attempt between the claim and the writeback — the fence loss the
 * escalation below reports on. (It stood beside the r1–r3 tests that have been replaced above.)
 */
function fenceOutOnWriteback() {
  interleave = () => {
    Object.assign(store.get('log-1')!, { status: 'CANCELLED', attemptRevision: 9 })
  }
}

test('o3d-e2mz r4: a JOURNAL fence loss says REVERSING JOURNAL, not credit-note', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  fenceOutOnWriteback()

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation)
  assert.match(escalation.description, /POSTED a manual journal to the Xero ledger \(XERO-1\)/)
  assert.match(escalation.description, /post a reversing journal there/)
  assert.doesNotMatch(escalation.description, /credit-note/, 'a journal is not credit-noted')
  assert.equal(escalation.metadata?.postEffect, 'POSTED a manual journal to the Xero ledger')
})

test('o3d-e2mz r4: a SALES_INVOICE fence loss still says void or credit-note', async () => {
  // The wording that was right all along must survive the classification — otherwise the fix would
  // have traded one wrong instruction for another.
  reset([syncLogRow({
    id: 'log-1',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: 'XERO-INV-1',
    status: 'PENDING',
    attemptRevision: 3,
  })])
  fenceOutOnWriteback()

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation)
  assert.match(escalation.description, /POSTED a document to the Xero ledger \(XERO-INV-1\)/)
  assert.match(escalation.description, /void or credit-note it there/)
})

test('o3d-e2mz r4: a fence loss on a type that creates NO document says so, and prescribes nothing in the ledger', async () => {
  // WC_INVOICE_NOTE succeeds by writing a note on the WooCommerce order and returns no external id.
  // Before this, the escalation announced a ledger document, named "a document whose id Xero did not
  // return", and sent the operator to reverse or credit-note it.
  reset([syncLogRow({
    id: 'log-1',
    type: 'WC_INVOICE_NOTE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    payload: { referenceId: 'order-1' },
    status: 'PENDING',
    attemptRevision: 3,
  })])
  fenceOutOnWriteback()

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation, 'a fence loss is still an ERROR whatever the effect was')
  assert.equal(escalation.level, 'ERROR')
  assert.match(escalation.description, /ADDED an invoice note to the WooCommerce order/)
  assert.match(escalation.description, /NO ledger document was created and nothing in Xero changed/)
  assert.doesNotMatch(escalation.description, /credit-note/, 'there is no document to credit-note')
  assert.doesNotMatch(escalation.description, /reversing journal/)
  assert.doesNotMatch(
    escalation.description,
    /a document whose id Xero did not return/,
    'and it must not imply a document was created whose id went missing',
  )
  assert.equal(escalation.metadata?.externalId, null)
  // SUPERSEDED ASSERTION, REWRITTEN: this used to read `metadata.evidence === 'NO_EXTERNAL_ID'`, one
  // member of the round-3 evidence enum that went with `recordPostedDocumentEvidence` (see the block
  // comment above). What it was really pinning is that a type creating no document is described as
  // one — which is `postEffect`, and is asserted from the type table rather than from an outcome enum.
  assert.equal(escalation.metadata?.postEffect, 'ADDED an invoice note to the WooCommerce order')
})

// ---------------------------------------------------------------------------
// o3d-e2mz r5 (Codex finding 1) — DETECTING THE CANCELLATION WINDOW IS NOT THE SAME AS NOT WALKING
// THROUGH IT.
//
// r4 routed a fence-losing worker into the evidence path: the id is recorded, an ERROR names the
// document. It then left the row SYNCED with an external id — which is exactly the candidate shape
// repairXeroBackReferences selects on (`status IN (SYNCED, FAILED) AND externalTransactionId IS NOT
// NULL`). Minutes later that sweep stamped the Xero id onto the CANCELLED order and enqueued its
// follow-ups: the PDF, the email, the WooCommerce note, and the PAYMENT. Cancellation exists to stop
// exactly that work, and the recovery restarted it automatically with no operator involved.
//
// The row is now terminalised as CANCELLED instead. Both statuses stop a second post; only SYNCED
// re-enters the pipeline.
// ---------------------------------------------------------------------------

const SALES_ROW = {
  id: 'log-1',
  type: 'SALES_INVOICE',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  externalTransactionId: 'XERO-INV-1',
}

/** The candidate shape repairXeroBackReferences selects on. */
function wouldBeSweptForRepair(row: { status: string; externalTransactionId: string | null } | undefined): boolean {
  return !!row && row.externalTransactionId !== null && (row.status === 'SYNCED' || row.status === 'FAILED')
}

/**
 * SUPERSEDED AND MOVED, WITH THE REASON — the r5/r6 block that stood here.
 *
 * Six tests pinned the fence-loss recovery terminalising its row as CANCELLED when the SALE behind it
 * was cancelled, so that the back-reference sweep would not then release that sale's work. Rounds 5,
 * 6 and 7 each closed one PRODUCER of that shape, and each closed with the same flag: the SWEEP still
 * has no cancellation check.
 *
 * Two merged changes settle it, and both are stronger than gating this producer:
 *
 *  • o3d-7o0 makes a cancellation REFUSE outright while a sales-invoice post is in flight, under the
 *    order's row lock. The schedule these tests dramatise — cancel commits, worker posts — cannot
 *    happen for a fresh claim at all; no document is created rather than one being created and held.
 *  • round 8's gate now lives on the CONSUMER, in the shared back-reference sweep, where it covers
 *    every producer including the ordinary settle path that reads no sale at all. Its tests are in
 *    tests/accounting/xero-backreference-sweep-cancelled-sale.test.ts, driving the real sweep.
 *
 * So the property is still pinned; it is pinned where the decision is now taken.
 */

test('o3d-e2mz r5: a DRAFT journal fence loss says DELETE THE DRAFT, and never says post a reversing journal', async () => {
  reset([syncLogRow({
    ...POSTED_ROW,
    status: 'PENDING',
    attemptRevision: 3,
    payload: { _postingMode: 'draft' },
  })])
  fenceOutOnWriteback()

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation)
  assert.match(escalation.description, /created a DRAFT manual journal in Xero \(nothing posted to the ledger\)/)
  assert.match(escalation.description, /DELETE the draft/)
  assert.doesNotMatch(
    escalation.description,
    /post a reversing journal there/,
    'a reversal of a draft posts for real and moves the accounts by itself',
  )
  assert.equal(escalation.metadata?.postEffect, 'created a DRAFT manual journal in Xero (nothing posted to the ledger)')
})

test('o3d-e2mz r5: a SUBMITTED journal keeps the reversing-journal remedy', async () => {
  // The counter-guard for the branch above: the draft wording must not leak onto a journal that
  // really is in the ledger, where deleting it is not an option and a reversal is the answer.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3, payload: { _postingMode: 'submitted' } })])
  fenceOutOnWriteback()

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.match(escalation?.description ?? '', /post a reversing journal there/)
  assert.doesNotMatch(escalation?.description ?? '', /DELETE the draft/)
})

// ---------------------------------------------------------------------------
// o3d-e2mz r7 — A ROW THAT ALREADY NAMED ITS DOCUMENT WAS NEVER TAKEN OUT OF THE SWEEP'S SHAPE.
//
// r5 and r6 expressed "stop this cancelled sale's work" as the STATUS half of the RECORDING write, so
// it inherited that write's precondition: `externalTransactionId: null`. Right for recording — that is
// the fact recording protects — and wrong for retiring. A row that already names its document skips
// the write entirely and keeps whatever status it has, and SYNCED/FAILED is exactly
// repairXeroBackReferences' candidate shape: the sweep then writes the id onto the CANCELLED order and
// enqueues its follow-ups — PDF, email, storefront note, PAYMENT.
//
// Every fixture in the r5/r6 blocks above nulls the external id in its interleave, so none of them
// could see it — and r6's retry meets that row EVERY time, because the first pass is what recorded the
// id. Retiring is now its own statement, with its own precondition, fired only by a PROVEN cancellation.
// ---------------------------------------------------------------------------

/**
 * SUPERSEDED, WITH THE REASON — the r7 block that stood here.
 *
 * Four tests pinned the fence-loss recovery RETIRING a row that already named its document, as a
 * statement separate from the recording write. That retirement was a producer-side gate on the shape
 * the back-reference sweep selects; round 8 moved the decision onto the sweep itself, where it also
 * covers rows this recovery never touches. See the block comment above, and
 * tests/accounting/xero-backreference-sweep-cancelled-sale.test.ts.
 */

