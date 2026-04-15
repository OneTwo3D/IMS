/**
 * Xero HTTP client with automatic token refresh and rate-limit handling.
 */

import { getAccessToken } from './auth'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'

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

  const res = await fetch(url, init)

  // Rate limit handling
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 60_000
    return { ok: false, status: 429, error: `Rate limited — retry after ${waitMs}ms` }
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

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
      'Accept': accept,
    },
  })

  if (res.status === 429) {
    return { ok: false, status: 429, error: 'Rate limited' }
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

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Xero-Tenant-Id': auth.tenantId,
      'Content-Type': contentType,
      'Content-Length': String(fileBuffer.length),
    },
    body: new Uint8Array(fileBuffer),
  })

  if (res.status === 429) {
    return { ok: false, status: 429, error: 'Rate limited' }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error')
    return { ok: false, status: res.status, error: `Attachment upload failed: ${errText}` }
  }

  const data = await res.json().catch(() => ({}))
  return { ok: true, status: res.status, data }
}
