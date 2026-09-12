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

/**
 * THE MUTUALLY EXCLUSIVE GROUPS — derived, so a registered WMS connector joins one by construction
 * (o3d-remove-shiphero round 10, Codex HIGH 1).
 *
 * WHAT WENT WRONG. Exclusivity used to be two hand-written `if` pairs inside each of the two
 * writers: `xero && quickbooks`, `woocommerce && shopify`. Round 8 made the settings toggles
 * registry-derived, which is what made a SECOND WMS switch exist — and nothing added a rule that
 * only one WMS may be on. Neither writer rejected it, so an operator could enable a second WMS
 * connector beside Mintsoft, be told it saved (it did), and then watch every push and every sweep
 * keep going to Mintsoft, because production routing resolved the active connector with
 * `WMS_CONNECTOR_IDS.find(...)` — first enabled wins. The operator is told the thing they asked for
 * happened. It did not.
 *
 * WHY A GROUP TABLE RATHER THAN A THIRD `if`. A third `if` is a rule about the two connectors
 * somebody remembered; this is a rule about the SHAPE of the id space. The WMS group is spread from
 * `WMS_CONNECTOR_IDS`, so registering a connector puts it under the rule without anyone editing a
 * writer — the same reason the id union, the setting-key map and the lock set are derived here
 * rather than listed.
 *
 * WHY EXCLUSIVITY AND NOT A PERSISTED `active_wms_connector` ROW. The reviewer offered both. An
 * explicit active row is a SECOND source of truth beside the per-connector `plugin_<id>_enabled`
 * rows that the module-visibility check, the onboarding readiness step, the /sync enable gate and
 * the settings switches all read — and two sources can disagree (`active=acme` while
 * `plugin_acme_enabled=false`). That is a new impossible-but-representable state, i.e. the very
 * defect class being removed, and removing it in turn would mean deriving every enable flag from
 * the active row — which changes the operator's model from "switches" to "a radio button" across
 * every screen. Exclusivity keeps ONE fact and makes the bad combination unwritable.
 *
 * That is only half the fix. See lib/connectors/wms/enabled-connector.ts for the other half: what
 * the readers do about a two-enabled state this rule cannot have written but a restore or a direct
 * `UPDATE setting` still can.
 */
export const INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS: readonly {
  readonly label: string
  readonly ids: readonly IntegrationPluginId[]
  /** Shown to the operator when two members of this group are on at once. */
  readonly conflict: string
}[] = [
  {
    label: 'shopping',
    ids: ['woocommerce', 'shopify'],
    conflict: 'Enable either WooCommerce or Shopify, not both.',
  },
  {
    label: 'accounting',
    ids: ['xero', 'quickbooks'],
    conflict: 'Enable either Xero or QuickBooks, not both — accounting dispatch is single-connector.',
  },
  {
    label: 'wms',
    // DERIVED. One entry ships today; the point is that the second one is covered the day it is
    // registered, not the day somebody remembers this file.
    ids: [...WMS_CONNECTOR_IDS],
    conflict: 'Enable one WMS connector at a time — order push, dispatch and every WMS sweep route'
      + ' to a single warehouse.',
  },
]

/**
 * The first exclusivity rule `state` breaks, or `null` when it breaks none.
 *
 * Total over the groups and over each group's members (`filter`, not a pair comparison), so a group
 * that grows a third member is checked for all three combinations without an edit. Both writers
 * call this against the state that RESULTS from their write, read under the selection lock — see
 * app/actions/settings.ts for why evaluating it beforehand made the check advisory only.
 */
export function findIntegrationPluginExclusivityConflict(
  state: Partial<Record<IntegrationPluginId, boolean>>,
): string | null {
  for (const group of INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS) {
    if (group.ids.filter((id) => state[id]).length > 1) return group.conflict
  }
  return null
}

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
