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
 *                     outcome cannot be determined is reported as UNKNOWN, never as nothing.
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
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'

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
}): RunOutcome {
  const { apply, failed, incomplete = false, aborted = false, writesMade = 0, unknownWrites = 0 } = args
  const unknownSuffix = unknownWrites > 0 ? `${unknownWrites} WRITE(S) OF UNKNOWN OUTCOME` : ''
  if (!apply) {
    // A dry run cannot write at all — the transport throws on any non-GET without --apply — so an
    // unknown write here means the write gate itself has been bypassed. It is reported, loudly,
    // rather than being unrepresentable.
    if (aborted) return { label: unknownSuffix ? `DRY RUN — ABORTED WITH ${unknownSuffix}` : 'DRY RUN — ABORTED', exitCode: 1 }
    if (unknownSuffix) return { label: `DRY RUN — INCOMPLETE, ${unknownSuffix}`, exitCode: 1 }
    return { label: failed || incomplete ? 'DRY RUN — INCOMPLETE' : 'DRY RUN', exitCode: failed || incomplete ? 1 : 0 }
  }
  if (aborted) {
    if (writesMade > 0 && unknownSuffix) {
      return { label: `PARTIALLY APPLIED — ABORTED AFTER ${writesMade} IRREVERSIBLE WRITE(S) AND ${unknownSuffix}`, exitCode: 1 }
    }
    if (writesMade > 0) return { label: `PARTIALLY APPLIED — ABORTED AFTER ${writesMade} IRREVERSIBLE WRITE(S)`, exitCode: 1 }
    // The lie this closes: a write that committed remotely and lost its response used to leave
    // `writesMade` at zero, so the last thing on screen said the run was a no-op.
    if (unknownSuffix) return { label: `PARTIALLY APPLIED — ABORTED WITH ${unknownSuffix}`, exitCode: 1 }
    return { label: 'ABORTED — NOTHING WAS WRITTEN', exitCode: 1 }
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

export class MutationJournal {
  private readonly writes: MutationRecord[] = []
  private readonly unknown: UnknownWriteRecord[] = []
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

export function settleWrite(args: {
  res: XeroResult<unknown>
  journal: MutationJournal
  kind: string
  label: string
}): boolean {
  const { res, journal, kind, label } = args
  const commit = commitOf(res)
  if (commit.state === 'unknown') {
    journal.recordUnknown(kind, label, commit.reason)
    throw new WriteOutcomeUnknownError(
      `ABORT: ${kind} — ${label}: ${commit.reason}.\n` +
        `THIS WRITE MAY HAVE COMMITTED. It is not being reported as a failure, because "it failed" would mean ` +
        `the ledger is unchanged and nothing here knows that.\n` +
        `Before re-running: read this object in Xero, or re-run the read-only footprint audit, and establish ` +
        `what actually happened to it. A re-run started from the old plan would otherwise treat it as untouched.`,
    )
  }
  if (commit.state === 'committed') {
    journal.recordWrite(kind, label)
    return true
  }
  return false
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
      // A settlement RESOLVES the intent only when it says what happened. 'unknown' is the answer
      // that does not, so it stays on the pile: the run that recorded it may itself have died
      // before printing the banner about it.
      if (record.state === 'unknown') continue
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
  kind: string
  label: string
  /**
   * The objects whose version THIS write moves, and where to find each one's new version in the
   * response. Deleting one allocation moves BOTH the credit note and the invoice, so both are
   * named: whatever the response does not report is recorded as unestablished, never assumed.
   */
  subjects?: Array<{ key: string; collectionKey: string; idField: string; id: string }>
}): Promise<{ committed: boolean; res: XeroResult<T> }> {
  const { transport, token, method, path, body, journal, writeLog, kind, label } = args
  // BEFORE the request, not after. This is the whole point of the log.
  const intentId = writeLog.intend({ kind, label, method, path })
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
    writeLog.settle(intentId, commit.state, commit.reason)
    if (commit.state === 'unknown') journal.recordUnknown(kind, label, message)
    throw e
  }
  const commit = commitOf(res)
  // Settled on disk BEFORE settleWrite, because settleWrite throws on an unknown outcome and the
  // record has to survive that throw as surely as it has to survive a kill.
  writeLog.settle(intentId, commit.state, commit.reason)
  if (commit.state === 'committed') {
    for (const subject of args.subjects ?? []) {
      journal.recordOwnWriteVersion(
        subject.key,
        versionFromWriteResponse({ data: res.data, collectionKey: subject.collectionKey, idField: subject.idField, id: subject.id }),
      )
    }
  }
  return { committed: settleWrite({ res, journal, kind, label }), res }
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
