import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-9tbz, end to end through the real OAuth callback path: exchangeCodeForTokens() and
 * getAccessToken() with Xero, the database and the settings store doubled.
 *
 * The doubles are deliberately stateful rather than canned, because the states this bug lives between
 * are database states: NO token row and NO pin (a fresh e2e rig, the state the o3d-t74p incident
 * happened in), a token row without a pin, and a pinned instance. A double that could only answer one
 * fixed shape could not express the difference — which is the failure mode that let the original
 * `connections[0]` line stand.
 */

type TokenRow = {
  id: string
  connector: string
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  tenantId: string
  tenantName: string | null
  grantedScopes: string | null
}

const LIVE = { id: 'c-live', tenantId: 'e7fb4378-live-org', tenantName: 'OneTwo3D Ltd', tenantType: 'ORGANISATION' }
const DEMO = { id: 'c-demo', tenantId: '5c949ed5-demo-org', tenantName: 'Demo Company (UK)', tenantType: 'ORGANISATION' }

let tokenRow: TokenRow | null = null
let settings: Record<string, string | null> = {}
let connectionsBody: unknown = []
let organisationCalls = 0
let notifications: Array<{ title: string; message: string }> = []
let activity: Array<{ action: string; description: string }> = []

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        findUnique: async () => tokenRow,
        upsert: async ({ create }: { create: Omit<TokenRow, 'id'> }) => {
          tokenRow = { id: 'row-1', ...create }
          return tokenRow
        },
        deleteMany: async () => ({ count: 0 }),
      },
      setting: {
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
          settings[where.key] = create.value
          return { key: where.key, value: create.value }
        },
        deleteMany: async () => ({ count: 0 }),
      },
      $transaction: async () => [],
    },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => settings[key] ?? null,
    serializeSettingValue: (_key: string, value: string) => value,
  },
})
mock.module('@/lib/secrets', {
  namedExports: {
    decryptSecret: (v: string) => v,
    encryptSecret: (v: string) => v,
    hasEncryptionKey: () => false,
    isEncryptedValue: () => true,
  },
})
mock.module('@/lib/base-currency', {
  namedExports: { getBaseCurrencyCode: async () => 'GBP' },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: { action: string; description: string }) => {
      activity.push({ action: params.action, description: params.description })
    },
  },
})
mock.module('@/lib/notifications', {
  namedExports: {
    notify: async (params: { title: string; message: string }) => {
      notifications.push({ title: params.title, message: params.message })
    },
  },
})
mock.module('@/lib/auth/token-store', {
  namedExports: { setAuthToken: async () => {}, consumeAuthToken: async () => null },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: { clearXeroReferenceCache: () => {} },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      if (url.includes('identity.xero.com/connect/token')) {
        return jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 1800,
          token_type: 'Bearer',
          scope: 'accounting.transactions accounting.contacts',
        })
      }
      if (url.includes('api.xero.com/connections')) return jsonResponse(connectionsBody)
      if (url.includes('Organisation')) {
        organisationCalls += 1
        return jsonResponse({ Organisations: [{ BaseCurrency: 'GBP' }] })
      }
      throw new Error(`unexpected connectorFetch: ${url}`)
    },
  },
})

async function loadAuth() {
  return await import('@/lib/connectors/xero/auth')
}

beforeEach(() => {
  tokenRow = null
  settings = { xero_client_id: 'client-id', xero_client_secret: 'client-secret' }
  connectionsBody = []
  organisationCalls = 0
  notifications = []
  activity = []
  delete process.env.XERO_ALLOWED_TENANT_IDS
  delete process.env.XERO_ALLOWED_TENANT_NAMES
  delete process.env.XERO_BLOCKED_TENANT_IDS
  // XERO_TENANT_ID is READ as of o3d-9tbz. It has to be cleared here like the others, or a value left
  // in the developer's own environment silently narrows the allow-list for every test in this file.
  delete process.env.XERO_TENANT_ID
})

/** A fresh database: no token row, no pin. The exact state the e2e rig connected in. */
function freshDatabase() {
  tokenRow = null
  delete settings.xero_expected_tenant_id
}

/** An instance already bound to an organisation: token row AND pin, as a real connection leaves it. */
function pinnedTo(conn: typeof DEMO) {
  settings.xero_expected_tenant_id = conn.tenantId
  tokenRow = {
    id: 'row-1',
    connector: 'xero',
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    tenantId: conn.tenantId,
    tenantName: conn.tenantName,
    grantedScopes: 'accounting.transactions',
  }
}


test('FRESH DATABASE + several organisations: refused, and NOTHING is stored', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null, 'no token row was written')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'no tenant was pinned')
  assert.equal(organisationCalls, 0, 'not even a read was made against the organisation')
  assert.match(result.error ?? '', /OneTwo3D Ltd/)
  assert.match(result.error ?? '', /Demo Company \(UK\)/)
  assert.match(result.error ?? '', /XERO_ALLOWED_TENANT_IDS/)
  assert.ok(activity.some((entry) => entry.action === 'xero_connect_refused'), 'the refusal is recorded')
})

test('FRESH DATABASE + a single organisation: ordinary first-time setup still connects', async () => {
  // This case outranks the bug. If it breaks, the fix is worse than what it fixes.
  freshDatabase()
  connectionsBody = [DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(result.tenantName, 'Demo Company (UK)')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(tokenRow?.accessToken, 'access-1')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId, 'and the connection pins itself')
})

test('the allow-list chooses among several organisations on a fresh database', async () => {
  // The only control that survives a database reset. LIVE is first in the list — the old code took it.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the allowed org, not connections[0]')
})

test('an organisation outside the allow-list is refused even when it is the ONLY one offered', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
  assert.match(result.error ?? '', /Demo Company \(UK\)/)
})

test('a pinned instance reconnects to its pinned organisation, not the first one offered', async () => {
  pinnedTo(DEMO)
  connectionsBody = [LIVE, DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})

test('a REVOKED authorisation (200 with an empty array) is reported as a revocation', async () => {
  freshDatabase()
  connectionsBody = []
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /REVOKED/)
  assert.equal(tokenRow, null)
})

test('a connections body that is not an array is refused, not crashed on', async () => {
  freshDatabase()
  connectionsBody = { Message: 'AuthenticationUnsuccessful' }
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /REVOKED/, 'and diagnosed like an empty list, not as a crash')
})


// --- the stored token, which is what every sync actually uses ----------------

test('a STORED token outside the allow-list stops the sync and says why', async () => {
  // The restored-dump case, and the shape the incident really took: the callback ran once, days of
  // syncs followed, and none of them went anywhere near the callback.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.equal(notifications.length, 1, 'the operator is told once')
  assert.match(notifications[0].message, /OneTwo3D Ltd/)
  assert.match(notifications[0].message, new RegExp(DEMO.tenantId))
  assert.ok(activity.some((entry) => entry.action === 'xero_stored_tenant_refused'))

  await getAccessToken()
  assert.equal(notifications.length, 1, 'and not once per sync tick')
})

test('a stored token ON the allow-list is handed out untouched', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, DEMO.tenantId)
  assert.equal(auth?.accessToken, 'stored-access')
  assert.equal(notifications.length, 0)
})

test('with no allow-list configured the stored token is handed out exactly as before', async () => {
  pinnedTo(LIVE)
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, LIVE.tenantId)
  assert.equal(notifications.length, 0)
})

test('the block reason travels with the failure, so "Not connected" is not the only clue', async () => {
  // Every Xero call reports a missing token as "Not connected to Xero". For an allow-list block that
  // sends the operator hunting for a lost token instead of reading the message that explains it.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getStoredTenantBlockReason } = await loadAuth()

  const reason = await getStoredTenantBlockReason()
  assert.match(reason ?? '', /OneTwo3D Ltd/)
  assert.match(reason ?? '', /allow-list forbids/)
})

test('no block reason when the stored token is allowed, or when there is no token at all', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getStoredTenantBlockReason } = await loadAuth()
  assert.equal(await getStoredTenantBlockReason(), null)

  freshDatabase()
  assert.equal(await getStoredTenantBlockReason(), null, 'a disconnected instance is not "blocked"')
})


// --- XERO_TENANT_ID, end to end ------------------------------------------------
//
// The documented control that nothing read. An operator who set it to their live org and connected an
// e2e rig got precisely the incident it looks like it prevents. These run it through the real callback
// and the real token path, because that is where the belief was false.

test('XERO_TENANT_ID ALONE stops the incident at the callback: nothing stored, nothing read', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  // LIVE is connections[0] and there is no pin — the exact state of the e2e rig in o3d-t74p.
  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the org XERO_TENANT_ID names, not the first offered')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('XERO_TENANT_ID ALONE refuses a consent that offers only the forbidden org', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null, 'no token row was written')
  assert.equal(organisationCalls, 0, 'not even a read against the live organisation')
  assert.match(result.error ?? '', /OneTwo3D Ltd/)
  assert.match(result.error ?? '', /replace the XERO_TENANT_ID line/, 'a remedy that does not create a conflict')
})

test('XERO_TENANT_ID ALONE halts a STORED token from a restored dump', async () => {
  // The days-of-syncs half of the incident, and the only half a callback check cannot reach.
  pinnedTo(LIVE)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely protected, not merely warned')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /XERO_TENANT_ID/)
})

test('a blank XERO_TENANT_ID — as .env.example and install.sh ship it — changes nothing', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_TENANT_ID = ''
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')
  assert.equal(result.success, true, 'first-time setup on a stock .env is untouched')
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})


// --- the two keys disagreeing, end to end ---------------------------------------

test('a contradictory configuration refuses the callback even for a single-org consent', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /contradict each other/)
  assert.ok(
    activity.some((entry) => entry.action === 'xero_connect_refused'),
    'and the refusal is on the record, not just on the operator’s screen',
  )
})

test('a contradictory configuration also halts an ALREADY-CONNECTED instance', async () => {
  // Config drift on a running box: the contradiction arrives by .env edit, with no callback in sight.
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.match(notifications[0].message, /contradict each other/)
  assert.match(notifications[0].message, /delete that line/)
})

test('the same organisation spelled in both keys is NOT a conflict', async () => {
  // A migration off the deprecated name, done belt-and-braces, must not be an outage.
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { getAccessToken } = await loadAuth()

  const auth = await getAccessToken()
  assert.equal(auth?.tenantId, DEMO.tenantId)
  assert.equal(notifications.length, 0)
})


// --- isConnected: a blocked token is not a connection -----------------------------

test('an allow-list-blocked token reports NOT connected, with the reason', async () => {
  // It used to report a healthy green connection on /sync while every sync failed — the one screen an
  // operator checks to find out whether Xero works told them it did.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.match(status.blockedReason ?? '', /allow-list forbids/)
  assert.match(status.blockedReason ?? '', /OneTwo3D Ltd/)
})

test('a blocked token still reports hasStoredToken, so Disconnect stays on screen', async () => {
  // The refusal says "disconnect Xero on /sync". /sync only offers that button when something is
  // stored, so dropping this flag would make the remedy name a control that is not there.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.hasStoredToken, true)
  assert.match(status.blockedReason ?? '', /disconnect Xero on \/sync/i)
})

test('isConnected does NOT notify — it runs on every render of /sync', async () => {
  // Minting an activity row and a notification per page view would bury the one that matters.
  pinnedTo(LIVE)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  await isConnected()
  await isConnected()
  assert.equal(notifications.length, 0)
  assert.equal(activity.length, 0)
})

test('an allowed token reports connected, and a fresh database reports neither', async () => {
  pinnedTo(DEMO)
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  const { isConnected } = await loadAuth()

  const connectedStatus = await isConnected()
  assert.equal(connectedStatus.connected, true)
  assert.equal(connectedStatus.tenantName, 'Demo Company (UK)')
  assert.equal(connectedStatus.blockedReason, undefined)

  freshDatabase()
  const freshStatus = await isConnected()
  assert.equal(freshStatus.connected, false)
  assert.equal(freshStatus.hasStoredToken, undefined, 'never connected is not the same as blocked')
  assert.equal(freshStatus.blockedReason, undefined)
})

test('a contradictory configuration is reported by isConnected too, not just by the sync', async () => {
  pinnedTo(DEMO)
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_IDS = LIVE.tenantId
  const { isConnected } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true)
  assert.match(status.blockedReason ?? '', /contradict each other/)
})


// --- XERO_BLOCKED_TENANT_IDS, end to end ---------------------------------------
//
// The rig's answer to the rotating Demo tenantId (r2 finding 1). Xero re-issues the Demo company's
// tenantId at every ~28-day reset, so an id ALLOW-list has to be re-edited every cycle; the LIVE
// organisation's id is the stable one, and blocking it is identity-strength rather than name-strength.

test('BLOCKING the live org stops the incident at the callback and connects to Demo instead', async () => {
  // The incident's own state: fresh database, no pin, LIVE first in the consent.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId, 'the org that is not blocked, not connections[0]')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})

test('the deny-list needs no edit when the Demo company comes back with a NEW tenantId', async () => {
  // The reason the runbook reached for names in the first place. Same .env line, next cycle.
  freshDatabase()
  const rotated = { ...DEMO, id: 'c-demo-2', tenantId: '5c949ed5-demo-cycle-2' }
  connectionsBody = [LIVE, rotated]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, rotated.tenantId)
})

test('a BLOCKED stored token halts every sync — the restored-dump half of the incident', async () => {
  pinnedTo(LIVE)
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely stopped, not merely warned')
  assert.match(notifications[0].message, /XERO_BLOCKED_TENANT_IDS/)
  assert.ok(activity.some((entry) => entry.action === 'xero_stored_tenant_refused'))
})

test('a consent that offers only blocked organisations is refused with nothing stored', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0, 'not even a read against the live organisation')
  assert.match(result.error ?? '', /XERO_BLOCKED_TENANT_IDS/)
})


// --- a name is not an identity, end to end -------------------------------------

test('two organisations sharing a NAME refuse the callback, and nothing is stored', async () => {
  freshDatabase()
  connectionsBody = [DEMO, { ...DEMO, id: 'c-other', tenantId: 'aa000000-other-demo' }]
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
  assert.match(result.error ?? '', /does not identify/)
  assert.ok(activity.some((entry) => entry.action === 'xero_connect_refused'))
})

test('an organisation RENAMED to the allow-listed name does not get past the id list', async () => {
  // Under the old union this connected: the name admitted an organisation the ids excluded.
  freshDatabase()
  connectionsBody = [{ ...LIVE, tenantName: 'Demo Company (UK)' }]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0)
})

test('an id and that same organisation NAME connect — two spellings are not a contradiction', async () => {
  // r2 finding 2. This pair used to be refused as a conflict.
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_TENANT_ID = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
})

test('an id and a name selecting DIFFERENT organisations still refuses, quoting both', async () => {
  freshDatabase()
  connectionsBody = [LIVE, DEMO]
  process.env.XERO_ALLOWED_TENANT_IDS = DEMO.tenantId
  process.env.XERO_ALLOWED_TENANT_NAMES = 'OneTwo3D Ltd'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/api/accounting/callback')

  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /contradict each other/)
  assert.match(result.error ?? '', /no organisation satisfies both/)
})

test('a NAME-ONLY guard is recorded as weaker than it looks — once, not once per sync', async () => {
  // Not a refusal: refusing would switch off the only tenant control the rig has today. But an operator
  // who believes a name pins the ledger is in the position this whole branch exists to end.
  const soleDemo = { ...DEMO, id: 'c-warn', tenantId: '5c949ed5-demo-warn' }
  pinnedTo(soleDemo)
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, soleDemo.tenantId, 'still permitted')
  const warnings = activity.filter((entry) => entry.action === 'xero_tenant_guard_name_only')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].description, /XERO_BLOCKED_TENANT_IDS=/)

  await getAccessToken()
  await getAccessToken()
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 1, 'not per tick')
})

test('adding an id-based control clears the name-only warning', async () => {
  const soleDemo = { ...DEMO, id: 'c-warn2', tenantId: '5c949ed5-demo-warn2' }
  pinnedTo(soleDemo)
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, soleDemo.tenantId)
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 0)
})
