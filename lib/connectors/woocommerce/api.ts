import { getSettingValues } from '@/lib/settings-store'
import { connectorFetch } from '@/lib/security/connector-fetch'
import type { ConnectorCredentials } from '../types'
import { WC_CREDENTIAL_SETTING_KEYS, resolveWcCredentials } from './credentials'
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
  // o3d-ecbj: the same resolver the advisory-lock snapshots in stock-sync.ts /
  // product-sync.ts use. They cannot share this READ — they must take their settings
  // inside their own locked transaction — so the only thing that can keep them in step is
  // sharing the interpretation of what they read.
  const map = await getSettingValues([...WC_CREDENTIAL_SETTING_KEYS])
  const resolution = resolveWcCredentials({
    url: map.get('wc_url'),
    key: map.get('wc_consumer_key'),
    secret: map.get('wc_consumer_secret'),
  })
  if (resolution.ok) return resolution.credentials
  // An unusable store URL is thrown, not swallowed: this is the interactive path, and
  // "not configured" would send an operator hunting for a missing setting that is present.
  if (resolution.reason === 'invalid_url') throw new Error(resolution.error)
  return null
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
    signal: AbortSignal.timeout(120000),
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
    signal: AbortSignal.timeout(120000),
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
    signal: AbortSignal.timeout(120000),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API PUT error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}
