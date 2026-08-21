/**
 * Xero HTTP client with automatic token refresh and rate-limit handling.
 */

import { getAccessToken, getStoredTenantBlockReason } from './auth'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { accountingPostingIntentRefusal } from '@/lib/connectors/accounting-posting-intent'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'
const XERO_CONNECTOR = 'xero'

/**
 * The status `performRequest` reports when it refused to send (o3d-gfh, Codex r1 finding 3).
 *
 * Zero, and deliberately not an HTTP code: nothing was sent, so there is no HTTP status to report, and
 * borrowing one (403, 409) would make the row's errorMessage claim Xero answered when Xero was never
 * asked. It matches the `status: 0` `notConnectedResponse` already uses for the same reason.
 */
const XERO_NOT_SENT_STATUS = 0
const XERO_MAX_RETRIES = 3
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
const XERO_MAX_RETRY_AFTER_MS = 90_000

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
 */
async function waitForBudget(tenantId: string): Promise<{ ok: true } | { ok: false; waitMs: number }> {
  while (true) {
    const now = Date.now()
    const minute = (minuteBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 60_000)
    const day = (dayBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 86_400_000)
    minuteBuckets.set(tenantId, minute)
    dayBuckets.set(tenantId, day)

    // Day first: no amount of waiting inside this request will fix it.
    if (day.length >= XERO_DAY_LIMIT) {
      return { ok: false, waitMs: 86_400_000 - (now - day[0]) }
    }

    const minuteWait = minute.length >= XERO_MINUTE_LIMIT ? 60_000 - (now - minute[0]) : 0
    if (minuteWait <= 0) return { ok: true }
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
  const intentRefusal = accountingPostingIntentRefusal(XERO_CONNECTOR, auth.tenantId)
  if (intentRefusal) {
    return { ok: false, status: XERO_NOT_SENT_STATUS, text: async () => intentRefusal } as Response
  }

  for (let attempt = 0; attempt <= XERO_MAX_RETRIES; attempt++) {
    const budget = await waitForBudget(auth.tenantId)
    if (!budget.ok) {
      return {
        ok: false,
        status: 429,
        text: async () =>
          `Xero day budget exhausted for this tenant: ${XERO_DAY_LIMIT} calls used within the rolling ` +
          `24h window, oldest falls out in ${Math.round(budget.waitMs / 60_000)} min. Not waiting — ` +
          `the work must be deferred. (Xero's real cap is 1,000/org/rolling-24h since 2026-03-02.)`,
      } as Response
    }
    noteRequest(auth.tenantId)

    const res = await connectorFetch(url, init, { connectorName: 'Xero' })
    noteLimitHeaders(auth.tenantId, res)
    if (res.status !== 429) return res

    lastRateLimitMs = Math.max(parseRetryAfterMs(res.headers.get('Retry-After')), 1000 * 2 ** attempt)

    // Give up rather than sleep out a daily limit. Retry-After is measured in seconds for the
    // minute limit and in HOURS for the daily one; waiting out the latter hangs this request
    // (and its cron) with nothing to show for it. Hand the 429 back and let the caller defer.
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
  return { ok: false, status: 0, error: blocked ?? 'Not connected to Xero' }
}

async function xeroFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string; ifModifiedSince?: Date | string },
): Promise<XeroResponse<T>> {
  const auth = await getAccessToken()
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
  const url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

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

  const init: RequestInit = { method, headers }

  if (body) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await performRequest(auth, init, url)
  // Refused before sending. Reported verbatim rather than falling through to the !res.ok branch, which
  // would prefix it with "HTTP 0:" and so describe a reply Xero never made.
  if (res.status === XERO_NOT_SENT_STATUS) {
    return { ok: false, status: XERO_NOT_SENT_STATUS, error: await res.text(), tenantId: auth.tenantId }
  }
  if (res.status === 429) {
    return { ok: false, status: 429, error: await res.text().catch(() => 'Rate limited'), tenantId: auth.tenantId }
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
  const auth = await getAccessToken()
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
  const auth = await getAccessToken()
  if (!auth) return await notConnectedResponse()

  const url = `${XERO_BASE_URL}/${endpoint}/${objectId}/Attachments/${encodeURIComponent(filename)}`

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
