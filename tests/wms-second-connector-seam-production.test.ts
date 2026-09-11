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
  ACME_WMS_ID,
  ACME_WMS_LABEL,
  AcmeWmsConnector,
  acmeAsnActions,
  acmeWmsConnectorDef,
  makeAcmeWarehouse,
  type AcmeAsnLog,
} from './helpers/fictitious-wms-connector.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'
import * as realPlugins from '../lib/integration-plugins.ts'
import * as realRegistry from '../lib/connectors/wms/registry.ts'
import { createWmsConnectorRegistry, type WmsConnectorDef } from '../lib/connectors/wms/registry.ts'
import type { WmsConnectorHooks } from '../lib/connectors/wms/connector-hooks.ts'
import type { WmsConnector, WmsOrderStatus } from '../lib/connectors/wms/types.ts'
import { encodeWmsDeltaCursor } from '../lib/domain/wms/delta-cursor-generation.ts'

// --- the fictitious connector, as far as the app is concerned ---------------------------------

const asnLog: AcmeAsnLog = { asnCalls: [] }
const acmeWarehouse = makeAcmeWarehouse()
const acmeConnector = new AcmeWmsConnector(acmeWarehouse)

/** Acme's hooks: the ASN implementation, and nothing else. No delta scope, no precondition. */
const acmeHooks: WmsConnectorHooks = { asn: async () => acmeAsnActions(acmeConnector, asnLog) }

/** Which connector plugins are enabled. Mutated per test, read by the REAL getActiveWmsConnectorId. */
let pluginState: Record<string, boolean> = { [ACME_WMS_ID]: true }

// The id list the resolver walks. This is the ONE thing registering a second connector changes
// about the shipped build, and the real `getActiveWmsConnectorId` is then left to do its own work.
mock.module('@/lib/connectors/wms/types', {
  namedExports: { ...realTypes, WMS_CONNECTOR_IDS: ['mintsoft', ACME_WMS_ID] },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { ...realPlugins, getIntegrationPluginState: async () => pluginState },
})

const seamDefs: WmsConnectorDef<string>[] = [
  // Mintsoft's real definition, minus its hooks: these tests never dispatch to Mintsoft, and
  // leaving the hooks on would let a routing bug reach the real server actions (and the real
  // database) instead of failing the assertion.
  { ...(realRegistry.BUILT_IN_WMS_CONNECTORS[0] as WmsConnectorDef<string>), hooks: undefined },
  { ...(acmeWmsConnectorDef(acmeWarehouse) as unknown as WmsConnectorDef<string>), hooks: acmeHooks },
]
const seamRegistry = createWmsConnectorRegistry<string>(seamDefs)

mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    ...realRegistry,
    findWmsConnectorLabel: (id: string) => seamRegistry.findDef(id)?.label ?? null,
    getWmsConnectorHooks: (id: string) => seamRegistry.findDef(id)?.hooks ?? {},
  },
})

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
  seamDefs[1].hooks = {}
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
    seamDefs[1].hooks = previous
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
// HIGH 2 — a second connector's inbound delta cannot inherit Mintsoft's watermark
// ---------------------------------------------------------------------------------------------

const NOW = new Date('2026-09-01T12:00:00.000Z')
/** Two hours old: inside a 24h lookback, and OUTSIDE any window a fresh Mintsoft watermark allows. */
const ACME_BACKLOG_CHANGED_AT = new Date(NOW.getTime() - 2 * 60 * 60 * 1000)
/** One minute old. If Acme reads THIS, its window starts after its own backlog changed. */
const MINTSOFT_WATERMARK = new Date(NOW.getTime() - 60 * 1000).toISOString()

/** An in-memory `settings` table, driven through the production Prisma-shaped deps. */
type SettingsClient = {
  setting: {
    findMany(args: { where: { key: { in: string[] } } }): Promise<Array<{ key: string; value: string | null }>>
    upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<void>
    deleteMany(args: { where: { key: { in: string[] } } }): Promise<void>
  }
  $executeRaw(): Promise<number>
  $queryRaw(): Promise<unknown[]>
  $transaction<T>(fn: (tx: SettingsClient) => Promise<T>): Promise<T>
}

function settingsDouble(seed: Record<string, string>) {
  const rows = new Map<string, string>(Object.entries(seed))
  const client: SettingsClient = {
    setting: {
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
    async $executeRaw() { return 0 },
    async $queryRaw() { return [] },
    async $transaction<T>(fn: (tx: SettingsClient) => Promise<T>): Promise<T> { return fn(client) },
  }
  return { rows, client }
}

const settings = settingsDouble({
  // A LIVE Mintsoft installation: a recent watermark, stamped at its current generation.
  mintsoft_order_delta_since: encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
  mintsoft_order_reconcile_at: encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
  mintsoft_order_delta_generation: '0',
})
mock.module('@/lib/db', { namedExports: { db: settings.client, prisma: settings.client } })

test('seam/production: a second connector’s delta reads ITS OWN cursor, never Mintsoft’s', async () => {
  const { createPrismaDispatchDeps, runWmsDispatchSweepCore } = await import('../lib/domain/wms/dispatch-sweep.ts')

  // Acme, WITH a bulk delta — the capability that used to drag Mintsoft's cursor state in behind it.
  // It honours `sinceIso`, which is what makes this a test of the window and not of the plumbing:
  // a connector that returned everything regardless would pass with the wrong watermark.
  const deltaCalls: string[] = []
  const backlogRow: WmsOrderStatus = {
    externalOrderId: 'ACME-1', externalOrderNumber: 'SO-BACKLOG', status: 'DESPATCHED', statusLabel: 'DESPATCHED',
    isSplit: false, partCount: null, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null,
    tracking: [{ trackingNumber: 'ACME-TRACK-1', carrier: 'ACME-EXPRESS', despatchedAt: null }],
    dispatched: true, raw: null,
  }
  const acmeWithDelta = Object.assign(new AcmeWmsConnector(makeAcmeWarehouse()), {
    fetchOrderDelta: async (sinceIso: string) => {
      deltaCalls.push(sinceIso)
      return Date.parse(`${sinceIso}Z`) <= ACME_BACKLOG_CHANGED_AT.getTime() ? [backlogRow] : []
    },
  })

  // The PRODUCTION deps for this connector id. Everything the delta touches — the cursor rows, the
  // scope lock, the generation chain — is built here, which is exactly where the bug lived.
  const prismaDeps = createPrismaDispatchDeps(ACME_WMS_ID as never, acmeWithDelta as never)

  const applied: string[] = []
  const result = await runWmsDispatchSweepCore({
    listCandidates: async () => [{ linkId: 'L1', orderId: 'O1', externalOrderNumber: 'SO-BACKLOG', externalOrderId: 'ACME-1' }],
    fetchOrderStatus: async () => null,
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    partsSupported: false,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, 1])),
    // THE THREE UNDER TEST, taken verbatim from the production deps.
    fetchDelta: prismaDeps.fetchDelta,
    getDeltaState: prismaDeps.getDeltaState,
    saveDeltaState: prismaDeps.saveDeltaState,
  }, {
    now: NOW,
    deltaEnabled: true,
    deltaTimeZone: 'UTC',
    deltaLookbackSeconds: 24 * 60 * 60,
    deltaOverlapSeconds: 60,
  })

  assert.equal(deltaCalls.length, 1, 'the delta ran')
  assert.ok(
    Date.parse(`${deltaCalls[0]}Z`) <= ACME_BACKLOG_CHANGED_AT.getTime(),
    `Acme’s window must start from ITS OWN cold start (the lookback floor), not from Mintsoft’s `
    + `watermark ${MINTSOFT_WATERMARK}; it started at ${deltaCalls[0]}`,
  )
  assert.equal(result.deltaRowCount, 1, 'the backlog row was inside the window')
  assert.deepEqual(applied, ['O1'], 'and the backlogged order was actually despatched')

  // The cursor Acme WROTE is its own, and Mintsoft's is untouched. A shared row would show up as
  // either a missing acme key or a moved mintsoft one.
  assert.ok(settings.rows.has(`${ACME_WMS_ID}_order_delta_since`), 'Acme minted its own watermark row')
  assert.equal(
    settings.rows.get('mintsoft_order_delta_since'),
    encodeWmsDeltaCursor(0, MINTSOFT_WATERMARK),
    'and Mintsoft’s watermark was not advanced by a sweep of a different warehouse',
  )
})

test('seam/production: the connector’s delta ENABLE FLAG and TIMEZONE are its own keys', async () => {
  const { wmsDeltaSettingKeys } = await import('../lib/domain/wms/delta-cursor-generation.ts')
  const acme = wmsDeltaSettingKeys(ACME_WMS_ID)
  const mintsoft = wmsDeltaSettingKeys('mintsoft')
  assert.equal(mintsoft.enabled, 'mintsoft_inbound_delta_enabled', 'the shipped keys are unchanged')
  assert.equal(mintsoft.timeZone, 'mintsoft_api_timezone')
  assert.notEqual(acme.enabled, mintsoft.enabled)
  assert.notEqual(acme.timeZone, mintsoft.timeZone)
  // The timezone is the quiet one: the cursor is formatted as a wall-clock string in it, so
  // inheriting another warehouse's zone shifts the window by hours and loses whatever fell in the gap.
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
