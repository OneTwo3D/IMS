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
 *
 * THE DATABASE DOUBLE HAS A PRIMARY KEY AND TRANSACTIONS (o3d-9tbz r3), for the same reason. The race
 * being fixed is two OAuth callbacks that both read "no pin" and both write; the fix is that
 * `settings.key` is a PRIMARY KEY, so only one INSERT survives. A double whose `setting.upsert` always
 * succeeds cannot tell the fix from the bug — both pass — so this one models what actually decides it:
 *
 *   - `setting.create` raises P2002 when the key already exists, INCLUDING when it was committed by
 *     another transaction after this one started reading. That is the unique index, and it is the only
 *     thing standing between the two callbacks.
 *   - `$transaction(fn)` stages every write and applies it only if the callback returns. A rollback
 *     therefore leaves nothing behind, which is what lets "nothing was stored" be asserted rather than
 *     assumed. The array form is still supported, because `disconnect()` uses it.
 *   - reads inside a transaction see committed data (READ COMMITTED, as Postgres runs by default), so a
 *     callback that starts after the other has committed sees the pin rather than a stale snapshot.
 *
 * `gateSettingReads` is what lets a test put two callbacks in flight AT THE SAME TIME rather than one
 * after the other: it holds every in-transaction pin read until N of them have arrived, so both
 * callbacks have provably read "no pin" before either writes. Without it the second callback simply
 * runs after the first has committed, which is a different (and much easier) case.
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
  tenantIsDemo: boolean | null
}

const LIVE = { id: 'c-live', tenantId: 'e7fb4378-live-org', tenantName: 'OneTwo3D Ltd', tenantType: 'ORGANISATION' }
const DEMO = { id: 'c-demo', tenantId: '5c949ed5-demo-org', tenantName: 'Demo Company (UK)', tenantType: 'ORGANISATION' }

let tokenRow: TokenRow | null = null
let settings: Record<string, string | null> = {}
let connectionsBody: unknown = []
/**
 * Per-consent organisation lists and access tokens, keyed by the OAuth `code`.
 *
 * Two callbacks in flight at once are two DIFFERENT consents, each with its own code, its own token and
 * its own organisation list. A single shared `connectionsBody` cannot express that — whichever callback
 * reaches the fetch last decides what BOTH of them saw — and a race test built on it is testing one
 * consent twice. The double therefore threads the code through: the token endpoint mints an access
 * token for it, and /connections answers according to the bearer it is presented with.
 */
let connectionsByCode: Record<string, unknown> = {}
let accessTokenByCode: Record<string, string> = {}
let organisationBody: unknown = { Organisations: [{ BaseCurrency: 'GBP' }] }
let organisationCalls = 0
let notifications: Array<{ title: string; message: string }> = []
let activity: Array<{ action: string; description: string }> = []

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

/**
 * A barrier that holds the first N in-transaction pin reads until all N have arrived.
 *
 * This is the whole point of the race tests: it is what makes both callbacks read "no pin" BEFORE either
 * of them writes one. Left unset it does nothing, so every other test in this file is untouched.
 */
let settingReadGate: ((key: string) => Promise<void>) | null = null
let organisationFetchGate: (() => Promise<void>) | null = null

/** Hold every arrival until `count` of them have arrived, then let them all go. */
function barrier(count: number): () => Promise<void> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let seen = 0
  return async () => {
    seen += 1
    if (seen >= count) { release(); return }
    await released
  }
}

/**
 * Hold the in-transaction PIN READ, so both callbacks provably read "no pin" before either writes one.
 *
 * This is the interleaving Postgres resolves with the primary key: two INSERTs of the same key, the
 * second blocked until the first commits and then rejected.
 */
function gateSettingReads(count: number): void {
  const wait = barrier(count)
  settingReadGate = async (key: string) => {
    if (key !== 'xero_expected_tenant_id') return
    await wait()
  }
}

/**
 * Hold the GET /Organisation call, so both callbacks have chosen their organisation — against a pin
 * they both read as absent — before either reaches the write. The second one's transaction then finds
 * the first's committed pin, which is the same race arriving by the other route.
 */
function gateOrganisationFetch(count: number): void {
  const wait = barrier(count)
  organisationFetchGate = async () => { await wait() }
}

function uniqueViolation(key: string) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`key\`)`), {
    code: 'P2002',
    meta: { target: ['key'], modelName: 'Setting' },
  })
}

type SettingRow = { key: string; value: string }

/**
 * In-flight INSERTs of a settings key, and how they ended.
 *
 * A unique index does not merely reject a key that is already COMMITTED — a second INSERT of a key an
 * uncommitted transaction is holding BLOCKS until that transaction ends, and is then rejected if it
 * committed. Without this the double lets both racing callbacks insert, both commit, and the test
 * passes against the bug as happily as against the fix.
 */
const pendingSettingInserts = new Map<string, Promise<boolean>>()

/** One interactive transaction: staged writes, committed together, discarded on throw. */
async function runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const staged: Record<string, string> = {}
  let stagedToken: TokenRow | null | undefined
  let settle: (committed: boolean) => void = () => {}
  const settled = new Promise<boolean>((resolve) => { settle = resolve })
  const claimed: string[] = []
  const tx = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }): Promise<SettingRow | null> => {
        if (settingReadGate) await settingReadGate(where.key)
        // READ COMMITTED: a row another transaction has already committed IS visible here.
        const value = staged[where.key] ?? settings[where.key]
        return value == null ? null : { key: where.key, value }
      },
      create: async ({ data }: { data: SettingRow }) => {
        // The primary key. This is the statement the whole fix rests on: the loser of the race is
        // rejected here, by the database, not by anything the process checked earlier.
        if (staged[data.key] != null || settings[data.key] != null) throw uniqueViolation(data.key)
        const inFlight = pendingSettingInserts.get(data.key)
        if (inFlight && (await inFlight)) throw uniqueViolation(data.key)
        if (settings[data.key] != null) throw uniqueViolation(data.key)
        staged[data.key] = data.value
        claimed.push(data.key)
        pendingSettingInserts.set(data.key, settled)
        return data
      },
      update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
        staged[where.key] = data.value
        return { key: where.key, value: data.value }
      },
    },
    accountingToken: {
      upsert: async ({ create }: { create: Omit<TokenRow, 'id'> }) => {
        stagedToken = { id: 'row-1', ...create }
        return stagedToken
      },
    },
  }
  try {
    const result = await fn(tx)
    for (const [key, value] of Object.entries(staged)) settings[key] = value
    if (stagedToken !== undefined) tokenRow = stagedToken
    settle(true)
    return result
  } catch (error) {
    settle(false)
    throw error
  } finally {
    for (const key of claimed) {
      if (pendingSettingInserts.get(key) === settled) pendingSettingInserts.delete(key)
    }
  }
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
        findUnique: async ({ where }: { where: { key: string } }): Promise<SettingRow | null> => {
          const value = settings[where.key]
          return value == null ? null : { key: where.key, value }
        },
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
          settings[where.key] = create.value
          return { key: where.key, value: create.value }
        },
        deleteMany: async () => ({ count: 0 }),
      },
      // Both forms: disconnect() passes an array, the tenant binding passes a callback.
      $transaction: async (arg: unknown) =>
        typeof arg === 'function'
          ? runTransaction(arg as (tx: unknown) => Promise<unknown>)
          : Promise.all(arg as Array<Promise<unknown>>),
    },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => settings[key] ?? null,
    serializeSettingValue: (_key: string, value: string) => value,
    deserializeSettingValue: (_key: string, value: string) => value,
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
    connectorFetch: async (url: string, init?: { headers?: Record<string, string>; body?: URLSearchParams }) => {
      if (url.includes('identity.xero.com/connect/token')) {
        const code = init?.body?.get('code') ?? ''
        return jsonResponse({
          access_token: accessTokenByCode[code] ?? 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 1800,
          token_type: 'Bearer',
          scope: 'accounting.transactions accounting.contacts',
        })
      }
      if (url.includes('api.xero.com/connections')) {
        const bearer = (init?.headers?.Authorization ?? '').replace('Bearer ', '')
        const code = Object.keys(accessTokenByCode).find((key) => accessTokenByCode[key] === bearer)
        return jsonResponse(code != null ? connectionsByCode[code] : connectionsBody)
      }
      if (url.includes('Organisation')) {
        organisationCalls += 1
        if (organisationFetchGate) await organisationFetchGate()
        return jsonResponse(organisationBody)
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
  connectionsByCode = {}
  accessTokenByCode = {}
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP' }] }
  organisationCalls = 0
  settingReadGate = null
  organisationFetchGate = null
  pendingSettingInserts.clear()
  notifications = []
  activity = []
  delete process.env.XERO_REQUIRE_DEMO_ORG
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

/** Two independent consents in flight at once, each offering its own organisation. */
function twoConsents(a: { code: string; org: typeof DEMO }, b: { code: string; org: typeof DEMO }) {
  connectionsByCode = { [a.code]: [a.org], [b.code]: [b.org] }
  accessTokenByCode = { [a.code]: `access-${a.code}`, [b.code]: `access-${b.code}` }
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
    tenantIsDemo: null,
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


// --- two callbacks racing for the binding (r3 finding 1) -------------------------
//
// Every check in tenant-guard.ts is computed from a snapshot: the pin is read, the choice is made, and
// the write happens later. Two callbacks in flight at once — a double-clicked Connect, two operators,
// a replayed redirect — both read "no pin" on a fresh database, both pass, and the second write lands on
// top of the first. The pin is the only thing that makes a later consent to a different organisation
// refuse, so a race that rewrites it does not trip the guard, it deletes it. What decides the winner is
// the PRIMARY KEY on settings.key, which is why the double models one.

test('TWO CALLBACKS AT ONCE on a fresh database: exactly one binds, the other stores nothing', async () => {
  // The rig's operator can reach both organisations, and consents to one in each of two browser tabs.
  freshDatabase()
  twoConsents({ code: 'code-demo', org: DEMO }, { code: 'code-live', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const [first, second] = await Promise.all([
    exchangeCodeForTokens('code-demo', 'https://ims.example/api/accounting/callback'),
    exchangeCodeForTokens('code-live', 'https://ims.example/api/accounting/callback'),
  ])

  const succeeded = [first, second].filter((r) => r.success)
  const refused = [first, second].filter((r) => !r.success)
  assert.equal(succeeded.length, 1, 'exactly one callback established the binding')
  assert.equal(refused.length, 1, 'and the other was refused rather than overwriting it')

  // The binding is one thing, not two that can disagree: the pin and the token name one organisation.
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId)
  assert.equal(tokenRow?.tenantName, succeeded[0].tenantName)
  assert.equal(
    tokenRow?.accessToken,
    tokenRow?.tenantId === DEMO.tenantId ? 'access-code-demo' : 'access-code-live',
    'and the stored token is the WINNER’s, not the other consent’s',
  )
})

test('the loser of the race is told which organisation won, and how to take it over', async () => {
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  const refusal = results.find((r) => !r.success)
  const winner = results.find((r) => r.success)
  assert.ok(refusal && winner)
  assert.match(refusal.error ?? '', /another Xero connection finished first/i)
  assert.match(refusal.error ?? '', new RegExp(settings.xero_expected_tenant_id ?? 'never'), 'names the winner')
  assert.match(refusal.error ?? '', /nothing from it was stored/i)
  assert.match(refusal.error ?? '', /disconnect Xero on \/sync/i, 'a remedy, not just a complaint')
  assert.ok(
    activity.some((entry) => entry.action === 'xero_connect_refused'),
    'and the losing callback is on the record, not only on that operator’s screen',
  )
})

test('the loser writes NO token — a rolled-back binding leaves nothing behind', async () => {
  // The refusal says "nothing from it was stored". Pinning inside the transaction but writing the token
  // outside it would leave that sentence false AND leave the LOSER's token in the database under the
  // WINNER's pin — a stored credential for one organisation labelled as another. So this asserts on the
  // access token, which is the only thing that tells the two consents apart.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  const winner = results.find((r) => r.success)
  assert.ok(winner, 'one consent bound')
  assert.ok(results.find((r) => !r.success), 'and the other was rolled back')

  const winnerCode = winner.tenantName === DEMO.tenantName ? 'c1' : 'c2'
  const loserCode = winnerCode === 'c1' ? 'c2' : 'c1'
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId, 'one binding, not two halves')
  assert.equal(tokenRow?.accessToken, `access-${winnerCode}`)
  assert.notEqual(
    tokenRow?.accessToken, `access-${loserCode}`,
    'the refused consent’s credential never reached the database',
  )
})

test('a callback that CHOSE before another finished is refused by the committed pin', async () => {
  // The same race arriving the other way round: both read "no pin" at the top, but the second one's
  // transaction opens after the first has committed, so it meets the pin rather than the unique index.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: LIVE })
  gateOrganisationFetch(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  assert.equal(results.filter((r) => r.success).length, 1)
  const refusal = results.find((r) => !r.success)
  assert.match(refusal?.error ?? '', /another Xero connection finished first/i)
  assert.equal(settings.xero_expected_tenant_id, tokenRow?.tenantId)
})

test('two callbacks for the SAME organisation both succeed — a double-click is not an error', async () => {
  // The common case by far, and the one a "refuse anything concurrent" fix would break: an operator who
  // double-clicks Connect ends up bound to exactly the organisation they asked for, so putting a
  // refusal on their screen would be crying wolf on the ordinary path.
  freshDatabase()
  twoConsents({ code: 'c1', org: DEMO }, { code: 'c2', org: DEMO })
  gateSettingReads(2)
  const { exchangeCodeForTokens } = await loadAuth()

  const results = await Promise.all([
    exchangeCodeForTokens('c1', 'https://ims.example/cb'),
    exchangeCodeForTokens('c2', 'https://ims.example/cb'),
  ])

  assert.deepEqual(results.map((r) => r.success), [true, true])
  assert.deepEqual(results.map((r) => r.tenantName), ['Demo Company (UK)', 'Demo Company (UK)'])
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(
    activity.filter((e) => e.action === 'xero_connect_refused').length, 0,
    'and nothing was recorded as a refusal — a discarded duplicate is not an incident',
  )
})

test('an ordinary sequential re-consent to the SAME organisation still works', async () => {
  // The Demo-reset path and every routine re-authorisation. The binding must be re-establishable, or
  // the fix locks the rig out of the organisation it is protecting.
  pinnedTo(DEMO)
  connectionsBody = [DEMO]
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('code-1', 'https://ims.example/cb')
  assert.equal(result.success, true)
  assert.equal(tokenRow?.accessToken, 'access-1', 'the fresh token replaced the stored one')
  assert.equal(settings.xero_expected_tenant_id, DEMO.tenantId)
})


// --- XERO_REQUIRE_DEMO_ORG (r3 finding 2) ----------------------------------------
//
// Blocking the live org's id fences out ONE organisation. It never constrained the rig TO a demo
// organisation: a third org an operator also administers is neither blocked nor allow-listed, and a
// name cannot close that because a name is not an identity. Xero's own IsDemoCompany can.

function organisation(fields: Record<string, unknown>) {
  organisationBody = { Organisations: [{ BaseCurrency: 'GBP', ...fields }] }
}

test('a THIRD organisation passes a deny-list and is stopped by XERO_REQUIRE_DEMO_ORG', async () => {
  // The finding, exactly: XERO_BLOCKED_TENANT_IDS=<live> does not stop this consent.
  const THIRD = { id: 'c-third', tenantId: '9aa10000-third-org', tenantName: 'Bookkeeper Sandbox', tenantType: 'ORGANISATION' }
  freshDatabase()
  connectionsBody = [THIRD]
  process.env.XERO_BLOCKED_TENANT_IDS = LIVE.tenantId
  organisation({ IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()

  const withoutTheKey = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(withoutTheKey.success, true, 'the deny-list alone lets a third organisation through')

  freshDatabase()
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const withTheKey = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(withTheKey.success, false)
  assert.equal(tokenRow, null, 'nothing stored')
  assert.equal(settings.xero_expected_tenant_id, undefined, 'and nothing pinned')
  assert.match(withTheKey.error ?? '', /Bookkeeper Sandbox/)
  assert.match(withTheKey.error ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.match(withTheKey.error ?? '', /IsDemoCompany=false/)
  assert.ok(activity.some((e) => e.action === 'xero_connect_refused'))
})

test('a Demo organisation connects under the key, and its demo status is RECORDED', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ IsDemoCompany: true })
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, true)
  assert.equal(tokenRow?.tenantId, DEMO.tenantId)
  assert.equal(tokenRow?.tenantIsDemo, true, 'so the STORED token can be checked without another API call')
  assert.equal(organisationCalls, 1, 'and it cost no call the callback was not already making')
})

test('the demo status is recorded even when the key is OFF, so switching it on needs no reconnect', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  organisation({ IsDemoCompany: true })
  const { exchangeCodeForTokens } = await loadAuth()

  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)
  assert.equal(tokenRow?.tenantIsDemo, true)
})

test('Class: DEMO is accepted when IsDemoCompany is absent, and an unknown Class is not', async () => {
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ Class: 'DEMO' })
  const { exchangeCodeForTokens } = await loadAuth()
  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)

  freshDatabase()
  organisation({ Class: 'PREMIUM' })
  const unknown = await exchangeCodeForTokens('c2', 'https://ims.example/cb')
  assert.equal(unknown.success, false, 'an unrecognised Class is not evidence of a demo organisation')
  assert.match(unknown.error ?? '', /could not read whether/i)
})

test('an organisation whose demo status Xero did not report is refused as UNVERIFIED, not as live', async () => {
  // Different remedy: nothing is wrong with the operator's choice, so "go and pick the Demo company"
  // would send them round the same loop.
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({})
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.match(result.error ?? '', /could not read whether/i)
  assert.match(result.error ?? '', /Try connecting again/i)
  assert.match(result.error ?? '', /delete the XERO_REQUIRE_DEMO_ORG line/)
  assert.ok(activity.some((e) => e.action === 'xero_connect_refused'))
})

test('the demo requirement is answered BEFORE the base-currency comparison', async () => {
  // A live organisation whose base currency also differs must hear about the ledger it was about to
  // invoice into, not about currencies.
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  organisation({ BaseCurrency: 'USD', IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.doesNotMatch(result.error ?? '', /base currency/i)
})

test('a STORED live token is halted by the key alone — the restored-dump half', async () => {
  // No callback runs when a production database is restored onto the rig. Only a read-time check sees
  // it, and this is the case the deny-list can only cover for organisations somebody remembered to list.
  const stray = { ...LIVE, tenantId: 'e7fb4378-live-restored', tenantName: 'Third Party Books' }
  pinnedTo(stray)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null, 'genuinely stopped, not merely warned')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /never verified with Xero/i)
  assert.match(notifications[0].message, /Third Party Books/)
  assert.match(notifications[0].message, /Disconnect Xero on \/sync/i)
  assert.ok(activity.some((e) => e.action === 'xero_stored_tenant_refused'))
})

test('a stored token RECORDED as a demo organisation keeps working', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-stored-ok' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal(notifications.length, 0)
})

test('a stored token Xero said is NOT a demo organisation is refused with its own wording', async () => {
  const live = { ...LIVE, tenantId: 'e7fb4378-live-known' }
  pinnedTo(live)
  tokenRow!.tenantIsDemo = false
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal(await getAccessToken(), null)
  assert.match(notifications[0].message, /Xero reports is NOT a demo organisation/i)
})

test('a demo-blocked token reports NOT connected on /sync, with the reason and a Disconnect button', async () => {
  const stray = { ...LIVE, tenantId: 'e7fb4378-live-isconnected' }
  pinnedTo(stray)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { isConnected, getStoredTenantBlockReason } = await loadAuth()

  const status = await isConnected()
  assert.equal(status.connected, false)
  assert.equal(status.hasStoredToken, true, 'so the remedy it names is on screen')
  assert.match(status.blockedReason ?? '', /XERO_REQUIRE_DEMO_ORG/)
  assert.match(await getStoredTenantBlockReason() ?? '', /XERO_REQUIRE_DEMO_ORG/)
})

test('a token refresh does not forget that the organisation was verified', async () => {
  // A refresh talks to the identity endpoint only. Clearing the flag there would turn a verified
  // connection into an unverified one at every expiry — an outage roughly every half hour.
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-refresh' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  tokenRow!.expiresAt = new Date(Date.now() - 1000)
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.accessToken, 'access-1', 'it refreshed')
  assert.equal(tokenRow?.tenantIsDemo, true)
  assert.equal((await getAccessToken())?.tenantId, demo.tenantId, 'and the next read is still permitted')
})

test('a malformed XERO_REQUIRE_DEMO_ORG refuses everything instead of silently meaning "off"', async () => {
  // The XERO_TENANT_ID mistake in a new place: a line in the .env that reads like a guard, and no guard.
  freshDatabase()
  connectionsBody = [DEMO]
  process.env.XERO_REQUIRE_DEMO_ORG = 'Demo Company (UK)'
  const { exchangeCodeForTokens } = await loadAuth()

  const result = await exchangeCodeForTokens('c1', 'https://ims.example/cb')
  assert.equal(result.success, false)
  assert.equal(tokenRow, null)
  assert.equal(organisationCalls, 0, 'refused before any Xero organisation was read')
  assert.match(result.error ?? '', /is not a yes\/no value/)
  assert.match(result.error ?? '', /XERO_REQUIRE_DEMO_ORG=true/)
})

test('XERO_REQUIRE_DEMO_ORG=false, and a blank value, change nothing', async () => {
  freshDatabase()
  connectionsBody = [LIVE]
  process.env.XERO_REQUIRE_DEMO_ORG = 'false'
  organisation({ IsDemoCompany: false })
  const { exchangeCodeForTokens } = await loadAuth()
  assert.equal((await exchangeCodeForTokens('c1', 'https://ims.example/cb')).success, true)

  freshDatabase()
  process.env.XERO_REQUIRE_DEMO_ORG = ''
  assert.equal((await exchangeCodeForTokens('c2', 'https://ims.example/cb')).success, true)
})

test('XERO_REQUIRE_DEMO_ORG is an anchor, so a name alongside it is not a name-ONLY guard', async () => {
  const demo = { ...DEMO, tenantId: '5c949ed5-demo-anchored' }
  pinnedTo(demo)
  tokenRow!.tenantIsDemo = true
  process.env.XERO_ALLOWED_TENANT_NAMES = 'Demo Company (UK)'
  process.env.XERO_REQUIRE_DEMO_ORG = 'true'
  const { getAccessToken } = await loadAuth()

  assert.equal((await getAccessToken())?.tenantId, demo.tenantId)
  assert.equal(activity.filter((e) => e.action === 'xero_tenant_guard_name_only').length, 0)
})
