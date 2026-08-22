import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { releaseUnsentTransportRefusal } from '@/lib/connectors/xero/sync-processor'
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

test('o3d-jit6 r4: BOTH runners hand the row back, and the outbox one does it atomically with the job', () => {
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

    // THE EVIDENCE FIRST. This activity row is what the later refusal tells an operator to look for,
    // and the release below makes the row claimable — so writing it afterwards opens a gap in which
    // another worker meets the marker with no trace of why it stands.
    const logAt = branch.indexOf('await logActivity({')
    const releaseAt = branch.indexOf('releaseUnsentTransportRefusal(')
    assert.ok(logAt > -1, `${name}: the refusal must still be logged`)
    assert.ok(releaseAt > -1, `${name}: the claim must be handed back`)
    assert.ok(releaseAt > logAt, `${name}: the evidence row is written BEFORE the row becomes claimable`)

    // Only on the reason that has a replay window running against it.
    assert.ok(
      branch.slice(0, releaseAt).includes("if (notPosted.reason === 'transport-refused') {"),
      `${name}: the release is guarded on the transport refusal`,
    )

    // FENCED ON THE LEASE, NOT ON THE SWEEP'S CAPTURED INSTANT, and this is the difference between
    // the fix working and the fix being invisible. `openRemoteWriteLease` renews
    // `processingStartedAt` when it opens and again in the fence that mints the dispatch marker, so
    // `held` — `claimHeldFrom(claimedAt)` from the top of the loop — names an instant the row no
    // longer carries. `releaseClaimForRetry` fences on the instant, and it fails CLOSED: a release
    // fenced on the stale one matches no row, reports nothing, and leaves the row in PROCESSING
    // exactly as round 3 did.
    assert.match(
      branch,
      /releaseUnsentTransportRefusal\((db|tx), entry\.id, lease, attempt, notPosted\.message\)/,
      `${name}: the release must fence on the LEASE — the claim this worker holds at that moment`,
    )
    assert.ok(
      !/releaseUnsentTransportRefusal\((db|tx), entry\.id, held,/.test(branch),
      `${name}: fencing on the sweep's captured instant would match nothing and fail silently`,
    )
  }

  // ONE TRANSACTION on the outbox path: a released row whose job stayed PROCESSING waits for the
  // queue's own fifteen-minute stale-lock sweep, and a requeued job whose row stayed PROCESSING is
  // claimed only to find the row unclaimable. Either half alone re-creates the defect.
  const tx = outbox.slice(outbox.indexOf('if (syncResult.notPosted) {'))
  const txAt = tx.indexOf('await db.$transaction(async (tx) => {')
  assert.ok(txAt > -1, 'the outbox hand-back must be one transaction')
  const body = tx.slice(txAt, tx.indexOf('})', tx.indexOf('deferOutboxWithoutSpendingAnAttempt(')))
  assert.match(body, /releaseUnsentTransportRefusal\(tx, entry\.id, lease, attempt, notPosted\.message\)/)
  // AND NOT `markXeroOutboxRetry`, whose first backoff floor is five minutes and which counts the
  // attempt against MAX_RETRIES — it would burn the window it is supposed to be racing.
  assert.match(body, /deferOutboxWithoutSpendingAnAttempt\(tx, job, notPosted\.message, 0\)/)
  assert.ok(
    !body.includes('markXeroOutboxRetry('),
    'the unsent hand-back must not spend an outbox attempt or take the five-minute backoff floor',
  )
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
