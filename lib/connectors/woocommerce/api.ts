import { getSettingValues } from '@/lib/settings-store'
import type { ConnectorCredentials } from '../types'
import { validateWooCommerceBaseUrl } from './url-safety'

async function readErrorDetails(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = await res.json() as { code?: string; message?: string }
      return [body.code, body.message].filter(Boolean).join(': ') || JSON.stringify(body)
    }
    return (await res.text()).slice(0, 500)
  } catch {
    return res.statusText
  }
}

export async function getWcCredentials(): Promise<ConnectorCredentials | null> {
  const map = await getSettingValues(['wc_url', 'wc_consumer_key', 'wc_consumer_secret'])
  const url = map.get('wc_url')
  const key = map.get('wc_consumer_key')
  const secret = map.get('wc_consumer_secret')
  if (!url || !key || !secret) return null

  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) {
    throw new Error(validated.error)
  }

  return { url: validated.normalizedUrl, key, secret }
}

export async function wcFetch(
  path: string,
  params: Record<string, string> = {},
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; totalPages: number; totalItems: number; error?: string }> {
  const credentials = creds ?? (await getWcCredentials())
  if (!credentials) {
    return { data: null, totalPages: 0, totalItems: 0, error: 'WooCommerce not configured. Set wc_url, wc_consumer_key, wc_consumer_secret in Settings.' }
  }

  const url = new URL(`${credentials.url}/wp-json/wc/v3${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(120000),
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API error: ${res.status} ${detail}` }
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API returned non-JSON response (${contentType}). The server may have timed out.` }
  }

  const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1')
  const totalItems = parseInt(res.headers.get('x-wp-total') ?? '0')
  const data = await res.json()
  return { data, totalPages, totalItems }
}

export async function wcPost(
  path: string,
  body: unknown,
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; error?: string }> {
  const credentials = creds ?? (await getWcCredentials())
  if (!credentials) return { data: null, error: 'WooCommerce not configured.' }

  const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
  const res = await fetch(`${credentials.url}/wp-json/wc/v3${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API POST error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}

export async function wcPut(
  path: string,
  body: unknown,
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; error?: string }> {
  const credentials = creds ?? (await getWcCredentials())
  if (!credentials) return { data: null, error: 'WooCommerce not configured.' }

  const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
  const res = await fetch(`${credentials.url}/wp-json/wc/v3${path}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API PUT error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}
