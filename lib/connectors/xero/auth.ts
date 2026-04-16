/**
 * Xero OAuth2 token management for standard Web App (authorization_code grant).
 *
 * Flow: save credentials → redirect user to Xero consent screen →
 * Xero redirects back to /api/accounting/callback with auth code →
 * callback exchanges code for access + refresh tokens.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { setAuthToken, consumeAuthToken } from '@/lib/auth/token-store'
import { notify } from '@/lib/notifications'
import { decryptSecret, encryptSecret, hasEncryptionKey, isEncryptedValue } from '@/lib/secrets'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { getBaseCurrencyCode } from '@/lib/base-currency'

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_CONNECTOR = 'xero'
const XERO_OAUTH_STATE_PREFIX = 'xero_oauth_state:'
const XERO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_ORGANISATION_URL = 'https://api.xero.com/api.xro/2.0/Organisation'
const XERO_SCOPES = 'openid profile email offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.attachments'

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

type XeroConnection = {
  id: string
  tenantId: string
  tenantName: string
  tenantType: string
}

type StoredAccountingToken = {
  id: string
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
}

const XERO_EXPECTED_TENANT_KEY = 'xero_expected_tenant_id'
const REFRESH_EARLY_MS = 2 * 60 * 1000

let refreshInFlight: Promise<{ accessToken: string; tenantId: string } | null> | null = null

function buildBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

async function readStoredToken(): Promise<StoredAccountingToken | null> {
  const row = await db.accountingToken.findUnique({ where: { connector: XERO_CONNECTOR } })
  if (!row) return null

  const accessToken = decryptSecret(row.accessToken)
  const refreshToken = row.refreshToken ? decryptSecret(row.refreshToken) : null

  if (hasEncryptionKey() && (!isEncryptedValue(row.accessToken) || (row.refreshToken && !isEncryptedValue(row.refreshToken)))) {
    try {
      await db.accountingToken.update({
        where: { connector: XERO_CONNECTOR },
        data: {
          accessToken: encryptSecret(accessToken),
          refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
        },
      })
    } catch {
      // Best-effort migration only.
    }
  }

  return {
    id: row.id,
    accessToken,
    refreshToken,
    expiresAt: row.expiresAt,
    tenantId: row.tenantId,
    tenantName: row.tenantName,
  }
}

async function upsertStoredToken(params: {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
}): Promise<void> {
  const data = {
    connector: XERO_CONNECTOR,
    accessToken: encryptSecret(params.accessToken),
    refreshToken: params.refreshToken ? encryptSecret(params.refreshToken) : null,
    expiresAt: params.expiresAt,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
  }
  await db.accountingToken.upsert({
    where: { connector: XERO_CONNECTOR },
    create: data,
    update: data,
  })
}

async function getExpectedTenantId(): Promise<string | null> {
  const token = await db.accountingToken.findUnique({
    where: { connector: XERO_CONNECTOR },
    select: { tenantId: true },
  })
  const stored = await getSettingValue(XERO_EXPECTED_TENANT_KEY)
  return stored ?? token?.tenantId ?? null
}

async function pinTenantId(tenantId: string): Promise<void> {
  await db.setting.upsert({
    where: { key: XERO_EXPECTED_TENANT_KEY },
    create: { key: XERO_EXPECTED_TENANT_KEY, value: serializeSettingValue(XERO_EXPECTED_TENANT_KEY, tenantId) },
    update: { value: serializeSettingValue(XERO_EXPECTED_TENANT_KEY, tenantId) },
  })
}

function selectTenantConnection(connections: XeroConnection[], expectedTenantId: string | null) {
  if (!expectedTenantId) return connections[0] ?? null
  return connections.find((conn) => conn.tenantId === expectedTenantId) ?? null
}

async function fetchOrganisationBaseCurrency(accessToken: string, tenantId: string): Promise<string | null> {
  const res = await fetch(XERO_ORGANISATION_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
    },
  })
  if (!res.ok) return null
  const data = await res.json() as Record<string, unknown>
  const organisations =
    (Array.isArray(data.Organisations) ? data.Organisations : null)
    ?? (Array.isArray(data.Organisation) ? data.Organisation : null)
    ?? []
  const first = organisations[0]
  if (!first || typeof first !== 'object') return null
  const baseCurrency = (first as Record<string, unknown>).BaseCurrency
  return typeof baseCurrency === 'string' && baseCurrency ? baseCurrency.toUpperCase() : null
}

async function logRefreshFailure(reason: string): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    tag: 'sync',
    action: 'xero_refresh_failed',
    level: 'ERROR',
    description: reason,
  })
  await notify({
    type: 'error',
    title: 'Xero connection needs attention',
    message: reason,
    actionUrl: '/sync',
  })
}

/**
 * Get a valid access token. Auto-refreshes if expired.
 * Returns null if not connected.
 */
export async function getAccessToken(): Promise<{ accessToken: string; tenantId: string } | null> {
  const token = await readStoredToken()
  if (!token) return null

  if (token.expiresAt < new Date(Date.now() + REFRESH_EARLY_MS)) {
    const refreshed = await refreshToken()
    if (!refreshed) return null
    return { accessToken: refreshed.accessToken, tenantId: refreshed.tenantId }
  }

  return { accessToken: token.accessToken, tenantId: token.tenantId }
}

/**
 * Build the Xero authorization URL. The user's browser is redirected here.
 *
 * SECURITY: generates a random `state` parameter bound to the initiating user
 * and persists it server-side with a short TTL. The callback MUST re-verify
 * the returned state via `consumeXeroOAuthState` before exchanging the code,
 * preventing CSRF / mix-up attacks on the Xero tenant binding.
 */
export async function getAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  initiatorUserId: string,
): Promise<string> {
  const state = crypto.randomUUID()
  await setAuthToken(`${XERO_OAUTH_STATE_PREFIX}${state}`, initiatorUserId, XERO_OAUTH_STATE_TTL_MS)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: XERO_SCOPES,
    state,
  })
  return `${XERO_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Validate and consume a previously issued Xero OAuth state token.
 * Returns the initiating user ID on success, or null if the state is missing,
 * expired, or already consumed. Tokens are single-use.
 */
export async function consumeXeroOAuthState(state: string): Promise<string | null> {
  if (!state) return null
  return consumeAuthToken(`${XERO_OAUTH_STATE_PREFIX}${state}`)
}

/**
 * Exchange an authorization code for tokens (called from /api/accounting/callback).
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{ success: boolean; tenantName?: string; error?: string }> {
  try {
    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('xero_client_id'),
      getSettingValue('xero_client_secret'),
    ])

    if (!clientId || !clientSecret) {
      return { success: false, error: 'Missing Xero credentials' }
    }

    const basicAuth = buildBasicAuth(clientId, clientSecret)
    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return { success: false, error: `Token exchange failed: ${err}` }
    }

    const tokenData: TokenResponse = await tokenRes.json()

    // Fetch tenant (organisation) info
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    })

    if (!connRes.ok) {
      const connErr = await connRes.text().catch(() => '')
      return { success: false, error: `Failed to fetch Xero connections (HTTP ${connRes.status}): ${connErr}` }
    }

    const connections: XeroConnection[] = await connRes.json()
    if (!connections.length) {
      return { success: false, error: 'No Xero organisations found for this app' }
    }

    const expectedTenantId = await getExpectedTenantId()
    const conn = selectTenantConnection(connections, expectedTenantId)
    if (!conn) {
      return {
        success: false,
        error: expectedTenantId
          ? `Connected Xero organisation does not match the pinned tenant (${expectedTenantId}). Reconnect to the expected organisation or clear the tenant binding before switching.`
          : 'Unable to resolve a Xero organisation for this app.',
      }
    }

    const [organisationBaseCurrency, imsBaseCurrency] = await Promise.all([
      fetchOrganisationBaseCurrency(tokenData.access_token, conn.tenantId),
      getBaseCurrencyCode(),
    ])
    if (organisationBaseCurrency && organisationBaseCurrency !== imsBaseCurrency) {
      return {
        success: false,
        error: `Xero organisation base currency (${organisationBaseCurrency}) must match the IMS base currency (${imsBaseCurrency}).`,
      }
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
    await upsertStoredToken({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresAt,
      tenantId: conn.tenantId,
      tenantName: conn.tenantName,
    })
    await pinTenantId(conn.tenantId)

    return { success: true, tenantName: conn.tenantName }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Refresh the access token using the refresh_token grant.
 */
export async function refreshToken(): Promise<{ accessToken: string; tenantId: string } | null> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const token = await readStoredToken()
    if (!token?.refreshToken) return null

    if (token.expiresAt >= new Date(Date.now() + REFRESH_EARLY_MS)) {
      return { accessToken: token.accessToken, tenantId: token.tenantId }
    }

    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('xero_client_id'),
      getSettingValue('xero_client_secret'),
    ])

    if (!clientId || !clientSecret) {
      await logRefreshFailure('Xero token refresh failed because client credentials are missing.')
      return null
    }

    try {
      const res = await fetch(XERO_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${buildBasicAuth(clientId, clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }),
      })

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '')
        await logRefreshFailure(`Xero token refresh failed (HTTP ${res.status}): ${errorBody || 'Unknown error'}`)
        return null
      }

      const data: TokenResponse = await res.json()
      const expiresAt = new Date(Date.now() + data.expires_in * 1000)

      await upsertStoredToken({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? token.refreshToken,
        expiresAt,
        tenantId: token.tenantId,
        tenantName: token.tenantName,
      })

      return { accessToken: data.access_token, tenantId: token.tenantId }
    } catch (error) {
      await logRefreshFailure(`Xero token refresh failed: ${String(error)}`)
      return null
    }
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/**
 * Disconnect from Xero — clears stored token.
 */
export async function disconnect(): Promise<void> {
  await db.$transaction([
    db.accountingToken.deleteMany({ where: { connector: XERO_CONNECTOR } }),
    db.setting.deleteMany({ where: { key: XERO_EXPECTED_TENANT_KEY } }),
  ])
}

/**
 * Check if Xero is connected (token exists).
 */
export async function isConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const token = await readStoredToken()
  if (!token) return { connected: false }
  return { connected: true, tenantName: token.tenantName ?? undefined }
}
