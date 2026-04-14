/**
 * WooCommerce REST API client.
 */

import { db } from '@/lib/db'
import type { ConnectorCredentials } from '../types'

export async function getWcCredentials(): Promise<ConnectorCredentials | null> {
  const settings = await db.setting.findMany({
    where: { key: { in: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] } },
  })
  const map = new Map(settings.map((s) => [s.key, s.value]))
  const url = map.get('wc_url')
  const key = map.get('wc_consumer_key')
  const secret = map.get('wc_consumer_secret')
  if (!url || !key || !secret) return null
  return { url: url.replace(/\/$/, ''), key, secret }
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
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API error: ${res.status} ${res.statusText}` }
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

  if (!res.ok) return { data: null, error: `WC API POST error: ${res.status} ${res.statusText}` }
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

  if (!res.ok) return { data: null, error: `WC API PUT error: ${res.status} ${res.statusText}` }
  return { data: await res.json() }
}
