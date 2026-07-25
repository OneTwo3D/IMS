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
import { connectorFetch } from '@/lib/security/connector-fetch'
import { clearXeroReferenceCache } from './api'
import { parseGrantedScopes, scopesFromTokenResponse, XERO_SCOPE_STRING } from './scopes'

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_CONNECTOR = 'xero'
const XERO_OAUTH_STATE_PREFIX = 'xero_oauth_state:'
const XERO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_ORGANISATION_URL = 'https://api.xero.com/api.xro/2.0/Organisation'
// The scope list lives in ./scopes alongside the per-sync-type requirements and the validation, so what
// we ASK for and what we CHECK can never drift apart (o3d-g2i). Adding a scope only takes effect after a
// RECONNECT: a refreshed token carries only the scopes granted at the original consent, which is why the
// grant is now recorded and checked rather than assumed.

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  /**
   * What Xero granted. NOT guaranteed to be present, and may be a string or an array — the authoritative
   * copy is the `scope` claim inside the access-token JWT, which scopesFromTokenResponse falls back to.
   */
  scope?: string | string[]
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
  grantedScopes: string | null
}

type OAuthStatePayload = {
  initiatorUserId: string
  returnPath: string | null
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
    grantedScopes: row.grantedScopes,
  }
}

async function upsertStoredToken(params: {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
  grantedScopes: string | null
}): Promise<void> {
  const data = {
    connector: XERO_CONNECTOR,
    accessToken: encryptSecret(params.accessToken),
    refreshToken: params.refreshToken ? encryptSecret(params.refreshToken) : null,
    expiresAt: params.expiresAt,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    grantedScopes: params.grantedScopes,
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
  const res = await connectorFetch(XERO_ORGANISATION_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
    },
  }, { connectorName: 'Xero' })
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
  returnPath?: string,
): Promise<string> {
  const state = crypto.randomUUID()
  const payload: OAuthStatePayload = {
    initiatorUserId,
    returnPath: returnPath && returnPath.startsWith('/') ? returnPath : null,
  }
  await setAuthToken(`${XERO_OAUTH_STATE_PREFIX}${state}`, JSON.stringify(payload), XERO_OAUTH_STATE_TTL_MS)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: XERO_SCOPE_STRING,
    state,
  })
  return `${XERO_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Validate and consume a previously issued Xero OAuth state token.
 * Returns the initiating user ID on success, or null if the state is missing,
 * expired, or already consumed. Tokens are single-use.
 */
export async function consumeXeroOAuthState(state: string): Promise<OAuthStatePayload | null> {
  if (!state) return null
  const value = await consumeAuthToken(`${XERO_OAUTH_STATE_PREFIX}${state}`)
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<OAuthStatePayload>
    if (typeof parsed.initiatorUserId !== 'string' || !parsed.initiatorUserId) return null
    return {
      initiatorUserId: parsed.initiatorUserId,
      returnPath: typeof parsed.returnPath === 'string' && parsed.returnPath.startsWith('/') ? parsed.returnPath : null,
    }
  } catch {
    return { initiatorUserId: value, returnPath: null }
  }
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
    const tokenRes = await connectorFetch(XERO_TOKEN_URL, {
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
    }, { connectorName: 'Xero' })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return { success: false, error: `Token exchange failed: ${err}` }
    }

    const tokenData: TokenResponse = await tokenRes.json()

    // Fetch tenant (organisation) info
    const connRes = await connectorFetch(XERO_CONNECTIONS_URL, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    }, { connectorName: 'Xero' })

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
      // What was actually GRANTED, which is not necessarily what we asked for: the operator can decline
      // individual scopes on the consent screen, and Xero says so here rather than at the failing call.
      // Read from the response field OR the access-token JWT claim — the top-level field is not
      // guaranteed, and taking null from its absence would leave validation off on a fresh reconnect.
      grantedScopes: scopesFromTokenResponse(tokenData),
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
      const res = await connectorFetch(XERO_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${buildBasicAuth(clientId, clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }),
      }, { connectorName: 'Xero' })

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
        // A refresh CANNOT widen a grant — it returns the scopes the original consent carried. Keeping
        // the stored value when the response says nothing is therefore right; overwriting it with null
        // would silently turn a known-deficient grant back into "unknown", which validation lets through.
        // It is also how a pre-existing connection FILLS IN its record without a reconnect: the JWT
        // fallback reads the grant off the new access token.
        grantedScopes: scopesFromTokenResponse(data) ?? token.grantedScopes,
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
 * Disconnect from Xero — clears the stored token and every id that token resolved.
 *
 * The accounting*Id columns are connector-agnostic: they hold ids belonging to whichever accounting
 * connector is connected. Left behind, a Xero ContactID/ItemID is read straight back by the
 * QuickBooks code path (or by a reconnect to a DIFFERENT Xero org) as if it were its own — the
 * lookups short-circuit on a stored id precisely so they never re-verify it. QuickBooks' disconnect
 * has always cleared contacts this way; Xero's did not, which was a live bug before the item column
 * gave it a second column to leak (o3d-3nc).
 */
export async function disconnect(): Promise<void> {
  await db.$transaction([
    db.accountingToken.deleteMany({ where: { connector: XERO_CONNECTOR } }),
    db.setting.deleteMany({ where: { key: XERO_EXPECTED_TENANT_KEY } }),
    db.customer.updateMany({
      where: { accountingContactId: { not: null } },
      data: { accountingContactId: null, accountingContactProvenance: null },
    }),
    db.supplier.updateMany({
      where: { accountingContactId: { not: null } },
      data: { accountingContactId: null, accountingContactProvenance: null },
    }),
    db.product.updateMany({
      where: { accountingItemId: { not: null } },
      data: { accountingItemId: null, accountingItemProvenance: null },
    }),
  ])
  // Drop cached reference data too (o3d-e2j) — the next connection is a different org and must not read
  // this one's tax rates / base currency.
  clearXeroReferenceCache()
}

/**
 * Check if Xero is connected (token exists).
 */
export async function isConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const token = await readStoredToken()
  if (!token) return { connected: false }
  return { connected: true, tenantName: token.tenantName ?? undefined }
}

/**
 * The scopes this connection was actually GRANTED, or null when that was never recorded (o3d-g2i).
 *
 * The null is load-bearing and must be passed through rather than defaulted to []: a token stored before
 * the grant was recorded knows nothing about its own scopes, and treating that as "granted nothing" would
 * block every scope-dependent sync on every installation the moment this shipped. Unknown means "let Xero
 * answer"; only a grant we have read and found wanting stops anything.
 */
export async function getGrantedScopes(): Promise<string[] | null> {
  const token = await readStoredToken()
  if (!token) return null
  return parseGrantedScopes(token.grantedScopes)
}
