/**
 * QuickBooks Online OAuth2 token management (authorization_code grant).
 *
 * Flow: save credentials → redirect user to Intuit consent screen →
 * Intuit redirects back to /api/accounting/callback with auth code + realmId →
 * callback exchanges code for access + refresh tokens.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { setAuthToken, consumeAuthToken } from '@/lib/auth/token-store'
import { notify } from '@/lib/notifications'
import { decryptSecret, encryptSecret, hasEncryptionKey, isEncryptedValue } from '@/lib/secrets'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { getBaseCurrencyCode } from '@/lib/base-currency'

const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
const QBO_CONNECTOR = 'quickbooks'
const QBO_OAUTH_STATE_PREFIX = 'qbo_oauth_state:'
const QBO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const QBO_SCOPES = 'com.intuit.quickbooks.accounting openid profile email'
const QBO_EXPECTED_REALM_KEY = 'quickbooks_expected_realm_id'
const REFRESH_EARLY_MS = 2 * 60 * 1000

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

type StoredAccountingToken = {
  id: string
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string // realmId in QBO terms
  tenantName: string | null
}

type OAuthStatePayload = {
  initiatorUserId: string
  returnPath: string | null
}

let refreshInFlight: Promise<{ accessToken: string; realmId: string } | null> | null = null

function buildBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

async function readStoredToken(): Promise<StoredAccountingToken | null> {
  const row = await db.accountingToken.findUnique({ where: { connector: QBO_CONNECTOR } })
  if (!row) return null

  const accessToken = decryptSecret(row.accessToken)
  const refreshToken = row.refreshToken ? decryptSecret(row.refreshToken) : null

  // Lazy migrate plaintext → encrypted
  if (hasEncryptionKey() && (!isEncryptedValue(row.accessToken) || (row.refreshToken && !isEncryptedValue(row.refreshToken)))) {
    try {
      await db.accountingToken.update({
        where: { connector: QBO_CONNECTOR },
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
    connector: QBO_CONNECTOR,
    accessToken: encryptSecret(params.accessToken),
    refreshToken: params.refreshToken ? encryptSecret(params.refreshToken) : null,
    expiresAt: params.expiresAt,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
  }
  await db.accountingToken.upsert({
    where: { connector: QBO_CONNECTOR },
    create: data,
    update: data,
  })
}

async function getExpectedRealmId(): Promise<string | null> {
  const token = await db.accountingToken.findUnique({
    where: { connector: QBO_CONNECTOR },
    select: { tenantId: true },
  })
  const stored = await getSettingValue(QBO_EXPECTED_REALM_KEY)
  return stored ?? token?.tenantId ?? null
}

async function pinRealmId(realmId: string): Promise<void> {
  await db.setting.upsert({
    where: { key: QBO_EXPECTED_REALM_KEY },
    create: { key: QBO_EXPECTED_REALM_KEY, value: serializeSettingValue(QBO_EXPECTED_REALM_KEY, realmId) },
    update: { value: serializeSettingValue(QBO_EXPECTED_REALM_KEY, realmId) },
  })
}

/**
 * Fetch the company base currency from QuickBooks CompanyInfo endpoint.
 */
async function fetchCompanyInfo(
  accessToken: string,
  realmId: string,
  useSandbox: boolean,
): Promise<{ companyName: string | null; baseCurrency: string | null }> {
  const base = useSandbox
    ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
    : 'https://quickbooks.api.intuit.com/v3/company'

  const res = await fetch(`${base}/${realmId}/companyinfo/${realmId}?minorversion=73`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  })

  if (!res.ok) return { companyName: null, baseCurrency: null }

  const data = await res.json() as Record<string, unknown>
  const info = data.CompanyInfo as Record<string, unknown> | undefined
  if (!info) return { companyName: null, baseCurrency: null }

  const companyName = typeof info.CompanyName === 'string' ? info.CompanyName : null
  const currencyRef = info.HomeCurrency as Record<string, unknown> | undefined
  const baseCurrency = typeof currencyRef?.value === 'string'
    ? currencyRef.value.toUpperCase()
    // Some QBO responses use a plain string instead of CurrencyRef
    : typeof info.HomeCurrency === 'string' ? (info.HomeCurrency as string).toUpperCase() : null

  return { companyName, baseCurrency }
}

async function logRefreshFailure(reason: string): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    tag: 'sync',
    action: 'quickbooks_refresh_failed',
    level: 'ERROR',
    description: reason,
  })
  await notify({
    type: 'error',
    title: 'QuickBooks connection needs attention',
    message: reason,
    actionUrl: '/sync',
  })
}

/**
 * Get a valid access token. Auto-refreshes if expired.
 * Returns null if not connected.
 */
export async function getAccessToken(): Promise<{ accessToken: string; realmId: string } | null> {
  const token = await readStoredToken()
  if (!token) return null

  if (token.expiresAt < new Date(Date.now() + REFRESH_EARLY_MS)) {
    const refreshed = await refreshToken()
    if (!refreshed) return null
    return refreshed
  }

  return { accessToken: token.accessToken, realmId: token.tenantId }
}

/**
 * Build the Intuit authorization URL. The user's browser is redirected here.
 *
 * SECURITY: generates a random `state` parameter bound to the initiating user
 * and persists it server-side with a short TTL. The callback MUST re-verify
 * the returned state via `consumeQuickBooksOAuthState` before exchanging the code.
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
  await setAuthToken(`${QBO_OAUTH_STATE_PREFIX}${state}`, JSON.stringify(payload), QBO_OAUTH_STATE_TTL_MS)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: QBO_SCOPES,
    state,
  })
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Validate and consume a previously issued QuickBooks OAuth state token.
 * Returns the initiating user ID on success, or null if invalid/expired/consumed.
 */
export async function consumeQuickBooksOAuthState(state: string): Promise<OAuthStatePayload | null> {
  if (!state) return null
  const value = await consumeAuthToken(`${QBO_OAUTH_STATE_PREFIX}${state}`)
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
 * QBO passes realmId as a query parameter in the callback URL.
 */
export async function exchangeCodeForTokens(
  code: string,
  realmId: string,
  redirectUri: string,
): Promise<{ success: boolean; tenantName?: string; error?: string }> {
  try {
    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('quickbooks_client_id'),
      getSettingValue('quickbooks_client_secret'),
    ])

    if (!clientId || !clientSecret) {
      return { success: false, error: 'Missing QuickBooks credentials' }
    }

    // Validate realmId against pinned value (if any)
    const expectedRealmId = await getExpectedRealmId()
    if (expectedRealmId && expectedRealmId !== realmId) {
      return {
        success: false,
        error: `Connected QuickBooks company does not match the pinned company (${expectedRealmId}). Reconnect to the expected company or disconnect first.`,
      }
    }

    const basicAuth = buildBasicAuth(clientId, clientSecret)
    const tokenRes = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
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

    // Determine sandbox mode
    const sandboxSetting = await getSettingValue('quickbooks_use_sandbox')
    const useSandbox = sandboxSetting === 'true'

    // Fetch company info for name and currency validation
    const { companyName, baseCurrency: qboCurrency } = await fetchCompanyInfo(
      tokenData.access_token,
      realmId,
      useSandbox,
    )

    const imsBaseCurrency = await getBaseCurrencyCode()
    if (qboCurrency && qboCurrency !== imsBaseCurrency) {
      return {
        success: false,
        error: `QuickBooks company base currency (${qboCurrency}) must match the IMS base currency (${imsBaseCurrency}).`,
      }
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
    await upsertStoredToken({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresAt,
      tenantId: realmId,
      tenantName: companyName,
    })
    await pinRealmId(realmId)

    // Store realmId as company_id setting
    await db.setting.upsert({
      where: { key: 'quickbooks_company_id' },
      create: { key: 'quickbooks_company_id', value: realmId },
      update: { value: realmId },
    })

    return { success: true, tenantName: companyName ?? realmId }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Refresh the access token using the refresh_token grant.
 * Uses in-flight deduplication to prevent concurrent refresh races.
 */
export async function refreshToken(): Promise<{ accessToken: string; realmId: string } | null> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const token = await readStoredToken()
    if (!token?.refreshToken) return null

    // Double-check: token might have been refreshed by another request
    if (token.expiresAt >= new Date(Date.now() + REFRESH_EARLY_MS)) {
      return { accessToken: token.accessToken, realmId: token.tenantId }
    }

    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('quickbooks_client_id'),
      getSettingValue('quickbooks_client_secret'),
    ])

    if (!clientId || !clientSecret) {
      await logRefreshFailure('QuickBooks token refresh failed because client credentials are missing.')
      return null
    }

    try {
      const res = await fetch(QBO_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${buildBasicAuth(clientId, clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }),
      })

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '')
        await logRefreshFailure(`QuickBooks token refresh failed (HTTP ${res.status}): ${errorBody || 'Unknown error'}`)
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

      return { accessToken: data.access_token, realmId: token.tenantId }
    } catch (error) {
      await logRefreshFailure(`QuickBooks token refresh failed: ${String(error)}`)
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
 * Disconnect from QuickBooks — clears stored token and revokes refresh token.
 */
export async function disconnect(): Promise<void> {
  // Attempt to revoke the refresh token (best-effort)
  const token = await readStoredToken()
  if (token?.refreshToken) {
    const [clientId, clientSecret] = await Promise.all([
      getSettingValue('quickbooks_client_id'),
      getSettingValue('quickbooks_client_secret'),
    ])
    if (clientId && clientSecret) {
      try {
        await fetch(QBO_REVOKE_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${buildBasicAuth(clientId, clientSecret)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ token: token.refreshToken }),
        })
      } catch {
        // Best-effort — don't fail disconnect on revoke error
      }
    }
  }

  await db.$transaction([
    db.accountingToken.deleteMany({ where: { connector: QBO_CONNECTOR } }),
    db.setting.deleteMany({ where: { key: QBO_EXPECTED_REALM_KEY } }),
    // Clear cached contact IDs so stale QuickBooks IDs aren't reused after
    // reconnecting to a different company or switching connectors.
    db.customer.updateMany({
      where: { accountingContactId: { not: null } },
      data: { accountingContactId: null },
    }),
    db.supplier.updateMany({
      where: { accountingContactId: { not: null } },
      data: { accountingContactId: null },
    }),
  ])
}

/**
 * Check if QuickBooks is connected (token exists).
 */
export async function isConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const token = await readStoredToken()
  if (!token) return { connected: false }
  return { connected: true, tenantName: token.tenantName ?? undefined }
}
