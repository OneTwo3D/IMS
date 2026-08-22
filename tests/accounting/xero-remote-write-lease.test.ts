import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xl63 ROUND 5, FINDING 1 & 2 — THE CLAIM AT THE MOMENT IT IS RELIED ON.
 *
 * Round 4 re-took the claim once, in front of `processEntry`, and flagged in its own commit message
 * what that left open: "time burnt inside the processor between the re-take and each individual push
 * call is still unfenced". `processEntry` is not a POST. It reads the granted scopes, guards against a
 * cancelled order, resolves contacts and looks items up — and every one of those goes through a client
 * whose in-request budget is six minutes PER CALL. So the claim proven at the top of the entry can be
 * long gone by the time the document is actually sent.
 *
 * And at the far end the same gap existed inside the persist itself: its deadline was derived from a
 * claim believed held, but the write it then made was `update({ where: { id } })` — conditioned on
 * nothing. A claim taken in between was invisible to it, and the write would flip a row another worker
 * was posting under to SYNCED, carrying this worker's id.
 *
 * THE DOUBLE HERE HONOURS `where`, WHICH IS THE ENTIRE POINT. A double that returns a canned count
 * cannot observe a fence at all: every one of these tests would pass against completely unfenced code,
 * because the thing under test IS the WHERE clause. So `accountingSyncLog.updateMany` below evaluates
 * the predicate against real row state, and "another worker steals the row" is a real mutation of that
 * state at a chosen instant rather than a number a test asserted into existence.
 */

const CLAIM_STALE_MS = 15 * 60 * 1000

type Row = Record<string, unknown>

const state = {
  row: null as Row | null,
  posted: [] as string[],
  activity: [] as Array<{ action?: string; level?: string; description?: string; metadata?: Record<string, unknown> }>,
  mirroredEventWrites: 0,
  /** Raw statements run inside a transaction — the database-clock stamp (o3d-batch-billpay). */
  databaseClockStamps: 0,
  /** Called when processEntry reads the granted scopes — i.e. after the lease opens, before any fence. */
  onScopes: null as (null | (() => void)),
  /** Called from inside the mocked push, i.e. after the document has "reached Xero". */
  onPost: null as (null | (() => void)),
  pendingServed: false,
  outbox: {
    lockHeld: true,
    calls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  },
  /** Every fenced write attempted against the sync row, with whether it MATCHED. */
  syncLogWrites: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown>; count: number }>,
  /** How many interactive transactions have been STARTED (the persist re-drives across failures). */
  transactionAttempts: 0,
  /**
   * Called before each transaction body runs, with the attempt number. May throw (to model an
   * exhausted pool) and may mutate the row (to model another statement landing in between).
   */
  beforeTransaction: null as (null | ((attempt: number) => Promise<void> | void)),
}

/** What Prisma raises when an interactive transaction cannot be STARTED — the production shape. */
function poolExhausted(): Error {
  return Object.assign(new Error('Unable to start a transaction in the given time'), {
    code: 'P2028',
    name: 'PrismaClientKnownRequestError',
  })
}

/** Evaluate one Prisma-style predicate against a value. Only the shapes this module actually uses. */
function matchValue(value: unknown, predicate: unknown): boolean {
  if (predicate === null) return value === null || value === undefined
  if (predicate instanceof Date) return value instanceof Date && value.getTime() === predicate.getTime()
  if (predicate !== null && typeof predicate === 'object') {
    const p = predicate as Record<string, unknown>
    if ('lt' in p) return value != null && Number(value) < Number(p.lt)
    if ('lte' in p) return value != null && Number(value) <= Number(p.lte)
    if ('gt' in p) return value != null && Number(value) > Number(p.gt)
    if ('gte' in p) return value != null && Number(value) >= Number(p.gte)
    if ('in' in p) return (p.in as unknown[]).includes(value)
    if ('not' in p) return value !== p.not
    throw new Error(`the double does not implement the predicate ${JSON.stringify(predicate)} — it must not GUESS`)
  }
  return value === predicate
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, predicate] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(predicate as Array<Record<string, unknown>>).some((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(predicate as Array<Record<string, unknown>>).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    // o3d-anu8 r3: `NOT` is a real Prisma operator and the claim/custody statement now uses one —
    // `stampingCustodyOnClaim` refuses to restore custody to a money row that carries neither
    // custody nor an attempt stamp. Interpreting it (rather than ignoring it, or throwing) is what
    // makes these doubles evaluate the predicate production evaluates.
    if (key === 'NOT') {
      if (matchesWhere(row, predicate as Record<string, unknown>)) return false
      continue
    }
    if (!matchValue(row[key], predicate)) return false
  }
  return true
}

function syncLogModel(): Record<string, unknown> {
  return {
    findMany: async ({ where }: { where?: Record<string, unknown> }) => {
      if (state.pendingServed || !state.row) return []
      state.pendingServed = true
      return where && !matchesWhere(state.row, where) ? [] : [{ ...state.row }]
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const matched = !!state.row && matchesWhere(state.row, where)
      state.syncLogWrites.push({ where, data, count: matched ? 1 : 0 })
      if (!matched) return { count: 0 }
      Object.assign(state.row!, data)
      return { count: 1 }
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (state.row && matchesWhere(state.row, where)) Object.assign(state.row, data)
      return { ...state.row }
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      (state.row && matchesWhere(state.row, where) ? { ...state.row } : null),
    findFirst: async () => null,
    count: async () => 0,
  }
}

function makeDbDouble(): Record<string, unknown> {
  const permissive = new Proxy({}, {
    get: (_target, method: string) => async () => {
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'findUnique' || method === 'findFirst') return null
      if (method === 'updateMany') return { count: 1 }
      return {}
    },
  })
  const events = new Proxy({}, {
    get: (_target, method: string) => async () => {
      if (method === 'findMany') return []
      if (method === 'findUnique' || method === 'findFirst') return null
      state.mirroredEventWrites += 1
      // The mirror UPDATEs the event and then writes a log row keyed on the returned id, so the
      // double must return one: `{}` made every settling write throw out of the mirror instead of
      // completing, which would have made these assertions about the persist vacuous.
      return method === 'updateMany' ? { count: 1 } : { id: 'event-1' }
    },
  })
  const syncLog = syncLogModel()
  const db: Record<string, unknown> = new Proxy({}, {
    get: (_target, key: string) => {
      if (key === '$transaction') {
        return async (arg: unknown) => {
          state.transactionAttempts += 1
          await state.beforeTransaction?.(state.transactionAttempts)
          return typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : []
        }
      }
      if (key === 'then') return undefined
      // o3d-batch-billpay (o3d-clxw r4), merged into development after this double was written: the
      // settling transaction stamps `syncedAt` from the DATABASE's clock straight after the fenced
      // write. `$executeRaw` is used as a TAGGED TEMPLATE and so must be a FUNCTION — the permissive
      // proxy below hands back a value only for METHOD access, so an un-taught double died on
      // "$executeRaw is not a function" inside the persist and the re-drive assertions read as a
      // pool failure. Counted, so the stamp's presence is observable here too.
      if (key === '$executeRaw' || key === '$executeRawUnsafe') {
        return async () => { state.databaseClockStamps += 1; return 1 }
      }
      // o3d-7o0, merged into development as part of #639: the cancelled-order guard now takes the
      // sales order's ROW LOCK before it reads the status, so a cancellation cannot commit between
      // the read and the post. The lock is a `SELECT ... FOR UPDATE` through `$queryRaw`, and an
      // un-taught double made the guard fail with "could not read sales order" — which this file
      // then reported as "nothing was posted", i.e. as a claim/lease failure with nothing at all to
      // do with claims. Locking behaviour itself is pinned in the allocation-service tests.
      if (key === '$queryRaw' || key === '$queryRawUnsafe') return async () => []
      if (key === 'accountingSyncLog') return syncLog
      if (key === 'accountingEvent' || key === 'accountingEventLog') return events
      if (key === 'integrationOutbox') {
        return {
          updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            state.outbox.calls.push(args)
            return { count: state.outbox.lockHeld ? 1 : 0 }
          },
        }
      }
      if (key === 'salesOrder') {
        return { findUnique: async () => ({ id: 'so-1', customerId: 'cust-1', status: 'PROCESSING' }), update: async () => ({}) }
      }
      return permissive
    },
  })
  return db
}

mock.module('@/lib/db', {
  namedExports: {
    db: makeDbDouble(),
    POST_REMOTE_PERSIST_TX_OPTIONS: { maxWait: 11_000, timeout: 15_000 },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
    logActivityPersisted: async (entry: Record<string, unknown>) => { state.activity.push(entry); return true },
    // Merged into development after this double was written (#637/#638): the unrecorded-posted-document
    // record is redacted and its metadata sanitised before it is filed. A double without these throws
    // INSIDE the evidence write, which then reports itself as "the record could not be saved" — an
    // alarming failure that is really just a missing test stub. Identity stand-ins: this file asserts
    // on the CONTENT of what is filed, not on how it is scrubbed.
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (metadata: unknown) => metadata,
  },
})
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getGrantedScopes: async () => { state.onScopes?.(); return null },
    // o3d-k26m.5 (merged into development after this double was written): before a sales-invoice
    // CREATE is sent, the processor asks the LEDGER who holds the invoice number, and that lookup
    // resolves the connection itself. A double without this made the lookup throw, and the fence
    // FAILS CLOSED — so every test in this file refused before it posted, and the lease properties
    // they exist to prove were never reached.
    getAccessToken: async () => ({ accessToken: 'access-1', tenantId: 'tenant-A' }),
  },
})
// The ledger's answer: NOBODY holds this number, from the organisation this worker is connected to.
// Mocked rather than driven through the HTTP layer because this file is about the claim lease, not
// about number ownership — that fence is pinned in tests/connectors/xero-invoice-number-post-slot.
mock.module('@/lib/connectors/xero/invoice-number-claim', {
  namedExports: {
    lookupXeroInvoiceNumberClaim: async () => ({ ok: true, claims: [], tenantId: 'tenant-A' }),
  },
})
mock.module('@/lib/connectors/xero/invoices', {
  namedExports: {
    pushSalesInvoice: async (data: { invoiceNumber: string }) => {
      state.posted.push(data.invoiceNumber)
      // The document has now reached Xero. Anything that happens after this line happens while the
      // ledger already holds it.
      state.onPost?.()
      return { success: true, invoiceId: 'XERO-INV-1', invoiceNumber: data.invoiceNumber }
    },
    updateSalesInvoice: async () => ({ success: true, invoiceId: 'XERO-INV-1' }),
  },
})

const processor = () => import('@/lib/connectors/xero/sync-processor')

function reset(): void {
  state.row = {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: null,
    retryCount: 0,
    errorMessage: null,
    processingStartedAt: null,
    createdAt: new Date('2026-08-20T09:00:00.000Z'),
    payload: { invoiceNumber: 'INV-1', contactName: 'A Customer', date: '2026-08-20', currency: 'GBP', lines: [] },
  }
  state.posted = []
  state.activity = []
  state.mirroredEventWrites = 0
  state.databaseClockStamps = 0
  state.onScopes = null
  state.onPost = null
  state.pendingServed = false
  state.outbox = { lockHeld: true, calls: [] }
  state.syncLogWrites = []
  state.transactionAttempts = 0
  state.beforeTransaction = null
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
}

/** The fenced write that records the posted document, if it was attempted at all. */
function settlingWrite() {
  return state.syncLogWrites.find((w) => w.data.status === 'SYNCED' && w.data.externalTransactionId === 'XERO-INV-1')
}

/**
 * A SECOND worker tries to record a DIFFERENT document against the same row.
 *
 * This is the guarantee o3d-550x (#639) substitutes for the claim fence that used to sit on the
 * settling write, so a test that stops asserting the fence has to assert this instead — otherwise the
 * rewrite would have removed a check and replaced it with nothing.
 */
async function recordSecondDocument(externalId: string) {
  const { recordPostedDocumentDurably } = await processor()
  return recordPostedDocumentDurably(
    { id: 'log-1', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
    externalId,
    state.row!.payload as Record<string, unknown>,
  )
}

/** Another worker re-claims the row: same id, a claim stamp that is not ours. */
function stealTheRow(): void {
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = new Date('2031-01-01T00:00:00.000Z')
}

test('r5 #1: a claim lost DURING the entry — after the lease opened, before the document was sent — posts nothing', async () => {
  reset()
  // The theft lands where round 4 could not see it: inside processEntry, between the lease opening and
  // the push. This is the scope read; in production it is any of the reads that precede a post, each of
  // which can sit out a rate limit for minutes.
  state.onScopes = stealTheRow

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, [],
    'the document must NOT be sent: the row now belongs to another worker, so this would be the second one')
  assert.equal(result.succeeded, 0)
  assert.equal(result.skipped, 1, 'handed back, not failed — nothing was sent, so no retry should be spent')
  assert.equal(result.failed, 0)

  const warning = state.activity.find((a) => a.action === 'xero_sync_claim_lost_before_post')
  assert.ok(warning, 'the lost claim is recorded, not swallowed')
  assert.match(warning.description ?? '', /posting would have created a second document/)
  assert.equal(warning.metadata?.operation, 'sales-invoice',
    'and names WHICH remote write was refused, which is the whole difference between this and round 4')
  assert.equal(warning.metadata?.reason, 'claim-lost')

  assert.equal(state.row?.status, 'PROCESSING')
  assert.deepEqual(state.row?.processingStartedAt, new Date('2031-01-01T00:00:00.000Z'),
    "and the thief's claim is left exactly as it was — nothing this worker did touched the row")
})

test('control: with the claim held throughout, the sweep posts exactly once and records it', async () => {
  reset()

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, ['INV-1'], 'the ordinary path must be untouched by the fences')
  assert.equal(result.skipped, 0, 'nothing was handed back')
  // Asserted on the WRITE rather than on `result.succeeded` or on the row's final state: the follow-up
  // enqueue that runs after the persist reaches plumbing this double does not model, and hands the row
  // back to PENDING afterwards. The property under test is that the fenced write LANDED.
  const settled = settlingWrite()
  assert.ok(settled, 'the persist must have attempted to record the document')
  assert.equal(settled.count, 1, 'and its precondition MATCHED — the ordinary path is not blocked by it')
  // r5 #2 asserted the claim itself here (`where.processingStartedAt instanceof Date`, `where.status
  // === 'PROCESSING'`). SUPERSEDED by #639 — see the r5 #2 test below for the full reasoning. The
  // property this control exists to prove is that the ordinary path is not blocked by whatever
  // precondition the settling write carries, so the precondition is asserted, just not that one.
  assert.ok(
    Array.isArray((settled.where as { OR?: unknown[] }).OR),
    'the settling write still carries a precondition — the "do not overwrite a DIFFERENT document" '
      + 'OR-clause — rather than being keyed on the row id alone',
  )
  assert.equal(state.activity.some((a) => a.action === 'xero_sync_claim_lost_before_post'), false)
  assert.equal(state.activity.some((a) => a.action === 'xero_sync_claim_lost_during_persist'), false)
})

/**
 * o3d-xl63 r5 #2, REWRITTEN AGAINST THE MERGED RULE — and this is the one place in this rebase where
 * the two branches genuinely disagreed rather than merely collided.
 *
 * WHAT r5 #2 ASSERTED. The claim is stolen while the document is on the wire; the settling write is
 * fenced on this worker's claim, matches NO row, and the persist therefore records NOTHING over the
 * new owner — the displaced document id surviving only in an ERROR alarm.
 *
 * WHY IT NO LONGER HOLDS. o3d-550x (merged as #639) considered claim-fencing this exact write and
 * rejected it in as many words: "Making it conditional on still holding the claim would mean the
 * displaced worker — the one that DID post — writes nothing, and the document exists in Xero with
 * nothing in IMS naming it." Its precondition is the fact it protects instead: the row must not
 * already name a DIFFERENT document. In THIS scenario the thief has not recorded anything yet, so
 * the precondition holds and the real document id is written to the row rather than left in a log.
 *
 * WHAT IS ASSERTED NOW. The same scenario, and the same thing that actually matters: a document that
 * reached Xero is not lost, and a second, different document cannot be silently written over it.
 * The two rules disagree about WHICH id ends up on the row; they agree completely that neither id may
 * vanish, and that is what this test pins.
 */
test('r5 #2 (superseded): a claim taken WHILE the document was in flight cannot LOSE the document', async () => {
  reset()
  // The narrowest window there is, and the one no pre-check can close: the claim is taken after the
  // persist's deadline was derived and before its write lands.
  state.onPost = stealTheRow

  const { processPendingXeroSync } = await processor()
  await processPendingXeroSync()

  assert.deepEqual(state.posted, ['INV-1'], 'the document DID reach Xero — that is the premise of this test')

  const settled = settlingWrite()
  assert.ok(settled,
    'the persist must have been ATTEMPTED — otherwise this test proves nothing about the precondition, '
      + 'only that the code took some other branch')
  assert.ok(
    Array.isArray((settled.where as { OR?: unknown[] }).OR),
    'and it carries the "do not overwrite a DIFFERENT document" precondition rather than being keyed '
      + 'on the row id alone — an `update({ where: { id } })` could not have refused anything',
  )

  // THE POINT. The row now names the document that was actually posted. Under r5 #2 this id lived
  // only in an activity-log alarm; under #639 it is on the row, which is strictly more recoverable.
  assert.equal(state.row?.externalTransactionId, 'XERO-INV-1',
    'the displaced worker DID post this document, so its id must be recorded somewhere durable')

  // And the half that makes the disagreement safe either way: the next worker cannot quietly replace
  // it. A different document arriving for the same row is refused, not written over the top.
  const otherWorker = await recordSecondDocument('XERO-INV-2')
  assert.equal(otherWorker.recorded, false,
    'a SECOND, different document must not be able to overwrite the first — that is the guarantee '
      + 'o3d-550x substitutes for the claim fence, and it is what stops an id being lost')
  assert.equal(state.row?.externalTransactionId, 'XERO-INV-1', 'the row keeps the id it already names')
})

test('r5 #1: the absolute lease deadline covers the preparation calls and is NOT extended by a renewal', async () => {
  reset()
  const { openRemoteWriteLease, XERO_ENTRY_LEASE_MS } = await processor()

  // Claim the row as the sweep would, so the lease has something to renew.
  const claimedAt = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAt

  let clock = 0
  const lease = await openRemoteWriteLease('log-1', claimedAt, undefined, () => clock)
  assert.ok(lease, 'the claim was ours, so the lease opened')
  assert.equal(lease.deadlineAt, XERO_ENTRY_LEASE_MS, 'fixed from the moment the entry started')

  // A renewal mid-entry: the claim moves, the deadline does not.
  clock = XERO_ENTRY_LEASE_MS - 1
  const early = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(early.ok, true, 'one millisecond inside the lease, the write may still begin')
  assert.equal(lease.deadlineAt, XERO_ENTRY_LEASE_MS,
    'and renewing the CLAIM must not renew the LEASE — otherwise a row wedged behind a rate limit '
      + 'renews itself for ever and never posts')

  const heldAfterRenewal = lease.heldFrom()
  clock = XERO_ENTRY_LEASE_MS
  const late = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(late.ok, false,
    'ON the deadline the remote write must not begin — the lease is spent, and a renewal that reset it '
      + 'would let one entry hold the row for ever without ever posting')
  assert.equal(late.ok === false && late.result.notPosted?.reason, 'lease-expired',
    'and it is the LEASE that refused, not a lost claim: the claim here is still ours')
  assert.match(late.ok === false ? late.result.error ?? '' : '', /preparation calls included/)
  assert.deepEqual(lease.heldFrom(), heldAfterRenewal,
    'and an expired lease does not extend its own claim on the way to refusing — the deadline is '
      + 'checked BEFORE the renewal')
})

test('r5 #1: the fence renews the OUTBOX lock too, and refuses without touching the row claim when it is gone', async () => {
  reset()
  const { openRemoteWriteLease } = await processor()

  const claimedAt = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAt

  const outboxRows = state.outbox.calls

  const lockedAt = new Date('2026-08-20T10:00:00.000Z')
  const job = { id: 'job-1', lockedAt, attempts: 0 } as unknown as Parameters<typeof openRemoteWriteLease>[2]

  const lease = await openRemoteWriteLease('log-1', claimedAt, job)
  assert.ok(lease)

  const ok = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(ok.ok, true)
  assert.equal(outboxRows.length, 1, 'the fence renews the queue-side lock as well as the row claim')
  assert.equal(outboxRows[0].where.id, 'job-1')
  assert.deepEqual(outboxRows[0].where.lockedAt, lockedAt,
    'fenced on the EXACT lock this worker holds — anything looser would renew a lock somebody else took')
  assert.ok((job as { lockedAt: Date }).lockedAt.getTime() > lockedAt.getTime(),
    "and advances the caller's copy, or every markXeroOutbox* helper would fence on a lockedAt that no longer exists")

  // Now the queue side is taken. The refusal must come BEFORE the row claim is renewed, so the two
  // never disagree about who holds this work.
  state.outbox.lockHeld = false
  const heldBefore = lease.heldFrom()
  const lost = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(lost.ok, false)
  assert.equal(lost.ok === false && lost.result.notPosted?.reason, 'claim-lost')
  assert.match(lost.ok === false ? lost.result.error ?? '' : '', /lock on outbox job job-1/)
  assert.deepEqual(lease.heldFrom(), heldBefore,
    'the row claim is left exactly as it was: the outbox lock is checked first for precisely this reason')
})

/**
 * ROUND 5 — ONE DEFINITION OF "I STILL HOLD THIS CLAIM", AND IT IS READ AT THE MOMENT IT IS USED.
 *
 * `heldClaimWhere` is the sibling branches' helper (o3d-batch-payidx fences every RELEASE of a claim
 * with it; o3d-batch-invnum fences the pre-post invoice-number stamp with it), adopted here by name
 * and shape rather than reinvented, so a merge that keeps one definition does not silently change
 * what the other two meant by ownership.
 *
 * What THIS branch adds is that the claim instant MOVES: the lease renews it before every remote
 * mutation. Both sibling branches capture `claimedAt` once, at the top of the sweep loop, and fence
 * on that value much later. Against this branch such a fence matches nothing — and because these
 * fences all fail closed, the failure is silent refusal of legitimate work rather than a visible
 * error. That is the one thing a merge has to preserve, so it is pinned here rather than described
 * in a commit message.
 */
test('r5: a claim instant captured at the top of the loop is NOT ownership once the lease has renewed', async () => {
  reset()
  const { openRemoteWriteLease, heldClaimWhere, claimHeldFrom } = await processor()
  const { db } = await import('@/lib/db') as unknown as {
    db: { accountingSyncLog: { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> } }
  }

  // The claim as the sweep loop takes it, which is the value a sibling branch would carry downstream.
  const claimedAtTopOfLoop = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAtTopOfLoop

  const lease = await openRemoteWriteLease('log-1', claimedAtTopOfLoop)
  assert.ok(lease, 'the claim was ours, so the lease opened')
  const fence = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(fence.ok, true, 'and it is still ours at the fence — no theft in this test at all')

  const heldNow = lease.heldFrom()
  assert.ok(heldNow.getTime() > claimedAtTopOfLoop.getTime(),
    'opening the lease and fencing each renewed the claim, so the instant the row carries has moved')

  // A consumer fencing on the captured instant. Driven through the double, which evaluates the WHERE
  // against real row state — a canned count could not tell these two cases apart at all.
  const stale = await db.accountingSyncLog.updateMany({
    where: heldClaimWhere('log-1', claimHeldFrom(claimedAtTopOfLoop)),
    data: { errorMessage: 'fenced-on-the-captured-instant' },
  })
  assert.equal(stale.count, 0,
    'a fence on the captured instant matches NOTHING: this worker still owns the row, but not under that stamp')
  assert.notEqual(state.row?.errorMessage, 'fenced-on-the-captured-instant',
    'and it fails CLOSED — the write is refused, which is why the mistake is silent rather than loud')

  // The same consumer, reading the claim from the lease at the moment it uses it.
  const current = await db.accountingSyncLog.updateMany({
    where: heldClaimWhere('log-1', claimHeldFrom(heldNow)),
    data: { errorMessage: 'fenced-on-the-held-instant' },
  })
  assert.equal(current.count, 1, 'read from the lease at the point of use, the very same fence matches')
  assert.equal(state.row?.errorMessage, 'fenced-on-the-held-instant')

  // r6: AND THE LEASE IS ITSELF A CLAIM. `heldClaimWhere(id, lease)` needs no adapter — the accessor
  // name is the contract — and because the instant is read when the WHERE is built, a fence written
  // once against the lease keeps matching across a renewal that a captured value would have missed.
  const beforeAnotherRenewal = lease.heldFrom()
  // `renewClaimForRemoteWrite` stamps `new Date()`, so the two renewals must land in different
  // milliseconds for "the instant moved" to be observable at all.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const fenceAgain = await lease.fenceBeforeRemoteWrite('invoice-payment')
  assert.equal(fenceAgain.ok, true)
  assert.ok(lease.heldFrom().getTime() > beforeAnotherRenewal.getTime(), 'the claim moved again')
  assert.deepEqual(heldClaimWhere('log-1', lease).processingStartedAt, lease.heldFrom(),
    'the lease satisfies HeldClaim structurally, and the fence reads it at the moment of use')
  const throughTheLease = await db.accountingSyncLog.updateMany({
    where: heldClaimWhere('log-1', lease),
    data: { errorMessage: 'fenced-through-the-lease' },
  })
  assert.equal(throughTheLease.count, 1, 'a fence built from the lease tracks the renewal it would otherwise have missed')
  assert.equal(state.row?.errorMessage, 'fenced-through-the-lease')
  const staleAfterRenewal = await db.accountingSyncLog.updateMany({
    where: heldClaimWhere('log-1', claimHeldFrom(beforeAnotherRenewal)),
    data: { errorMessage: 'must-not-land-either' },
  })
  assert.equal(staleAfterRenewal.count, 0,
    'while the instant captured one fence ago matches nothing — which is the silent refusal r6 removes')
  assert.notEqual(state.row?.errorMessage, 'must-not-land-either')

  // And a genuine theft is still refused, so the fence has not been loosened into a no-op.
  stealTheRow()
  const stolen = await db.accountingSyncLog.updateMany({
    where: heldClaimWhere('log-1', lease),
    data: { errorMessage: 'must-not-land' },
  })
  assert.equal(stolen.count, 0, "once another worker re-stamps the row, the held instant stops matching too")
  assert.notEqual(state.row?.errorMessage, 'must-not-land')

  // THE DEFINITION ITSELF, because a merge keeps exactly one of the three copies. Matching on
  // `status: 'PROCESSING'` alone is not ownership — the replacement's row is PROCESSING too.
  assert.deepEqual(Object.keys(heldClaimWhere('log-1', claimHeldFrom(heldNow))).sort(), ['id', 'processingStartedAt', 'status'],
    'identical to the helper on o3d-batch-payidx and o3d-batch-invnum: three fields, no more, no fewer')
  assert.equal(heldClaimWhere('log-1', claimHeldFrom(heldNow)).status, 'PROCESSING')
  assert.deepEqual(heldClaimWhere('log-1', claimHeldFrom(heldNow)).processingStartedAt, heldNow)
})

/**
 * o3d-xl63 ROUND 6 — THE PERSIST HOLDS THE CLAIM, NOT A PHOTOGRAPH OF IT.
 *
 * `persistPostedXeroDocument` used to take `claimedAt: Date`, read once by the caller as
 * `lease.heldFrom()`. Everything it then does — the settling write's fence, the deadline, and the
 * give-up path's terminal write — was measured against that one value, minutes after it was read.
 *
 * On a branch that RENEWS the claim that is the wrong value by construction, and the failure is
 * silent: the fence fails closed, so a WHERE built from a superseded instant matches nothing, and
 * "matched nothing" is indistinguishable from "another worker owns this row". The two tests below
 * pin both ends of it — the ordinary settling write and the give-up path — with the row state the
 * double actually evaluates the predicate against, so an unfenced or wrongly-fenced write cannot pass.
 */
test('r6: a claim renewed while the persist is RE-DRIVEN is the claim the settling write fences on', async () => {
  reset()
  const { openRemoteWriteLease, persistPostedXeroDocument } = await processor()

  const claimedAtTopOfLoop = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAtTopOfLoop

  const lease = await openRemoteWriteLease('log-1', claimedAtTopOfLoop)
  assert.ok(lease, 'the claim was ours, so the lease opened')
  const heldWhenThePersistWasCalled = lease.heldFrom()

  // The re-drive window: the first transaction cannot be STARTED (the exhausted pool), and before the
  // second one the lease renews the claim — which is what the lease does at every fence, and what a
  // concurrent renewal for this row looks like from the persist's point of view.
  const renewals: Date[] = []
  state.beforeTransaction = async (attempt) => {
    if (attempt === 1) throw poolExhausted()
    if (attempt === 2 && renewals.length === 0) {
      const fence = await lease.fenceBeforeRemoteWrite('invoice-payment')
      assert.equal(fence.ok, true, 'the row is still ours — the renewal is legitimate, not a theft')
      renewals.push(lease.heldFrom())
    }
  }

  const recorded = await persistPostedXeroDocument({
    entry: { id: 'log-1', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
    // The row's own payload, so the mirrored-event write runs exactly as it does in the sweep.
    payload: state.row!.payload as Record<string, unknown>,
    externalId: 'XERO-INV-1',
    // THE LEASE, not `lease.heldFrom()`.
    claim: lease,
  })

  assert.equal(renewals.length, 1, 'the scenario ran: the claim moved between the two attempts')
  const renewed = renewals[0]
  assert.ok(renewed.getTime() > heldWhenThePersistWasCalled.getTime(),
    'and it moved FORWARD, so a caller-side snapshot would now be a superseded instant')
  assert.equal(state.transactionAttempts, 2, 'one failure to start, then the re-drive')

  assert.deepEqual(recorded, { persisted: true },
    'the document Xero holds is recorded across the re-drive')
  const settled = settlingWrite()
  assert.ok(settled, 'the settling write was attempted')
  assert.equal(settled!.count, 1, 'and it MATCHED — the double evaluated the WHERE against real row state')
  // r6 asserted that the RENEWED instant appears in this WHERE. SUPERSEDED: #639 does not put the
  // claim on this write at all (see the r5 #2 test above). The r6 property — the persist holds the
  // CLAIM and not a photograph of it — is still real and is still asserted, at the two places that
  // still read it: the deadline, which is why this re-drive was allowed to continue at all after the
  // claim moved, and the give-up path's terminal write in the test below. Both would break under a
  // caller-side snapshot; neither is touched by the settling write's precondition changing.
  assert.equal(state.row?.status, 'SYNCED')
  assert.equal(state.row?.externalTransactionId, 'XERO-INV-1')
  assert.equal(
    state.activity.filter((a) => a.action === 'xero_sync_claim_lost_during_persist').length, 0,
    'and no lost-claim alarm is raised for a claim that was never lost',
  )
})

test('r6: the give-up path records the external id against the RENEWED claim, not the one the persist started with', async () => {
  reset()
  const { persistPostedXeroDocument } = await processor()

  // A claim with 300ms of spendable life left, so the whole re-drive plays out in milliseconds instead
  // of the fourteen real minutes a freshly renewed claim would buy. A real lease stamps `new Date()`
  // and cannot be positioned like this, so the claim is hand-built — but it is the same shape the
  // lease exposes: an accessor answering the instant the row currently carries.
  let held = new Date(Date.now() - (CLAIM_STALE_MS - 60_000 - 300))
  const claim = { heldFrom: () => held }
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = held
  const heldWhenThePersistWasCalled = held

  // No transaction ever starts. Partway through, the claim is renewed — the row's stamp moves, and so
  // does the claim, because they are the same fact.
  state.beforeTransaction = (attempt) => {
    if (attempt === 2) {
      held = new Date(held.getTime() + 5_000)
      state.row!.processingStartedAt = held
    }
    throw poolExhausted()
  }

  const recorded = await persistPostedXeroDocument({
    entry: { id: 'log-1', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
    payload: {},
    externalId: 'XERO-INV-1',
    claim,
  })

  assert.ok(state.transactionAttempts >= 2, 'the persist was re-driven across the failure before giving up')
  assert.notDeepEqual(held, heldWhenThePersistWasCalled, 'the scenario ran: the claim moved during the re-drive')
  // `{ persisted: false, reason: 'pool-exhausted' }` rather than a bare `false`: the persist now
  // distinguishes "the pool refused me" from "the row already names a DIFFERENT document", because
  // the outbox runner has to bury the second and must NOT touch the database after the first.
  assert.deepEqual(recorded, { persisted: false, reason: 'pool-exhausted' },
    'the caller is told the row was not recorded normally — the pool never gave it a transaction')

  // THE VERDICT: the single-statement fallback is the only thing that can still save the id, and it is
  // claim-fenced. Built from a snapshot it matches nothing and the id is lost with an "already lost"
  // reason on a row this worker still owns.
  const fallback = state.syncLogWrites.find((w) => w.data.externalTransactionId === 'XERO-INV-1')
  assert.ok(fallback, 'the give-up path attempted its terminal write')
  assert.deepEqual(fallback!.where.processingStartedAt, held,
    'fenced on the claim as it stands NOW, not as it stood when the persist began')
  assert.equal(fallback!.count, 1, 'so it matched the row this worker still owns')
  assert.equal(state.row?.externalTransactionId, 'XERO-INV-1',
    'and the id of the document Xero already holds is recovered, which is the whole point of the give-up path')
  assert.equal(state.row?.status, 'PENDING',
    'handed back so the next run short-circuits on the external id instead of posting a second document')
})
