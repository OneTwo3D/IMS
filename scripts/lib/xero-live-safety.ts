/**
 * o3d-t74p — the safety contract for the LIVE Xero incident scripts.
 *
 * The four `*-xero-live-*` scripts operate on a REAL ledger and one of them writes irreversibly:
 * a voided invoice cannot be un-voided and a deleted item cannot be restored. Every boundary that
 * stands between "read the org" and "destroy part of it" lives in this file rather than inline in
 * the scripts, for one reason: prose in a header is not executable, and the review that merged the
 * first pass missed a one-character predicate bug that would have swept genuine business contacts
 * into an irreversible void. These functions are covered by tests/scripts/xero-live-safety.test.ts.
 *
 * The contract, in the order it is enforced:
 *
 *   1. TRANSPORT      no method other than GET can leave the process unless --apply was passed, and
 *                     a rate-limited WRITE is refused rather than re-dispatched: the retry would
 *                     land an authorisation minted before the sleep. A GET still retries — a read
 *                     authorises nothing, and its own result is what gets checked.
 *   2. TENANT         the organisation Xero reports must be the expected one, by id AND by name.
 *   3. SELECTION      only the exact full-chain fixture naming grammar selects an object, and
 *                     anything that merely looks E2E-ish aborts the run instead of being included
 *                     or silently dropped.
 *   4. MANIFEST       every object about to be mutated must appear in a separately reviewed,
 *                     tenant-stamped manifest AND still be in the state that manifest records.
 *                     An object that is live-selected but absent from the manifest is fatal, and
 *                     so is one whose status, contact, blockers or UpdatedDateUTC have moved since
 *                     the review: a uuid says WHICH object a human approved, never WHAT they
 *                     approved doing to it.
 *   5. COMPLETENESS   a read that could not be proven complete is an error, never an empty result.
 *                     A walk that cannot ADVANCE has not FINISHED: a server that re-serves page 1
 *                     proves only that `page` is not working, and an unpaged Xero GET is silently
 *                     truncated to the oldest 100 rows.
 *   6. REVALIDATION   each object is re-read immediately before EACH write to it — not once per
 *                     object, because a step that writes several times to one object would then
 *                     have checked only the first — and must be byte-for-byte the object that was
 *                     planned, INCLUDING UpdatedDateUTC, the catch-all version, which is a REQUIRED
 *                     field of the expectation precisely so that no call site can drop it by
 *                     omission. Where this run has itself already written to the object, the write
 *                     is held to the version XERO REPORTED FOR THAT WRITE; where Xero reported
 *                     none, there is nothing attributable to this run and the write is REFUSED.
 *                     An authorisation does not outlive its window either: nothing may re-dispatch
 *                     a write after a delay, because the check that authorised it is behind that
 *                     delay. A rate-limited write is refused and the operator re-runs.
 *   7. OUTCOME        a run with any failure exits non-zero and does not report success; a run that
 *                     THREW after writing says how much it had already destroyed; and a write whose
 *                     outcome cannot be determined is reported as UNKNOWN, never as nothing. A
 *                     settlement that could not be STORED does not suppress the mutation it was
 *                     about: the process still knows what happened, and once the durable stores
 *                     have refused it, that knowledge is the only copy of the answer left.
 *   8. DURABILITY     every write is recorded on disk, and flushed, BEFORE it is dispatched. An
 *                     in-memory record of an unknown write dies with the process, and a killed
 *                     process is the same class of event that produces one. An intent with no
 *                     settlement stops the NEXT run rather than being lost.
 *   9. EXCLUSION      that log, and the exclusive lock over it, are keyed on THE LEDGER — the
 *                     tenant id — at an absolute path derived from it. Neither is a path anyone
 *                     can supply. A log path taken off the command line makes both guarantees
 *                     conditional on what was typed: two runs given two paths take two locks (so
 *                     nothing is excluded) and read two logs (so a run can start with an empty
 *                     fence over a ledger a dead run may have changed).
 *  10. COORDINATION   and because a lock FILE and a log FILE coordinate ONE HOST while the thing
 *                     they protect is ONE LEDGER, the same exclusion and the same fence also live
 *                     in a shared authority: a PostgreSQL advisory lock and the
 *                     `xero_live_write_intents` table in the IMS database, both keyed on the same
 *                     tenant. Otherwise a second host, a container or a restored VM takes a free
 *                     lock and reads an empty fence. Unreachable is REFUSED, in both modes.
 *  11. AND THE COORDINATOR IS THE LEDGER'S, not whichever store DATABASE_URL names — otherwise
 *                     "the operator's path choice" has merely become "the operator's DATABASE_URL"
 *                     and two hosts on two databases each take a free lock. The store must hold
 *                     the IMS accounting connection for this Xero organisation, or it is refused
 *                     before any lock is taken. A LOST lock is refused too, in both modes: an
 *                     --apply notices at its next dispatch, a dry run at the two points where its
 *                     plan becomes an artefact, and the loss is latched permanently.
 *  12. AND A SETTLEMENT NOBODY CAN INTERPRET IS NOT A SETTLEMENT. The vocabulary is closed —
 *                     NULL, 'unknown', 'committed', 'not-committed' — and every question about it
 *                     is asked as the COMPLEMENT of the resolved pair, so a value outside the
 *                     vocabulary HOLDS the recovery fence rather than silently clearing it. Where
 *                     nobody established an outcome, the tooling prints an investigation, not an
 *                     UPDATE: there is nothing to settle a write as until somebody has read the
 *                     ledger.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import pg from 'pg'
import { XERO_LIVE_CLEANUP_LOCK_NAMESPACE } from '../../lib/db/advisory-locks.ts'

// ---------------------------------------------------------------------------
// Errors. All safety aborts share a base class so a caller can tell a refusal
// to act from an ordinary transport failure.
// ---------------------------------------------------------------------------
export class SafetyViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
/** A write was attempted without --apply. This is a programming error, not an operator error. */
export class WriteWithoutApplyError extends SafetyViolationError {}
/** The connected organisation is not the expected one. */
export class TenantMismatchError extends SafetyViolationError {}
/** A read could not be proven complete, so nothing downstream may treat it as the whole set. */
export class ReadIncompleteError extends SafetyViolationError {}
/** Something that looks like a fixture but does not match the grammar exactly. */
export class AmbiguousSelectionError extends SafetyViolationError {}
/** A planned object is not covered by the reviewed manifest, or has moved since it was reviewed. */
export class ManifestViolationError extends SafetyViolationError {}
/** A live object no longer matches the plan that was reviewed. */
export class PlanDivergedError extends SafetyViolationError {}
/**
 * The call budget ran out. It is its own class because it is one of only two failures that are
 * known to happen BEFORE anything leaves this process — which is the only circumstance in which a
 * write may be recorded as "not dispatched" rather than as an unknown outcome.
 */
export class CallCeilingError extends SafetyViolationError {}
/**
 * A write left this process and its outcome could not be determined. It is a SafetyViolationError
 * because the run must stop: after this, nothing in the process knows what the ledger contains.
 */
export class WriteOutcomeUnknownError extends SafetyViolationError {}
/**
 * A write was DISPATCHED and this process knows what became of it, but could not record that
 * anywhere durable.
 *
 * It is its own class because it is the one failure where the process's own memory is the last
 * copy of the answer. The intent is on disk and in the shared fence with no settlement against it,
 * so the next run — on this host or any other — will refuse to start; what it needs in order to be
 * unblocked is the outcome, and the outcome exists only in this run's banner. Suppressing it, which
 * is what a settlement failure used to do by throwing past the journal, leaves the durable record
 * saying that something was attempted and nothing about what happened to it.
 */
export class WriteSettlementNotRecordedError extends SafetyViolationError {}

/**
 * Xero rate-limited a WRITE, and the write is therefore refused rather than retried.
 *
 * An authorisation must not outlive its window. Every write in this tooling is authorised
 * individually — re-read the object, confirm the unit, write — and that whole guarantee is about
 * the gap between the check and the write being as small as the process can make it. The transport
 * used to close a 429 by sleeping (up to 121s, up to `maxRateLimitRetries` times) and then
 * RE-DISPATCHING the same request. The retried write carries an authorisation minted before the
 * sleep: nothing re-read the object, nothing re-confirmed the unit, and the document may have been
 * re-contacted, re-allocated or edited by a person in Xero in the meantime. The first attempt was
 * safe — Xero's limiter refuses before applying — and that says nothing about the second.
 *
 * So a rate-limited write is REFUSED, not retried, and this is the refusal. It is safe to treat as
 * a clean stop: 429 is an answer from Xero's own application layer declining the request, so it is
 * `not-committed` by the same rule as a 400 or a 404 — the ledger is unchanged and the write log
 * records it as such, leaving nothing for the next run to account for.
 *
 * The cost is a re-run, and it was always a re-run: the retry was bounded, so an endpoint that
 * stays limited ended in a throw anyway. Refusing at the FIRST 429 buys the same outcome without
 * ever dispatching a write on a stale check. Re-running re-reads everything, which is exactly the
 * re-authorisation a retry cannot do — the transport is below the manifest, the journal and the
 * unit, and has nothing to re-authorise against.
 */
export class WriteRateLimitedError extends SafetyViolationError {
  /** Xero refused it. Carried so `performWrite` settles the log from the same classifier. */
  readonly commit: WriteCommit = classifyWriteOutcome({ status: 429 })
}

// ---------------------------------------------------------------------------
// 3. SELECTION — the exact fixture naming grammar
// ---------------------------------------------------------------------------
/**
 * The full-chain harness builds its Woo customer as
 *   `first_name: 'E2E', last_name: runTag(runId)`      e2e/full-chain/harness/wc.ts:122
 *   `runTag(runId) === 'E2E-FC-' + runId`              e2e/full-chain/harness/tag.ts:23-28
 *   `runId === base36(Date.now()) + 4 random base36`   e2e/full-chain/harness/tag.ts:15-21
 * which Xero renders as the contact name `E2E E2E-FC-<runId>`. All 111 contacts in the live
 * footprint match this exactly (verified against xero-live-e2e-footprint-20260810.csv).
 *
 * A namespace prefix would not do. `'E2E'` also matches `E2ENetworks Ltd`; `'E2E '` — the
 * correction made on the first pass — still matches `E2E Consulting Ltd`. Both are plausible names
 * for a real supplier, and the script VOIDS what it matches. Only the full grammar is safe.
 */
export const FIXTURE_CONTACT_NAME = /^E2E E2E-FC-[0-9a-z]+$/

/**
 * `taggedSku` is `E2E-FC-<RUNID>-<LABEL>` upper-cased (tag.ts:31-33), e.g.
 * `E2E-FC-MRMDZZHZHGDF-SMOKE`. All 217 items in the live footprint match. The bare `E2E-`
 * namespace does not qualify on its own.
 */
export const FIXTURE_ITEM_CODE = /^E2E-FC-[0-9A-Z]+(?:-[0-9A-Z]+)+$/

/** Anything carrying the token at all — the trip-wire for a near miss. */
const LOOKS_LIKE_E2E = /e2e/i

export type SelectionClass =
  /** Matches the fixture grammar exactly. Safe to mutate, subject to the manifest. */
  | 'fixture'
  /** Carries the E2E token but is not the fixture grammar. NEVER mutated; aborts the run. */
  | 'near-miss'
  /** Nothing to do with the fixtures. */
  | 'unrelated'

export function classifyContactName(name?: string | null): SelectionClass {
  if (!name) return 'unrelated'
  if (FIXTURE_CONTACT_NAME.test(name)) return 'fixture'
  return LOOKS_LIKE_E2E.test(name) ? 'near-miss' : 'unrelated'
}

export function classifyItemCode(code?: string | null): SelectionClass {
  if (!code) return 'unrelated'
  if (FIXTURE_ITEM_CODE.test(code)) return 'fixture'
  return LOOKS_LIKE_E2E.test(code) ? 'near-miss' : 'unrelated'
}

/** The only predicate that may gate a write. Exact grammar, nothing else. */
export const isFixtureContactName = (name?: string | null): boolean => classifyContactName(name) === 'fixture'
export const isFixtureItemCode = (code?: string | null): boolean => classifyItemCode(code) === 'fixture'

/**
 * A near miss is not a judgement call to be made at 2am against a live ledger. If the server-side
 * `StartsWith` filter hands back anything that is E2E-ish but not the exact fixture form, the whole
 * run stops so a human can look at it.
 */
export function assertNoNearMisses(
  labelled: Array<{ label: string; value?: string | null }>,
  classify: (v?: string | null) => SelectionClass,
  what: string,
): void {
  const nearMisses = labelled.filter((x) => classify(x.value) === 'near-miss')
  if (nearMisses.length === 0) return
  const shown = nearMisses.slice(0, 10).map((x) => `${x.label} => ${JSON.stringify(x.value)}`)
  throw new AmbiguousSelectionError(
    `ABORT: ${nearMisses.length} ${what} carry the E2E token but do not match the fixture grammar, ` +
      `so they are NOT provably test residue:\n  ${shown.join('\n  ')}` +
      (nearMisses.length > shown.length ? `\n  ... and ${nearMisses.length - shown.length} more` : '') +
      `\nResolve these by hand. Nothing was written.`,
  )
}

// ---------------------------------------------------------------------------
// 1. TRANSPORT — the write gate
// ---------------------------------------------------------------------------
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Did a NON-GET request change the live ledger?
 *
 * `not-committed` is a claim ABOUT THE LEDGER, not a description of what this process received,
 * and the two are not the same thing. A request whose response was lost — a gateway timeout, a
 * dropped connection, a 502 from something in front of Xero — may have been applied in full. Xero
 * has no idempotency key on these endpoints and no "did you get this?" query, so nothing in this
 * process can tell an unapplied write from an applied one whose answer never arrived.
 *
 * Reporting that as nothing-written is the worst lie this tooling can tell on an irreversible
 * operation: the banner says the run was a no-op, so nobody goes and looks, and the next run
 * re-reads the object as untouched and voids it again — or, worse, treats the residue as evidence
 * that the object was never ours.
 *
 * So only an answer FROM XERO'S APPLICATION that rejects the request may be called not-committed.
 * Anything that leaves the outcome genuinely open is `unknown`, and `unknown` is a reportable
 * outcome: it aborts the run, names the object, and makes the banner say PARTIALLY APPLIED.
 */
export type WriteCommitState = 'committed' | 'not-committed' | 'unknown'
export type WriteCommit = { state: WriteCommitState; reason: string }

/**
 * The statuses that prove Xero itself refused the request before applying it: a validation
 * failure, a bad or unscoped token, a missing object, a wrong verb, a rate-limit refusal. Each is
 * an answer from the application, not from something standing in front of it.
 *
 * The list is deliberately an ALLOW-list. A status nobody thought about — a 3xx, a 418, a 520 from
 * a CDN — falls through to `unknown`, which costs an operator one manual check. The other default
 * costs a silent lie about a live ledger.
 */
const REJECTED_WITHOUT_APPLYING = new Set([400, 401, 403, 404, 405, 409, 412, 415, 422, 429])

export function classifyWriteOutcome(args: { status?: number; transportError?: string }): WriteCommit {
  const { status, transportError } = args
  if (transportError !== undefined) {
    return {
      state: 'unknown',
      reason: `the request left this process and no usable response came back (${transportError}); Xero may have applied it`,
    }
  }
  if (status !== undefined && status >= 200 && status < 300) {
    return { state: 'committed', reason: `Xero answered HTTP ${status}` }
  }
  if (status !== undefined && REJECTED_WITHOUT_APPLYING.has(status)) {
    return { state: 'not-committed', reason: `Xero refused the request with HTTP ${status}` }
  }
  return {
    state: 'unknown',
    reason:
      `HTTP ${status ?? '(none)'} is not an answer from Xero's application layer, so the write may have been ` +
      `applied before the response was lost`,
  }
}

/** `commit` is populated for every non-GET and is absent on reads, which cannot commit anything. */
export type XeroResult<T> = { ok: boolean; status: number; data?: T; error?: string; commit?: WriteCommit }
export type TransportToken = { accessToken: string; tenantId: string }

export type XeroTransport = {
  request<T>(token: TransportToken, method: HttpMethod, path: string, body?: unknown): Promise<XeroResult<T>>
  /** GET-only view of `request`, for the pagination helpers and anything that must not write. */
  reader(token: TransportToken): <T>(path: string) => Promise<XeroResult<T>>
  readonly callCount: number
}

export type TransportOptions = {
  /** FALSE unless the operator passed --apply. Defaulting this to false is part of the contract. */
  apply?: boolean
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxCalls?: number
  minIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
  /**
   * Consecutive 429s tolerated on one GET before giving up. It does not apply to writes: a
   * rate-limited write is refused outright, because a retry would carry an authorisation minted
   * before the sleep. See `WriteRateLimitedError`.
   */
  maxRateLimitRetries?: number
  /** Extra headers per request, e.g. If-Modified-Since. */
  headersFor?: (path: string) => Record<string, string>
}

const DEFAULT_BASE_URL = 'https://api.xero.com/api.xro/2.0'

export function createXeroTransport(options: TransportOptions = {}): XeroTransport {
  const {
    // `apply` defaults to FALSE. A caller that forgets to pass it gets a read-only transport, not
    // a live one — the failure direction has to be inert, because the other direction is a void.
    apply = false,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    maxCalls = 1500,
    minIntervalMs = 1100,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log = () => {},
    maxRateLimitRetries = 5,
    headersFor,
  } = options

  let callCount = 0
  let lastCallAt = 0

  async function request<T>(token: TransportToken, method: HttpMethod, path: string, body?: unknown, rateLimitRetries = 0): Promise<XeroResult<T>> {
    // FIRST, before pacing, before any network work: a non-GET without --apply never happens.
    // This is the last line of defence, so it throws rather than returning an error result — a
    // caller cannot accidentally ignore it the way it can ignore `{ ok: false }`.
    if (method !== 'GET' && !apply) {
      throw new WriteWithoutApplyError(`BUG: attempted ${method} ${path} without --apply`)
    }
    if (callCount >= maxCalls) throw new CallCeilingError(`API call ceiling (${maxCalls}) reached`)

    const wait = minIntervalMs - (now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    callCount++
    lastCallAt = now()

    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token.accessToken}`,
          'Xero-Tenant-Id': token.tenantId,
          'Accept': 'application/json',
          ...(headersFor?.(path) ?? {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      // A GET that never got an answer is just a failed read, and every caller already refuses to
      // treat a failed read as data — so it keeps throwing. A WRITE that never got an answer is a
      // different fact about the world: the bytes left this process, and Xero may have applied
      // them. That cannot surface as `{ ok: false }`, because every caller reads `ok: false` as
      // "nothing happened".
      if (method === 'GET') throw e
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, status: 0, error: message, commit: classifyWriteOutcome({ transportError: message }) }
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '0')
      // A WRITE IS NEVER RE-DISPATCHED. See `WriteRateLimitedError`: the authorisation for this
      // write was granted before the sleep, and a retry would spend it on state nobody re-checked.
      // This is checked FIRST, so a rate-limited write never sleeps at all.
      if (method !== 'GET') {
        throw new WriteRateLimitedError(
          `ABORT: Xero rate-limited ${method} ${path} (HTTP 429, Retry-After ${retryAfter || 'unset'}s) after ${callCount} calls.\n` +
            `THE WRITE WAS REFUSED AND THE LEDGER IS UNCHANGED — 429 is Xero's own application layer declining ` +
            `the request before applying it.\n` +
            `It is NOT retried: this write was authorised by a re-read taken immediately before it, and that ` +
            `authorisation does not survive the wait. Re-run once the limit has cleared, from a FRESH manifest, ` +
            `so the write is authorised by a read taken next to it.`,
        )
      }
      // The daily cap's Retry-After is measured in HOURS. Sleeping on it is indistinguishable from
      // a hung script, so surface it instead.
      if (retryAfter > 120) throw new Error(`Rate limited; Retry-After ${retryAfter}s after ${callCount} calls`)
      // Bounded. The retry refunds the budget (`callCount--`) so that a rate-limited call does not
      // eat the ceiling — which means an endpoint stuck at 429 would otherwise retry forever, and
      // `maxCalls` could never stop it.
      if (rateLimitRetries >= maxRateLimitRetries) {
        throw new Error(`Rate limited ${maxRateLimitRetries} times in a row on ${method} ${path}; giving up after ${callCount} calls`)
      }
      log(`  rate limited, sleeping ${retryAfter}s...`)
      await sleep((retryAfter + 1) * 1000)
      callCount--
      return request<T>(token, method, path, body, rateLimitRetries + 1)
    }

    // The commit state is a function of the STATUS alone, so it is settled before the body is
    // read: a write that Xero answered 2xx has landed whether or not we can parse what came back.
    const commit = method === 'GET' ? undefined : classifyWriteOutcome({ status: res.status })

    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (method === 'GET') throw e
      const message = e instanceof Error ? e.message : String(e)
      // The status already told us whether it committed; losing the body does not undo that.
      return { ok: commit!.state === 'committed', status: res.status, error: `response body unreadable: ${message}`, commit }
    }

    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300), commit }
    if (!text) return { ok: true, status: res.status, commit }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T, commit }
    } catch {
      // A 200 that is not JSON is not a successful READ. Returning ok:true for a GET here is how a
      // garbage response becomes "the collection is empty", which is how absence gets manufactured.
      //
      // A WRITE is the opposite case and must not be folded into it. Xero answered 2xx, so the
      // change is in the ledger; only the echoed object is unreadable. Reporting that as
      // `ok: false` is the same lie as reporting a lost response as nothing-written, so the write
      // keeps its committed state and merely carries the unreadable body as an error string.
      const error = `Non-JSON response: ${text.slice(0, 200)}`
      if (commit) return { ok: commit.state === 'committed', status: res.status, error, commit }
      return { ok: false, status: res.status, error }
    }
  }

  return {
    request,
    reader(token: TransportToken) {
      return <T>(path: string) => request<T>(token, 'GET', path)
    },
    get callCount() {
      return callCount
    },
  }
}

// ---------------------------------------------------------------------------
// 2. TENANT
// ---------------------------------------------------------------------------
export function assertExpectedTenant(args: {
  tokenTenantId: string
  organisationName?: string
  expectedTenantId: string
  expectedTenantName: string
}): void {
  const { tokenTenantId, organisationName, expectedTenantId, expectedTenantName } = args
  if (tokenTenantId !== expectedTenantId || organisationName !== expectedTenantName) {
    throw new TenantMismatchError(
      `ABORT: connected to "${organisationName ?? '(unknown)'}" (${tokenTenantId}), ` +
        `expected ${expectedTenantName} (${expectedTenantId})`,
    )
  }
}

// ---------------------------------------------------------------------------
// 5. COMPLETENESS — pagination that cannot silently under-report
// ---------------------------------------------------------------------------
export type Reader = <T>(path: string) => Promise<XeroResult<T>>

/**
 * Page a Xero collection to proven completeness.
 *
 * Three distinct endings, and only one of them is "done":
 *
 *   • an EMPTY `key` array         — the collection is exhausted. This is the ONLY success, and it
 *     is the only ending in which the server has told us there is nothing more.
 *   • a page of only already-seen ids — the walk cannot ADVANCE. `page` is being ignored (Xero
 *     drops unknown query params rather than rejecting them), so every request re-serves the same
 *     rows. This was previously treated as completeness, on the reasoning that page 1 must
 *     therefore have been the whole collection. It is the reverse: an UNPAGED Xero GET is silently
 *     truncated to the oldest 100 rows, so a server stuck on page 1 is exactly the shape of a
 *     collection we have only seen the beginning of. Treating a repeat as proof of enumeration
 *     turns "paging is broken" into "there is nothing else" — the same inversion as reading an
 *     unparseable body as an empty one. It is INCOMPLETE, and it has to be recognised as such or
 *     the walk also spins to the ceiling.
 *   • anything else                — a non-2xx page, a 2xx whose body is not a Xero collection
 *     envelope carrying `key` as an ARRAY, or the page ceiling. NOT complete, so it throws. The
 *     previous implementation `break`-ed on a failed page and returned the partial accumulation as
 *     if it were the whole set, which is what let a failed read become a partial irreversible
 *     apply.
 *
 * The body-shape check is the same defect as the failed page wearing different clothes. `res.data?.
 * [key] ?? []` cannot tell `{"Invoices":[]}` — Xero saying the collection is exhausted — from a
 * 200 carrying an HTML error page, a proxy's `{"message":"..."}`, an empty body, or a response
 * whose collection key we spelled wrong. All four used to read as "nothing there", and "nothing
 * there" is what stops the walk, truncates the manifest, and leaves live objects behind while the
 * run reports success. A response we cannot parse says NOTHING about the collection.
 *
 * It deliberately does NOT stop on a short-but-non-empty page: the page size is not a guarantee,
 * and treating "fewer than 100" as terminal is the same class of mistake as trusting an ignored
 * filter. That assumption is exactly what makes the manual-journal `NOT_FOUND` unsound.
 */
/**
 * Turn a 2xx page into either the collection it claims to be, or a REASON it is not one.
 *
 * Shared, because the "empty means exhausted" defect had two homes: this file's pager and the
 * manual-journal sweep in audit-xero-live-contamination.ts, which set `pagingComplete = true` on a
 * body it could not read. Fixing one and leaving the other is how the 429 defect survived three
 * copies of the same client. The callers differ in what they DO about it — the pager throws, the
 * journal sweep marks the enumeration incomplete and falls through to per-id confirmation — but
 * neither may treat an unreadable body as an answer.
 */
export type CollectionPage<T> = { ok: true; rows: T[] } | { ok: false; reason: string }

export function parseCollectionPage<T>(data: unknown, key: string): CollectionPage<T> {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      reason: `the body is not a Xero collection envelope (${data === undefined ? 'no body' : Array.isArray(data) ? 'a bare array' : typeof data})`,
    }
  }
  const rows = (data as Record<string, unknown>)[key]
  if (!Array.isArray(rows)) {
    const keys = Object.keys(data as Record<string, unknown>)
    return { ok: false, reason: `no \`${key}\` array (top-level keys: ${keys.length ? keys.join(', ') : 'none'})` }
  }
  return { ok: true, rows: rows as T[] }
}

/**
 * One page of a walk, classified. THE decision, in one place, because it had two homes and the
 * same defect appeared in both: this file's pager and the manual-journal sweep in
 * audit-xero-live-contamination.ts, which each decided independently what "the walk is finished"
 * means. Fixing one and leaving the other is how the 429 defect survived three copies of the same
 * client, and how the repeated-page inversion survived two fixes to `pagingComplete`.
 *
 * The callers still differ in what they DO about an incomplete walk — the pager throws, the
 * journal sweep marks the enumeration incomplete and falls through to per-id confirmation — but
 * neither of them gets to decide what completeness IS.
 */
export type PageStep<T> =
  /** New rows. The walk advanced; ask for the next page. */
  | { kind: 'rows'; rows: T[] }
  /** An empty collection array. The ONLY ending that means the collection was fully enumerated. */
  | { kind: 'exhausted' }
  /** The walk stopped without being finished. `reason` is written to be read by an operator. */
  | { kind: 'incomplete'; reason: string }

export function classifyPage<T>(args: {
  res: { ok: boolean; status: number; error?: string; data?: unknown }
  path: string
  key: string
  page: number
  idOf: (row: T) => string
  seen: ReadonlySet<string>
}): PageStep<T> {
  const { res, path, key, page, idOf, seen } = args
  if (!res.ok) {
    return {
      kind: 'incomplete',
      reason: `${path} page ${page} failed (HTTP ${res.status}${res.error ? `: ${res.error}` : ''})`,
    }
  }
  // A 2xx is not by itself a read. The body has to be a collection envelope carrying `key` as an
  // array before "the array is empty" is allowed to mean the collection is exhausted.
  const parsed = parseCollectionPage<T>(res.data, key)
  if (!parsed.ok) {
    return {
      kind: 'incomplete',
      reason:
        `${path} page ${page} answered HTTP ${res.status} but ${parsed.reason}. A response that cannot be ` +
        `parsed says nothing about the collection — it is NOT an empty one`,
    }
  }
  if (parsed.rows.length === 0) return { kind: 'exhausted' }

  // Deduplicated against what the walk has already collected AND within the page itself: a page
  // that repeats an id twice must not put it in the result twice.
  const fresh: T[] = []
  const freshIds = new Set<string>()
  for (const row of parsed.rows) {
    const id = idOf(row)
    if (seen.has(id) || freshIds.has(id)) continue
    freshIds.add(id)
    fresh.push(row)
  }
  if (fresh.length === 0) {
    // Every id on this page has been seen before, so the walk cannot advance. What that proves is
    // that `page` is not being honoured — NOT that the collection ended. An unpaged Xero GET is
    // silently truncated to the oldest 100 rows, so "the server keeps answering with the same
    // rows" is precisely the shape of a collection whose tail we have never been shown. The
    // previous version returned what it had and called it complete, which would have let a server
    // stuck on page 1 be read as a fully enumerated ledger.
    return {
      kind: 'incomplete',
      reason:
        `${path} page ${page} returned only rows already seen on page ${page - 1}. \`page\` is being ignored, ` +
        `so the walk cannot advance — and an unpaged Xero collection is silently truncated to the oldest 100 ` +
        `rows, so this is evidence of a TRUNCATED read, not of a complete one`,
    }
  }
  return { kind: 'rows', rows: fresh }
}

export async function pageAllComplete<T>(args: {
  read: Reader
  path: string
  key: string
  idOf: (row: T) => string
  maxPages?: number
  log?: (m: string) => void
}): Promise<T[]> {
  const { read, path, key, idOf, maxPages = 25, log = () => {} } = args
  const seen = new Set<string>()
  const out: T[] = []

  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await read<Record<string, T[]>>(`${path}${sep}page=${page}`)
    const step = classifyPage<T>({ res, path, key, page, idOf, seen })
    if (step.kind === 'incomplete') {
      log(`  ! ${step.reason}`)
      throw new ReadIncompleteError(
        `ABORT: ${step.reason}. The read is incomplete, so no plan built from it can be trusted. Nothing was written.`,
      )
    }
    if (step.kind === 'exhausted') return out
    for (const row of step.rows) {
      seen.add(idOf(row))
      out.push(row)
    }
  }

  throw new ReadIncompleteError(
    `ABORT: ${path} hit the ${maxPages}-page ceiling without an empty page. The read is incomplete ` +
      `and indistinguishable from completion. Raise the ceiling deliberately or narrow the query. Nothing was written.`,
  )
}

// ---------------------------------------------------------------------------
// BLOCKERS — one grammar, shared by the audit that writes the manifest and the
// writer that is authorised by it
// ---------------------------------------------------------------------------
/**
 * A "blocker" is anything Xero requires released before a document can be voided: an allocation,
 * a payment, a refund. The manifest binds the blocker SET a human reviewed, so the audit and the
 * writer have to name blockers the same way — two spellings of the same allocation would make
 * every credit note look changed and reduce the check to noise, which is how a safety check gets
 * switched off.
 *
 * An allocation is named by the INVOICE it links to, not by its own AllocationID: the id is absent
 * from some collection responses, and a set of `allocation:?` entries collapses duplicates and
 * silently agrees with itself. The invoice id is always present and is what actually identifies
 * which link is being released.
 */
export type AllocationLike = { AllocationID?: string; Invoice?: { InvoiceID?: string } }
export type PaymentLike = { PaymentID?: string }
export type CreditNoteRefLike = { CreditNoteID?: string }

export const allocationBlocker = (a: AllocationLike): string =>
  `allocation:${a.Invoice?.InvoiceID ?? a.AllocationID ?? 'unidentified'}`

/** Blockers on a CREDIT NOTE: its allocations to invoices, and any refund paid against it. */
export function creditNoteBlockers(cn: { Allocations?: AllocationLike[]; Payments?: PaymentLike[] }): string[] {
  return [
    ...(cn.Allocations ?? []).map(allocationBlocker),
    ...(cn.Payments ?? []).map((p) => `refund:${p.PaymentID ?? 'unidentified'}`),
  ]
}

/** Blockers on an INVOICE: payments against it, and credit notes allocated to it. */
export function invoiceBlockers(inv: { Payments?: PaymentLike[]; CreditNotes?: CreditNoteRefLike[] }): string[] {
  return [
    ...(inv.Payments ?? []).map((p) => `payment:${p.PaymentID ?? 'unidentified'}`),
    ...(inv.CreditNotes ?? []).map((c) => `creditnote:${c.CreditNoteID ?? 'unidentified'}`),
  ]
}

/** The manifest's on-disk form: sorted so the CSV is order-insensitive by construction. */
export const formatBlockers = (blockers: string[]): string => [...blockers].sort().join(' ')
export const parseBlockers = (field: string): string[] => field.split(/\s+/).filter(Boolean)

// ---------------------------------------------------------------------------
// 4. MANIFEST — a reviewed, tenant-stamped record of objects AND their state
// ---------------------------------------------------------------------------
export type ManifestEntry = {
  uuid: string
  entity: string
  status: string
  contact: string
  number: string
  /** The blocker set as reviewed, in the shared grammar above. */
  blockers: string[]
  /** Xero's raw UpdatedDateUTC as reviewed. Any movement at all is divergence. */
  updatedDateUtc: string
}
export type WriteManifest = {
  tenantId: string
  entries: Map<string, ManifestEntry>
  countsByEntity: Map<string, number>
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Parse the reviewed manifest — the CSV that audit-xero-live-e2e-footprint.ts writes.
 *
 * The `tenantId` column is mandatory and must be single-valued. Without a tenant stamp a manifest
 * is just a list of uuids, and o3d-s36z (nothing records which organisation an id belongs to) is
 * precisely the defect that produced this incident: 553 ids that read as live-org objects and were
 * not. A manifest that cannot say which org it describes may not authorise a write.
 *
 * The STATE columns — status, contact, blockers, updatedDateUtc — are mandatory for the same
 * reason and are just as load-bearing. A manifest of bare uuids authorises "you may act on these
 * objects" forever; what a human actually signed off is "you may act on these objects AS THEY ARE
 * NOW". A credit note reviewed as SUBMITTED (not posted, no GL effect, deletable) and since
 * APPROVED by a person is a different object with the same uuid, and its removal is now a real
 * ledger change. A manifest that cannot state what was reviewed cannot authorise the write, so an
 * older CSV without these columns is refused rather than accepted at reduced strength.
 */
export function parseWriteManifest(csvText: string): WriteManifest {
  const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new ManifestViolationError('ABORT: the manifest is empty.')
  const header = splitCsvLine(lines[0])
  const col = (name: string) => header.indexOf(name)
  const iTenant = col('tenantId')
  const iUuid = col('uuid')
  const iEntity = col('entity')
  if (iTenant < 0) {
    throw new ManifestViolationError(
      'ABORT: the manifest has no tenantId column, so it cannot say which organisation it describes. ' +
        'Regenerate it with audit-xero-live-e2e-footprint.ts.',
    )
  }
  if (iUuid < 0 || iEntity < 0) throw new ManifestViolationError('ABORT: the manifest needs uuid and entity columns.')
  const iStatus = col('status')
  const iContact = col('contact')
  const iNumber = col('number')
  const iBlockers = col('blockers')
  const iUpdated = col('updatedDateUtc')
  // The state columns are what turn a list of uuids into an authorisation. Missing columns are
  // refused rather than defaulted: an empty string would compare equal to an object that genuinely
  // has no blockers, and the check would pass by accident on exactly the manifests it cannot cover.
  const missingState = [
    iStatus < 0 ? 'status' : null,
    iContact < 0 ? 'contact' : null,
    iBlockers < 0 ? 'blockers' : null,
    iUpdated < 0 ? 'updatedDateUtc' : null,
  ].filter(Boolean)
  if (missingState.length) {
    throw new ManifestViolationError(
      `ABORT: the manifest has no ${missingState.join(', ')} column(s), so it records WHICH objects were ` +
        'reviewed but not WHAT STATE they were reviewed in. A uuid on its own authorises acting on an object ' +
        'that a human has since approved, paid or re-contacted. Regenerate the manifest with ' +
        'scripts/audit-xero-live-e2e-footprint.ts and review it again.',
    )
  }

  const entries = new Map<string, ManifestEntry>()
  const countsByEntity = new Map<string, number>()
  const tenants = new Set<string>()

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line)
    const tenantId = (f[iTenant] ?? '').trim()
    const uuid = (f[iUuid] ?? '').trim()
    if (!uuid) continue
    if (!tenantId) throw new ManifestViolationError(`ABORT: manifest row ${uuid} has no tenantId.`)
    tenants.add(tenantId)
    const entity = (f[iEntity] ?? '').trim()
    entries.set(uuid, {
      uuid,
      entity,
      status: (f[iStatus] ?? '').trim(),
      contact: (f[iContact] ?? '').trim(),
      number: iNumber >= 0 ? (f[iNumber] ?? '').trim() : '',
      blockers: parseBlockers((f[iBlockers] ?? '').trim()),
      updatedDateUtc: (f[iUpdated] ?? '').trim(),
    })
    countsByEntity.set(entity, (countsByEntity.get(entity) ?? 0) + 1)
  }

  if (tenants.size !== 1) {
    throw new ManifestViolationError(
      `ABORT: the manifest spans ${tenants.size} tenants (${[...tenants].join(', ')}). One manifest, one organisation.`,
    )
  }
  if (entries.size === 0) throw new ManifestViolationError('ABORT: the manifest has no rows.')
  return { tenantId: [...tenants][0], entries, countsByEntity }
}

export function assertManifestTenant(manifest: WriteManifest, expectedTenantId: string): void {
  if (manifest.tenantId !== expectedTenantId) {
    throw new ManifestViolationError(
      `ABORT: the manifest describes tenant ${manifest.tenantId}, but this run is connected to ${expectedTenantId}.`,
    )
  }
}

/** An object as the live plan read it, in the same terms the manifest records. */
export type PlannedObject = {
  uuid: string
  entity: string
  /** Human-facing name for the error message — invoice number, contact name, item code. */
  label: string
  status: string
  contactName?: string
  blockers?: string[]
  updatedDateUtc?: string
}

/**
 * Nothing gets mutated unless a human already looked at it — AT THIS STATE.
 *
 * Two separate refusals, and the second is the one that was missing:
 *
 *   • IDENTITY. A planned object that is NOT in the manifest is FATAL. It appeared after the
 *     review, so nobody has agreed it is test residue. (A manifest id no longer present live is
 *     fine — it was already cleaned up, or never existed. That asymmetry is deliberate.)
 *
 *   • STATE. A planned object whose status, contact, blocker set or UpdatedDateUTC differs from
 *     the manifest is FATAL. Binding only the uuid authorises an object that has moved since a
 *     human looked at it: a credit note reviewed as SUBMITTED and since APPROVED by a person, an
 *     invoice re-contacted to a genuine customer, a document that has since been paid, or one that
 *     picked up an allocation nobody in this run created. All of those keep their uuid, all of them
 *     pass an id-only check, and all of them are irreversible when acted on. UpdatedDateUTC is
 *     compared as the catch-all: it moves for changes none of the other columns can express.
 *
 * This runs against the PLAN — the complete read taken at the start of the apply — so it fires
 * once, before the first mutation, rather than after part of the ledger has already been destroyed.
 */
export function assertPlanAuthorizedByManifest(
  plan: PlannedObject[],
  manifest: WriteManifest,
): { covered: number; missingFromLedger: string[] } {
  const unreviewed = plan.filter((p) => !manifest.entries.has(p.uuid))
  if (unreviewed.length) {
    const shown = unreviewed.slice(0, 10).map((p) => `${p.entity} ${p.label} (${p.uuid})`)
    throw new ManifestViolationError(
      `ABORT: ${unreviewed.length} object(s) selected against the live ledger are NOT in the reviewed manifest:\n  ` +
        shown.join('\n  ') +
        (unreviewed.length > shown.length ? `\n  ... and ${unreviewed.length - shown.length} more` : '') +
        `\nThey appeared after the manifest was produced. Re-run the read-only footprint audit, review it, ` +
        `and pass the new manifest. Nothing was written.`,
    )
  }

  const diverged: string[] = []
  for (const p of plan) {
    const reviewed = manifest.entries.get(p.uuid)!
    const diffs: string[] = []
    if (reviewed.entity !== p.entity) diffs.push(`entity ${reviewed.entity} -> ${p.entity}`)
    if (reviewed.status !== p.status) diffs.push(`status ${reviewed.status || '(none)'} -> ${p.status || '(none)'}`)
    if (reviewed.contact !== (p.contactName ?? '')) {
      diffs.push(`contact ${JSON.stringify(reviewed.contact)} -> ${JSON.stringify(p.contactName ?? '')}`)
    }
    if (normaliseBlockers(reviewed.blockers) !== normaliseBlockers(p.blockers)) {
      diffs.push(`blockers [${normaliseBlockers(reviewed.blockers)}] -> [${normaliseBlockers(p.blockers)}]`)
    }
    if (reviewed.updatedDateUtc !== (p.updatedDateUtc ?? '')) {
      diffs.push(`updatedDateUTC ${reviewed.updatedDateUtc || '(none)'} -> ${p.updatedDateUtc || '(none)'}`)
    }
    if (diffs.length) diverged.push(`${p.entity} ${p.label} (${p.uuid}): ${diffs.join('; ')}`)
  }
  if (diverged.length) {
    const shown = diverged.slice(0, 10)
    throw new ManifestViolationError(
      `ABORT: ${diverged.length} object(s) are in the manifest but are NO LONGER IN THE STATE THAT WAS REVIEWED:\n  ` +
        shown.join('\n  ') +
        (diverged.length > shown.length ? `\n  ... and ${diverged.length - shown.length} more` : '') +
        `\nThe manifest authorises acting on these objects as they were when a human read the CSV, not on ` +
        `whatever they have become since. Something — a person approving a document, a payment, a re-contact — ` +
        `has changed them. Re-run the read-only footprint audit, review the new CSV, and pass that. Nothing was written.`,
    )
  }

  const planned = new Set(plan.map((p) => p.uuid))
  const missingFromLedger = [...manifest.entries.keys()].filter((id) => !planned.has(id))
  return { covered: plan.length, missingFromLedger }
}

// ---------------------------------------------------------------------------
// 6. REVALIDATION — the object about to be mutated is the object that was planned
// ---------------------------------------------------------------------------
export type RevalidationSubject = {
  id: string
  status: string
  contactName?: string
  /** Payment / allocation / credit-note ids that gate the transition, order-insensitive. */
  blockers?: string[]
  updatedDateUtc?: string
}

export type RevalidationExpectation = {
  id: string
  /**
   * Every status the object may legitimately be in when we reach it. It is a SET, not a single
   * value, because this script's own earlier steps move a document: releasing the allocations and
   * payments off a PAID document leaves it AUTHORISED. Only transitions THIS RUN ACTUALLY CAUSED
   * belong here — build it with `allowedStatusesAfterRun`, never with `statusesAfterReleasingBlockers`
   * directly, or the set admits the same transition when somebody else caused it.
   */
  allowedStatuses: string[]
  contactName?: string
  blockers?: string[]
  /**
   * 'exact'    — the blocker set must be unchanged (nothing has touched it yet).
   * 'released' — the live set may differ from the plan's ONLY by blockers this run itself released,
   *              listed in `releasedBlockers`. A blocker that appeared, or one that vanished
   *              without this run deleting it, means someone else is working on the document.
   */
  blockerPolicy?: 'exact' | 'released'
  /**
   * The blockers THIS RUN deleted off this object, recorded at the moment the DELETE succeeded.
   * Only meaningful under the 'released' policy. Anything not in here that has gone missing was
   * removed by somebody else.
   */
  releasedBlockers?: string[]
  /**
   * The catch-all. REQUIRED — deliberately not optional — because the defect this replaces was a
   * call site that simply left `updatedDateUtc` out, and an optional field that is absent looks
   * exactly like a field that matched. Making it required means the only way to skip the version
   * check is to write down which exemption you are claiming, in code, where a reviewer sees it.
   */
  version: VersionExpectation
}

/**
 * What the object's version — Xero's UpdatedDateUTC — must look like at the moment of the write.
 *
 * UpdatedDateUTC is the catch-all: it moves for every change, including the ones status, contact
 * and blockers cannot express (a line item edited, an account or tax rate changed, a reference or
 * due date altered, a tracking category attached). Checking status/contact/blockers and not this
 * is checking the changes we thought of and waving through the ones we did not.
 */
export type VersionExpectation =
  /**
   * Nothing in this run has written to the object, so its version must be BYTE-IDENTICAL to the
   * one that was planned and reviewed. This is the normal case and it is the strong one.
   */
  | { policy: 'unchanged'; updatedDateUtc: string }
  /**
   * THIS RUN wrote to the object in an earlier step, so byte-equality with the REVIEWED version is
   * arithmetically impossible — and Xero, answering that write, reported the version its own change
   * produced. The object must be at THAT version. It is exact equality again, just against the
   * state OUR write left behind instead of the state the human reviewed.
   *
   * This is a binding, not an exemption. The version is the fingerprint of the change we made, so
   * anything that has happened to the object since — including a forward change by somebody else,
   * in a dimension no other column covers — fails it.
   */
  | { policy: 'matches-our-write'; updatedDateUtc: string; because: string[] }
  /**
   * THIS RUN wrote to the object and Xero's response did NOT report the version its change
   * produced, so there is no version to hold the next write to. This policy ALWAYS diverges.
   *
   * The policy this replaces said: the version may move FORWARDS, because this run moved
   * something. That is not evidence the forward movement is ours — it authorises unrelated forward
   * changes. "The version moved and we moved something" admits a third party's edit (a line
   * changed, an account swapped, a tracking category attached, a due date altered) on the very
   * document we are about to irreversibly void, because our own write supplies the alibi for
   * someone else's. A narrowed residual is still an authorisation.
   *
   * Nothing can establish our own change here without writing to live, so the exemption is not
   * granted blind: it is withdrawn. The run refuses and the operator re-runs the read-only audit,
   * reviews the fresh CSV and applies the remaining steps from it. The writes already made stand.
   * A RE-RUN IS THE COST, and it is the cheaper of the two mistakes available.
   */
  | { policy: 'unestablished'; plannedUpdatedDateUtc: string; because: string[] }

/**
 * Xero returns timestamps in two shapes on the same API — `/Date(1613486114757+0000)/` on the
 * collection endpoints and an ISO string with no zone on others — so ordering them by string
 * comparison is wrong for one of them and silently wrong for both when they are mixed.
 * Unparseable is `null`, and every caller treats null as "cannot be checked", never as "fine".
 */
export function parseXeroTimestamp(value?: string | null): number | null {
  if (!value) return null
  const trimmed = value.trim()
  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(trimmed)
  if (dotNet) return Number(dotNet[1])
  // An ISO stamp with no zone is UTC — Xero's field is literally named UpdatedDateUTC — so it is
  // pinned to UTC rather than left to the local timezone of whatever machine runs the script.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed}Z`
  const parsed = Date.parse(zoned)
  return Number.isFinite(parsed) ? parsed : null
}

function normaliseBlockers(b?: string[]): string {
  return [...(b ?? [])].sort().join(' ')
}

/**
 * The version half of `assertUnchanged`, kept separate only because it is the part that was
 * missing. Every path returns a DIFFERENCE or nothing; there is no path that returns "could not
 * check" as if it were "checked and fine", which is what an optional field bought us before.
 */
function versionDiffs(expected: VersionExpectation | undefined, liveVersion?: string): string[] {
  if (!expected) {
    // Unreachable through the type system — `version` is required — and handled anyway. The whole
    // defect was a missing field being read as a satisfied one, and the type checker is not the
    // only way a call site can arrive here.
    return [
      'this call site supplied no version expectation at all, so the catch-all was never checked. ' +
      'That is the defect itself, not a state to proceed from',
    ]
  }
  if (!liveVersion) {
    return [
      'the re-read carries no UpdatedDateUTC, so the version this write was authorised against ' +
      'cannot be checked at all — an unreadable version is not a matching one',
    ]
  }
  if (expected.policy === 'unchanged') {
    if (!expected.updatedDateUtc) {
      return [
        'the reviewed plan carries no UpdatedDateUTC for this object, so there is no version to ' +
        'hold the write to. Re-run the read-only audit and review a plan that has one',
      ]
    }
    return expected.updatedDateUtc === liveVersion
      ? []
      : [`updatedDateUTC ${expected.updatedDateUtc} -> ${liveVersion}`]
  }
  if (expected.policy === 'matches-our-write') {
    if (!expected.updatedDateUtc) {
      // Belt and braces: an empty binding is not a binding. A caller that reaches here has failed
      // to record what its own write produced, which is the 'unestablished' case wearing the
      // stronger policy's name, and it is refused as such rather than passing on a blank compare.
      return [
        'this run wrote to the object but recorded no resulting version for it, so there is nothing ' +
        'for the write to be held to. That is an UNESTABLISHED version, not a satisfied one',
      ]
    }
    return expected.updatedDateUtc === liveVersion
      ? []
      : [
        `updatedDateUTC ${expected.updatedDateUtc} -> ${liveVersion}: this run's own write left the object at ` +
        `${expected.updatedDateUtc} (${expected.because.join(', ') || 'no released blocker recorded'}), and it has ` +
        `moved AGAIN since. That second change is not ours`,
      ]
  }
  // 'unestablished' — always a divergence. See the type above for why this is a refusal rather
  // than a check: there is nothing here to compare that would mean anything.
  return [
    `this run wrote to the object (${expected.because.join(', ') || 'no released blocker recorded'}) and Xero's ` +
    `response did not report the version its change produced. The reviewed version ` +
    `${JSON.stringify(expected.plannedUpdatedDateUtc)} therefore no longer applies, and no other version is ` +
    `attributable to us. "It moved forwards and we moved something" is not evidence the movement is ours, so no ` +
    `exemption is granted: re-run the read-only footprint audit, review the fresh CSV, and apply the remaining ` +
    `steps from it. The writes already made stand — a RE-RUN IS THE COST of this refusal`,
  ]
}

/** Releasing every blocker off a PAID document leaves it AUTHORISED; nothing else moves. */
export function statusesAfterReleasingBlockers(plannedStatus: string): string[] {
  return plannedStatus === 'PAID' ? ['PAID', 'AUTHORISED'] : [plannedStatus]
}

/**
 * The statuses a document may be in by the time this run reaches it — CONDITIONAL ON THIS RUN
 * HAVING CAUSED THE MOVE.
 *
 * `statusesAfterReleasingBlockers` answers "what could this transition produce". That is a
 * different question from "is this transition explained", and using the first as the answer to the
 * second is how a permissive set gets written: PAID -> AUTHORISED is accepted whether step 1 of
 * this run released the payment or a colleague did it by hand in the Xero UI two minutes ago,
 * while the plan we are about to void was already stale. The run knows which of those happened —
 * it recorded its own successful deletes — so the widened set is only offered when this run is the
 * reason the document could have moved. Otherwise the planned status is the only acceptable one.
 *
 * `thisRunReleasedABlocker` must come from the run's own journal of SUCCEEDED deletes, not from
 * intent: a delete that was attempted and failed explains nothing.
 */
export function allowedStatusesAfterRun(plannedStatus: string, thisRunReleasedABlocker: boolean): string[] {
  return thisRunReleasedABlocker ? statusesAfterReleasingBlockers(plannedStatus) : [plannedStatus]
}

/**
 * Compare the freshly re-read object against the reviewed plan and refuse the write on ANY
 * unexplained difference.
 *
 * The failure this closes is not "Xero rejects an invalid transition". It is the opposite: someone
 * re-assigns a selected document to a genuine contact between the plan read and the write, the
 * document stays in a perfectly valid status, the stale cached `Contact.Name` still satisfies the
 * predicate, and Xero happily voids a real customer's invoice. That is a WRONG write, not a
 * rejected one, and it is irreversible.
 */
export function assertUnchanged(expected: RevalidationExpectation, live: RevalidationSubject | null | undefined): void {
  if (!live) {
    throw new PlanDivergedError(
      `ABORT: ${expected.id} could not be re-read immediately before mutating it. Nothing further was written.`,
    )
  }
  const diffs: string[] = []
  if (live.id !== expected.id) diffs.push(`id ${expected.id} -> ${live.id}`)
  if (!expected.allowedStatuses.includes(live.status)) {
    diffs.push(`status ${live.status} is not one of [${expected.allowedStatuses.join(', ')}]`)
  }
  if ((live.contactName ?? '') !== (expected.contactName ?? '')) {
    diffs.push(`contact ${JSON.stringify(expected.contactName ?? '')} -> ${JSON.stringify(live.contactName ?? '')}`)
  }
  const policy = expected.blockerPolicy ?? 'exact'
  if (policy === 'exact') {
    if (normaliseBlockers(live.blockers) !== normaliseBlockers(expected.blockers)) {
      diffs.push(`blockers [${normaliseBlockers(expected.blockers)}] -> [${normaliseBlockers(live.blockers)}]`)
    }
  } else {
    const plannedSet = new Set(expected.blockers ?? [])
    const liveSet = new Set(live.blockers ?? [])
    const added = [...liveSet].filter((b) => !plannedSet.has(b))
    if (added.length) diffs.push(`new blocker(s) appeared since the plan: ${added.join(', ')}`)
    // A blocker that has GONE is only acceptable if this run is the one that deleted it. The
    // permissive version of this check ("the live set may be any subset of the plan's") accepts a
    // colleague releasing a payment in the Xero UI as readily as it accepts step 1's own DELETE,
    // and then the widened status set accepts the resulting PAID -> AUTHORISED too. Between them
    // that is a document moving under the script and the script agreeing to void it anyway.
    const released = new Set(expected.releasedBlockers ?? [])
    const goneUnexplained = [...plannedSet].filter((b) => !liveSet.has(b) && !released.has(b))
    if (goneUnexplained.length) {
      diffs.push(
        `blocker(s) released by something other than this run: ${goneUnexplained.join(', ')}` +
          (released.size ? ` (this run released: ${[...released].sort().join(', ')})` : ' (this run released nothing here)'),
      )
    }
  }
  // The catch-all, checked HERE — at the write — because that is the only moment at which it
  // counts. The version was bound to the reviewed state one round ago and then dropped from the
  // final revalidation, which left the manifest check enforcing it minutes earlier while the
  // irreversible write enforced nothing.
  diffs.push(...versionDiffs(expected.version, live.updatedDateUtc))
  if (diffs.length === 0) return
  throw new PlanDivergedError(
    `ABORT: ${expected.id} changed between the reviewed plan and this write:\n  ${diffs.join('\n  ')}\n` +
      `The whole run stops — a ledger that is moving under the script is not one to keep writing to.`,
  )
}

/** The re-read must also still satisfy the selection grammar, not just match the plan. */
export function assertStillFixtureContact(id: string, liveContactName?: string): void {
  if (isFixtureContactName(liveContactName)) return
  throw new PlanDivergedError(
    `ABORT: ${id} is now contacted to ${JSON.stringify(liveContactName ?? '')}, which is not a full-chain ` +
      `fixture contact. Nothing further was written.`,
  )
}

// ---------------------------------------------------------------------------
// 7. OUTCOME — including the outcome of a run that threw part-way through
// ---------------------------------------------------------------------------
export type RunOutcome = { label: string; exitCode: number }

/**
 * A run that failed anywhere does not get to print APPLIED and exit 0. Partial destruction reported
 * as success is the single worst shape this tooling can take — and so is partial destruction
 * reported as nothing at all, which is what `aborted` exists for.
 *
 * `aborted` means the run threw: a safety guard refused, the ledger moved under it, the token
 * expired. `writesMade` is how many irreversible writes had already succeeded when that happened.
 * An abort after zero writes is a clean refusal; an abort after N writes is a PARTIAL APPLY, and
 * the operator has to be told so in the same breath as the error — otherwise the last thing on
 * screen is a stack-shaped message about one credit note and no indication that eighty invoices
 * are already voided.
 *
 * `unknownWrites` is the third state, and it is the one that used to be unrepresentable: a request
 * that left this process and never came back. An abort after zero KNOWN writes is only a clean
 * refusal if there are no unknown ones — otherwise "nothing was written" is a claim about a live
 * ledger that nothing in this process is entitled to make.
 */
export function runOutcome(args: {
  apply: boolean
  failed: number
  incomplete?: boolean
  aborted?: boolean
  writesMade?: number
  /**
   * Writes that LEFT THIS PROCESS and whose outcome could not be determined. They are not
   * failures and they are not successes; the one thing they may never do is disappear into
   * "nothing was written". A run with any of these is PARTIALLY APPLIED even if every write it
   * can account for succeeded.
   */
  unknownWrites?: number
  /**
   * Writes whose outcome THIS PROCESS ESTABLISHED but could not record durably. They are not
   * unknown — the answer is known — and they are not clean either: the durable stores hold an
   * intent with no settlement, so the next run is blocked and the answer that unblocks it exists
   * only in this run's output. A run with one of these may never print a label that ends the
   * story.
   */
  unrecordedSettlements?: number
}): RunOutcome {
  const {
    apply, failed, incomplete = false, aborted = false, writesMade = 0, unknownWrites = 0,
    unrecordedSettlements = 0,
  } = args
  const unknownSuffix = unknownWrites > 0 ? `${unknownWrites} WRITE(S) OF UNKNOWN OUTCOME` : ''
  const unrecordedSuffix = unrecordedSettlements > 0 ? `${unrecordedSettlements} UNRECORDED SETTLEMENT(S)` : ''
  if (!apply) {
    // A dry run cannot write at all — the transport throws on any non-GET without --apply — so an
    // unknown write here means the write gate itself has been bypassed. It is reported, loudly,
    // rather than being unrepresentable.
    if (aborted) {
      const dryTail = [unknownSuffix, unrecordedSuffix].filter(Boolean).join(' AND ')
      return { label: dryTail ? `DRY RUN — ABORTED WITH ${dryTail}` : 'DRY RUN — ABORTED', exitCode: 1 }
    }
    if (unknownSuffix) return { label: `DRY RUN — INCOMPLETE, ${unknownSuffix}`, exitCode: 1 }
    return { label: failed || incomplete ? 'DRY RUN — INCOMPLETE' : 'DRY RUN', exitCode: failed || incomplete ? 1 : 0 }
  }
  if (aborted) {
    // Appended rather than folded in, so every existing label keeps its exact wording: this is an
    // ADDITIONAL fact about the run, not a different reading of the ledger.
    const tail = unrecordedSuffix ? ` — AND ${unrecordedSuffix} THAT ONLY THIS OUTPUT RECORDS` : ''
    if (writesMade > 0 && unknownSuffix) {
      return { label: `PARTIALLY APPLIED — ABORTED AFTER ${writesMade} IRREVERSIBLE WRITE(S) AND ${unknownSuffix}${tail}`, exitCode: 1 }
    }
    if (writesMade > 0) return { label: `PARTIALLY APPLIED — ABORTED AFTER ${writesMade} IRREVERSIBLE WRITE(S)${tail}`, exitCode: 1 }
    // The lie this closes: a write that committed remotely and lost its response used to leave
    // `writesMade` at zero, so the last thing on screen said the run was a no-op.
    if (unknownSuffix) return { label: `PARTIALLY APPLIED — ABORTED WITH ${unknownSuffix}${tail}`, exitCode: 1 }
    // A write Xero REFUSED leaves the ledger unchanged, so "nothing was written" is still true —
    // but the durable stores now hold an intent nobody settled, and the next run will refuse over
    // it. Saying only "NOTHING WAS WRITTEN" would send the operator to that refusal with no idea
    // what it is about.
    if (unrecordedSuffix) {
      return { label: `ABORTED — NOTHING WAS WRITTEN, BUT ${unrecordedSuffix} EXIST ONLY IN THIS OUTPUT`, exitCode: 1 }
    }
    return { label: 'ABORTED — NOTHING WAS WRITTEN', exitCode: 1 }
  }
  if (unrecordedSuffix) {
    return {
      label: `PARTIALLY APPLIED — ${unrecordedSuffix} THAT ONLY THIS OUTPUT RECORDS` +
        (unknownSuffix ? ` AND ${unknownSuffix}` : ''),
      exitCode: 1,
    }
  }
  if (unknownSuffix) return { label: `PARTIALLY APPLIED — ${failed} FAILURE(S) AND ${unknownSuffix}`, exitCode: 1 }
  if (failed || incomplete) return { label: `PARTIALLY APPLIED — ${failed} FAILURE(S)`, exitCode: 1 }
  return { label: 'APPLIED', exitCode: 0 }
}

/**
 * What this run has actually done to the live ledger, so far.
 *
 * It serves two of the safety checks at once, and they are the same fact seen from two sides:
 *
 *   • CAUSALITY. `recordRelease` is called only when a DELETE has SUCCEEDED, so `releasedFor` can
 *     answer "did this run remove that blocker" — the difference between a document this run moved
 *     and a document that moved for reasons nobody in this process knows about.
 *   • REPORTABILITY. `writeCount` is the number of irreversible writes already made, which is what
 *     turns a thrown exception from "the run failed" into "the run destroyed this much and then
 *     failed".
 *
 * It is deliberately append-only and holds no opinions: the journal records what happened, the
 * guards decide what it permits.
 */
export type MutationRecord = { kind: string; label: string }
/** A write that may or may not have changed the ledger, and the reason nobody can say which. */
export type UnknownWriteRecord = MutationRecord & { reason: string }
/**
 * A write whose OUTCOME THIS PROCESS KNOWS but could not record anywhere durable.
 *
 * It is a different fact from an unknown write and must not be folded into one. An unknown write
 * means nobody knows what happened; this means THIS RUN knows, and the two stores that were
 * supposed to remember do not. The consequence for the operator is specific: the intent is on disk
 * and in the shared fence with no settlement, so the next run refuses to start — and the only
 * place the answer exists is the banner this run is about to print. If that answer is dropped, the
 * log records that something was attempted and loses what became of it, which is the half needed
 * to reconcile.
 */
export type UnrecordedSettlement = MutationRecord & {
  intentId: string
  method: HttpMethod
  path: string
  /** What this process established: committed, not-committed, or unknown. */
  state: WriteCommitState
  reason: string
  /** Which durable store(s) refused the settlement, and why. */
  failures: string[]
}

export class MutationJournal {
  private readonly writes: MutationRecord[] = []
  private readonly unknown: UnknownWriteRecord[] = []
  private readonly unrecorded: UnrecordedSettlement[] = []
  private readonly releases = new Map<string, Set<string>>()
  /**
   * Per object: the version Xero reported for it IN THE RESPONSE TO OUR OWN WRITE, or `null` when
   * that response said nothing about it. Absent from the map means this run has not written to it.
   */
  private readonly ownVersions = new Map<string, string | null>()
  private readonly failures: string[] = []

  /** An irreversible write that SUCCEEDED. Never call this for an attempt. */
  recordWrite(kind: string, label: string): void {
    this.writes.push({ kind, label })
  }

  /**
   * A write whose outcome could not be determined: it left this process and no answer from Xero's
   * application layer came back. It is recorded SEPARATELY from both successes and failures, and
   * it is never silently folded into either — a run that has one of these has an unknown ledger,
   * and the operator is the only thing that can resolve it.
   *
   * It deliberately does NOT feed `releasedFor`/`causedRelease`: "we might have deleted that
   * allocation" cannot license a later step to accept a document that moved.
   */
  recordUnknown(kind: string, label: string, reason: string): void {
    this.unknown.push({ kind, label, reason })
  }

  /**
   * A write whose outcome could not be written to the durable log or to the shared fence AFTER it
   * had already been dispatched.
   *
   * This is recorded IN ADDITION to the write itself — never instead of it. The failure being
   * closed here is that a throwing settlement used to skip the journal entirely, so a mutation
   * that had definitely landed (or definitely might have) disappeared from the run's own account
   * of what it did to the ledger. The durable record then said a write was attempted and said
   * nothing about what became of it, and the in-memory record, which still knew, threw it away.
   */
  recordUnrecordedSettlement(entry: UnrecordedSettlement): void {
    this.unrecorded.push(entry)
  }

  /**
   * A blocker this run removed, keyed by the object it was removed FROM. A single allocation
   * delete releases both sides, so it is recorded against both the credit note and the invoice.
   */
  recordRelease(subjectKey: string, blocker: string): void {
    const set = this.releases.get(subjectKey) ?? new Set<string>()
    set.add(blocker)
    this.releases.set(subjectKey, set)
  }

  releasedFor(subjectKey: string): string[] {
    return [...(this.releases.get(subjectKey) ?? [])]
  }

  /** Did THIS RUN release anything off this object? The gate for widening the allowed statuses. */
  causedRelease(subjectKey: string): boolean {
    return (this.releases.get(subjectKey)?.size ?? 0) > 0
  }

  /**
   * The version Xero reported for this object when it answered OUR OWN write — the only version
   * this run is entitled to attribute to itself. Pass `null` when the response did not carry one.
   *
   * `null` is STICKY. Once a write to this object has come back without a version, nothing later
   * in the run can say what state our writes left it in: a version observed afterwards is a state,
   * not a provenance, and the whole defect being closed here is treating the two as the same.
   */
  recordOwnWriteVersion(subjectKey: string, version: string | null): void {
    if (this.ownVersions.has(subjectKey) && this.ownVersions.get(subjectKey) === null) return
    this.ownVersions.set(subjectKey, version)
  }

  /** Has THIS RUN written to this object at all? The gate for which version policy applies. */
  wroteTo(subjectKey: string): boolean {
    return this.ownVersions.has(subjectKey)
  }

  /** `undefined` — this run never wrote to it. `null` — it did, and the version is unestablished. */
  ownWriteVersion(subjectKey: string): string | null | undefined {
    return this.ownVersions.get(subjectKey)
  }

  recordFailure(message: string): void {
    this.failures.push(message)
  }

  get writeCount(): number { return this.writes.length }
  get writeRecords(): readonly MutationRecord[] { return this.writes }
  get unknownCount(): number { return this.unknown.length }
  get unknownRecords(): readonly UnknownWriteRecord[] { return this.unknown }
  get unrecordedSettlementCount(): number { return this.unrecorded.length }
  get unrecordedSettlements(): readonly UnrecordedSettlement[] { return this.unrecorded }
  get failureCount(): number { return this.failures.length }
  get failureMessages(): readonly string[] { return this.failures }
}

/**
 * The ONLY way a write result is allowed to become a fact about the ledger.
 *
 * Every call site used to read `res.ok` and branch two ways — succeeded, or failed and therefore
 * did nothing. There is a third case, and it is the one that matters on an irreversible operation:
 * the request left this process and no answer came back, so the object may be voided and may not
 * be, and no amount of re-reading `res` will settle it. Routing every write through here means a
 * call site cannot express the two-way version any more.
 *
 * Returns true when Xero committed the write and false when Xero refused it. It does not return
 * for the third case: the run cannot go on reasoning about a ledger it can no longer describe, so
 * it aborts — and because the abort carries `recordUnknown`, the banner says PARTIALLY APPLIED and
 * names the object instead of claiming nothing was written.
 */
/**
 * The version Xero reported FOR THIS OBJECT in the response to a write we just made.
 *
 * It is deliberately strict about identity. Xero answers a write with whatever object the endpoint
 * is about, and that is not always the object whose version matters: `POST /Payments/{id}` answers
 * with the PAYMENT while the document the refund was blocking is the credit note, and
 * `DELETE /CreditNotes/{id}/Allocations/{id}` answers about the allocation. Accepting "some
 * UpdatedDateUTC came back" would bind the next write to a version belonging to a different record
 * — a binding that looks strong and means nothing — so the match is by collection AND by id.
 *
 * Anything it cannot match returns null, which every caller reads as UNESTABLISHED, never as fine.
 */
export function versionFromWriteResponse(args: {
  data: unknown
  collectionKey: string
  idField: string
  id: string
}): string | null {
  const { data, collectionKey, idField, id } = args
  if (!data || typeof data !== 'object') return null
  const rows = (data as Record<string, unknown>)[collectionKey]
  if (!Array.isArray(rows)) return null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (record[idField] !== id) continue
    const version = record.UpdatedDateUTC
    return typeof version === 'string' && version.trim() !== '' ? version : null
  }
  return null
}

/** One reading of a write result's commit state, shared so nothing can classify it a second way. */
export function commitOf(res: XeroResult<unknown>): WriteCommit {
  return res.commit ?? {
    state: 'unknown',
    reason: 'the transport returned no commit classification for a write, so its outcome is not established',
  }
}

/**
 * Put the outcome of a dispatched write into the run's own account of what it did to the ledger.
 *
 * Split out of `settleWrite` because it must also run on the path where the DURABLE settlement
 * failed — the run still knows what happened, and the in-memory record is then the only thing that
 * does. Returns whether Xero committed it.
 */
export function journalWriteOutcome(args: {
  commit: WriteCommit
  journal: MutationJournal
  kind: string
  label: string
}): boolean {
  const { commit, journal, kind, label } = args
  if (commit.state === 'unknown') {
    journal.recordUnknown(kind, label, commit.reason)
    return false
  }
  if (commit.state === 'committed') {
    journal.recordWrite(kind, label)
    return true
  }
  return false
}

export function settleWrite(args: {
  res: XeroResult<unknown>
  journal: MutationJournal
  kind: string
  label: string
}): boolean {
  const { res, journal, kind, label } = args
  const commit = commitOf(res)
  const committed = journalWriteOutcome({ commit, journal, kind, label })
  if (commit.state === 'unknown') {
    throw new WriteOutcomeUnknownError(
      `ABORT: ${kind} — ${label}: ${commit.reason}.\n` +
        `THIS WRITE MAY HAVE COMMITTED. It is not being reported as a failure, because "it failed" would mean ` +
        `the ledger is unchanged and nothing here knows that.\n` +
        `Before re-running: read this object in Xero, or re-run the read-only footprint audit, and establish ` +
        `what actually happened to it. A re-run started from the old plan would otherwise treat it as untouched.`,
    )
  }
  return committed
}

// ---------------------------------------------------------------------------
// 8. THE WRITE-INTENT LOG — evidence of a write that OUTLIVES the process
// ---------------------------------------------------------------------------
/**
 * `settleWrite` records an unknown outcome AFTER the response settles. That covers the write whose
 * ANSWER was lost. It does not cover the process that never gets to see one.
 *
 * A killed process — OOM, SIGKILL, a dropped SSH session, the machine going away, the container
 * being evicted — is the SAME class of event that produces an unknown outcome, and it is the one
 * where the evidence dies with the recorder. The in-memory journal is garbage collected, the
 * banner is never printed, `PLAN_OUT` still says what the run INTENDED, and the next run re-reads
 * the object off Xero as though nobody had ever written to it. If the write landed, the next run
 * plans from a state nobody confirmed — which is precisely the recovery the unknown-write banner
 * exists to prevent.
 *
 * So the intent is written to disk and FLUSHED TO THE DEVICE BEFORE the request is dispatched, and
 * the outcome is appended after it settles. An intent with no matching settlement is exactly the
 * evidence that would otherwise have been lost, and the next run REFUSES TO START while one exists.
 *
 * The log is not date-stamped. It has to be found by the run that comes after the crash, and a
 * file named after the day the dead run started is a file the next day's run walks straight past.
 */
export type WriteIntent = {
  id: string
  /**
   * Which RUN wrote this line. Ids used to be `w1`, `w2`, ... from a per-process counter, so two
   * runs sharing the log produced the same ids and a settlement from one resolved an intent from
   * the other — the landed unknown write disappearing behind a colliding run's success. The id is
   * now scoped to the run that minted it, and a settlement only resolves an intent from its OWN
   * run. See `acquireWriteLogLock` for the half that stops the collision happening at all.
   */
  runId: string
  kind: string
  label: string
  method: HttpMethod
  path: string
  at: string
  tenantId: string
}

export type WriteIntentLog = {
  /**
   * Which RUN this log is minting ids for. Exposed because the SHARED fence has to record the same
   * run against the same intent: a settlement is predicated on the run in both stores, so a
   * settlement from one run can never resolve another's dispatched write — on disk or in the
   * database.
   */
  readonly runId: string
  /** Durably record that a write is ABOUT to be dispatched. Returns the id used to settle it. */
  intend(entry: { kind: string; label: string; method: HttpMethod; path: string }): string
  /** Durably record what became of it. */
  settle(id: string, state: WriteCommitState, reason: string): void
  close(): void
}

/**
 * A previous run left a write on disk that nobody can account for: an intent with no settlement
 * (the process died), or one settled as UNKNOWN (the answer was lost and the banner may never have
 * been read). Both mean the same thing about the ledger — it may have changed — so both stop the
 * next run.
 */
export class UnresolvedWriteError extends SafetyViolationError {}

/**
 * For dry runs, which cannot dispatch a write at all, and for tests that are not about durability.
 * It is a separate value rather than an `if (log)` at the call site: an optional log is a log a
 * call site can forget, and the forgetting is invisible.
 */
export const NULL_WRITE_INTENT_LOG: WriteIntentLog = {
  runId: 'not-logged',
  intend: () => 'not-logged',
  settle: () => {},
  close: () => {},
}

/**
 * The log itself, over an injected `append` sink. The sink is injected so that the ORDERING
 * contract — intent on disk before the request leaves, outcome after — is testable without a
 * filesystem, and so that a test can make the flush itself fail.
 */
export function createWriteIntentLog(args: {
  tenantId: string
  /** MUST durably flush before returning. `openWriteIntentLog` is the fsync-ing implementation. */
  append: (line: string) => void
  now?: () => Date
  /**
   * Identifies THIS RUN in the log. Defaults to fresh randomness, and must never be derived from
   * anything two runs could agree on — a pid, a date, a hostname — because the whole job of this
   * value is to make a colliding run's ids provably not ours.
   */
  runId?: string
}): WriteIntentLog {
  const { tenantId, append, now = () => new Date(), runId = randomBytes(8).toString('hex') } = args
  let seq = 0
  return {
    runId,
    intend(entry) {
      // Scoped to the run. `w1` from a bare counter is the same string in every process that ever
      // opens this file, which is exactly how one run's settlement erased another run's evidence.
      const id = `${runId}-w${++seq}`
      const record: WriteIntent & { event: 'intent' } = {
        event: 'intent', id, runId, kind: entry.kind, label: entry.label,
        method: entry.method, path: entry.path, at: now().toISOString(), tenantId,
      }
      append(JSON.stringify(record))
      return id
    },
    settle(id, state, reason) {
      append(JSON.stringify({ event: 'settled', id, runId, state, reason, at: now().toISOString(), tenantId }))
    },
    close() {},
  }
}

/**
 * Two runs must not share this log, and the reason is the guarantee the log exists to give.
 *
 * The refusal in `assertNoUnresolvedWrites` reads the whole file and asks "is there a write nobody
 * accounted for?". That question has an answer only if the file describes ONE run's writes at a
 * time. With two runs appending, run A can dispatch a write, die before settling it, and run B —
 * which read the file before A's intent reached it, or which is simply further along — appends its
 * own settlements over the top. The landed write that nobody can account for is then sitting in a
 * file that the next run reads as clean. That is not a smaller version of the guarantee; it is the
 * absence of it, in exactly the crash the log was built for.
 *
 * Both halves of the fix are here, and they answer different failures:
 *
 *   • THIS LOCK makes the collision impossible. `openSync(..., 'wx')` is O_CREAT|O_EXCL, one
 *     atomic syscall: the second run does not get the file, and does not start. It FAILS CLOSED on
 *     every path — if the lock is already held it refuses, and if the lock CANNOT BE TAKEN for any
 *     other reason (no permission, no directory, a read-only filesystem) it refuses then too,
 *     because a lock that could not be established is indistinguishable from one held by someone
 *     else as far as this process's knowledge goes. Nothing here treats "the mechanism broke" as
 *     "carry on".
 *   • THE RUN-SCOPED IDS in `createWriteIntentLog` mean that a collision which happens ANYWAY —
 *     a lock cleared by hand, two runs pointed at the same log through different paths, a
 *     filesystem where O_EXCL is not honoured — still cannot HIDE anything: a settlement resolves
 *     only an intent from its own run, so the dead run's intent stays on the pile.
 *
 * A stale lock after a crash is deliberate, and is the same policy as an unresolved intent: the
 * operator looks, establishes what happened, and clears it. A lock that auto-expired would hand
 * the next run exactly the state this file refuses to let it plan from.
 */
export class WriteLogLockedError extends SafetyViolationError {}

/**
 * WHERE THE LOG LIVES IS NOT THE OPERATOR'S CHOICE, and that is the whole of this section.
 *
 * The lock above makes two runs collide — but only when they are pointed at the SAME file. The log
 * path used to come off the command line (`--write-log <path>`), and a path is not a fact about
 * the thing being protected; it is a fact about what somebody typed. Two runs handed two different
 * paths took two different locks and read two different logs, and BOTH guarantees went with it:
 *
 *   • THE SINGLE-APPLY LOCK. Run-scoped ids stop one run's settlement from HIDING another's
 *     intent. They do not stop two runs both applying the same plan to the same ledger — only
 *     mutual exclusion does that, and mutual exclusion keyed on a path excludes nothing when the
 *     path is an input.
 *   • THE RECOVERY FENCE. A run pointed at a fresh path reads an EMPTY log, finds no unaccounted
 *     write, and starts — which is precisely the "plan over a ledger nobody has confirmed" the
 *     fence exists to refuse. The dead run's evidence is still on disk, in the file this run was
 *     told not to look at.
 *
 * And it was never only `--write-log`. The old default `./xero-live-cleanup-write-log.jsonl` is
 * CWD-RELATIVE, so the same command typed in the repo root and in /root already meant two logs and
 * two locks, with nobody having asked for anything unusual.
 *
 * So the lock and the log are keyed on THE LEDGER — the tenant id — at an absolute path derived
 * from it. The tenant is the thing being protected; it is knowable before any I/O (the remover
 * refuses every tenant but one, by constant, so the key exists before a token is even read); and
 * no flag, no cwd and no call site can move it. The path is an OUTPUT of the tenant, never an
 * input from an operator. `openWriteIntentLog` takes no path at all — an argument that cannot be
 * expressed is an argument no future call site can get wrong.
 *
 * Keyed on the TENANT rather than on the PLAN because two different plans against one ledger must
 * still not run at once, and because the fence asks a question about the LEDGER's state, not about
 * any one plan's: a plan-keyed lock would let two runs of two overlapping plans proceed together,
 * and would give a second plan a fence that had never seen the first plan's dispatched writes.
 *
 * It fails closed at every step, which is why this shape was chosen over the alternatives. The
 * directory is created before the lock is taken; if it cannot be created — no permission, a
 * read-only filesystem, a plain file in the way — then the lock cannot be taken either, and a lock
 * that could not be established is treated exactly like one somebody else is holding. Resolving
 * the realpath of an operator-supplied path was rejected: it makes two names for one file collide,
 * but a genuinely NEW path still resolves cleanly, takes a free lock and starts with an empty
 * fence. Merely refusing a non-default path was rejected too: the default was itself cwd-relative,
 * so "the default" is not one file.
 */
export const XERO_CLEANUP_STATE_DIR = '/var/lib/o3d/xero-cleanup'

/**
 * Where earlier versions of this tool wrote, before the log was keyed on the ledger. The fence
 * reads these IN ADDITION to the tenant's log, never instead of it: an operator who upgrades
 * mid-incident has a round-5 log sitting in some cwd and a tenant-keyed file that is empty on its
 * first run — an empty fence in exactly the situation the fence exists for. Relative on purpose;
 * it is resolved against the cwd the run is started in, which is the cwd the old default meant.
 */
export const LEGACY_WRITE_LOG_PATHS: readonly string[] = ['./xero-live-cleanup-write-log.jsonl']

/** A run tried to put the write-intent log somewhere other than where the ledger says it goes. */
export class WriteLogRelocationError extends SafetyViolationError {}

export type WriteLogTarget = {
  /** The directory both files live in. Created 0700 before the lock is taken. */
  stateDir: string
  /** The write-intent log for this ledger. The ONLY log an apply run can append to. */
  logPath: string
  /** The exclusive lock guarding it. One per ledger, whatever any run was told. */
  lockPath: string
}

/**
 * Xero tenant ids are uuids. The check is not pedantry: this value is pasted into a filesystem
 * path, so anything it can contain is a way to move the log — a separator, a `..`, an empty string
 * — and moving the log is the defect this whole section closes. It is the one remaining input to
 * the derivation, so it is the one remaining way back in, and it is refused rather than sanitised.
 */
const TENANT_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function writeLogTargetForTenant(args: {
  tenantId: string
  /**
   * TEST SEAM ONLY, so a test does not write to a machine-wide directory. No CLI flag reaches it,
   * and `tests/scripts/xero-live-safety.test.ts` asserts the remover never passes one — otherwise
   * this parameter would be `--write-log` under a new name.
   */
  stateDir?: string
}): WriteLogTarget {
  const stateDir = args.stateDir ?? XERO_CLEANUP_STATE_DIR
  if (!TENANT_ID_FORM.test(args.tenantId)) {
    throw new WriteLogRelocationError(
      `ABORT: refusing to derive the write-intent log path from a tenant id that is not a uuid ` +
        `(${JSON.stringify(args.tenantId)}). The log path is keyed on the ledger it protects, so anything this ` +
        `value can contain is a way to move the log out of ${stateDir} — and a moved log means a fresh, empty ` +
        `recovery fence and a lock nobody else takes.`,
    )
  }
  const logPath = `${stateDir}/write-log-${args.tenantId.toLowerCase()}.jsonl`
  return { stateDir, logPath, lockPath: `${logPath}.lock` }
}

/**
 * The command-line half. `--write-log` is REFUSED rather than ignored: an operator who typed it
 * believes the log moved, and a flag that silently does nothing is how somebody ends up running a
 * second apply in the belief that it is isolated from the first.
 *
 * It is refused in a DRY RUN too. A dry run cannot dispatch a write, but it reads the log to
 * decide whether the ledger is in a state anyone has confirmed, and a dry run pointed at an empty
 * file builds the very plan the next `--apply` is authorised by. The fence has to hold one step
 * earlier than the writing does.
 */
export function assertWriteLogNotRelocated(args: { requestedPath?: string; target: WriteLogTarget }): void {
  if (args.requestedPath === undefined) return
  throw new WriteLogRelocationError(
    `ABORT: --write-log is no longer accepted (you passed it ${args.requestedPath ? `as ${JSON.stringify(args.requestedPath)}` : 'with no value'}).\n` +
      `The write-intent log is keyed on the LEDGER, not on a path: ${args.target.logPath}, locked by ` +
      `${args.target.lockPath}. That is what makes "only one apply run at a time" and "a dispatched write is ` +
      `never invisible to the next run" true regardless of what anyone types — two runs given two paths took two ` +
      `locks and read two logs, and neither guarantee survived it.\n` +
      `If you wanted a clean log: account for every write already in ${args.target.logPath} (open each object in ` +
      `Xero, or re-run scripts/audit-xero-live-e2e-footprint.ts) and move it aside — ` +
      `mv ${args.target.logPath} ${args.target.logPath}.resolved-<date>. That is the same resolution the ` +
      `unaccounted-write refusal asks for, and it requires reading the ledger rather than renaming a file.`,
  )
}

export type WriteLogLock = {
  /** The lock file, so the message that tells an operator to remove it can name it. */
  path: string
  /** Idempotent: the log's `close()` and a caller's `finally` may both call it. */
  release(): void
}

export function acquireWriteLogLock(args: {
  /**
   * The LEDGER being protected. The lock path is derived from it — there is no path parameter,
   * because a path parameter is what let two runs of this script miss each other entirely.
   */
  tenantId: string
  /** TEST SEAM ONLY. See `writeLogTargetForTenant`. */
  stateDir?: string
  /** Injected for tests, and so a caller can make the mechanism itself fail. */
  ensureDir?: (dir: string) => void
  openLock?: (lockPath: string) => number
  removeLock?: (lockPath: string) => void
  now?: () => Date
}): WriteLogLock {
  const target = writeLogTargetForTenant({ tenantId: args.tenantId, stateDir: args.stateDir })
  const lockPath = target.lockPath
  const ensureDir = args.ensureDir ?? ((d: string) => { mkdirSync(d, { recursive: true, mode: 0o700 }) })
  const openLock = args.openLock ?? ((p: string) => openSync(p, 'wx'))
  const removeLock = args.removeLock ?? ((p: string) => unlinkSync(p))
  const now = args.now ?? (() => new Date())

  let fd: number
  try {
    // Inside the try on purpose. A directory that cannot be made is a lock that cannot be taken,
    // and this refuses on both for the same reason: neither outcome tells this process that no
    // other run is live.
    ensureDir(target.stateDir)
    fd = openLock(lockPath)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new WriteLogLockedError(
      `ABORT: could not take the exclusive lock on the write-intent log (${lockPath}): ${message}\n` +
        `Either another run of this script is writing to ${target.logPath} right now, or one died holding the ` +
        `lock, or the lock could not be established at all (${target.stateDir} unwritable or missing).\n` +
        `THIS LOCK IS PER-LEDGER, not per-file: every run against this tenant takes this same lock however it ` +
        `was invoked and from whatever directory. The log is what proves no dispatched write went unaccounted ` +
        `for, and one run's records appended over another's destroy that proof.\n` +
        `If no other run is live: read ${lockPath} to see which run left it, account for every write in ` +
        `${target.logPath} (open each object in Xero, or re-run scripts/audit-xero-live-e2e-footprint.ts), and ` +
        `only then remove the lock file.`,
    )
  }
  try {
    // Best effort identity for the human who has to decide whether this lock is live. It is not
    // part of the exclusion — O_EXCL already did that — but a lock nobody can attribute is a lock
    // nobody dares clear.
    writeSync(fd, `${JSON.stringify({ pid: process.pid, at: now().toISOString(), log: target.logPath })}\n`)
    fsyncSync(fd)
  } catch {
    /* the exclusion is the file's existence, not its contents */
  }

  let released = false
  return {
    path: lockPath,
    release() {
      if (released) return
      released = true
      try { closeSync(fd) } catch { /* releasing the lock must not mask the run's own error */ }
      try { removeLock(lockPath) } catch { /* a lock left behind fails CLOSED; that is the safe way to fail */ }
    },
  }
}

/**
 * The on-disk sink. `writeSync` then `fsyncSync`: a buffered write that has not reached the device
 * is not evidence of anything, and the events this log exists for — a kill, an OOM, a host going
 * away — are exactly the ones that discard a buffer.
 *
 * It is EXCLUSIVE. The lock is taken here rather than left to the call site, for the same reason
 * the null log is a value rather than an `if (log)`: a lock a caller has to remember is a lock a
 * caller can forget, and the forgetting is invisible until two runs have already interleaved. A
 * caller that must lock EARLIER — before it reads the log to check for unresolved writes, which is
 * the window a second run could append into — takes the lock itself with `acquireWriteLogLock` and
 * hands it in.
 */
export function openWriteIntentLog(args: {
  /** The LEDGER. There is no `path`: see `XERO_CLEANUP_STATE_DIR` for why it was taken away. */
  tenantId: string
  /** TEST SEAM ONLY. See `writeLogTargetForTenant`. */
  stateDir?: string
  now?: () => Date
  /** An already-held lock, for a caller that locked before scanning. Released by `close()`. */
  lock?: WriteLogLock
  runId?: string
}): WriteIntentLog {
  const target = writeLogTargetForTenant({ tenantId: args.tenantId, stateDir: args.stateDir })
  // A lock for one ledger cannot guard the log of another. The remover takes its lock from a
  // CONSTANT tenant id, before any token is read, and opens the log under the tenant the token
  // turned out to carry; those are two different values arriving by two different routes, and
  // "locked one thing, wrote another" is the same defect this section exists to close, one layer
  // in. It is refused rather than re-locked: a mismatch means somebody's assumption is wrong.
  if (args.lock && args.lock.path !== target.lockPath) {
    throw new WriteLogLockedError(
      `ABORT: the lock this run holds (${args.lock.path}) does not guard the write-intent log it is about to ` +
        `open (${target.logPath}, locked by ${target.lockPath}). The lock was taken for a different ledger, so ` +
        `nothing excludes a second run from this one. Both must be keyed on the same tenant.`,
    )
  }
  const lock = args.lock ?? acquireWriteLogLock({ tenantId: args.tenantId, stateDir: args.stateDir, now: args.now })
  let fd: number
  try {
    fd = openSync(target.logPath, 'a')
  } catch (e) {
    lock.release()
    throw e
  }
  const log = createWriteIntentLog({
    tenantId: args.tenantId,
    now: args.now,
    runId: args.runId,
    append: (line) => {
      writeSync(fd, `${line}\n`)
      fsyncSync(fd)
    },
  })
  return {
    ...log,
    // Spread carries `runId` through, and it must: the shared fence records the same run against
    // the same intent id, and a mismatch between the two stores would make one of them unable to
    // settle its own write.
    close: () => {
      try { closeSync(fd) } finally { lock.release() }
    },
  }
}

export type WriteLogScan = { unresolved: WriteIntent[]; unreadableLines: number }

/**
 * What a previous run left behind, and could not account for.
 *
 * THREE things count, and they are all the same fact about the ledger — it may have changed and
 * nothing knows how:
 *   • an intent with no settlement at all — the process died between dispatching and recording;
 *   • an intent settled as UNKNOWN — the answer was lost, and the banner that says so may never
 *     have been printed, let alone read;
 *   • a line that cannot be parsed — a half-written final record is exactly what a process dying
 *     mid-append looks like, and "I could not read it" is not "there was nothing there".
 */
export function scanWriteIntentLog(text: string): WriteLogScan {
  const open = new Map<string, WriteIntent>()
  let unreadableLines = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      record = parsed as Record<string, unknown>
    } catch {
      unreadableLines++
      continue
    }
    const id = typeof record.id === 'string' ? record.id : null
    if (!id) { unreadableLines++; continue }
    if (record.event === 'intent') {
      open.set(id, {
        id,
        runId: String(record.runId ?? ''),
        kind: String(record.kind ?? '(unnamed)'),
        label: String(record.label ?? '(unlabelled)'),
        method: (record.method ?? 'POST') as HttpMethod,
        path: String(record.path ?? '(unknown path)'),
        at: String(record.at ?? ''),
        tenantId: String(record.tenantId ?? ''),
      })
    } else if (record.event === 'settled') {
      // A settlement RESOLVES the intent only when it says what happened, IN WORDS THIS TOOL
      // RECOGNISES. 'unknown' is the answer that does not, so it stays on the pile: the run that
      // recorded it may itself have died before printing the banner about it. So does anything
      // outside the vocabulary — a truncated value, a hand-edited line, a state written by some
      // future version of this file — for the same reason the shared fence stops believing it
      // (r8 finding 3): a settlement nobody can interpret is not a settlement, and this scan's own
      // rule about unreadable LINES ("I could not read it" is not "there was nothing there") has to
      // hold for unreadable FIELDS as well.
      if (typeof record.state !== 'string' || !settlementResolvesIntent(record.state)) continue
      // And only its OWN run's intent. Ids are run-scoped now, so this can only fire on a log
      // written by a version that minted bare `w1`, `w2` counters — the exact shape in which one
      // run's settlement erased another's dispatched-but-unaccounted-for write. Where neither line
      // carries a run, they are from the same (pre-run-id) writer and still match.
      const intent = open.get(id)
      if (intent && intent.runId !== String(record.runId ?? '')) continue
      open.delete(id)
    } else {
      unreadableLines++
    }
  }
  return { unresolved: [...open.values()], unreadableLines }
}

/**
 * The refusal. It runs before anything else, in BOTH modes: a dry run whose purpose is to build
 * the plan for the next apply is planning from a ledger nobody has confirmed, which is the same
 * mistake one step earlier.
 */
export function assertNoUnresolvedWrites(args: { path: string; text: string }): void {
  const { unresolved, unreadableLines } = scanWriteIntentLog(args.text)
  if (unresolved.length === 0 && unreadableLines === 0) return
  const shown = unresolved.slice(0, 20).map((u) => `${u.kind}: ${u.label} — ${u.method} ${u.path} at ${u.at}`)
  throw new UnresolvedWriteError(
    `ABORT: ${args.path} records ${unresolved.length} write(s) that were DISPATCHED and never accounted for` +
      (unreadableLines ? `, plus ${unreadableLines} line(s) that could not be read` : '') +
      `. A previous run either stopped between sending a write and recording what became of it, or recorded ` +
      `that it never learned the outcome, so the ledger may have changed in ways nothing in this process knows ` +
      `about:\n  ` +
      shown.join('\n  ') +
      (unresolved.length > shown.length ? `\n  ... and ${unresolved.length - shown.length} more` : '') +
      `\nResolve by READING: open each object in Xero, or re-run scripts/audit-xero-live-e2e-footprint.ts, and ` +
      `establish what actually happened to it. Once every one is accounted for, move the log aside ` +
      `(mv ${args.path} ${args.path}.resolved-<date>) and plan again from a FRESH manifest. Continuing on the old ` +
      `plan would treat these objects as untouched.`,
  )
}

// ---------------------------------------------------------------------------
// 10. WHERE THE COORDINATION LIVES — the ledger is one thing; a host is not
// ---------------------------------------------------------------------------
/**
 * THE LOCK AND THE FENCE ABOVE COORDINATE ONE FILESYSTEM. THE THING THEY PROTECT IS ONE LEDGER.
 *
 * Round 6 took the log path away from the operator and derived it from the tenant, which closed
 * "two paths on one host". What it could not close, and said so rather than closing, is that
 * `/var/lib/o3d/xero-cleanup` is a fact about a MACHINE. A second host, a container, or a VM
 * restored from a snapshot finds no lock file and an empty log. It therefore:
 *
 *   • takes the single-apply lock for free, and applies the same plan to the same organisation
 *     while another host is part-way through applying it; and
 *   • starts with an EMPTY RECOVERY FENCE, so a write that another machine dispatched and never
 *     accounted for — the exact evidence the fence exists to act on — is invisible to it.
 *
 * Two runs on two hosts against one Xero organisation is not an exotic case; it is the case the
 * lock was built for, seen from one machine over.
 *
 * SO THE COORDINATION MOVES TO A SHARED AUTHORITY: the IMS PostgreSQL database, which every host
 * that can run these scripts already has to reach. Two mechanisms, one key:
 *
 *   • MUTUAL EXCLUSION is a SESSION advisory lock in the XERO_LIVE_CLEANUP namespace, whose second
 *     int is derived from the tenant id. `--apply` takes it EXCLUSIVELY; a dry run takes it in
 *     SHARE mode. A dry run writes nothing, but the plan it produces is what the next `--apply` is
 *     authorised by, so it must not be built while an apply is mutating the ledger underneath it.
 *     Two dry runs coexist; an apply excludes everything.
 *   • THE RECOVERY FENCE is the `xero_live_write_intents` table: the same intent-before-dispatch,
 *     settlement-after record as the on-disk log, kept where another host can read it.
 *
 * BOTH ARE KEPT, disk AND database, and that is deliberate rather than belt-and-braces. They fail
 * in different directions and only the pair covers both: the FILE is what survives when the
 * DATABASE is what went away (and it is fsynced, so it survives a kill in the same millisecond),
 * and the ROW is what survives when the HOST is what went away. An intent is not considered
 * recorded until it is in both, and a write is not dispatched until its intent is recorded.
 *
 * IT FAILS CLOSED, IN BOTH MODES. If the database cannot be reached, if the lock cannot be taken,
 * or if the lock is held by another run, the script REFUSES TO START — including in a dry run,
 * because a plan built without the fence is what authorises the next irreversible apply. "The
 * coordinator is down" is indistinguishable, from inside this process, from "another host is
 * writing to the ledger right now", and there is only one safe reading of that.
 *
 * A LOST LOCK IS A REFUSAL, IN BOTH MODES, and this is where round 7 was still wrong.
 *
 * PostgreSQL frees a session advisory lock the instant its connection dies, so a reaped session or
 * a coordinator restart un-excludes this run silently. In an --apply that is caught by construction:
 * every dispatch is preceded by an INSERT of its intent on the very session that holds the lock, so
 * a dead session throws before the request leaves. The liveness check is the write the run cannot
 * skip.
 *
 * A DRY RUN MAKES NO WRITES, so it had no such check and simply carried on — and what it carries on
 * to produce is the PLAN, which is the artefact the whole share-mode lock was introduced to protect.
 * A dry run that loses its lock and finishes hands the next `--apply` a plan assembled over a ledger
 * that was, from some unknown point onwards, being mutated by somebody else. So the fence now asks
 * pg_locks directly — `SHARED_FENCE_SQL.held`, keyed on this backend's pid and the mode it took —
 * on a timer AND on demand, LATCHES any loss permanently, and the remover asserts it is still held
 * before it persists the plan and again before it reports success. A lock that came back is not the
 * lock that was held; continuity is the property, so the latch is never cleared.
 *
 * WHY NOT A MARKER IN THE LEDGER ITSELF, which is the other thing both runs can see. It was
 * considered and is UNAVAILABLE, for three independent reasons, any one of which is fatal:
 *
 *   1. TAKING IT WOULD BE A WRITE TO A REAL ACCOUNTING LEDGER. This entire incident is test
 *      artefacts that ended up in a live Xero organisation; adding coordination artefacts to that
 *      organisation to clean it up is the same defect with a better motive. There is no scratch
 *      space in Xero — every object is ledger data.
 *   2. A DRY RUN COULD NOT TAKE ONE. The transport refuses every non-GET without `--apply`, and
 *      the fence has to hold for a dry run too. A coordinator only half the runs can participate
 *      in is not a coordinator.
 *   3. XERO HAS NO CONDITIONAL CREATE. No If-Match, no compare-and-swap, no unique-constraint
 *      create that distinguishes "I made it" from "it was already there" for the object kinds this
 *      tooling can reach. Two hosts POSTing a marker both succeed, and arbitrating afterwards
 *      needs a total order over server-assigned timestamps that Xero does not promise. Mutual
 *      exclusion built on that is exclusion in name only.
 *
 *      This one is asserted rather than measured, and the reason is worth recording: the stored
 *      audit token expired on 2026-08-18T14:49Z and refreshing it rotates the refresh token out of
 *      band, so no live call could be made to test it. It rests on Xero's published API surface,
 *      not on an observation from this session. Reasons 1 and 2 need no live check — they are
 *      properties of this tooling's own contract — and either alone disqualifies the option.
 */
/** The shared coordinator could not be reached, or refused to answer. Never "carry on". */
export class SharedCoordinatorUnavailableError extends SafetyViolationError {}
/** Another run — possibly on another host — holds the ledger. */
export class SharedRunInProgressError extends SafetyViolationError {}
/** A previous run, on this host or any other, dispatched a write nobody has accounted for. */
export class SharedUnresolvedWriteError extends SafetyViolationError {}
/**
 * The database this run was told to coordinate through is not the one that holds this LEDGER.
 *
 * Separate from "unavailable" on purpose: an unreachable coordinator is a fact about the network,
 * this is a fact about WHICH LEDGER the store in front of us belongs to, and the operator's next
 * move is completely different. See `assertCoordinatorOwnsLedger`.
 */
export class LedgerCoordinatorMismatchError extends SafetyViolationError {}
/**
 * The ledger lock this run WAS holding is not held any more.
 *
 * It is not "could not take"; it is "took it, and it is gone" — a reaper closed the session, the
 * coordinator restarted, the connection dropped. Everything this run has read since is a reading
 * of a ledger that was, from that moment, unexcluded.
 */
export class SharedFenceLostError extends SafetyViolationError {}

/**
 * THE SETTLEMENT VOCABULARY, and it is closed.
 *
 * Only these two values ACCOUNT for a dispatched write. `null` (dispatched, and the run died before
 * recording anything) and `'unknown'` (settled, and the answer was lost) are the two ways a write
 * stays on the fence — and so is ANY OTHER VALUE, which is the point.
 *
 * The defect (r8 finding 3): the fence held a row when the state was NULL or `'unknown'` and let go
 * of it otherwise, so a state nobody can interpret — an operator's `commited`, a `COMMITTED`, a
 * `resolved` pasted from another tool, a half-applied UPDATE — silently REMOVED the row from the
 * shared recovery fence. That is the same class as the read-side defect fixed earlier in this file:
 * an unreadable answer must not read as "nothing there". So the rule is stated as the COMPLEMENT of
 * this list everywhere it is asked, in SQL and in TypeScript: recognised-and-resolved is the only
 * thing that resolves; everything else holds.
 */
export const RESOLVED_SETTLEMENT_STATES = ['committed', 'not-committed'] as const
/** Every value the column may legally hold. Mirrors the CHECK constraint in the migration. */
export const SETTLEMENT_STATES = ['committed', 'not-committed', 'unknown'] as const

/** Why a row is still on the fence — or that it is not. */
export type SettlementReading =
  /** A recognised terminal answer. The only reading that lets a row go. */
  | 'resolved'
  /** Dispatched, and nothing ever came back to record. */
  | 'never-settled'
  /** Settled, and the answer was lost. Somebody knows nothing; that is not nothing. */
  | 'unknown-outcome'
  /** A value outside the vocabulary. Nobody can say what it claims, so it claims nothing. */
  | 'uninterpretable'

export function readSettlementState(state: string | null | undefined): SettlementReading {
  if (state === null || state === undefined) return 'never-settled'
  if ((RESOLVED_SETTLEMENT_STATES as readonly string[]).includes(state)) return 'resolved'
  if (state === 'unknown') return 'unknown-outcome'
  return 'uninterpretable'
}

/** Does this settlement value account for the write? Anything unrecognised: no. */
export const settlementResolvesIntent = (state: string | null | undefined): boolean =>
  readSettlementState(state) === 'resolved'

/**
 * How an operator actually recovers ONE unaccounted-for intent — and, for the outcomes nobody
 * established, the statement that there is nothing to run yet.
 *
 * The defect this closes (r8 finding 4): the banner printed
 * `UPDATE ... SET "state" = '<the state>' ...` for every unrecorded settlement, `'unknown'`
 * included. For a KNOWN outcome that is genuine recovery — this process established the answer, the
 * stores refused to keep it, and the operator is transcribing it back after confirming the object.
 * For an UNKNOWN one it is not recovery at all: nobody established anything, so there is nothing to
 * transcribe, and the statement it printed would have written back the exact value the row already
 * holds — a command that runs cleanly, changes nothing, and leaves the fence refusing. An operator
 * following it would reasonably conclude the fence was broken.
 *
 * So an unknown outcome gets INVESTIGATION first and a settlement second, with the vocabulary
 * spelled out and the third answer — "I cannot tell" — given an explicit, non-settling home.
 */
export function settlementRecoveryInstruction(args: {
  intentId: string
  /**
   * What this process established. `'unknown'` — the answer was lost — and `null`/`undefined` — the
   * row was never settled at all — mean the same thing to an operator: nobody knows, so there is
   * nothing to write down. They take the same branch, and that mapping is decided HERE rather than
   * at each call site, because a call site that forgets it prints an executable-looking lie.
   */
  state: WriteCommitState | string | null | undefined
  /** What to go and look at, e.g. `item E2E-FC-A-1`. The audit script is always named as well. */
  subject?: string
  indent?: string
}): string {
  const pad = args.indent ?? ''
  const where = args.subject ? `${args.subject} ` : ''
  const settle = (value: string) =>
    `${pad}  UPDATE "xero_live_write_intents" SET "state" = '${value}', "reason" = '<who checked, and how>', ` +
    `"settledAt" = now() WHERE "id" = '${args.intentId}';`
  const join = (...parts: string[]) => parts.join('\n')

  if (settlementResolvesIntent(args.state)) {
    // This run KNOWS. The operator is transcribing a known answer back after confirming the object,
    // so the statement is executable exactly as printed and the confirmation is what makes running
    // it honest.
    const established = String(args.state)
    return join(
      `${pad}THIS RUN ESTABLISHED THE OUTCOME: ${established.toUpperCase()}. Confirm it against the ledger —`,
      `${pad}open ${where}in Xero, or re-run scripts/audit-xero-live-e2e-footprint.ts — and then record it:`,
      settle(established),
    )
  }
  // Nobody established anything, so there is nothing to transcribe and no statement to print.
  return join(
    `${pad}NOBODY ESTABLISHED WHAT BECAME OF THIS WRITE, so THERE IS NOTHING TO SETTLE IT AS YET and`,
    `${pad}no UPDATE here to copy. Settling it as 'unknown' is not recovery: that is the value the row`,
    `${pad}already holds, it resolves nothing, and the fence would go on refusing — correctly.`,
    `${pad}RECOVERY IS A READ, and it has to come first. Open ${where}in Xero, or re-run`,
    `${pad}scripts/audit-xero-live-e2e-footprint.ts, and establish which of three things is true:`,
    `${pad}  * the ledger shows the change this write intended   -> the outcome is 'committed'`,
    `${pad}  * the object is untouched, with no trace of it      -> the outcome is 'not-committed'`,
    `${pad}  * you cannot tell from the ledger                   -> STOP, and leave the row exactly as it is.`,
    `${pad}    An unresolved row is then the correct description of the world, and no further --apply may`,
    `${pad}    run against this ledger until a human can say which of the first two it was. Xero's audit`,
    `${pad}    history for the object, and the output of the run that dispatched it, are what is left to read.`,
    `${pad}ONLY THEN, with the outcome you established substituted in — never the placeholder, and never`,
    `${pad}'unknown':`,
    settle('<committed|not-committed>'),
  )
}

/**
 * The slice of a PostgreSQL client this file needs. Deliberately tiny, and deliberately NOT
 * `pg.Client`: the fence must be exercisable against a double that models one database shared by
 * two hosts, which is the only way to test the thing this section exists for.
 */
export type CoordinationClient = {
  connect(): Promise<void>
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

export type SharedFenceMode = 'exclusive' | 'shared'

/** A write another run left unaccounted for, as the shared store has it. */
export type SharedUnresolvedWrite = {
  id: string
  runId: string
  host: string
  kind: string
  label: string
  method: string
  path: string
  intendedAt: string
  /** `null` — dispatched and never settled. `'unknown'` — settled, and the answer was lost. */
  state: string | null
}

/**
 * WHICH STORE THIS IS, established by asking it about the LEDGER rather than by trusting the name
 * it was reached under. See `assertCoordinatorOwnsLedger`.
 */
export type LedgerCoordinator = {
  /** `current_database()` of the session holding the lock. For the operator, not for the binding. */
  database: string
  /** The `accounting_tokens` row that makes this database this ledger's IMS installation. */
  connectionId: string
  /** What that row calls the organisation. Printed so a mismatch reads as English. */
  tenantName: string
}

export type SharedWriteFence = {
  readonly tenantId: string
  readonly hostId: string
  readonly lockId: number
  readonly mode: SharedFenceMode
  /** Which store took the lock, and what makes it this ledger's. */
  readonly coordinator: LedgerCoordinator
  /**
   * Re-establish, against PostgreSQL, that THIS SESSION still holds the ledger lock in the mode it
   * took. Throws `SharedFenceLostError` otherwise. Call it before anything is derived from what was
   * read under the lock — a plan, above all.
   */
  assertStillHeld(context: string): Promise<void>
  /** Every write against this LEDGER that no run, on any host, has accounted for. */
  scanUnresolved(): Promise<SharedUnresolvedWrite[]>
  /** Durably record — COMMITTED — that a write is about to be dispatched. Throws to refuse it. */
  intend(entry: { id: string; runId: string; kind: string; label: string; method: HttpMethod; path: string }): Promise<void>
  /** Durably record what became of it. Throws if it did not land. */
  settle(entry: { id: string; runId: string; state: WriteCommitState; reason: string }): Promise<void>
  release(): Promise<void>
}

/**
 * For tests, and for the read-only audits that cannot dispatch a write at all. It is a VALUE and
 * not an optional parameter for the same reason `NULL_WRITE_INTENT_LOG` is: a fence a call site
 * can omit is a fence a call site can forget, and the forgetting is invisible. The remover passes
 * its real fence in both modes.
 */
export const NULL_SHARED_WRITE_FENCE: SharedWriteFence = {
  tenantId: '(none)',
  hostId: '(none)',
  lockId: 0,
  mode: 'shared',
  coordinator: { database: '(none)', connectionId: '(none)', tenantName: '(none)' },
  // It holds nothing, so it cannot have lost anything. The remover never reaches its own
  // still-held check through this value: by then the real fence has replaced it, and the tests
  // assert that ordering.
  assertStillHeld: async () => {},
  scanUnresolved: async () => [],
  intend: async () => {},
  settle: async () => {},
  release: async () => {},
}

/**
 * The second int of the advisory lock, derived from the LEDGER.
 *
 * Hashed rather than parsed out of the uuid: an arbitrary 32 bits of a tenant id are as likely to
 * collide as any other, and a hash makes the derivation total. Forced positive and below 2^31
 * because the two-int lock takes int4 arguments, and away from 0 so that a defaulted-to-zero key
 * can never look like a real one.
 */
export function xeroLedgerLockId(tenantId: string): number {
  if (!TENANT_ID_FORM.test(tenantId)) {
    throw new WriteLogRelocationError(
      `ABORT: refusing to derive the shared cleanup lock from a tenant id that is not a uuid ` +
        `(${JSON.stringify(tenantId)}). The lock is keyed on the ledger it protects; a key derived from ` +
        `something else is a lock over something else.`,
    )
  }
  const digest = createHash('sha256').update(tenantId.toLowerCase()).digest()
  const value = digest.readUInt32BE(0) % 0x7fff_ffff
  return value === 0 ? 1 : value
}

/**
 * The exact SQL the fence issues. Exported so the test double is measured against the statements
 * that actually run rather than against a paraphrase of them, and so that a change to one without
 * the other fails a test instead of a production run.
 */
export const SHARED_FENCE_SQL = {
  lock: {
    exclusive: 'SELECT pg_try_advisory_lock($1, $2) AS locked',
    shared: 'SELECT pg_try_advisory_lock_shared($1, $2) AS locked',
  },
  unlock: {
    exclusive: 'SELECT pg_advisory_unlock($1, $2) AS unlocked',
    shared: 'SELECT pg_advisory_unlock_shared($1, $2) AS unlocked',
  },
  /**
   * Not `SELECT 1`. A heartbeat that only proves the socket is open proves the wrong thing: the
   * guarantee is "this session still HOLDS the ledger lock", and pg_locks is where that is written
   * down. `objsubid = 2` is the two-int form, `mode` distinguishes the exclusive lock an --apply
   * takes from the share lock a dry run takes, and `pid = pg_backend_pid()` is what makes it a
   * question about OURSELVES rather than about whoever else may be holding it.
   */
  held:
    'SELECT count(*)::int AS held FROM pg_locks ' +
    "WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 " +
    'AND pid = pg_backend_pid() AND granted AND mode = $3',
  /**
   * Does this database hold the IMS connection to the ledger we are about to lock? The LEFT JOIN
   * against a one-row source is so that a database with NO Xero connection still answers — with a
   * row saying so — instead of answering nothing, which is the shape this whole file refuses to
   * read as "fine".
   */
  identify:
    'SELECT current_database() AS "database", t."id" AS "connectionId", t."tenantId" AS "tenantId", ' +
    't."tenantName" AS "tenantName" ' +
    'FROM (SELECT 1) AS present LEFT JOIN "accounting_tokens" t ON t."connector" = \'xero\'',
  /**
   * Everything for this ledger that is not accounted for, stated as the COMPLEMENT of the resolved
   * vocabulary rather than as a list of the unresolved ones (r8 finding 3). `state IS NULL` is
   * spelled separately because `NULL NOT IN (...)` is NULL, not true, and a three-valued predicate
   * that quietly answers "unknown" for the most dangerous row is exactly the bug.
   */
  scan:
    'SELECT "id", "runId", "host", "kind", "label", "method", "path", "intendedAt", "state" ' +
    'FROM "xero_live_write_intents" ' +
    'WHERE "tenantId" = $1 AND ("state" IS NULL OR "state" NOT IN (\'committed\', \'not-committed\')) ' +
    'ORDER BY "intendedAt"',
  intend:
    'INSERT INTO "xero_live_write_intents" ' +
    '("id", "runId", "tenantId", "host", "kind", "label", "method", "path", "intendedAt") ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING "id"',
  settle:
    'UPDATE "xero_live_write_intents" SET "state" = $3, "reason" = $4, "settledAt" = $5 ' +
    'WHERE "id" = $1 AND "runId" = $2 RETURNING "id"',
} as const

/**
 * VERIFIED AGAINST A REAL POSTGRESQL, not only against the double. On the IMS dev database, two
 * sessions were used to confirm every semantic this design leans on: an exclusive holder refuses
 * both a second exclusive taker and a share taker; two share holders coexist and together refuse
 * an exclusive one; ending a session frees what it held (the dead-host case); the intend/settle/
 * scan statements below run as written; a settlement predicated on a DIFFERENT run matches zero
 * rows; and `unknown` puts a settled row back on the fence. The table was created and the rows
 * written inside a transaction that was ROLLED BACK, so nothing was left behind.
 *
 * ROUND 8 ADDED FOUR MORE, measured the same way against the same database:
 *   • `held` reports 0 before the lock, 1 while this session holds it, 0 when asked about the OTHER
 *     mode, and 0 after the unlock — and 0 for a lock a DIFFERENT session holds, which is what
 *     makes it a question about ourselves rather than about the key;
 *   • the two-int advisory lock really does appear in pg_locks with `objsubid = 2` and
 *     mode `ShareLock` / `ExclusiveLock`, which is what the predicate keys on;
 *   • `identify` runs as written, and the dev database correctly answered that it is the IMS
 *     installation for a DIFFERENT organisation — so `acquireSharedWriteFence`, called with the
 *     live tenant and the real `pg` client, refused it with LedgerCoordinatorMismatchError;
 *   • the migration's CHECK constraint rejects `commited` and accepts `committed`, and with the
 *     constraint dropped the scan predicate still HOLDS the uninterpretable row and still releases
 *     a recognised one. Again inside a transaction that was ROLLED BACK; the table does not exist
 *     in that database afterwards and no advisory lock was left behind.
 *
 * The Xero side of this file has no equivalent check available: the stored audit token expired
 * 2026-08-18T14:49Z and refreshing it rotates the refresh token out of band.
 */

/**
 * How often the fence RE-ESTABLISHES that it still holds the lock.
 *
 * It is not a keepalive any more, and the rename is the point (r8 finding 1). `SELECT 1` proved the
 * socket was open, which is not the guarantee: the guarantee is that this session still holds the
 * ledger lock in the mode it took, and only pg_locks can say that. A tick that fails LATCHES the
 * loss, so it is discovered by the next thing the run does rather than by nothing at all.
 */
export const SHARED_FENCE_HELD_CHECK_MS = 30_000

/** What pg_locks calls the two lock modes this fence takes. */
export const SHARED_FENCE_LOCK_MODE: Record<SharedFenceMode, string> = {
  exclusive: 'ExclusiveLock',
  shared: 'ShareLock',
}

/**
 * IS THE STORE IN FRONT OF US THIS LEDGER'S COORDINATOR? (r8 finding 2.)
 *
 * Round 6 keyed the coordination on the tenant instead of on a path anybody typed, and round 7
 * moved it off the filesystem into the IMS database — but WHICH database is `DATABASE_URL`, which
 * is per-host configuration. So the defect survived one layer out, in exactly the shape round 6
 * closed: two hosts pointed at two different databases each find the ledger's key FREE, each take
 * it, and each read an empty fence. "The operator's path choice" had become "the operator's
 * DATABASE_URL".
 *
 * A lock is only exclusion if every run that can reach the protected thing takes THE SAME ONE. So
 * the coordinator may not be whatever store the host names — it has to be identified by the LEDGER.
 * That is what this asks, and it is a question only the store can answer about itself: an IMS
 * database holds exactly one Xero connection (`accounting_tokens` is unique on `connector`), and
 * that row names the organisation the installation is connected to. A database whose row names a
 * DIFFERENT organisation, or that has no Xero connection at all, is not this ledger's coordinator,
 * and locking a key in it excludes nobody. It is refused rather than used.
 *
 * WHAT THIS DOES AND DOES NOT BUY, stated plainly because the residue matters:
 *
 *   • CLOSED: an empty database, a scratch database, a per-developer database, another tenant's IMS
 *     installation, and a host re-pointed at any of them. None of these can be made to hold the
 *     ledger's lock any more. That is the whole of the "operator's DATABASE_URL" class except one.
 *   • OPEN, AND UNCLOSEABLE FROM HERE: two databases that BOTH legitimately claim this ledger — a
 *     restored snapshot of the IMS database, or a second IMS installation authorised against the
 *     same Xero organisation. Both hold a matching row, both answer yes, and nothing inside either
 *     one can see the other.
 *
 * SO WHAT COULD SELF-IDENTIFY AGAINST THE TENANT, since the database provably cannot on its own?
 * Only the ledger, and it is the one place this tooling may not put a marker — for the three
 * reasons under "WHY NOT A MARKER IN THE LEDGER ITSELF" above, any one of them fatal. What is left
 * is to make the split VISIBLE rather than silent: the coordinator's identity is carried on the
 * fence, printed by the remover at start-up and named in every refusal, so two operators comparing
 * two runs' output can see they coordinated in two places. A guarantee it is not, and it is not
 * described as one. The check that IS a guarantee — that a run cannot coordinate through a store
 * unrelated to the ledger — is the one above.
 */
export function assertCoordinatorOwnsLedger(args: {
  tenantId: string
  /** `current_database()`, for the message. It is not part of the decision. */
  database: string
  /** Every `accounting_tokens` row with `connector = 'xero'`, as the store answered. */
  connections: ReadonlyArray<{ connectionId?: string | null; tenantId?: string | null; tenantName?: string | null }>
}): LedgerCoordinator {
  const preface =
    `The live-Xero cleanup coordinates through the IMS database that OWNS this ledger — that is what makes ` +
    `the single-apply lock and the crash-recovery fence true across hosts. Which database that is cannot be ` +
    `taken from DATABASE_URL, because two hosts given two URLs would each take a free lock in their own ` +
    `store and exclude nobody; it is established by asking the store which Xero organisation it is connected ` +
    `to.`
  const real = args.connections.filter((c) => c.connectionId != null && c.tenantId != null)
  if (real.length === 0) {
    throw new LedgerCoordinatorMismatchError(
      `ABORT: the database this run reached (${args.database}) holds no Xero connection at all, so it is not ` +
        `the coordinator for ledger ${args.tenantId} — or for any ledger.\n${preface}\n` +
        `Point DATABASE_URL at the IMS database whose accounting connection is ${args.tenantId} and run it ` +
        `again. If that database IS the one already named and its connection has been removed, re-authorise ` +
        `IMS against the organisation through the normal settings flow — that restores the row as evidence of ` +
        `something real. Do NOT hand-write a connection row to get past this check: the row is what makes one ` +
        `store the coordinator, and forging it makes an unrelated database claim a ledger it has nothing to do ` +
        `with, which is the whole defect this check exists to close.`,
    )
  }
  if (real.length > 1) {
    throw new LedgerCoordinatorMismatchError(
      `ABORT: the database this run reached (${args.database}) holds ${real.length} Xero connections ` +
        `(${real.map((c) => `${c.tenantName ?? '(unnamed)'} ${c.tenantId}`).join(', ')}), so which ledger it ` +
        `coordinates is ambiguous. accounting_tokens is unique on connector, so this schema is not the one ` +
        `this tooling was written against.\n${preface}`,
    )
  }
  const [only] = real
  if (String(only.tenantId).toLowerCase() !== args.tenantId.toLowerCase()) {
    throw new LedgerCoordinatorMismatchError(
      `ABORT: the database this run reached (${args.database}) is the IMS installation for ` +
        `${only.tenantName ?? '(unnamed organisation)'} (${only.tenantId}) — a DIFFERENT Xero organisation ` +
        `from the one this script acts on (${args.tenantId}).\n${preface}\n` +
        `Taking the ledger's lock here would exclude nothing: the run that matters coordinates in the other ` +
        `database, finds the key free, and both proceed. Point DATABASE_URL at the IMS database for ` +
        `${args.tenantId}.`,
    )
  }
  return {
    database: args.database,
    connectionId: String(only.connectionId),
    tenantName: only.tenantName ? String(only.tenantName) : '(unnamed organisation)',
  }
}

/**
 * Take the ledger's cross-host fence, or refuse.
 *
 * Every failure here is a refusal, and they are deliberately not distinguished into "safe" and
 * "unsafe" ones: a database that cannot be reached, a lock that cannot be taken and a lock somebody
 * else holds all leave this process unable to say that no other run is live against this ledger.
 */
export async function acquireSharedWriteFence(args: {
  tenantId: string
  /** `--apply` takes the ledger exclusively; a dry run shares it with other dry runs. */
  mode: SharedFenceMode
  /** Injected for tests, and so a caller can make the coordinator itself fail. */
  createClient?: () => CoordinationClient
  hostId?: string
  now?: () => Date
  /** Injected so tests leave no timers behind. */
  setKeepalive?: (fn: () => void, ms: number) => { clear: () => void }
}): Promise<SharedWriteFence> {
  const lockId = xeroLedgerLockId(args.tenantId)
  const hostId = args.hostId ?? `${hostname()}#${process.pid}`
  const now = args.now ?? (() => new Date())
  const createClient = args.createClient ?? defaultCoordinationClient
  const setKeepalive =
    args.setKeepalive ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      handle.unref?.()
      return { clear: () => { clearInterval(handle) } }
    })

  let client: CoordinationClient
  try {
    client = createClient()
    await client.connect()
  } catch (e) {
    throw new SharedCoordinatorUnavailableError(
      `ABORT: could not reach the shared coordinator for this ledger (${args.tenantId}): ${errText(e)}\n` +
        `The single-apply lock and the crash-recovery fence for this Xero organisation live in the IMS ` +
        `database, because a lock FILE coordinates one host and this ledger can be reached from any of them. ` +
        `With the coordinator unreachable, nothing in this process can tell "no other run is live" from ` +
        `"another host is writing to the ledger right now", so it refuses — in a dry run too, because the plan ` +
        `a dry run produces is what the next --apply is authorised by.\n` +
        `Set DATABASE_URL to the IMS database and try again. Do NOT work around this by running the script ` +
        `somewhere the database is unreachable.`,
    )
  }

  const end = async () => { try { await client.end() } catch { /* the session is going away regardless */ } }

  // BEFORE THE LOCK, because a lock taken in a store that has nothing to do with this ledger is not
  // a lock at all — it is a free key in somebody's scratch database while the run that matters
  // takes the free key in another one. See `assertCoordinatorOwnsLedger`.
  let coordinator: LedgerCoordinator
  try {
    const identity = await client.query(SHARED_FENCE_SQL.identify)
    coordinator = assertCoordinatorOwnsLedger({
      tenantId: args.tenantId,
      database: String(identity.rows[0]?.database ?? '(unnamed database)'),
      connections: identity.rows.map((r) => ({
        connectionId: r.connectionId == null ? null : String(r.connectionId),
        tenantId: r.tenantId == null ? null : String(r.tenantId),
        tenantName: r.tenantName == null ? null : String(r.tenantName),
      })),
    })
  } catch (e) {
    await end()
    // A mismatch is a finding about the world and keeps its own class; anything else means the
    // question could not be ASKED, which is indistinguishable from "this is not an IMS database"
    // and is refused on the same terms as an unreachable coordinator.
    if (e instanceof LedgerCoordinatorMismatchError) throw e
    throw new SharedCoordinatorUnavailableError(
      `ABORT: the store this run reached could not be asked which Xero organisation it belongs to ` +
        `(${args.tenantId}): ${errText(e)}\n` +
        `The coordinator for this ledger is identified by the accounting_tokens row that names the ledger, not ` +
        `by DATABASE_URL — so a store that cannot answer that question cannot be shown to be the one every ` +
        `other run coordinates through, and taking its lock would exclude nobody.`,
    )
  }

  let locked: boolean
  try {
    const res = await client.query(SHARED_FENCE_SQL.lock[args.mode], [XERO_LIVE_CLEANUP_LOCK_NAMESPACE, lockId])
    locked = res.rows[0]?.locked === true
  } catch (e) {
    await end()
    throw new SharedCoordinatorUnavailableError(
      `ABORT: the shared coordinator could not be asked for the ledger lock (${args.tenantId}): ${errText(e)}\n` +
        `A lock that could not be established is treated exactly like one another run is holding.`,
    )
  }
  if (!locked) {
    await end()
    throw new SharedRunInProgressError(
      `ABORT: another run holds this LEDGER (${args.tenantId}).\n` +
        `Coordinated through ${coordinator.database}, the IMS installation connected to ` +
        `${coordinator.tenantName} (connection ${coordinator.connectionId}).\n` +
        `The lock is a PostgreSQL advisory lock in the IMS database — namespace ` +
        `${XERO_LIVE_CLEANUP_LOCK_NAMESPACE}, key ${lockId} — so it is held across HOSTS, not just across ` +
        `processes on this one. ${args.mode === 'exclusive'
          ? 'An --apply run excludes every other run against this organisation, including dry runs.'
          : 'A dry run is refused while an --apply is in flight: the plan it would build is a plan over a ledger that is being mutated as it reads it.'}\n` +
        `Find the run that holds it — SELECT * FROM pg_locks WHERE locktype = 'advisory' AND classid = ` +
        `${XERO_LIVE_CLEANUP_LOCK_NAMESPACE} AND objid = ${lockId}, joined to pg_stat_activity — and wait for it ` +
        `or establish that it died. A session lock is released the instant its connection ends, so there is ` +
        `nothing to clear by hand.`,
    )
  }

  /**
   * THE LOSS LATCH (r8 finding 1).
   *
   * Once this is set the fence is finished: every method refuses, and it is never cleared. A lock
   * that came back is not the lock that was held — the window in between is a window in which
   * another run could take the ledger, do anything to it, and give it back — so "it is held again"
   * is not the question. The question is whether it has been held CONTINUOUSLY since the reads this
   * run's conclusions rest on, and once the answer is no, nothing later can make it yes.
   */
  let lost: string | null = null
  const checkHeld = async (): Promise<void> => {
    if (lost) return
    try {
      const res = await client.query(SHARED_FENCE_SQL.held, [
        XERO_LIVE_CLEANUP_LOCK_NAMESPACE, lockId, SHARED_FENCE_LOCK_MODE[args.mode],
      ])
      const held = Number(res.rows[0]?.held ?? 0)
      if (held !== 1) {
        lost =
          `PostgreSQL reports this session holds ${held} ${SHARED_FENCE_LOCK_MODE[args.mode]}(s) on ` +
          `advisory key (${XERO_LIVE_CLEANUP_LOCK_NAMESPACE}, ${lockId}), not 1`
      }
    } catch (e) {
      // Unanswerable is treated as lost, for the reason every other refusal in this file gives: from
      // inside this process "I could not ask" and "somebody else has it" are the same state.
      lost = `the coordinator could not be asked whether this session still holds the ledger: ${errText(e)}`
    }
  }
  const lostError = (context: string): SharedFenceLostError =>
    new SharedFenceLostError(
      `ABORT: this run no longer holds the lock on ledger ${args.tenantId} — ${lost}.\n` +
        `Where it was noticed: ${context}.\n` +
        `A PostgreSQL session advisory lock lives and dies with its connection, so a reaped session, a ` +
        `coordinator restart or a dropped connection frees it silently and instantly. From the moment it went, ` +
        `nothing excluded another run — an --apply on any host could have taken this ledger and changed it — so ` +
        `everything read since is a reading of a ledger nobody was holding still.\n` +
        (args.mode === 'shared'
          ? `THIS IS A DRY RUN, AND THAT IS NOT A REASON TO CARRY ON. A dry run writes nothing, but the PLAN it ` +
            `produces is the artefact the next --apply is authorised by, and a plan assembled over an unexcluded ` +
            `ledger authorises writes against states nobody confirmed. That plan is exactly what this lock ` +
            `existed to protect, so it is not written and not offered.\n`
          : `NOTHING FURTHER IS DISPATCHED. Writes already made stand and are listed below; they cannot be undone.\n`) +
        `Re-run from the start. There is nothing to clear by hand — an advisory lock nobody holds leaves ` +
        `nothing behind — but if this keeps happening, find out WHY the session stopped holding it: an idle ` +
        `reaper, a coordinator restart, or a connection pooler in front of DATABASE_URL. A pooler that hands ` +
        `successive statements to different backends makes a SESSION lock meaningless, and this refusal is what ` +
        `that configuration looks like. Point DATABASE_URL at PostgreSQL directly.`,
    )
  const ensureHeld = (context: string): void => { if (lost) throw lostError(context) }
  /**
   * Ask PostgreSQL NOW, rather than trusting the last tick. The extra round trip is bought on every
   * dispatch on purpose: the intent INSERT proves the SESSION is alive, and that is not the same
   * question as whether the session still HOLDS the ledger — a lock released out of band, or a
   * pooler that moved the statement to another backend, leaves an INSERT that succeeds beautifully
   * on a run that is excluding nobody.
   */
  const assertHeldNow = async (context: string): Promise<void> => {
    ensureHeld(context)
    await checkHeld()
    ensureHeld(context)
  }

  const keepalive = setKeepalive(() => { void checkHeld() }, SHARED_FENCE_HELD_CHECK_MS)

  const fail = (what: string, e: unknown): never => {
    throw new SharedCoordinatorUnavailableError(
      `ABORT: the shared write fence could not ${what} for ledger ${args.tenantId}: ${errText(e)}\n` +
        `This session is also what holds the ledger's advisory lock, so a failure here means the exclusion ` +
        `may be gone as well — PostgreSQL frees a session lock the instant its connection dies. Nothing may ` +
        `be dispatched after it.`,
    )
  }

  return {
    tenantId: args.tenantId,
    hostId,
    lockId,
    mode: args.mode,
    coordinator,
    /**
     * Ask PostgreSQL, NOW, whether this session still holds the ledger — do not settle for the last
     * tick's answer. Called before anything derived from what was read under the lock becomes an
     * artefact, and in an --apply run the intent INSERT plays the same role for every dispatch.
     */
    async assertStillHeld(context: string) {
      await assertHeldNow(context)
    },
    async scanUnresolved() {
      // Latch-only: this runs immediately after acquisition, and the SELECT below is on the same
      // session anyway. `assertStillHeld` is what a caller uses when the answer has to be fresh.
      ensureHeld('reading the unaccounted-for writes')
      let rows: Array<Record<string, unknown>>
      try {
        rows = (await client.query(SHARED_FENCE_SQL.scan, [args.tenantId])).rows
      } catch (e) {
        return fail('read the unaccounted-for writes', e)
      }
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        runId: String(r.runId ?? ''),
        host: String(r.host ?? '(unknown host)'),
        kind: String(r.kind ?? '(unnamed)'),
        label: String(r.label ?? '(unlabelled)'),
        method: String(r.method ?? '(unknown method)'),
        path: String(r.path ?? '(unknown path)'),
        intendedAt: r.intendedAt instanceof Date ? r.intendedAt.toISOString() : String(r.intendedAt ?? ''),
        state: r.state == null ? null : String(r.state),
      }))
    },
    async intend(entry) {
      // BEFORE the intent, and therefore before the dispatch. The INSERT below runs on the session
      // that holds the lock, so it catches a DEAD session — but not a lock that went while the
      // session lived, which is the same hole the dry run had. Asked out loud, every time.
      await assertHeldNow(`recording the intent to ${entry.method} ${entry.path}`)
      let rows: Array<Record<string, unknown>>
      try {
        rows = (await client.query(SHARED_FENCE_SQL.intend, [
          entry.id, entry.runId, args.tenantId, hostId, entry.kind, entry.label, entry.method, entry.path, now(),
        ])).rows
      } catch (e) {
        return fail('record a write intent', e)
      }
      // An INSERT that reported success without inserting is not evidence of anything, and this is
      // the record another host reads to learn that this write ever happened.
      if (rows.length !== 1) {
        return fail('record a write intent', new Error(`the insert affected ${rows.length} row(s), not 1`))
      }
    },
    async settle(entry) {
      // DELIBERATELY NOT gated on the loss latch, unlike `intend`. This is recording what became of
      // a write that has ALREADY been dispatched, and the answer is the scarcest thing in the run:
      // refusing to try because the lock is gone would throw away the only account of it while the
      // store may well still be writable. If the session really is dead the UPDATE fails on its own
      // and `recordSettlement` reports it as an unrecorded settlement, which is the honest outcome.
      let rows: Array<Record<string, unknown>>
      try {
        rows = (await client.query(SHARED_FENCE_SQL.settle, [entry.id, entry.runId, entry.state, entry.reason, now()])).rows
      } catch (e) {
        return fail('record the outcome of a write', e)
      }
      // Predicated on the RUN as well as the id, so a settlement can never resolve another run's
      // intent — the same rule the on-disk scan applies, enforced by the database.
      if (rows.length !== 1) {
        return fail(
          'record the outcome of a write',
          new Error(`the update matched ${rows.length} row(s), not 1 — intent ${entry.id} of run ${entry.runId}`),
        )
      }
    },
    async release() {
      keepalive.clear()
      // Best effort, and unlike the lock FILE this fails OPEN — deliberately. A session advisory
      // lock exists only for as long as its session, so the connection ending IS the release;
      // there is nothing that can be left behind for an operator to clear.
      try { await client.query(SHARED_FENCE_SQL.unlock[args.mode], [XERO_LIVE_CLEANUP_LOCK_NAMESPACE, lockId]) } catch { /* the end() below releases it */ }
      await end()
    },
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The real client. A dedicated session, never a pooled one: `pg_try_advisory_lock` lives on the
 * connection that took it, and a pool would hand the unlock — or the next intent INSERT — to a
 * different socket that never held the lock. Injectable, so every test in this file runs against a
 * double that models one database shared by two hosts instead of against a socket.
 */
function defaultCoordinationClient(): CoordinationClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The live-Xero cleanup coordinates through the IMS database because a lock ' +
        'file only coordinates one host — and specifically through the IMS installation whose accounting ' +
        'connection IS this ledger, which is checked once the connection is open.',
    )
  }
  return new pg.Client({ connectionString, application_name: 'o3d_xero_live_cleanup_fence' }) as unknown as CoordinationClient
}

/**
 * The cross-host half of the recovery refusal. Same rule as `assertNoUnresolvedWrites`, asked of
 * the shared store: a write that was dispatched and never accounted for stops the next run whether
 * the machine that dispatched it still exists or not.
 */
export function assertNoUnresolvedSharedWrites(args: {
  tenantId: string
  unresolved: readonly SharedUnresolvedWrite[]
}): void {
  if (args.unresolved.length === 0) return
  // Why each row is still here. `uninterpretable` is the case r8 finding 3 was about: a state
  // outside the vocabulary used to make the row VANISH from this list, so the run it should have
  // stopped started instead. It now holds the fence like any other unaccounted-for write, and it
  // says so in its own words rather than being reported as one of the other two.
  const describe = (u: SharedUnresolvedWrite): string => {
    switch (readSettlementState(u.state)) {
      case 'never-settled': return 'never settled — the run died between dispatching it and recording the answer'
      case 'unknown-outcome': return 'settled as UNKNOWN — the answer was lost'
      case 'uninterpretable':
        return `settled as ${JSON.stringify(u.state)}, which is not one of ` +
          `${SETTLEMENT_STATES.map((v) => `'${v}'` ).join(', ')} — nobody can say what it claims, so it claims nothing`
      case 'resolved': return 'accounted for (this row should not be on the fence; report it)'
    }
  }
  const shown = args.unresolved
    .slice(0, 20)
    .map((u) => `${u.kind}: ${u.label} — ${u.method} ${u.path} at ${u.intendedAt}, dispatched from ${u.host} by run ` +
      `${u.runId}\n      intent ${u.id}: ${describe(u)}\n` +
      settlementRecoveryInstruction({ intentId: u.id, state: null, subject: `${u.kind} ${u.label}`, indent: '      ' }))
  throw new SharedUnresolvedWriteError(
    `ABORT: the shared write fence records ${args.unresolved.length} write(s) against ledger ${args.tenantId} that ` +
      `were DISPATCHED and are not accounted for. These come from the IMS database, not from this machine's disk, ` +
      `so they include runs on OTHER HOSTS — which is the case a lock file and a log file could not see at all:\n  ` +
      shown.join('\n  ') +
      (args.unresolved.length > shown.length ? `\n  ... and ${args.unresolved.length - shown.length} more` : '') +
      `\nThen plan again from a FRESH manifest. Nothing expires these rows on a timer: the only thing that can say ` +
      `what became of a dispatched write is Xero, and a fence that cleared itself would hand the next run exactly ` +
      `the empty state it exists to refuse.`,
  )
}

/**
 * A step that makes SEVERAL irreversible writes against ONE object, with the guarantee that every
 * one of them is authorised by a revalidation of its own.
 *
 * The defect this closes: step 1 re-read the credit note once and then deleted every allocation and
 * every refund on it. The re-read-before-mutation guarantee is per-OBJECT, so it held for the first
 * DELETE and merely accompanied the rest — every write after the first acted on a state nobody had
 * re-checked, in the step that does the most damage. A document re-contacted to a genuine customer,
 * or re-allocated, between write one and write two was invisible.
 *
 * The other way to close it would be to make the batch atomic, so that a single revalidation
 * genuinely covers all of it. That is not available: each allocation is its own DELETE against its
 * own URL, a refund reversal is a POST to an entirely different endpoint, Xero has no batch verb
 * spanning them, no transaction, and no If-Match/version precondition on any of them. There is
 * nothing for one re-read to cover. So the revalidation is repeated, and this is the loop that
 * makes repeating it structural rather than a thing each call site remembers.
 *
 * The order is fixed and is the whole point: revalidate, confirm the unit, write — per unit. A
 * caller cannot hoist the revalidation out, because it does not own the loop.
 */
export async function writeUnitsIndividually<TUnit, TLive>(args: {
  units: readonly TUnit[]
  /** Re-read and revalidate the SUBJECT. Called once per unit, immediately before that unit's write. */
  revalidate: () => Promise<TLive>
  /**
   * The subject is as planned; this confirms the UNIT is too — the allocation still points at the
   * same invoice for the same amount, the refund is still the same refund. Throws to refuse.
   */
  confirmUnit: (unit: TUnit, live: TLive) => void
  /** The irreversible write. Reached only after this unit's own revalidation and confirmation. */
  write: (unit: TUnit, live: TLive) => Promise<void>
}): Promise<void> {
  for (const unit of args.units) {
    const live = await args.revalidate()
    args.confirmUnit(unit, live)
    await args.write(unit, live)
  }
}

/**
 * THE ONLY WAY THIS TOOLING WRITES.
 *
 * It exists so that three things cannot come apart at a call site: the durable intent goes down
 * BEFORE the request is dispatched, the outcome is settled on disk whatever happens, and the
 * version Xero reports for the object it moved is captured from THAT response and no other. Each
 * of those was a separate defect when the call sites did them by hand — or, in the case of the
 * first, did not do them at all.
 */
export async function performWrite<T>(args: {
  transport: XeroTransport
  token: TransportToken
  method: HttpMethod
  path: string
  body?: unknown
  journal: MutationJournal
  writeLog: WriteIntentLog
  /**
   * The CROSS-HOST half of the same record. Required, not optional, for the reason the null log is
   * a value rather than an `if (log)`: a coordinator a call site can omit is one a call site can
   * forget, and the forgetting is invisible until two hosts have already interleaved. Pass
   * `NULL_SHARED_WRITE_FENCE` only where a write provably cannot be dispatched.
   */
  fence: SharedWriteFence
  kind: string
  label: string
  /**
   * The objects whose version THIS write moves, and where to find each one's new version in the
   * response. Deleting one allocation moves BOTH the credit note and the invoice, so both are
   * named: whatever the response does not report is recorded as unestablished, never assumed.
   */
  subjects?: Array<{ key: string; collectionKey: string; idField: string; id: string }>
}): Promise<{ committed: boolean; res: XeroResult<T> }> {
  const { transport, token, method, path, body, journal, writeLog, fence, kind, label } = args
  // BEFORE the request, not after. This is the whole point of the log.
  const intentId = writeLog.intend({ kind, label, method, path })
  // And before the request in the SHARED store too, for the same reason one turn further out: the
  // fsynced file is invisible to a run on another host, so a write recorded only there is a write
  // that a second machine's recovery fence cannot see. Both stores, then dispatch.
  //
  // It doubles as the liveness check on the exclusion. This INSERT runs on the very session that
  // holds the ledger's advisory lock, and PostgreSQL frees that lock the instant the session dies
  // — so a lost lock throws HERE, before the request leaves, rather than being discovered after
  // another host has already written.
  try {
    await fence.intend({ id: intentId, runId: writeLog.runId, kind, label, method, path })
  } catch (e) {
    // The request has NOT been dispatched: this failed before the network, exactly like the write
    // gate and the call ceiling. Saying so keeps the local log's fence honest — an intent left
    // dangling here would stop the next run over a ledger that provably did not change.
    const message = e instanceof Error ? e.message : String(e)
    try {
      writeLog.settle(intentId, 'not-committed', `the request never left this process: ${message}`)
    } catch (settleError) {
      journal.recordUnrecordedSettlement({
        intentId, kind, label, method, path,
        state: 'not-committed',
        reason: `the request never left this process: ${message}`,
        failures: [`the durable log: ${settleError instanceof Error ? settleError.message : String(settleError)}`],
      })
    }
    throw e
  }
  let res: XeroResult<T>
  try {
    res = await transport.request<T>(token, method, path, body)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // A throw is not automatically "nothing was sent". Only three things can say the ledger is
    // unchanged: the write gate and the call ceiling, which run BEFORE the network, and a 429,
    // which is XERO ITSELF refusing the request — the same evidence as a 400 or a 404, just
    // delivered as a refusal to retry rather than as a result. Everything else is settled as
    // unknown: over-reporting costs the operator one manual read, and under-reporting loses an
    // irreversible write.
    const commit: WriteCommit =
      e instanceof WriteWithoutApplyError || e instanceof CallCeilingError
        ? { state: 'not-committed', reason: `the request never left this process: ${message}` }
        : e instanceof WriteRateLimitedError
          ? e.commit
          : { state: 'unknown', reason: message }
    // THE JOURNAL FIRST, and that ordering is the fix. Settling used to come first, so a
    // settlement that threw — a full disk, a dropped coordinator session — took the
    // `recordUnknown` with it: the run then reported "nothing was written" about a request that
    // had already left the process. What the durable stores refuse to hold, memory still has to.
    journalWriteOutcome({ commit, journal, kind, label })
    const failures = await recordSettlement({ writeLog, fence, intentId, runId: writeLog.runId, commit })
    if (failures.length > 0) {
      journal.recordUnrecordedSettlement({ intentId, kind, label, method, path, state: commit.state, reason: commit.reason, failures })
    }
    // The transport's own error is the cause and stays the thrown one; the settlement failure is
    // carried on the journal, which is what the end-of-run banner prints from on every path.
    throw e
  }
  const commit = commitOf(res)
  // Settled BEFORE settleWrite, because settleWrite throws on an unknown outcome and the record has
  // to survive that throw as surely as it has to survive a kill. Both stores are attempted even if
  // the first refuses: a settlement that reached one of them is not nothing.
  const failures = await recordSettlement({ writeLog, fence, intentId, runId: writeLog.runId, commit })
  if (commit.state === 'committed') {
    for (const subject of args.subjects ?? []) {
      journal.recordOwnWriteVersion(
        subject.key,
        versionFromWriteResponse({ data: res.data, collectionKey: subject.collectionKey, idField: subject.idField, id: subject.id }),
      )
    }
  }
  if (failures.length > 0) {
    // The mutation is recorded EXPLICITLY here rather than by falling through to settleWrite,
    // because the throw below would otherwise skip it — which is the defect: a write that landed,
    // whose settlement could not be stored, vanished from the run's account of what it destroyed.
    journalWriteOutcome({ commit, journal, kind, label })
    journal.recordUnrecordedSettlement({ intentId, kind, label, method, path, state: commit.state, reason: commit.reason, failures })
    throw new WriteSettlementNotRecordedError(
      `ABORT: ${kind} — ${label}: the write was DISPATCHED (${method} ${path}) and its outcome is ` +
        `${commit.state.toUpperCase()} (${commit.reason}), but that outcome could not be recorded — ${failures.join('; ')}.\n` +
        `The intent for it is durable; the ANSWER is not. So the next run, on this host or any other, will refuse ` +
        `to start over intent ${intentId} — and the only place the answer now exists is this run's output.\n` +
        `WRITE THIS DOWN.\n` +
        // An UNKNOWN outcome gets investigation, not an UPDATE: there is nothing to transcribe,
        // because nobody established anything. That decision lives in one place, below.
        settlementRecoveryInstruction({ intentId, state: commit.state, subject: `${kind} ${label}` }) +
        `\nAccount for the same intent in the on-disk log before the next run.`,
    )
  }
  return { committed: settleWrite({ res, journal, kind, label }), res }
}

/**
 * Settle one dispatched write in BOTH durable stores, and report which of them refused rather than
 * throwing out of the first failure.
 *
 * Neither store may be skipped because the other failed: they answer different questions — the
 * file is what a next run ON THIS HOST reads, the row is what a next run ANYWHERE reads — and a
 * settlement that reached one of them still narrows what the operator has to reconcile. The
 * failures are returned instead of thrown so the caller can record the outcome in memory first;
 * throwing from here is what used to suppress the mutation.
 */
async function recordSettlement(args: {
  writeLog: WriteIntentLog
  fence: SharedWriteFence
  intentId: string
  runId: string
  commit: WriteCommit
}): Promise<string[]> {
  const { writeLog, fence, intentId, runId, commit } = args
  const failures: string[] = []
  try {
    writeLog.settle(intentId, commit.state, commit.reason)
  } catch (e) {
    failures.push(`the durable log refused it: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    await fence.settle({ id: intentId, runId, state: commit.state, reason: commit.reason })
  } catch (e) {
    failures.push(`the shared fence refused it: ${e instanceof Error ? e.message : String(e)}`)
  }
  return failures
}

// ---------------------------------------------------------------------------
// Absence classification, shared with the read-only audits
// ---------------------------------------------------------------------------
/**
 * How an id was resolved. The distinction between the last two is the whole of finding 5/6: an
 * object that was ASKED FOR BY ID and answered 404 is gone; an object that merely failed to turn up
 * in a collection read is UNKNOWN, and a collection read that ERRORED says nothing at all.
 */
export type Resolution =
  /** The object was returned by Xero. */
  | 'PRESENT'
  /** A per-id GET returned HTTP 404. This is the ONLY value that means "confirmed absent". */
  | 'NOT_FOUND'
  /** Not seen, and not confirmed by a per-id read. Says nothing about whether it exists. */
  | 'UNKNOWN'
  /** A read failed. Says nothing about whether it exists. */
  | 'ERROR'

export function isConclusive(resolution: Resolution): boolean {
  return resolution === 'PRESENT' || resolution === 'NOT_FOUND'
}

/**
 * Turn a per-id GET into a resolution. Anything that is not a 2xx and not a 404 is an ERROR — a
 * transient 5xx or an expired token must never be published as "this object is gone".
 */
export function resolveById(res: { ok: boolean; status: number }, found: boolean): Resolution {
  if (res.ok) return found ? 'PRESENT' : 'UNKNOWN'
  if (res.status === 404) return 'NOT_FOUND'
  return 'ERROR'
}

// ---------------------------------------------------------------------------
// The retirement refusal (o3d-t74p finding 4)
// ---------------------------------------------------------------------------
/**
 * retire-live-tenant-external-ids.ts nulls the stored Xero ids on 553 local rows. Its premise —
 * that those ids address objects in the LIVE organisation — was DISPROVED: they are Demo-tenant
 * ids, and the instance is connected to Demo, so they are plausibly CURRENT references. Its own
 * documentation says do not run it.
 *
 * A header warning is not a control. This is: the apply path refuses by default and the refusal can
 * only be lifted by a deliberate, documented override that cannot be satisfied by accident —
 * a long exact flag AND a signed-off authorization file AND three positive database/tenant checks
 * that all have to agree with each other.
 */
export class RetirementRefusedError extends SafetyViolationError {}

/** The exact token the authorization file must carry. Nothing else unlocks the apply path. */
export const RETIREMENT_AUTHORIZATION_TOKEN = 'RETIRE-DEMO-HISTORY'
/** The exact flag. Long, specific, and unpleasant to type by mistake — that is the point. */
export const RETIREMENT_OVERRIDE_FLAG = '--i-have-read-o3d-t74p-and-authorize-demo-history-retirement'

export type RetirementAuthorization = {
  token: string
  tenantId: string
  database: string
  ids: number
  /** SHA-256 of the exact id set that was signed off. See `fingerprintIds`. */
  idsSha256: string
  authorizedBy: string
  authorizedAt: string
}

/**
 * The fingerprint of an id SET — order-insensitive, duplicate-insensitive, whitespace-insensitive,
 * so it is a property of the set itself and not of how the CSV happened to be sorted the day it was
 * read.
 *
 * A count is not a binding. `ids: 553` is satisfied by ANY 553 ids: a different export, a CSV
 * regenerated after the underlying data moved, one id swapped for another, or the same file with
 * a row edited. The authorization is supposed to say "I reviewed THESE rows and agreed to null
 * THEM", and only a fingerprint of the actual ids says that. The count is kept as well, because it
 * gives the operator a readable failure ("553 vs 554") before the opaque one.
 */
export function fingerprintIds(ids: Iterable<string>): string {
  const unique = [...new Set([...ids].map((id) => id.trim()).filter((id) => id !== ''))].sort()
  return createHash('sha256').update(unique.join('\n')).digest('hex')
}

export function parseRetirementAuthorization(text: string): RetirementAuthorization {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at < 0) continue
    fields.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim())
  }
  const required = ['token', 'tenantId', 'database', 'ids', 'idsSha256', 'authorizedBy', 'authorizedAt']
  const missing = required.filter((k) => !fields.get(k))
  if (missing.length) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization file is missing ${missing.join(', ')}. Every field is mandatory.`,
    )
  }
  const ids = Number(fields.get('ids'))
  if (!Number.isInteger(ids) || ids <= 0) {
    throw new RetirementRefusedError(`REFUSED: the authorization file's \`ids\` must be a positive integer.`)
  }
  const idsSha256 = fields.get('idsSha256')!.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(idsSha256)) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization file's \`idsSha256\` must be a 64-character SHA-256 hex digest of the ` +
        `reviewed id set. The dry run prints it.`,
    )
  }
  return {
    token: fields.get('token')!,
    tenantId: fields.get('tenantId')!,
    database: fields.get('database')!,
    ids,
    idsSha256,
    authorizedBy: fields.get('authorizedBy')!,
    authorizedAt: fields.get('authorizedAt')!,
  }
}

export type RetirementGuardInput = {
  /** Was the exact long override flag present on the command line? */
  overrideFlagPresent: boolean
  /** The parsed authorization file, or null if none was supplied. */
  authorization: RetirementAuthorization | null
  /** `select current_database()` — the server's own answer, NOT a substring of DATABASE_URL. */
  currentDatabase: string | null
  expectedDatabase: string
  /** Every Xero token row in the database. */
  tenantRows: Array<{ tenantId: string; tenantName?: string | null }>
  expectedTenantId: string
  /** The ids the CSV actually resolved to — the set, not a count of it. */
  ids: string[]
}

/**
 * Throws unless EVERY condition holds. Each check is positive — it requires proof of the expected
 * state rather than the absence of a wrong one — because the guard this replaces failed open in
 * three separate ways at once:
 *
 *   • it permitted the currently connected Demo tenant, which is the exact state in which the
 *     documented damage occurs;
 *   • it permitted ZERO token rows (`tok.rows.length &&` short-circuits to "fine");
 *   • it checked `DATABASE_URL.includes('onetwo3d_ims_e2e')`, which a username, a password or a
 *     query parameter containing that string satisfies while connected somewhere else entirely.
 */
export function assertRetirementAuthorized(input: RetirementGuardInput): void {
  const {
    overrideFlagPresent, authorization, currentDatabase, expectedDatabase,
    tenantRows, expectedTenantId, ids,
  } = input
  const idCount = new Set(ids.map((id) => id.trim()).filter((id) => id !== '')).size

  if (!overrideFlagPresent || !authorization) {
    throw new RetirementRefusedError(
      'REFUSED: this operation is disabled.\n' +
        '  Its premise was disproved on 2026-08-10: the 553 ids are Demo-tenant ids and the instance is\n' +
        '  connected to Demo, so they are plausibly CURRENT references. Nulling them would delete live\n' +
        '  back-references, not retire dead ones. The script\'s own header says do not run it.\n' +
        `  If a documented decision now authorises dropping the e2e instance's Demo-tenant history, pass\n` +
        `  ${RETIREMENT_OVERRIDE_FLAG}\n` +
        '  together with --authorization <file> carrying token/tenantId/database/ids/authorizedBy/authorizedAt.',
    )
  }

  if (authorization.token !== RETIREMENT_AUTHORIZATION_TOKEN) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization token is ${JSON.stringify(authorization.token)}, not ${RETIREMENT_AUTHORIZATION_TOKEN}.`,
    )
  }

  // The database says what it is. DATABASE_URL is a connection *request*, not an identity.
  if (!currentDatabase) {
    throw new RetirementRefusedError('REFUSED: could not read current_database() from the server.')
  }
  if (currentDatabase !== expectedDatabase) {
    throw new RetirementRefusedError(
      `REFUSED: connected to database ${JSON.stringify(currentDatabase)}, not ${JSON.stringify(expectedDatabase)}.`,
    )
  }
  if (authorization.database !== currentDatabase) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is for database ${JSON.stringify(authorization.database)}, ` +
        `but this connection is to ${JSON.stringify(currentDatabase)}.`,
    )
  }

  // Exactly one tenant, positively matched. Zero rows is not "safe by default" — it means nothing
  // can confirm which organisation the ids belong to, which is the whole defect (o3d-s36z).
  if (tenantRows.length !== 1) {
    throw new RetirementRefusedError(
      `REFUSED: expected exactly one Xero token row to identify the connected organisation, found ${tenantRows.length}. ` +
        'Nothing can say which tenant these ids belong to.',
    )
  }
  if (tenantRows[0].tenantId !== expectedTenantId) {
    throw new RetirementRefusedError(
      `REFUSED: connected to "${tenantRows[0].tenantName ?? tenantRows[0].tenantId}" (${tenantRows[0].tenantId}), ` +
        `not the authorised tenant ${expectedTenantId}.`,
    )
  }
  if (authorization.tenantId !== tenantRows[0].tenantId) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is stamped for tenant ${authorization.tenantId}, but this instance is ` +
        `connected to ${tenantRows[0].tenantId}.`,
    )
  }

  // The approval covered a SPECIFIC SET of ids. The count is checked first only because "553 vs
  // 554" is a readable failure; it is not the binding, because any 553 ids satisfy it.
  if (authorization.ids !== idCount) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization covers ${authorization.ids} id(s) but the CSV resolves to ${idCount}. ` +
        'Re-review and re-authorize.',
    )
  }

  // The binding. Without it the authorization is a note saying "some ids were reviewed": point the
  // script at a different CSV of the same size — a re-export after the data moved, one id swapped
  // for another, a hand-edited row — and the same signed file authorises nulling back-references
  // nobody ever looked at. The fingerprint is of the id SET, so re-ordering or re-exporting the
  // same ids still matches, and anything else does not.
  const fingerprint = fingerprintIds(ids)
  if (authorization.idsSha256 !== fingerprint) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is signed for id set ${authorization.idsSha256}, but the CSV resolves to ` +
        `${fingerprint}. Same count, different ids — this is not the set that was reviewed. Re-review and re-authorize.`,
    )
  }
}
