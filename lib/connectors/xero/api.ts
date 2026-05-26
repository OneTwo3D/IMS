/**
 * Xero HTTP client with automatic token refresh and rate-limit handling.
 */

import { getAccessToken } from './auth'
import { connectorFetch } from '@/lib/security/connector-fetch'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'
const XERO_MAX_RETRIES = 3
const XERO_MINUTE_LIMIT = 55
const XERO_DAY_LIMIT = 4900

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

async function waitForBudget(tenantId: string) {
  while (true) {
    const now = Date.now()
    const minute = (minuteBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 60_000)
    const day = (dayBuckets.get(tenantId) ?? []).filter((ts) => ts >= now - 86_400_000)
    minuteBuckets.set(tenantId, minute)
    dayBuckets.set(tenantId, day)

    const minuteWait = minute.length >= XERO_MINUTE_LIMIT ? 60_000 - (now - minute[0]) : 0
    const dayWait = day.length >= XERO_DAY_LIMIT ? 86_400_000 - (now - day[0]) : 0
    const waitMs = Math.max(minuteWait, dayWait)
    if (waitMs <= 0) return
    await sleep(waitMs)
  }
}

function noteRequest(tenantId: string) {
  const now = Date.now()
  pushRequestTimestamp(minuteBuckets, tenantId, now, 60_000)
  pushRequestTimestamp(dayBuckets, tenantId, now, 86_400_000)
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

  for (let attempt = 0; attempt <= XERO_MAX_RETRIES; attempt++) {
    await waitForBudget(auth.tenantId)
    noteRequest(auth.tenantId)

    const res = await connectorFetch(url, init, { connectorName: 'Xero' })
    if (res.status !== 429) return res

    lastRateLimitMs = Math.max(parseRetryAfterMs(res.headers.get('Retry-After')), 1000 * 2 ** attempt)
    if (attempt === XERO_MAX_RETRIES) {
      return { ok: false, status: 429, text: async () => `Rate limited after retries; retry after ${lastRateLimitMs}ms` } as Response
    }

    await sleep(lastRateLimitMs)
  }

  return { ok: false, status: 429, text: async () => `Rate limited after retries; retry after ${lastRateLimitMs}ms` } as Response
}

async function xeroFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string },
): Promise<XeroResponse<T>> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to Xero' }

  const url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Xero-Tenant-Id': auth.tenantId,
    'Accept': 'application/json',
  }
  if (opts?.idempotencyKey && method !== 'GET') {
    headers['Idempotency-Key'] = opts.idempotencyKey
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
      const errBody = await res.json() as XeroApiError
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
    } catch {
      errorMessage += ': ' + await res.text().catch(() => 'Unknown error')
    }
    return { ok: false, status: res.status, error: errorMessage }
  }

  const data = await res.json() as T
  return { ok: true, status: res.status, data }
}

export async function xeroGet<T = unknown>(path: string): Promise<XeroResponse<T>> {
  return xeroFetch<T>('GET', path)
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
  if (!auth) return { ok: false, status: 0, error: 'Not connected to Xero' }

  const url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

  const res = await performRequest(auth, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
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
  if (!auth) return { ok: false, status: 0, error: 'Not connected to Xero' }

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
