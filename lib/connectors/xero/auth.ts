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
import {
  isXeroTenantAllowed, nameOnlyGuardWarning, readXeroTenantAllowList, selectXeroTenant,
  storedTenantRefusalMessage, type XeroTenantAllowList,
} from './tenant-guard'

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

/**
 * Refusals are recorded as well as returned (o3d-9tbz). The incident this guards against was silent for
 * days; the redirect back to /sync carries the message, but only to whoever happens to be looking at the
 * browser at that moment. Best-effort: a logging failure must not turn a refusal into a 500.
 */
async function logTenantRefusal(reason: string, message: string): Promise<void> {
  try {
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'xero_connect_refused',
      level: 'ERROR',
      description: message,
      metadata: { connector: XERO_CONNECTOR, reason },
    })
  } catch {
    // Best-effort only.
  }
}

/**
 * Only warn once per offending tenant, so a blocked instance does not mint a notification per sync tick.
 * Reset on the first allowed read, so a later violation is announced again.
 */
let allowListWarnedTenantId: string | null = null

/**
 * The same once-only discipline for the WEAK-GUARD warning (o3d-9tbz r2).
 *
 * A server restricted by organisation NAME alone has no identity anchor — Xero names are neither unique
 * nor fixed — and that is worth saying, but it is a standing condition rather than an event, so saying it
 * on every sync tick would bury the notifications that mean something.
 */
let nameOnlyWarnedTenantId: string | null = null

/**
 * Say once that a NAME-only tenant guard is weaker than it looks (o3d-9tbz r2).
 *
 * Not a refusal: refusing would switch off the only tenant control the e2e rig currently has, and a
 * control nobody can use protects nothing. The warning names XERO_BLOCKED_TENANT_IDS, which is the one
 * remedy that survives the Demo company's ~28-day tenantId rotation without any maintenance.
 */
async function warnNameOnlyGuard(allowList: XeroTenantAllowList, tenantId: string): Promise<void> {
  if (!allowList.nameOnlyGuard || nameOnlyWarnedTenantId === tenantId) return
  nameOnlyWarnedTenantId = tenantId
  try {
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'xero_tenant_guard_name_only',
      level: 'WARNING',
      description: nameOnlyGuardWarning(allowList),
      metadata: { connector: XERO_CONNECTOR, tenantId },
    })
  } catch {
    // Best-effort only — a logging failure must not stop a sync that is otherwise permitted.
  }
}

/**
 * The env allow-list, enforced against the STORED token rather than the callback (o3d-9tbz).
 *
 * The callback check alone would not have stopped the o3d-t74p incident past its first minute: the
 * connection was established once and then every sync for days ran off the stored token. It is also the
 * only thing that catches a database restored from another environment with its Xero token still in it,
 * where no callback ever runs.
 */
async function storedTenantAllowed(token: StoredAccountingToken): Promise<boolean> {
  const allowList = readXeroTenantAllowList()
  const summary = { tenantId: token.tenantId, tenantName: token.tenantName }
  if (isXeroTenantAllowed(summary, allowList)) {
    allowListWarnedTenantId = null
    await warnNameOnlyGuard(allowList, token.tenantId)
    return true
  }

  const message = storedTenantRefusalMessage(summary, allowList)
  if (allowListWarnedTenantId !== token.tenantId) {
    allowListWarnedTenantId = token.tenantId
    try {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'xero_stored_tenant_refused',
        level: 'ERROR',
        description: message,
        metadata: { connector: XERO_CONNECTOR, tenantId: token.tenantId },
      })
      await notify({ type: 'error', title: 'Xero connection blocked', message, actionUrl: '/sync' })
    } catch {
      // Best-effort only — the refusal itself stands either way.
    }
  }
  return false
}

/**
 * Why the stored connection is unusable, when the reason is the env allow-list — or null.
 *
 * Every Xero call reports a missing token as "Not connected to Xero", which for an allow-list block is
 * true but useless: the operator sees a disconnection they cannot explain and a Test Connection that
 * complains about base currency. The api layer substitutes this message so the reason travels with the
 * failure instead of only into the notification.
 */
export async function getStoredTenantBlockReason(): Promise<string | null> {
  const row = await db.accountingToken.findUnique({
    where: { connector: XERO_CONNECTOR },
    select: { tenantId: true, tenantName: true },
  })
  if (!row) return null
  const allowList = readXeroTenantAllowList()
  if (isXeroTenantAllowed(row, allowList)) return null
  return storedTenantRefusalMessage(row, allowList)
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
  if (!(await storedTenantAllowed(token))) return null

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

    // A revoked authorisation answers 200 with an EMPTY ARRAY rather than an error, so "no organisations"
    // is a body shape, not a status code. Anything that is not an array is treated the same way: an
    // unexpected body must not reach .filter() as a crash.
    const connectionsBody: unknown = await connRes.json()
    const connections: XeroConnection[] = Array.isArray(connectionsBody) ? connectionsBody as XeroConnection[] : []

    const expectedTenantId = await getExpectedTenantId()
    const allowList = readXeroTenantAllowList()
    const choice = selectXeroTenant({ connections, expectedTenantId, allowList })
    if (!choice.ok) {
      await logTenantRefusal(choice.reason, choice.error)
      return { success: false, error: choice.error }
    }
    const conn = choice.connection
    // The moment the operator is actually watching, and the moment a name-only guard binds a ledger.
    await warnNameOnlyGuard(allowList, conn.tenantId)

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
    if (!(await storedTenantAllowed(token))) return null

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
/**
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
 *   3. RECONNECT TO A DIFFERENT ONE — the new connection has a new provenance. Every old id is in
 *      a foreign namespace: it is not a uniqueness conflict, it is not "already linked" (a document
 *      linked in the old org reads as unlinked here and can post afresh), and old sync rows are
 *      invisible to the sweep because their stored provenance no longer matches.
 *
 * The pin (the *_EXPECTED_* setting) is what makes step 3 deliberate rather than accidental:
 * re-authorising to a different organisation while still connected is refused, and only an explicit
 * disconnect clears the pin.
 *
 * WHY XERO DOES NOT NEED QUICKBOOKS' REALM-SWITCH GUARD (o3d-9kek r4 finding 1, verified rather than
 * assumed). QuickBooks refuses a connect to a different realm outright, because a QuickBooks bill id
 * is a per-company INTEGER: realm B routinely issues id "42", so a retired realm-A bill holding "42"
 * is confused with it by every consumer that reads a naked accountingInvoiceId — and payment-poller
 * .ts, which selects on `accountingInvoiceId != null` alone, demonstrably does exactly that.
 *
 * Xero ids are GUIDs, and that is what removes the exposure, not the namespace column. The poller
 * here builds its match set FROM XERO (`invoiceById` keyed on InvoiceID, then
 * `accountingInvoiceId: { in: [...] }`), so a retired org's GUID cannot appear in it: no two Xero
 * organisations ever issue the same InvoiceID. A stale GUID therefore matches nothing and resolves
 * nothing — the failure mode is a loud 404 on the next post, not a payment settling the wrong
 * invoice. Checked: payment-poller.ts, payment-reconcile.ts and the sync-processor's update paths
 * all key on ids that came back from Xero within the current tenant.
 *
 * The residual this note used to describe — `connections[0]` when the pin is absent, so a
 * post-disconnect reconnect could silently land on a different organisation — is GONE as of o3d-9tbz.
 * Clearing the pin here now means the next consent must be unambiguous by itself: one organisation
 * offered, or an allow-list that narrows it to one, or IMS refuses and asks.
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
 * Is Xero connected — meaning USABLE, not merely "a token row exists" (o3d-9tbz).
 *
 * This used to answer `connected: true` for the presence of a row alone, so an instance whose stored
 * tenant the allow-list forbids reported a healthy green connection on /sync while every single sync
 * failed. That is the worst possible reading: the one screen an operator checks to find out whether
 * Xero is working told them it was, and the real reason sat in a notification they had to go and find.
 *
 * A blocked connection is therefore NOT connected, and carries the reason with it.
 *
 * `hasStoredToken` is load-bearing and separate from `connected`: the refusal text tells the operator
 * to "disconnect Xero on /sync", and /sync only offers a Disconnect button when there is something to
 * disconnect. Collapsing the blocked state into a plain `connected: false` would hide that button and
 * make the remedy unperformable — the operator would be told to press something that is not there.
 *
 * Deliberately uses the PURE allow-list check rather than `storedTenantAllowed`: this runs on every
 * render of /sync, onboarding and settings, and a read that mints an activity row and a notification
 * per page view would bury the one notification that matters.
 */
export async function isConnected(): Promise<{
  connected: boolean
  tenantName?: string
  blockedReason?: string
  hasStoredToken?: boolean
}> {
  const token = await readStoredToken()
  if (!token) return { connected: false }

  const summary = { tenantId: token.tenantId, tenantName: token.tenantName }
  const allowList = readXeroTenantAllowList()
  if (!isXeroTenantAllowed(summary, allowList)) {
    return {
      connected: false,
      hasStoredToken: true,
      tenantName: token.tenantName ?? undefined,
      blockedReason: storedTenantRefusalMessage(summary, allowList),
    }
  }

  return { connected: true, tenantName: token.tenantName ?? undefined, hasStoredToken: true }
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
