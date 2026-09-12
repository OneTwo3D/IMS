/**
 * A WHITESPACE-ONLY TOKEN IS NOT A CREDENTIAL, AND MUST NOT READ AS "CONFIGURED"
 * (o3d-pow3 / o3d-remove-shiphero round 12, Codex HIGH 3).
 *
 * THE DEFECT. Round 8 moved the `configured` flag on the /sync WMS panel and the onboarding wizard
 * off the connector's own hooks and onto `WmsConnector.isConfigured()`; round 10 made that path
 * authoritative by routing it through `isWmsConnectorConfigured`. The predicate it replaced,
 * `mintsoftHasAuthMaterial`, TRIMMED every token it looked at. `isMintsoftConfigured` did not: it
 * read the cached key with a bare `getSettingValue(MINTSOFT_AUTH_TOKEN_KEY)` and tested it for
 * truthiness. A `mintsoft_api_key` row holding spaces — or a `MINTSOFT_API_KEY` environment
 * variable holding spaces, which never passes through the validated settings action at all — was
 * therefore reported as a set-up connection.
 *
 * WHY THAT MATTERS RATHER THAN BEING COSMETIC. "Configured" is what ticks the onboarding step and
 * paints the /sync badge, and both are what an operator reads to decide there is nothing to fix.
 * Meanwhile every request built from that token fails. The two screens that say the connection is
 * fine are the two screens that could repair it.
 *
 * WHAT IS REAL HERE. Both server actions, `isWmsConnectorConfigured`, the shipped registry, the
 * real `MintsoftConnector` and the real `isMintsoftConfigured`. Only the process boundaries a unit
 * test cannot have are stubbed: the session, Prisma, and the settings rows.
 *
 * AND IT IS PROVED NON-VACUOUS. The last case swaps the same row for a REAL token under the same
 * stubs and watches the answer flip to `true`. Without it every assertion here would also pass on a
 * fixture that reported "not configured" for some unrelated reason — a missing base URL, say — and
 * the trim would be untested.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * NOTHING UNDER TEST IS IMPORTED STATICALLY, for the reason
 * tests/wms-configured-predicate-containment.test.ts states: a static import of the registry would
 * bind the REAL Prisma client before the mocks below run, and `isConfigured()` would then answer
 * `false` because of a connection error rather than because of the token — every case green, the
 * defect invisible.
 */

/** The row an operator (or a deployment) leaves behind: present, and carrying nothing usable. */
const WHITESPACE_TOKEN = '   '
/** What a real cached key looks like, for the contrast at the bottom. */
const REAL_TOKEN = 'live-mintsoft-key'

const MINTSOFT_FORM = { endpoint: 'https://api.mintsoft.co.uk' }
const MINTSOFT_PANEL = { warehouses: [] as string[] }

/** What the stored `WmsConnection` row says. Mutable, for the base-URL case at the bottom. */
let connectionBaseUrl = 'https://api.mintsoft.co.uk'

/** Prisma as a boundary. The connection row is what supplies the base URL the predicate needs. */
const dbStub: unknown = new Proxy({}, {
  get: (_root, model: string) => new Proxy({}, {
    get: (_model, method: string) => async () => {
      if (model === 'wmsConnection' && method === 'findFirst') {
        return { connector: 'mintsoft', baseUrl: connectionBaseUrl, orderLookupConnector: null }
      }
      if (method === 'findMany') return []
      if (method === 'count') return 0
      return null
    },
  }),
})
mock.module('@/lib/db', { namedExports: { db: dbStub, prisma: dbStub } })

/**
 * The settings rows. Mintsoft is the enabled WMS connector, the auth mode is CREDENTIALS (the
 * branch this finding is about), and there is no username or password — so the cached key is the
 * only thing that can make this connection look set up.
 */
const SETTING_ROWS: Record<string, string> = {
  plugin_mintsoft_enabled: 'true',
  mintsoft_auth_mode: 'credentials',
  mintsoft_api_key: WHITESPACE_TOKEN,
}
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => SETTING_ROWS[key] ?? null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, SETTING_ROWS[key] ?? null])),
    setSetting: async () => {},
    serializeSettingValue: (_key: string, value: string) => value,
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireAuth: async () => ({ id: 'u1', role: 'ADMIN' }),
    getCurrentUser: async () => ({ id: 'u1', role: 'ADMIN' }),
  },
})

/** The connector's own screen readers, reached through its REAL registry hooks. */
mock.module('@/app/actions/mintsoft-sync', {
  namedExports: {
    getMintsoftOnboardingConnectionData: async () => MINTSOFT_FORM,
    getMintsoftDashboardData: async () => MINTSOFT_PANEL,
  },
})

test('[round 12 HIGH 3] a whitespace-only cached key is NOT a configured connection', async () => {
  const { isMintsoftConfigured } = await import('../lib/connectors/mintsoft/api/auth.ts')

  // THE WHOLE DEFECT IN ONE LINE: before the fix this was `true`, because the row is non-empty.
  assert.equal(
    await isMintsoftConfigured(), false,
    'a token made of spaces cannot authenticate a single request, so the connection is not set up',
  )
})

test('[round 12 HIGH 3] and the WMS boundary — the AUTHORITATIVE path since round 10 — says the same', async () => {
  const registry = await import('../lib/connectors/wms/registry.ts')
  assert.equal(
    await registry.isWmsConnectorConfigured('mintsoft'), false,
    'the boundary reports what the connector reports; it is containment, not a second opinion',
  )
})

test('[round 12 HIGH 3] the /sync badge and the onboarding step both read it as NOT set up', async () => {
  const wmsSync = await import('../app/actions/wms-sync.ts')
  const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')

  const dashboard = await wmsSync.getWmsSyncDashboardData()
  assert.notEqual(dashboard, null, 'a WMS connector is enabled; null is reserved for "none is"')
  assert.equal(
    dashboard!.configured, false,
    'the Configured badge is what an operator reads to decide there is nothing to fix',
  )
  assert.deepEqual(dashboard!.connectorData.mintsoft, MINTSOFT_PANEL, 'and the panel still renders')

  const onboarding = await wmsOnboarding.getWmsOnboardingConnectionData()
  assert.equal(onboarding.configured, false, 'and the wizard step stays unticked, which is the remedy')
  assert.deepEqual(onboarding.connectorData.mintsoft, MINTSOFT_FORM)
})

test('[round 12 HIGH 3] a REAL cached key is still configured — the cases above are not vacuous', async () => {
  const { isMintsoftConfigured } = await import('../lib/connectors/mintsoft/api/auth.ts')
  const registry = await import('../lib/connectors/wms/registry.ts')

  SETTING_ROWS.mintsoft_api_key = REAL_TOKEN
  try {
    // If this were also `false`, every assertion above would be proving something else — a missing
    // base URL, an unreadable connection row, a predicate that always refuses.
    assert.equal(await isMintsoftConfigured(), true, 'the credentials branch still accepts a real cached key')
    assert.equal(await registry.isWmsConnectorConfigured('mintsoft'), true)
  } finally {
    SETTING_ROWS.mintsoft_api_key = WHITESPACE_TOKEN
  }
})

/**
 * THE OTHER DIVERGENCE RECORDED ON o3d-pow3, DECIDED AND PINNED.
 *
 * Round 8's substitution also NARROWED the base-URL half: the predicate it replaced accepted any
 * non-empty stored base URL, while `getMintsoftApiConfiguration` reports
 * `normalizeMintsoftBaseUrl(stored) ?? ''`, so an UNPARSEABLE value reads as absent. The narrow
 * answer is the correct one and it is kept — that normalised value is the only base URL any
 * Mintsoft request is ever built from, so a value `validateExternalBaseUrl` rejects is a connection
 * that cannot make a single call, and calling it "configured" is the same lie as the whitespace
 * token, with the same consequence: it stops an operator re-entering the endpoint. Undeclared
 * before this round, and nothing pinned either answer.
 */
test('[round 12 HIGH 3] an unparseable stored base URL is NOT configured either, and deliberately so', async () => {
  const { isMintsoftConfigured, normalizeMintsoftBaseUrl } = await import('../lib/connectors/mintsoft/api/auth.ts')

  // A stored value that is non-empty — the old predicate's whole test — and not a usable URL.
  const stored = 'not a url at all'
  assert.equal(normalizeMintsoftBaseUrl(stored), null, 'the normaliser rejects it')

  // REAL auth material, so the only thing left to refuse on is the endpoint.
  SETTING_ROWS.mintsoft_api_key = REAL_TOKEN
  connectionBaseUrl = stored
  try {
    assert.equal(
      await isMintsoftConfigured(), false,
      'a base URL nothing can build a request from is not a configured connection, whatever the'
      + ' credentials say',
    )
  } finally {
    connectionBaseUrl = 'https://api.mintsoft.co.uk'
    SETTING_ROWS.mintsoft_api_key = WHITESPACE_TOKEN
  }
})

/**
 * FIXED-KEY MODE, MOVED HERE WHEN `mintsoftHasAuthMaterial` WAS DELETED
 * (o3d-remove-shiphero round 14, Codex HIGH 2).
 *
 * The deleted helper had its own mode-awareness test (tests/mintsoft-auth-mode.test.ts). The
 * predicate that SURVIVES — and that everything now reads — had no case for its `api_key` arm at
 * all. Deleting a duplicate computation must not delete the coverage the duplicate was carrying,
 * so the three rules move here, asserted against the predicate production actually uses.
 *
 * The rules matter because of o3d-092: in fixed-key mode NOTHING may call `/api/Auth`, since a
 * refresh mints a new tenant key and breaks the woocommerce-mintsoft-sync sweep and the
 * shipping-label service that share it. So "configured" in this mode has to mean the FIXED key is
 * there — falling back to credentials or to a stale cache would report a connection that is about
 * to throw on every call, and imply the credentials are still load-bearing when the whole point is
 * that they are not.
 */
test('[round 14 HIGH 2] fixed-key mode: the FIXED key alone decides, and it is trimmed', async () => {
  const { isMintsoftConfigured } = await import('../lib/connectors/mintsoft/api/auth.ts')

  SETTING_ROWS.mintsoft_auth_mode = 'api_key'
  // Everything that counts in the OTHER mode, all present: the rotating cache and a full
  // username/password pair. None of it may substitute for the fixed key.
  SETTING_ROWS.mintsoft_api_key = REAL_TOKEN
  SETTING_ROWS.mintsoft_username = 'ops'
  SETTING_ROWS.mintsoft_password = 'ops-password'
  try {
    assert.equal(
      await isMintsoftConfigured(), false,
      'credentials and a cached token do NOT make a fixed-key connection configured — reporting'
      + ' otherwise implies they are load-bearing, and in this mode nothing may use them',
    )

    SETTING_ROWS.mintsoft_static_api_key = WHITESPACE_TOKEN
    assert.equal(
      await isMintsoftConfigured(), false,
      'and the trim rule holds in this branch too: a fixed key of spaces builds'
      + " `Authorization: '   '`",
    )

    SETTING_ROWS.mintsoft_static_api_key = REAL_TOKEN
    assert.equal(
      await isMintsoftConfigured(), true,
      'a real fixed key IS a configured connection — without this the two cases above would pass on'
      + ' a mode that always refuses',
    )
  } finally {
    delete SETTING_ROWS.mintsoft_static_api_key
    delete SETTING_ROWS.mintsoft_username
    delete SETTING_ROWS.mintsoft_password
    SETTING_ROWS.mintsoft_auth_mode = 'credentials'
    SETTING_ROWS.mintsoft_api_key = WHITESPACE_TOKEN
  }
})
