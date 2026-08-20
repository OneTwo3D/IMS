import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import {
  accountingRetryDuplicateCaution,
  isWithinXeroIdempotencyWindow,
  XERO_IDEMPOTENCY_KEY_RETENTION_MS,
  XERO_IDEMPOTENCY_RETENTION_DOC_URL,
} from '../../lib/domain/accounting/idempotency-retention.ts'

/**
 * o3d-wahn: the window was never established, so "re-queueing is safe because the key is
 * deterministic" was an argument with a missing premise. It is established now, and it is SIX
 * MINUTES — short enough that the conclusion does not follow for any manual retry.
 */

test('o3d-wahn: Xero keeps an idempotency key for six minutes, which is the whole finding', () => {
  assert.equal(XERO_IDEMPOTENCY_KEY_RETENTION_MS, 6 * 60 * 1000,
    'the vendor documentation says "keys are stored for 6 minutes from the time of the first call"')
  assert.match(XERO_IDEMPOTENCY_RETENTION_DOC_URL, /^https:\/\/developer\.xero\.com\//,
    'and the claim cites where it came from, so it can be re-checked rather than trusted')
})

test('o3d-wahn: the window is measured from the attempt, and closes exactly on the bound', () => {
  const now = new Date('2026-08-19T12:00:00.000Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo)

  assert.equal(isWithinXeroIdempotencyWindow(at(0), now), true, 'an attempt this instant')
  assert.equal(isWithinXeroIdempotencyWindow(at(XERO_IDEMPOTENCY_KEY_RETENTION_MS - 1), now), true,
    'one millisecond inside the window')
  assert.equal(isWithinXeroIdempotencyWindow(at(XERO_IDEMPOTENCY_KEY_RETENTION_MS), now), false,
    'and on the bound the key is gone — the boundary is not "about six minutes"')
  assert.equal(isWithinXeroIdempotencyWindow(at(60 * 60 * 1000), now), false, 'an hour-old row, which is the ordinary case')
})

test('o3d-wahn: an unknown attempt time is OUTSIDE the window, never inside it', () => {
  // "We do not know when this was posted" must not read as "it is safe to post again". A row with no
  // processingStartedAt has no attempt to be idempotent about.
  const now = new Date('2026-08-19T12:00:00.000Z')
  assert.equal(isWithinXeroIdempotencyWindow(null, now), false)
  assert.equal(isWithinXeroIdempotencyWindow(undefined, now), false)
  assert.equal(isWithinXeroIdempotencyWindow('not a date', now), false)
  assert.equal(isWithinXeroIdempotencyWindow(new Date(now.getTime() + 1000), now), false,
    'and a stamp in the future is a broken clock, not a fresh key')
})

test('o3d-wahn: the caution is offered for Xero and WITHHELD where no window was established', () => {
  const xero = accountingRetryDuplicateCaution('xero')
  assert.ok(xero, 'the Xero retry controls say what a retry costs')
  assert.match(xero!, /6 minutes/, 'and quote the window rather than gesturing at "may create duplicates"')
  assert.match(xero!, /SECOND document/, 'naming the actual consequence in the ledger')
  assert.match(xero!, /Check Xero/, 'and the check the operator has to make instead')

  // QuickBooks' RequestId window is unverified. A caution quoting an invented number would be worse
  // than none, because it would be believed.
  assert.equal(accountingRetryDuplicateCaution('quickbooks'), null)
  assert.equal(accountingRetryDuplicateCaution(null), null)
  assert.equal(accountingRetryDuplicateCaution(undefined), null)
})

/**
 * Round 2, finding 1 — THE SAME ARITHMETIC CONDEMNS THE AUTOMATIC PATH.
 *
 * Round 1 established the window and then reasoned only about the button a human presses. But six
 * minutes is not a fact about humans: the retries a WORKER schedules are minutes apart too.
 *
 * ROUND 3, FINDING 4 — AND ROUND 2'S TESTS PROVED NEITHER BOUND IT CLAIMED. They multiplied
 * XERO_MAX_RETRIES by XERO_MAX_RETRY_AFTER_MS, called the product "the in-request retry", and compared
 * it to the window. THE PRODUCT IS NOT THE LOOP: `performRequest` awaits `waitForBudget` before EVERY
 * attempt as well, and a minute-limit wait there sleeps up to 60s, so the real worst case is
 * 3 x 90s + 3 x 60s = 450s — OUTSIDE the six minutes the comment claimed it was inside. The other test
 * added a made-up 60_000 to DEFAULT_RETRY_BASE_DELAY_MS until the inequality came out true, which
 * establishes nothing about when a queued retry actually lands.
 *
 * So both bounds are now taken from the code that produces them: the first by DRIVING the retry loop
 * and timing its attempts, the second by asking the real backoff calculator for its real extremes.
 */

/** Let queued microtasks run without letting real time pass. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/**
 * Advance the MOCKED clock until `isDone()`, or give up. Bounded on purpose: a reverted budget check
 * must fail this test, and a test that waits for ever instead of failing has proved nothing.
 */
async function runClock(isDone: () => boolean, stepMs = 1_000, maxSteps = 1_200) {
  for (let step = 0; step < maxSteps && !isDone(); step++) {
    await settle()
    if (!isDone()) mock.timers.tick(stepMs)
  }
  await settle()
}

let currentTenantId = 'tenant-unset'
let connectorFetchHandler: (url: string, init: RequestInit) => Promise<Response> = async () => {
  throw new Error('no connectorFetch handler installed')
}

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => ({ accessToken: 'test-token', tenantId: currentTenantId }),
    getStoredTenantBlockReason: async () => null,
    getGrantedScopes: async () => [],
  },
})

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: (url: string, init: RequestInit) => connectorFetchHandler(url, init),
  },
})

test('o3d-wahn r3 #4: the in-request retry loop is MEASURED, and it stays inside the window', async (t) => {
  currentTenantId = 'tenant-retry-loop'
  const { xeroGet, XERO_IN_REQUEST_RETRY_BUDGET_MS, XERO_MAX_RETRIES } = await import('@/lib/connectors/xero/api')

  const attemptsAt: number[] = []
  connectorFetchHandler = async () => {
    attemptsAt.push(Date.now())
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '90' } })
  }

  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())

  let done = false
  const call = xeroGet('Invoices').then((result) => { done = true; return result })
  await runClock(() => done)

  assert.equal(done, true, 'the call finished rather than blocking for ever on Retry-After')
  const response = await call
  assert.equal(response.ok, false)
  assert.equal(attemptsAt.length, XERO_MAX_RETRIES + 1,
    'one attempt plus XERO_MAX_RETRIES, which is what the loop is written to do')

  // THE BOUND, measured from the first HTTP call — which is where Xero starts the key's clock.
  const spanMs = attemptsAt[attemptsAt.length - 1] - attemptsAt[0]
  // STRICT (o3d-xl63 r5 #3). `<=` accepted the boundary, and the boundary is not inside the window:
  // `isWithinXeroIdempotencyWindow` is `age < RETENTION`, so an attempt sent at exactly six minutes is
  // one this repository's own predicate calls expired. An assertion that admits the failing case is
  // not a bound.
  assert.ok(
    spanMs < XERO_IN_REQUEST_RETRY_BUDGET_MS,
    `the last in-request attempt went out ${spanMs}ms after the first, at or past the `
      + `${XERO_IN_REQUEST_RETRY_BUDGET_MS}ms Xero remembers the Idempotency-Key for`,
  )
  assert.deepEqual(
    attemptsAt.map((at) => at - attemptsAt[0]), [0, 90_000, 180_000, 270_000],
    'and the schedule is the real one: three Retry-After sleeps of 90s, not a product of two constants',
  )

  // Round 2's arithmetic, kept but correctly LABELLED: this is the Retry-After leg alone, and it is a
  // tripwire on two constants, not the bound. It is why the budget check on that leg is defensive
  // today — the leg that can actually exhaust the budget is the minute-limit wait, driven below.
  const { XERO_MAX_RETRY_AFTER_MS } = await import('@/lib/connectors/xero/api')
  assert.ok(
    XERO_MAX_RETRIES * XERO_MAX_RETRY_AFTER_MS < XERO_IN_REQUEST_RETRY_BUDGET_MS,
    'raise either constant and the Retry-After sleeps alone can leave the window — at which point the '
      + 'budget check on that leg stops being defensive and starts firing',
  )
})

test('o3d-wahn r3 #4: the minute-limit wait — the leg round 2 forgot — answers to the same budget', async (t) => {
  currentTenantId = 'tenant-minute-budget'
  const { xeroGet, waitForBudget, XERO_IN_REQUEST_RETRY_BUDGET_MS } = await import('@/lib/connectors/xero/api')
  void XERO_IN_REQUEST_RETRY_BUDGET_MS

  connectorFetchHandler = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())

  // Fill this tenant's minute bucket to the limit, using real calls, so the wait under test is a real
  // wait rather than a state a test asserted into existence.
  // No clock ticks here: while the bucket is under the limit these calls take no wait at all, so the
  // 55 timestamps all land on the same instant — which is what makes the wait below a full minute.
  for (let i = 0; i < 55; i++) await xeroGet('Organisation')

  // 1. A wait that will not fit the remaining window is REFUSED, and refused WITHOUT SLEEPING: the
  //    assertion runs before any tick, so a reverted budget check fails here immediately instead of
  //    hanging the run.
  type BudgetOutcome = Awaited<ReturnType<typeof waitForBudget>>
  const refusals: BudgetOutcome[] = []
  void waitForBudget(currentTenantId, 30_000).then((result) => { refusals.push(result) })
  await settle()
  assert.equal(refusals.length, 1,
    'it answered without sleeping, because the wait it wanted does not fit the budget')
  const refusal = refusals[0]
  assert.equal(refusal.ok, false)
  assert.equal(refusal.ok === false && refusal.reason, 'budget')
  assert.equal(refusal.ok === false && refusal.waitMs, 60_000,
    'and it says how long it would have slept: a full minute')

  // 2. The refusal is not vacuous: with no budget imposed, the SAME state really does sleep a minute.
  //    Without this, a helper that refused everything would pass part 1 just as well.
  const startedAt = Date.now()
  const allowed: BudgetOutcome[] = []
  void waitForBudget(currentTenantId).then((result) => { allowed.push(result) })
  await settle()
  assert.equal(allowed.length, 0, 'unbudgeted, it is asleep on the minute limit')
  await runClock(() => allowed.length > 0, 1_000, 120)
  assert.equal(allowed[0]?.ok, true)
  assert.equal(Date.now() - startedAt, 60_000, 'having slept exactly the minute the refusal declined to spend')
})

test('o3d-wahn r3 #4: what a QUEUED retry is worth, from the real backoff calculator', async () => {
  const { calculateIntegrationOutboxRetryDelayMs, DEFAULT_RETRY_BASE_DELAY_MS } =
    await import('@/lib/domain/integrations/outbox')

  // The real extremes of the real function: jitter is tail-only, so random()=0 is the floor and
  // random()=1 the ceiling. Nothing here is restated arithmetic — these are the delays production
  // schedules with.
  const firstFloor = calculateIntegrationOutboxRetryDelayMs({ attemptsBeforeFailure: 0, random: () => 0 })
  const firstCeiling = calculateIntegrationOutboxRetryDelayMs({ attemptsBeforeFailure: 0, random: () => 1 })
  const secondFloor = calculateIntegrationOutboxRetryDelayMs({ attemptsBeforeFailure: 1, random: () => 0 })

  assert.equal(firstFloor, DEFAULT_RETRY_BASE_DELAY_MS, 'the first retry is never sooner than the base delay')
  assert.ok(firstCeiling > firstFloor, 'and jitter only ever pushes it later')

  // THE HONEST BOUND, and it is not the one round 2 claimed. The first queued retry can land at
  // 300s — INSIDE the six-minute window — when jitter is minimal and the failed call was quick. So
  // "a queued retry lands outside the window" is FALSE as a universal claim, and asserting it with a
  // hand-added 60_000 was the tripwire admitting as much.
  assert.ok(firstFloor < XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    'the earliest first retry is inside the window, so the window cannot be what makes it safe or unsafe')
  assert.equal(isWithinXeroIdempotencyWindow(new Date(Date.now() - firstFloor)), true,
    'stated the other way round: a row whose attempt was one floor-delay ago is still inside')

  // What IS provable is that nothing keeps it there. The ceiling alone does not clear the window, but
  // the elapsed time Xero measures also includes the failed call itself — and that call may have spent
  // the whole in-request budget before failing.
  const { XERO_IN_REQUEST_RETRY_BUDGET_MS } = await import('@/lib/connectors/xero/api')
  assert.ok(
    firstCeiling + XERO_IN_REQUEST_RETRY_BUDGET_MS > XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    'measured from the first call, a slow failure plus a jittered backoff is already past the window',
  )

  // And from the second retry on it is not arguable at all: the floor alone clears the window.
  assert.ok(
    secondFloor > XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    'from the second automatic retry the key has certainly expired and the re-post is a NEW request',
  )
  assert.equal(isWithinXeroIdempotencyWindow(new Date(Date.now() - secondFloor)), false)

  // The conclusion the module has to state: a protection you cannot tell is present is not one you may
  // rely on. Whether a queued retry still has its key is UNDETERMINED at the floor and gone above it,
  // so nothing may be built on it either way.
  assert.notEqual(
    isWithinXeroIdempotencyWindow(new Date(Date.now() - firstFloor)),
    isWithinXeroIdempotencyWindow(new Date(Date.now() - secondFloor)),
    'the two automatic retries fall on opposite sides of the window — the schedule does not respect it',
  )
})

test('o3d-wahn r2: the module says plainly what protects an automatic retry instead', () => {
  // The obligation this round is honesty, and the deliverable is prose — so the prose is the thing
  // under test. It must name the local record (the real protection), and must not leave the reader
  // with a remote guarantee that expired before the retry was scheduled.
  const source = readFileSync(new URL('../../lib/domain/accounting/idempotency-retention.ts', import.meta.url), 'utf8')
  assert.match(source, /AUTOMATIC PATH IS NO BETTER/,
    'the automatic path is addressed, not just the button an operator presses')
  assert.match(source, /externalTransactionId/,
    'and points at the local record that actually short-circuits the next attempt')
  assert.match(source, /NOTHING[\s*]+PREVENTS the duplicate/,
    'and says plainly that once that record is lost nothing prevents the duplicate')
  assert.match(source, /settlement-status\.ts|settlementStatus/,
    'naming the detective control that is left, rather than implying a preventive one')

  // r3 #4: the two claims round 2 could not support must not survive as prose either. The in-request
  // bound is now enforced, and the queued-retry claim is corrected rather than repeated.
  assert.match(source, /XERO_IN_REQUEST_RETRY_BUDGET_MS/,
    'the in-request bound is named as an enforced budget, not asserted as a product of two constants')
  assert.doesNotMatch(source, /the first retry sits at or past the six-minute line/,
    'the queued-retry claim round 2 could not prove — and which the real floor contradicts — is gone')
  assert.match(source, /A PROTECTION YOU CANNOT TELL IS PRESENT IS NOT ONE YOU MAY RELY ON/,
    'and what replaces it is a statement an operator can act on')
})

test('o3d-wahn r2: the runbook covers the automatic retries too', () => {
  const doc = readFileSync(new URL('../../help-docs/xero-sync.md', import.meta.url), 'utf8')
  assert.match(doc, /The same is true of the AUTOMATIC retries/,
    'an operator reading only the runbook must not think the queue is protected while the button is not')
  assert.match(doc, /update-or-create on `InvoiceNumber`/,
    'and it distinguishes the one operation that IS protected, by Xero\'s semantics rather than by the key')
  assert.match(doc, /nothing\s+prevents a duplicate/i,
    'and states the unprotected case rather than leaving it to be inferred')
})

test('o3d-wahn: the operator documentation records the same window as the code', () => {
  // The constant and the runbook are two statements of one fact, and the fact is the deliverable here.
  const doc = readFileSync(new URL('../../help-docs/xero-sync.md', import.meta.url), 'utf8')
  assert.match(doc, /stored for 6\n?> ?minutes|stored for 6 minutes/,
    'the vendor sentence is quoted, so a reader can see it is not our estimate')
  assert.ok(doc.includes(XERO_IDEMPOTENCY_RETENTION_DOC_URL.replace(/\/$/, '')),
    'and links the page it came from')
  assert.match(doc, /manual retry is therefore a new request/i,
    'and states the consequence for the control the operator actually presses')
})


/**
 * o3d-xl63 ROUND 5, FINDING 3 — THE BUDGET WAS NOT STRICT, AT EITHER END.
 *
 * `waitForBudget` refused a wait only when it was strictly LONGER than what was left, so a wait
 * exactly as long as the remainder was taken — landing the next attempt ON six minutes. And having
 * taken it, `performRequest` never looked at the clock again before sending: it decided from the wait
 * it INTENDED, not the time that actually passed, so a timer that woke late sent the attempt later
 * still with nothing to notice.
 *
 * Both cases send a request Xero treats as NEW — `isWithinXeroIdempotencyWindow` is `age < RETENTION`
 * — which is exactly how an in-request retry stops being a retry and becomes a second document.
 */

test('r5 #3: a wait exactly as long as what is left is REFUSED, because the boundary is already outside', async (t) => {
  currentTenantId = 'tenant-exact-boundary'
  const { xeroGet, waitForBudget } = await import('@/lib/connectors/xero/api')

  connectorFetchHandler = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())

  // Fill the minute bucket with real calls, so the 60s wait under test is one the real limiter wants
  // to take rather than a state asserted into existence.
  for (let i = 0; i < 55; i++) await xeroGet('Organisation')

  type BudgetOutcome = Awaited<ReturnType<typeof waitForBudget>>
  const outcomes: BudgetOutcome[] = []
  // EXACTLY the wait it wants: 60,000ms of budget against a 60,000ms minute-limit wait.
  void waitForBudget(currentTenantId, 60_000).then((result) => { outcomes.push(result) })
  await settle()

  assert.equal(outcomes.length, 1,
    'it answered WITHOUT sleeping — taking this wait would put the next attempt on the deadline, where '
      + 'the key is already gone')
  const outcome = outcomes[0]
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.reason, 'budget',
    'and it is the budget that refused it, not the day limit')
  assert.equal(outcome.ok === false && outcome.waitMs, 60_000)

  // Not vacuous: one millisecond more of budget and the same state really does sleep.
  const allowed: BudgetOutcome[] = []
  void waitForBudget(currentTenantId, 60_001).then((result) => { allowed.push(result) })
  await settle()
  assert.equal(allowed.length, 0, 'with the wait strictly inside the budget it is asleep, not refusing')
  await runClock(() => allowed.length > 0, 1_000, 120)
  assert.equal(allowed[0]?.ok, true)
})

test('r5 #3: an OVERSLEPT timer cannot smuggle an attempt out past the window', async (t) => {
  currentTenantId = 'tenant-overslept'
  const { xeroGet, XERO_IN_REQUEST_RETRY_BUDGET_MS } = await import('@/lib/connectors/xero/api')

  const attemptsAt: number[] = []
  connectorFetchHandler = async () => {
    attemptsAt.push(Date.now())
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '90' } })
  }

  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())

  let done = false
  const call = xeroGet('Invoices').then((result) => { done = true; return result })
  // 200 SECONDS PER STEP against 90-second Retry-After sleeps: every sleep wakes 110s late, which is
  // what a saturated event loop does and what `sleptMs += minuteWait` could not see. Two of these
  // overshoot the six-minute window even though no individual sleep was ever unaffordable.
  await runClock(() => done, 200_000, 40)

  assert.equal(done, true, 'the call finished rather than blocking for ever')
  const response = await call
  assert.equal(response.ok, false)

  const spanMs = attemptsAt[attemptsAt.length - 1] - attemptsAt[0]
  assert.ok(
    spanMs < XERO_IN_REQUEST_RETRY_BUDGET_MS,
    `an attempt went out ${spanMs}ms after the first — at or past the ${XERO_IN_REQUEST_RETRY_BUDGET_MS}ms `
      + `Xero remembers the Idempotency-Key for, so Xero would have treated it as a NEW request. The `
      + `attempts landed at ${JSON.stringify(attemptsAt.map((at) => at - attemptsAt[0]))}`,
  )
  assert.deepEqual(attemptsAt.map((at) => at - attemptsAt[0]), [0, 200_000],
    'the third attempt would have gone out at 400,000ms — 40s past the window — so it was not sent at all')

  // And it says WHICH bound refused it, so an operator is not left guessing between this and the
  // "the next wait would not fit" refusal decided before a sleep.
  assert.match(response.error ?? '', /ALREADY SPENT/,
    'the refusal names the at-send check, not the before-the-wait one')
  assert.match(response.error ?? '', /work must be deferred/)
})
