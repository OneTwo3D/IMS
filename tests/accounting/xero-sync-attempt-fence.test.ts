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

const dbStub = {
  accountingSyncLog,
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
