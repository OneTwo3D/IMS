/**
 * QuickBooks Online HTTP client with automatic token refresh and rate-limit handling.
 *
 * QBO rate limits: 10 requests/second, 500 requests/minute per app.
 * We use conservative limits (9/sec, 450/min) to leave headroom.
 */

import { db } from '@/lib/db'
import { getAccessToken } from './auth'
import { getQuickBooksSettings } from './settings'

const QBO_PRODUCTION_BASE = 'https://quickbooks.api.intuit.com/v3/company'
const QBO_SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com/v3/company'
const QBO_MINOR_VERSION = 73
const QBO_MAX_RETRIES = 3
const QBO_SECOND_LIMIT = 9
const QBO_MINUTE_LIMIT = 450
const QBO_CONNECTOR = 'quickbooks'

const secondBuckets = new Map<string, number[]>()
const minuteBuckets = new Map<string, number[]>()

export type QboApiError = {
  Fault?: {
    type?: string
    Error?: Array<{ Message?: string; Detail?: string; code?: string }>
  }
}

export type QboResponse<T = unknown> = {
  ok: boolean
  status: number
  data?: T
  error?: string
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

async function waitForBudget(realmId: string) {
  while (true) {
    const now = Date.now()
    const second = (secondBuckets.get(realmId) ?? []).filter((ts) => ts >= now - 1_000)
    const minute = (minuteBuckets.get(realmId) ?? []).filter((ts) => ts >= now - 60_000)
    secondBuckets.set(realmId, second)
    minuteBuckets.set(realmId, minute)

    const secondWait = second.length >= QBO_SECOND_LIMIT ? 1_000 - (now - second[0]) : 0
    const minuteWait = minute.length >= QBO_MINUTE_LIMIT ? 60_000 - (now - minute[0]) : 0
    const waitMs = Math.max(secondWait, minuteWait)
    if (waitMs <= 0) return
    await sleep(waitMs)
  }
}

function noteRequest(realmId: string) {
  const now = Date.now()
  pushRequestTimestamp(secondBuckets, realmId, now, 1_000)
  pushRequestTimestamp(minuteBuckets, realmId, now, 60_000)
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0
  const seconds = Number.parseInt(value, 10)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const absolute = Date.parse(value)
  return Number.isFinite(absolute) ? Math.max(0, absolute - Date.now()) : 0
}

async function getBaseUrl(): Promise<string> {
  const settings = await getQuickBooksSettings()
  return settings.quickbooks_use_sandbox === 'true' ? QBO_SANDBOX_BASE : QBO_PRODUCTION_BASE
}

function buildUrl(baseUrl: string, realmId: string, path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${baseUrl}/${realmId}/${path}${separator}minorversion=${QBO_MINOR_VERSION}`
}

function appendQueryParam(path: string, key: string, value: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

function parseQboError(body: unknown): string {
  const err = body as QboApiError
  if (!err?.Fault?.Error?.length) return ''
  return err.Fault.Error
    .map((e) => [e.Message, e.Detail].filter(Boolean).join(': '))
    .join('; ')
}

async function performRequest(auth: { accessToken: string; realmId: string }, init: RequestInit, url: string) {
  let lastRateLimitMs = 0

  for (let attempt = 0; attempt <= QBO_MAX_RETRIES; attempt++) {
    await waitForBudget(auth.realmId)
    noteRequest(auth.realmId)

    const res = await fetch(url, init)
    if (res.status !== 429) return res

    lastRateLimitMs = Math.max(parseRetryAfterMs(res.headers.get('Retry-After')), 1000 * 2 ** attempt)
    if (attempt === QBO_MAX_RETRIES) {
      return { ok: false, status: 429, text: async () => `Rate limited after retries; retry after ${lastRateLimitMs}ms` } as Response
    }

    await sleep(lastRateLimitMs)
  }

  return { ok: false, status: 429, text: async () => `Rate limited after retries; retry after ${lastRateLimitMs}ms` } as Response
}

async function qboFetch<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts?: { requestId?: string },
): Promise<QboResponse<T>> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to QuickBooks' }

  const baseUrl = await getBaseUrl()
  const requestPath = opts?.requestId ? appendQueryParam(path, 'requestid', opts.requestId) : path
  const url = buildUrl(baseUrl, auth.realmId, requestPath)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Accept': 'application/json',
  }

  const init: RequestInit = { method, headers }

  if (body) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await performRequest(auth, init, url)
  if (res.status === 429) {
    return { ok: false, status: 429, error: await res.text().catch(() => 'Rate limited') }
  }

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`
    try {
      const errBody = await res.json()
      const parsed = parseQboError(errBody)
      if (parsed) errorMessage = parsed
    } catch {
      errorMessage += ': ' + await res.text().catch(() => 'Unknown error')
    }
    return { ok: false, status: res.status, error: errorMessage }
  }

  const data = await res.json() as T
  return { ok: true, status: res.status, data }
}

export async function qboGet<T = unknown>(path: string): Promise<QboResponse<T>> {
  return qboFetch<T>('GET', path)
}

export async function qboPost<T = unknown>(path: string, body: unknown): Promise<QboResponse<T>> {
  return qboFetch<T>('POST', path, body)
}

export async function qboPostIdempotent<T = unknown>(
  path: string,
  body: unknown,
  requestId: string,
): Promise<QboResponse<T>> {
  return qboFetch<T>('POST', path, body, { requestId })
}

/**
 * Execute a QBO SQL-like query.
 * Example: qboQuery('Account', "Active = true") → SELECT * FROM Account WHERE Active = true
 */
export async function qboQuery<T = unknown>(entity: string, where?: string): Promise<QboResponse<T>> {
  const query = where ? `SELECT * FROM ${entity} WHERE ${where}` : `SELECT * FROM ${entity}`
  return qboFetch<T>('GET', `query?query=${encodeURIComponent(query)}`)
}

/**
 * Raw binary GET request (e.g. for PDF download).
 */
export async function qboGetRaw(
  path: string,
  accept: string = 'application/pdf',
): Promise<{ ok: boolean; status: number; buffer?: Buffer; error?: string }> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to QuickBooks' }

  const baseUrl = await getBaseUrl()
  const url = buildUrl(baseUrl, auth.realmId, path)

  const res = await performRequest(auth, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Accept': accept,
    },
  }, url)

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
 * Upload a file attachment to a QBO entity.
 * QBO uses the Attachable entity + upload endpoint.
 */
export async function qboUploadAttachment(
  entityType: string,
  entityId: string,
  filename: string,
  fileBuffer: Buffer,
  contentType: string,
): Promise<QboResponse> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to QuickBooks' }

  const baseUrl = await getBaseUrl()
  const url = `${baseUrl}/${auth.realmId}/upload?minorversion=${QBO_MINOR_VERSION}`

  // QBO upload requires multipart/form-data with file_metadata_0 (JSON) and file_content_0 (binary)
  const metadata = JSON.stringify({
    AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
    FileName: filename,
    ContentType: contentType,
  })

  const boundary = `----QBOBoundary${Date.now()}`
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_0"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file_content_0"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ]

  const head = Buffer.from(parts[0])
  const mid = Buffer.from(parts[1])
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, mid, fileBuffer, tail])

  const res = await performRequest(auth, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Accept': 'application/json',
    },
    body: new Uint8Array(body),
  }, url)

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

/**
 * Escape a string value for use in QBO SQL-like queries.
 * Single quotes are doubled: O'Brien → O''Brien
 */
export function escapeQboQueryValue(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Resolve an account code or ID to a QBO AccountRef { value: id }.
 * Looks up AccountingAccount by code first, then by externalAccountId.
 * Returns null if not found.
 */
export async function resolveAccountRef(codeOrId: string): Promise<{ value: string } | null> {
  if (!codeOrId) return null

  // Try by code (AcctNum) first
  const byCode = await db.accountingAccount.findFirst({
    where: { connector: QBO_CONNECTOR, code: codeOrId, active: true },
    select: { externalAccountId: true },
  })
  if (byCode) return { value: byCode.externalAccountId }

  // Try by externalAccountId directly (already a QBO ID)
  const byId = await db.accountingAccount.findFirst({
    where: { connector: QBO_CONNECTOR, externalAccountId: codeOrId, active: true },
    select: { externalAccountId: true },
  })
  if (byId) return { value: byId.externalAccountId }

  return null
}
