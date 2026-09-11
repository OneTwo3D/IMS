/**
 * The integration plugin setting keys, and nothing else.
 *
 * Split out of lib/integration-plugins.ts so that code which must NOT drag Prisma in can still
 * name the same keys — specifically the full-chain quiesce harness (e2e/full-chain/harness),
 * which writes `plugin_xero_enabled` on the STAGE database over a raw `pg` client and now has to
 * take the same locks in the same order as the app (o3d-osl8 round 6, finding 2). A harness that
 * imported the app's settings store would pull the Prisma client into a script that deliberately
 * talks to two databases neither of which is the one Prisma is configured for.
 *
 * THE ONE IMPORT, AND WHY IT IS SAFE. `./connectors/wms/types` is itself an import-free module of
 * constants and types — it is where WMS_CONNECTOR_IDS lives. Importing it keeps this module
 * Prisma-free, which is the actual constraint. Do not add an import that reaches a client.
 *
 * RELATIVE, NOT `@/…`, and deliberately: the quiesce harness's whole import chain
 * (quiesce.ts → lib/db/advisory-locks.ts → lib/db/database-url-schema.mjs) is alias-free, because
 * it is loaded by scripts whose resolution of `@/…` depends on tsx finding this repo's tsconfig.
 * Adding the first alias dependency to that chain would make the lock inventory depend on a
 * resolver setting. (Module mocks are unaffected: `mock.module('@/lib/connectors/wms/types')`
 * resolves to the same file URL and still intercepts this import.)
 *
 * o3d-m0ad / o3d-remove-shiphero round 8 (Codex HIGH 2) — WHY THE WMS IDS ARE NOT SPELLED HERE.
 * This module used to enumerate five literal ids, one of which happened to be the shipped WMS
 * connector. A SECOND registered WMS connector was therefore not an integration plugin at all: it
 * had no id in the union, no setting key, no place in the state record and no row in the lock set —
 * so `saveOnboardingPluginState` dropped it silently and it could not be enabled through any
 * production screen. A connector that can be registered but never enabled is a seam that proves
 * nothing. The WMS half of the union is now DERIVED from the registry's id list, so registering a
 * connector gives it a key, a state member, a lock row and a toggle by construction.
 */
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from './connectors/wms/types'

/**
 * The plugins that are not WMS connectors: one shopping pair and one accounting pair, each
 * mutually exclusive. These are enumerated because there is no registry to derive them from —
 * unlike the WMS connectors, which have one.
 */
export const NON_WMS_INTEGRATION_PLUGIN_IDS = ['woocommerce', 'shopify', 'xero', 'quickbooks'] as const

export type NonWmsIntegrationPluginId = (typeof NON_WMS_INTEGRATION_PLUGIN_IDS)[number]

export type IntegrationPluginId = NonWmsIntegrationPluginId | WmsConnectorId

export const INTEGRATION_PLUGIN_IDS: readonly IntegrationPluginId[] = [
  ...NON_WMS_INTEGRATION_PLUGIN_IDS,
  ...WMS_CONNECTOR_IDS,
]

/** The setting key a plugin's enable flag lives in. One rule, applied to every id. */
export function integrationPluginSettingKey(id: IntegrationPluginId): string {
  return `plugin_${id}_enabled`
}

/**
 * id → setting key, for every registered plugin.
 *
 * TOTAL over the id union by construction (`Record`, not `Partial<Record>`), so a WMS connector
 * added to WMS_CONNECTOR_IDS gets a key without anyone remembering to add one, and an id the map
 * is missing is a `tsc` error at every read rather than an `undefined` key written to the database.
 */
export const INTEGRATION_PLUGIN_SETTING_KEYS: Record<IntegrationPluginId, string> =
  Object.fromEntries(
    INTEGRATION_PLUGIN_IDS.map((id) => [id, integrationPluginSettingKey(id)]),
  ) as Record<IntegrationPluginId, string>

export type IntegrationPluginState = Record<IntegrationPluginId, boolean>

/**
 * Every plugin key, sorted — THE canonical order these rows are locked in.
 *
 * ALL of them, not just the two accounting ones. Exclusivity spans WooCommerce/Shopify as well as
 * Xero/QuickBooks, so locking only the accounting pair would leave the commerce pair with exactly
 * the race the lock exists to close. One order for one lock set is also what stops two callers
 * taking the same rows in opposite orders and deadlocking.
 */
export const INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER: readonly string[] = INTEGRATION_PLUGIN_IDS
  .map((id) => INTEGRATION_PLUGIN_SETTING_KEYS[id])
  .slice()
  .sort()

/** `'true'` and nothing else. An absent row and `false` mean the same thing. */
export function parseIntegrationPluginEnabled(value: string | null | undefined): boolean {
  return value === 'true'
}

/**
 * A plugin-state record built from ONE answer per id, over the whole id union.
 *
 * The only constructor the app uses, because it is the only one that cannot omit an id: every
 * writer and reader of plugin state goes through it (or through `INTEGRATION_PLUGIN_IDS`) rather
 * than listing members, which is what let a sixth id be silently dropped.
 */
export function buildIntegrationPluginState(
  valueFor: (id: IntegrationPluginId) => boolean,
): IntegrationPluginState {
  return Object.fromEntries(
    INTEGRATION_PLUGIN_IDS.map((id) => [id, valueFor(id)]),
  ) as IntegrationPluginState
}
