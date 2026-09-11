/**
 * THE SECOND-CONNECTOR SEAM, DRIVEN THROUGH THE TWO SCREENS THAT TURN A CONNECTOR ON
 * (o3d-m0ad / o3d-remove-shiphero round 8, Codex HIGH 2).
 *
 * WHY THIS FILE EXISTS SEPARATELY AGAIN. The other two seam files prove that a registered
 * connector is DISPATCHED to and RENDERED. Round 7's finding was that both of those are downstream
 * of a step neither of them performs: somebody has to switch the plugin ON, and the enable state
 * has to be stored. `saveOnboardingPluginState` took a five-member object literal, overwrote five
 * named members and upserted five named keys — and `IntegrationPluginState` is structurally
 * assignable to that literal, so passing the whole state COMPILED and the sixth id was silently
 * dropped and handed back at whatever value the database already held. The Settings screen had a
 * hard-written switch per plugin and two `as IntegrationPluginState` casts that suppressed the
 * missing-member errors. Net effect: a connector could satisfy every totality check the previous
 * round added and still be impossible to enable through either production UI.
 *
 * That is the fifth consecutive round in which a seam proved a property one layer short of where
 * production decides — so this file starts at the SWITCH and ends at the STORED ROW.
 *
 * WHAT IS MOCKED. The id list (the one thing registering a connector changes), the registry's
 * labels, the session, and the database — a real serialized in-memory settings store, so the
 * locked transaction the writer opens behaves as it does in production. The plugin key derivation,
 * the catalogue, the Settings component and the wizard's writer are the shipped code, unmodified.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ACME_WMS_ID, ACME_WMS_LABEL } from './helpers/fictitious-wms-connector.ts'
import { mountClientComponent } from './fixtures/render-client-component.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'
import * as realRegistry from '../lib/connectors/wms/registry.ts'
import * as realSettingsStore from '../lib/settings-store.ts'

/** The setting key the derived map must mint for a registered connector, spelled independently. */
const ACME_SETTING_KEY = `plugin_${ACME_WMS_ID}_enabled`

const SHIPPED_KEYS = [
  'plugin_woocommerce_enabled',
  'plugin_shopify_enabled',
  'plugin_xero_enabled',
  'plugin_quickbooks_enabled',
  'plugin_mintsoft_enabled',
]
const ALL_KEYS = [...SHIPPED_KEYS, ACME_SETTING_KEY]

// The ONE thing a second connector's existence changes about the shipped build.
mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    ...realTypes,
    WMS_CONNECTOR_IDS: ['mintsoft', ACME_WMS_ID],
    isWmsConnectorId: (value: string | null | undefined) => value === 'mintsoft' || value === ACME_WMS_ID,
  },
})

// The registry, for the catalogue's label lookup. `create` is never called here.
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    ...realRegistry,
    wmsConnectorRegistry: {
      ...realRegistry.wmsConnectorRegistry,
      findDef: (id: string) => (id === ACME_WMS_ID
        ? { id, label: ACME_WMS_LABEL, available: true, createReplayPolicy: 'remote-refuses-duplicate', create: () => { throw new Error('not used') } }
        : realRegistry.wmsConnectorRegistry.findDef(id)),
    },
  },
})

// --- the database, serialized the way the selection lock serializes writers ---------------------

const store = new Map<string, string>()
/** Every settings key written, in commit order. */
const writes: string[] = []
/** Payloads the Settings screen sent to its server action. */
const settingsSaves: unknown[] = []

const setting = {
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } }) => {
    const keys = where?.key?.in ?? [...store.keys()]
    return keys.filter((key) => store.has(key)).map((key) => ({ key, value: store.get(key)! }))
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null),
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
    // Model the materialising INSERT: rows that do not exist appear at their default.
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
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting,
      $transaction: (arg: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as unknown[])
        const run = txChain.then(() => (arg as (tx: typeof txClient) => Promise<unknown>)(txClient))
        txChain = run.then(() => undefined, () => undefined)
        return run
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
// The pooled settings READ, so the round-trip assertion below reads back what the writer stored
// rather than reaching a database. Installed HERE, at module scope: `mock.module` binds when the
// importer is first evaluated, and lib/integration-plugins is pulled in by the writer's own import
// graph long before any test body runs.
mock.module('@/lib/settings-store', {
  namedExports: {
    ...realSettingsStore,
    getSettingValues: async (wanted: string[]) =>
      new Map(wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)!])),
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
// The Settings screen's own server action. Captured rather than executed: this case is about what
// the SCREEN sends, and the case above it is about what the writer stores.
mock.module('@/app/actions/settings', {
  namedExports: {
    saveIntegrationPluginState: async (payload: unknown) => {
      settingsSaves.push(payload)
      return { status: 'saved' }
    },
  },
})

/**
 * `tsc` sees the SHIPPED id union — `acme-wms` is not in it, because this build does not ship it.
 * The widened list exists only at runtime, under the `mock.module` above, so the comparison is
 * written through `string`. That is the one place this file leaves the type system behind, and it
 * is the same allowance every seam file makes for the fictitious connector.
 */
const isAcme = (id: string) => id === ACME_WMS_ID

function reset() {
  store.clear()
  writes.length = 0
  settingsSaves.length = 0
}
test.beforeEach(reset)

// ---------------------------------------------------------------------------------------------
// The derivation itself: a registered connector IS an integration plugin.
// ---------------------------------------------------------------------------------------------

test('seam/plugin-state: a registered WMS connector gets an id, a setting key and a lock row', async () => {
  const keys = await import('../lib/integration-plugin-keys.ts')

  assert.ok(
    keys.INTEGRATION_PLUGIN_IDS.includes(ACME_WMS_ID as never),
    'the plugin id union is derived from the WMS registry, so registering a connector enrols it',
  )
  assert.equal(
    (keys.INTEGRATION_PLUGIN_SETTING_KEYS as Record<string, string>)[ACME_WMS_ID], ACME_SETTING_KEY,
    'and it gets a setting key by the same rule as every other plugin, not by somebody adding one',
  )
  assert.ok(
    keys.INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER.includes(ACME_SETTING_KEY),
    'and its row is inside the selection lock — a row outside it is a row a concurrent writer can move',
  )
  assert.equal(keys.INTEGRATION_PLUGIN_IDS.length, 6)
})

// ---------------------------------------------------------------------------------------------
// The wizard's writer: the enable state ROUND-TRIPS.
// ---------------------------------------------------------------------------------------------

test('seam/plugin-state: the onboarding writer STORES a second connector’s enable flag and reads it back', async () => {
  const keys = await import('../lib/integration-plugin-keys.ts')
  const { saveOnboardingPluginState } = await import('../app/actions/onboarding.ts')

  const requested = keys.buildIntegrationPluginState((id) => isAcme(id))
  const result = await saveOnboardingPluginState(requested)
  assert.equal(result.status, 'saved', JSON.stringify(result))

  // THE ROW. Before the fix the upsert loop named five keys, so this one was never written at all
  // and the action still reported success.
  assert.equal(
    store.get(ACME_SETTING_KEY), 'true',
    'the registered connector’s own row was written — the loop walks the registry, not a tuple',
  )
  assert.equal(
    writes.filter((w) => w.startsWith(ACME_SETTING_KEY)).length, 1,
    'exactly once, inside the one locked transaction',
  )
  assert.deepEqual(
    [...store.keys()].sort(), [...ALL_KEYS].sort(),
    'and every registered plugin got a row, none of them skipped',
  )

  // THE READ BACK, through the production reader rather than by inspecting the double: an enable
  // that stores but does not resolve is the same hole one step over.
  const plugins = await import('../lib/integration-plugins.ts')
  const readBack = await plugins.getIntegrationPluginState()
  assert.equal(
    (readBack as Record<string, boolean>)[ACME_WMS_ID], true,
    'and `getIntegrationPluginState` resolves it — which is what every WMS enable gate reads',
  )
  assert.equal(readBack.mintsoft, false, 'while the shipped connector stays off, so this is not a blanket true')
})

test('seam/plugin-state: turning a second connector back OFF is stored too', async () => {
  // The negative that keeps the case above honest: a writer that hard-wrote `true` for an unknown
  // key would pass everything up to here.
  const keys = await import('../lib/integration-plugin-keys.ts')
  const { saveOnboardingPluginState } = await import('../app/actions/onboarding.ts')

  await saveOnboardingPluginState(keys.buildIntegrationPluginState((id) => isAcme(id)))
  assert.equal(store.get(ACME_SETTING_KEY), 'true')
  await saveOnboardingPluginState(keys.buildIntegrationPluginState(() => false))
  assert.equal(store.get(ACME_SETTING_KEY), 'false')
})

// ---------------------------------------------------------------------------------------------
// The Settings screen: there IS a switch, and pressing Save sends what it says.
// ---------------------------------------------------------------------------------------------

type SwitchProps = { checked: boolean; onCheckedChange: (value: boolean) => void }

/** Every Switch in a render, in order, with its label — the component renders one per plugin. */
function switchesIn(tree: unknown): Array<SwitchProps & { label: string }> {
  const found: Array<SwitchProps & { label: string }> = []
  const walk = (node: unknown, label: string) => {
    if (Array.isArray(node)) { node.forEach((child) => walk(child, label)); return }
    if (!node || typeof node !== 'object') return
    const element = node as { key?: string | null; props?: Record<string, unknown> }
    const nextLabel = element.key ? String(element.key) : label
    if (element.props && typeof element.props.checked === 'boolean' && 'onCheckedChange' in element.props) {
      found.push({
        checked: element.props.checked as boolean,
        onCheckedChange: element.props.onCheckedChange as (value: boolean) => void,
        label: nextLabel,
      })
    }
    if (element.props && 'children' in element.props) walk(element.props.children, nextLabel)
  }
  walk(tree, '')
  return found
}

async function mountSettings(enabledIds: string[] = []) {
  const keys = await import('../lib/integration-plugin-keys.ts')
  const { listIntegrationPluginDescriptors } = await import('../lib/domain/integrations/plugin-catalog.ts')
  const { IntegrationPluginsSettings } = await import('../components/settings/integration-plugins-settings.tsx')
  const state = keys.buildIntegrationPluginState((id) => enabledIds.includes(id))
  return {
    keys,
    mounted: mountClientComponent(
      IntegrationPluginsSettings as unknown as (props: { plugins: unknown[] }) => unknown,
      { plugins: listIntegrationPluginDescriptors(state) as unknown[] },
    ),
  }
}

test('seam/plugin-state: the Settings screen renders a switch for a registered connector, named from the registry', async () => {
  const { mounted } = await mountSettings()
  const { tree, html } = mounted.render()
  const switches = switchesIn(tree)

  assert.equal(
    switches.length, 6,
    'one switch per REGISTERED plugin — the screen used to hard-write five, so a sixth had no control at all',
  )
  assert.ok(switches.some((s) => s.label === ACME_WMS_ID), 'including one keyed by the registered connector’s id')
  assert.match(
    html, new RegExp(`${ACME_WMS_LABEL} plugin`),
    'labelled from the connector’s own registration, so no screen spells a warehouse’s name itself',
  )
})

test('seam/plugin-state: toggling that switch and pressing Save SENDS the connector’s value', async () => {
  const { mounted } = await mountSettings()
  const acmeSwitch = switchesIn(mounted.render().tree).find((s) => s.label === ACME_WMS_ID)
  assert.ok(acmeSwitch, 'the switch exists')
  assert.equal(acmeSwitch.checked, false, 'and starts from the server-rendered value')

  acmeSwitch.onCheckedChange(true)
  const rendered = mounted.render()
  assert.equal(
    switchesIn(rendered.tree).find((s) => s.label === ACME_WMS_ID)!.checked, true,
    'the switch moves — a control wired to nothing would still be false here',
  )

  const save = rendered.controls.find((control) => /Save/i.test(control.label))
  await mounted.click(save)

  assert.equal(settingsSaves.length, 1)
  const payload = settingsSaves[0] as Record<string, boolean>
  assert.equal(
    payload[ACME_WMS_ID], true,
    'and the payload carries it — it used to name five members, so a switch could move and send nothing',
  )
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['acme-wms', 'mintsoft', 'quickbooks', 'shopify', 'woocommerce', 'xero'],
    'the WHOLE selection is sent, over every registered plugin',
  )
})

test('seam/plugin-state: the shipped connector’s switch still works and is told apart from the new one', async () => {
  // The negative: a screen that reported every switch as the same plugin would pass the case above.
  const { mounted } = await mountSettings(['mintsoft'])
  const switches = switchesIn(mounted.render().tree)
  assert.equal(switches.find((s) => s.label === 'mintsoft')!.checked, true)
  assert.equal(switches.find((s) => s.label === ACME_WMS_ID)!.checked, false)

  switches.find((s) => s.label === 'mintsoft')!.onCheckedChange(false)
  const rendered = mounted.render()
  await mounted.click(rendered.controls.find((control) => /Save/i.test(control.label)))
  const payload = settingsSaves[0] as Record<string, boolean>
  assert.equal(payload.mintsoft, false)
  assert.equal(payload[ACME_WMS_ID], false)
})
