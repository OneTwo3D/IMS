import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  recordAndReleaseUnsentTransportRefusal,
  releaseUnsentTransportRefusal,
} from '@/lib/connectors/xero/sync-processor'
import {
  CREATE_DISPATCH_REPLAY_MARGIN_MS,
  decideCreateDispatch,
} from '@/lib/domain/accounting/create-dispatch-record'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'

/**
 * o3d-jit6 ROUND 4 (Codex HIGH) — "NO RETRY SPENT" HAD BECOME "NO RETRY POSSIBLE IN TIME".
 *
 * Round 3 classified a pre-egress transport refusal as `notPosted`: the row is not failed, spends no
 * retry, and a named WARNING activity row records that IMS refused to send. That was the right
 * instinct and it is kept whole.
 *
 * WHAT IT DID NOT DO WAS GIVE THE ROW BACK. The claim fence renews `processingStartedAt` on the very
 * statement that mints the dispatch marker, so at the moment of the refusal the row is PROCESSING at
 * a brand-new instant. Both runners then logged and moved on. Neither selector will look at a
 * PROCESSING row until it is older than CLAIM_STALE_MS — FIFTEEN MINUTES — and Xero forgets an
 * idempotency key after SIX. So the one window in which a replay is provably not a second create had
 * always closed before anything could re-take the row, and the next attempt met a permanent refusal
 * for a create that was never made.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. the claim is released, through the one fenced release, at an instant that leaves the row
 *      claimable INSIDE the replay window — measured against the window's own constants, not against
 *      a number retyped here;
 *   2. and that is a real change: the row r3 left behind could not be re-taken until long after the
 *      window had closed;
 *   3. the standing dispatch marker is untouched and still refuses a late attempt, so making the
 *      retry possible did not license a second post;
 *   4. the release is fenced — a displaced owner, or an attempt an operator has moved, releases
 *      nothing — and spends no retry;
 *   5. both runners do it, the outbox one atomically with the job requeue, and both write the
 *      evidence row FIRST.
 */

/* ------------------------------------------------------------------------------------------------
 * A ONE-ROW STORE THAT HONOURS ITS WHERE CLAUSE.
 *
 * The property under test is WHICH writes match, so a double that ignored `where` would report the
 * fence as working and its absence as working equally well.
 * ---------------------------------------------------------------------------------------------- */

type Row = {
  id: string
  status: string
  processingStartedAt: Date | null
  attemptStampingCustodyAt: Date | null
  attemptRevision: number
  retryCount: number
  errorMessage: string | null
  /** The marker. Write-once by database trigger in production; nothing here may move it. */
  createDispatchedAt: Date | null
  createDispatchIdempotencyKey: string | null
}

function makeRowStore(row: Partial<Row> & { id: string }) {
  const state: Row = {
    status: 'PROCESSING',
    processingStartedAt: null,
    attemptStampingCustodyAt: null,
    attemptRevision: 0,
    retryCount: 3,
    errorMessage: null,
    createDispatchedAt: null,
    createDispatchIdempotencyKey: null,
    ...row,
  }
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []

  const matches = (where: Record<string, unknown>): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      const actual = (state as unknown as Record<string, unknown>)[key]
      if (expected instanceof Date) {
        if ((actual as Date | null)?.valueOf() !== expected.valueOf()) return false
      } else if (actual !== expected) return false
    }
    return true
  }

  const client = {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data })
        if (!matches(where)) return { count: 0 }
        Object.assign(state, data)
        return { count: 1 }
      },
    },
  }
  return { client: client as never, state, writes }
}

/** The dispatch marker is minted by the fence, so it is stamped at the claim renewal. */
const T_DISPATCH = new Date('2026-08-22T09:00:00.000Z')
/** The transport refuses moments later — no socket was ever opened. */
const T_REFUSAL = new Date(T_DISPATCH.getTime() + 1_500)
const KEY = 'ims-manual-journal-log-1'
const ATTEMPT = { id: 'log-1', attemptRevision: 4 }
const MESSAGE = 'NOTHING WAS SENT for COGS_JOURNAL for PurchaseOrder po-1: ...'

/** The part of Xero's window a replay decided at the fence can still be inside. */
const USABLE_WINDOW_MS = XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS
const CLAIM_STALE_MS = 15 * 60 * 1000
/** The last instant at which a sweep could take this row and still replay it safely. */
const LAST_REPLAYABLE = new Date(T_DISPATCH.getTime() + USABLE_WINDOW_MS - 1)

/** The direct runner's own selector, modelled from the predicate in `processPendingXeroSyncDirect`. */
function claimableAt(row: Pick<Row, 'status' | 'processingStartedAt'>, now: Date): boolean {
  if (row.status === 'PENDING') {
    return row.processingStartedAt === null || row.processingStartedAt.valueOf() <= now.valueOf()
  }
  if (row.status === 'PROCESSING') {
    return row.processingStartedAt !== null
      && row.processingStartedAt.valueOf() < now.valueOf() - CLAIM_STALE_MS
  }
  return false
}

function markerVerdict(now: Date) {
  return decideCreateDispatch({
    type: 'COGS_JOURNAL',
    idempotencyKey: KEY,
    recorded: { dispatchedAt: T_DISPATCH, idempotencyKey: KEY },
    now,
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
  })
}

/* ------------------------------------------------------------------------------------------------
 * THE HIGH.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r4: an unsent create is handed back, and the row is RECLAIMABLE INSIDE the replay window', async () => {
  const store = makeRowStore({
    id: 'log-1',
    processingStartedAt: T_DISPATCH,
    attemptRevision: 4,
    createDispatchedAt: T_DISPATCH,
    createDispatchIdempotencyKey: KEY,
  })

  const released = await releaseUnsentTransportRefusal(
    store.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
  )

  assert.equal(released, true, 'the holder of the claim gives it back')
  assert.equal(store.state.status, 'PENDING', 'the row is no longer PROCESSING — it is claimable again')
  assert.equal(store.state.errorMessage, MESSAGE, 'and it carries the not-sent wording')

  // THE POINT OF THE WHOLE FIX. `processingStartedAt` on a PENDING row is the earliest-next-claim
  // gate, and it must not be a backoff — the usable window is FIVE minutes from the dispatch and the
  // cron ticks every five, so any delay added here guarantees the miss.
  const gate = store.state.processingStartedAt
  assert.ok(gate !== null, 'the gate is written')
  assert.equal(gate.valueOf(), T_REFUSAL.valueOf(), 'the gate is NOW, not now-plus-a-backoff')

  // THE PROPERTY, STATED OVER THE WHOLE WINDOW RATHER THAN OVER ONE ASSUMED TICK. This layer does
  // not choose when the next sweep runs — the `accounting-sync` cron ticks every five minutes and its
  // phase is not ours — so "the retry lands inside the window" is not something the release can
  // assert on its own. What it CAN make true, and what the r3 row could not, is that the row is
  // claimable at EVERY instant of the window that is left: from the refusal to the last replayable
  // moment there is no instant at which a sweep would pass it over. Any backoff written here would
  // carve ticks off the front of that interval, and a five-minute one would leave none at all.
  for (const [name, at] of [
    ['immediately', new Date(T_REFUSAL.getTime() + 1)],
    ['a minute in', new Date(T_DISPATCH.getTime() + 60_000)],
    ['at the last replayable instant', LAST_REPLAYABLE],
  ] as const) {
    assert.ok(claimableAt(store.state, at), `a sweep running ${name} takes the row`)
    // Which the marker itself confirms, rather than being taken on trust from the arithmetic.
    const verdict = markerVerdict(at)
    assert.equal(verdict.dispatch, true, `and the marker permits the replay ${name}`)
    assert.equal(
      verdict.dispatch === true ? verdict.basis : null,
      'replay-within-idempotency-window',
      'Xero answers a repeat of a key it still holds with the ORIGINAL document, so this is provably '
        + 'not a second create — and on this path there is no original, because nothing was sent',
    )
  }
})

test('o3d-jit6 r4: the row round 3 left behind could not be re-taken until long after the window closed', async () => {
  // THE DEFECT, stated as a fact about the row rather than as a story about the code. This is the
  // state the branch was in before the release: PROCESSING at the instant the fence renewed.
  const abandoned = { status: 'PROCESSING', processingStartedAt: T_DISPATCH }

  for (const minutes of [1, 5, 10, 14]) {
    const at = new Date(T_DISPATCH.getTime() + minutes * 60_000)
    assert.equal(claimableAt(abandoned, at), false, `${minutes} min after the refusal: still nobody's`)
  }
  assert.equal(
    claimableAt(abandoned, LAST_REPLAYABLE),
    false,
    'NOT ONE INSTANT of the replay window was claimable — the interval the release opens was empty',
  )
  const firstPossible = new Date(T_DISPATCH.getTime() + CLAIM_STALE_MS + 1)
  assert.equal(claimableAt(abandoned, firstPossible), true, 'only the stale-claim cutoff frees it')

  // And by then the marker refuses, which is the whole cost: a create that was never sent becomes a
  // row only a human can resolve.
  assert.ok(firstPossible.valueOf() - T_DISPATCH.valueOf() > USABLE_WINDOW_MS)
  assert.equal(markerVerdict(firstPossible).dispatch, false)
})

test('o3d-jit6 r4: releasing the claim does NOT license a post outside the window', async () => {
  // The marker is the gate, and the release does not move it. Past the window the answer is exactly
  // what it was before this change — refused, naming both producers of the state and pointing at the
  // activity row an operator should check BEFORE the ledger.
  const late = markerVerdict(new Date(T_DISPATCH.getTime() + XERO_IDEMPOTENCY_KEY_RETENTION_MS + 1_000))

  assert.equal(late.dispatch, false, 'a late replay is refused however the row got back here')
  const error = late.dispatch === false ? late.error : ''
  assert.match(error, /TWO THINGS PRODUCE THAT STATE/)
  assert.match(error, /xero_sync_transport_refused_before_post/)

  // And the release writes neither half of the marker, so nothing it does can talk the gate above
  // into a different answer. (In production the pair is write-once by database trigger as well; this
  // asserts the statement does not even try.)
  const store = makeRowStore({
    id: 'log-1',
    processingStartedAt: T_DISPATCH,
    attemptRevision: 4,
    createDispatchedAt: T_DISPATCH,
    createDispatchIdempotencyKey: KEY,
  })
  await releaseUnsentTransportRefusal(
    store.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
  )
  const written = store.writes.at(-1)?.data ?? {}
  assert.ok(!('createDispatchedAt' in written), 'the release must not touch the dispatch instant')
  assert.ok(!('createDispatchIdempotencyKey' in written), 'nor the key it was dispatched under')
  assert.equal(store.state.createDispatchedAt?.valueOf(), T_DISPATCH.valueOf())
  assert.equal(store.state.createDispatchIdempotencyKey, KEY)

  // NO RETRY SPENT — that half of round 3 is what makes this safe to do on every tick. A refusal
  // about the connection, the posting intent, an egress authorisation or the rate budget is not a
  // fact about this row, so it must never drive it to FAILED.
  assert.ok(!('retryCount' in written), 'the release must not spend a retry')
  assert.equal(store.state.retryCount, 3)
  assert.ok(!('status' in written) || written.status === 'PENDING')
})

test('o3d-jit6 r4: the release is fenced — a displaced owner, or a moved attempt, releases nothing', async () => {
  // A worker whose claim went stale and was replaced must not drop the replacement's live claim back
  // to PENDING while the replacement's request is on the wire.
  const displaced = makeRowStore({
    id: 'log-1',
    processingStartedAt: new Date(T_DISPATCH.getTime() + 60_000),
    attemptRevision: 4,
  })
  assert.equal(
    await releaseUnsentTransportRefusal(
      displaced.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
    ),
    false,
  )
  assert.equal(displaced.state.status, 'PROCESSING', "the replacement's claim is untouched")

  // And a decision an operator took while this claim was held bumps the attempt revision, which this
  // release must not reopen.
  const decided = makeRowStore({ id: 'log-1', processingStartedAt: T_DISPATCH, attemptRevision: 5 })
  assert.equal(
    await releaseUnsentTransportRefusal(
      decided.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
    ),
    false,
  )
  assert.equal(decided.state.status, 'PROCESSING')
})

test('o3d-jit6 r4: the release keeps attempt-stamping custody, like every other non-terminal release', async () => {
  const store = makeRowStore({ id: 'log-1', processingStartedAt: T_DISPATCH, attemptRevision: 4 })
  await releaseUnsentTransportRefusal(
    store.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
  )
  // Re-gating a row is the same write as claiming it with a future instant, and the database's
  // forfeit trigger nulls custody on any claim-shaped UPDATE that does not re-assert it in the SAME
  // statement. Going through `releaseClaimForRetry` is what gets this for free; a hand-spelt release
  // here would have silently forfeited it.
  assert.equal(store.state.attemptStampingCustodyAt?.valueOf(), T_REFUSAL.valueOf())
})

/* ------------------------------------------------------------------------------------------------
 * THE WIRING, WHICH NO UNIT ABOVE CAN SEE.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r5: BOTH runners hand back through the ONE transaction body, evidence included', () => {
  const source = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const direct = source.slice(
    source.indexOf('async function processPendingXeroSyncDirect('),
    source.indexOf('async function processPendingXeroSyncViaOutbox('),
  )
  const outbox = source.slice(
    source.indexOf('async function processPendingXeroSyncViaOutbox('),
    source.indexOf('async function guardCancelledSalesOrderInvoice('),
  )
  assert.ok(direct.length > 0 && outbox.length > 0, 'both runner blocks must be found')

  for (const [name, block] of [['direct', direct], ['outbox', outbox]] as const) {
    const branch = block.slice(block.indexOf('if (syncResult.notPosted) {'))
    assert.ok(branch.length > 0, `${name}: the notPosted branch must be found`)

    // Only on the reason that has a replay window running against it.
    const guardAt = branch.indexOf("if (notPosted.reason === 'transport-refused') {")
    assert.ok(guardAt > -1, `${name}: the hand-back is guarded on the transport refusal`)

    // ONE TRANSACTION, AND THE EVIDENCE IS INSIDE IT (r5). r4 wrote the evidence with the
    // best-effort `logActivity` from outside the release, so the release could commit while the
    // only durable trace of the refusal was silently lost. The transaction body is now shared, so
    // there is no call site at which that separation can be reintroduced by one runner alone.
    const txAt = branch.indexOf('await db.$transaction(async (tx) => {', guardAt)
    assert.ok(txAt > -1, `${name}: the hand-back must be one transaction`)
    const txBody = branch.slice(txAt, branch.indexOf('})', txAt))
    assert.match(
      txBody,
      /await recordAndReleaseUnsentTransportRefusal\(tx, \{ entry, notPosted, lease, attempt/,
      `${name}: the hand-back goes through the shared body, fenced on the LEASE`,
    )
    // FENCED ON THE LEASE, NOT ON THE SWEEP'S CAPTURED INSTANT, and this is the difference between
    // the fix working and the fix being invisible. `openRemoteWriteLease` renews
    // `processingStartedAt` when it opens and again in the fence that mints the dispatch marker, so
    // `held` — `claimHeldFrom(claimedAt)` from the top of the loop — names an instant the row no
    // longer carries. The fence fails CLOSED, so a release fenced on the stale one matches no row,
    // reports nothing, and leaves the row in PROCESSING exactly as round 3 did.
    assert.ok(
      !/recordAndReleaseUnsentTransportRefusal\(tx, \{ entry, notPosted, held,/.test(branch),
      `${name}: fencing on the sweep's captured instant would match nothing and fail silently`,
    )

    // AND NO BEST-EFFORT EVIDENCE WRITE ON THIS PATH. `logActivity` swallows its own failures; using
    // it for the row the marker's refusal points at is exactly the defect r5 closes.
    const refusalArm = branch.slice(guardAt, branch.indexOf('} else {', guardAt))
    assert.ok(
      !/await logActivity\(\{/.test(refusalArm),
      `${name}: the refusal evidence must not be written best-effort alongside the release`,
    )
  }

  // The direct runner owns no outbox job and passes none; the queued runner passes its job, so the
  // requeue joins the same commit. Either half alone re-creates r4's defect: a released row whose
  // job stayed PROCESSING waits for the queue's own fifteen-minute stale-lock sweep, and a requeued
  // job whose row stayed PROCESSING is claimed only to find the row unclaimable.
  const directTx = direct.slice(direct.indexOf('recordAndReleaseUnsentTransportRefusal(tx, {'))
  assert.match(directTx.slice(0, directTx.indexOf('\n')), /\{ entry, notPosted, lease, attempt \}\)/)
  const outboxTx = outbox.slice(outbox.indexOf('recordAndReleaseUnsentTransportRefusal(tx, {'))
  assert.match(outboxTx.slice(0, outboxTx.indexOf('\n')), /\{ entry, notPosted, lease, attempt, job \}\)/)
})

test('o3d-jit6 r5: the shared body writes the evidence transactionally, and never best-effort', () => {
  const source = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const body = source.slice(
    source.indexOf('export async function recordAndReleaseUnsentTransportRefusal('),
    source.indexOf('/**\n * SAY THAT THE HAND-BACK ABORTED'),
  )
  assert.ok(body.length > 0, 'the shared hand-back body must be found')

  const logAt = body.indexOf('await logActivityInTransaction(tx, {')
  const releaseAt = body.indexOf('await releaseUnsentTransportRefusal(')
  const deferAt = body.indexOf('deferOutboxWithoutSpendingAnAttempt(tx, args.job,')
  assert.ok(logAt > -1, 'the evidence must be written through the transaction')
  assert.ok(releaseAt > logAt, 'the evidence row is written BEFORE the row becomes claimable')
  assert.ok(deferAt > releaseAt, 'and the job requeue is the third write of the same commit')

  // `logActivity` and `logActivityPersisted` both swallow; neither may appear here.
  assert.ok(!/await logActivity\(/.test(body), 'no best-effort activity write inside the hand-back')
  assert.ok(!/logActivityPersisted\(/.test(body), 'nor the reporting-but-still-committing variant')
  // AND NOT `markXeroOutboxRetry`, whose first backoff floor is five minutes and which counts the
  // attempt against MAX_RETRIES — it would burn the window it is supposed to be racing.
  assert.ok(
    !body.includes('markXeroOutboxRetry('),
    'the unsent hand-back must not spend an outbox attempt or take the five-minute backoff floor',
  )
  assert.match(body, /deferOutboxWithoutSpendingAnAttempt\(tx, args\.job, args\.notPosted\.message, 0\)/)
})

test('o3d-jit6 r4: the release goes through the ONE fenced release, not a hand-spelt statement', () => {
  const source = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const helper = source.slice(
    source.indexOf('export async function releaseUnsentTransportRefusal('),
    source.indexOf('async function markXeroOutboxRetry('),
  )
  assert.ok(helper.length > 0, 'the helper must be found')
  assert.match(helper, /return releaseClaimForRetry\(client, entryId, held, \{/)
  // The fence and the custody re-assertion are part of that statement, not of this call site — see
  // sync-claim-fence.ts. A direct write here would be a second definition of ownership.
  assert.ok(
    !/accountingSyncLog\.(update|updateMany|upsert)\(/.test(helper),
    'the helper must not write the row itself',
  )
  assert.match(helper, /nextAttemptAt: now,/, 'and it must not introduce a backoff')
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 5 — THE EVIDENCE IS NOT BEST-EFFORT ANY MORE, AND THESE PROVE IT BEHAVIOURALLY.
 *
 * The structural tests above pin the shape. What they cannot see is what happens when the activity
 * write FAILS, which is the entire defect: `logActivity` swallows its own errors, so round 4's
 * evidence write could fail silently while the release and the requeue committed anyway — leaving a
 * standing dispatch marker, a claimable row, and no trace at all of why the marker stands.
 *
 * So the fake below is a TRANSACTION, not a client. It stages every write against a copy and commits
 * that copy only if the body returns; a throw discards it. Without that, "one transaction" is a claim
 * no unit test can distinguish from three statements in a row.
 * ---------------------------------------------------------------------------------------------- */

const WORKER = 'xero-accounting-sync'
const T_LOCK = new Date('2026-08-22T08:59:00.000Z')
const NOT_POSTED = {
  reason: 'transport-refused' as const,
  operation: 'manual-journal',
  message: MESSAGE,
}

type JobRow = {
  id: string
  status: string
  lockedAt: Date | null
  lockedBy: string | null
  nextAttemptAt: Date | null
  lastError: string | null
  attempts: number
}
type World = { sync: Row; job: JobRow; activity: Array<Record<string, unknown>> }

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key]
    if (expected instanceof Date) {
      if ((actual as Date | null)?.valueOf() !== expected.valueOf()) return false
    } else if (actual !== expected) return false
  }
  return true
}

function updateManyOn(get: () => Record<string, unknown>) {
  return async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const row = get()
    if (!whereMatches(row, where)) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  }
}

/** A transaction that actually rolls back: writes land on a staged copy, promoted only on return. */
function makeWorld(options: { sync?: Partial<Row>; activityLogFails?: boolean } = {}) {
  let committed: World = {
    sync: {
      id: 'log-1',
      status: 'PROCESSING',
      processingStartedAt: T_DISPATCH,
      attemptStampingCustodyAt: null,
      attemptRevision: 4,
      retryCount: 3,
      errorMessage: null,
      createDispatchedAt: T_DISPATCH,
      createDispatchIdempotencyKey: KEY,
      ...options.sync,
    },
    job: {
      id: 'job-1',
      status: 'PROCESSING',
      lockedAt: T_LOCK,
      lockedBy: WORKER,
      nextAttemptAt: null,
      lastError: null,
      attempts: 2,
    },
    activity: [],
  }

  async function transaction<T>(body: (tx: never) => Promise<T>): Promise<T> {
    const staged: World = structuredClone(committed)
    const tx = {
      activityLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          // The failure `logActivity` would have swallowed. Here it must propagate.
          if (options.activityLogFails) throw new Error('activity_log is not writable')
          staged.activity.push(data)
          return data
        },
      },
      accountingSyncLog: { updateMany: updateManyOn(() => staged.sync as unknown as Record<string, unknown>) },
      integrationOutbox: { updateMany: updateManyOn(() => staged.job as unknown as Record<string, unknown>) },
    }
    const out = await body(tx as never)
    committed = staged
    return out
  }

  return { transaction, world: () => committed }
}

const JOB = {
  id: 'job-1',
  connector: 'xero',
  operation: 'sync',
  idempotencyKey: 'k',
  payloadJson: {},
  status: 'PROCESSING',
  attempts: 2,
  nextAttemptAt: null,
  lastError: null,
  lockedAt: T_LOCK,
  lockedBy: WORKER,
  createdAt: T_LOCK,
  updatedAt: T_LOCK,
}

test('o3d-jit6 r5: the queued hand-back commits evidence, release and requeue as ONE fact', async () => {
  const w = makeWorld()
  const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
    job: JOB as never,
  }))

  assert.equal(out.released, true)
  const after = w.world()
  assert.equal(after.activity.length, 1, 'the evidence row is written')
  assert.equal(after.activity[0].action, 'xero_sync_transport_refused_before_post',
    'and it is the action the marker refusal tells an operator to look for')
  assert.equal(after.activity[0].level, 'WARNING')
  assert.equal(after.sync.status, 'PENDING', 'the row is claimable again')
  assert.equal(after.job.status, 'RETRYABLE_FAILED', 'and its job is back in the queue')
  assert.equal(after.job.attempts, 2, 'without spending an attempt')
  // The marker is untouched, so the retry meets the same deterministic key and the same verdict.
  assert.equal(after.sync.createDispatchedAt?.valueOf(), T_DISPATCH.valueOf())
  assert.equal(after.sync.createDispatchIdempotencyKey, KEY)
})

test('o3d-jit6 r5: an unwritable activity row ABORTS the hand-back — nothing released, nothing requeued', async () => {
  // THE DEFECT, AS A FACT ABOUT THE DATABASE. Under round 4 this is exactly the run that broke the
  // invariant: `logActivity` swallowed the failure, the release and the requeue committed, and the
  // row went back to PENDING with the dispatch marker standing and no trace of why.
  const w = makeWorld({ activityLogFails: true })

  await assert.rejects(
    () => w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
      entry: { id: 'log-1', type: 'COGS_JOURNAL' },
      notPosted: NOT_POSTED,
      lease: claimHeldFrom(T_DISPATCH),
      attempt: ATTEMPT,
      job: JOB as never,
    })),
    /activity_log is not writable/,
    'an unwritable record must abort, not be swallowed',
  )

  const after = w.world()
  assert.equal(after.activity.length, 0, 'nothing was recorded')
  assert.equal(after.sync.status, 'PROCESSING',
    'AND THEREFORE NOTHING WAS RELEASED — no worker can meet the marker with the trace missing')
  assert.equal(after.sync.processingStartedAt?.valueOf(), T_DISPATCH.valueOf(), 'the claim is exactly as it was')
  assert.equal(after.job.status, 'PROCESSING', 'and the job was not requeued either')
  assert.equal(after.job.lockedBy, WORKER)
})

test('o3d-jit6 r5: the DIRECT hand-back rolls back as one too — it is the same body, with no job', async () => {
  const w = makeWorld({ activityLogFails: true })

  await assert.rejects(
    () => w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
      entry: { id: 'log-1', type: 'COGS_JOURNAL' },
      notPosted: NOT_POSTED,
      lease: claimHeldFrom(T_DISPATCH),
      attempt: ATTEMPT,
    })),
    /activity_log is not writable/,
  )
  assert.equal(w.world().sync.status, 'PROCESSING', 'the direct runner releases nothing either')
  assert.equal(w.world().activity.length, 0)

  // And with a writable log the direct body releases the row and touches no job — the runner holds
  // none, so there is nothing on that side to keep atomic with.
  const ok = makeWorld()
  const out = await ok.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
  }))
  assert.equal(out.released, true)
  assert.equal(ok.world().sync.status, 'PENDING')
  assert.equal(ok.world().activity.length, 1)
  assert.equal(ok.world().job.status, 'PROCESSING', 'the direct path must not touch an outbox job')
})

test('o3d-jit6 r5: a ZERO-ROW fenced release does NOT abort — the evidence and the requeue still commit', async () => {
  // The asymmetry with the log failure is deliberate. `false` here means a displaced owner, or an
  // attempt an operator has since moved: the fence doing its job. The refusal it records STILL
  // HAPPENED and is still the row the marker's refusal points at, so rolling the evidence back would
  // delete the record of a real refusal on the grounds that somebody else now owns the row. And the
  // outbox job is this worker's regardless of what happened to the sync row, so it is handed back.
  const displaced = makeWorld({ sync: { processingStartedAt: new Date(T_DISPATCH.getTime() + 60_000) } })
  const out = await displaced.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
    job: JOB as never,
  }))

  assert.equal(out.released, false, 'the caller is told the release matched nothing')
  const after = displaced.world()
  assert.equal(after.sync.status, 'PROCESSING', "the replacement's claim is untouched")
  assert.equal(after.activity.length, 1, 'but the refusal that really happened is still recorded')
  assert.equal(after.job.status, 'RETRYABLE_FAILED', 'and this worker still hands back its own job')

  // Same when an operator moved the attempt while this claim was held.
  const decided = makeWorld({ sync: { attemptRevision: 5 } })
  const outDecided = await decided.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
    job: JOB as never,
  }))
  assert.equal(outDecided.released, false)
  assert.equal(decided.world().sync.status, 'PROCESSING', "an operator's decision is not reopened")
  assert.equal(decided.world().activity.length, 1)
})

test('o3d-jit6 r5: a job this worker no longer holds aborts the whole hand-back, evidence included', async () => {
  // `deferOutboxWithoutSpendingAnAttempt` throws when its fence matches nothing. Under round 4 the
  // evidence had already been committed by then; now it rolls back with the rest, which is the
  // correct reading of "abort": the row was not released, so nothing will meet the marker.
  const w = makeWorld()
  await assert.rejects(
    () => w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
      entry: { id: 'log-1', type: 'COGS_JOURNAL' },
      notPosted: NOT_POSTED,
      lease: claimHeldFrom(T_DISPATCH),
      attempt: ATTEMPT,
      job: { ...JOB, lockedAt: new Date(T_LOCK.getTime() + 1_000) } as never,
    })),
    /is not claimed by xero-accounting-sync/,
  )
  const after = w.world()
  assert.equal(after.sync.status, 'PROCESSING', 'the row stays claimed by this worker')
  assert.equal(after.activity.length, 0, 'and the evidence rolled back with it')
})
