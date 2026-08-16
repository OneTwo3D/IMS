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
import { connectorFetch } from '@/lib/security/connector-fetch'
import { assertTenantSwitchIsSafe, recordConnectedTenantId } from '@/lib/domain/accounting/tenant-switch-guard'

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

  const res = await connectorFetch(`${base}/${realmId}/companyinfo/${realmId}?minorversion=73`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  }, { connectorName: 'QuickBooks' })

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

    // THE REALM-SWITCH GUARD (o3d-9kek r4 finding 1). The pin above is cleared by disconnect — that
    // is what makes a deliberate move possible — so it cannot answer "who did we used to be" at the
    // one moment that matters. This can, and it refuses the switch outright while any local document
    // still carries an id this realm did not issue.
    //
    // It is here rather than spread across the ~190 readers of a naked accountingInvoiceId because
    // those readers cannot be fixed by a rule: SalesOrder, SalesOrderRefund and SupplierCreditNote
    // have no provenance column to check at all. Refusing to CREATE the confusable state covers all
    // of them, and every reader written after this one. See o3d-5hku for the consumer audit this
    // does not do — until that lands, this guard is the only thing standing between a realm switch
    // and a payment settling the wrong bill.
    //
    // Before the token exchange on purpose: a refused switch must leave no token, no pin and no
    // trace behind.
    const switchDecision = await assertTenantSwitchIsSafe(db, {
      connector: QBO_CONNECTOR,
      connectorLabel: 'QuickBooks',
      tenantNoun: 'company',
      incomingTenantId: realmId,
    })
    if (!switchDecision.ok) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'quickbooks_realm_switch_refused',
        level: 'ERROR',
        description: switchDecision.error,
        metadata: {
          previousRealmId: switchDecision.previousTenantId,
          incomingRealmId: realmId,
          ...switchDecision.evidence,
        },
      })
      return { success: false, error: switchDecision.error }
    }

    const basicAuth = buildBasicAuth(clientId, clientSecret)
    const tokenRes = await connectorFetch(QBO_TOKEN_URL, {
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
    }, { connectorName: 'QuickBooks' })

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
    // Survives disconnect, unlike the pin — that is what lets the guard above recognise the NEXT
    // connect as a switch rather than as a first connection (o3d-9kek r4 finding 1).
    await recordConnectedTenantId(db, QBO_CONNECTOR, realmId)

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
      const res = await connectorFetch(QBO_TOKEN_URL, {
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
      }, { connectorName: 'QuickBooks' })

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
 *
 * THE REALM/TENANT-SWITCH LIFECYCLE (o3d-9kek r3 finding 1), which this function defines.
 *
 * Disconnect deliberately does NOT clear the external ids on documents — purchase_invoices
 * .accounting_invoice_id, sales_orders.accounting_invoice_id and the rest. They are financial
 * evidence: the only local record of which ledger document a bill or invoice became, and the
 * anchor every later correction and payment posts against. Cached LOOKUP ids (contacts, items) are
 * different — they are a performance cache with an authoritative source, so they are cleared.
 *
 * That retention is exactly why the ids are namespaced. Each stored bill id carries the
 * "<connector>:<tenantId>" of the connection that issued it, and uniqueness is enforced over the
 * PAIR, so:
 *
 *   1. DISCONNECT — token and pin go, ids stay. Nothing can be attributed: with no active
 *      provenance the repair sweep does nothing at all and the back-reference writers refuse.
 *   2. RECONNECT TO THE SAME tenant/realm — the provenance matches again and everything resumes
 *      exactly where it was. Nothing was destroyed to make the switch possible.
 *   3. RECONNECT TO A DIFFERENT ONE — REFUSED while any old id remains. See below.
 *
 * The pin (the *_EXPECTED_* setting) is what makes step 3 deliberate rather than accidental:
 * re-authorising to a different company while still connected is refused, and only an explicit
 * disconnect clears the pin.
 *
 * STEP 3 USED TO SAY SOMETHING FALSE, and o3d-9kek r4 finding 1 is the correction. It claimed the
 * old realm's history "stays readable and stays inert" once the namespaces diverge, on the strength
 * of the (id, provenance) pair being unique. The pair IS unique. The history is NOT inert:
 * payment-poller.ts selects bills by `accountingInvoiceId != null` alone and never looks at
 * accountingInvoiceProvenance, so a paid realm-B bill whose integer id collides with a retired
 * realm-A bill marks the A bill paid — and roughly 190 other call sites read a naked external id
 * the same way, on models (SalesOrder, SalesOrderRefund, SupplierCreditNote) that have no
 * provenance column to consult even in principle.
 *
 * Worse, the compound index CREATED that exposure: under the previous GLOBAL unique index realm B's
 * colliding id could not be written at all — legitimate work was blocked, but nothing was ever
 * confusable. So the namespace change is only safe alongside a guard that stops the confusable
 * state existing, and exchangeCodeForTokens now REFUSES a connect to a different realm while ids
 * this realm did not issue are still stored. The full consumer audit is o3d-5hku.
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
        await connectorFetch(QBO_REVOKE_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${buildBasicAuth(clientId, clientSecret)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ token: token.refreshToken }),
        }, { connectorName: 'QuickBooks' })
      } catch {
        // Best-effort: disconnect should complete even if connectorFetch adds
        // timeout, response-size, DNS, or network failures to token revocation.
      }
    }
  }

  await db.$transaction([
    db.accountingToken.deleteMany({ where: { connector: QBO_CONNECTOR } }),
    db.setting.deleteMany({ where: { key: QBO_EXPECTED_REALM_KEY } }),
    // DELIBERATELY ABSENT: lastConnectedTenantSettingKey('quickbooks'). Do not add it here. The pin
    // above is cleared because an explicit disconnect is how an operator declares they intend to
    // move; the last-connected marker is what lets the NEXT connect recognise that move as a switch
    // and refuse it while this realm's ids are still stored (o3d-9kek r4 finding 1). Deleting it
    // would make every reconnect look like a first connection and silently reopen the window.

    // Clear cached contact + item IDs so stale QuickBooks IDs aren't reused after
    // reconnecting to a different company or switching connectors.
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
}

/**
 * Check if QuickBooks is connected (token exists).
 */
export async function isConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const token = await readStoredToken()
  if (!token) return { connected: false }
  return { connected: true, tenantName: token.tenantName ?? undefined }
}
