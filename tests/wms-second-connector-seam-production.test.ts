/**
 * THE SECOND-CONNECTOR SEAM, DRIVEN THROUGH THE PRODUCTION ENTRYPOINTS
 * (o3d-remove-shiphero round 2, Codex HIGH 1 + HIGH 2).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM tests/wms-second-connector-seam.test.ts. That file proves
 * the generic layer BEHAVES generically when it is handed a fictitious connector. Codex's finding
 * was that behaving generically when handed one is not the same as being REACHED with one: the ASN
 * server actions dispatched on `connector === 'mintsoft'`, and the dispatch sweep wired every
 * connector's inbound-delta cursors to Mintsoft's setting rows. Both are on the path between the
 * registry and the generic code, so a test that starts inside the generic code cannot see either.
 * It is the proof-of-an-adjacent-property shape: sound, and about the wrong thing.
 *
 * So this file starts at the OUTSIDE. It registers `acme-wms`, makes it the active connector, and
 * calls the real server actions and the real Prisma-backed dispatch deps. The module mocks are
 * confined here because `mock.module` is process-wide and the seam file deliberately runs against
 * the real modules.
 *
 * WHAT IS MOCKED, AND WHY THAT IS NOT CHEATING. Only the things a second connector's EXISTENCE
 * would change (the registry's contents, which connector is enabled) and the process boundaries a
 * unit test cannot have (the session, the database). The code under test — the facade's routing,
 * the deps' key derivation, the sweep core — is the shipped code, unmodified.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  ACME_DELTA_TIME_ZONE,
  ACME_WMS_ID,
  ACME_WMS_LABEL,
  AcmeWmsConnector,
  DeltaAcmeWmsConnector,
  SEAM_WMS_CONNECTOR_IDS,
  acmeAsnActions,
  acmeWallClock,
  acmeWmsRegistration,
  makeAcmeWarehouse,
  type AcmeAsnLog,
  type AcmeDeltaLog,
} from './helpers/fictitious-wms-connector.ts'
import { seamRegistryExports, seamWmsTypesExports } from './helpers/fictitious-wms-connector.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'
import * as realPlugins from '../lib/integration-plugins.ts'
import { createRegisteredWmsConnectorRegistry } from '../lib/connectors/wms/registry.ts'
import type { WmsConnectorHooks } from '../lib/connectors/wms/connector-hooks.ts'
import type { WmsConnector, WmsOrderStatus } from '../lib/connectors/wms/types.ts'
import * as realSettingsStore from '../lib/settings-store.ts'
import { encodeWmsDeltaCursor } from '../lib/domain/wms/delta-cursor-generation.ts'

// --- the fictitious connector, as far as the app is concerned ---------------------------------

const asnLog: AcmeAsnLog = { asnCalls: [] }
const acmeWarehouse = makeAcmeWarehouse()
const acmeConnector = new AcmeWmsConnector(acmeWarehouse)

/** What Acme's /sync panel and onboarding form hand back. Opaque to the generic facades by design. */
const ACME_PANEL = { warehouses: ['ACME-WH-1'], lastSyncAt: null }
const ACME_FORM = { endpoint: 'https://acme.example/api', account: 'acme-ops' }

/**
 * Acme's hooks: the ASN implementation, the /sync dashboard and the onboarding connection step.
 * No delta scope, no dispatch precondition — those absences are load-bearing elsewhere in this file.
 */
const acmeHooks: WmsConnectorHooks = {
  asn: async () => acmeAsnActions(acmeConnector, asnLog),
  // NEITHER HOOK STATES `configured` (round 8, Codex HIGH 1): a hook supplies its screen's payload,
  // and whether the connection is set up is `isConfigured()` — see connector-hooks.ts.
  syncDashboard: async () => ({ getDashboardData: async () => ({ panel: ACME_PANEL }) }),
  onboarding: async () => ({ getConnectionData: async () => ({ form: ACME_FORM }) }),
  productSync: async () => ({
    syncProduct: async (productId, triggeredBy) => { productSyncLog.push(`product:${productId}:${triggeredBy}`) },
    syncBundle: async (productId, triggeredBy) => { productSyncLog.push(`bundle:${productId}:${triggeredBy}`) },
  }),
}

/** What Acme's product/bundle sync was asked to do — proves WHICH connector the dispatcher reached. */
const productSyncLog: string[] = []

/**
 * Acme's delta rows and the cursor it was asked for. Declared up here because the connector the
 * registry hands back must BE this one — the production wrapper reads `deltaCursorTimeZone` off
 * whatever `getWmsConnector` returns, which is the seam under test.
 */
const deltaLog: AcmeDeltaLog = { calls: [] }
/** Acme's own watermark, and a backlog row that changed 70 minutes ago — inside its real window. */
const ACME_WATERMARK_AT = new Date(Date.now() - 60 * 60 * 1000)
const ACME_BACKLOG_CHANGED_AT = new Date(Date.now() - 70 * 60 * 1000)
const ACME_BACKLOG_ROW: WmsOrderStatus = {
  externalOrderId: 'ACME-1', externalOrderNumber: 'SO-BACKLOG', status: 'DESPATCHED', statusLabel: 'DESPATCHED',
  isSplit: false, partCount: null, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null,
  tracking: [{ trackingNumber: 'ACME-TRACK-1', carrier: 'ACME-EXPRESS', despatchedAt: null }],
  dispatched: true, raw: null,
}
const acmeDeltaConnector = new DeltaAcmeWmsConnector(
  [{ changedAt: ACME_BACKLOG_CHANGED_AT, row: ACME_BACKLOG_ROW }],
  deltaLog,
  acmeWarehouse,
)

/** Which connector plugins are enabled. Mutated per test, read by the REAL getActiveWmsConnectorId. */
let pluginState: Record<string, boolean> = { [ACME_WMS_ID]: true }

// The id list the resolver walks. This is the ONE thing registering a second connector changes
// about the shipped build, and the real `getActiveWmsConnectorId` is then left to do its own work.
//
// THE ID LIST AND THE REGISTRY ARE ONE FIXTURE NOW (round 12, Codex HIGH 1). They used to be two
// independent mocks — a widened `WMS_CONNECTOR_IDS` here and a hand-built array of definitions
// below — so the seam could hold the state production forbids and the round-12 defect (a registered
// id with no definition) was invisible to four green suites. `SEAM_WMS_CONNECTOR_IDS` feeds both,
// and the registry is assembled by the SHIPPED derivation.
mock.module('@/lib/connectors/wms/types', { namedExports: seamWmsTypesExports(realTypes) })
mock.module('@/lib/integration-plugins', {
  namedExports: { ...realPlugins, getIntegrationPluginState: async () => pluginState },
})

const seamRegistry = createRegisteredWmsConnectorRegistry<string>([...SEAM_WMS_CONNECTOR_IDS], {
  // Mintsoft, registered but inert: these tests never dispatch to it, and leaving its hooks or its
  // real factory on would let a routing bug reach the real server actions and the real database
  // instead of failing the assertion. The factory matters as much as the hooks now that the UI
  // facades resolve `isConfigured()` through it (round 8, Codex HIGH 1) — the fallback path, with
  // no plugin enabled, resolves Mintsoft and would otherwise read settings.
  mintsoft: {
    label: 'Mintsoft',
    available: true,
    createReplayPolicy: 'remote-refuses-duplicate',
    create: (() => ({
      id: 'mintsoft',
      name: 'Mintsoft',
      isConfigured: async () => false,
    })) as never,
  },
  [ACME_WMS_ID]: {
    ...acmeWmsRegistration(acmeWarehouse),
    hooks: acmeHooks,
    // The registry hands back the DELTA-CAPABLE Acme, so the production wrapper resolves its
    // `deltaCursorTimeZone` the way it resolves the shipped connector's.
    create: () => acmeDeltaConnector as never,
  },
})

// The shipped registry module with its DEFAULT SOURCE re-bound to the seam registry — the real
// `findWmsConnectorLabel`, `getWmsConnectorHooks`, `findWmsConnector` and the real CONTAINED
// `isWmsConnectorConfigured` (round 10, Codex HIGH 2) all run unmodified over it, rather than being
// re-implemented here as one-liners the production rule could drift away from.
mock.module('@/lib/connectors/wms/registry', { namedExports: seamRegistryExports(() => seamRegistry) })

// The per-connector sweep lock is a session advisory lock on a real pg connection — a process
// boundary, not code under test. Running the body inline is the only thing mocked about it.
mock.module('@/lib/domain/wms/dispatch-sweep-lock', {
  namedExports: {
    DISPATCH_LOCK_SKIPPED: { lockSkipped: true },
    DISPATCH_SWEEP_LOCK_NAMESPACE: 1,
    dispatchSweepLockKey: (id: string) => id.length,
    withDispatchSweepLockOrSkip: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

// Every action here takes its delegate's own permission. The seam is about ROUTING, so the session
// is granted; tests/security/* is where the gates themselves are proved.
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireAuth: async () => ({ id: 'u1', role: 'ADMIN' }),
    getCurrentUser: async () => ({ id: 'u1', role: 'ADMIN' }),
  },
})

// ---------------------------------------------------------------------------------------------
// HIGH 1 — the ASN server actions dispatch to the ACTIVE connector, whoever that is
// ---------------------------------------------------------------------------------------------

test('seam/production: the ASN facade dispatches to a registered non-Mintsoft connector', async () => {
  asnLog.asnCalls.length = 0
  const actions = await import('../app/actions/wms-asn.ts')

  // THE READ. Before the fix this returned `unsupportedWmsAsnState` — pluginEnabled false, no ASNs
  // — for a connector that implements the REQUIRED `createAsn`, because the facade compared the
  // active id to a literal and fell off the end of the `if`.
  const poState = await actions.getWmsPurchaseOrderAsnState('po-1')
  assert.equal(poState.pluginEnabled, true, 'the active connector CAN do ASNs, and the facade must reach it')
  assert.equal(poState.connectorLabel, ACME_WMS_LABEL, 'and the view-model is labelled from the registry')
  assert.equal(poState.bindingExternalWarehouseId, 'ACME-WH-1')

  // THE TRANSFER READ, which used to return `{}` — an empty map is indistinguishable from "no
  // transfers", so the failure was invisible in the UI rather than merely wrong.
  const transferStates = await actions.getWmsTransferAsnStates(['tr-1', 'tr-2'])
  assert.deepEqual(Object.keys(transferStates).sort(), ['tr-1', 'tr-2'])
  assert.equal(transferStates['tr-1'].connectorLabel, ACME_WMS_LABEL)

  // THE WRITES, which used to answer "No WMS connector is enabled." while one plainly was.
  const poCreate = await actions.createWmsPurchaseOrderAsn('po-1', {})
  assert.equal(poCreate.success, true, poCreate.error ?? '')
  assert.equal(poCreate.externalAsnId, 'ACME-ASN-po-1', 'the id came from the FICTITIOUS warehouse')

  const transferCreate = await actions.createWmsTransferAsn('tr-1', {})
  assert.equal(transferCreate.success, true, transferCreate.error ?? '')
  assert.equal(transferCreate.externalAsnId, 'ACME-ASN-tr-1')

  const recheck = await actions.recheckWmsAsnBookedIn('ACME-ASN-po-1')
  assert.equal(recheck.success, true, recheck.error ?? '')
  assert.match(recheck.message ?? '', new RegExp(ACME_WMS_LABEL))

  assert.deepEqual(
    asnLog.asnCalls,
    ['po-state:po-1', 'transfer-states:tr-1,tr-2', 'po-create:po-1', 'transfer-create:tr-1', 'recheck:ACME-ASN-po-1'],
    'every action reached the ACTIVE connector’s own implementation, in order',
  )
})

test('seam/production: a registered connector that declares NO ASN support is refused BY NAME', async () => {
  // The other half of routing by capability: "cannot" must stay expressible, and must not be
  // reported as "nothing is enabled" — those call for different things from an operator.
  const previous = seamRegistry.findDef(ACME_WMS_ID)!.hooks
  seamRegistry.getDef(ACME_WMS_ID).hooks = {}
  try {
    const actions = await import('../app/actions/wms-asn.ts')
    const state = await actions.getWmsPurchaseOrderAsnState('po-1')
    assert.equal(state.pluginEnabled, false)
    assert.equal(state.connectorLabel, ACME_WMS_LABEL, 'named, not anonymised')

    const create = await actions.createWmsPurchaseOrderAsn('po-1', {})
    assert.equal(create.success, false)
    assert.match(create.error ?? '', new RegExp(ACME_WMS_LABEL))
    assert.doesNotMatch(create.error ?? '', /No WMS connector is enabled/)
  } finally {
    seamRegistry.getDef(ACME_WMS_ID).hooks = previous
  }
})

test('seam/production: with NO plugin enabled the facade falls back and still names what it resolved', async () => {
  // `getActiveWmsConnectorId` deliberately falls back to the FIRST registered connector, so with
  // every plugin off the ACTIVE connector is Mintsoft, not nothing — and the operator must be told
  // which system was consulted. (The `connector === null` arm of the facade is only reachable with
  // an EMPTY registry, which no build ships; it is kept as a fail-safe, not as a live path.)
  const previous = pluginState
  pluginState = {}
  try {
    const actions = await import('../app/actions/wms-asn.ts')
    const create = await actions.createWmsPurchaseOrderAsn('po-1', {})
    assert.equal(create.success, false)
    assert.match(create.error ?? '', /Mintsoft/, 'the resolved connector is named')
    const state = await actions.getWmsPurchaseOrderAsnState('po-1')
    assert.equal(state.pluginEnabled, false)
    assert.equal(state.connectorLabel, 'Mintsoft')
  } finally {
    pluginState = previous
  }
})

// ---------------------------------------------------------------------------------------------
// HIGH 2 (round 2) / HIGH 2 (round 4) — the /sync and onboarding facades dispatch to the ACTIVE
// connector, and their DTO is keyed by it
// ---------------------------------------------------------------------------------------------

test('seam/production: the /sync dashboard facade dispatches to a registered non-Mintsoft connector', async () => {
  const wmsSync = await import('../app/actions/wms-sync.ts')

  // Before the fix this returned `null` — the SAME answer the facade gives when no WMS connector is
  // enabled at all, so an enabled, registered, configured second connector was reported to the
  // operator as "you have no WMS".
  const data = await wmsSync.getWmsSyncDashboardData()
  assert.notEqual(data, null, 'a WMS connector IS enabled; `null` is the no-connector answer')
  assert.equal(data!.connectorId, ACME_WMS_ID)
  assert.equal(
    data!.connectorLabel, ACME_WMS_LABEL,
    'the /sync panel is a CLIENT component and cannot read the registry, so the label travels in the DTO'
    + ' (o3d-remove-shiphero round 6) — without it an unknown connector is shown to an operator as a raw id',
  )
  assert.equal(data!.configured, true, 'the connector said it is configured, and the facade must carry that through')

  // The DTO is keyed BY CONNECTOR. A literal `mintsoft:` member was the actual obstacle to routing
  // on hooks — a second named member would have been the same one-arm defect with one more arm.
  assert.deepEqual(
    data!.connectorData[ACME_WMS_ID as never],
    ACME_PANEL,
    'the payload arrives under the id of the connector that produced it',
  )
  assert.equal(
    Object.keys(data!.connectorData).length, 1,
    'and only the active connector is represented — no named member for a connector that did not run',
  )
})

test('seam/production: the onboarding facade reports a registered non-Mintsoft connector as CONFIGURED', async () => {
  const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')

  // Before the fix the fall-through arm answered `configured: false` for every connector but one.
  // That is not an empty answer, it is a wrong one: the wizard shows an unticked setup step for a
  // connection that is already live.
  const data = await wmsOnboarding.getWmsOnboardingConnectionData()
  assert.equal(data.connectorId, ACME_WMS_ID)
  assert.equal(data.connectorLabel, ACME_WMS_LABEL, 'named from the registry, not anonymised')
  assert.equal(data.configured, true, 'the connector says it is set up, and the wizard must be told so')
  assert.deepEqual(data.connectorData[ACME_WMS_ID as never], ACME_FORM)
})

/**
 * THE TEST THAT USED TO PIN THE DEFECT (o3d-remove-shiphero round 8, Codex HIGH 1).
 *
 * WHAT IT ASSERTED, AND WHY THAT WAS WRONG. Until round 8 this case ended
 * `assert.equal(dashboard!.configured, false)` — for a connector whose `isConfigured()` returns
 * TRUE. Its reasoning was that a connector declaring no panel "has nothing configured here", so
 * `false` was read as a statement about the SCREEN. But `configured` is not about the screen: it is
 * what the /sync card renders as CONFIGURED and what the onboarding wizard ticks its setup step
 * off, and both of those are claims about the CONNECTION. So the assertion agreed with the facade's
 * hard-coded `configured: false` while the fixture standing in for the warehouse said the
 * connection was live — and the fixture was right. A test that blesses the wrong answer is why this
 * survived round 6, which audited these two files specifically.
 *
 * WHAT IT ASSERTS NOW. Capability and state are read SEPARATELY and vary independently: a live
 * connection with no panel is `configured: true` with an empty payload, and the same connector with
 * its connection taken away is `configured: false` — from the same code path, so the value is
 * plainly being read rather than written by the branch.
 */
test('seam/production: a connector with NO panel and a LIVE connection is not reported as unconfigured', async () => {
  const previous = seamRegistry.getDef(ACME_WMS_ID).hooks
  seamRegistry.getDef(ACME_WMS_ID).hooks = {}
  try {
    const wmsSync = await import('../app/actions/wms-sync.ts')
    const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')

    const dashboard = await wmsSync.getWmsSyncDashboardData()
    assert.notEqual(dashboard, null, 'a connector with no panel is still an enabled connector')
    assert.equal(dashboard!.connectorId, ACME_WMS_ID)
    assert.equal(
      dashboard!.configured, true,
      'the connector says its connection is set up; shipping no panel does not unsay it',
    )
    assert.deepEqual(dashboard!.connectorData, {}, 'nothing is claimed on behalf of a connector that ran nothing')

    const onboarding = await wmsOnboarding.getWmsOnboardingConnectionData()
    assert.equal(onboarding.connectorLabel, ACME_WMS_LABEL, 'still named')
    assert.equal(onboarding.configured, true, 'and the wizard does not ask for credentials that are already stored')
    assert.deepEqual(onboarding.connectorData, {})
  } finally {
    seamRegistry.getDef(ACME_WMS_ID).hooks = previous
  }
})

test('seam/production: the SAME no-panel connector reports unconfigured when its connection really is absent', async () => {
  // THE CONTRAST THAT MAKES THE CASE ABOVE A TEST OF A READ. Without it, a facade that hard-coded
  // `configured: true` would pass everything above — the same shape of mistake, mirrored.
  const previousHooks = seamRegistry.getDef(ACME_WMS_ID).hooks
  seamRegistry.getDef(ACME_WMS_ID).hooks = {}
  acmeWarehouse.configured = false
  try {
    const wmsSync = await import('../app/actions/wms-sync.ts')
    const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')
    assert.equal((await wmsSync.getWmsSyncDashboardData())!.configured, false)
    assert.equal((await wmsOnboarding.getWmsOnboardingConnectionData()).configured, false)
  } finally {
    acmeWarehouse.configured = true
    seamRegistry.getDef(ACME_WMS_ID).hooks = previousHooks
  }
})

test('seam/production: a connector whose isConfigured THROWS is reported unconfigured, not propagated', async () => {
  // o3d-remove-shiphero round 10, Codex HIGH 2 — and the case the round-10 comment on the registry
  // mock above would otherwise only CLAIM. `AcmeWmsConnector.isConfigured()` returns a boolean and
  // cannot throw, so without this the contained reader and the bare `findWmsConnector(id)
  // .isConfigured()` it replaced are indistinguishable in this file: the try/catch is never entered.
  //
  // A question that throws has not been answered, and an unanswered connection is NOT configured —
  // which is what keeps the /sync panel and the onboarding form on screen for the operator who has
  // to repair it. `null` here would mean "no WMS is enabled", which is a different and false claim.
  const previousCreate = seamRegistry.getDef(ACME_WMS_ID).create
  seamRegistry.getDef(ACME_WMS_ID).create = (() => ({
    id: ACME_WMS_ID,
    name: ACME_WMS_LABEL,
    isConfigured: async () => { throw new Error('acme cannot resolve its auth mode') },
  })) as never
  try {
    const wmsSync = await import('../app/actions/wms-sync.ts')
    const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')

    const dashboard = await wmsSync.getWmsSyncDashboardData()
    assert.notEqual(dashboard, null, 'the connector is still enabled and still named')
    assert.equal(dashboard!.connectorId, ACME_WMS_ID)
    assert.equal(dashboard!.configured, false, 'an unanswerable predicate is not a configured connection')
    assert.deepEqual(dashboard!.connectorData[ACME_WMS_ID as never], ACME_PANEL, 'and the panel still renders')

    const onboarding = await wmsOnboarding.getWmsOnboardingConnectionData()
    assert.equal(onboarding.configured, false)
    assert.deepEqual(onboarding.connectorData[ACME_WMS_ID as never], ACME_FORM, 'and so does the corrective form')
  } finally {
    seamRegistry.getDef(ACME_WMS_ID).create = previousCreate
  }
})

test('seam/production: a connector WITH a panel is still reported from its own isConfigured, not its hook', async () => {
  // The hook cannot state `configured` any more, so the value on the hooked path must come from the
  // same place as on the hook-less path. Taking the connection away while the panel keeps returning
  // its payload proves it: a facade still reading a hook-supplied flag would answer `true` here.
  acmeWarehouse.configured = false
  try {
    const wmsSync = await import('../app/actions/wms-sync.ts')
    const data = await wmsSync.getWmsSyncDashboardData()
    assert.equal(data!.configured, false, 'the connection is gone even though the panel still renders')
    assert.deepEqual(data!.connectorData[ACME_WMS_ID as never], ACME_PANEL, 'and the panel payload is unaffected')
  } finally {
    acmeWarehouse.configured = true
  }
})

test('seam/production: the product-sync dispatcher reaches a registered non-Mintsoft connector', async () => {
  // Same class as the two facades above: `lib/domain/wms/product-sync-dispatch.ts` already routes on
  // `hooks.productSync`, but nothing drove it from OUTSIDE with a second connector — and routing
  // correctly when handed one is not the same as being reached with one.
  const dispatch = await import('../lib/domain/wms/product-sync-dispatch.ts')
  productSyncLog.length = 0

  assert.equal(await dispatch.isAnyWmsConnectorEnabled(), true)
  await dispatch.runWmsProductSyncForProduct('p-1', 'product_mutation')
  await dispatch.runWmsBundleSyncForProduct('p-1', 'cron')
  assert.deepEqual(
    productSyncLog,
    ['product:p-1:product_mutation', 'bundle:p-1:cron'],
    'the mutation reached the ACTIVE connector’s own sync, with the trigger it was given',
  )

  // And a connector that declares no product sync is a silent no-op rather than a throw — the
  // dispatcher is best-effort on the product-mutation path.
  const previous = seamRegistry.getDef(ACME_WMS_ID).hooks
  seamRegistry.getDef(ACME_WMS_ID).hooks = {}
  try {
    productSyncLog.length = 0
    await dispatch.runWmsProductSyncForProduct('p-2', 'manual')
    assert.deepEqual(productSyncLog, [])
  } finally {
    seamRegistry.getDef(ACME_WMS_ID).hooks = previous
  }
})

test('seam/production: with NO plugin enabled the /sync facade answers null, and onboarding names the fallback', async () => {
  const previous = pluginState
  pluginState = {}
  try {
    const wmsSync = await import('../app/actions/wms-sync.ts')
    const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')
    assert.equal(await wmsSync.getWmsSyncDashboardData(), null, '`null` now means exactly one thing')
    // `getActiveWmsConnectorId` deliberately falls back to the FIRST registered connector, so the
    // wizard still names the system it consulted rather than describing an anonymous absence.
    const onboarding = await wmsOnboarding.getWmsOnboardingConnectionData()
    assert.equal(onboarding.connectorId, 'mintsoft')
    assert.equal(onboarding.connectorLabel, 'Mintsoft')
  } finally {
    pluginState = previous
  }
})

// ---------------------------------------------------------------------------------------------
// HIGH 2 (round 2) + HIGH 1 (round 4) — a second connector's inbound delta cannot inherit the
// shipped connector's watermark, NOR its timezone
//
// DRIVEN THROUGH `runWmsDispatchSweep`, THE PRODUCTION ENTRYPOINT. Round 2's version of this test
// called `runWmsDispatchSweepCore` and handed it `deltaTimeZone: 'UTC'` by hand. That is the
// branch's recurring defect in its purest form: the value production DERIVES was supplied by the
// test, so the derivation — which still defaulted every connector to the shipped connector's
// `Europe/London` — was the one thing the test could not see. The wrapper is now what is called,
// and the zone is not passed in from anywhere.
// ---------------------------------------------------------------------------------------------

/** A LIVE installation of the shipped connector: a recent watermark at its current generation. */
const MINTSOFT_WATERMARK = new Date(Date.now() - 60 * 1000).toISOString()

/**
 * An in-memory Prisma double: the `settings` table the delta cursors live in, plus the sync-job
 * bookkeeping the production wrapper writes around the core.
 */
type SettingsClient = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ key: string; value: string } | null>
    findMany(args: { where: { key: { in: string[] } } }): Promise<Array<{ key: string; value: string | null }>>
    upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<void>
    deleteMany(args: { where: { key: { in: string[] } } }): Promise<void>
  }
  wmsSyncJob: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<void>
  }
  wmsSyncLog: {
    create(args: { data: Record<string, unknown> }): Promise<void>
    createMany(args: { data: Array<Record<string, unknown>> }): Promise<void>
  }
  $executeRaw(): Promise<number>
  $queryRaw(): Promise<unknown[]>
  $transaction<T>(fn: (tx: SettingsClient) => Promise<T>): Promise<T>
}

function settingsDouble(seed: Record<string, string>) {
  const rows = new Map<string, string>(Object.entries(seed))
  const jobs: Array<Record<string, unknown>> = []
  const client: SettingsClient = {
    setting: {
      async findUnique({ where }: { where: { key: string } }) {
        const value = rows.get(where.key)
        return value === undefined ? null : { key: where.key, value }
      },
      async findMany({ where }: { where: { key: { in: string[] } } }) {
        return where.key.in.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) ?? null }))
      },
      async upsert({ where, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
        rows.set(where.key, update.value)
      },
      async deleteMany({ where }: { where: { key: { in: string[] } } }) {
        for (const k of where.key.in) rows.delete(k)
      },
    },
    wmsSyncJob: {
      async create({ data }: { data: Record<string, unknown> }) {
        jobs.push(data)
        return { id: `job-${jobs.length}` }
      },
      async update() {},
    },
    wmsSyncLog: {
      async create() {},
      async createMany() {},
    },
    async $executeRaw() { return 0 },
    async $queryRaw() { return [] },
    async $transaction<T>(fn: (tx: SettingsClient) => Promise<T>): Promise<T> { return fn(client) },
  }
  return { rows, jobs, client }
}

const settings = settingsDouble({
  mintsoft_order_delta_since: encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
  mintsoft_order_reconcile_at: encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
  mintsoft_order_delta_generation: '0',
  // Acme's OWN watermark, an hour old. Its window therefore starts one overlap (15 min) before it,
  // which is a deterministic instant — so the cursor string this sweep must send is known exactly.
  [`${ACME_WMS_ID}_order_delta_since`]: encodeWmsDeltaCursor(0, ACME_WATERMARK_AT.toISOString()),
  [`${ACME_WMS_ID}_order_delta_generation`]: '0',
  // NOTE WHAT IS NOT SEEDED: `acme-wms_api_timezone`. That row is absent on every fresh install,
  // and its absence is the whole finding — the zone must come from the CONNECTOR, not from a
  // default written for somebody else's warehouse.
})
mock.module('@/lib/db', { namedExports: { db: settings.client, prisma: settings.client } })

/**
 * The SETTINGS READ is a database read, and it is the second process boundary this file has to
 * stand in for.
 *
 * It is mocked rather than left real because `lib/settings-store.ts` is already loaded — the static
 * import of `./helpers/fictitious-wms-connector.ts` at the top of this file pulls the registry in,
 * which pulls the settings store in, which binds the REAL Prisma client before any `mock.module`
 * here has run. The `db` mock therefore reaches every module imported dynamically below, but not
 * that one.
 *
 * WHAT IS STILL UNDER TEST: the KEY. This reads the same in-memory row map the production cursor
 * deps read, so a wrapper that asked for another connector's `_api_timezone` row — or for a row
 * nobody namespaced — gets exactly what the database would have given it: the wrong value, or
 * nothing.
 */
mock.module('@/lib/settings-store', {
  namedExports: {
    ...realSettingsStore,
    getSettingValue: async (key: string) => settings.rows.get(key) ?? null,
  },
})

/** The window this sweep must ask for: Acme's watermark less the 900s default overlap. */
const EXPECTED_SINCE_AT = new Date(ACME_WATERMARK_AT.getTime() - 900 * 1000)

test('seam/production: the sweep formats the delta cursor in THE CONNECTOR’S zone, not the shipped connector’s', async () => {
  const { createPrismaDispatchDeps, runWmsDispatchSweep } = await import('../lib/domain/wms/dispatch-sweep.ts')

  deltaLog.calls.length = 0
  const applied: string[] = []
  // The THREE delta members are the production ones, built by the production factory for this
  // connector id; the rest of the port is in-memory so the sweep has candidates to work on without
  // a database. Everything this test asserts about — the cursor rows, the generation chain, the
  // zone — is on the production path.
  const prismaDeps = createPrismaDispatchDeps(ACME_WMS_ID as never, acmeDeltaConnector as never)
  const result = await runWmsDispatchSweep('seam-test', {
    deps: {
      listCandidates: async () => [{ linkId: 'L1', orderId: 'O1', externalOrderNumber: 'SO-BACKLOG', externalOrderId: 'ACME-1' }],
      fetchOrderStatus: async () => null,
      applyDispatch: async (orderId: string) => { applied.push(orderId); return { success: true } },
      partsSupported: false,
      fetchOrderParts: async () => [],
      fetchPartItems: async () => [],
      pushPartialShipment: async () => ({ ok: true }),
      repointLink: async () => {},
      recordDispatchError: async () => ({ deadLettered: false }),
      clearDispatchFailures: async () => {},
      countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
      fetchDelta: prismaDeps.fetchDelta,
      getDeltaState: prismaDeps.getDeltaState,
      saveDeltaState: prismaDeps.saveDeltaState,
    } as never,
  })

  assert.equal(deltaLog.calls.length, 1, `the delta ran (sweep status ${result.status ?? 'n/a'})`)
  // THE CURSOR ITSELF. A wall clock in Acme's zone, which differs from the shipped connector's by
  // hours — so this equality fails outright if any cross-connector default survives.
  assert.equal(
    deltaLog.calls[0],
    acmeWallClock(EXPECTED_SINCE_AT),
    `the cursor must be a wall clock in ${ACME_DELTA_TIME_ZONE} — the zone Acme itself declares. `
    + 'A cursor formatted in another warehouse’s zone is not an error the warehouse reports; it '
    + 'silently starts the window hours late.',
  )
  // AND THE CONSEQUENCE, which is the part an operator would ever see: an order that changed
  // inside Acme's real window was despatched rather than skipped.
  assert.deepEqual(applied, ['O1'], 'the backlogged order was inside the window and was despatched')
  assert.equal(result.dispatched, 1)

  // The cursor Acme wrote is its own, and the shipped connector's is untouched.
  assert.ok(settings.rows.has(`${ACME_WMS_ID}_order_delta_since`), 'Acme holds its own watermark row')
  assert.equal(
    settings.rows.get('mintsoft_order_delta_since'),
    encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
    'and the shipped connector’s watermark was not advanced by a sweep of a different warehouse',
  )
})

test('seam/production: the connector’s OWN timezone setting row still overrides its declared zone', async () => {
  // The override is per-connector and additive, not a way back to a shared default: a tenant whose
  // warehouse is configured differently sets ITS row, and nobody else's behaviour moves.
  const { createPrismaDispatchDeps, runWmsDispatchSweep } = await import('../lib/domain/wms/dispatch-sweep.ts')
  settings.rows.set(`${ACME_WMS_ID}_api_timezone`, 'UTC')
  // Rewind Acme's watermark: the previous test advanced it on its clean pass, which is the correct
  // behaviour and would otherwise make the window this test asserts on depend on test order.
  settings.rows.set(`${ACME_WMS_ID}_order_delta_since`, encodeWmsDeltaCursor(0, ACME_WATERMARK_AT.toISOString()))
  deltaLog.calls.length = 0
  try {
    const prismaDeps = createPrismaDispatchDeps(ACME_WMS_ID as never, acmeDeltaConnector as never)
    await runWmsDispatchSweep('seam-test', {
      deps: {
        listCandidates: async () => [],
        fetchOrderStatus: async () => null,
        applyDispatch: async () => ({ success: true }),
        partsSupported: false,
        fetchOrderParts: async () => [],
        fetchPartItems: async () => [],
        pushPartialShipment: async () => ({ ok: true }),
        repointLink: async () => {},
        recordDispatchError: async () => ({ deadLettered: false }),
        clearDispatchFailures: async () => {},
        countLinksByOrderNumber: async () => new Map(),
        fetchDelta: prismaDeps.fetchDelta,
        getDeltaState: prismaDeps.getDeltaState,
        saveDeltaState: prismaDeps.saveDeltaState,
      } as never,
    })
    assert.equal(deltaLog.calls.length, 1)
    const utcWallClock = EXPECTED_SINCE_AT.toISOString().slice(0, 19)
    assert.equal(deltaLog.calls[0], utcWallClock, 'the connector’s own row wins over its declared zone')
  } finally {
    settings.rows.delete(`${ACME_WMS_ID}_api_timezone`)
  }
})

test('seam/production: the connector’s delta ENABLE FLAG and TIMEZONE are its own keys', async () => {
  const { wmsDeltaSettingKeys } = await import('../lib/domain/wms/delta-cursor-generation.ts')
  const acme = wmsDeltaSettingKeys(ACME_WMS_ID)
  const mintsoft = wmsDeltaSettingKeys('mintsoft')
  assert.equal(mintsoft.enabled, 'mintsoft_inbound_delta_enabled', 'the shipped keys are unchanged')
  assert.equal(mintsoft.timeZone, 'mintsoft_api_timezone')
  assert.notEqual(acme.enabled, mintsoft.enabled)
  assert.notEqual(acme.timeZone, mintsoft.timeZone)
  assert.equal(acme.timeZone, `${ACME_WMS_ID}_api_timezone`)
})

// ---------------------------------------------------------------------------------------------
// The seam audit's own finding: capability degradation must be DERIVED, not asserted by the test
// ---------------------------------------------------------------------------------------------

test('seam/production: the PRODUCTION deps derive capability degradation from the connector itself', async () => {
  // tests/wms-second-connector-seam.test.ts asserts that the sweep CORE degrades when
  // `partsSupported` is false and `fetchDelta` is absent — but it sets both by hand, with a comment
  // saying so. That proves the core copes; it does not prove the production wiring ever reports the
  // degradation, and the wiring is where a `connector.fetchOrderParts ? … : …` could quietly become
  // an id comparison. So the derivation is checked HERE, on the real deps factory.
  const { createPrismaDispatchDeps } = await import('../lib/domain/wms/dispatch-sweep.ts')

  const plain = new AcmeWmsConnector(makeAcmeWarehouse())
  assert.equal(
    (plain as Partial<WmsConnector<typeof ACME_WMS_ID>>).fetchOrderParts,
    undefined,
    'precondition: this WMS cannot split-part',
  )
  const plainDeps = createPrismaDispatchDeps(ACME_WMS_ID as never, plain as never)
  assert.equal(plainDeps.partsSupported, false, 'derived from the ABSENT method, not from the id')
  assert.equal(plainDeps.fetchDelta, undefined, 'no bulk delta wired for a connector that has none')
  assert.equal(plainDeps.getDeltaState, undefined, 'and therefore no cursor state either')
  assert.equal(plainDeps.saveDeltaState, undefined)

  // The contrast: the SAME connector id, one capability added, and the wiring follows the method.
  const capable = Object.assign(new AcmeWmsConnector(makeAcmeWarehouse()), {
    fetchOrderParts: async () => [],
    fetchOrderDelta: async () => [],
  })
  const capableDeps = createPrismaDispatchDeps(ACME_WMS_ID as never, capable as never)
  assert.equal(capableDeps.partsSupported, true)
  assert.equal(typeof capableDeps.fetchDelta, 'function')
  assert.equal(typeof capableDeps.getDeltaState, 'function')
})
