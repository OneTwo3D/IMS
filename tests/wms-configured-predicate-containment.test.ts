/**
 * A MALFORMED AUTH MODE MUST NOT TAKE THE ONBOARDING WIZARD OFF THE SCREEN
 * (o3d-remove-shiphero round 10, Codex HIGH 2).
 *
 * THE DEFECT. Round 8 moved the `configured` flag on both UI facades onto
 * `WmsConnector.isConfigured()` and argued the move behaviour-preserving BY INSPECTION. It was not.
 * The value it replaced came from the connector's own onboarding hook, where
 * `mintsoftHasAuthMaterial` CATCHES `MintsoftAuthModeError` and reads a malformed auth mode as "not
 * configured". `MintsoftConnector.isConfigured()` does not: it goes through
 * `getMintsoftApiConfiguration()`, which refuses a malformed stored or environment value rather
 * than defaulting it (deliberately — defaulting means a login that rotates the tenant API key).
 *
 * The facades then awaited that predicate unguarded, and `app/(dashboard)/onboarding/page.tsx`
 * gathers its reads with `Promise.all`. So ONE bad `mintsoft_auth_mode` row — or one bad
 * `MINTSOFT_AUTH_MODE` env var, which never passes through the validated settings action at all —
 * failed the whole wizard render, and the wizard is where the value is corrected. The
 * misconfiguration became unrecoverable through the UI, which is worse than the mislabelled step
 * round 8 set out to fix. `/sync` degrades rather than 500s, but one rejected read there makes the
 * WHOLE dashboard unavailable, not just the WMS panel.
 *
 * WHAT IS REAL HERE. The server actions, `isWmsConnectorConfigured` (including its try/catch), the
 * shipped registry, the real `MintsoftConnector`, and the real `resolveMintsoftAuthMode` that
 * throws. Only the process boundaries a unit test cannot have are stubbed: the session, and Prisma.
 *
 * AND IT IS PROVED NON-VACUOUS. The last case asserts the UNCONTAINED predicate really does reject
 * under these exact stubs. Without it, every assertion below would also pass on a fixture where
 * nothing ever threw — the defect would be invisible and the test would look green for the wrong
 * reason.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * NOTHING UNDER TEST IS IMPORTED STATICALLY, AND NOTHING UNDER TEST IS MOCKED.
 *
 * `mock.module` only reaches a module that has not been evaluated yet, so a static
 * `import * as realRegistry from '../lib/connectors/wms/registry.ts'` here would pull the registry
 * — and therefore `MintsoftConnector`, and therefore the REAL Prisma client — in before any mock
 * below has run. The connector then reads a real database and `isConfigured()` throws a CONNECTION
 * error instead of the auth-mode error this file is about: the containment answers `false` for the
 * wrong reason and every case goes green while proving nothing. The non-vacuity case at the bottom
 * is what caught that, and it is why the registry is NOT mocked here at all.
 *
 * So the mocks below are only the three process boundaries: Prisma, the settings rows, and the
 * session — plus the connector's own `'use server'` screen readers, whose CONTENT is proved in the
 * Mintsoft suites and which would otherwise reach the real database. The registry, the connector,
 * `isWmsConnectorConfigured`, the plugin-state resolution and both server actions are the shipped
 * code, unmodified.
 */

/** The value an operator (or an env var) can leave behind: close to a real mode, and not one. */
const MALFORMED_AUTH_MODE = 'api-key'

/** What the wizard's Mintsoft step and the /sync panel render. */
const MINTSOFT_FORM = { endpoint: 'https://api.mintsoft.co.uk', mode: MALFORMED_AUTH_MODE }
const MINTSOFT_PANEL = { warehouses: [] as string[] }

/**
 * Prisma, as a boundary rather than as code under test. Permissive on purpose: this file is about
 * what happens when a PREDICATE throws, and a stub that failed on an unanticipated read would turn
 * every such case into a different failure.
 */
const dbStub: unknown = new Proxy({}, {
  get: () => new Proxy({}, {
    get: (_model, method: string) => async () => {
      if (method === 'findMany') return []
      if (method === 'count') return 0
      return null
    },
  }),
})
mock.module('@/lib/db', { namedExports: { db: dbStub, prisma: dbStub } })

/**
 * The settings rows. Mintsoft is the enabled WMS connector (the ordinary shipped configuration) and
 * `mintsoft_auth_mode` is the malformed one — every other key answers as an unset install would, so
 * nothing else can be the reason a read fails.
 */
const SETTING_ROWS: Record<string, string> = {
  plugin_mintsoft_enabled: 'true',
  mintsoft_auth_mode: MALFORMED_AUTH_MODE,
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

test('[round 10 HIGH 2] a malformed auth mode still renders the onboarding form', async () => {
  const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')

  // THE WHOLE DEFECT IN ONE LINE: before the fix this REJECTED, and the wizard's `Promise.all`
  // turned that into a failed render of the only screen that can repair the value.
  const data = await wmsOnboarding.getWmsOnboardingConnectionData()

  assert.equal(data.connectorId, 'mintsoft')
  assert.equal(data.connectorLabel, 'Mintsoft', 'the step still names the system it is about')
  assert.equal(
    data.configured, false,
    'a connector that cannot say whether it is configured is NOT configured — and "not set up" is'
    + ' exactly the state that sends an operator to the form below',
  )
  assert.deepEqual(
    data.connectorData.mintsoft, MINTSOFT_FORM,
    'and the corrective form is still carried to the wizard: an unanswerable predicate must not'
    + ' remove the only control that can answer it',
  )
})

test('[round 10 HIGH 2] the /sync WMS panel survives the same malformed auth mode', async () => {
  const wmsSync = await import('../app/actions/wms-sync.ts')

  // /sync gathers 22 reads and drops the ENTIRE dashboard if any one of them rejects, so this was
  // never "the WMS panel is missing" — it was every panel on the page.
  const data = await wmsSync.getWmsSyncDashboardData()

  assert.notEqual(data, null, 'a WMS connector is enabled; null is reserved for "none is"')
  assert.equal(data!.connectorId, 'mintsoft')
  assert.equal(data!.configured, false)
  assert.deepEqual(data!.connectorData.mintsoft, MINTSOFT_PANEL, 'the panel still renders')
})

test('[round 10 HIGH 2] the predicate really does throw here — the cases above are not vacuous', async () => {
  const { MintsoftConnector } = await import('../lib/connectors/mintsoft/index.ts')
  const { MintsoftAuthModeError } = await import('../lib/connectors/mintsoft/settings/schema.ts')

  // UNCONTAINED. If this resolved, the two cases above would prove nothing: they would be asserting
  // that a predicate which never throws does not take a screen down.
  await assert.rejects(
    () => new MintsoftConnector().isConfigured(),
    (error: unknown) => {
      assert.ok(error instanceof MintsoftAuthModeError, `expected MintsoftAuthModeError, got ${String(error)}`)
      return true
    },
    'MintsoftConnector.isConfigured() must still refuse a malformed auth mode — the containment is'
    + ' at the boundary, not a softening of the connector',
  )

  // CONTAINED, through the shipped registry: the same connector, the same throw, answered.
  const registry = await import('../lib/connectors/wms/registry.ts')
  assert.equal(
    await registry.isWmsConnectorConfigured('mintsoft'), false,
    'the boundary answers the question the connector could not',
  )
})

test('[round 10 HIGH 2] a framework REDIRECT thrown by the predicate is rethrown, not answered false', async () => {
  // THE ONE THROW THAT MUST NOT BE CONTAINED. Next signals `redirect()` / `notFound()` by THROWING,
  // and a predicate that re-enters a permission gate raises exactly those. Swallowing a
  // NEXT_REDIRECT into `configured: false` leaves an operator with an invalidated or 2FA-unverified
  // session sitting on the wizard instead of at the challenge — the same reasoning
  // lib/domain/post-commit.ts states, and the same `unstable_rethrow` doing the work. Without this
  // case "rethrows framework control flow first" is a claim in a comment.
  const registry = await import('../lib/connectors/wms/registry.ts')
  const redirectError = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })

  await assert.rejects(
    () => registry.isWmsConnectorConfigured('acme', {
      findDef: () => ({ create: () => ({ isConfigured: async () => { throw redirectError } }) as never }),
    }),
    (error: unknown) => {
      assert.equal((error as { digest?: string }).digest, 'NEXT_REDIRECT;replace;/login;307;')
      return true
    },
  )

  // And the contrast that proves the rethrow is selective rather than a missing catch: an ORDINARY
  // error from the same shape is still answered.
  assert.equal(
    await registry.isWmsConnectorConfigured('acme', {
      findDef: () => ({ create: () => ({ isConfigured: async () => { throw new Error('boom') } }) as never }),
    }),
    false,
  )
})
