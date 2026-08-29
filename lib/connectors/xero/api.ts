/**
 * Xero HTTP client with automatic token refresh and rate-limit handling.
 */

import { getAccessToken, getStoredTenantBlockReason } from './auth'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { accountingPostingIntentRefusal } from '@/lib/connectors/accounting-posting-intent'
import { accountingEgressRefusal } from '@/lib/connectors/accounting-egress-authorization'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'
const XERO_CONNECTOR = 'xero'

/**
 * The status `performRequest` reports when it REFUSED TO SEND (o3d-gfh / Codex r1 finding 3, and
 * o3d-k26m.5 r6 — both refusals report it).
 *
 * Zero, and deliberately not an HTTP code: nothing was sent, so there is no HTTP status to report,
 * and borrowing one (403, 409) would make the row's errorMessage claim Xero answered when Xero was
 * never asked. It matches the `status: 0` that `notConnectedResponse` already uses for the same
 * reason, so "0 means nothing left this process" is one rule across the module rather than two.
 */
const XERO_NOT_SENT_STATUS = 0

/**
 * WHICH PRE-EGRESS REFUSAL THIS WAS — ENUMERATED AT THE SITE THAT MADE IT (o3d-gvzu).
 *
 * `status: 0` and a 429 both already say "this call produced no reply". Neither says WHY, and the
 * difference matters to exactly one caller: the manual-journal poster, which holds a durable dispatch
 * marker it may release only on PROOF THAT NOTHING LEFT THIS PROCESS. "We got no answer" is not that
 * proof — a timeout, a socket reset mid-write and a 5xx are all cases where the request may have
 * arrived — so the marker may not be released on the absence of a reply, only on the presence of a
 * refusal that is provably above the socket.
 *
 * SO IT IS A NAMED SET, NOT A PREDICATE OVER ERROR SHAPES. Each member is written by the one
 * statement that performs that refusal, and each is provable by WHERE THAT STATEMENT SITS rather than
 * by what it says:
 *
 *  • `no-connection`          `getAccessToken()` returned null, so no token, no tenant header and no
 *                             request object were ever built. `performRequest` is not reached at all;
 *                             there is nothing to send and nothing that could have been sent.
 *  • `posting-intent-refused` `accountingPostingIntentRefusal` refuses ABOVE the retry loop, before
 *                             the first `waitForBudget`. It returns straight out of `performRequest`
 *                             with no `connectorFetch` between it and the caller.
 *  • `egress-unauthorised`    `accountingEgressRefusal` is the last statement before `noteRequest`,
 *                             and nothing between it and `connectorFetch` awaits. On the attempt it
 *                             refuses, `connectorFetch` is never called.
 *  • `rate-budget-refused`    every budget refusal — the minute wait, the rolling-day cap, and both
 *                             idempotency-window bounds — returns BEFORE `noteRequest`, which is why
 *                             a refusal consumes no Xero budget.
 *
 * AND EVERY ONE OF THEM IS ADDITIONALLY GATED ON `firstCallAt === null`, per call. Three of these can
 * be reached on a LATER pass of the retry loop, after an earlier attempt has already gone out — an
 * egress authorisation re-evaluated per attempt, a budget bound checked after a 429 sleep. Such a
 * refusal is pre-egress for its own attempt and says nothing whatever about the request that already
 * left, so it is NOT tagged. `firstCallAt` is set on the statement after `noteRequest` and before
 * `connectorFetch`, so "still null" is the machine-checked form of "this call has sent nothing".
 *
 * ------------------------------------------------------------------------------------------------
 * AN ENUMERATION OF RETURNS IS NOT AN ENUMERATION OF EXITS (o3d-2w2j r2, Codex HIGH)
 * ------------------------------------------------------------------------------------------------
 *
 * The four members above are the ways a pre-egress statement can RETURN a refusal. A statement can
 * also leave by THROWING, and the first round enumerated only the first kind. `getAccessToken()` is
 * the exact case: it reads the token row, reads settings and decrypts, and any of those can reject.
 * The exception then produced no member and no outcome at all — the post threw, the processor's
 * ordinary failure path took the row with the dispatch marker still standing, and once the replay
 * window closed the row was permanently refused for a create that provably never reached the
 * transport. That is the original wedge, arriving through an unenumerated door.
 *
 * So each pre-request statement that can throw now has a member of its own, written by a catch at
 * that exact statement, and each is provable by the same rule — WHERE THE STATEMENT SITS:
 *
 *  • `connection-unresolvable`  `getAccessToken()` THREW. Same position as `no-connection`: no token,
 *                               no tenant header, no request object, and `performRequest` is not
 *                               entered. The only difference between the two is how the resolver
 *                               declined to produce an auth.
 *  • `request-unbuildable`      building the request object threw — the `If-Modified-Since`
 *                               formatting or the body serialisation. After the auth is resolved and
 *                               strictly before `performRequest` is called, so no socket exists yet.
 *  • `posting-intent-unavailable`
 *                               `accountingPostingIntentRefusal` threw rather than answering. Same
 *                               statement as `posting-intent-refused`, above the retry loop.
 *  • `rate-budget-unavailable`  `waitForBudget` threw. Same statement as the budget refusals, and
 *                               like them it returns before `noteRequest`, so it costs no budget.
 *  • `egress-authorisation-unavailable`
 *                               `accountingEgressRefusal` threw. Its `authorize` callbacks read AND
 *                               WRITE the database, so this is the likeliest throw of the five. Same
 *                               statement as `egress-unauthorised`, and `connectorFetch` is the next
 *                               statement but one.
 *
 * WHERE THE LINE IS DRAWN, AND IT IS DRAWN AT THE SOCKET, NOT AT THE FUNCTION BOUNDARY. Every catch
 * above ends BEFORE the statement that can send. `performRequest` is called outside the
 * request-building catch; `connectorFetch` is called outside all of them. An exception from
 * `connectorFetch` — or from anything after it — propagates exactly as it did before, untagged,
 * because the request was already handed to the transport.
 *
 * `noteRequest` IS DELIBERATELY NOT WRAPPED. It sits between the last refusal and `connectorFetch`,
 * and its FIRST statement increments the attempt counter — so a throw from it leaves the caller's
 * counter delta non-zero, `reachedTheWire` true, and the release refused by the conjunction whatever
 * this tag said. Leaving it untagged errs towards "sent", which is the direction this whole type errs
 * in; wrapping it would add the one member that could never license anything.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no member for a timeout, a reset, a 5xx, an unparseable body
 * or a `connectorFetch` throw. Those are ANSWERS THAT DID NOT ARRIVE, not refusals that did not send,
 * and the whole value of this type is that it cannot be widened to cover them without someone adding
 * a member and writing down where the statement sits.
 */
export type XeroNotSentReason =
  | 'no-connection'
  | 'posting-intent-refused'
  | 'egress-unauthorised'
  | 'rate-budget-refused'
  | 'connection-unresolvable'
  | 'request-unbuildable'
  | 'posting-intent-unavailable'
  | 'rate-budget-unavailable'
  | 'egress-authorisation-unavailable'

/**
 * How the reason travels from `performRequest` (which returns a `Response`) to `xeroFetchWithAuth`
 * (which builds the `XeroResponse`). A symbol rather than a field so it cannot collide with anything
 * on a real `Response`, and so a genuine Xero reply can never carry one.
 */
const XERO_NOT_SENT_REASON = Symbol('xero.notSentReason')

/** Read the tag off a refusal built by {@link markNotSent}. Undefined on every real reply. */
function xeroNotSentReason(res: Response): XeroNotSentReason | undefined {
  return (res as Response & { [XERO_NOT_SENT_REASON]?: XeroNotSentReason })[XERO_NOT_SENT_REASON]
}

/**
 * In-request 429 retries. Exported because it is half of the only retry Xero's six-minute
 * Idempotency-Key window actually covers — see lib/domain/accounting/idempotency-retention.ts.
 */
export const XERO_MAX_RETRIES = 3
const XERO_MINUTE_LIMIT = 55 // Xero's is 60/min, rolling

/**
 * Xero's daily cap, minus a small reserve.
 *
 * 1,000 calls per organisation per ROLLING 24h — NOT 5,000, and NOT midnight-reset. Xero cut the
 * free/Starter tier from 5,000 to 1,000 on 2026-03-02; the 4,900 this used to hold was the old
 * cap's reserve and meant the limiter below could never engage. Xero began 429ing at 1,000 while
 * waitForBudget still believed 3,900 remained, so the budget was fiction and the first thing that
 * noticed was a request sleeping on Retry-After (o3d-wgv, o3d-98q).
 *
 * Rolling, so this cannot be reasoned about as "today's" spend: calls fall out of the window 24h
 * after they were made, individually.
 */
const XERO_DAY_LIMIT = 950

/**
 * Longest we will ever sleep on a Retry-After.
 *
 * A MINUTE-limit 429 hands back seconds and is worth waiting out. A DAILY-limit 429 hands back
 * HOURS — parseRetryAfterMs would pass ~86,400,000ms to sleep() and the cron request would hang
 * until something killed it. Rare at 5,000/day; routine at 1,000. Past this we give up and let
 * the caller defer the work (the outbox already re-queues with backoff), because a job that
 * returns is one an operator can see (o3d-2it).
 */
export const XERO_MAX_RETRY_AFTER_MS = 90_000

/**
 * THE IN-REQUEST RETRY BUDGET, AND WHY IT IS THE IDEMPOTENCY WINDOW (o3d-wahn r3 #4).
 *
 * `idempotency-retention.ts` says the in-request 429 loop is the one retry Xero's Idempotency-Key
 * still covers, and round 2 "proved" it by multiplying XERO_MAX_RETRIES by XERO_MAX_RETRY_AFTER_MS:
 * 3 x 90s = 4m30s, inside six minutes. THAT PRODUCT IS NOT THE LOOP. `performRequest` also awaits
 * `waitForBudget` before EVERY attempt, and a minute-limit wait there sleeps up to 60s — so the real
 * worst case between the first HTTP call and the last is 3 x 90s of Retry-After plus 3 x 60s of
 * minute-limit waiting = 7m30s, comfortably OUTSIDE the window the comment claimed it was inside.
 *
 * Rather than correct the prose down to "usually inside", the loop now ENFORCES the bound: no wait is
 * taken that would put the next attempt past this budget, measured from the first HTTP call, which is
 * where Xero starts the key's clock. Past it the call hands back a 429 and the outbox defers the work
 * — which is strictly better than blocking a cron for another minute to send a header Xero has
 * forgotten. `tests/accounting/idempotency-retention.test.ts` drives the real loop and measures the
 * gap between first and last attempt, so the claim is a measurement rather than an arithmetic
 * coincidence between two constants.
 */
export const XERO_IN_REQUEST_RETRY_BUDGET_MS = XERO_IDEMPOTENCY_KEY_RETENTION_MS

const minuteBuckets = new Map<string, number[]>()
const dayBuckets = new Map<string, number[]>()

export type XeroApiError = {
  StatusCode: number
  ErrorNumber: number
  Type: string
  Message: string
  Elements?: Array<{
    ValidationErrors?: Array<{ Message: string }>
  }>
}

export type XeroResponse<T = unknown> = {
  ok: boolean
  status: number
  data?: T
  error?: string
  /**
   * PRESENT ONLY WHEN THIS PROCESS PROVED IT SENT NOTHING (o3d-gvzu). See {@link XeroNotSentReason}
   * for the enumeration and for why each member is provable from where its statement sits.
   *
   * `undefined` is not "we sent it". It is "nothing here proves we did not" — which covers a real
   * reply, a timeout, a reset mid-write, a 5xx, and a per-attempt refusal that followed an attempt
   * which had already gone out. Callers that hold a durable record of a dispatch must treat
   * `undefined` as SENT.
   */
  notSent?: XeroNotSentReason
  /**
   * The Xero organisation this request was actually ADDRESSED TO — the tenantId that went out in the
   * `Xero-Tenant-Id` header, resolved BEFORE the request was made (o3d-gfh, o3d-s36z).
   *
   * WHY THE RESPONSE CARRIES IT. Everything that caches an id Xero issued used to answer "which
   * organisation issued this?" by asking the database AFTER the call returned
   * (`activeAccountingIdProvenance`). That is a resample, not a record: a disconnect and reconnect to a
   * different organisation landing during the in-flight call — and rate-limit retries widen that window
   * to tens of seconds — stamps the NEW organisation onto an id the OLD one issued, and the exact-match
   * guard then trusts the false provenance for good. o3d-s36z's own list of what a next attempt must do
   * differently leads with "issuer identity must be established BEFORE the remote call can corrupt
   * anything, not observed during it"; this is that, and it costs nothing because the auth was already
   * resolved to build the request.
   *
   * `undefined` ONLY when no request was made (not connected / blocked token). A caller that treats
   * undefined as "the current tenant" has reintroduced the resample.
   *
   * WHICH ORGANISATION ANSWERED (o3d-k26m.5 r7, finding 2).
   *
   * A Xero response is only evidence about the ledger it came from, and which ledger that is is
   * decided per call by `getAccessToken()` — a reconnect, a tenant re-pin or a refresh that lands
   * elsewhere all change it between one call and the next. A caller that holds an answer across a
   * later WRITE therefore has to be able to say which organisation the answer is about; the
   * invoice-number fence does exactly that, and without this field its "nobody holds this number"
   * was an unattributed sentence that any organisation could be made to satisfy.
   *
   * Undefined only where no tenant was ever resolved — a disconnected call, which is already a
   * failure. Present on failures too, deliberately: a failed read is still a fact about one org.
   */
  tenantId?: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pushRequestTimestamp(bucket: Map<string, number[]>, key: string, now: number, windowMs: number) {
  const cutoff = now - windowMs
  const values = (bucket.get(key) ?? []).filter((ts) => ts >= cutoff)
  values.push(now)
  bucket.set(key, values)
}

/**
 * Block until this tenant has minute-budget, or report that the DAY budget is gone.
 *
 * The two limits need opposite treatment and used to get the same one. A minute-limit wait is
 * at most 60s and worth sitting out. A day-limit wait is up to 24 HOURS — sleeping that out
 * hangs the request and its cron for the rest of the day, which is the same failure we just
 * removed from the Retry-After path (o3d-2it).
 *
 * This was unreachable while XERO_DAY_LIMIT was 4,900: Xero 429'd at its real 1,000 long before
 * the local bucket ever filled, so the day branch was dead code. Correcting the limit to 950
 * makes it live, so it has to report exhaustion instead of sleeping on it. Callers turn this
 * into a 429 and let the outbox defer with backoff.
 *
 * EXPORTED so its refusal can be driven directly (o3d-wahn r3 #4). This minute-limit sleep is the
 * third wait in `performRequest` and the one round 2's `MAX_RETRIES x MAX_RETRY_AFTER` arithmetic
 * left out; a test that cannot reach it cannot prove the budget covers it.
 */
export async function waitForBudget(
  tenantId: string,
  /**
   * The most this may sleep in total. Not a nicety: the minute-limit wait is the third sleep in the
   * retry loop and the one round 2's arithmetic forgot, so it has to answer to the same budget as the
   * Retry-After sleeps do (o3d-wahn r3 #4). Infinity before the first HTTP call, when no key clock is
   * running yet.
   */
  budgetMs: number = Number.POSITIVE_INFINITY,
): Promise<{ ok: true } | { ok: false; reason: 'day' | 'budget'; waitMs: number }> {
  /**
   * AN ABSOLUTE DEADLINE, NOT A RUNNING TOTAL OF INTENDED SLEEPS (o3d-xl63 r5 #3).
   *
   * The previous shape accumulated `sleptMs += minuteWait` — the sleep it ASKED for, not the one it
   * got. `setTimeout` is a floor, not a promise: an event loop busy with another tenant's response
   * wakes this one late, and every millisecond of that overrun was invisible to the budget. Reading
   * the real clock each time round makes an overslept timer cost what it actually cost.
   */
  const deadlineAt = Number.isFinite(budgetMs) ? Date.now() + budgetMs : Number.POSITIVE_INFINITY
  while (true) {
    const now = Date.now()
    const minute = (minuteBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 60_000)
    const day = (dayBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 86_400_000)
    minuteBuckets.set(tenantId, minute)
    dayBuckets.set(tenantId, day)

    // Day first: no amount of waiting inside this request will fix it.
    if (day.length >= XERO_DAY_LIMIT) {
      return { ok: false, reason: 'day', waitMs: 86_400_000 - (now - day[0]) }
    }

    const minuteWait = minute.length >= XERO_MINUTE_LIMIT ? 60_000 - (now - minute[0]) : 0
    if (minuteWait <= 0) return { ok: true }
    /**
     * REFUSED AT EQUALITY, because equality is already outside (o3d-xl63 r5 #3).
     *
     * `>` let a sleep land the next attempt on the deadline exactly. Six minutes is not the last
     * instant the key is good for — `isWithinXeroIdempotencyWindow` is `age < RETENTION`, so an
     * attempt sent AT six minutes is one the retention predicate itself calls expired. A budget whose
     * boundary case is the one the rest of the codebase treats as unprotected is not a bound.
     */
    if (now + minuteWait >= deadlineAt) return { ok: false, reason: 'budget', waitMs: minuteWait }
    await sleep(minuteWait)
  }
}

/**
 * Total HTTP attempts this process has made against Xero, across all tenants (o3d-8f9 r3).
 *
 * The delta of this counter across a call is the only honest measure of what a request COST: the
 * retry loop can issue up to XERO_MAX_RETRIES + 1 attempts for one caller invocation, so a ledger
 * that counts invocations understates real usage by up to 4x. The poll budget reads this so its
 * ceiling bounds tenant API attempts rather than function calls.
 *
 * Monotonic and never reset — callers take differences, so wraparound is not a concern at this scale.
 */
let xeroHttpAttempts = 0

/** See xeroHttpAttempts. */
export function xeroHttpAttemptCount(): number {
  return xeroHttpAttempts
}

function noteRequest(tenantId: string) {
  const now = Date.now()
  xeroHttpAttempts += 1
  pushRequestTimestamp(minuteBuckets, tenantId, now, 60_000)
  pushRequestTimestamp(dayBuckets, tenantId, now, 86_400_000)
}

/** Xero's own view of what is left, per tenant. Ground truth, unlike the local buckets. */
export type XeroLimitSnapshot = {
  dayRemaining?: number
  minuteRemaining?: number
  appMinuteRemaining?: number
  at: number
}

const limitSnapshots = new Map<string, XeroLimitSnapshot>()

/**
 * Record what Xero says is left. It tells us on EVERY response and we were not listening.
 *
 * The local buckets are a guess that is wrong in both directions: in-memory, so wiped on every
 * deploy and not shared across workers, and blind to spend by anything else pointed at the same
 * org (the e2e rig and stage share one Demo tenant — o3d-98q). These headers are free,
 * authoritative and need no accounting of our own.
 *
 * Read-only for now: the buckets still drive throttling, because a header-driven limiter should
 * land with its own tests. This makes real spend visible first — see xeroLimitSnapshot() (o3d-8p8).
 */
function noteLimitHeaders(tenantId: string, res: { headers?: { get(name: string): string | null } }) {
  const num = (name: string): number | undefined => {
    const raw = res.headers?.get(name)
    if (raw == null) return undefined
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : undefined
  }

  const snapshot: XeroLimitSnapshot = {
    dayRemaining: num('X-DayLimit-Remaining'),
    minuteRemaining: num('X-MinLimit-Remaining'),
    appMinuteRemaining: num('X-AppMinLimit-Remaining'),
    at: Date.now(),
  }
  if (snapshot.dayRemaining == null && snapshot.minuteRemaining == null) return // not a Xero API response
  limitSnapshots.set(tenantId, snapshot)

  // Loud once it is genuinely tight. Silence here is what let a day's budget vanish unnoticed
  // twice in one week.
  if (snapshot.dayRemaining != null && snapshot.dayRemaining <= 100) {
    console.warn(
      `[xero] tenant ${tenantId}: ${snapshot.dayRemaining} of the day's API calls left (rolling 24h).`,
    )
  }
}

/** What Xero last told us was left for this tenant, or undefined if it has not answered yet. */
export function xeroLimitSnapshot(tenantId: string): XeroLimitSnapshot | undefined {
  return limitSnapshots.get(tenantId)
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0
  const seconds = Number.parseInt(value, 10)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const absolute = Date.parse(value)
  return Number.isFinite(absolute) ? Math.max(0, absolute - Date.now()) : 0
}

async function performRequest(auth: { accessToken: string; tenantId: string }, init: RequestInit, url: string) {
  let lastRateLimitMs = 0
  /**
   * When Xero started this request's Idempotency-Key clock. Null until the first attempt actually
   * goes out: waiting for minute budget BEFORE the first call costs nothing from the window, because
   * the key has not been sent yet.
   */
  let firstCallAt: number | null = null
  /** What is left of XERO_IN_REQUEST_RETRY_BUDGET_MS, from the first call. */
  const budgetRemainingMs = () =>
    firstCallAt === null ? Number.POSITIVE_INFINITY : XERO_IN_REQUEST_RETRY_BUDGET_MS - (Date.now() - firstCallAt)
  /**
   * TAG A REFUSAL AS PROVABLY PRE-EGRESS — and refuse to tag it once anything has gone out (o3d-gvzu).
   *
   * `firstCallAt` is assigned on the statement AFTER `noteRequest` and BEFORE `connectorFetch`, and it
   * is the only thing in this function that records "a request has left". So `firstCallAt === null` is
   * a mechanical proof that no `connectorFetch` has been entered on this call, and it is checked HERE,
   * at the moment of return, rather than at the site that decided to refuse — several of these
   * refusals are re-evaluated per retry attempt, and the same refusal is pre-egress on attempt 0 and
   * says nothing at all about attempt 1.
   *
   * IT ERRS ONLY TOWARDS "SENT". Losing a tag costs a marker that is not released and a refusal an
   * operator resolves; adding one that is not true costs a duplicate document in a live ledger.
   */
  const markNotSent = <T extends object>(reason: XeroNotSentReason, res: T): T =>
    firstCallAt === null ? Object.assign(res, { [XERO_NOT_SENT_REASON]: reason }) : res
  const outOfBudgetResponse = (waitMs: number, elapsedMs: number) => markNotSent('rate-budget-refused', {
    ok: false,
    status: 429,
    text: async () =>
      `Rate limited; the next in-request retry would wait ${Math.round(waitMs / 1000)}s, which puts it ` +
      `past the ${XERO_IN_REQUEST_RETRY_BUDGET_MS / 1000}s Xero remembers an Idempotency-Key for ` +
      `(${Math.round(elapsedMs / 1000)}s already spent on this call). Not waiting — the work must be ` +
      `deferred, where the local record of the external id is what prevents a duplicate.`,
  } as Response)
  /**
   * THE ATTEMPT THAT WAS ABOUT TO GO OUT AT OR PAST THE LINE (o3d-xl63 r5 #3).
   *
   * Distinct from the refusal above, and it has to be: that one is decided BEFORE a wait, from the
   * wait's intended length. This one is decided AFTER every await, from the clock — the case where the
   * waits were each individually affordable and the elapsed total still reached the deadline, whether
   * by an exact-boundary sleep or by a timer that woke late. Its own message, so a test can tell which
   * of the two refused and an operator can tell which bound was hit.
   */
  const budgetSpentResponse = (elapsedMs: number) => markNotSent('rate-budget-refused', {
    ok: false,
    status: 429,
    text: async () =>
      `Rate limited; the ${XERO_IN_REQUEST_RETRY_BUDGET_MS / 1000}s Xero remembers an Idempotency-Key ` +
      `for was ALREADY SPENT (${Math.round(elapsedMs / 1000)}s) at the moment this attempt was about to ` +
      `be sent, so it was not sent. At or past that line Xero treats the key as a new request, which is ` +
      `exactly how a retry becomes a second document. The work must be deferred, where the local record ` +
      `of the external id is what prevents a duplicate.`,
  } as Response)

  // THE ONE PLACE the queued row's connection is authorised, and the last statement before anything
  // leaves this process (o3d-gfh, Codex r1 finding 3).
  //
  // Here rather than at the top of `processEntry` because `auth.tenantId` is the string that goes into
  // this request's own `Xero-Tenant-Id` header: the value checked and the value used are one object, so
  // no rebinding can land between them. The processor's earlier read of the token row was a SECOND,
  // independent selection of the same thing, and a check at T1 says nothing about a request sent at T2.
  //
  // Every Xero egress in this file funnels through here — xeroFetchWithAuth, xeroGetRaw and
  // xeroUploadAttachment all call it — so there is no arm left to forget it. Evaluated once rather than
  // per retry attempt on purpose: `auth` is fixed for the whole call, so the verdict cannot change
  // across the retry loop, and re-asking would be a second evaluation of a settled permission.
  //
  // AND IT IS ASKED INSIDE A CATCH (o3d-2w2j r2). The verdict is computed from the row's stored
  // payload and its provenance stamps; a payload that will not deserialise, or a provenance shape it
  // cannot read, throws rather than refusing. That exception is as pre-egress as the refusal beside
  // it — this is the statement above the retry loop, and `connectorFetch` has not been entered — so
  // it is reported as a named refusal rather than escaping the transport untagged.
  let intentRefusal: string | null
  try {
    intentRefusal = accountingPostingIntentRefusal(XERO_CONNECTOR, auth.tenantId)
  } catch (error) {
    return markNotSent('posting-intent-unavailable', {
      ok: false,
      status: XERO_NOT_SENT_STATUS,
      text: async () =>
        `Xero's posting intent for organisation ${auth.tenantId} could not be evaluated — `
        + `${String(error)}. NOTHING WAS SENT: this check sits above the retry loop, so no attempt `
        + 'had been made when it failed.',
    }) as Response
  }
  if (intentRefusal) {
    return markNotSent('posting-intent-refused', {
      ok: false, status: XERO_NOT_SENT_STATUS, text: async () => intentRefusal,
    }) as Response
  }

  for (let attempt = 0; attempt <= XERO_MAX_RETRIES; attempt++) {
    const remainingBeforeCall = budgetRemainingMs()
    // Wrapped for the same reason the two authorisations are: it is a statement that can leave by
    // throwing as well as by answering, and every exit above the socket has to be enumerated. It
    // cannot throw at today's body (in-memory buckets and a `setTimeout`), and that is precisely the
    // kind of claim the first round made about the token resolver — so the catch is here on the
    // strength of WHERE THE STATEMENT SITS, which does not change when the body does.
    let budget: Awaited<ReturnType<typeof waitForBudget>>
    try {
      budget = await waitForBudget(auth.tenantId, remainingBeforeCall)
    } catch (error) {
      return markNotSent('rate-budget-unavailable', {
        ok: false,
        // NOT a 429: nothing rate-limited this request. Zero, like every other refusal that reports
        // no reply because there was no request — and it keeps "a 429 above the socket is a budget
        // refusal" exactly as true as it was.
        status: XERO_NOT_SENT_STATUS,
        text: async () =>
          `Xero's rate budget for organisation ${auth.tenantId} could not be evaluated — `
          + `${String(error)}. NOTHING WAS SENT: this runs before \`noteRequest\`, so no attempt was `
          + 'made and none was counted.',
      }) as Response
    }
    if (!budget.ok) {
      if (budget.reason === 'budget') return outOfBudgetResponse(budget.waitMs, XERO_IN_REQUEST_RETRY_BUDGET_MS - remainingBeforeCall)
      return markNotSent('rate-budget-refused', {
        ok: false,
        status: 429,
        text: async () =>
          `Xero day budget exhausted for this tenant: ${XERO_DAY_LIMIT} calls used within the rolling ` +
          `24h window, oldest falls out in ${Math.round(budget.waitMs / 60_000)} min. Not waiting — ` +
          `the work must be deferred. (Xero's real cap is 1,000/org/rolling-24h since 2026-03-02.)`,
      } as Response)
    }

    // THE LAST STATEMENT BEFORE THE SOCKET, AND THE ONE PLACE ANY PRE-EGRESS PERMISSION IS SPENT
    // (o3d-k26m.5 r6).
    //
    // INSIDE THE LOOP, AND AFTER `waitForBudget`, ON PURPOSE. Everything above this line can block:
    // the budget wait sleeps until the tenant's minute window clears, and a 429 sleeps up to
    // XERO_MAX_RETRY_AFTER_MS before coming back round. A permission evaluated before the loop would
    // be spent on an attempt that leaves minutes later — which is the same "true when taken, false
    // when spent" defect one layer down, and is exactly why "immediately before `xeroPost`" was not
    // immediately before the write. See accounting-egress-authorization.ts for why per-attempt rather
    // than per-call, and for how the sibling branch's tenant verdict collapses into this same call.
    //
    // BEFORE `noteRequest` because a refusal consumes no Xero budget: nothing is sent, so nothing may
    // be counted against the rolling day cap. Nothing between here and `connectorFetch` awaits.
    //
    // AND IT IS ASKED ABOUT THIS REQUEST, NOT ABOUT REQUESTS IN GENERAL (r7, finding 2). `auth` is the
    // resolution this very request was built from — `init.headers['Xero-Tenant-Id']` is that same
    // string — so an authorisation holding an answer obtained from some earlier call can compare the
    // organisation it asked against the organisation about to be written to, here, with no second
    // token resolution able to intervene. That comparison used to be impossible to make correctly at
    // any other point, so it was not made at all.
    //
    // AND IT IS THE LIKELIEST OF THE FIVE TO THROW (o3d-2w2j r2), which is why the catch matters most
    // here: an `authorize` callback may READ AND WRITE the database and one of them takes an
    // exclusive slot, so a lock timeout, a serialisation failure or a dropped connection all reject.
    // The catch adds no await of its own, so "nothing between here and `connectorFetch` awaits"
    // still holds, and it ends before `noteRequest` — nothing was sent, and nothing was counted.
    let egressRefusal: string | null
    try {
      egressRefusal = await accountingEgressRefusal(XERO_CONNECTOR, { tenantId: auth.tenantId })
    } catch (error) {
      return markNotSent('egress-authorisation-unavailable', {
        ok: false,
        status: XERO_NOT_SENT_STATUS,
        text: async () =>
          `The egress authorisation for organisation ${auth.tenantId} could not be evaluated — `
          + `${String(error)}. NOTHING WAS SENT: the authorisation is the last statement before the `
          + 'attempt is counted, and it never returned a permission.',
      }) as Response
    }
    if (egressRefusal) {
      return markNotSent('egress-unauthorised', {
        ok: false, status: XERO_NOT_SENT_STATUS, text: async () => egressRefusal,
      }) as Response
    }

    /**
     * RE-READ THE CLOCK BEFORE THE REQUEST GOES OUT, NOT BEFORE THE WAIT (o3d-xl63 r5 #3).
     *
     * `waitForBudget` decides from the wait it is ABOUT to take; between that decision and this line
     * lies the wait itself, and at the bottom of the loop a Retry-After sleep. Both can overrun, and
     * an exact-boundary wait lands here precisely ON the deadline. Deciding again HERE — from
     * `Date.now()`, immediately before `noteRequest` records an attempt and `connectorFetch` sends
     * one — is the only check that sees what actually elapsed. Strict: at the line the key is already
     * expired as far as `isWithinXeroIdempotencyWindow` is concerned.
     *
     * AFTER the egress refusal above, and that order is the one that satisfies BOTH rules. This read
     * is SYNCHRONOUS, so placing it second leaves the egress check's "nothing between here and
     * `connectorFetch` awaits" true, while placing it first would put that check's `await` between
     * this clock reading and the send — the very gap this re-read exists to eliminate.
     */
    const remainingAtSend = budgetRemainingMs()
    if (remainingAtSend <= 0) {
      return budgetSpentResponse(XERO_IN_REQUEST_RETRY_BUDGET_MS - remainingAtSend)
    }

    noteRequest(auth.tenantId)
    firstCallAt ??= Date.now()

    const res = await connectorFetch(url, init, { connectorName: 'Xero' })
    noteLimitHeaders(auth.tenantId, res)
    if (res.status !== 429) return res

    lastRateLimitMs = Math.max(parseRetryAfterMs(res.headers.get('Retry-After')), 1000 * 2 ** attempt)

    // Give up rather than sleep out a daily limit. Retry-After is measured in seconds for the
    // minute limit and in HOURS for the daily one; waiting out the latter hangs this request
    // (and its cron) with nothing to show for it. Hand the 429 back and let the caller defer.
    // The wait must fit the window as well as the per-sleep cap: a retry sent after Xero has forgotten
    // the key is a NEW request to Xero, so blocking a cron for it buys nothing (o3d-wahn r3 #4).
    //
    // THIS HALF IS DEFENSIVE AT TODAY'S CONSTANTS and says so rather than pretending to be load-bearing:
    // XERO_MAX_RETRIES x XERO_MAX_RETRY_AFTER_MS is 270s, inside the 360s budget, so the Retry-After
    // sleeps alone cannot exhaust it — only the minute-limit waits above can, which is why THEY are
    // what the tests drive. It exists so that raising either constant cannot silently reintroduce the
    // overrun; the test pins that relationship so the day it stops holding, this becomes live.
    const remaining = budgetRemainingMs()
    // `>=`, not `>` (r5 #3): a sleep exactly as long as what is left lands the next attempt ON the
    // deadline, which the retention predicate already calls expired.
    if (lastRateLimitMs >= remaining && attempt !== XERO_MAX_RETRIES) {
      return outOfBudgetResponse(lastRateLimitMs, XERO_IN_REQUEST_RETRY_BUDGET_MS - remaining)
    }
    if (lastRateLimitMs > XERO_MAX_RETRY_AFTER_MS || attempt === XERO_MAX_RETRIES) {
      return {
        ok: false,
        status: 429,
        text: async () =>
          lastRateLimitMs > XERO_MAX_RETRY_AFTER_MS
            ? `Rate limited; Xero asked for ${Math.round(lastRateLimitMs / 1000)}s which exceeds the ` +
              `${XERO_MAX_RETRY_AFTER_MS / 1000}s we are willing to block for. This is what the DAILY ` +
              `cap (1,000 calls/org/rolling-24h) looks like — the work must be deferred, not waited out.`
            : `Rate limited after retries; retry after ${lastRateLimitMs}ms`,
      } as Response
    }

    await sleep(lastRateLimitMs)
  }

  return { ok: false, status: 429, text: async () => `Rate limited after retries; retry after ${lastRateLimitMs}ms` } as Response
}

/**
 * Format a timestamp for Xero's `If-Modified-Since`.
 *
 * Xero documents `yyyy-mm-ddThh:mm:ss` and is fussy about it: the milliseconds and offset a bare
 * toISOString() emits are the reported cause of the header being silently ignored (XeroAPI/Xero-Java
 * #166, XeroAPI/xero-ruby #24 — both surface as "the filter does nothing, every record comes back").
 * Truncating to whole seconds keeps us on the documented shape.
 *
 * Dropping the sub-second is deliberately the safe direction: an earlier floor re-returns a record
 * we have already reconciled, which the callers are idempotent about. Rounding up could skip one.
 */
export function formatIfModifiedSince(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().slice(0, 19)
}

/**
 * "Not connected to Xero" is the truth but rarely the whole of it: when the stored connection has been
 * refused by the XERO_ALLOWED_TENANT_IDS/_NAMES allow-list (o3d-9tbz) the operator needs to know THAT,
 * or they go looking for a lost token. Only consulted on the already-failing path.
 */
async function notConnectedResponse<T = unknown>(): Promise<XeroResponse<T>> {
  const blocked = await getStoredTenantBlockReason().catch(() => null)
  // PROVABLY PRE-EGRESS BY CONSTRUCTION, and the strongest of the four: `getAccessToken()` answered
  // null, so there is no access token, no `Xero-Tenant-Id` and no request object. `performRequest` is
  // never entered. This is the "Not connected to Xero" blip o3d-gvzu names — one of which used to
  // wedge a manual-journal row for good.
  return { ok: false, status: 0, error: blocked ?? 'Not connected to Xero', notSent: 'no-connection' }
}

/**
 * The resolver THREW (o3d-2w2j r2). Sibling of {@link notConnectedResponse} — same position, same
 * proof — reported separately because "no connection is stored" and "the stored connection could not
 * be read" send an operator to different places.
 *
 * No `tenantId`: none was ever resolved. That is the same `undefined` a disconnected call already
 * produces, and it is the truth here for the same reason.
 */
function connectionUnresolvableResponse<T = unknown>(error: unknown): XeroResponse<T> {
  return {
    ok: false,
    status: XERO_NOT_SENT_STATUS,
    error: `Could not resolve a Xero connection: ${String(error)}. NOTHING WAS SENT — no token was `
      + 'obtained, so no request was ever built.',
    notSent: 'connection-unresolvable',
  }
}

/**
 * BUILDING THE REQUEST THREW (o3d-2w2j r2).
 *
 * The two statements that can: `formatIfModifiedSince`, which calls `toISOString()` and answers a
 * RangeError for an unparseable date, and `JSON.stringify`, which throws on a cycle or a BigInt. Both
 * sit after the auth is resolved and strictly before `performRequest` is called, so the proof is
 * positional in the same way every other member's is.
 */
function requestUnbuildableResponse<T = unknown>(tenantId: string, error: unknown): XeroResponse<T> {
  return {
    ok: false,
    status: XERO_NOT_SENT_STATUS,
    error: `Could not build the Xero request: ${String(error)}. NOTHING WAS SENT — the failure is in `
      + 'assembling the request object, one statement above the transport.',
    notSent: 'request-unbuildable',
    tenantId,
  }
}

async function xeroFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string; ifModifiedSince?: Date | string },
): Promise<XeroResponse<T>> {
  let auth: Awaited<ReturnType<typeof getAccessToken>>
  try {
    auth = await getAccessToken()
  } catch (error) {
    // THE RESOLVER CAN THROW, AND THE FIRST ROUND ONLY HANDLED IT RETURNING NULL (o3d-2w2j r2).
    //
    // `getAccessToken()` reads the token row, reads settings and decrypts; a database blip, a
    // settings read that fails or a decryption error all reject rather than answer null. The
    // exception used to leave this function entirely, so the manual-journal poster produced neither
    // an outcome nor a reason and the row fell into ordinary backoff with its dispatch marker
    // standing — the wedge this branch exists to close, through a door the enumeration had not
    // named.
    //
    // PROVABLY PRE-EGRESS BY CONSTRUCTION, and for exactly the reason `no-connection` is: there is
    // no access token, no `Xero-Tenant-Id` and no request object, and `performRequest` is never
    // entered. Which of the two applies depends only on how the resolver declined.
    return connectionUnresolvableResponse(error)
  }
  if (!auth) return await notConnectedResponse()
  return xeroFetchWithAuth<T>(auth, method, path, body, opts)
}

// The body of a Xero request against an ALREADY-RESOLVED auth. Split out so xeroGetCached can resolve
// auth exactly once and use the SAME auth for both the cache key and the request — otherwise a
// concurrent reconnect between two getAccessToken() calls could store one tenant's response under
// another tenant's key (o3d-e2j).
async function xeroFetchWithAuth<T = unknown>(
  auth: { accessToken: string; tenantId: string },
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string; ifModifiedSince?: Date | string },
): Promise<XeroResponse<T>> {
  // EVERY STATEMENT THAT ASSEMBLES THE REQUEST, IN ONE BLOCK THAT CANNOT THROW PAST ITSELF
  // (o3d-2w2j r2). Two of them can throw today — `formatIfModifiedSince` on an unparseable date and
  // `JSON.stringify` on a cycle or a BigInt — and the block rather than the two statements is
  // deliberate: the property being kept is that NOTHING between the resolved auth and
  // `performRequest` may leave this function untagged, and a block keeps it for statements added
  // later that nobody thought to wrap.
  //
  // IT ENDS BEFORE `performRequest`, which is the whole of the rule. The transport has its own
  // pre-egress tags, its own per-attempt guard and, below them, a socket whose exceptions must stay
  // untagged; folding it in here would tag them all.
  let url: string
  let init: RequestInit
  try {
    url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
      'Accept': 'application/json',
    }
    if (opts?.idempotencyKey && method !== 'GET') {
      headers['Idempotency-Key'] = opts.idempotencyKey
    }
    // The Accounting API's modified-since filter is THIS HEADER. There is no `ModifiedAfter` query
    // param — the poller passed one for months and Xero, which ignores unknown query params rather
    // than rejecting them, dropped it on the floor (o3d-5gm). `?since=` is Payroll, not Accounting.
    if (opts?.ifModifiedSince) {
      headers['If-Modified-Since'] = formatIfModifiedSince(opts.ifModifiedSince)
    }

    init = { method, headers }

    if (body) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
  } catch (error) {
    return requestUnbuildableResponse<T>(auth.tenantId, error)
  }

  const res = await performRequest(auth, init, url)
  // Refused before sending. Reported verbatim rather than falling through to the `!res.ok` branch,
  // which would prefix it with "HTTP 0:" and so describe a reply Xero never made.
  if (res.status === XERO_NOT_SENT_STATUS) {
    return {
      ok: false, status: XERO_NOT_SENT_STATUS, error: await res.text(), tenantId: auth.tenantId,
      notSent: xeroNotSentReason(res),
    }
  }
  if (res.status === 429) {
    // A 429 is the one status that appears on BOTH sides of the socket — the budget refusals below
    // the fence report it without sending, and Xero itself answers it after a real send. So the tag
    // is what separates them, never the status (o3d-gvzu).
    return {
      ok: false, status: 429, error: await res.text().catch(() => 'Rate limited'), tenantId: auth.tenantId,
      notSent: xeroNotSentReason(res),
    }
  }

  if (!res.ok) {
    // Read the body ONCE as text, then parse. res.json() followed by res.text() in the
    // catch cannot work: json() has already consumed the stream, so text() throws and
    // the .catch swallows it — the raw-body fallback ALWAYS degraded to 'Unknown error'.
    const rawBody = await res.text().catch(() => '')
    let errorMessage = `HTTP ${res.status}`
    try {
      const errBody = JSON.parse(rawBody) as XeroApiError
      if (errBody.Message) {
        errorMessage = errBody.Message
      }
      // Extract validation errors
      if (errBody.Elements?.length) {
        const validationErrors = errBody.Elements
          .flatMap(e => e.ValidationErrors ?? [])
          .map(v => v.Message)
          .filter(Boolean)
        if (validationErrors.length) {
          errorMessage += ': ' + validationErrors.join('; ')
        }
      }
      // Xero does not always answer in the shape above. When it doesn't, we were
      // DISCARDING the body and recording a bare "HTTP 400" — which is how a genuine
      // STOCK_RECEIPT rejection stayed indistinguishable from a demo-tenant quirk and got
      // parked as a fixme (e2e/xero.spec.ts:134). Never throw the diagnostic away.
      if (errorMessage === `HTTP ${res.status}` && rawBody) {
        errorMessage += `: ${rawBody.slice(0, 1000)}`
      }
    } catch {
      errorMessage += ': ' + (rawBody.slice(0, 1000) || 'Unknown error (empty response body)')
    }
    return { ok: false, status: res.status, error: errorMessage, tenantId: auth.tenantId }
  }

  const data = await res.json() as T
  return { ok: true, status: res.status, data, tenantId: auth.tenantId }
}

/**
 * TTL cache for Xero REFERENCE data only (o3d-e2j).
 *
 * xeroGet is a genuine single chokepoint, but it serves both reference data AND per-transaction lookups
 * (Invoices?where=..., contact/item searches) that MUST stay live — so this is a sibling with an explicit
 * allowlist, never a blanket cache over xeroGet. A caller opts in by using xeroGetCached, and the path
 * head must be on XERO_CACHEABLE_REFERENCE_PATHS or the call throws rather than silently serving stale
 * data for something that should be live.
 *
 * Xero's own guidance is to cache Chart of Accounts / Tax Rates / Currencies / Tracking Categories for
 * 4-12h; 4h is chosen as the conservative end, since these are things a user can change in Xero and would
 * expect to see reflected reasonably soon. Deliberately NOT cached: tax-rate drift detection
 * (fetchXeroTaxRates), which is the freshness authority and must read live, and one-shot enable-sync
 * validation gates, where a cache buys nothing and stale data could wrongly pass/fail the gate.
 */
export const XERO_REFERENCE_CACHE_TTL_MS = 4 * 60 * 60 * 1000

const XERO_CACHEABLE_REFERENCE_PATHS = ['TaxRates', 'Organisation', 'Currencies', 'TrackingCategories'] as const

type XeroReferenceCacheEntry = { expiresAt: number; response: XeroResponse<unknown> }
const xeroReferenceCache = new Map<string, XeroReferenceCacheEntry>()

/** Drop all cached reference data — call when the connection changes (disconnect/reconnect). */
export function clearXeroReferenceCache(): void {
  xeroReferenceCache.clear()
}

/**
 * Drop cached entries for a single reference path across all tenants — call right after mutating that
 * data (e.g. after putXeroTaxRate) so a passive read can't serve the pre-mutation snapshot for the rest
 * of the TTL. Keys are `${tenantId}:${path}` (o3d-r30).
 */
export function clearXeroReferenceCachePath(path: string): void {
  for (const key of xeroReferenceCache.keys()) {
    if (key.endsWith(`:${path}`)) xeroReferenceCache.delete(key)
  }
}

/**
 * Like xeroGet, but serves a cached body for up to ttlMs when the path is reference data.
 *
 * The cache key includes the tenant id, so a reconnect to a different org never serves the previous org's
 * reference data (the same lesson as o3d-6nd). Only a genuinely successful response is cached — never a
 * 429 or error, or a transient failure would be pinned for the whole TTL.
 */
export async function xeroGetCached<T = unknown>(
  path: string,
  ttlMs: number = XERO_REFERENCE_CACHE_TTL_MS,
): Promise<XeroResponse<T>> {
  // EXACT match, not a prefix/head parse. The cacheable reads are all bare endpoint names, so requiring
  // the whole path to equal an allowlisted name means a crafted path can never slip a live endpoint past
  // the guard — "TaxRates/../Invoices/{id}" and "Organisation/%2e%2e/Invoices" are simply not equal to
  // "TaxRates"/"Organisation" and are rejected before any URL normalisation could reinterpret them.
  if (!(XERO_CACHEABLE_REFERENCE_PATHS as readonly string[]).includes(path)) {
    throw new Error(
      `xeroGetCached refused path "${path}"; only the exact reference endpoints ` +
      `${XERO_CACHEABLE_REFERENCE_PATHS.join(', ')} may be cached. Per-transaction lookups (and any ` +
      'subpath or query) must use xeroGet so they stay live.',
    )
  }

  // Resolve auth ONCE and use it for both the key and the request. Never touch the cache when
  // disconnected — no read from and no write to a 'no-tenant' key, so a disconnected call can neither
  // serve nor create connected data.
  //
  // The resolver can throw as well as answer null (o3d-2w2j r2), and this arm answers the same
  // `XeroResponse` the others do, so it reports the same named refusal. Nothing here holds a dispatch
  // marker — these are reference GETs — but a rule with an exception in it is a rule nobody can
  // check, and the cache is deliberately left untouched on both arms alike.
  let auth: Awaited<ReturnType<typeof getAccessToken>>
  try {
    auth = await getAccessToken()
  } catch (error) {
    return connectionUnresolvableResponse<T>(error)
  }
  if (!auth) return await notConnectedResponse()

  const key = `${auth.tenantId}:${path}`
  const now = Date.now()
  const hit = xeroReferenceCache.get(key)
  if (hit && hit.expiresAt > now) return hit.response as XeroResponse<T>

  const response = await xeroFetchWithAuth<T>(auth, 'GET', path)
  if (response.ok) xeroReferenceCache.set(key, { expiresAt: now + ttlMs, response })
  return response
}

export async function xeroGet<T = unknown>(
  path: string,
  opts?: { ifModifiedSince?: Date | string },
): Promise<XeroResponse<T>> {
  return xeroFetch<T>('GET', path, undefined, opts)
}

export async function xeroPost<T = unknown>(
  path: string,
  body: unknown,
  opts?: { idempotencyKey?: string },
): Promise<XeroResponse<T>> {
  return xeroFetch<T>('POST', path, body, opts)
}

export async function xeroPut<T = unknown>(
  path: string,
  body: unknown,
  opts?: { idempotencyKey?: string },
): Promise<XeroResponse<T>> {
  return xeroFetch<T>('PUT', path, body, opts)
}

/**
 * Raw binary GET request (e.g. for PDF download).
 * Returns the response as a Buffer.
 */
export async function xeroGetRaw(
  path: string,
  accept: string = 'application/pdf',
): Promise<{ ok: boolean; status: number; buffer?: Buffer; error?: string }> {
  // THE ONE ARM THAT STILL LETS A RESOLVER EXCEPTION THROUGH, AND IT IS SAID OUT LOUD (o3d-2w2j r2).
  //
  // Its return type has no `notSent` field to carry a tag on, because nothing it is used for holds a
  // durable dispatch record: it downloads PDFs. Widening the shape to add a channel with no reader
  // would be a wider change than the one being made, and an untagged exception here costs a failed
  // download that is retried, not a wedged row. The next caller that needs the proof should move to
  // `XeroResponse` rather than add a second, weaker tag here.
  const auth = await getAccessToken()
  if (!auth) return await notConnectedResponse()

  const url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

  const res = await performRequest(auth, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
      'Accept': accept,
    },
  }, url)

  if (res.status === XERO_NOT_SENT_STATUS) {
    return { ok: false, status: XERO_NOT_SENT_STATUS, error: await res.text() }
  }

  if (res.status === 429) {
    return { ok: false, status: 429, error: await res.text().catch(() => 'Rate limited') }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error')
    return { ok: false, status: res.status, error: `Raw GET failed: ${errText}` }
  }

  const arrayBuffer = await res.arrayBuffer()
  return { ok: true, status: res.status, buffer: Buffer.from(arrayBuffer) }
}

/**
 * Upload a file attachment to a Xero object (invoice, bill, credit note, etc.).
 * Uses the Xero Files API: PUT /api.xro/2.0/{endpoint}/{id}/Attachments/{filename}
 */
export async function xeroUploadAttachment(
  endpoint: string,
  objectId: string,
  filename: string,
  fileBuffer: Buffer,
  contentType: string,
): Promise<XeroResponse> {
  let auth: Awaited<ReturnType<typeof getAccessToken>>
  try {
    auth = await getAccessToken()
  } catch (error) {
    return connectionUnresolvableResponse(error)
  }
  if (!auth) return await notConnectedResponse()

  // `encodeURIComponent` throws a URIError on a lone surrogate, and a filename arrives from
  // user-supplied data. Same block, same rule as `xeroFetchWithAuth`: it ends before
  // `performRequest`.
  let url: string
  try {
    url = `${XERO_BASE_URL}/${endpoint}/${objectId}/Attachments/${encodeURIComponent(filename)}`
  } catch (error) {
    return requestUnbuildableResponse(auth.tenantId, error)
  }

  const res = await performRequest(auth, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
      'Content-Type': contentType,
      'Content-Length': String(fileBuffer.length),
    },
    body: new Uint8Array(fileBuffer),
  }, url)

  if (res.status === XERO_NOT_SENT_STATUS) {
    return { ok: false, status: XERO_NOT_SENT_STATUS, error: await res.text() }
  }

  if (res.status === 429) {
    return { ok: false, status: 429, error: await res.text().catch(() => 'Rate limited') }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error')
    return { ok: false, status: res.status, error: `Attachment upload failed: ${errText}` }
  }

  const data = await res.json().catch(() => ({}))
  return { ok: true, status: res.status, data }
}
