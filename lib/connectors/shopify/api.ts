import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ConnectorCredentials } from '@/lib/connectors/types'
import { getShopifySettings } from './settings'

const SHOPIFY_API_VERSION = '2025-01'

export type ShopifyCredentials = ConnectorCredentials & {
  storeDomain: string
  adminApiAccessToken: string
  webhookSecret: string
}

export type ShopifyGraphqlResult<T> = {
  data: T | null
  error?: string
}

type ShopifyGraphqlEnvelope<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

function normalizeStoreDomain(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withProtocol)
    const hostname = url.hostname.toLowerCase()
    return hostname || null
  } catch {
    return null
  }
}

async function readErrorDetails(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''

  try {
    if (contentType.includes('application/json')) {
      const body = await res.json() as ShopifyGraphqlEnvelope<unknown>
      const messages = body.errors?.map((entry) => entry.message).filter(Boolean)
      if (messages && messages.length > 0) return messages.join('; ')
      return JSON.stringify(body)
    }

    return (await res.text()).slice(0, 500)
  } catch {
    return res.statusText
  }
}

export function extractShopifyLegacyResourceId(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return trimmed

  const match = trimmed.match(/\/(\d+)(?:\?.*)?$/)
  return match?.[1] ?? null
}

export async function getShopifyCredentials(): Promise<ShopifyCredentials | null> {
  const settings = await getShopifySettings()
  const storeDomain = normalizeStoreDomain(settings.shopify_store_domain)
  const adminApiAccessToken = settings.shopify_admin_api_access_token.trim()

  if (!storeDomain || !adminApiAccessToken) return null

  return {
    url: `https://${storeDomain}`,
    key: adminApiAccessToken,
    secret: settings.shopify_webhook_secret.trim(),
    storeDomain,
    adminApiAccessToken,
    webhookSecret: settings.shopify_webhook_secret.trim(),
  }
}

export function buildShopifyAdminUrl(
  creds: Pick<ShopifyCredentials, 'storeDomain'>,
  resource: 'products' | 'orders',
  externalId: number | string | null | undefined,
): string | null {
  const legacyId = extractShopifyLegacyResourceId(externalId)
  if (!legacyId) return null
  return `https://${creds.storeDomain}/admin/${resource}/${legacyId}`
}

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  creds?: ShopifyCredentials | null,
): Promise<ShopifyGraphqlResult<T>> {
  const credentials = creds ?? (await getShopifyCredentials())
  if (!credentials) {
    return {
      data: null,
      error: 'Shopify not configured. Set shopify_store_domain and shopify_admin_api_access_token in Settings.',
    }
  }

  const res = await fetch(`https://${credentials.storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': credentials.adminApiAccessToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `Shopify API error: ${res.status} ${detail}` }
  }

  const payload = await res.json() as ShopifyGraphqlEnvelope<T>
  if (payload.errors && payload.errors.length > 0) {
    const detail = payload.errors.map((entry) => entry.message).filter(Boolean).join('; ') || 'Unknown GraphQL error'
    return { data: null, error: `Shopify GraphQL error: ${detail}` }
  }

  return { data: payload.data ?? null }
}

export function verifyShopifyWebhookSignature(body: string, providedSignature: string, secret: string): boolean {
  if (!providedSignature || !secret) return false

  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('base64')
  const providedBuffer = Buffer.from(providedSignature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

