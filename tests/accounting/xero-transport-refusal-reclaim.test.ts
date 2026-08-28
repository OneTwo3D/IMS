import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  recordAndReleaseUnsentTransportRefusal,
  releaseUnsentTransportRefusal,
  retryUnsentHandBack,
  UNSENT_HANDBACK_MAX_ATTEMPTS,
  UNSENT_HANDBACK_MIN_ACQUISITION_MS,
  UNSENT_HANDBACK_MIN_ATTEMPT_MS,
  UNSENT_HANDBACK_MIN_EXECUTION_MS,
  UNSENT_HANDBACK_RETRY_BASE_DELAY_MS,
  UNSENT_HANDBACK_COMMIT_ACTION,
  UNSENT_HANDBACK_MAX_WAIT_MS,
  UNSENT_HANDBACK_RETRY_BUDGET_MS,
  unsentHandBackAttemptBounds,
  unsentHandBackAttemptBudgetMs,
  unsentHandBackCommitProvesRelease,
  unsentHandBackDeadline,
  unsentHandBackOperationId,
} from '@/lib/connectors/xero/sync-processor'
import {
  CREATE_DISPATCH_REPLAY_MARGIN_MS,
  decideCreateDispatch,
  readCreateDispatchAge,
  type CreateDispatchClient,
} from '@/lib/domain/accounting/create-dispatch-record'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'
import { STAMPED_MONEY_TYPES } from '@/lib/domain/accounting/money-attempt-provenance'
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
  /**
   * o3d-gvzu: the release beside the marker. Modelled here because the hand-back now writes it under
   * a predicate over BOTH of the other two — a double that did not carry it would throw rather than
   * silently pass, which is the property `whereMatches` is built for, but it would also make the
   * release untestable at the only seam it has.
   */
  createDispatchReleasedAt: Date | null
  /** Named by the release's own fence, so it has to be on the row for the predicate to be evaluated. */
  connector: string
  /**
   * THE THREE COLUMNS THE WELDED REFUSAL READS (o3d-anu8 r3), modelled because the release now
   * carries a predicate over them. Leaving them off the row would not have made the refusal
   * harmless — it would have made it UNEVALUATED, which is the same shape of defect as ignoring
   * the `where` altogether: the test would report the refusal as absent and as satisfied alike.
   *
   * `type` is COGS_JOURNAL because that is the only producer of `reason: 'transport-refused'` —
   * the manual-journal path is the one create that mints a dispatch marker. `remoteAttemptedAt`
   * is null because "nothing was sent" is this file's whole premise, and custody is null because
   * the minting fence has just forfeited it (`renewClaimForRemoteWrite` moves
   * `processingStartedAt` without re-asserting custody, so the database trigger nulls it). That
   * is the exact row state a real hand-back releases, and it is one conjunct — the type — away
   * from being refused. See the pinning test at the end of the round-4 block.
   */
  type: string
  remoteAttemptedAt: Date | null
}

/**
 * A PRISMA `where` IS A TREE, AND SINCE o3d-anu8 THE ONE UNDER TEST IS ONE.
 *
 * `releaseClaimForRetry` no longer passes the caller's predicate through: it builds the whole
 * `updateMany` argument with `stampingCustodyOnClaim`, which AND-s `CUSTODY_MAY_BE_RESTORED` — a
 * `NOT` over a `type: { in: [...] }` — onto it. So the statement that reaches this double is
 * `{ AND: [ { id, status, processingStartedAt, attemptRevision }, { NOT: { ... } } ] }`.
 *
 * A matcher that walked only the top level reads `AND` as a COLUMN NAME, finds no such column on
 * the row, and answers "no match" for every write there has ever been. That is not a small
 * inaccuracy: it turns the eight behavioural tests here red AND turns the four fence tests green
 * for a reason that has nothing to do with the fence, because a double that never matches proves
 * a displaced owner releases nothing just as loudly as a correct fence does.
 *
 * So this understands exactly the operators the statement under test uses — `AND`, `OR`, `NOT`,
 * `in`, `not`, and scalar/Date/null equality — and THROWS on anything else. An unrecognised
 * operator, or a column the row does not model, means the double has stopped modelling the
 * statement; that has to be loud, because its silent form is a `false` that reads as a working
 * fence.
 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date) return (actual as Date | null)?.valueOf() === expected.valueOf()
  if (expected !== null && typeof expected === 'object') {
    const filter = expected as Record<string, unknown>
    const keys = Object.keys(filter)
    if (keys.length === 1 && keys[0] === 'in') {
      return (filter.in as unknown[]).includes(actual)
    }
    if (keys.length === 1 && keys[0] === 'not') return !valueMatches(actual, filter.not)
    throw new Error(`the double does not model the filter ${JSON.stringify(keys)} — it is not modelling the statement`)
  }
  return actual === expected
}

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(expected as Array<Record<string, unknown>>).every((clause) => whereMatches(row, clause))) return false
      continue
    }
    if (key === 'OR') {
      if (!(expected as Array<Record<string, unknown>>).some((clause) => whereMatches(row, clause))) return false
      continue
    }
    if (key === 'NOT') {
      // Prisma's `NOT` over several fields negates their CONJUNCTION, which is what the recursion
      // gives: the refusal excludes a row only when type AND custody AND stamp all say so.
      if (whereMatches(row, expected as Record<string, unknown>)) return false
      continue
    }
    if (!(key in row)) {
      throw new Error(`the double does not model column "${key}" — it cannot say whether this write matches`)
    }
    if (!valueMatches(row[key], expected)) return false
  }
  return true
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
    createDispatchReleasedAt: null,
    connector: 'xero',
    type: 'COGS_JOURNAL',
    remoteAttemptedAt: null,
    ...row,
  }
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []

  const client = {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data })
        if (!whereMatches(state as unknown as Record<string, unknown>, where)) return { count: 0 }
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
    recorded: { dispatchedAt: T_DISPATCH, idempotencyKey: KEY, releasedAt: null },
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

test('o3d-jit6 r4 x o3d-anu8 r3: the custody refusal is carried, evaluated, and does not bite a hand-back', async () => {
  // WHY THIS TEST EXISTS. `releaseClaimForRetry` no longer just writes custody, it AND-s a REFUSAL
  // into the predicate: a money row carrying neither custody nor an attempt stamp is not claimed at
  // all, because restoring custody to it would rewrite "undetermined" into `attemptProvenNeverMade`'s
  // positive proof. That refusal now sits in front of THIS release too, and the row a transport
  // refusal produces is two-thirds of the way to matching it:
  //
  //   custody NULL             — `renewClaimForRemoteWrite` moves `processingStartedAt` when it opens
  //                              the lease and again in the fence that mints the marker, and neither
  //                              re-asserts custody, so the forfeit trigger takes it. A releasing
  //                              worker holding its own claim is therefore NOT a worker holding
  //                              custody, whatever the claim fence's comment says.
  //   remoteAttemptedAt NULL   — the premise of the whole file. Nothing was sent.
  //
  // What keeps the release landing is the THIRD conjunct, the type. So it is pinned here, from both
  // sides, rather than left as an accident nobody would notice being lost.
  const refused = makeRowStore({
    id: 'log-1', processingStartedAt: T_DISPATCH, attemptRevision: 4,
    attemptStampingCustodyAt: null, remoteAttemptedAt: null, type: 'COGS_JOURNAL',
  })
  assert.equal(
    await releaseUnsentTransportRefusal(
      refused.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
    ),
    true,
    'the row that provably sent nothing IS handed back',
  )

  // AND THE REFUSAL REALLY IS IN THE PREDICATE — asserted on the statement, so "it landed" cannot be
  // "the double never looked". `reason: 'transport-refused'` is produced by the manual-journal path
  // alone, which is why COGS_JOURNAL is the type above.
  const where = refused.writes.at(-1)?.where as { AND?: Array<Record<string, unknown>> }
  const custody = where.AND?.find((clause) => 'NOT' in clause)?.NOT as Record<string, unknown> | undefined
  assert.ok(custody, 'the welded refusal must be AND-ed onto the fence, not merged into it')
  assert.deepEqual(custody.type, { in: [...STAMPED_MONEY_TYPES] })
  assert.equal(custody.attemptStampingCustodyAt, null)
  assert.equal(custody.remoteAttemptedAt, null)
  assert.ok(!STAMPED_MONEY_TYPES.includes(refused.state.type as never), 'and the released type is outside its scope')

  // THE OTHER SIDE, WHICH IS WHAT MAKES THE ABOVE MEAN SOMETHING. The identical row under a money
  // type IS refused. If a money type ever grows a create-dispatch marker and a transport refusal,
  // this is the row that could not be handed back — so the failure is written down here rather than
  // discovered as a payment stuck in PROCESSING for fifteen minutes past its replay window.
  for (const moneyType of STAMPED_MONEY_TYPES) {
    const money = makeRowStore({
      id: 'log-1', processingStartedAt: T_DISPATCH, attemptRevision: 4,
      attemptStampingCustodyAt: null, remoteAttemptedAt: null, type: moneyType,
    })
    assert.equal(
      await releaseUnsentTransportRefusal(
        money.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
      ),
      false,
      `${moneyType}: the refusal bites — this is the state a money hand-back must never be in`,
    )
    assert.equal(money.state.status, 'PROCESSING')

    // AND IT NEVER IS, for a reason that is a property of the money path rather than of this one:
    // `authoriseMoneyPost` stamps `remoteAttemptedAt` BEFORE it runs the callback that holds the
    // claim fence, so by the time any money entry can reach a refusal its stamp is already set and
    // the third conjunct is already false.
    const stamped = makeRowStore({
      id: 'log-1', processingStartedAt: T_DISPATCH, attemptRevision: 4,
      attemptStampingCustodyAt: null, remoteAttemptedAt: T_DISPATCH, type: moneyType,
    })
    assert.equal(
      await releaseUnsentTransportRefusal(
        stamped.client, 'log-1', claimHeldFrom(T_DISPATCH), ATTEMPT, MESSAGE, T_REFUSAL,
      ),
      true,
      `${moneyType}: a stamped money row releases normally, which is every money row that got this far`,
    )
  }
})

/* ------------------------------------------------------------------------------------------------
 * THE WIRING, WHICH NO UNIT ABOVE CAN SEE.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r5/r7: BOTH runners hand back through the ONE shared hand-back, evidence included', () => {
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

    // r7: NO RUNNER OWNS THE TRANSACTION ANY MORE. r5 shared the transaction BODY and left the
    // transaction, its catch and its report spelt out per runner — which is where r7's bounded
    // retry would have had to be written twice and could drift once. A runner that opened its own
    // transaction here would be doing exactly that, so the shape is forbidden rather than merely
    // unused.
    const refusalArm = branch.slice(guardAt, branch.indexOf('} else {', guardAt))
    assert.ok(
      !/db\.\$transaction\(/.test(refusalArm),
      `${name}: the transaction belongs to the shared hand-back, not to the runner`,
    )
    assert.match(
      refusalArm,
      /await handBackUnsentTransportRefusal\(\{ entry, notPosted, lease, attempt/,
      `${name}: the hand-back goes through the shared function, fenced on the LEASE`,
    )
    // FENCED ON THE LEASE, NOT ON THE SWEEP'S CAPTURED INSTANT, and this is the difference between
    // the fix working and the fix being invisible. `openRemoteWriteLease` renews
    // `processingStartedAt` when it opens and again in the fence that mints the dispatch marker, so
    // `held` — `claimHeldFrom(claimedAt)` from the top of the loop — names an instant the row no
    // longer carries. The fence fails CLOSED, so a release fenced on the stale one matches no row,
    // reports nothing, and leaves the row in PROCESSING exactly as round 3 did.
    assert.ok(
      !/handBackUnsentTransportRefusal\(\{ entry, notPosted, held,/.test(branch),
      `${name}: fencing on the sweep's captured instant would match nothing and fail silently`,
    )

    // AND NO BEST-EFFORT EVIDENCE WRITE ON THIS PATH. `logActivity` swallows its own failures; using
    // it for the row the marker's refusal points at is exactly the defect r5 closes.
    assert.ok(
      !/await logActivity\(\{/.test(refusalArm),
      `${name}: the refusal evidence must not be written best-effort alongside the release`,
    )
  }

  // The direct runner owns no outbox job and passes none; the queued runner passes its job, so the
  // requeue joins the same commit. Either half alone re-creates r4's defect: a released row whose
  // job stayed PROCESSING waits for the queue's own fifteen-minute stale-lock sweep, and a requeued
  // job whose row stayed PROCESSING is claimed only to find the row unclaimable.
  const directCall = direct.slice(direct.indexOf('handBackUnsentTransportRefusal({'))
  assert.match(directCall.slice(0, directCall.indexOf('\n')), /\{ entry, notPosted, lease, attempt \}\)/)
  const outboxCall = outbox.slice(outbox.indexOf('handBackUnsentTransportRefusal({'))
  assert.match(outboxCall.slice(0, outboxCall.indexOf('\n')), /\{ entry, notPosted, lease, attempt, job \}\)/)

  // AND THE SHARED HAND-BACK IS WHERE THE ONE TRANSACTION LIVES, INSIDE THE BOUNDED RETRY. r6 ran
  // the transaction once and conceded on abort; retrying anything SMALLER than the whole
  // transaction would reintroduce the separation r5 closed, so the retry must wrap the
  // `$transaction`, not a statement inside it.
  const handBack = source.slice(
    source.indexOf('async function handBackUnsentTransportRefusal(args: {'),
    source.indexOf('/**\n * HAND BACK A ROW THAT PROVABLY SENT NOTHING'),
  )
  assert.ok(handBack.length > 0, 'the shared hand-back must be found')
  assert.match(
    handBack,
    /retryUnsentHandBack\(\(attemptBudgetMs\) => db\.\$transaction\(async \(tx\) => \{\s*\n\s*return recordAndReleaseUnsentTransportRefusal\(tx, \{ entry, notPosted, lease, attempt, job \}\)/,
    'the COMPLETE atomic hand-back is what is retried',
  )
  assert.match(
    handBack,
    /await reportUnsentHandBackAborted\(entry, notPosted, outcome\.error, job\?\.id, \{/,
    'and an exhausted retry is reported, with how many attempts were made',
  )
  assert.ok(
    !/throw /.test(handBack),
    'it must not throw into the per-entry catch: that spends a retry and FAILS a row that sent nothing',
  )
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
      createDispatchReleasedAt: null,
      connector: 'xero',
      // See the note on `Row`: the state a real hand-back releases from, refusal columns included.
      type: 'COGS_JOURNAL',
      remoteAttemptedAt: null,
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
  assert.equal(after.activity.length, 2, 'the evidence row is written, and the r9 commit record after it')
  assert.equal(after.activity[0].action, 'xero_sync_transport_refused_before_post',
    'and it is the action the marker refusal tells an operator to look for')
  assert.equal(after.activity[0].level, 'WARNING')
  assert.equal(after.activity[1].action, UNSENT_HANDBACK_COMMIT_ACTION)
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
  assert.equal(ok.world().activity.length, 2, 'evidence row plus commit record')
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
  assert.equal(after.activity.length, 2, 'but the refusal that really happened is still recorded')
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
  assert.equal(decided.world().activity.length, 2)
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

/* ------------------------------------------------------------------------------------------------
 * ROUND 7 — A TRANSIENT ABORT MUST NOT STRAND THE ROW.
 *
 * r6 made the evidence, the release and the requeue one transaction and — correctly — chose not to
 * throw the abort into the per-entry catch, because that would spend a retry and mark FAILED a row
 * that provably sent nothing. But it then skipped and continued unconditionally, so a serialisation
 * failure, a deadlock or a dropped connection left the row PROCESSING at a freshly renewed claim,
 * unclaimable for FIFTEEN minutes — past the window in which a replay is provably not a second
 * create. That is the r5 defect, reached through the abort path.
 *
 * These pin the bounded retry: the whole transaction is re-run, transient aborts end with the row
 * released, and the bounds are real — attempts AND wall time, the latter checked before the pause is
 * taken so the sequence cannot consume the window it is racing.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r7: a transient abort is retried and the row IS handed back', async () => {
  const w = makeWorld()
  let calls = 0
  const slept: number[] = []

  const outcome = await retryUnsentHandBack(
    () => {
      calls++
      // The first attempt aborts the way a serialisation failure does: the transaction rolls back
      // whole, so nothing of it survives into the retry.
      if (calls === 1) return Promise.reject(new Error('could not serialize access due to concurrent update'))
      return w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
        entry: { id: 'log-1', type: 'COGS_JOURNAL' },
        notPosted: NOT_POSTED,
        lease: claimHeldFrom(T_DISPATCH),
        attempt: ATTEMPT,
        job: JOB as never,
      }))
    },
    { sleep: async (ms) => { slept.push(ms) }, monotonicMs: () => 0 },
  )

  assert.equal(outcome.handedBack, true, 'the second attempt succeeded, so the row was handed back')
  assert.equal(outcome.attempts, 2)
  assert.deepEqual(slept, [UNSENT_HANDBACK_RETRY_BASE_DELAY_MS], 'one pause, and it is the base delay')

  const after = w.world()
  assert.equal(after.sync.status, 'PENDING', 'THE ROW IS CLAIMABLE AGAIN — this is the whole finding')
  assert.equal(after.activity.length, 2, 'with exactly ONE hand-back\'s rows, from the attempt that committed')
  assert.equal(after.activity[0].action, 'xero_sync_transport_refused_before_post')
  assert.equal(after.job.status, 'RETRYABLE_FAILED', 'and the job went back with it, in the same commit')
  assert.equal(after.job.attempts, 2, 'still without spending an attempt')
  // The marker is untouched by the retry, so a replay is still decided by the window, not by us.
  assert.equal(after.sync.createDispatchedAt?.valueOf(), T_DISPATCH.valueOf())
})

test('o3d-jit6 r7: the retry is bounded by attempts, and the row is left exactly as the abort left it', async () => {
  const w = makeWorld({ activityLogFails: true })
  let calls = 0
  const slept: number[] = []

  const outcome = await retryUnsentHandBack(
    () => {
      calls++
      return w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
        entry: { id: 'log-1', type: 'COGS_JOURNAL' },
        notPosted: NOT_POSTED,
        lease: claimHeldFrom(T_DISPATCH),
        attempt: ATTEMPT,
        job: JOB as never,
      }))
    },
    { sleep: async (ms) => { slept.push(ms) }, monotonicMs: () => 0 },
  )

  assert.equal(outcome.handedBack, false)
  assert.equal(calls, UNSENT_HANDBACK_MAX_ATTEMPTS, 'it stops at the cap rather than retrying forever')
  assert.equal(outcome.handedBack === false && outcome.attempts, UNSENT_HANDBACK_MAX_ATTEMPTS)
  assert.equal(outcome.handedBack === false && outcome.abandoned, 'attempts-exhausted')
  assert.equal(slept.length, UNSENT_HANDBACK_MAX_ATTEMPTS - 1, 'one pause between attempts, none after the last')
  assert.deepEqual(slept, [UNSENT_HANDBACK_RETRY_BASE_DELAY_MS, UNSENT_HANDBACK_RETRY_BASE_DELAY_MS * 2])

  const after = w.world()
  assert.equal(after.activity.length, 0, 'nothing was recorded')
  assert.equal(after.sync.status, 'PROCESSING', 'and therefore nothing was released')
  assert.equal(after.job.status, 'PROCESSING', 'nor requeued — the halves stay together to the end')
})

test('o3d-jit6 r7: the wall-time budget is checked BEFORE the pause, so the retry cannot eat the window', async () => {
  // The budget is a fraction of the usable replay window, derived from the window's own constants.
  assert.ok(
    UNSENT_HANDBACK_RETRY_BUDGET_MS < USABLE_WINDOW_MS,
    'the retry sequence must not be allowed to spend the window it is trying to get back inside',
  )

  let calls = 0
  const slept: number[] = []
  // A clock that has already spent almost the whole budget by the time the first attempt fails.
  let nowMs = 0
  const outcome = await retryUnsentHandBack(
    () => {
      calls++
      nowMs = UNSENT_HANDBACK_RETRY_BUDGET_MS - 1
      return Promise.reject(new Error('deadlock detected'))
    },
    { sleep: async (ms) => { slept.push(ms) }, monotonicMs: () => nowMs },
  )

  assert.equal(calls, 1, 'the budget stopped it before a second attempt')
  assert.equal(slept.length, 0, 'AND BEFORE THE PAUSE — a budget noticed after it is overspent is not a bound')
  assert.equal(outcome.handedBack, false)
  assert.equal(outcome.handedBack === false && outcome.abandoned, 'budget-exhausted')
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 8 — THE BOUND WAS NOT A BOUND, AND A FALSE ALARM WAS POINTED AT AN OPERATOR.
 *
 * r7 retried the complete hand-back and called it "bounded twice over". It was not. The wall-time
 * bound accounted only for the delay it was ABOUT TO REQUEST: nothing measured how long an attempt
 * actually took, nothing re-checked after a sleep, and the attempt itself carried no bound at all —
 * so a slow transaction or an over-long pause carried the sequence past the replay window it exists
 * to get back inside, with every check it made still passing. And the budget was granted at ENTRY, as
 * if the window opened when the hand-back started rather than when the marker was stamped.
 *
 * r7 also named — and accepted — a residual that ended with an operator being told a row was
 * permanently stranded when it had in fact been handed back: an attempt whose COMMIT landed and whose
 * ACKNOWLEDGEMENT was lost.
 *
 * These pin both: a deadline anchored on the marker's own database-clock stamp and checked against
 * MEASURED elapsed time before every attempt and after every sleep, an attempt that cannot outlive
 * what is left, and a committed hand-back that is recognised as success rather than exhaustion.
 * ---------------------------------------------------------------------------------------------- */

/** The name this hand-back gives itself: the row, the claim instant it fences on, the attempt. */
const HAND_BACK_ID = unsentHandBackOperationId('log-1', claimHeldFrom(T_DISPATCH), ATTEMPT)

test('o3d-jit6 r8: the deadline is anchored on the marker, so time the window has already run is not re-granted', () => {
  // The marker was stamped almost a whole budget ago by the time the refusal is being handed back —
  // the transport hung, the refusal was classified, and all of that came out of the SAME window.
  const nearlySpent = unsentHandBackDeadline(1_000, {
    known: true,
    elapsedMs: UNSENT_HANDBACK_RETRY_BUDGET_MS - 100,
  })
  assert.equal(nearlySpent.anchor, 'dispatch-marker')
  assert.equal(nearlySpent.atMs, 1_100, 'what is left is the budget MINUS what the window has already run')
  // r7's bound, for contrast: a full budget handed out at entry, however old the marker was.
  assert.notEqual(
    nearlySpent.atMs,
    1_000 + UNSENT_HANDBACK_RETRY_BUDGET_MS,
    'a budget computed at entry describes a window that no longer exists',
  )

  // A marker that cannot be read — or is not there — falls back to the entry-anchored bound, and
  // never to a LONGER one: the fallback may only be as permissive as r7 already was.
  for (const reason of ['no-marker', 'unreadable', 'unorderable'] as const) {
    const fallback = unsentHandBackDeadline(1_000, { known: false, reason })
    assert.equal(fallback.anchor, 'hand-back-entry', `${reason}: the report must say which bound was used`)
    assert.equal(fallback.atMs, 1_000 + UNSENT_HANDBACK_RETRY_BUDGET_MS)
  }
})

test('o3d-jit6 r8: a marker-anchored deadline stops a retry that the entry-anchored budget would have allowed', async () => {
  async function sequenceUnder(deadline?: { atMs: number; anchor: 'dispatch-marker' | 'hand-back-entry' }) {
    let calls = 0
    const slept: number[] = []
    const outcome = await retryUnsentHandBack(
      () => {
        calls++
        return Promise.reject(new Error('deadlock detected'))
      },
      { sleep: async (ms) => { slept.push(ms) }, monotonicMs: () => 0, deadline },
    )
    return { calls, slept, outcome }
  }

  // The marker is 100ms from the end of the sequence's share of the window: there is no room for even
  // the first pause, so the sequence stops rather than spending the window it is racing.
  const anchored = await sequenceUnder({ atMs: 100, anchor: 'dispatch-marker' })
  assert.equal(anchored.calls, 1, 'one attempt, and then the real deadline stopped it')
  assert.deepEqual(anchored.slept, [], 'AND NOTHING WAS SLEPT — the pause was never affordable')
  assert.equal(anchored.outcome.handedBack, false)
  assert.equal(anchored.outcome.handedBack === false && anchored.outcome.abandoned, 'budget-exhausted')

  // The same failures, the same clock, the entry-anchored fallback: three attempts and two pauses.
  // That is the difference the anchor makes, stated as behaviour rather than as arithmetic.
  const fromEntry = await sequenceUnder()
  assert.equal(fromEntry.calls, UNSENT_HANDBACK_MAX_ATTEMPTS)
  assert.equal(fromEntry.slept.length, UNSENT_HANDBACK_MAX_ATTEMPTS - 1)
  assert.equal(fromEntry.outcome.handedBack === false && fromEntry.outcome.abandoned, 'attempts-exhausted')
})

test('o3d-jit6 r8: an attempt that overruns its share of the budget ends the sequence, and is given what is left', async () => {
  const budgets: number[] = []
  const slept: number[] = []
  let nowMs = 0
  let calls = 0

  const outcome = await retryUnsentHandBack(
    (attemptBudgetMs) => {
      calls++
      budgets.push(attemptBudgetMs)
      // THE ATTEMPT ITSELF OVERRUNS. It requested no delay, so r7's check — which looked only at the
      // pause it was about to ask for — could not see this at all.
      nowMs += 8_000
      return Promise.reject(new Error('could not serialize access due to concurrent update'))
    },
    {
      sleep: async (ms) => { slept.push(ms) },
      monotonicMs: () => nowMs,
      deadline: { atMs: 10_000, anchor: 'dispatch-marker' },
    },
  )

  assert.equal(calls, 2, 'the third attempt is not started: by then the deadline is 6s in the past')
  assert.deepEqual(slept, [UNSENT_HANDBACK_RETRY_BASE_DELAY_MS], 'only the pause that was still affordable')
  assert.equal(outcome.handedBack, false)
  assert.equal(outcome.handedBack === false && outcome.abandoned, 'budget-exhausted')

  // EACH ATTEMPT IS BOUNDED BY WHAT IS LEFT, so it cannot outlive the deadline on its own.
  assert.equal(budgets[0], 10_000, 'the first attempt may spend the whole remainder')
  assert.equal(budgets[1], 2_000, 'the second gets only what the first left behind')

  // AND THE DEFECT, IN ITS OWN TERMS: r7 compared (elapsed + requested delay) against a budget granted
  // at entry, and that comparison still passes here — which is why it never stopped anything.
  assert.ok(
    nowMs - 0 + UNSENT_HANDBACK_RETRY_BASE_DELAY_MS * 2 < UNSENT_HANDBACK_RETRY_BUDGET_MS,
    "r7's own check would have permitted a third attempt long after the deadline had passed",
  )
})

test('o3d-jit6 r8: a pause that sleeps longer than it asked for is caught AFTER the sleep, before the next attempt', async () => {
  let nowMs = 0
  let calls = 0
  const slept: number[] = []

  const outcome = await retryUnsentHandBack(
    () => {
      calls++
      return Promise.reject(new Error('deadlock detected'))
    },
    {
      // The pause was affordable when it was requested and was not when it ended — a stalled host, a
      // saturated event loop, a suspended container. r7 never looked again.
      sleep: async (ms) => { slept.push(ms); nowMs += 30_000 },
      monotonicMs: () => nowMs,
      deadline: { atMs: 10_000, anchor: 'dispatch-marker' },
    },
  )

  assert.equal(calls, 1, 'NO ATTEMPT BEGINS AFTER THE DEADLINE — this is the check r7 did not make')
  assert.deepEqual(slept, [UNSENT_HANDBACK_RETRY_BASE_DELAY_MS], 'the pause itself was legitimately taken')
  assert.equal(outcome.handedBack, false)
  assert.equal(outcome.handedBack === false && outcome.attempts, 1)
  assert.equal(outcome.handedBack === false && outcome.abandoned, 'budget-exhausted')
})

test('o3d-jit6 r8: an attempt is given the measured remainder, floored so it can still do its work', () => {
  assert.equal(unsentHandBackAttemptBudgetMs(5_000), 5_000, 'what is left is what it gets')
  assert.equal(unsentHandBackAttemptBudgetMs(1), UNSENT_HANDBACK_MIN_ATTEMPT_MS, 'never less than it takes to write three rows')
  assert.equal(
    unsentHandBackAttemptBudgetMs(-9_000),
    UNSENT_HANDBACK_MIN_ATTEMPT_MS,
    'an already-overrun deadline must not manufacture the abort it is measuring',
  )
  assert.equal(
    unsentHandBackAttemptBudgetMs(UNSENT_HANDBACK_RETRY_BUDGET_MS * 2),
    UNSENT_HANDBACK_RETRY_BUDGET_MS,
    'and never more than the sequence itself is allowed',
  )
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 8 — THE MEDIUM: A LOST ACKNOWLEDGEMENT IS NOT A STRANDED ROW.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r8: a hand-back whose acknowledgement was lost is reported as HANDED BACK, not as stranded', async () => {
  const w = makeWorld()
  let calls = 0
  const slept: number[] = []

  const outcome = await retryUnsentHandBack(
    async () => {
      calls++
      await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
        entry: { id: 'log-1', type: 'COGS_JOURNAL' },
        notPosted: NOT_POSTED,
        lease: claimHeldFrom(T_DISPATCH),
        attempt: ATTEMPT,
        job: JOB as never,
      }))
      // THE COMMIT LANDED AND THE ACKNOWLEDGEMENT DID NOT. Everything the hand-back had to do is
      // done; the caller sees only a rejection, exactly as a dropped connection presents it.
      throw new Error('connection terminated unexpectedly')
    },
    {
      sleep: async (ms) => { slept.push(ms) },
      monotonicMs: () => 0,
      // THE PROBE PRODUCTION USES, r9: not the evidence row — the COMMIT RECORD, which is written
      // after the release and states what it matched. `findRecordedUnsentHandBack` applies exactly
      // this predicate against `db`.
      recordedHandBack: async () => w.world().activity.some(
        (row) => row.action === UNSENT_HANDBACK_COMMIT_ACTION
          && (row.metadata as { handBackId?: string } | undefined)?.handBackId === HAND_BACK_ID
          && unsentHandBackCommitProvesRelease(row.metadata),
      ),
    },
  )

  assert.equal(outcome.handedBack, true, 'THE WORK WAS DONE — reporting it stranded is the false alarm')
  assert.equal(outcome.handedBack === true && outcome.alreadyRecorded, true, 'and it is distinguished from a fresh commit')
  assert.equal(outcome.handedBack === true && outcome.released, null, 'this run did not release, so it claims nothing about it')
  assert.equal(calls, 1, 'detected before a second attempt duplicates the evidence or throws on the outbox fence')
  assert.deepEqual(slept, [], 'and no pause is spent on work that has already happened')

  const after = w.world()
  assert.equal(after.activity.length, 2, "exactly ONE hand-back's rows — r7 wrote a second set on the retry")
  assert.equal(after.activity[0].entityId, 'log-1', 'named on the row, so the probe is an index lookup')
  assert.equal((after.activity[0].metadata as { handBackId?: string }).handBackId, HAND_BACK_ID)
  assert.equal(after.activity[1].action, UNSENT_HANDBACK_COMMIT_ACTION)
  assert.equal((after.activity[1].metadata as { released?: boolean }).released, true)
  assert.equal(after.sync.status, 'PENDING', 'the row really was handed back')
  assert.equal(after.job.status, 'RETRYABLE_FAILED', 'and the job with it, in that same commit')
  assert.equal(after.job.attempts, 2, 'still without spending an attempt')
})

test('o3d-jit6 r8: the identifier is deterministic across attempts and unique to this hand-back', () => {
  assert.equal(
    unsentHandBackOperationId('log-1', claimHeldFrom(T_DISPATCH), ATTEMPT),
    HAND_BACK_ID,
    'every attempt of one sequence derives the same name — nothing is generated and threaded through',
  )
  // A different row, a different claim instant, or a different attempt is a different hand-back, and
  // none of them may be mistaken for this one.
  assert.notEqual(unsentHandBackOperationId('log-2', claimHeldFrom(T_DISPATCH), ATTEMPT), HAND_BACK_ID)
  assert.notEqual(unsentHandBackOperationId('log-1', claimHeldFrom(T_REFUSAL), ATTEMPT), HAND_BACK_ID)
  assert.notEqual(
    unsentHandBackOperationId('log-1', claimHeldFrom(T_DISPATCH), { ...ATTEMPT, attemptRevision: 5 }),
    HAND_BACK_ID,
  )
})

test('o3d-jit6 r8: without the probe, that same lost acknowledgement is exactly the false alarm r7 accepted', async () => {
  // THE DEFECT, kept as a fact about the code rather than a story about it. Nothing here is mocked
  // into failing: the retry meets its OWN committed work and cannot tell that is what it is.
  const w = makeWorld()
  let calls = 0

  const outcome = await retryUnsentHandBack(
    async () => {
      calls++
      const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
        entry: { id: 'log-1', type: 'COGS_JOURNAL' },
        notPosted: NOT_POSTED,
        lease: claimHeldFrom(T_DISPATCH),
        attempt: ATTEMPT,
        job: JOB as never,
      }))
      if (calls === 1) throw new Error('connection terminated unexpectedly')
      return out
    },
    { sleep: async () => {}, monotonicMs: () => 0 },
  )

  assert.equal(outcome.handedBack, false, 'the sequence reports exhaustion...')
  assert.equal(outcome.handedBack === false && outcome.abandoned, 'attempts-exhausted')
  assert.equal(calls, UNSENT_HANDBACK_MAX_ATTEMPTS)
  // ...about a row that is sitting in PENDING with its evidence written and its job requeued. That
  // report sends an operator to resolve a row that needs nothing.
  const after = w.world()
  assert.equal(after.sync.status, 'PENDING', 'THE WORK WAS DONE ALL ALONG')
  assert.equal(after.activity.length, 2, 'and the later attempts rolled back, so not even a duplicate remains')
  assert.equal(after.job.status, 'RETRYABLE_FAILED')
})

test('o3d-jit6 r8: the shared hand-back anchors on the marker, bounds the attempt, and probes for its own work', () => {
  const source = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const handBack = source.slice(
    source.indexOf('async function handBackUnsentTransportRefusal(args: {'),
    source.indexOf('/**\n * HAND BACK A ROW THAT PROVABLY SENT NOTHING'),
  )
  assert.ok(handBack.length > 0, 'the shared hand-back must be found')

  // The deadline comes from the marker's own database-clock stamp, read as an elapsed DURATION so no
  // instant crosses between clocks (o3d-clxw). A `new Date()` compared against the column would be
  // that defect returning.
  assert.match(
    handBack,
    /unsentHandBackDeadline\(Date\.now\(\), await readCreateDispatchAge\(db, entry\.id\)\)/,
    'the wall-time bound must be anchored on the marker, not on when the hand-back happened to start',
  )
  assert.match(
    handBack,
    /unsentHandBackAttemptBounds\(attemptBudgetMs\)/,
    'and acquisition AND execution must come out of what is left, as ONE remainder (r9)',
  )
  assert.ok(
    !/maxWait: Math\.min\(attemptBudgetMs/.test(handBack),
    'an independently granted maxWait is a second budget added to the first — the r9 defect',
  )
  assert.match(
    handBack,
    /const handBackId = unsentHandBackOperationId\(entry\.id, lease, attempt\)/,
    'the hand-back names itself from the row, the claim instant and the attempt',
  )
  assert.match(
    handBack,
    /recordedHandBack: \(\) => findRecordedUnsentHandBack\(\{ entry, notPosted, handBackId \}\)/,
    'and an ambiguous failure asks the database whether that name is already recorded',
  )
  assert.ok(
    !/throw /.test(handBack),
    'it must still not throw into the per-entry catch: that spends a retry and FAILS a row that sent nothing',
  )
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 9 — THE DEADLINE WAS SAMPLED IN TWO CALLS, THE ATTEMPT HAD TWO BUDGETS, AND THE PROBE
 * CERTIFIED A RELEASE IT HAD NOT SEEN.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A database whose clock only moves when it is asked to do work — so "how long the read took" is a
 * number the test controls rather than a race it hopes for.
 */
function makeSampledDatabase(options: { dispatchedAt: Date; startElapsedMs: number; statementMs: number; secondQueryMs: number }) {
  let dbNowMs = options.dispatchedAt.getTime() + options.startElapsedMs
  const calls = { queryRaw: 0, findUnique: 0 }
  const client: CreateDispatchClient = {
    $queryRaw: (async (strings: TemplateStringsArray) => {
      calls.queryRaw++
      // The statement itself costs time, and `clock_timestamp()` is evaluated INSIDE it.
      dbNowMs += options.statementMs
      const sql = Array.from(strings).join('?')
      if (sql.includes('create_dispatched_at')) {
        return [{ elapsedMs: dbNowMs - options.dispatchedAt.getTime() }]
      }
      // r8's shape: a clock read on its own, with the marker still to be fetched.
      return [{ now: new Date(dbNowMs) }]
    }) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      findUnique: async () => {
        calls.findUnique++
        // THE SLOW SECOND QUERY. Under load this is where the time goes, and under r8 every
        // millisecond of it fell outside the elapsed figure.
        dbNowMs += options.secondQueryMs
        return {
          createDispatchedAt: options.dispatchedAt,
          createDispatchIdempotencyKey: KEY,
          createDispatchReleasedAt: null,
        }
      },
    },
  }
  return { client, calls, elapsedNow: () => dbNowMs - options.dispatchedAt.getTime() }
}

test('o3d-jit6 r9: the marker age is sampled in ONE statement, so a slow read cannot extend the deadline', async () => {
  const STATEMENT_MS = 40
  const SECOND_QUERY_MS = 3_000
  const START_ELAPSED_MS = 1_000
  const db = makeSampledDatabase({
    dispatchedAt: T_DISPATCH,
    startElapsedMs: START_ELAPSED_MS,
    statementMs: STATEMENT_MS,
    secondQueryMs: SECOND_QUERY_MS,
  })

  const age = await readCreateDispatchAge(db.client, 'log-1')

  // ONE ROUND TRIP. The marker and the clock are read together; there is no second query for time to
  // hide in.
  assert.equal(db.calls.queryRaw, 1, 'the marker and the clock come back from the same statement')
  assert.equal(db.calls.findUnique, 0, 'and there is no separate fetch of the marker at all')

  assert.equal(age.known, true)
  assert.equal(
    age.known === true && age.elapsedMs,
    db.elapsedNow(),
    'the duration handed to the host is the one the database measured when it read the row',
  )
  assert.equal(age.known === true && age.elapsedMs, START_ELAPSED_MS + STATEMENT_MS)

  // AND THE DEADLINE IS THAT MUCH EARLIER. r8 sampled the clock first and then paid SECOND_QUERY_MS
  // for the marker, so its elapsed figure was short by exactly that and the deadline it built sat
  // that much LATER than the truth — under the delay that makes the window tight.
  const honest = unsentHandBackDeadline(0, age)
  assert.equal(honest.anchor, 'dispatch-marker')
  assert.equal(honest.atMs, UNSENT_HANDBACK_RETRY_BUDGET_MS - (START_ELAPSED_MS + STATEMENT_MS))
  const twoCallSampling = unsentHandBackDeadline(0, { known: true, elapsedMs: START_ELAPSED_MS + STATEMENT_MS - SECOND_QUERY_MS })
  assert.ok(
    honest.atMs < twoCallSampling.atMs,
    'a deadline built from a two-call sample is later than the truth by the cost of the second call',
  )
})

test('o3d-jit6 r9: a row that is gone and a row with no marker are still told apart, from the one statement', async () => {
  const missing: CreateDispatchClient = {
    $queryRaw: (async () => []) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: { findUnique: async () => { throw new Error('must not be called') } },
  }
  assert.deepEqual(await readCreateDispatchAge(missing, 'log-1'), { known: false, reason: 'unreadable' })

  const unmarked: CreateDispatchClient = {
    $queryRaw: (async () => [{ elapsedMs: null }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: { findUnique: async () => { throw new Error('must not be called') } },
  }
  assert.deepEqual(await readCreateDispatchAge(unmarked, 'log-1'), { known: false, reason: 'no-marker' })

  // An age this instance cannot order against the database's own clock is evidence of nothing.
  const backwards: CreateDispatchClient = {
    $queryRaw: (async () => [{ elapsedMs: -1 }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: { findUnique: async () => { throw new Error('must not be called') } },
  }
  assert.deepEqual(await readCreateDispatchAge(backwards, 'log-1'), { known: false, reason: 'unorderable' })

  const broken: CreateDispatchClient = {
    $queryRaw: (async () => { throw new Error('connection terminated') }) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: { findUnique: async () => { throw new Error('must not be called') } },
  }
  assert.deepEqual(await readCreateDispatchAge(broken, 'log-1'), { known: false, reason: 'unreadable' })
})

test('o3d-jit6 r9: acquisition and execution come out of ONE remainder, never two budgets that add up', () => {
  for (const budget of [
    UNSENT_HANDBACK_MIN_ATTEMPT_MS,
    UNSENT_HANDBACK_MIN_ATTEMPT_MS + 1,
    5_000,
    UNSENT_HANDBACK_RETRY_BUDGET_MS,
  ]) {
    const bounds = unsentHandBackAttemptBounds(budget)
    assert.equal(
      bounds.maxWait + bounds.timeout,
      budget,
      `${budget}: waiting for a connection and running the transaction must share the remainder`,
    )
    assert.ok(bounds.maxWait >= 1 && bounds.timeout >= 1, `${budget}: both halves must be usable`)
    assert.ok(bounds.maxWait <= UNSENT_HANDBACK_MAX_WAIT_MS, `${budget}: the reservation is capped`)
  }

  // THE r8 SHAPE, FOR CONTRAST: the budget as `timeout` with `maxWait` granted independently on top.
  // An attempt could spend both, consecutively, and outlive the deadline by the whole wait.
  const budget = unsentHandBackAttemptBudgetMs(UNSENT_HANDBACK_RETRY_BUDGET_MS)
  const r8 = { timeout: budget, maxWait: Math.min(budget, UNSENT_HANDBACK_MAX_WAIT_MS) }
  assert.ok(r8.maxWait + r8.timeout > budget, 'which is the finding')
  assert.equal(unsentHandBackAttemptBounds(budget).maxWait + unsentHandBackAttemptBounds(budget).timeout, budget)
})

test('o3d-jit6 r9: the commit records WHAT THE FENCED RELEASE MATCHED, and only that proves a hand-back', async () => {
  const w = makeWorld()
  const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
    job: JOB as never,
  }))
  assert.equal(out.released, true)

  const [evidence, commit] = w.world().activity
  // THE FINDING. The evidence row is written BEFORE the release and commits even when the release
  // matches nothing, so it cannot prove the release ran — and r8's probe read exactly this row.
  assert.equal(evidence.action, 'xero_sync_transport_refused_before_post')
  assert.equal((evidence.metadata as { handBackId?: string }).handBackId, HAND_BACK_ID)
  assert.equal(
    unsentHandBackCommitProvesRelease(evidence.metadata),
    false,
    'the named evidence row says a refusal was recorded, and nothing about the release',
  )

  assert.equal(commit.action, UNSENT_HANDBACK_COMMIT_ACTION)
  assert.equal((commit.metadata as { handBackId?: string }).handBackId, HAND_BACK_ID,
    'the release result is persisted alongside the deterministic identifier, in the same transaction')
  assert.equal((commit.metadata as { released?: boolean }).released, true)
  assert.equal(unsentHandBackCommitProvesRelease(commit.metadata), true)

  // AND A ZERO-ROW RELEASE STILL COMMITS — deliberately — and is recorded truthfully rather than
  // hidden. The probe may certify it, because the record proves the release ran and says what it did.
  const displaced = makeWorld({ sync: { processingStartedAt: new Date(T_DISPATCH.getTime() + 60_000) } })
  const zero = await displaced.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
    job: JOB as never,
  }))
  assert.equal(zero.released, false)
  const zeroCommit = displaced.world().activity[1]
  assert.equal(zeroCommit.action, UNSENT_HANDBACK_COMMIT_ACTION)
  assert.equal((zeroCommit.metadata as { released?: boolean }).released, false)
  assert.equal(unsentHandBackCommitProvesRelease(zeroCommit.metadata), true)
})

test('o3d-jit6 r9: the probe looks for the commit record, not for the evidence row', () => {
  const source = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const probe = source.slice(
    source.indexOf('async function findRecordedUnsentHandBack(args: {'),
    source.indexOf('/**\n * SAY THAT AN ACKNOWLEDGEMENT WAS LOST'),
  )
  assert.ok(probe.length > 0, 'the probe must be found')
  assert.match(probe, /action: UNSENT_HANDBACK_COMMIT_ACTION/, 'it asks for the record the release wrote')
  assert.ok(
    !/unsentPostEvidence\(/.test(probe),
    'the evidence row cannot prove the release ran — it is written before it and commits without it',
  )
  assert.match(
    probe,
    /return unsentHandBackCommitProvesRelease\(found\?\.metadata\)/,
    'and success requires a record that STATES what the fenced release matched',
  )

  // The commit record is written AFTER the release, in the same transaction, so it cannot exist
  // unless the release returned.
  const body = source.slice(
    source.indexOf('export async function recordAndReleaseUnsentTransportRefusal('),
    source.indexOf('/**\n * SAY THAT THE HAND-BACK ABORTED'),
  )
  const releaseAt = body.indexOf('await releaseUnsentTransportRefusal(')
  const commitAt = body.indexOf('action: UNSENT_HANDBACK_COMMIT_ACTION')
  assert.ok(releaseAt > -1 && commitAt > releaseAt, 'the release result is recorded after the release')
  assert.match(body, /handBackId,\n      released,\n/, 'the identifier and the result on the same record')
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 10 — THE AGE WAS MEASURED ACROSS TWO TIMESTAMP TYPES, AND THE SPLIT ATE THE FLOOR IT WAS
 * SPLITTING.
 * ---------------------------------------------------------------------------------------------- */

/**
 * o3d-jit6 r10 (Codex HIGH) — THE SESSION'S TIME ZONE WAS AN OPERAND OF THE REPLAY WINDOW.
 *
 * `create_dispatched_at` is `TIMESTAMP(3)` WITHOUT time zone and holds the driver's naive UTC
 * instant. `clock_timestamp()` is `timestamptz`. Subtracting the first from the second makes Postgres
 * promote the naive column using the SESSION's `TimeZone`, so the elapsed figure is off by exactly
 * that offset — hours, against a window of six minutes.
 *
 * WHAT THIS TEST IS AND IS NOT. It pins the SQL SHAPE: that the clock is demoted into the column's
 * own naive UTC frame before the subtraction, and that the r9 shape which did not is gone. It is a
 * WEAKER test than executing the statement, because it asserts the text of the query rather than the
 * behaviour of a server — a rewrite that preserved the phrase and broke the semantics would pass it.
 *
 * The behaviour itself was verified against a real PostgreSQL engine — an ephemeral in-memory PGlite
 * instance created for the check and discarded, touching no database of ours — by running BOTH
 * statements against the same row under `SET LOCAL TIME ZONE` for UTC, Europe/London,
 * America/New_York, Asia/Tokyo and Pacific/Kiritimati. On a marker minted milliseconds earlier the
 * r9 statement reported 0.002s elapsed under UTC, 3600.004s under Europe/London (deadline 3570s in
 * the PAST — every attempt after the first refused as budget-exhausted), 32400.006s under Asia/Tokyo,
 * 50400.007s under Pacific/Kiritimati, and MINUS 14399.995s under America/New_York, which
 * `readCreateDispatchAge` rejects as `unorderable` so the caller silently falls back to the
 * entry-anchored bound r8 exists to replace. The fixed statement reported 0.003s–0.008s under all
 * five — a spread of 5ms, which is the probe's own elapsed time and nothing else. That run is not
 * reproducible from this suite; the assertions below are what remains under CI.
 */
test('o3d-jit6 r10: the age subtracts two NAIVE UTC timestamps, so the session time zone is not an operand', () => {
  const migration = readFileSync(
    join(process.cwd(), 'prisma/migrations/20260822090100_accounting_sync_log_create_dispatch_record/migration.sql'),
    'utf8',
  )
  // THE PREMISE, PINNED: the column is `timestamp WITHOUT time zone`. If it ever becomes `timestamptz`
  // the subtraction below stops needing the demotion — and this assertion is what says so.
  assert.match(
    migration,
    /ADD COLUMN "create_dispatched_at" TIMESTAMP\(3\);/,
    'the marker is a naive timestamp, which is why the clock must be demoted to match it',
  )
  assert.ok(
    !/create_dispatched_at" TIMESTAMPTZ/i.test(migration),
    'nothing may quietly turn the marker into a time-zone-aware column without revisiting the read',
  )

  const source = readFileSync(join(process.cwd(), 'lib/domain/accounting/create-dispatch-record.ts'), 'utf8')
  const read = source.slice(source.indexOf('export async function readCreateDispatchAge('))
  const statement = read.slice(0, read.indexOf('const row = rows?.[0]'))
  assert.ok(statement.length > 0, 'the one statement must be found')

  assert.match(
    statement,
    /EXTRACT\(EPOCH FROM \(\(clock_timestamp\(\) AT TIME ZONE 'UTC'\) - "create_dispatched_at"\)\)/,
    'the clock is demoted into the marker’s own naive UTC frame BEFORE the subtraction',
  )
  // THE r9 SHAPE, WHICH IS THE FINDING: a bare `timestamptz - timestamp`, resolved per session.
  assert.ok(
    !/EPOCH FROM \(clock_timestamp\(\) - "create_dispatched_at"\)/.test(statement),
    'a bare timestamptz minus a naive timestamp is resolved in the SESSION time zone — the finding',
  )
  // `now()`/`CURRENT_TIMESTAMP` are timestamptz too, and `timezone(...)`/`::timestamp` would be the
  // same demotion spelt differently; none of them may appear undemoted.
  assert.ok(
    !/\b(now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP)\b/.test(statement),
    'the sample uses clock_timestamp(), not a statement-frozen or session-local clock',
  )
})

/**
 * o3d-jit6 r10 (Codex HIGH) — THE CLAMP AND THE SPLIT CONTRADICTED EACH OTHER.
 *
 * r8 clamped the attempt budget UP to a floor because the transaction needs that much time TO RUN.
 * r9 then reserved the connection wait OUT of the clamped value, capped at half of it — so the floor
 * case ran the transaction in half the time the floor was clamped to guarantee.
 */
test('o3d-jit6 r10: the clamp guarantees EXECUTION its minimum, AFTER acquisition has been reserved', () => {
  assert.equal(
    UNSENT_HANDBACK_MIN_ATTEMPT_MS,
    UNSENT_HANDBACK_MIN_EXECUTION_MS + UNSENT_HANDBACK_MIN_ACQUISITION_MS,
    'the attempt floor is the two minima together, not the execution minimum standing in for both',
  )

  // THE FINDING, SPELT OUT: r9's split applied to r8's floor (which WAS the execution minimum).
  const r9MaxWaitAtItsFloor = Math.max(1, Math.min(UNSENT_HANDBACK_MAX_WAIT_MS, Math.floor(UNSENT_HANDBACK_MIN_EXECUTION_MS / 2)))
  const r9ExecutionAtItsFloor = UNSENT_HANDBACK_MIN_EXECUTION_MS - r9MaxWaitAtItsFloor
  assert.ok(
    r9ExecutionAtItsFloor < UNSENT_HANDBACK_MIN_EXECUTION_MS,
    'r9 left the floor case with less execution time than the floor exists to guarantee',
  )
  assert.equal(r9ExecutionAtItsFloor, UNSENT_HANDBACK_MIN_EXECUTION_MS / 2, 'half of it, precisely')

  // AND WHAT IT IS NOW: the floor splits into exactly one minimum each, summing to the budget.
  const floorBudget = unsentHandBackAttemptBudgetMs(1)
  assert.equal(floorBudget, UNSENT_HANDBACK_MIN_ATTEMPT_MS)
  const atFloor = unsentHandBackAttemptBounds(floorBudget)
  assert.equal(atFloor.maxWait, UNSENT_HANDBACK_MIN_ACQUISITION_MS, 'the wait gets its minimum')
  assert.equal(atFloor.timeout, UNSENT_HANDBACK_MIN_EXECUTION_MS, 'and the transaction still gets ALL of its own')
  assert.equal(atFloor.maxWait + atFloor.timeout, floorBudget, 'with nothing added on top')

  // Across every budget the clamp can actually produce, all four invariants hold at once.
  for (const remainingMs of [
    -9_000, 0, 1, 999, 1_000, UNSENT_HANDBACK_MIN_ATTEMPT_MS - 1, UNSENT_HANDBACK_MIN_ATTEMPT_MS,
    UNSENT_HANDBACK_MIN_ATTEMPT_MS + 1, 2_000, 3_000, 3_001, 5_000,
    UNSENT_HANDBACK_RETRY_BUDGET_MS, UNSENT_HANDBACK_RETRY_BUDGET_MS * 3,
  ]) {
    const budget = unsentHandBackAttemptBudgetMs(remainingMs)
    const bounds = unsentHandBackAttemptBounds(budget)
    assert.equal(bounds.maxWait + bounds.timeout, budget, `${remainingMs}: the halves still sum to the budget exactly`)
    assert.ok(
      bounds.timeout >= UNSENT_HANDBACK_MIN_EXECUTION_MS,
      `${remainingMs}: execution keeps its own minimum after the reservation (got ${bounds.timeout})`,
    )
    assert.ok(
      bounds.maxWait >= UNSENT_HANDBACK_MIN_ACQUISITION_MS,
      `${remainingMs}: acquisition keeps its own minimum (got ${bounds.maxWait})`,
    )
    assert.ok(bounds.maxWait <= UNSENT_HANDBACK_MAX_WAIT_MS, `${remainingMs}: the reservation is still capped`)
  }

  // A LARGE BUDGET STILL GIVES EXECUTION NEARLY ALL OF IT — the r9 property that was worth keeping.
  const wide = unsentHandBackAttemptBounds(UNSENT_HANDBACK_RETRY_BUDGET_MS)
  assert.equal(wide.maxWait, UNSENT_HANDBACK_MAX_WAIT_MS)
  assert.equal(wide.timeout, UNSENT_HANDBACK_RETRY_BUDGET_MS - UNSENT_HANDBACK_MAX_WAIT_MS)
})

/* ------------------------------------------------------------------------------------------------
 * o3d-gvzu — AND THE MARKER'S RELEASE, WRITTEN IN THE SAME COMMIT.
 *
 * Round 4 gave the row back inside the replay window and said, correctly, that the marker still
 * refuses a late attempt: "releasing the claim buys a chance to get back before the deadline; it does
 * not move the deadline". That is what one "Not connected to Xero" blip cost — a permanent refusal
 * needing an operator, for a create nobody made. The release is the deadline finally moving, and only
 * on positive evidence: `notPosted.releaseCreateDispatch` is present ONLY when the transport named a
 * provably pre-egress refusal AND the marker is one this attempt can speak for.
 * ---------------------------------------------------------------------------------------------- */

/** What the journal branch attaches when, and only when, the release is licensed. */
const RELEASING = {
  ...NOT_POSTED,
  releaseCreateDispatch: { notSent: 'no-connection', basis: 'first-dispatch' },
}

test('o3d-gvzu: a proven pre-egress refusal releases the marker, in the hand-back\'s own commit', async () => {
  const w = makeWorld()

  const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: RELEASING,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
  }))

  assert.equal(out.released, true)
  const after = w.world()
  assert.notEqual(after.sync.createDispatchReleasedAt, null, 'THE POINT: the release is recorded')
  // THE MARKER ITSELF IS UNTOUCHED, which is the whole reason this is a second column: the pair is
  // write-once by database trigger because it is a prohibition, and a prohibition that tampering
  // clears hands the tamperer what they wanted.
  assert.equal(after.sync.createDispatchedAt?.valueOf(), T_DISPATCH.valueOf())
  assert.equal(after.sync.createDispatchIdempotencyKey, KEY)
  // And it is one fact with the rest of the hand-back: same commit, same evidence trail.
  assert.equal(after.sync.status, 'PENDING')
  assert.equal(after.activity[0].action, 'xero_sync_transport_refused_before_post')
  const commit = after.activity[1].metadata as Record<string, unknown>
  assert.equal(commit.createDispatchReleased, true, 'the commit record says the release landed')
  assert.equal(commit.notSent, 'no-connection', 'and names the refusal that licensed it')
})

test('o3d-gvzu: a refusal with NO proof writes no release at all', async () => {
  // The ordinary case, and the safe one: a timeout, a socket reset mid-write, a 5xx, or a replay of a
  // marker some earlier attempt minted. `releaseCreateDispatch` is absent, so nothing is released and
  // the row behaves exactly as round 4 left it.
  //
  // MUTATION THAT KILLS THIS TEST: making the release unconditional — dropping the
  // `args.notPosted.releaseCreateDispatch ?` guard in `recordAndReleaseUnsentTransportRefusal`.
  // Under it every transport refusal releases the marker, including the ones that may have arrived.
  const w = makeWorld()

  const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: NOT_POSTED,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
  }))

  assert.equal(out.released, true, 'the row is still handed back — that part is unchanged')
  const after = w.world()
  assert.equal(after.sync.createDispatchReleasedAt, null, 'THE POINT: but nothing is released')
  const commit = after.activity[1].metadata as Record<string, unknown>
  assert.equal(commit.createDispatchReleased, null,
    'and the commit record distinguishes "no release attempted" from "attempted and matched nothing"')
})

test('o3d-gvzu: the release is FENCED — a displaced owner releases nothing', async () => {
  // The same fence every non-terminal write here carries. A worker whose claim has been taken must
  // not be able to license a post on a row somebody else is already posting.
  //
  // MUTATION THAT KILLS THIS TEST: dropping `heldClaimWhere` (or the attempt revision) from
  // `releaseCreateDispatchMarker`'s predicate. Under it the stale worker's release lands.
  const w = makeWorld()

  const out = await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: RELEASING,
    // A claim instant this row no longer carries: another worker took it and renewed.
    lease: claimHeldFrom(new Date(T_DISPATCH.getTime() - 60_000)),
    attempt: ATTEMPT,
  }))

  assert.equal(out.released, false, 'the claim release matches nothing either')
  const after = w.world()
  assert.equal(after.sync.createDispatchReleasedAt, null, 'THE POINT: and neither does the release')
  const commit = after.activity[1].metadata as Record<string, unknown>
  assert.equal(commit.createDispatchReleased, false, 'reported as attempted-and-matched-nothing')
})

test('o3d-gvzu: a release already standing is not re-stamped by a second refusal', async () => {
  // WRITE-ONCE PER PROOF. The instant on the row belongs to the proof that first established it, and
  // a second refusal on the same standing release must not move it — the column is only ever read as
  // present/absent, so moving it buys nothing and loses the one thing it records.
  //
  // MUTATION THAT KILLS THIS TEST: dropping `createDispatchReleasedAt: null` from the predicate.
  const first = new Date(T_DISPATCH.getTime() + 500)
  const w = makeWorld({ sync: { createDispatchReleasedAt: first } })

  await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: RELEASING,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
  }))

  assert.equal(w.world().sync.createDispatchReleasedAt?.valueOf(), first.valueOf())
})

test('o3d-gvzu: a row with NO marker cannot be released — there is nothing for a release to be about', async () => {
  // Belt as well as braces: the database refuses this too (the trigger nulls a release written onto a
  // row whose OLD marker was null), and the predicate refuses it here so a row that reaches the
  // hand-back without a marker cannot acquire a standing permission out of nowhere.
  //
  // MUTATION THAT KILLS THIS TEST: dropping `createDispatchedAt: { not: null }` from the predicate.
  const w = makeWorld({ sync: { createDispatchedAt: null, createDispatchIdempotencyKey: null } })

  await w.transaction((tx) => recordAndReleaseUnsentTransportRefusal(tx, {
    entry: { id: 'log-1', type: 'COGS_JOURNAL' },
    notPosted: RELEASING,
    lease: claimHeldFrom(T_DISPATCH),
    attempt: ATTEMPT,
  }))

  assert.equal(w.world().sync.createDispatchReleasedAt, null)
})

test('o3d-gvzu: the released row may send again, and the send SPENDS the release', async () => {
  // What the release is worth, end to end, through the real decision function rather than a model of
  // it. A row past the window with a standing release dispatches — and the fence write it hands back
  // is the CONSUMPTION, so the permission cannot outlive the request it permitted. Without that, a
  // send that landed and then failed to settle would meet the same standing release and post again.
  const pastTheWindow = new Date(T_DISPATCH.getTime() + XERO_IDEMPOTENCY_KEY_RETENTION_MS + 60_000)

  const refused = decideCreateDispatch({
    type: 'COGS_JOURNAL',
    idempotencyKey: KEY,
    recorded: { dispatchedAt: T_DISPATCH, idempotencyKey: KEY, releasedAt: null },
    now: pastTheWindow,
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
  })
  assert.equal(refused.dispatch, false, 'the wedged state this issue is about')

  const released = decideCreateDispatch({
    type: 'COGS_JOURNAL',
    idempotencyKey: KEY,
    recorded: { dispatchedAt: T_DISPATCH, idempotencyKey: KEY, releasedAt: T_REFUSAL },
    now: pastTheWindow,
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
  })
  assert.equal(released.dispatch, true, 'THE POINT: a proven-unsent marker no longer wedges the row')
  assert.equal(released.dispatch === true ? released.basis : null, 'released-nothing-left-the-process')

  // AND THE ARM THAT WINS IS THE ONE THAT SPENDS IT. Inside the window a same-key replay would also
  // dispatch — but on a basis that writes NOTHING, which would leave the release standing over a
  // request that then went out.
  //
  // MUTATION THAT KILLS THIS TEST: moving the release arm below the replay arm in
  // `decideCreateDispatch`. The basis comes back as 'replay-within-idempotency-window', the fence
  // writes nothing, and the release survives its own send.
  const insideTheWindow = new Date(T_DISPATCH.getTime() + 1_000)
  const both = decideCreateDispatch({
    type: 'COGS_JOURNAL',
    idempotencyKey: KEY,
    recorded: { dispatchedAt: T_DISPATCH, idempotencyKey: KEY, releasedAt: T_REFUSAL },
    now: insideTheWindow,
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
  })
  assert.equal(both.dispatch === true ? both.basis : null, 'released-nothing-left-the-process',
    'the release arm wins even where the replay arm would also have dispatched')
})

test('o3d-gvzu: the fence write for that basis is the CONSUMPTION, and the fence fails closed on it', async () => {
  const source = readFileSync(join(process.cwd(), 'lib/domain/accounting/create-dispatch-record.ts'), 'utf8')
  const plan = source.slice(source.indexOf('export async function planCreateDispatch('))
  // MUTATION THAT KILLS THIS TEST: returning `write: null` for the released basis, so the permission
  // is never spent.
  assert.match(
    plan,
    /decision\.basis === 'released-nothing-left-the-process'\s*\n\s*\? \{ createDispatchReleasedAt: null \}\s*\n\s*: null/,
    'the released basis, and only it, hands the fence the consumption',
  )

  const processor = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const fence = processor.slice(processor.indexOf('async fenceBeforeRemoteWrite(operation: string'))
  // A create whose consumption cannot be written is a create whose outcome cannot be recorded either:
  // the same rule the mint already answers to, and the same reason.
  assert.match(fence.slice(0, fence.indexOf('if (!again)')), /if \(!createDispatchWrite\) throw error/)
  assert.match(
    processor.slice(processor.indexOf('export async function renewClaimForRemoteWrite(')),
    /data: write \? \{ processingStartedAt: renewedAt, \.\.\.write \} : \{ processingStartedAt: renewedAt \}/,
    'and it rides inside the claim proof, exactly as the mint does',
  )
})
