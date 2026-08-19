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
import { deserializeSettingValue, getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { clearXeroReferenceCache } from './api'
import { parseGrantedScopes, scopesFromTokenResponse, XERO_SCOPE_STRING } from './scopes'
import {
  demoOrgConnectRefusal, nameOnlyGuardWarning, readXeroTenantAllowList, selectXeroTenant,
  storedXeroConnectionRefusal, xeroDemoOrgVerdict, xeroTenantBindingRaceMessage,
  type XeroConnectionSummary, type XeroTenantAllowList,
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
  /**
   * Xero's `IsDemoCompany` for this organisation, as read from GET /Organisation at the consent that
   * established this connection — or null when it was never read (o3d-9tbz r3).
   *
   * Null is load-bearing and is NOT the same as false. A token stored before XERO_REQUIRE_DEMO_ORG
   * existed, or one that arrived inside a restored dump from another environment, knows nothing about
   * its own organisation; under that key it is refused as UNVERIFIED, with a remedy (reconnect) that
   * differs from the one for an organisation Xero has actually told us is not a demo company.
   */
  tenantIsDemo: boolean | null
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
      // Scoped to the exact row that was READ — same organisation, same ciphertext (o3d-9tbz r4). This
      // is the refresh defect's smaller twin: it re-writes token material read a moment ago, so keyed on
      // `connector` alone it could re-encrypt a retired organisation's tokens on top of a connection
      // that had since been rebound. A miss means the row moved on and the migration is simply not
      // needed; it was always best-effort.
      await db.accountingToken.updateMany({
        where: { connector: XERO_CONNECTOR, tenantId: row.tenantId, accessToken: row.accessToken },
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
    tenantIsDemo: row.tenantIsDemo ?? null,
  }
}

type StoredTokenWrite = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
  grantedScopes: string | null
  tenantIsDemo: boolean | null
}

function storedTokenRow(params: StoredTokenWrite) {
  return {
    connector: XERO_CONNECTOR,
    accessToken: encryptSecret(params.accessToken),
    refreshToken: params.refreshToken ? encryptSecret(params.refreshToken) : null,
    expiresAt: params.expiresAt,
    tenantId: params.tenantId,
    tenantName: params.tenantName,
    grantedScopes: params.grantedScopes,
    tenantIsDemo: params.tenantIsDemo,
  }
}

/**
 * Write a REFRESHED token — and only while the row still names the organisation it was refreshed for
 * (o3d-9tbz r4).
 *
 * THE RACE THIS CLOSES. Round 3 made the BINDING atomic, so of two consents only one leaves a pin and a
 * token behind. The refresh path went straight round it. A refresh is a long round trip to Xero that
 * began by READING the token row; by the time it comes back to write, an operator may have disconnected
 * and re-consented to a different organisation, and that binding may already have committed. An upsert
 * keyed on `connector` alone has no idea any of that happened: it overwrites the winner's token with the
 * old organisation's. The instance is then bound to one organisation by its PIN and to another by its
 * TOKEN — the exact split round 3 closed, reached through a different door, and the one that decides
 * where invoices are actually posted is the token.
 *
 * WHAT MAKES IT SAFE is again not a check in this process — a check would sit on the wrong side of the
 * same window. The organisation is put in the WHERE clause, so the database evaluates it AT THE WRITE:
 *
 *     UPDATE accounting_tokens SET ... WHERE connector = 'xero' AND tenant_id = <the one we refreshed>
 *
 * If a rebinding has already committed, the predicate no longer matches and nothing is written. If the
 * rebinding is still IN FLIGHT, this statement waits on its row lock rather than racing it, and under
 * READ COMMITTED Postgres re-evaluates the predicate against the row the winner committed — so the
 * outcome is the same whichever order the two arrive in. `updateMany` rather than `update` because a
 * miss must be an ANSWER (count 0) rather than an exception to classify; round 3 already paid for the
 * lesson that catching the wrong P-code reports the wrong cause.
 *
 * IT ALSO STOPS A REFRESH RESURRECTING A DISCONNECTED CONNECTION. The upsert's `create` branch would
 * re-insert a token row that `disconnect()` had just deleted, quietly reconnecting an instance to the
 * organisation an operator had just detached it from. There is no create branch here at all.
 *
 * ORDINARY REFRESH IS UNTOUCHED: the tenant asked for is the tenant on the row, the predicate matches,
 * one row is updated. Returning false means only that this token is stale — the caller fails THIS call
 * and the next one reads the new binding.
 */
async function storeRefreshedToken(params: StoredTokenWrite): Promise<boolean> {
  const { count } = await db.accountingToken.updateMany({
    where: { connector: XERO_CONNECTOR, tenantId: params.tenantId },
    data: storedTokenRow(params),
  })
  return count > 0
}

async function getExpectedTenantId(): Promise<string | null> {
  const token = await db.accountingToken.findUnique({
    where: { connector: XERO_CONNECTOR },
    select: { tenantId: true },
  })
  const stored = await getSettingValue(XERO_EXPECTED_TENANT_KEY)
  return stored ?? token?.tenantId ?? null
}

/**
 * Bind this instance to ONE Xero organisation — token row and pin — atomically (o3d-9tbz r3).
 *
 * THE RACE. Everything upstream of here is a check against a SNAPSHOT: `getExpectedTenantId()` reads the
 * pin, `selectXeroTenant` decides against it, and the write happens later. Two OAuth callbacks in flight
 * at once — an operator who double-clicks Connect, two operators connecting at the same time, a browser
 * that replays the redirect — both read "no pin" on a fresh database, both pass every check, and the
 * second one's write lands on top of the first. The pin is the ONLY thing that makes a later consent to
 * a different organisation refuse, so a race that rewrites it does not trip the guard, it removes it.
 * That is the same shape as the incident this branch exists for: the rig invoiced into the live ledger
 * because nothing had bound it to Demo first.
 *
 * WHAT MAKES IT ATOMIC is not a check. `settings.key` is a PRIMARY KEY, so of two concurrent INSERTs of
 * `xero_expected_tenant_id` the database blocks the second until the first commits and then rejects it
 * (P2002). No amount of read-then-write in this process can do that, because the window being closed is
 * between the read and the write. The pin is therefore INSERTed first inside the transaction and the
 * token row written after it: the loser's INSERT fails, the transaction rolls back, and its token never
 * reaches the database at all — which is what lets the refusal say "nothing was stored" truthfully.
 *
 * A pin that already exists and names a DIFFERENT organisation is the same refusal by the other route:
 * the winner committed before this transaction started reading. Reconnecting to the SAME organisation —
 * the ordinary re-consent, and the one after a Demo reset — updates the pin and the token as before.
 *
 * `update` rather than "leave it alone" on the matching path is deliberate: it takes the row lock, so
 * two concurrent consents to the same organisation are serialised and the token row ends up wholly one
 * of them rather than a mixture.
 */
async function bindXeroTenant(params: {
  connection: XeroConnectionSummary
  token: StoredTokenWrite
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { connection, token } = params
  const pinValue = serializeSettingValue(XERO_EXPECTED_TENANT_KEY, token.tenantId)

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.setting.findUnique({ where: { key: XERO_EXPECTED_TENANT_KEY } })
      if (existing) {
        const pinned = deserializeSettingValue(XERO_EXPECTED_TENANT_KEY, existing.value)
        if (pinned !== token.tenantId) throw new XeroBindingRace(pinned)
        await tx.setting.update({ where: { key: XERO_EXPECTED_TENANT_KEY }, data: { value: pinValue } })
      } else {
        // The arbiter. Not an upsert: an upsert is exactly the check-then-write this must not be.
        //
        // The P2002 is caught HERE rather than around the whole transaction. The token upsert below has
        // unique constraints of its own, and a duplicate-key error from that statement means something
        // entirely different; treating any P2002 in this block as "another callback won the race" would
        // report the wrong cause with a remedy that does not fit it.
        try {
          await tx.setting.create({ data: { key: XERO_EXPECTED_TENANT_KEY, value: pinValue } })
        } catch (error) {
          if (!isUniqueViolation(error)) throw error
          throw new XeroBindingRace(null)
        }
      }
      const data = storedTokenRow(token)
      await tx.accountingToken.upsert({ where: { connector: XERO_CONNECTOR }, create: data, update: data })
    })
    return { ok: true }
  } catch (error) {
    if (!(error instanceof XeroBindingRace)) throw error
    const boundTo = await readBoundTenant(error.boundTenantId)

    // Losing the race to the SAME organisation is not a failure. An operator who double-clicks Connect
    // fires two callbacks for one consent; this instance ends up bound to exactly the organisation they
    // asked for, with a valid token, and the only thing discarded is a duplicate. Reporting that as an
    // error would put a refusal on the screen of somebody whose connection worked — and a guard that
    // cries wolf on the ordinary path is a guard that gets switched off, which is the failure mode this
    // whole branch exists to avoid.
    if (boundTo.tenantId === token.tenantId) return { ok: true }

    return { ok: false, error: xeroTenantBindingRaceMessage({ attempted: connection, boundTo }) }
  }
}

/**
 * A concurrent callback bound this instance first.
 *
 * `boundTenantId` is the pin this transaction READ when the winner had already committed, and null when
 * the unique index rejected the INSERT instead — in that case the winner's pin is only readable after
 * this transaction has rolled back, which is what `readBoundTenant` does.
 */
class XeroBindingRace extends Error {
  constructor(readonly boundTenantId: string | null) {
    super(`Xero tenant already bound${boundTenantId ? ` to ${boundTenantId}` : ''}`)
    this.name = 'XeroBindingRace'
  }
}

/**
 * Prisma's unique-constraint code, duck-typed.
 *
 * Deliberately not `instanceof Prisma.PrismaClientKnownRequestError`: the same duplicate key arrives as
 * a different class depending on which copy of the client raised it, and a test that cannot express "the
 * database rejected this INSERT" cannot test the only thing here that is load-bearing.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

/** Who actually holds the binding now, named as well as we can name it, for the loser's message. */
async function readBoundTenant(knownTenantId: string | null): Promise<XeroConnectionSummary> {
  const row = await db.accountingToken.findUnique({
    where: { connector: XERO_CONNECTOR },
    select: { tenantId: true, tenantName: true },
  }).catch(() => null)
  const pinned = knownTenantId ?? (await getSettingValue(XERO_EXPECTED_TENANT_KEY)) ?? row?.tenantId ?? '(unknown)'
  return { tenantId: pinned, tenantName: row?.tenantId === pinned ? row.tenantName : null }
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
  const summary = storedSummary(token)
  const message = storedXeroConnectionRefusal(summary, allowList)
  if (message === null) {
    allowListWarnedTenantId = null
    await warnNameOnlyGuard(allowList, token.tenantId)
    return true
  }

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
    select: { tenantId: true, tenantName: true, tenantIsDemo: true },
  })
  if (!row) return null
  return storedXeroConnectionRefusal(
    { tenantId: row.tenantId, tenantName: row.tenantName, isDemoCompany: row.tenantIsDemo ?? null },
    readXeroTenantAllowList(),
  )
}

/** The stored connection as the guard sees it — including what it knows about the organisation. */
function storedSummary(token: StoredAccountingToken): XeroConnectionSummary {
  return { tenantId: token.tenantId, tenantName: token.tenantName, isDemoCompany: token.tenantIsDemo }
}

/**
 * What GET /Organisation says about the organisation behind this token.
 *
 * One call, two answers, because the callback already made this call for the base currency and
 * `XERO_REQUIRE_DEMO_ORG` needs no second one (o3d-9tbz r3). Both fields are null when they could not be
 * read; for the demo flag that null is a refusal under that key, not a pass.
 */
type XeroOrganisationFacts = { baseCurrency: string | null; isDemoCompany: boolean | null }

/**
 * Is this a Xero DEMO organisation, according to Xero?
 *
 * `IsDemoCompany` is the authoritative field. `Class: "DEMO"` on the same object says the same thing and
 * is read as a second POSITIVE signal only — an unrecognised Class is not evidence either way, so it
 * yields null (unverified) rather than false. Only Xero explicitly saying `IsDemoCompany: false` earns
 * the "this is not a demo organisation" refusal, because that refusal tells the operator to go and pick
 * a different organisation and it must not be aimed at someone who already picked the right one.
 */
function readIsDemoCompany(organisation: Record<string, unknown>): boolean | null {
  if (typeof organisation.IsDemoCompany === 'boolean') return organisation.IsDemoCompany
  if (typeof organisation.Class === 'string' && organisation.Class.trim().toUpperCase() === 'DEMO') return true
  return null
}

async function fetchOrganisationFacts(accessToken: string, tenantId: string): Promise<XeroOrganisationFacts> {
  const unknown: XeroOrganisationFacts = { baseCurrency: null, isDemoCompany: null }
  const res = await connectorFetch(XERO_ORGANISATION_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
    },
  }, { connectorName: 'Xero' })
  if (!res.ok) return unknown
  const data = await res.json() as Record<string, unknown>
  const organisations =
    (Array.isArray(data.Organisations) ? data.Organisations : null)
    ?? (Array.isArray(data.Organisation) ? data.Organisation : null)
    ?? []
  const first = organisations[0]
  if (!first || typeof first !== 'object') return unknown
  const record = first as Record<string, unknown>
  const baseCurrency = record.BaseCurrency
  return {
    baseCurrency: typeof baseCurrency === 'string' && baseCurrency ? baseCurrency.toUpperCase() : null,
    isDemoCompany: readIsDemoCompany(record),
  }
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
 * A refreshed token was thrown away because it was no longer this instance's organisation (o3d-9tbz r4).
 *
 * Deliberately NOT logRefreshFailure: that one notifies, and this is not a failure anybody needs to act
 * on. It is still recorded, because "a sync failed once, at the moment somebody rebound the connector"
 * is otherwise an unexplainable blip in the activity log.
 */
async function logStaleRefreshDiscarded(token: StoredAccountingToken): Promise<void> {
  try {
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'xero_refresh_discarded',
      level: 'WARNING',
      description:
        `A Xero token refresh for ${token.tenantName ?? token.tenantId} was discarded: this instance is `
        + 'no longer connected to that organisation. Nothing was overwritten.',
      metadata: { connector: XERO_CONNECTOR, tenantId: token.tenantId },
    })
  } catch {
    // Best-effort only.
  }
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

    const [organisation, imsBaseCurrency] = await Promise.all([
      fetchOrganisationFacts(tokenData.access_token, conn.tenantId),
      getBaseCurrencyCode(),
    ])

    // The demo requirement is answered BEFORE the currency comparison. A rig pointed at a live
    // organisation whose base currency happens to match would otherwise sail past, and one whose
    // currency differs would be told about currencies when the real problem is the ledger it is about
    // to invoice into (o3d-9tbz r3).
    const demoVerdict = xeroDemoOrgVerdict(allowList, organisation.isDemoCompany)
    if (demoVerdict === 'not-demo' || demoVerdict === 'unverified') {
      const error = demoOrgConnectRefusal({ tenantId: conn.tenantId, tenantName: conn.tenantName }, demoVerdict)
      await logTenantRefusal(demoVerdict === 'not-demo' ? 'not-demo-org' : 'demo-unverified', error)
      return { success: false, error }
    }

    if (organisation.baseCurrency && organisation.baseCurrency !== imsBaseCurrency) {
      return {
        success: false,
        error: `Xero organisation base currency (${organisation.baseCurrency}) must match the IMS base currency (${imsBaseCurrency}).`,
      }
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
    // ONE write, and the database decides who wins it. Storing the token and pinning the tenant used to
    // be two statements, so a concurrent callback could interleave them and leave a token for one
    // organisation pinned to another — a binding that no longer names the ledger the syncs use.
    const bound = await bindXeroTenant({
      connection: { tenantId: conn.tenantId, tenantName: conn.tenantName },
      token: {
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
        // Recorded whether or not XERO_REQUIRE_DEMO_ORG is set today, so switching the key on does not
        // require a reconnect on an instance that was already connected to a demo organisation.
        tenantIsDemo: organisation.isDemoCompany,
      },
    })
    if (!bound.ok) {
      await logTenantRefusal('binding-race', bound.error)
      return { success: false, error: bound.error }
    }

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

      const stored = await storeRefreshedToken({
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
        // A refresh talks only to the identity endpoint — it learns nothing new about the organisation,
        // so carry the recorded demo status forward. Overwriting it with null would turn a connection
        // this instance HAS verified back into an unverified one at the next token expiry, and under
        // XERO_REQUIRE_DEMO_ORG that is an outage roughly every 30 minutes.
        tenantIsDemo: token.tenantIsDemo,
      })
      if (!stored) {
        // The binding moved underneath this refresh. Not an outage and not the operator's problem: the
        // instance is connected, to the organisation they just chose, with that organisation's own
        // token. Recorded rather than notified for exactly that reason — "Xero connection needs
        // attention" would be a false alarm, and a guard that cries wolf gets switched off.
        await logStaleRefreshDiscarded(token)
        return null
      }

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

  const blockedReason = storedXeroConnectionRefusal(storedSummary(token), readXeroTenantAllowList())
  if (blockedReason !== null) {
    return {
      connected: false,
      hasStoredToken: true,
      tenantName: token.tenantName ?? undefined,
      blockedReason,
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
