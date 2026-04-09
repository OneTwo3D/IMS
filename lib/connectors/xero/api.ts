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
): Promise<XeroResponse<T>> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to Xero' }

  const url = path.startsWith('http') ? path : `${XERO_BASE_URL}/${path}`

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Xero-Tenant-Id': auth.tenantId,
    'Accept': 'application/json',
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

export async function xeroPost<T = unknown>(path: string, body: unknown): Promise<XeroResponse<T>> {
  return xeroFetch<T>('POST', path, body)
}

export async function xeroPut<T = unknown>(path: string, body: unknown): Promise<XeroResponse<T>> {
  return xeroFetch<T>('PUT', path, body)
}
