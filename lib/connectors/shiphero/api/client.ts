import { getShipheroAccessToken, getShipheroApiConfiguration, invalidateShipheroAccessToken } from './auth'
import { SHIPHERO_GRAPHQL_PATH } from '@/lib/connectors/shiphero/settings/schema'
import type { WmsWarehouseRef } from '@/lib/connectors/wms/types'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { extractShipheroWarehouses } from './normalizers'

export type ShipheroGraphqlError = {
  message?: string
  code?: string | number
  required_credits?: number
  remaining_credits?: number
  [key: string]: unknown
}

export type ShipheroGraphqlResult<T> = {
  data: T | null
  errors?: ShipheroGraphqlError[]
  error?: string
  status: number
}

// --- Error classification (ported from woocommerce-shiphero-sync) ----------
// We match on MESSAGE substrings, never integer codes: ShipHero's "not enough
// credits" throttle and its invalid-token errors can share code 30, so a
// code-based classifier would invalidate the token on a quota error and retry
// the over-budget query. Throttle is checked first so a quota error whose
// message happens to contain an auth word doesn't trigger token recovery.

const INVALID_TOKEN_PATTERNS = [
  'invalid token',
  'expired token',
  'invalid access_token',
  'invalid access token',
  'invalid bearer',
  'unauthorized',
  'not authorized',
  'authentication failed',
] as const

const THROTTLE_PATTERNS = [
  'not enough credits',
  'required_credits',
  'remaining_credits',
  'throttle',
  'rate limit',
  'too many requests',
  'quota exceeded',
  'quota',
] as const

export function looksLikeShipheroThrottle(error: ShipheroGraphqlError | null | undefined): boolean {
  if (!error || typeof error !== 'object') return false
  if (typeof error.required_credits === 'number' || typeof error.remaining_credits === 'number') return true
  const message = String(error.message ?? '').toLowerCase()
  return THROTTLE_PATTERNS.some((pattern) => message.includes(pattern))
}

export function isShipheroInvalidTokenErrors(errors: ShipheroGraphqlError[] | null | undefined): boolean {
  if (!errors?.length) return false
  for (const error of errors) {
    if (!error || typeof error !== 'object') continue
    // Throttle-shaped errors fall through to the query-error path, not auth recovery.
    if (looksLikeShipheroThrottle(error)) continue
    const message = String(error.message ?? '').toLowerCase()
    if (INVALID_TOKEN_PATTERNS.some((pattern) => message.includes(pattern))) return true
  }
  return false
}

export function shipheroErrorsAreTransient(errors: ShipheroGraphqlError[] | null | undefined): boolean {
  if (!errors?.length) return false
  return errors.some((error) => looksLikeShipheroThrottle(error))
}

function summarizeShipheroErrors(errors: ShipheroGraphqlError[]): string {
  const first = errors.find((error) => error && typeof error.message === 'string' && error.message.trim())
  return first?.message?.trim() || 'ShipHero GraphQL request returned errors'
}

function buildShipheroRequestUrl(path: string, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBaseUrl)
}

async function sendShipheroGraphql<T>(
  baseUrl: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> | undefined,
): Promise<ShipheroGraphqlResult<T>> {
  const response = await connectorFetch(buildShipheroRequestUrl(SHIPHERO_GRAPHQL_PATH, baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
    cache: 'no-store',
  }, {
    connectorName: 'ShipHero',
    allowE2eLocalHttp: true,
  })

  const body = (await response.json().catch(() => null)) as { data?: T; errors?: ShipheroGraphqlError[] } | null

  // HTTP 401 is a definitive token rejection — no body inspection needed.
  if (response.status === 401) {
    return { data: null, error: 'ShipHero rejected the access token', status: response.status }
  }

  // Other non-2xx (403, 5xx, …): surface WITH any parsed errors[] so the caller
  // classifies. A 403 may carry a throttle/quota error[], which must not be
  // mistaken for an auth failure (that would burn a token refresh + retry the
  // over-budget query). The auth-rejection decision is left to
  // isShipheroInvalidTokenErrors, which skips throttle-shaped errors.
  if (!response.ok) {
    const errors = body?.errors?.length ? body.errors : undefined
    return {
      data: null,
      errors,
      error: errors ? summarizeShipheroErrors(errors) : `ShipHero GraphQL request failed with status ${response.status}`,
      status: response.status,
    }
  }

  if (body?.errors?.length) {
    return { data: body.data ?? null, errors: body.errors, error: summarizeShipheroErrors(body.errors), status: response.status }
  }

  return { data: body?.data ?? null, status: response.status }
}

/**
 * Execute a ShipHero GraphQL query/mutation. Mirrors the Mintsoft `mintsoftRequest`
 * lifecycle: fetch a cached bearer, send, and on an auth rejection (HTTP 401/403
 * or an invalid-token errors[] payload) refresh the token once and retry. Throttle
 * errors are NOT treated as auth failures — they surface to the caller for a
 * retry-next-tick at the sweep layer.
 */
export async function shipheroGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<ShipheroGraphqlResult<T>> {
  const config = await getShipheroApiConfiguration()

  try {
    const accessToken = await getShipheroAccessToken()
    const firstAttempt = await sendShipheroGraphql<T>(config.baseUrl, accessToken, query, variables)

    // HTTP 401 OR an invalid-token errors[] payload (which can ride on a 403 or
    // even a 200) drives a single refresh + retry. A 403 alone is NOT treated as
    // auth — its errors[] decides, so a throttle on a 403 falls through to the
    // caller instead of burning a refresh.
    const authRejected = firstAttempt.status === 401
      || isShipheroInvalidTokenErrors(firstAttempt.errors)
    if (!authRejected) {
      return firstAttempt
    }

    await invalidateShipheroAccessToken()
    const refreshedToken = await getShipheroAccessToken({ forceRefresh: true })
    return sendShipheroGraphql<T>(config.baseUrl, refreshedToken, query, variables)
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : 'ShipHero GraphQL request failed',
      status: 500,
    }
  }
}

const WAREHOUSES_QUERY = `query {
  account {
    data {
      warehouses {
        id
        legacy_id
        identifier
        profile
      }
    }
  }
}`

type ShipheroWarehousesData = {
  account?: { data?: { warehouses?: unknown } } | null
}

export async function fetchShipheroWarehouses(): Promise<WmsWarehouseRef[]> {
  const result = await shipheroGraphql<ShipheroWarehousesData>(WAREHOUSES_QUERY)
  if (result.error) throw new Error(result.error)
  return extractShipheroWarehouses(result.data?.account?.data?.warehouses)
}
