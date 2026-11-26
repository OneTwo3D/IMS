/**
 * ONE VERDICT ON "IS THIS CONNECTION SET UP?", ALL THE WAY TO THE MARKUP
 * (o3d-remove-shiphero round 14, Codex HIGH 2).
 *
 * THE DEFECT. Round 12 made `isMintsoftConfigured()` reject an UNPARSEABLE stored base URL: it reads
 * `getMintsoftApiConfiguration().baseUrl`, which is `normalizeMintsoftBaseUrl(stored) ?? ''`, and
 * that normalised value is the only base URL any Mintsoft request is ever built from. A stored value
 * `validateExternalBaseUrl` rejects is therefore a connection that cannot make a single call. Round
 * 10 had already made that predicate AUTHORITATIVE for the `configured` flag on both UI facades.
 *
 * And both Mintsoft DTO builders went on computing the same fact a second way —
 * `Boolean((connection?.baseUrl ?? '').trim() && mintsoftHasAuthMaterial(settings))` — which tests
 * only that the stored string is NON-BLANK. So on exactly the case round 12 fixed the two answers
 * DIVERGED, and the screens read the wrong one:
 *
 *   - `/sync` printed "Configured" and left Run Product Verify, Run Bundle Verify and Poll Returns
 *     ENABLED — three actions that call a warehouse over a URL nothing can build a request from;
 *   - the onboarding wizard printed a green "Connected to <endpoint>" banner and
 *     "Mintsoft connection is already configured.";
 *
 * while the registry envelope beside them said the connection was unusable. The remedy an operator
 * takes from "Configured" is to look somewhere else for the fault.
 *
 * THE FIX IS A DELETION, NOT A SYNC. `MintsoftConnectionStatus` no longer HAS a `configured` field,
 * so there is no second value to agree or disagree with; the envelope's verdict is handed to the
 * Mintsoft renderers as a prop. `data.status.configured` is now a compile error.
 *
 * WHY THIS FILE GOES TO THE MARKUP. The round-10 fixture that pinned the facade
 * (tests/wms-configured-predicate-containment.test.ts) MOCKS both DTO builders, so it stops one
 * layer before the code that decides what an operator reads — the fifth fixture on this branch to
 * stop short of production. This file mocks NO Mintsoft code and NO WMS code. It stubs the four
 * process boundaries a unit test cannot have (Prisma, the settings rows, the session, and the
 * framework router/session hooks a client component reads) and then runs, unmodified:
 *
 *   getWmsSyncDashboardData → the registry → MintsoftConnector.isConfigured → isMintsoftConfigured
 *     → getMintsoftDashboardData → WmsSyncPanel → WMS_PANELS.mintsoft.render → MintsoftClient
 *
 * and the same chain for the onboarding wizard. The assertions are about the rendered HTML.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from './fixtures/render-client-component.ts'
import type { WmsConnectorId } from '../lib/connectors/wms/types.ts'
// TYPE-ONLY, and therefore erased: importing the server action's VALUES here would load the module
// before the mocks below are installed. The type is what the compile-time case needs.
import type { MintsoftConnectionStatus } from '../app/actions/mintsoft-sync.ts'

/** Non-blank — which is the whole of what the deleted computation tested — and not a usable URL. */
const MALFORMED_BASE_URL = 'not a url at all'
const USABLE_BASE_URL = 'https://api.mintsoft.co.uk'

/** Flipped per case. The ONLY thing that differs between the two halves of every case below. */
let connectionBaseUrl = MALFORMED_BASE_URL

function mintsoftConnectionRow() {
  return {
    id: 'wms-conn-1',
    connector: 'mintsoft',
    label: 'Mintsoft',
    baseUrl: connectionBaseUrl,
    orderLookupConnector: null,
    active: true,
    lastAuthAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    bindings: [] as Array<{ id: string }>,
  }
}

/**
 * Prisma as a boundary. Permissive except for the one row this file is about: the Mintsoft
 * connection, whose `baseUrl` is the stored value both the authoritative predicate and the deleted
 * recomputation read. One source, two readings — that is the divergence.
 */
const dbStub: unknown = new Proxy({}, {
  get: (_target, model: string) => new Proxy({}, {
    get: (_m, method: string) => async () => {
      if (model === 'wmsConnection' && (method === 'findFirst' || method === 'findUnique')) {
        return mintsoftConnectionRow()
      }
      if (method === 'findMany') return []
      if (method === 'count') return 0
      return null
    },
  }),
})
mock.module('@/lib/db', { namedExports: { db: dbStub, prisma: dbStub } })

/**
 * An ordinary, working install: Mintsoft enabled, a real cached token, no auth-mode weirdness.
 * Nothing here can be the reason a screen says "not set up" — only the base URL can.
 */
const SETTING_ROWS: Record<string, string> = {
  plugin_mintsoft_enabled: 'true',
  // A non-blank, non-whitespace cached token. Obviously fake on purpose: the predicate only asks
  // whether there IS auth material, so a realistic-looking string would be a secret-shaped liability
  // for no test value.
  mintsoft_api_key: 'fixture-cached-token-not-a-real-credential',
}
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => SETTING_ROWS[key] ?? null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, SETTING_ROWS[key] ?? null])),
    setSetting: async () => {},
    setSettings: async () => {},
    deleteSetting: async () => {},
    // The pure half of the module, stubbed to its identity behaviour. None of it touches the fact
    // under test — a display mask and an at-rest cipher cannot change whether a base URL parses —
    // and the alternative (importing the real module) binds the REAL Prisma client before the `db`
    // mock above can run.
    serializeSettingValue: (_key: string, value: string) => value,
    deserializeSettingValue: (_key: string, value: string) => value,
    maskSettingSecret: (_key: string, value: string | null | undefined) => (value ? '••••••••' : ''),
    SENSITIVE_SETTING_KEYS: new Set<string>(),
    SETTING_ENV_FALLBACKS: {} as Record<string, string>,
    // No environment overrides: a clean install, so the stored rows above are the whole truth and
    // an env var on the developer's box cannot change what this file proves.
    getActiveSettingEnvOverrides: () => ({}),
    getSettingEnvFallbackKey: () => null,
    getEnvFallback: () => null,
    migrateEncryptedSettingValue: async () => 'skipped',
    bulkMigrateEncryptedSettings: async () => {},
    migrateEncryptedSettingRows: async () => {},
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireFreshPermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireAuth: async () => ({ id: 'u1', role: 'ADMIN' }),
    getCurrentUser: async () => ({ id: 'u1', role: 'ADMIN' }),
    freshAuthFailureResult: () => ({ success: false, error: 'fresh_auth_required' }),
  },
})

// The framework boundaries a client component reads. Not code under test: the router and the
// session provider are context this harness has no tree for.
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => {} }), redirect: () => {} } })
mock.module('next-auth/react', {
  namedExports: {
    useSession: () => ({ data: { user: { id: 'u1', role: 'ADMIN' } }, status: 'authenticated', update: async () => {} }),
    getSession: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    signIn: async () => {},
    signOut: async () => {},
    SessionProvider: ({ children }: { children: unknown }) => children,
  },
})

const noop = () => {}
const withStepUp = async <T,>(run: () => Promise<T>): Promise<T> => run()

function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether the control with this visible label is rendered DISABLED.
 *
 * It asserts the control EXISTS first, on purpose: "disabled" must not be satisfiable by a render
 * that simply stopped drawing the button — that is a different screen, not a safer one.
 */
/**
 * The Connection card's Status tile, read off the markup rather than off a whole-page regex — the
 * word "Configured" appears in prose elsewhere on this screen, and a page-wide match would be
 * satisfied by the wrong sentence.
 */
function statusTileText(html: string): string {
  const at = html.indexOf('>Status<')
  assert.notEqual(at, -1, 'the Connection card must render a Status tile')
  return visibleText(html.slice(at + 1, at + 300))
}

function controlIsDisabled(html: string, label: string): boolean {
  const at = html.indexOf(label)
  assert.notEqual(at, -1, `expected a "${label}" control in the rendered panel`)
  const open = html.lastIndexOf('<button', at)
  assert.notEqual(open, -1, `expected "${label}" to be a button`)
  const tag = html.slice(open, html.indexOf('>', open) + 1)
  return /\sdisabled(=|\s|>)/.test(tag)
}

async function renderSyncPanel() {
  const wmsSync = await import('../app/actions/wms-sync.ts')
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')
  const data = await wmsSync.getWmsSyncDashboardData()
  assert.notEqual(data, null, 'Mintsoft is the enabled connector; a null DTO would be a different bug')
  const { html } = mountClientComponent(WmsSyncPanel, {
    connectorId: 'mintsoft' as WmsConnectorId,
    data,
    onBack: noop,
  }).render()
  return { data: data!, html }
}

async function renderOnboardingStep() {
  const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')
  const { WmsOnboardingConnection } = await import('../components/onboarding/wms-onboarding-connection.tsx')
  const data = await wmsOnboarding.getWmsOnboardingConnectionData()
  const { html } = mountClientComponent(WmsOnboardingConnection, {
    data,
    enabled: true,
    busy: false,
    availableOrderLookupConnectors: [],
    withStepUp,
    onToggle: noop,
    onBusyChange: noop,
    onConnected: noop,
    onError: noop,
  } as never).render()
  return { data, html }
}

// ---------------------------------------------------------------------------------------------
// THE DIVERGENT CASE — a stored base URL that is non-blank and unusable
// ---------------------------------------------------------------------------------------------

test('[round 14 HIGH 2] /sync shows NOT CONFIGURED and disables verification for an unusable base URL', async () => {
  connectionBaseUrl = MALFORMED_BASE_URL
  const { data, html } = await renderSyncPanel()

  assert.equal(data.configured, false, 'the envelope carries the one verdict')

  // THE DELETION ITSELF: the payload no longer restates the fact, so there is nothing to disagree.
  const panel = data.connectorData.mintsoft as { status: Record<string, unknown>; connection: { baseUrl: string } }
  assert.equal(
    'configured' in panel.status, false,
    'MintsoftConnectionStatus must not carry a second `configured` — a field that exists is a field'
    + ' a renderer can read',
  )

  // AND THE FIXTURE IS NOT VACUOUS: the stored value the deleted expression tested is right there,
  // non-blank, exactly as an operator typo leaves it.
  assert.equal(panel.connection.baseUrl.trim().length > 0, true)

  // WHAT THE OPERATOR READS.
  assert.match(
    statusTileText(html), /^Status Not configured/,
    'the Status tile tells the truth — it used to print "Configured" here',
  )

  // The three actions that would call the warehouse.
  for (const label of ['Run Product Verify', 'Run Bundle Verify', 'Poll Returns']) {
    assert.equal(
      controlIsDisabled(html, label), true,
      `${label} must be disabled — it calls Mintsoft over a URL nothing can build a request from`,
    )
  }
})

test('[round 14 HIGH 2] the onboarding step does not claim "Connected" for an unusable base URL', async () => {
  connectionBaseUrl = MALFORMED_BASE_URL
  const { data, html } = await renderOnboardingStep()

  assert.equal(data.connectorId, 'mintsoft')
  assert.equal(data.configured, false)

  const text = visibleText(html)
  // The green banner and the reassurance line, both of which used to appear off the nested value.
  assert.doesNotMatch(text, /Connected to/, 'no green "Connected to <endpoint>" banner')
  assert.doesNotMatch(text, /connection is already configured/i)
  // The form an operator fixes it in is still on screen, with the stored value in it.
  assert.match(html, /Base URL/)
  assert.ok(html.includes(MALFORMED_BASE_URL), 'with the stored value in it, so it can be corrected')
})

// ---------------------------------------------------------------------------------------------
// THE POSITIVE CONTROL — the same install, one character different
// ---------------------------------------------------------------------------------------------

test('[round 14 HIGH 2] a USABLE base URL still reads Configured and still enables verification', async () => {
  // Without this the three cases above are satisfied by a fix that simply says "not configured" to
  // everybody, which would disable the /sync verification actions for every working install.
  connectionBaseUrl = USABLE_BASE_URL
  try {
    const { data, html } = await renderSyncPanel()
    assert.equal(data.configured, true, 'nothing changed but the endpoint')

    assert.match(statusTileText(html), /^Status Configured/)
    for (const label of ['Run Product Verify', 'Run Bundle Verify', 'Poll Returns']) {
      assert.equal(controlIsDisabled(html, label), false, `${label} must be available on a live connection`)
    }
  } finally {
    connectionBaseUrl = MALFORMED_BASE_URL
  }
})

test('[round 14 HIGH 2] and the onboarding step DOES say Connected on a usable base URL', async () => {
  connectionBaseUrl = USABLE_BASE_URL
  try {
    const { data, html } = await renderOnboardingStep()
    assert.equal(data.configured, true)
    const text = visibleText(html)
    assert.match(text, /Connected to/)
    assert.match(text, /connection is already configured/i)
  } finally {
    connectionBaseUrl = MALFORMED_BASE_URL
  }
})

test('[round 14 HIGH 2] the nested `configured` is not merely absent — it is UNWRITABLE', () => {
  // The runtime check above (`'configured' in panel.status`) says the builder stopped emitting it.
  // This says the TYPE stopped admitting it, which is what makes a renderer unable to read a second
  // verdict at all: `data.status.configured` is a compile error, in every screen, for ever.
  const status: MintsoftConnectionStatus = {
    active: true,
    bindingCount: 0,
    lastAuthAt: null,
    lastStockSyncAt: null,
  }
  // @ts-expect-error o3d-remove-shiphero r14 (Codex HIGH 2): MintsoftConnectionStatus has no
  // `configured`. Putting the field back makes this line compile, and this file then fails to
  // compile because the directive is unused — THAT is the detection.
  assert.equal(status.configured, undefined)
})

// ---------------------------------------------------------------------------------------------
// THE SIBLING RECOMPUTATION — warehouse discovery was gated on the same expression
// ---------------------------------------------------------------------------------------------

test('[round 14 HIGH 2] warehouse discovery is gated on the verdict, not on a non-blank string', async () => {
  // The dashboard builder ran external warehouse discovery behind the SAME expression the deleted
  // `configured` was, so a malformed base URL sent it out to build a request it cannot build. It now
  // asks the boundary. `externalWarehouses` empty AND `warehouseLookupError` null is the signature
  // of "never attempted" — a lookup that RAN and failed would leave an error string behind.
  connectionBaseUrl = MALFORMED_BASE_URL
  const { data } = await renderSyncPanel()
  const panel = data.connectorData.mintsoft as {
    externalWarehouses: unknown[]
    warehouseLookupError: string | null
  }
  assert.deepEqual(panel.externalWarehouses, [])
  assert.equal(panel.warehouseLookupError, null, 'discovery was not attempted, so it did not fail either')
})
