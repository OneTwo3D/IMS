import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import {
  decideCreateDispatchRelease,
  mayReleaseCreateDispatch,
  type CreateDispatchBasis,
} from '@/lib/domain/accounting/create-dispatch-record'

/**
 * o3d-gvzu — RELEASE THE MARKER ON PROOF THAT NOTHING LEFT, AND ON NOTHING ELSE.
 *
 * The manual-journal branch mints a durable dispatch marker inside the claim fence, one statement
 * before the socket, and the transport still has pre-egress stops BELOW it. Each of them reported
 * "nothing left this process" and each left the marker written, so one "Not connected to Xero" blip
 * wedged the row for good once Xero's six-minute idempotency window closed under it.
 *
 * WHAT THIS FILE IS ABOUT IS THE DIRECTION EACH CASE FAILS IN. "Proof nothing was sent" is not the
 * same fact as "we got no answer", and the whole value of the fix is that it cannot be widened into
 * the second one by accident:
 *
 *   PROVABLY PRE-EGRESS — release   a connection that never resolved, a posting-intent refusal, an
 *                                   egress authorisation, an exhausted rate budget. Each is a NAMED
 *                                   member written by the statement that performed it, and each is
 *                                   provable from where that statement sits relative to the socket.
 *   MAY HAVE ARRIVED — keep         a timeout, a socket reset mid-write, a 5xx. No member exists for
 *                                   any of them, deliberately, and the tests below are written so
 *                                   that inventing one to cover them turns them red.
 *
 * The transport here is REAL. Only its edges are doubled — the auth resolution, the two
 * authorisations, and `connectorFetch` itself — so what is under test is the actual retry loop, the
 * actual budget bounds and the actual statement order, not a model of them.
 */

/* ------------------------------------------------------------------------------------------------
 * THE TRANSPORT, REAL, WITH ONLY ITS EDGES DOUBLED.
 * ---------------------------------------------------------------------------------------------- */

let auth: { accessToken: string; tenantId: string } | null = { accessToken: 'tok', tenantId: 'tenant-1' }
let intentRefusal: string | null = null
let egressRefusal: string | null = null
/**
 * ...AND THE OTHER WAY EACH OF THEM CAN LEAVE (o3d-2w2j r2, Codex HIGH).
 *
 * Round 1 doubled these edges so they could RETURN a refusal. Every one of them can also THROW — the
 * resolver reads the token row, reads settings and decrypts; the egress `authorize` callbacks read
 * and WRITE the database — and an enumeration of returns is not an enumeration of exits. These are
 * what let the tests below drive the throwing exit of the very same statement.
 */
let authThrows: Error | null = null
let intentThrows: Error | null = null
let egressThrows: Error | null = null
/** Answers `connectorFetch`, call by call. Throwing models a timeout or a reset mid-write. */
let fetchAnswers: Array<{ status: number; body?: unknown; throws?: Error; retryAfter?: string }> = []
const wireCalls: string[] = []
/** Runs at the top of every `connectorFetch`, so a test can change the world MID-CALL. */
let onFetch: (() => void) | null = null

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => {
      if (authThrows) throw authThrows
      return auth
    },
    getStoredTenantBlockReason: async () => null,
  },
})

mock.module('@/lib/connectors/accounting-posting-intent', {
  namedExports: {
    accountingPostingIntentRefusal: () => {
      if (intentThrows) throw intentThrows
      return intentRefusal
    },
  },
})

mock.module('@/lib/connectors/accounting-egress-authorization', {
  namedExports: {
    accountingEgressRefusal: async () => {
      if (egressThrows) throw egressThrows
      return egressRefusal
    },
  },
})

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      wireCalls.push(url)
      onFetch?.()
      const answer = fetchAnswers.shift() ?? {
        status: 200,
        body: { ManualJournals: [{ ManualJournalID: 'MJ-1' }] },
      }
      if (answer.throws) throw answer.throws
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        headers: { get: (name: string) => (name === 'Retry-After' ? answer.retryAfter ?? null : null) },
        json: async () => answer.body,
        text: async () => JSON.stringify(answer.body ?? {}),
      } as unknown as Response
    },
  },
})

type JournalsModule = typeof import('../../lib/connectors/xero/journals.ts')

const LINES = [
  { accountCode: '310', description: 'COGS', debit: 40 },
  { accountCode: '630', description: 'Inventory', credit: 40 },
]

async function postOne() {
  const { prepareManualJournal, postPreparedManualJournal }: JournalsModule =
    await import('@/lib/connectors/xero/journals')
  const prepared = prepareManualJournal({
    date: '2026-08-22', reference: 'COGS 2026-08-22', narration: 'COGS', lines: LINES,
  })
  assert.ok(prepared.ok, 'the journal itself is valid — every gate above the fence has passed')
  return postPreparedManualJournal(prepared.prepared, { idempotencyKey: 'ims-manual-journal-log-1' })
}

function reset() {
  wireCalls.length = 0
  fetchAnswers = []
  onFetch = null
  // A fresh tenant per test: the rate buckets are per-tenant and process-wide, so a shared id would
  // let one test's spend decide another's budget verdict.
  auth = { accessToken: 'tok', tenantId: `tenant-${Math.random()}` }
  intentRefusal = null
  egressRefusal = null
  authThrows = null
  intentThrows = null
  egressThrows = null
}

/** The release decision, taken on a REAL transport outcome, for the attempt that minted the marker. */
function verdictFor(outcome: { reachedTheWire: boolean; notSent?: string }) {
  return decideCreateDispatchRelease({ basis: 'first-dispatch', outcome })
}

/* ------------------------------------------------------------------------------------------------
 * THE POSITIVE HALF: THE FOUR REFUSALS THAT ARE PROVABLY ABOVE THE SOCKET.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-gvzu: each pre-egress refusal names ITSELF, and each releases the marker', async () => {
  const refusals: Array<[string, string, () => void]> = [
    // The blip the issue names. `getAccessToken()` answered null, so no token, no tenant header and
    // no request object were ever built.
    ['no usable connection', 'no-connection', () => { auth = null }],
    ['posting intent refused', 'posting-intent-refused',
      () => { intentRefusal = 'Xero posting is paused for this organisation' }],
    ['egress authorisation refused', 'egress-unauthorised',
      () => { egressRefusal = 'This connection is not authorised to write' }],
  ]

  for (const [name, expected, arrange] of refusals) {
    reset()
    arrange()

    const result = await postOne()

    assert.equal(result.success, false, `${name}: the post fails`)
    assert.deepEqual(wireCalls, [], `${name}: and provably nothing left the process`)
    assert.equal(result.reachedTheWire, false, `${name}: the counter says so`)
    assert.equal(result.notSent, expected, `THE POINT (${name}): and the refusal NAMES itself`)

    const verdict = verdictFor(result)
    assert.equal(verdict.release, true, `${name}: so the marker may be released`)
    assert.equal(verdict.release === true ? verdict.notSent : null, expected,
      `${name}: and the release records WHICH refusal licensed it`)
  }
})

test('o3d-gvzu: every rate-budget refusal is tagged, and each returns BEFORE `noteRequest`', async () => {
  // THE FOURTH MEMBER, AND THE ONE THAT CANNOT BE DRIVEN END-TO-END HERE — said plainly rather than
  // faked. Reaching the rolling-day cap takes 950 real calls, and the minute limiter sleeps out a
  // sixty-second window every 55 of them, so a behavioural test of it would spend a quarter of an
  // hour asleep. `waitForBudget` itself is exercised by o3d-wahn's own tests; what is new here, and
  // what this pins, is that its refusals carry the tag and that they sit above the socket.
  const api = readFileSync('lib/connectors/xero/api.ts', 'utf8')
  const perform = api.slice(api.indexOf('async function performRequest('))

  // ALL FOUR budget returns, and there are exactly four: the two idempotency-window bounds and the
  // two `waitForBudget` arms. Each is built through `markNotSent`, which is what applies the
  // per-call guard — none of them may hand back a bare object.
  const tagged = perform.match(/markNotSent\('rate-budget-refused'/g) ?? []
  assert.equal(tagged.length, 3,
    'the two budget-response builders and the day-cap return are all tagged; the two builders cover '
    + 'both bounds, so three sites cover all four refusals')
  // ...and every 429 that can be produced ABOVE the socket is one of them. Counted rather than
  // pattern-matched: a new untagged pre-egress 429 raises the first number without the second, and a
  // tag applied to one of the POST-egress 429s (which is the widening this must not permit) raises
  // the second without the first.
  const aboveSocket = perform.slice(0, perform.indexOf('noteRequest(auth.tenantId)'))
  assert.equal((aboveSocket.match(/status: 429/g) ?? []).length, 3,
    'exactly three 429-producing sites sit above the socket')
  assert.equal((aboveSocket.match(/markNotSent\('rate-budget-refused'/g) ?? []).length, 3,
    'and every one of them is tagged')

  // AND THEY ARE ALL ABOVE `noteRequest`, which is what makes them provable. Every budget refusal is
  // reached from the top of the retry loop or from the pre-send re-read, both of which return before
  // the counter is bumped — the transport counts an ATTEMPT, and a refused attempt is not one.
  const budgetCheck = perform.indexOf('const remainingAtSend = budgetRemainingMs()')
  const note = perform.indexOf('noteRequest(auth.tenantId)')
  const fetchCall = perform.indexOf('await connectorFetch(url, init,')
  assert.ok(budgetCheck > -1 && note > budgetCheck && fetchCall > note,
    'the last budget bound is checked, then the attempt is counted, then the socket is used')

  // And the decision treats that member exactly as it treats the other three.
  assert.equal(verdictFor({ reachedTheWire: false, notSent: 'rate-budget-refused' }).release, true)
})

/* ------------------------------------------------------------------------------------------------
 * THE NEGATIVE HALF, WHICH IS THE LOAD-BEARING ONE.
 *
 * Each of these is a case where the request MAY HAVE ARRIVED. Each must KEEP the marker, and each is
 * written so that widening the release to cover it turns this test red.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-gvzu: a TIMEOUT keeps the marker — it is an answer that did not arrive, not a refusal to send', async () => {
  reset()
  fetchAnswers = [{ status: 0, throws: Object.assign(new Error('Xero request timed out after 30000ms'), { name: 'TimeoutError' }) }]

  // MUTATION THAT KILLS THIS TEST: converting a `connectorFetch` throw into a not-sent refusal —
  // catching it and returning a tagged `status: 0` response, or tagging on the error's name. Under
  // that change the post no longer rejects and this assertion fails first.
  await assert.rejects(postOne(), /timed out/,
    'a timeout must propagate as an ordinary error, never be laundered into "nothing was sent"')

  // And the reason it must: the request had already been handed to the socket. `noteRequest` runs on
  // the statement before `connectorFetch`, so the attempt is counted even though no reply came back.
  assert.equal(wireCalls.length, 1, 'the request WAS handed to the transport')

  // The decision, on the outcome such a call produces if a caller ever builds one from it.
  const verdict = verdictFor({ reachedTheWire: true, notSent: undefined })
  assert.equal(verdict.release, false, 'THE POINT: no proof, no release')
  assert.equal(verdict.release === false ? verdict.refusal : null, 'no-proof-the-request-did-not-leave')
})

test('o3d-gvzu: a socket RESET MID-WRITE keeps the marker — the body may already be in Xero', async () => {
  reset()
  // Thrown from INSIDE `connectorFetch`, after the request has been handed over: the bytes may have
  // been written and the peer may have processed them before the connection died.
  fetchAnswers = [{ status: 0, throws: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }]

  // MUTATION THAT KILLS THIS TEST: the same widening as above — any rule that reads a transport
  // EXCEPTION as proof of non-delivery. `ECONNRESET` is the most tempting of them, because it sounds
  // like a connection that never worked; mid-write it is the opposite.
  await assert.rejects(postOne(), /ECONNRESET/,
    'a reset must propagate as an ordinary error — mid-write, the peer may already have the body')
  assert.equal(wireCalls.length, 1, 'and the request WAS handed to the transport')

  const verdict = verdictFor({ reachedTheWire: true, notSent: undefined })
  assert.equal(verdict.release, false, 'THE POINT: no proof, no release')
})

test('o3d-gvzu: a 5xx keeps the marker — Xero answered, so Xero was asked', async () => {
  reset()
  fetchAnswers = [{ status: 503, body: { Message: 'Service Unavailable' } }]

  const result = await postOne()

  assert.equal(result.success, false)
  assert.equal(wireCalls.length, 1, 'a real request was made')
  assert.equal(result.reachedTheWire, true)
  // MUTATION THAT KILLS THIS TEST: any widening that treats a failed post with no document as proof
  // — `release = !posted.success`, `release = posted.journalId === undefined`, or inferring a reason
  // from `status >= 500`. All three make `notSent` present here and this assertion fails.
  assert.equal(result.notSent, undefined,
    'THE POINT: a 5xx carries no proof of non-delivery — the journal may have been created and the '
    + 'failure be in what came back')
  const verdict = verdictFor(result)
  assert.equal(verdict.release, false)
  assert.equal(verdict.release === false ? verdict.refusal : null, 'no-proof-the-request-did-not-leave')
})

test('o3d-gvzu: a 400 from Xero keeps the marker too — the control that stops "call everything unsent"', async () => {
  reset()
  fetchAnswers = [{ status: 400, body: { Message: 'Account code 800 is not valid for this document' } }]

  const result = await postOne()

  assert.equal(result.reachedTheWire, true)
  assert.equal(result.notSent, undefined)
  assert.equal(verdictFor(result).release, false)
})

test('o3d-gvzu: a refusal AFTER an attempt has already gone out is NOT proof about that attempt', async () => {
  // THE PER-CALL GUARD, and the sharpest form of the defect class this issue belongs to. The egress
  // authorisation is re-evaluated on EVERY retry attempt. If Xero 429s the first attempt and the
  // authorisation then refuses the second, the refusal is genuinely pre-egress for the second attempt
  // and says nothing whatever about the first — which has already been sent.
  reset()
  fetchAnswers = [{ status: 429, retryAfter: '0' }]
  onFetch = () => { egressRefusal = 'This connection is not authorised to write' }

  const result = await postOne()

  assert.equal(result.success, false)
  assert.equal(wireCalls.length, 1, 'the first attempt really did go out')
  assert.equal(result.reachedTheWire, true, 'so the call as a whole reached the wire')
  // MUTATION THAT KILLS THIS TEST: dropping the `firstCallAt === null` guard from `markNotSent`, so
  // the tag is attached wherever the refusal happens to be evaluated. Under that change this comes
  // back as 'egress-unauthorised' and the marker is released over a request that was sent.
  assert.equal(result.notSent, undefined,
    'THE POINT: a per-attempt refusal below an attempt that already left is not proof about it')
  assert.equal(verdictFor(result).release, false)
})

/* ------------------------------------------------------------------------------------------------
 * AND THE PROOF IS ABOUT THIS ATTEMPT'S REQUEST, SO IT ONLY RELEASES THIS ATTEMPT'S MARKER.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-gvzu: a REPLAY of an earlier dispatch may not release it, however good its own proof', async () => {
  // The replay arm exists precisely because the earlier request MIGHT have reached Xero — that is
  // what makes re-sending the same key safe inside the window. So proving that THIS request never
  // left says nothing about the one the marker records.
  const proven = { reachedTheWire: false, notSent: 'no-connection' }

  const replay = decideCreateDispatchRelease({ basis: 'replay-within-idempotency-window', outcome: proven })
  // MUTATION THAT KILLS THIS TEST: dropping the basis gate — `release = notSent !== undefined &&
  // !reachedTheWire` alone. Under it a replay releases a marker whose dispatch may be in the ledger,
  // and the next attempt posts a second journal on top of it.
  assert.equal(replay.release, false)
  assert.equal(replay.release === false ? replay.refusal : null, 'marker-is-not-this-attempts')

  const upsert = decideCreateDispatchRelease({ basis: 'natural-key-upsert', outcome: proven })
  assert.equal(upsert.release, false, 'and a type whose marker gates nothing gains no permission either')

  // The two that may, and they are the two whose marker this attempt can speak for.
  for (const basis of ['first-dispatch', 'released-nothing-left-the-process'] as CreateDispatchBasis[]) {
    assert.equal(mayReleaseCreateDispatch(basis), true, basis)
    assert.equal(decideCreateDispatchRelease({ basis, outcome: proven }).release, true, basis)
  }
})

test('o3d-gvzu: BOTH measurements are required — neither alone licenses a release', async () => {
  // They fail in opposite directions and are checked as a conjunction for that reason. A tag without
  // a quiet counter is a site that mislabelled itself; a quiet counter without a tag is every case in
  // the negative half above.
  assert.equal(
    decideCreateDispatchRelease({
      basis: 'first-dispatch', outcome: { reachedTheWire: true, notSent: 'egress-unauthorised' },
    }).release,
    false,
    'a tag on a call that DID reach the wire is not proof',
  )
  assert.equal(
    decideCreateDispatchRelease({
      basis: 'first-dispatch', outcome: { reachedTheWire: false, notSent: undefined },
    }).release,
    false,
    'and a quiet counter with no named refusal is not proof either',
  )
})

/* ------------------------------------------------------------------------------------------------
 * AN ENUMERATION OF RETURNS IS NOT AN ENUMERATION OF EXITS (o3d-2w2j r2, Codex HIGH).
 *
 * Round 1 enumerated the ways a pre-egress statement can RETURN a refusal and proved each from where
 * it sits. A statement can also leave by THROWING, and none of those exits was named: the exception
 * escaped the transport, the poster produced neither an outcome nor a reason, and the processor's
 * ordinary failure path took the row with the dispatch marker still standing. Once the replay window
 * closed the row was permanently refused for a create that provably never reached the transport —
 * the original wedge, through a door the enumeration had not counted.
 *
 * EVERY TEST BELOW GOES BY THE REAL ROUTE. `postOne()` is the manual-journal poster over the real
 * `journals.ts` and the real `api.ts`; only the four edges are doubled. The control at the top of the
 * first test proves that route really does reach the socket when nothing is arranged, so a run that
 * stops short stopped at the statement the test arranged and not somewhere incidental.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-2w2j r2: a resolver that THROWS releases the marker — the wedge through the unenumerated door', async () => {
  // ROUTE PROOF FIRST. Nothing arranged: this exact helper travels journals.ts -> xeroPost ->
  // xeroFetch -> getAccessToken -> xeroFetchWithAuth -> performRequest -> connectorFetch, and lands.
  reset()
  const control = await postOne()
  assert.equal(control.success, true, 'the unarranged route really does reach Xero')
  assert.equal(wireCalls.length, 1, 'and it reaches the socket, so the route under test is the real one')

  reset()
  authThrows = new Error('Failed to decrypt the stored Xero refresh token')

  // MUTATION THAT KILLS THIS TEST: delete the try/catch around `getAccessToken()` in `xeroFetch`
  // (restoring `const auth = await getAccessToken()`). The rejection then propagates out of the post
  // and this line throws instead of returning — which is exactly the pre-fix behaviour, and exactly
  // what left the marker standing.
  const result = await postOne()

  assert.equal(result.success, false, 'the post fails')
  assert.deepEqual(wireCalls, [], 'and provably nothing left the process — the resolver never answered')
  assert.equal(result.reachedTheWire, false, 'the quiet counter agrees')
  assert.match(result.error ?? '', /decrypt the stored Xero refresh token/,
    'the route is the RESOLVER: its own exception is what is being reported')
  assert.equal(result.notSent, 'connection-unresolvable',
    'THE POINT: the throwing exit of the resolver is a NAMED member, distinct from the null it '
    + 'already had')

  const verdict = verdictFor(result)
  assert.equal(verdict.release, true, 'so the marker is released and the row is not wedged')
  assert.equal(verdict.release === true ? verdict.notSent : null, 'connection-unresolvable',
    'and the release records WHICH exit licensed it')
})

test('o3d-2w2j r2: the two authorisations name their throwing exit too, and both release', async () => {
  // THE SWEEP, not just the reported statement. Both of these sit BELOW the dispatch marker and
  // ABOVE the socket, and both can leave by throwing: the posting-intent verdict is computed from a
  // stored payload and its provenance stamps, and the egress `authorize` callbacks read AND WRITE the
  // database and one of them takes an exclusive slot.
  const cases: Array<[string, string, () => void]> = [
    ['posting intent', 'posting-intent-unavailable',
      () => { intentThrows = new Error('connection provenance for this row will not deserialise') }],
    ['egress authorisation', 'egress-authorisation-unavailable',
      () => { egressThrows = new Error('canceling statement due to lock timeout') }],
  ]

  for (const [name, expected, arrange] of cases) {
    reset()
    arrange()

    // MUTATION THAT KILLS THIS TEST: remove either try/catch in `performRequest`. The throw then
    // leaves the transport and `await postOne()` rejects, so this line fails before any assertion.
    const result = await postOne()

    assert.equal(result.success, false, `${name}: the post fails`)
    assert.deepEqual(wireCalls, [], `${name}: and nothing left the process`)
    assert.equal(result.reachedTheWire, false, `${name}: the counter says so`)
    assert.match(result.error ?? '', /lock timeout|will not deserialise/,
      `${name}: and the reported cause is the exception from THAT statement, not a generic failure`)
    assert.equal(result.notSent, expected, `THE POINT (${name}): the throwing exit names itself`)
    assert.equal(verdictFor(result).release, true, `${name}: so the marker may be released`)
  }
})

test('o3d-2w2j r2: a request that cannot be BUILT never reaches the transport, by either route', async () => {
  // The two statements between a resolved auth and `performRequest` that can throw. Driven through
  // the exported transport rather than the journal poster, because that is where they live: the
  // manual-journal body is validated above the fence and cannot reach either of them.
  const { xeroGet, xeroPost } = await import('@/lib/connectors/xero/api')

  // ROUTE 1 — the `If-Modified-Since` header. `formatIfModifiedSince` calls `toISOString()`, which
  // answers a RangeError for an unparseable date.
  reset()
  const header = await xeroGet('Invoices', { ifModifiedSince: new Date('the thirty-first of Octember') })
  assert.deepEqual(wireCalls, [], 'header route: nothing left the process')
  assert.equal(header.notSent, 'request-unbuildable',
    'THE POINT: the header formatter throws ABOVE performRequest, so it is a named pre-egress exit')

  // ROUTE 2 — the body. `JSON.stringify` throws on a cycle.
  reset()
  const cyclic: Record<string, unknown> = { Narration: 'COGS' }
  cyclic.self = cyclic
  // MUTATION THAT KILLS THIS TEST: drop the try/catch around the request-construction block in
  // `xeroFetchWithAuth`. Both calls then reject and neither `await` returns.
  const serialised = await xeroPost('ManualJournals', cyclic)
  assert.deepEqual(wireCalls, [], 'body route: nothing left the process')
  assert.equal(serialised.notSent, 'request-unbuildable', 'and the same member covers it')
  assert.equal(serialised.tenantId !== undefined, true,
    'the auth WAS resolved here — which is what makes this a different exit from the resolver one')

  assert.equal(verdictFor({ reachedTheWire: false, notSent: 'request-unbuildable' }).release, true)
})

test('o3d-2w2j r2: the new members change NOTHING about a throw from the socket', async () => {
  // THE CONTROL FOR THE WHOLE SWEEP. Five throwing exits are now tagged; the one that must never be
  // is the transport's own. `connectorFetch` is called outside every catch added by this round, and
  // this is what says so behaviourally rather than by reading the file.
  reset()
  fetchAnswers = [{ status: 0, throws: new Error('socket hang up') }]

  // MUTATION THAT KILLS THIS TEST: widening any of the new catches to enclose `connectorFetch` — for
  // example wrapping the whole retry loop, or moving the egress catch's closing brace below the send.
  // Under that change this stops rejecting and the marker is released over a request that was sent.
  await assert.rejects(postOne(), /socket hang up/,
    'an exception from the socket propagates untagged, exactly as before')
  assert.equal(wireCalls.length, 1, 'and it was the socket, because the request was handed to it')
})

test('o3d-2w2j r2: a throwing exit on a REPLAY still may not release — the basis gate is untouched', async () => {
  // The new members are proof about THIS attempt's request, and nothing more. A replay of an earlier
  // dispatch's key may still not release, because that earlier request might have reached Xero.
  for (const notSent of ['connection-unresolvable', 'request-unbuildable', 'posting-intent-unavailable',
    'rate-budget-unavailable', 'egress-authorisation-unavailable']) {
    const replay = decideCreateDispatchRelease({
      basis: 'replay-within-idempotency-window', outcome: { reachedTheWire: false, notSent },
    })
    assert.equal(replay.release, false, notSent)
    // ...and the conjunction's other half holds for them too.
    assert.equal(
      decideCreateDispatchRelease({ basis: 'first-dispatch', outcome: { reachedTheWire: true, notSent } }).release,
      false,
      `${notSent}: a tag on a call that DID reach the wire is still not proof`,
    )
  }
})

/* ------------------------------------------------------------------------------------------------
 * THE ENUMERATION IS AN ENUMERATION, NOT A PREDICATE OVER ERROR SHAPES.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-gvzu: the tag is written at the refusal sites and never inferred downstream', async () => {
  const api = readFileSync('lib/connectors/xero/api.ts', 'utf8')
  const journals = readFileSync('lib/connectors/xero/journals.ts', 'utf8')
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')

  // Exactly nine members, so adding a tenth is a deliberate act that has to be argued for. FOUR
  // RETURNS and FIVE THROWS, and the pairing is the argument (o3d-2w2j r2): every pre-request
  // statement that can hand back a refusal can also leave by throwing, and the first round counted
  // only the first kind. Any new member has to name the statement it is written at and say where
  // that statement sits relative to the socket.
  const members = api
    .slice(api.indexOf('export type XeroNotSentReason ='), api.indexOf('const XERO_NOT_SENT_REASON'))
    .match(/'[a-z-]+'/g) ?? []
  assert.deepEqual(members, [
    "'no-connection'", "'posting-intent-refused'", "'egress-unauthorised'", "'rate-budget-refused'",
    "'connection-unresolvable'", "'request-unbuildable'", "'posting-intent-unavailable'",
    "'rate-budget-unavailable'", "'egress-authorisation-unavailable'",
  ])
  assert.ok(!/'timeout'|'reset'|'5xx'|'server-error'|'unknown'/.test(api),
    'there must be no member for a case where the request may have arrived')

  // ...and each throwing member is written at ONE catch, never two. Two sites for one member is how
  // a tag stops being provable from where a statement sits.
  for (const member of ['posting-intent-unavailable', 'rate-budget-unavailable',
    'egress-authorisation-unavailable']) {
    assert.equal((api.match(new RegExp(`markNotSent\\('${member}'`, 'g')) ?? []).length, 1, member)
  }

  // NO TAG IS WRITTEN BELOW THE SOCKET. `markNotSent` is the only thing that attaches one inside
  // `performRequest`, and every one of its call sites is above `noteRequest` — which is the statement
  // before `connectorFetch`. The behavioural control for this is the socket-throw test above; this
  // makes a new site below the line fail loudly rather than silently.
  const perform = api.slice(api.indexOf('async function performRequest('))
  const belowTheLine = perform.slice(perform.indexOf('noteRequest(auth.tenantId)'))
  assert.equal((belowTheLine.match(/markNotSent\(/g) ?? []).length, 0,
    'no refusal may be tagged at or after the statement that counts an attempt')

  // The guard that makes every tag per-call rather than per-refusal.
  assert.match(api, /firstCallAt === null \? Object\.assign\(res, \{ \[XERO_NOT_SENT_REASON\]: reason \}\)/)

  // The tag travels; it is never reconstructed. `journals.ts` must carry `res.notSent` through
  // untouched rather than deriving one from the status, the counter or the prose.
  assert.match(journals, /notSent: res\.notSent,/)
  assert.ok(!/notSent: .*(reachedTheWire|status|error)/.test(journals),
    'the post must not infer a reason from anything it can see')

  // And the branch decides through the one pure function, on the outcome, with no shape test.
  const branch = processor.slice(
    processor.indexOf("const idempotencySource = typeof payload._idempotencyKey === 'string'"),
    processor.indexOf("case 'TAX_RATE_SYNC': {"),
  )
  assert.match(branch, /decideCreateDispatchRelease\(\{ basis: dispatch\.basis, outcome: posted \}\)/)
  assert.ok(!/posted\.error\?\.|status ===|\.includes\(/.test(branch),
    'the branch must not read the reason out of a status code or an error string')
})
