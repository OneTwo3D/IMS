import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyMainSyncFailureRetry,
  deferPaymentUntilEarlierLogsPost,
  deferUpdateUntilCreatePosts,
  heldClaimWhere as heldClaimWhereFromConnector,
  recordPostedSyncResult,
} from '@/lib/connectors/xero/sync-processor'
import { claimHeldFrom, heldClaimWhere, releaseClaimForRetry, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'

// ---------------------------------------------------------------------------
// o3d-550x — the accounting processor wrote its result BY ROW ID, unfenced.
//
// TWO DIFFERENT WRITES, TWO DIFFERENT ANSWERS, and conflating them is the reason this issue could not
// simply be "fence everything":
//
//  • A RELEASE OF THE CLAIM (failure retry, rate-limit backoff, ordering deferral) asserts a state the
//    row can be talked out of. It must land ONLY while this worker still holds the claim it took —
//    otherwise a worker whose claim went stale comes back, drops the row to PENDING over the
//    replacement's live claim, and the row is re-claimed a third time while a request is on the wire.
//    The old `{ id, retryCount }` guard could not stop it: A RE-CLAIM DOES NOT ADVANCE retryCount.
//
//  • A RECORD OF A POSTED DOCUMENT states a fact about the external ledger that has already happened.
//    Fencing THAT on claim ownership is the failure mode the settled rule forbids — the worker that
//    actually posted would write nothing and the document would exist in Xero with nothing in IMS
//    naming it. Its only precondition is the fact it protects: the row must not already name a
//    DIFFERENT document. Whichever worker gets there first wins, and no race decides it.
//
// AND THE CASE THAT COMPLETES THE PAIR (Codex r1, HIGH): when that record REFUSES, the evidence of the
// displaced document is irreplaceable — the row will never name it. So it is written in the SAME
// transaction that observed the refusal, not afterwards by a logger that swallows its own failures.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  status: string
  processingStartedAt: Date | null
  /**
   * o3d-e2mz: the per-attempt identity the processor now stamps on every claim. Carried by this
   * double because `applyMainSyncFailureRetry` fences on it as well as on the claim instant — a
   * double without it answers `undefined` to `attemptRevision: 0` and refuses EVERY write, which
   * would make the o3d-550x tests below pass for entirely the wrong reason.
   */
  attemptRevision: number
  retryCount: number
  externalTransactionId: string | null
  syncedAt: Date | null
  errorMessage: string | null
}

type ActivityWrite = { data: Record<string, unknown> }

/**
 * A one-row store that HONOURS its where clause, including the `OR` the evidence write uses.
 *
 * This matters more than usual here: the entire property under test is WHICH writes match and which do
 * not. A double that ignored `where` would report the fix as working and the defect as working equally
 * well — which is exactly what the canned-count double in main-sync-failure-retry-concurrency.test.ts
 * does, and why the behavioural assertions live in this file instead.
 *
 * `activityLog` is a real recording delegate rather than one of the null-answering mirror stubs,
 * because the conflict evidence is now written through it INSIDE the transaction, and "was it written,
 * and with which two ids" is the property the HIGH turns on. `failActivityLog` expresses the case the
 * old code could not survive: the evidence write itself failing.
 */
function makeRowStore(
  row: (Partial<Row> & { id: string }) | null,
  options: { failActivityLog?: boolean } = {},
) {
  const state: Row | null = row === null ? null : {
    status: 'PROCESSING',
    processingStartedAt: null,
    attemptRevision: 0,
    retryCount: 0,
    externalTransactionId: null,
    syncedAt: null,
    errorMessage: null,
    ...row,
  }
  const mirrorWrites: unknown[] = []
  const activityWrites: ActivityWrite[] = []

  const leafMatches = (where: Record<string, unknown>): boolean => {
    if (state === null) return false
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'OR') continue
      const actual = (state as unknown as Record<string, unknown>)[key]
      if (expected instanceof Date) {
        if ((actual as Date | null)?.valueOf() !== expected.valueOf()) return false
      } else if (actual !== expected) return false
    }
    if (Array.isArray(where.OR)) {
      if (!(where.OR as Array<Record<string, unknown>>).some((clause) => leafMatches(clause))) return false
    }
    return true
  }

  const accountingSyncLog = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!leafMatches(where)) return { count: 0 }
      Object.assign(state as Row, data)
      return { count: 1 }
    },
    findUnique: async () => (state === null ? null : { ...state }),
  }

  const activityLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (options.failActivityLog) throw new Error('activity_log insert failed')
      activityWrites.push({ data })
      return { id: `activity-${activityWrites.length}` }
    },
  }

  // o3d-batch-billpay (o3d-clxw r4), merged into development after this double was written: the
  // SYNCED transaction now stamps `syncedAt` from the DATABASE's clock through raw SQL, so the
  // transaction client must answer `$executeRaw` with a FUNCTION. The generic delegate proxy below
  // returns an object, which is why the un-taught double failed with "$executeRaw is not a function"
  // rather than with anything about claims. Statements are recorded so a test can say the stamp ran.
  const rawStatements: unknown[] = []
  const executeRaw = async (...args: unknown[]) => { rawStatements.push(args); return 1 }

  const tx = new Proxy({ accountingSyncLog }, {
    get(_target, prop: string) {
      if (prop === 'accountingSyncLog') return accountingSyncLog
      if (prop === 'activityLog') return activityLog
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe') return executeRaw
      // Mirror-table delegates: record the call so "the mirror was NOT written" is assertable.
      //
      // READS answer NOTHING FOUND (null / []), which is the mirror's own "no event to update" path —
      // this file is about the sync row, and a half-built mirror event would only add noise.
      //
      // WRITES answer a ROW (o3d-nf9i, merged into development after this double was written).
      // `updateMirroredAccountingEventStatus` now returns an OUTCOME, and the value its
      // `accountingEvent.update` resolves to IS that outcome on the success path — so a double that
      // answered `null` to a write made the mirror dereference `null.id` and threw out of the
      // transaction. Prisma's `update` never resolves to null either: it returns the row or throws
      // P2025, so answering a row is also the more truthful model.
      return new Proxy({}, {
        get: (_t, method: string) => async (args: unknown) => {
          mirrorWrites.push({ delegate: prop, method, args })
          if (method === 'findMany') return []
          if (method === 'findUnique' || method === 'findFirst') return null
          if (method === 'updateMany' || method === 'deleteMany') return { count: 1 }
          return { id: 'mirror-event-1' }
        },
      })
    },
  })
  return { tx: tx as never, state, mirrorWrites, activityWrites, rawStatements }
}

const T_DISPLACED_CLAIM = new Date('2026-03-01T09:00:00.000Z')
const T_REPLACEMENT_CLAIM = new Date('2026-03-01T09:20:00.000Z')

const ATTEMPT = { id: 'log-1', attemptRevision: 0 }
const ENTRY = {
  id: 'log-1',
  retryCount: 2,
  type: 'SALES_INVOICE' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
}

test('o3d-550x: heldClaimWhere names the claim INSTANT, not merely that the row is claimed', () => {
  // The replacement's row is PROCESSING too, so `status: PROCESSING` alone identifies nothing.
  assert.deepEqual(heldClaimWhere('log-1', claimHeldFrom(T_DISPLACED_CLAIM)), {
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_DISPLACED_CLAIM,
  })
})

// ---------------------------------------------------------------------------
// THE CLAIM-INSTANT CONVENTION (Codex r2, medium 2).
//
// Three branches import this one fence and they did not agree about what a claim instant is. This
// branch, o3d-batch-payidx and o3d-batch-invnum CAPTURE it once when the row is claimed;
// o3d-batch-small2 RENEWS it before every remote mutation so a long post cannot have its claim age out
// mid-flight. A captured instant fenced against a renewed row matches NOTHING, and because the fence
// fails closed the symptom is not an error — it is a deferral that never happens, a backoff that never
// lands, a retirement that silently does not retire.
//
// The resolution is that a fence is handed the CLAIM and asks it for the instant AT THE WRITE. A
// renewing lease and a fixed claim are then the same thing to every call site.
// ---------------------------------------------------------------------------

/** Stands in for the sibling's remote-write lease: one claim whose instant moves forward. */
function renewableClaim(initial: Date): { claim: HeldClaim; renew: (at: Date) => void } {
  let current = initial
  return { claim: { heldFrom: () => current }, renew: (at: Date) => { current = at } }
}

const T_RENEWED_CLAIM = new Date('2026-03-01T09:40:00.000Z')

test('Codex r2 medium 2: the fence reads the claim instant AT THE POINT OF USE, not when the entry was picked up', () => {
  const lease = renewableClaim(T_REPLACEMENT_CLAIM)
  assert.deepEqual(heldClaimWhere('log-1', lease.claim), {
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
  })

  lease.renew(T_RENEWED_CLAIM)

  assert.deepEqual(heldClaimWhere('log-1', lease.claim), {
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_RENEWED_CLAIM,
  }, 'a fence built after a renewal must name the renewed instant, or it fences on a claim nobody holds')
})

test('Codex r2 medium 2: a renewing claim still releases its own row — the fence does not refuse it', async () => {
  // The failure this pins is SILENT. The row is the one this worker holds; it simply renewed the claim
  // while it was working, exactly as o3d-batch-small2's lease does before each remote mutation.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_RENEWED_CLAIM,
  })
  const lease = renewableClaim(T_REPLACEMENT_CLAIM)
  // The claim is USED before it is renewed — the runner fences something early in the entry (a
  // deferral check, a guard) and only then does the lease move the instant forward. A fence that
  // remembered the first answer would go on releasing against a claim instant the row no longer bears.
  heldClaimWhere('log-1', lease.claim)
  lease.renew(T_RENEWED_CLAIM)

  const released = await releaseClaimForRetry(tx, 'log-1', lease.claim, {
    errorMessage: 'Xero rate limit exceeded',
    nextAttemptAt: T_BACKOFF,
  })

  assert.equal(released, true, 'the holder must be able to hand back the claim it actually holds')
  assert.equal(state!.status, 'PENDING')
  assert.equal(state!.processingStartedAt?.valueOf(), T_BACKOFF.valueOf())
})

test('Codex r2 medium 2: the SAME row, fenced on the instant carried down from the loop, refuses everything', async () => {
  // The control that shows the two conventions are incompatible rather than merely different: identical
  // row, identical worker, and the only difference is that the claim instant was captured at pick-up
  // instead of read at the write. Nothing happens, nothing is reported, and the row sits in PROCESSING
  // until it goes stale and somebody else takes it.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_RENEWED_CLAIM,
  })

  const released = await releaseClaimForRetry(tx, 'log-1', claimHeldFrom(T_REPLACEMENT_CLAIM), {
    errorMessage: 'Xero rate limit exceeded',
    nextAttemptAt: T_BACKOFF,
  })

  assert.equal(released, false)
  assert.equal(state!.status, 'PROCESSING', 'the work is refused, and only the return value says so')
})

test('Codex r2 medium 2: no claim carrier in either runner, or in the retirement, is a bare instant', () => {
  // The type makes a `Date` a compile error; this pins the shape the runners are expected to have, so a
  // future edit cannot reintroduce "capture it at the top and carry it down" by widening the type back.
  const src = stripComments(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  assert.equal(
    (src.match(/const held = claimHeldFrom\(claimedAt\)/g) ?? []).length,
    2,
    'each runner builds ONE claim holder for the entry it is processing',
  )
  for (const call of ['releaseClaimForRetry(', 'applyMainSyncFailureRetry(', 'retireSalesInvoiceForCancelledOrder(']) {
    let at = src.indexOf(call)
    while (at !== -1) {
      const args = callArgs(src, at + call.length - 1)
      assert.ok(
        !/\bclaimedAt\b/.test(args),
        `${call} is being handed the raw instant — a renewing sibling would make that fence match nothing:\n${args.slice(0, 200)}`,
      )
      at = src.indexOf(call, at + 1)
    }
  }
})

test('o3d-550x: there is ONE definition of claim ownership, not one per consumer', () => {
  // Codex r1, medium 1: the connector re-exports the domain helper rather than owning a second copy,
  // so a change to what "I still hold this claim" means cannot reach the connector's releases while
  // missing the cancellation retirement (or vice versa).
  assert.equal(heldClaimWhereFromConnector, heldClaimWhere)
})

test('Codex r1 medium 2: the cancellation retirement COMPOSES the fence, it does not re-spell it', () => {
  // Identity alone cannot catch this: an inline copy that happens to match behaves identically today,
  // which is exactly why it is dangerous. What must be true is that the predicate is not written out a
  // second time — so the source is read, with comments stripped so a commented example cannot satisfy it.
  const src = stripComments(readFileSync(join(process.cwd(), 'lib/domain/accounting/cancel-order-invoice-sync.ts'), 'utf8'))
  // o3d-e2mz: the entry id now arrives as part of the ATTEMPT the worker claimed, so the composed
  // call names `attempt.id` rather than a separate `syncLogId`. What this pins is unchanged and is
  // the whole point: the ownership half is COMPOSED from the shared predicate, not re-spelt.
  assert.ok(src.includes('heldClaimWhere(attempt.id, held)'), 'the retirement must compose the shared fence')
  assert.ok(
    !/processingStartedAt:\s*(claimedAt|held\.heldFrom\(\))/.test(src),
    'and must not hand-spell the claim instant into a where clause of its own',
  )
})

test('o3d-550x: a displaced owner cannot release the replacement\'s claim', async () => {
  // The row was re-taken at 09:20 after the 09:00 claim aged out. The 09:00 worker is still alive — a
  // timeout cannot recall a request already on the wire — and now reports its failure.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  await applyMainSyncFailureRetry(tx, ATTEMPT, ENTRY, 'connection reset', {}, claimHeldFrom(T_DISPLACED_CLAIM))

  assert.equal(state!.status, 'PROCESSING', 'the replacement still holds the row')
  assert.equal(state!.processingStartedAt?.valueOf(), T_REPLACEMENT_CLAIM.valueOf())
  assert.equal(state!.retryCount, 2, 'and its attempt budget was not spent by a worker that no longer owns it')
  assert.equal(state!.errorMessage, null, 'nor was the replacement\'s row annotated with a stranger\'s error')
})

test('o3d-550x: the worker that DOES hold the claim still records its failure', async () => {
  // The counter-guard: fencing must not freeze the row. Without this, the fix would be indistinguishable
  // from "the failure write never lands", which would strand every genuinely failing row in PROCESSING.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  const result = await applyMainSyncFailureRetry(tx, ATTEMPT, ENTRY, 'connection reset', {}, claimHeldFrom(T_REPLACEMENT_CLAIM))

  assert.equal(state!.status, 'PENDING')
  assert.equal(state!.retryCount, 3)
  assert.equal(state!.processingStartedAt, null, 'the claim is given back, so the row can be re-taken')
  assert.equal(result.finalFailure, false)
})

// ---------------------------------------------------------------------------
// THE NON-TERMINAL RELEASE — one statement, so every deferral and every backoff in both runners is
// covered by these two tests rather than by a source scan hoping to spot an unfenced copy.
// (Codex r1, medium 2: "add behavioural displaced-owner tests for deferral and rate-limit paths".)
// ---------------------------------------------------------------------------

const T_BACKOFF = new Date('2026-03-01T09:35:00.000Z')

test('o3d-550x: a rate-limit backoff by a DISPLACED owner releases nothing', async () => {
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
  })

  const released = await releaseClaimForRetry(tx, 'log-1', claimHeldFrom(T_DISPLACED_CLAIM), {
    errorMessage: 'Xero rate limit exceeded',
    nextAttemptAt: T_BACKOFF,
  })

  assert.equal(released, false, 'the caller is told the release did not land')
  assert.equal(state!.status, 'PROCESSING', 'the replacement keeps its claim')
  assert.equal(state!.processingStartedAt?.valueOf(), T_REPLACEMENT_CLAIM.valueOf(), 'and its claim instant is intact')
  assert.equal(state!.errorMessage, null, 'a stranger\'s rate-limit error is not stamped on a live claim')
})

test('o3d-550x: the holder\'s backoff DOES land, with the future instant as the next-claim gate', async () => {
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
  })

  const released = await releaseClaimForRetry(tx, 'log-1', claimHeldFrom(T_REPLACEMENT_CLAIM), {
    errorMessage: 'Xero rate limit exceeded',
    nextAttemptAt: T_BACKOFF,
  })

  assert.equal(released, true)
  assert.equal(state!.status, 'PENDING')
  assert.equal(state!.processingStartedAt?.valueOf(), T_BACKOFF.valueOf())
  assert.equal(state!.errorMessage, 'Xero rate limit exceeded')
})

test('o3d-550x: the payment-ordering deferral is fenced — a displaced owner cannot defer a live claim', async () => {
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
  })

  const deferred = await deferPaymentUntilEarlierLogsPost(tx, { id: 'log-1' }, claimHeldFrom(T_DISPLACED_CLAIM))

  assert.equal(deferred, false)
  assert.equal(state!.status, 'PROCESSING')
  assert.equal(state!.processingStartedAt?.valueOf(), T_REPLACEMENT_CLAIM.valueOf())
})

test('o3d-550x: the holder\'s payment-ordering deferral lands and says why', async () => {
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
  })

  const deferred = await deferPaymentUntilEarlierLogsPost(tx, { id: 'log-1' }, claimHeldFrom(T_REPLACEMENT_CLAIM))

  assert.equal(deferred, true)
  assert.equal(state!.status, 'PENDING')
  assert.equal(state!.errorMessage, 'Deferred until older invoice payment sync logs post')
  assert.ok((state!.processingStartedAt?.valueOf() ?? 0) > Date.now(), 'deferred, not immediately re-claimable')
})

test('o3d-550x: the UPDATE-before-CREATE deferral is fenced too', async () => {
  const displaced = makeRowStore({ id: 'log-1', status: 'PROCESSING', processingStartedAt: T_REPLACEMENT_CLAIM })
  assert.equal(await deferUpdateUntilCreatePosts(displaced.tx, { id: 'log-1' }, claimHeldFrom(T_DISPLACED_CLAIM)), false)
  assert.equal(displaced.state!.status, 'PROCESSING')

  const holder = makeRowStore({ id: 'log-1', status: 'PROCESSING', processingStartedAt: T_REPLACEMENT_CLAIM })
  assert.equal(await deferUpdateUntilCreatePosts(holder.tx, { id: 'log-1' }, claimHeldFrom(T_REPLACEMENT_CLAIM)), true)
  assert.equal(holder.state!.status, 'PENDING')
  assert.equal(holder.state!.errorMessage, 'Deferred until the invoice CREATE for this document posts')
})

// ---------------------------------------------------------------------------
// THE RETRACTION PATH — the cancellation retirement releases the SAME claims, and it is the one that
// terminalises a row, so it is the worst place for a second definition of ownership to drift.
// ---------------------------------------------------------------------------

test('o3d-550x: a displaced owner cannot RETIRE a row a live worker now holds', async () => {
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: null,
  })

  const retired = await retireSalesInvoiceForCancelledOrder(tx, ATTEMPT, 'order-1', claimHeldFrom(T_DISPLACED_CLAIM))

  assert.equal(retired, false)
  assert.equal(state!.status, 'PROCESSING', 'a retraction by a worker that lost the row must do nothing')
})

test('o3d-550x: the claim holder DOES retire, and only while the row names no document', async () => {
  const holder = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: null,
  })
  assert.equal(await retireSalesInvoiceForCancelledOrder(holder.tx, ATTEMPT, 'order-1', claimHeldFrom(T_REPLACEMENT_CLAIM)), true)
  assert.equal(holder.state!.status, 'CANCELLED')

  // The arm that is this call site's own, not part of the shared fence: a row that already posted must
  // never be retired, or a real Xero receivable is hidden behind a CANCELLED row.
  const posted = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: 'INV-XERO-1',
  })
  assert.equal(await retireSalesInvoiceForCancelledOrder(posted.tx, ATTEMPT, 'order-1', claimHeldFrom(T_REPLACEMENT_CLAIM)), false)
  assert.equal(posted.state!.status, 'PROCESSING')
})

// ---------------------------------------------------------------------------
// THE EVIDENCE WRITES
// ---------------------------------------------------------------------------

test('o3d-550x: a posted document is recorded even by a worker whose claim has been taken away', async () => {
  // THE RULE THIS PINS: evidence of a posted document must NEVER be conditional on winning a race. The
  // row is PROCESSING under a claim stamped 20 minutes after this worker's, i.e. this worker is
  // displaced — and it still records, because the fact it is recording already happened in Xero.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: null,
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true)
  assert.equal(state!.externalTransactionId, 'INV-XERO-1', 'the document id is on the row, not only in a log')
  assert.equal(state!.status, 'SYNCED')
  assert.equal(state!.processingStartedAt, null)
})

test('o3d-550x: a posted document is recorded even when the row is no longer claimed at all', async () => {
  // The shape that catches ANY claim-shaped precondition, including `status: 'PROCESSING'`. It is also
  // the likelier one: this worker's claim aged out, a replacement took the row, FAILED, and released it
  // to PENDING — and only then did this worker's request come back carrying a real Xero invoice. If the
  // record were conditional on the claim, that invoice would exist in the ledger with nothing naming it.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PENDING',
    processingStartedAt: null,
    retryCount: 3,
    externalTransactionId: null,
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true, 'the fact that a document exists does not depend on holding a claim')
  assert.equal(state!.externalTransactionId, 'INV-XERO-1')
  assert.equal(state!.status, 'SYNCED')
})

test('o3d-550x: recording a posted document REFUSES to overwrite a different one, and names both', async () => {
  // A newer claim posted its own invoice while this attempt was on the wire. Both exist in Xero.
  // Overwriting would destroy the only local record of the one already on the row.
  const { tx, state, mirrorWrites } = makeRowStore({
    id: 'log-1',
    status: 'SYNCED',
    processingStartedAt: null,
    externalTransactionId: 'INV-XERO-FIRST',
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-SECOND', payload: {} })

  assert.equal(record.recorded, false)
  assert.equal(record.recorded === false && record.reason, 'ANOTHER_DOCUMENT_NAMED')
  assert.equal(
    record.recorded === false && record.reason === 'ANOTHER_DOCUMENT_NAMED' && record.namedExternalId,
    'INV-XERO-FIRST',
    'the caller is told WHICH document the row keeps, so it can escalate with both ids',
  )
  assert.equal(state!.externalTransactionId, 'INV-XERO-FIRST', 'the first document is still the one IMS names')
  assert.deepEqual(mirrorWrites, [], 'and no POSTED mirror event is written for a record that did not land')
})

test('Codex r1 HIGH: the conflict evidence is written IN the transaction that observed the conflict', async () => {
  // THE DEFECT: the displaced id was escalated AFTER this transaction closed, through a logger that
  // catches its own database errors and returns false — a return nobody read. A transient failure there,
  // or a crash in the gap, lost the ONLY local trace of a real Xero document, and on the outbox path the
  // job was then buried as permanently failed. So the evidence must commit with the observation.
  const { tx, activityWrites } = makeRowStore({
    id: 'log-1',
    status: 'SYNCED',
    processingStartedAt: null,
    externalTransactionId: 'INV-XERO-FIRST',
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-SECOND', payload: {} })

  assert.equal(activityWrites.length, 1, 'exactly one durable record of the conflict, written through the tx client')
  const written = activityWrites[0].data
  assert.equal(written.action, 'xero_posted_document_unrecorded')
  assert.equal(written.level, 'ERROR')
  assert.equal(written.entityId, 'log-1')
  assert.equal((written.metadata as Record<string, unknown>).postedExternalId, 'INV-XERO-SECOND')
  assert.equal((written.metadata as Record<string, unknown>).rowNamesExternalId, 'INV-XERO-FIRST')
  assert.match(String(written.description), /INV-XERO-SECOND/, 'the displaced document is named')
  assert.match(String(written.description), /INV-XERO-FIRST/, 'and so is the one the row keeps')
  assert.match(String(written.description), /REMEDY:/, 'and the refusal names something an operator can do')

  // The caller gets that same wording back, so the outbox job's failure message and the activity row
  // cannot describe the same incident two different ways.
  assert.equal(record.recorded === false && record.evidence, String(written.description))
})

test('Codex r1 HIGH: a failed evidence write THROWS — it is never reported as a completed escalation', async () => {
  // The exact failure the old code swallowed. Throwing is what makes it impossible for a caller to mark
  // the outbox job permanently failed on evidence that was never written: the transaction aborts and the
  // job is retried instead of buried.
  const { tx } = makeRowStore({
    id: 'log-1',
    status: 'SYNCED',
    processingStartedAt: null,
    externalTransactionId: 'INV-XERO-FIRST',
  }, { failActivityLog: true })

  await assert.rejects(
    () => recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-SECOND', payload: {} }),
    /activity_log insert failed/,
  )
})

test('o3d-550x: re-recording the SAME document is idempotent, not a refusal', async () => {
  // The crash-after-post replay: the row already carries this exact id (the runner's
  // `entry.externalTransactionId` branch). Refusing here would strand a recoverable row forever.
  const { tx, state, activityWrites } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: 'INV-XERO-1',
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true)
  assert.equal(state!.status, 'SYNCED')
  assert.equal(state!.externalTransactionId, 'INV-XERO-1')
  assert.deepEqual(activityWrites, [], 'the ordinary replay must not file a conflict nobody has')
})

test('o3d-550x: a vanished row is reported as ROW_MISSING, and STILL leaves durable evidence', async () => {
  const { tx, activityWrites } = makeRowStore(null)

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })
  assert.equal(record.recorded, false)
  assert.equal(record.recorded === false && record.reason, 'ROW_MISSING')
  assert.equal(activityWrites.length, 1, 'a document with no row at all is the case that MOST needs a record')
  assert.equal((activityWrites[0].data.metadata as Record<string, unknown>).reason, 'ROW_MISSING')
  assert.match(String(activityWrites[0].data.description), /INV-XERO-1/)
  assert.match(String(activityWrites[0].data.description), /REMEDY:/)
})

// ---------------------------------------------------------------------------
// THE STRUCTURAL GUARD
//
// Codex r1, medium 2: the previous version of this scan read RAW SOURCE, so a commented-out fence
// satisfied it; its positive assertion needed only ONE `heldClaimWhere` anywhere in a runner; and its
// negative scan looked at `accountingSyncLog.update(` while ignoring `updateMany(` — the very call a
// release must use. A commented fence plus an unfenced `updateMany({ where: { id } })` passed.
// ---------------------------------------------------------------------------

/**
 * Remove comments without touching string literals.
 *
 * Naive stripping would eat the `//` in a URL inside a message string and shift every offset after it,
 * which is how a scanner ends up reading a `where` clause that is really the tail of a sentence.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      out += '\n'
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Balanced-paren argument text for the call whose `(` is at `open`. */
function callArgs(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

test('Codex r1 medium 2: the scanner really does remove comments before it asserts anything', () => {
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  // A sentinel that exists ONLY inside a comment in the file being scanned, so this proves the strip
  // ran on the real source rather than on a fixture.
  const SENTINEL = 'o3d-550x: the one fenced release.'
  assert.ok(src.includes(SENTINEL), 'the sentinel comment must exist in the source being scanned')
  const stripped = stripComments(src)
  assert.ok(!stripped.includes(SENTINEL), 'and it must be gone once comments are stripped')
  // Counter-guard: stripping must not have eaten the code. A scanner that returned '' would pass the
  // assertion above and every negative assertion below.
  assert.ok(stripped.includes('export async function recordPostedSyncResult('), 'code survives stripping')
  assert.ok(stripped.includes('accountingSyncLogClaimWhere('), 'and so do the predicates the scan reads')
  // Round 5 expressed this as a BYTE RATIO (`stripped.length > src.length / 2`). That threshold no
  // longer holds and its failure said nothing about the stripper: merging o3d-550x's prose with this
  // branch's took the file past 52% comments, so a perfectly correct strip now returns 48% of the
  // bytes. Replaced rather than lowered, because a ratio was always the weaker way to say it — half
  // the CODE could vanish and a ratio would still pass. Counting surviving top-level declarations
  // cannot be satisfied by an empty result, and cannot be satisfied by a half-eaten one either.
  const declarations = (stripped.match(/^(export )?(async )?function /gm) ?? []).length
  assert.equal(
    declarations,
    (src.match(/^(export )?(async )?function /gm) ?? []).length,
    'a stripper that returned nothing — or that ate code along with the comments — would pass every '
      + 'negative assertion below, so every top-level declaration in the file must survive it',
  )
  assert.ok(declarations > 40, 'and the file really does contain the declarations being counted')
})

test('o3d-550x: neither runner writes the sync row except to CLAIM it or through a fenced helper', () => {
  // Structural, and paired with the behavioural tests above. The rule is stronger than "spot an unfenced
  // release": a runner may touch accountingSyncLog directly ONLY to take the claim. Every state change
  // after that goes through a named helper whose fence is part of the statement, so there is no call
  // shape left in which somebody can forget one.
  const src = stripComments(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const direct = src.slice(
    src.indexOf('async function processPendingXeroSyncDirect('),
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
  )
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )

  // Every write verb, not just `update(` — `updateMany` is the one a release must use, and the previous
  // scan did not look at it at all.
  const WRITE_CALLS = ['accountingSyncLog.update(', 'accountingSyncLog.updateMany(', 'accountingSyncLog.upsert(']

  for (const [name, block] of [['direct', direct], ['outbox', outbox]] as const) {
    assert.ok(block.length > 0, `the ${name} runner block must be found`)

    let claimSites = 0
    for (const call of WRITE_CALLS) {
      let at = block.indexOf(call)
      while (at !== -1) {
        const args = callArgs(block, at + call.length - 1)
        const isClaim = args.includes('accountingSyncLogClaimWhere(')
        const isFenced = args.includes('heldClaimWhere(entry.id, held)')
        if (isClaim) claimSites++
        assert.ok(
          isClaim || isFenced,
          `${name} runner: a direct ${call} whose where is neither the claim predicate nor `
            + `heldClaimWhere(entry.id, held) — this is how an unfenced release gets back in:\n${args.slice(0, 300)}`,
        )
        assert.ok(
          !args.includes("status: 'SYNCED'"),
          `${name} runner: SYNCED must not be written inline — that is the unfenced clobber o3d-550x is about`,
        )
        at = block.indexOf(call, at + 1)
      }
    }
    // SUPERSEDED ASSERTION (o3d-m5qk). This used to be
    //   assert.equal(claimSites, 1, 'the runner takes exactly one claim, and that is its only direct row write')
    // — written when the claim was an inline `updateMany` in each runner. o3d-a3wx round 4 moved the
    // claim itself into `claimAccountingSyncLog`, because an order-scoped INVOICE_PAYMENT must take it
    // under the order row lock TOGETHER with the "is anything else for this order posting?" test, and
    // two runners electing from their own snapshots is not exclusion. So the runners now have ZERO
    // direct row writes, which is STRICTLY STRONGER than "exactly one", and that is what is asserted —
    // plus that the claim is still taken, through the one helper, so the rule cannot be satisfied by a
    // runner that simply stopped claiming.
    assert.equal(claimSites, 0, `the ${name} runner must make NO direct row write at all`)
    assert.ok(
      block.includes('claimAccountingSyncLog(entry, claimedAt, staleClaimCutoff)'),
      `the ${name} runner must still take its claim, and only through the one helper`,
    )

    // And the releases it DOES perform go through the shared statements, which carry the fence.
    assert.ok(
      block.includes('releaseClaimForRetry(') || block.includes('deferPaymentUntilEarlierLogsPost('),
      `the ${name} runner must release claims through the shared fenced release`,
    )
    // ONE call path for the evidence, and it is the one that cannot hand an unwritable record to the
    // ordinary retry (Codex r2, HIGH). A runner that opened its own transaction around
    // recordPostedSyncResult would be back to throwing into `catch (e)` as though it were a sync error.
    assert.ok(
      block.includes('recordPostedDocumentDurably(entry, '),
      `the ${name} runner must record a posted document through recordPostedDocumentDurably`,
    )
    assert.ok(
      !block.includes('recordPostedSyncResult('),
      `the ${name} runner must not call the evidence write directly — that is how a caller ends up `
        + 'owning the transaction, and an unwritable record then reads as an ordinary sync failure',
    )
  }
})

test('o3d-m5qk: the claim helper is the ONLY writer of the claim predicate, and it fences the row it takes', () => {
  // The counterpart to the rule above. Moving the claim out of the runners is only an improvement while
  // the helper it moved into cannot itself write the row on any other terms — otherwise "zero direct
  // writes in the runner" is satisfied by a helper that writes whatever it likes.
  const src = stripComments(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const helper = src.slice(
    src.indexOf('async function claimAccountingSyncLog('),
    src.indexOf('export function invoicePaymentDeferralMessage('),
  )
  assert.ok(helper.length > 0, 'the claim helper must be found')

  const WRITE_CALLS = ['accountingSyncLog.update(', 'accountingSyncLog.updateMany(', 'accountingSyncLog.upsert(']
  let writes = 0
  for (const call of WRITE_CALLS) {
    let at = helper.indexOf(call)
    while (at !== -1) {
      const args = callArgs(helper, at + call.length - 1)
      assert.ok(
        args.includes('accountingSyncLogClaimWhere('),
        `the claim helper wrote the row on terms other than the claim predicate:\n${args.slice(0, 300)}`,
      )
      writes++
      at = helper.indexOf(call, at + 1)
    }
  }
  assert.equal(writes, 2, 'exactly two claim writes: the unlocked path and the order-locked one')

  // The order lock and the exclusion test must both be INSIDE the transaction that takes the claim,
  // and the claim write must come after them — otherwise the read that authorises the claim and the
  // claim itself can be interleaved by another runner, which is the whole defect.
  const txAt = helper.indexOf('db.$transaction(')
  assert.ok(txAt > 0, 'the order-scoped claim must be taken in a transaction')
  const lockAt = helper.indexOf('lockSalesOrder(tx,', txAt)
  const decideAt = helper.indexOf('decideInvoicePaymentClaim(', txAt)
  const writeAt = helper.indexOf('tx.accountingSyncLog.updateMany(', txAt)
  assert.ok(lockAt > txAt, 'the order row lock must be taken inside the transaction')
  assert.ok(decideAt > lockAt, 'the exclusion test must be evaluated under the lock')
  assert.ok(writeAt > decideAt, 'and the claim written only after it')
})

test('Codex r1 HIGH: no runner escalates an unrecordable document through the best-effort logger', () => {
  // The shape of the defect, pinned so it cannot come back as "just log it afterwards". The evidence is
  // written by recordPostedSyncResult inside the conflict transaction; a caller that reached for
  // logActivity/logActivityPersisted on this path would be swallowing failures again.
  const src = stripComments(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )
  const direct = src.slice(
    src.indexOf('async function processPendingXeroSyncDirect('),
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
  )
  for (const [name, block] of [['direct', direct], ['outbox', outbox]] as const) {
    for (const chunk of block.split('if (!record.recorded) {').slice(1)) {
      const body = chunk.slice(0, chunk.indexOf('\n        }'))
      assert.ok(
        !body.includes('logActivity'),
        `${name} runner: the unrecordable-document branch must not write its evidence through the `
          + 'best-effort logger — it swallows database failures and returns false',
      )
    }
    // The outbox runner may only bury the job using the evidence the transaction already committed.
    if (name === 'outbox') {
      assert.ok(
        block.includes('markXeroOutboxPermanent(job, record.evidence)'),
        'the outbox runner must bury the job with the wording of the record it has proof of',
      )
    }
  }
})
