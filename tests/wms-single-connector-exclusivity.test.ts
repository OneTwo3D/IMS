/**
 * ONE WMS CONNECTOR AT A TIME — AND NOBODY PICKS A WINNER
 * (o3d-remove-shiphero round 10, Codex HIGH 1).
 *
 * THE DEFECT ROUND 8 INTRODUCED. Making the Integration Plugins toggles registry-derived is what
 * made a SECOND WMS switch exist. Nothing added the rule that only one may be on: neither writer
 * rejected it, and every production routing site resolved the active connector with
 * `WMS_CONNECTOR_IDS.find((id) => state[id])` — first enabled wins, silently. So an operator could
 * enable a second warehouse beside Mintsoft, be told the save succeeded (it did), and then watch
 * every order push, every dispatch reconciliation and every sweep keep going to Mintsoft. The
 * operator is told the thing they asked for happened. It did not.
 *
 * THE FIX HAS TWO HALVES AND THIS FILE DRIVES BOTH THROUGH PRODUCTION CODE.
 *
 *   1. UNWRITABLE. `findIntegrationPluginExclusivityConflict` puts the WMS ids in a DERIVED
 *      exclusivity group (spread from `WMS_CONNECTOR_IDS`, so a connector joins it the day it is
 *      registered), and both plugin-state writers evaluate it under the connector-selection lock
 *      against the state their write RESULTS in — which is what makes the two-partial-writes race
 *      unable to assemble the state either call would have been refused for.
 *
 *   2. NOT GUESSED. "This app cannot write it" is not "it cannot exist": a restore, or a direct
 *      `UPDATE setting`, still can. So the readers resolve three ways and `ambiguous` routes
 *      NOWHERE — with its own reason, never reported as "no WMS connector is enabled" while two
 *      switches are visibly on. The routing cases below put the rows in the store BEHIND the
 *      writers' backs, exactly as a restore would, and then call production entrypoints.
 *
 * WHAT IS MOCKED: the id list (the one thing registering a connector changes), the settings rows,
 * the session, and Prisma. The writers, the lock ordering, the exclusivity rule, the resolver and
 * every entrypoint below are the shipped code.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ACME_WMS_ID } from './helpers/fictitious-wms-connector.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'

const ACME_SETTING_KEY = `plugin_${ACME_WMS_ID}_enabled`
const MINTSOFT_SETTING_KEY = 'plugin_mintsoft_enabled'
const ALL_KEYS = [
  'plugin_woocommerce_enabled',
  'plugin_shopify_enabled',
  'plugin_xero_enabled',
  'plugin_quickbooks_enabled',
  MINTSOFT_SETTING_KEY,
  ACME_SETTING_KEY,
]

// The ONE thing a second registered connector changes about the shipped build.
mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    ...realTypes,
    WMS_CONNECTOR_IDS: ['mintsoft', ACME_WMS_ID],
    isWmsConnectorId: (value: string | null | undefined) => value === 'mintsoft' || value === ACME_WMS_ID,
  },
})

// --- the settings rows, serialized the way the selection lock serializes writers ----------------

const store = new Map<string, string>()
/** Every settings key written, in commit order — so a refusal can be shown to have written NOTHING. */
const writes: string[] = []
/** Every bulk write against WmsOrderDiscrepancy — see the reconcile-sweep case. */
const discrepancyRetirements: string[] = []

const setting = {
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } }) => {
    const keys = where?.key?.in ?? [...store.keys()]
    return keys.filter((key) => store.has(key)).map((key) => ({ key, value: store.get(key)! }))
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null),
  findFirst: async () => null,
  upsert: async ({ where, create, update }: {
    where: { key: string }; create: { key: string; value: string }; update: { value: string }
  }) => {
    const value = store.has(where.key) ? update.value : create.value
    store.set(where.key, value)
    writes.push(`${where.key}=${value}`)
    return { key: where.key, value }
  },
}

const txClient = {
  setting,
  $executeRaw: async (strings: TemplateStringsArray) => {
    if (/INSERT INTO settings/i.test(strings.raw.join(''))) {
      for (const key of ALL_KEYS) if (!store.has(key)) store.set(key, 'false')
    }
    return 1
  },
  $queryRaw: async () => [...store.entries()]
    .filter(([key]) => ALL_KEYS.includes(key))
    .map(([key, value]) => ({ key, value })),
}

let txChain: Promise<unknown> = Promise.resolve()
const dbDouble = {
  setting,
  salesOrder: { findMany: async () => [], findFirst: async () => null },
  shoppingOrderLink: { findUnique: async () => null },
  wmsOrderDiscrepancy: {
    // Counted, because the reconcile sweep's NO-CONNECTOR arm retires every open finding and the
    // ambiguous arm must not.
    updateMany: async () => { discrepancyRetirements.push('updateMany'); return { count: 0 } },
    findFirst: async () => null,
  },
  $transaction: (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as unknown[])
    const run = txChain.then(() => (arg as (tx: typeof txClient) => Promise<unknown>)(txClient))
    txChain = run.then(() => undefined, () => undefined)
    return run
  },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

// The pooled settings READ. `lib/integration-plugins` is left REAL, so the routing cases below
// resolve the enabled set through the same reader production uses.
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => store.get(key) ?? null,
    getSettingValues: async (wanted: string[]) =>
      new Map(wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)!])),
    setSetting: async () => {},
    serializeSettingValue: (_key: string, value: string) => value,
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/crontab-reconcile', {
  namedExports: {
    reconcileCrontab: async () => ({ success: true }),
    readOwnCrontabResult: async () => ({ resolved: true, text: '', present: false }),
  },
})

function reset() {
  store.clear()
  writes.length = 0
  discrepancyRetirements.length = 0
}
test.beforeEach(reset)

/**
 * `tsc` sees the SHIPPED id union — `acme-wms` is not in it, because this build does not ship it.
 * The widened list exists only at runtime, under the `mock.module` above, so the comparison is
 * written through `string`. The same allowance every seam file makes for the fictitious connector.
 */
const isAcme = (id: string) => id === ACME_WMS_ID

/** Put rows in the store without going through a writer — what a restore or a hand-edit leaves. */
function forceStoredState(enabled: string[]) {
  for (const key of ALL_KEYS) store.set(key, 'false')
  for (const id of enabled) store.set(`plugin_${id}_enabled`, 'true')
  writes.length = 0
}

// ---------------------------------------------------------------------------------------------
// 1. UNWRITABLE — through both writers, and across the race between them
// ---------------------------------------------------------------------------------------------

test('[round 10 HIGH 1] the Settings writer refuses a second WMS connector, and stores nothing', async () => {
  const { saveIntegrationPluginState } = await import('../app/actions/settings.ts')

  // Mintsoft on, the ordinary shipped state.
  const first = await saveIntegrationPluginState({ mintsoft: true })
  assert.equal(first.status, 'saved', JSON.stringify(first))
  assert.equal(store.get(MINTSOFT_SETTING_KEY), 'true')
  writes.length = 0

  // THE DEFECT: before the fix this returned `saved`, wrote the row, and changed nothing about
  // where orders go — every routing site kept resolving Mintsoft, because it is first.
  const second = await saveIntegrationPluginState({ [ACME_WMS_ID]: true } as never)
  assert.equal(second.status, 'refused', JSON.stringify(second))
  assert.match((second as { error: string }).error, /one WMS connector at a time/i)
  assert.deepEqual(writes, [], 'a refusal commits nothing — the transaction returns before the upserts')
  assert.equal(store.get(ACME_SETTING_KEY), 'false')
  assert.equal(store.get(MINTSOFT_SETTING_KEY), 'true', 'and the connector that WAS enabled is untouched')
})

test('[round 10 HIGH 1] two concurrent PARTIAL writes cannot assemble a two-WMS state between them', async () => {
  // The race the under-lock evaluation exists for, and the reason the rule is not a payload check:
  // each call names only its own connector, so each payload is innocent. It is the RESULTING state,
  // read through the transaction after the lock, that is refused.
  const { saveIntegrationPluginState } = await import('../app/actions/settings.ts')

  const [a, b] = await Promise.all([
    saveIntegrationPluginState({ mintsoft: true }),
    saveIntegrationPluginState({ [ACME_WMS_ID]: true } as never),
  ])

  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, ['refused', 'saved'], 'exactly one wins; the other is refused, not merged')
  assert.equal(
    [store.get(MINTSOFT_SETTING_KEY), store.get(ACME_SETTING_KEY)].filter((v) => v === 'true').length, 1,
    'and the stored rows never hold two enabled WMS connectors',
  )
})

test('[round 10 HIGH 1] the onboarding wizard refuses the same selection', async () => {
  const keys = await import('../lib/integration-plugin-keys.ts')
  const { saveOnboardingPluginState } = await import('../app/actions/onboarding.ts')

  const both = keys.buildIntegrationPluginState((id) => id === 'mintsoft' || isAcme(id))
  const result = await saveOnboardingPluginState(both)

  assert.equal(result.status, 'refused', JSON.stringify(result))
  assert.match((result as { error: string }).error, /one WMS connector at a time/i)
  assert.deepEqual(writes, [], 'and the wizard commits nothing either')
})

test('[round 10 HIGH 1] enabling exactly one WMS connector is still permitted', async () => {
  // The negative without which every case above would also pass on a writer that refused
  // everything — which would be a different, louder bug.
  const keys = await import('../lib/integration-plugin-keys.ts')
  const { saveOnboardingPluginState } = await import('../app/actions/onboarding.ts')

  const acmeOnly = keys.buildIntegrationPluginState((id) => isAcme(id))
  assert.equal((await saveOnboardingPluginState(acmeOnly)).status, 'saved')
  assert.equal(store.get(ACME_SETTING_KEY), 'true')
  assert.equal(store.get(MINTSOFT_SETTING_KEY), 'false')
})

test('[round 10 HIGH 1] the WMS group is DERIVED, not a third hand-written pair', async () => {
  const keys = await import('../lib/integration-plugin-keys.ts')
  const wms = keys.INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS.find((group) => group.label === 'wms')
  assert.ok(wms, 'there is a WMS exclusivity group')
  assert.deepEqual(
    [...wms.ids].sort(), ['mintsoft', ACME_WMS_ID].sort(),
    'and it contains every REGISTERED connector — spread from WMS_CONNECTOR_IDS, so a newly'
    + ' registered connector is under the rule without anyone editing this table',
  )
})

// ---------------------------------------------------------------------------------------------
// 2. NOT GUESSED — production entrypoints, against a state written behind the writers' backs
// ---------------------------------------------------------------------------------------------

test('[round 10 HIGH 1] a two-WMS state resolves to NOTHING, not to the first registered connector', async () => {
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const active = await import('../lib/connectors/wms/active-connector.ts')

  assert.equal(
    await active.getEnabledWmsConnectorId(), null,
    'the enabled resolver refuses to choose between two enabled connectors',
  )
  assert.equal(
    await active.getActiveWmsConnectorId(), null,
    'and the FALLBACK resolver does not fall back either — "ambiguous" is not "none", and resolving'
    + ' it to the first registered connector is exactly the silent winner-picking being removed',
  )
})

test('[round 10 HIGH 1] with ONE enabled, the same resolvers still answer — the rule is not a blanket refusal', async () => {
  forceStoredState([ACME_WMS_ID])
  const active = await import('../lib/connectors/wms/active-connector.ts')
  assert.equal(await active.getEnabledWmsConnectorId(), ACME_WMS_ID)
  assert.equal(await active.getActiveWmsConnectorId(), ACME_WMS_ID)

  // And with none enabled the legacy fallback is intact — a property this change must not break.
  forceStoredState([])
  assert.equal(await active.getEnabledWmsConnectorId(), null)
  assert.equal(await active.getActiveWmsConnectorId(), 'mintsoft', 'the legacy fallback still applies to NONE')
})

test('[round 10 HIGH 1] a sweep SKIPS with the ambiguity as its reason, instead of sweeping Mintsoft', async () => {
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const { runWmsOrderStatusSweep } = await import('../lib/domain/wms/order-status-sweep.ts')

  const result = await runWmsOrderStatusSweep()

  assert.equal(result.scanned, 0, 'nothing was swept')
  assert.match(
    String(result.skipped), /More than one WMS connector is enabled/,
    'and the reason names the real fault. Reporting "No WMS connector enabled" here would send an'
    + ' operator looking for a switch to turn ON while two are already on',
  )
  assert.match(String(result.skipped), /mintsoft/, 'naming the connectors that are fighting')
  assert.match(String(result.skipped), new RegExp(ACME_WMS_ID))
})

test('[round 10 HIGH 1] the /sync WMS facade claims no panel for a connector it cannot name', async () => {
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const { getWmsSyncDashboardData } = await import('../app/actions/wms-sync.ts')
  assert.equal(
    await getWmsSyncDashboardData(), null,
    'the facade must not render one connector’s panel while another is equally enabled',
  )
})

test('[round 10 HIGH 1] the reconcile sweep SKIPS on ambiguity and RETIRES NOTHING', async () => {
  // THE CASE WHERE FOLDING `ambiguous` INTO `none` WOULD BE DESTRUCTIVE, which is why the resolution
  // is three-way and not a nullable id. The no-connector arm of this sweep marks EVERY open
  // discrepancy RESOLVED, reasoning that nothing can ever re-verify them. That reasoning is false
  // when two connectors are enabled: the findings belong to a connector that IS on, and they become
  // actionable again the moment the selection is corrected. Closing them would discard real
  // discrepancies over a settings mistake, and nothing reopens them.
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const { runWmsOrderReconcileSweep } = await import('../lib/domain/wms/order-reconcile-sweep.ts')

  const result = await runWmsOrderReconcileSweep('test')

  assert.equal(result.status, 'SKIPPED')
  assert.match(String(result.skippedReason), /More than one WMS connector is enabled/)
  assert.deepEqual(
    discrepancyRetirements, [],
    'and NOT ONE open finding was retired — the destructive arm belongs to "no connector", not to'
    + ' "cannot tell which connector"',
  )
})

test('[round 10 HIGH 1] with NO connector the same sweep still retires — the arm above is not dead code', async () => {
  // The contrast that makes the case above a test of a BRANCH rather than of a sweep that never
  // writes. Without it, an implementation that simply removed the retirement would pass.
  forceStoredState([])
  const { runWmsOrderReconcileSweep } = await import('../lib/domain/wms/order-reconcile-sweep.ts')

  const result = await runWmsOrderReconcileSweep('test')

  assert.equal(result.status, 'SKIPPED')
  assert.equal(result.skippedReason, 'No WMS connector enabled')
  assert.deepEqual(discrepancyRetirements, ['updateMany'], 'the no-connector arm still retires')
})

test('[round 10 HIGH 1] the order-push sweep declines with the ambiguity as its reason too', async () => {
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const { runWmsOrderPushSweep } = await import('../lib/domain/wms/order-push-sweep.ts')

  const result = await runWmsOrderPushSweep()

  assert.equal(result.created, 0)
  assert.match(String(result.skipped), /More than one WMS connector is enabled/)
})

test('[round 10 HIGH 1] the ASN facade refuses with the CONTRADICTION, not with "no WMS is enabled"', async () => {
  // `resolveActiveWmsConnector` falls back to the first registered connector when NOTHING is
  // enabled, so this facade's "nothing resolved" arm is now reached (in practice) only by a
  // contradictory selection. Answering it with "No WMS connector is enabled." would print the one
  // sentence that is certainly false in the only state that gets there — and an operator looking at
  // two enabled switches cannot act on it.
  forceStoredState(['mintsoft', ACME_WMS_ID])
  const actions = await import('../app/actions/wms-asn.ts')

  const result = await actions.createWmsPurchaseOrderAsn('po-1', {})

  assert.equal(result.success, false)
  assert.doesNotMatch(String(result.error), /No WMS connector is enabled/)
  assert.match(String(result.error), /More than one WMS connector is enabled/)
  assert.match(String(result.error), /Integration Plugins/, 'and it names where the remedy is')
})
