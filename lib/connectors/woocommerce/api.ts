import { getSettingValues } from '@/lib/settings-store'
import { connectorFetch } from '@/lib/security/connector-fetch'
import type { ConnectorCredentials } from '../types'
import { validateWooCommerceBaseUrl } from './url-safety'

const GENERIC_WC_NOT_CONFIGURED_ERROR = 'WooCommerce integration is not configured.'

function logMissingWooCommerceCredentials(): void {
  console.warn('[woocommerce-api] missing required WooCommerce settings', {
    missing: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'],
  })
}

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

function validateWooCommerceCredentials(
  credentials: ConnectorCredentials,
): { ok: true; credentials: ConnectorCredentials } | { ok: false; error: string } {
  const validated = validateWooCommerceBaseUrl(credentials.url)
  if (!validated.ok) return { ok: false, error: validated.error }
  return {
    ok: true,
    credentials: {
      ...credentials,
      url: validated.normalizedUrl,
    },
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

/**
 * Per-request ceiling for every WooCommerce call (o3d-jcx: exported so the callers that page can
 * reason about their aggregate worst case against the webhook inbox's stale-processing window,
 * instead of the number being three copies of a literal nobody can see from outside).
 */
export const WC_REQUEST_TIMEOUT_MS = 120_000

/**
 * Value used for a pagination header WooCommerce did not send readably (o3d-jcx).
 *
 * Negative on purpose: it can never be mistaken for a real count, and a caller that compares it
 * against a page number stops rather than looping, while a caller that validates it (see
 * fetchAllWcVariations) can refuse instead of silently treating page 1 as the whole set.
 */
export const WC_PAGINATION_UNKNOWN = -1

/** Exported for test: the NaN this replaced is the silent truncation itself (o3d-jcx). */
export function readWcCountHeader(raw: string | null, whenAbsent: number): number {
  if (raw === null) return whenAbsent
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : WC_PAGINATION_UNKNOWN
}

export async function wcFetch(
  path: string,
  params: Record<string, string> = {},
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; totalPages: number; totalItems: number; error?: string }> {
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, totalPages: 0, totalItems: 0, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) {
    return { data: null, totalPages: 0, totalItems: 0, error: validatedCredentials.error }
  }
  const safeCredentials = validatedCredentials.credentials

  const url = new URL(`${safeCredentials.url}/wp-json/wc/v3${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API error: ${res.status} ${detail}` }
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API returned non-JSON response (${contentType}). The server may have timed out.` }
  }

  // o3d-jcx: `parseInt('')` is NaN, and `page <= NaN` is false — so a WooCommerce install that
  // sent an EMPTY x-wp-totalpages ended every paging loop in this connector after page one and
  // reported the truncated result as complete. NaN is now surfaced as a NEGATIVE sentinel so a
  // caller that pages can tell "one page" from "the server did not say", rather than the two
  // being indistinguishable. Callers that ignore it are no worse off than before.
  const totalPages = readWcCountHeader(res.headers.get('x-wp-totalpages'), 1)
  const totalItems = readWcCountHeader(res.headers.get('x-wp-total'), 0)
  const data = await res.json()
  return { data, totalPages, totalItems }
}

export async function wcPost(
  path: string,
  body: unknown,
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; error?: string }> {
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) return { data: null, error: validatedCredentials.error }
  const safeCredentials = validatedCredentials.credentials

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(`${safeCredentials.url}/wp-json/wc/v3${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
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
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) return { data: null, error: validatedCredentials.error }
  const safeCredentials = validatedCredentials.credentials

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(`${safeCredentials.url}/wp-json/wc/v3${path}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API PUT error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}
