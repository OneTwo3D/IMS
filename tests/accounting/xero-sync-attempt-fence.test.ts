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

const dbStub = {
  accountingSyncLog,
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
  salesOrders = new Map([['order-1', { status: 'PROCESSING' }]])
}

const POSTED_ROW = {
  id: 'log-1',
  type: 'COGS_JOURNAL',
  referenceType: 'CogsEntry',
  referenceId: 'cogs-1',
  externalTransactionId: 'XERO-1',
}

test('claiming a row mints a new attempt: the claim CASes on the revision it read and bumps it', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  const claimWhere = store.updateManyWheres[0]
  assert.equal(claimWhere.attemptRevision, 3, 'the claim must be a compare-and-swap on the revision that was read')
  assert.equal(store.get('log-1')?.attemptRevision, 4, 'a claim must move the row to a new attempt')
  assert.equal(store.get('log-1')?.status, 'SYNCED')
})

test('a decision landing between the claim and the writeback is NOT overwritten, and is reported', async () => {
  // The o3d-osl8 race: the operator settles the PROCESSING row as "did not post" while this worker
  // holds the attempt. Settlement bumps the revision, so the worker's writeback must find nothing.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      errorMessage: 'Operator verified: never posted',
    })
  }

  const result = await (await loadProcessor())()

  assert.equal(store.get('log-1')?.status, 'CANCELLED', 'the settlement must survive the worker writeback')
  assert.equal(store.get('log-1')?.attemptRevision, 5)
  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 1)

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation, 'losing the fence after a post must be reported, not swallowed')
  assert.equal(escalation.level, 'ERROR')
  assert.equal(escalation.metadata?.externalId, 'XERO-1')
  assert.equal(escalation.metadata?.claimedAttemptRevision, 4)
  assert.equal(escalation.metadata?.currentAttemptRevision, 5)
  assert.match(escalation.description, /XERO-1/)
})

test('a settled row whose document DID post gets the external id recorded, loudly', async () => {
  // Same race, but the operator's assertion is now known to be wrong and the row names no document.
  // The posted invoice must become visible to the order delete guard rather than being lost.
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
  assert.equal(row?.attemptRevision, 6, 'recording the correction must itself move the attempt on')
  assert.match(row?.errorMessage ?? '', /Posted to Xero as XERO-1 on attempt 4/)
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.level, 'ERROR')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED')
  assert.match(escalation?.description ?? '', /now recorded on the sync row/)
})

test('a SECOND fence loss does not discard the id of a document that is known to have posted', async () => {
  // o3d-e2mz Finding 2. Round 1 fenced the recording write on the revision it had just read, so a row
  // that moved AGAIN between that read and that write refused it — the mechanism built to protect the
  // evidence destroying the only durable record of the document, in exactly the case it exists for.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
    // ...and the row moves a SECOND time, between the escalation's read and the recording write.
    interleave = () => {
      Object.assign(store.get('log-1')!, { attemptRevision: 9, errorMessage: 'Reset by an operator' })
    }
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-1', 'the id of a document known to exist must not depend on winning a race')
  assert.equal(row?.status, 'SYNCED')
  assert.equal(row?.attemptRevision, 10, 'recording the evidence still advances the fence, it just never depends on it')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED')
})

test('a document whose row has vanished is reported as unrecordable, without claiming to be its only record', async () => {
  // The one case where the id genuinely cannot be recorded on the row. o3d-e2mz r3: what the failed
  // write establishes is that NOTHING KEYED ON THE ROW can see the document — not that this log entry
  // is the only record of it anywhere, which it cannot know (an earlier attempt may have left a
  // mirrored event or a back-reference).
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, { status: 'CANCELLED', attemptRevision: 5, externalTransactionId: null })
    interleave = () => { store.rows.length = 0 }
  }

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.level, 'ERROR')
  assert.equal(escalation?.metadata?.evidence, 'ROW_MISSING')
  assert.match(escalation?.description ?? '', /nothing keyed on that row will see this document/)
  assert.doesNotMatch(
    escalation?.description ?? '',
    /ONLY record/,
    'the write establishes what the row can show, never what other records exist',
  )
  assert.match(escalation?.description ?? '', /XERO-1/)
})

test('a settled row that already names a document is left exactly as the decision left it', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'SYNCED',
      attemptRevision: 5,
      externalTransactionId: 'XERO-OPERATOR-VERIFIED',
      errorMessage: 'Operator verified: posted',
    })
  }

  await (await loadProcessor())()

  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-OPERATOR-VERIFIED', 'a recorded document id must never be renamed')
  assert.equal(store.get('log-1')?.attemptRevision, 5)
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'ALREADY_NAMED')
  // The ids genuinely differ, so the operator is told to check BOTH.
  assert.match(escalation?.description ?? '', /DIFFERENT document/)
  assert.match(escalation?.description ?? '', /XERO-1/)
})

test('o3d-e2mz r3: a row that already names THE SAME document is not reported as a second document', async () => {
  // Round 2 returned ALREADY_NAMED for every miss on a surviving row — "a DIFFERENT document ...
  // check the accounting system for BOTH ids" — without ever reading which document the row names.
  // The ordinary case is that it names the one we just posted (a replay, or a writeback that landed
  // after all), and that reading sent an operator hunting for an invoice that does not exist.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'SYNCED',
      attemptRevision: 5,
      // The SAME document this attempt posted.
      externalTransactionId: 'XERO-1',
      errorMessage: 'Recorded by another attempt',
    })
  }

  await (await loadProcessor())()

  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-1')
  assert.equal(store.get('log-1')?.attemptRevision, 5, 'nothing was written, so nothing advanced the attempt')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'ALREADY_RECORDED')
  assert.match(escalation?.description ?? '', /THIS SAME document/)
  assert.match(escalation?.description ?? '', /no second document is implied/)
  assert.doesNotMatch(
    escalation?.description ?? '',
    /DIFFERENT document/,
    'the ids match, so nothing may claim they do not',
  )
})

test('o3d-e2mz r3: RECORDED does not promise a delete guard that may not apply to this entry', async () => {
  // The note claimed "the order cannot be deleted while it exists". The delete guard keys on
  // externalTransactionId for entries keyed to a SalesOrder or a Shipment; this row is a COGS_JOURNAL
  // keyed to a CogsEntry, which the guard never looks at.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }

  await (await loadProcessor())()

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED')
  assert.match(escalation?.description ?? '', /now recorded on the sync row/)
  assert.match(
    escalation?.description ?? '',
    /where this entry is keyed to a sales order or shipment/,
    'the guard is stated as conditional on the reference, because that is what it is',
  )
  assert.doesNotMatch(escalation?.description ?? '', /the order cannot be deleted/)
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

test('o3d-e2mz r3: a lost evidence write on a row still naming NO document is reported as not recorded', async () => {
  // The third thing a missed evidence write can mean, and the one r2 could not say. Its predicate is
  // "the row names no document"; r2 read a miss on a surviving row as proof that the row now names
  // one, and reported a DIFFERENT document. If the row still names none, neither reading is true —
  // something moved it in between, and the id was simply not recorded.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }
  // Only the evidence write is made to match nothing — it is the one keyed on "names no document".
  const inner = store.delegate.updateMany as (args: never) => Promise<unknown>
  store.delegate.updateMany = (async (args: { where?: Record<string, unknown> }) => {
    if (args?.where && args.where.externalTransactionId === null) return { count: 0 }
    return inner(args as never)
  }) as never

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, null, 'nothing was recorded, and the report must say only that')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'NOT_RECORDED')
  assert.match(escalation?.description ?? '', /was NOT recorded on it/)
  assert.doesNotMatch(escalation?.description ?? '', /DIFFERENT document/)
  assert.match(escalation?.description ?? '', /XERO-1/)
})

// ---------------------------------------------------------------------------
// o3d-e2mz r4 (Codex finding 3) — THE ESCALATION MUST NOT PRESCRIBE A REMEDY FOR A DOCUMENT THAT
// DOES NOT EXIST.
//
// `recordPostAfterFenceLoss` used to end every escalation with the same sentence: "The document is
// in the ledger: reverse or credit-note it there if it should not exist." That is true of an
// invoice and false of most of the queue — INVOICE_PDF saves a file, INVOICE_EMAIL sends an email,
// WC_INVOICE_NOTE writes a note on the WooCommerce order, BILL_ATTACHMENT attaches a file,
// PURCHASE_CREDIT_NOTE_ALLOCATION applies a credit note that already existed. Telling an operator
// to credit-note one of those is worse than saying nothing: the nearest matching document is a real
// receivable or payable, and that is what they will reach for.
// ---------------------------------------------------------------------------

/** Bump the row out from under the worker, so its writeback CAS misses and the escalation runs. */
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
  assert.equal(escalation.metadata?.evidence, 'NO_EXTERNAL_ID')
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

test('o3d-e2mz r5: a fence loss on a CANCELLED sale records the document but does NOT hand the sweep its work', async () => {
  // The window itself: the cancellation sweep retired this claimed row and bumped the attempt while
  // the worker was mid-post. Under r4 the row came back SYNCED and the back-reference sweep then
  // wrote the invoice id onto the cancelled order and enqueued its payment.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  salesOrders = new Map([['order-1', { status: 'CANCELLED' }]])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 9,
      externalTransactionId: null,
      errorMessage: 'Cancelled: order cancelled before this invoice posted (no revenue to recognise).',
    })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'the document that exists is still named on the row')
  assert.equal(row?.status, 'CANCELLED', 'and the row is NOT promoted to SYNCED')
  assert.equal(
    wouldBeSweptForRepair(row),
    false,
    'so repairXeroBackReferences will never pick it up and enqueue the cancelled sale\'s follow-ups',
  )
  assert.equal(row?.syncedAt, null, 'a cancelled sale has no successful sync to date-stamp')

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.level, 'ERROR')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED_ON_CANCELLED_SALE')
  assert.match(escalation?.description ?? '', /SALE IT BELONGS TO IS CANCELLED/)
  assert.match(escalation?.description ?? '', /none of its follow-ups \(PDF, email, payment, attachment\) are enqueued/)
})

test('o3d-e2mz r5: a fence loss on a LIVE sale still settles the row, so the legitimate repair is untouched', async () => {
  // THE COUNTER-GUARD. The other reason a row reads CANCELLED is an operator settling it as "did not
  // post" — and for that row the sweep's back-reference and follow-ups ARE the correct repair. A fix
  // that keyed on the ROW's status instead of the SALE's would have stopped this one too.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 9,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.status, 'SYNCED', 'the sale is live, so the document is a real posting to reconcile')
  assert.equal(wouldBeSweptForRepair(row), true, 'and the back-reference sweep must still be able to finish the job')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED')
})

test('o3d-e2mz r5: a sale that cannot be read fails CLOSED — the work is held, not released', async () => {
  // Same rule guardCancelledSalesOrderInvoice applies: a transient read outage must not become
  // permission to carry on for a sale that may not exist.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  salesOrders = null
  interleave = () => {
    Object.assign(store.get('log-1')!, { status: 'CANCELLED', attemptRevision: 9, externalTransactionId: null })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1')
  assert.equal(row?.status, 'CANCELLED')
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED_SALE_UNREADABLE')
  // r6: and the note no longer sends the operator to a button that refuses them. retryFailedXeroSync
  // fences on `expectedStatus: 'FAILED'` and "Retry All" filters on it too, so a CANCELLED row is
  // refused by BOTH entry points. The affordance that would release it is filed as o3d-psvi.
  assert.match(escalation?.description ?? '', /NO self-service action does that yet/)
  assert.match(escalation?.description ?? '', /o3d-psvi/)
  assert.doesNotMatch(
    escalation?.description ?? '',
    /retry the row from the sync log/,
    'a remedy the retry path refuses is worse than no remedy: it reads as a dead end after the click',
  )
})

// ---------------------------------------------------------------------------
// o3d-e2mz r6 — A STALE SALE READ RE-PROMOTED A CONCURRENTLY CANCELLED ROW.
//
// r5 read the sale to decide whether the fence-loss recovery may settle the row, which is the right
// question — but it asked it BEFORE the transaction and outside it, so the answer was already history
// by the time the write used it. A cancellation committing in that gap left the row SYNCED with an
// external id, which is repairXeroBackReferences' candidate shape, and the sweep then did the
// cancelled sale's work: back-reference, PDF, email, storefront note, PAYMENT. Exactly what r5 closed
// for a sale cancelled a moment EARLIER.
//
// The read now happens inside the writing transaction, under the same `lockSalesOrder` row lock that
// `cancelSalesOrderFulfillmentState` opens with, so the two serialise: the cancellation either
// commits first and is seen, or waits for the decision it would have invalidated.
// ---------------------------------------------------------------------------

test('o3d-e2mz r6: a sale cancelled AFTER the worker read it still holds the row, instead of being re-promoted', async () => {
  // The window r5 left. `salesOrders` says LIVE for the whole of r5's pre-transaction read; the
  // cancellation lands at the start of the transaction that writes the evidence — which is precisely
  // where a real one can land, because r5 took no lock over that gap.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 9,
      externalTransactionId: null,
      errorMessage: 'Cancelled: order cancelled before this invoice posted (no revenue to recognise).',
    })
    // ...and the SALE is cancelled between the worker's read and its write.
    interleave = () => { salesOrders = new Map([['order-1', { status: 'CANCELLED' }]]) }
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'the document that exists is still named on the row')
  assert.equal(row?.status, 'CANCELLED', 'the row is NOT promoted to SYNCED on a sale that is cancelled by now')
  assert.equal(
    wouldBeSweptForRepair(row),
    false,
    'so the back-reference sweep never gets handed the cancelled sale\'s follow-ups — PDF, email, note, PAYMENT',
  )
  assert.equal(row?.syncedAt, null)
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED_ON_CANCELLED_SALE')
  assert.match(escalation?.description ?? '', /SALE IT BELONGS TO IS CANCELLED/)
})

test('o3d-e2mz r6: the sale is read under the order row lock, taken before the read and inside the write', async () => {
  // WHY the test above can be trusted: the decision and the write are one locked section. A read
  // taken before the lock — or before the transaction, as r5 did — is a read a cancellation can
  // overtake, however close to the write it is moved.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 9,
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }

  await (await loadProcessor())()

  assert.deepEqual(orderLockLog, ['lock:order-1', 'read:order-1'], 'the row lock is taken FIRST, then the status is read')
  // And the live-sale behaviour is unchanged by the lock: this row IS the legitimate repair.
  assert.equal(store.get('log-1')?.status, 'SYNCED')
  assert.equal(wouldBeSweptForRepair(store.get('log-1')), true)
})

test('o3d-e2mz r6: a sale that cannot be read still records the document, without the read holding the write hostage', async () => {
  // The locked read is the first statement in the transaction, so a read failure is a transaction
  // that wrote nothing. The retry writes fail-closed with no read at all, which keeps r5's unreadable
  // outcome AND keeps the id on the row rather than only in the escalation log.
  reset([syncLogRow({ ...SALES_ROW, status: 'PENDING', attemptRevision: 3 })])
  salesOrders = null
  interleave = () => {
    Object.assign(store.get('log-1')!, { status: 'CANCELLED', attemptRevision: 9, externalTransactionId: null })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'the id survives a failed sale read')
  assert.equal(row?.status, 'CANCELLED')
  assert.equal(wouldBeSweptForRepair(row), false)
  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.equal(escalation?.metadata?.evidence, 'RECORDED_SALE_UNREADABLE')
})

// ---------------------------------------------------------------------------
// o3d-e2mz r5 (Codex finding 2) — A DRAFT JOURNAL IS NOT REVERSED, IT IS DELETED.
//
// `_postingMode: 'draft'` sends the journal to Xero as DRAFT, which moves no balances. "Post a
// reversing journal" is then the most dangerous sentence in the remedy table: the reversal DOES post,
// so an operator following it moves the accounts by exactly the amount the draft never moved.
// ---------------------------------------------------------------------------

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
