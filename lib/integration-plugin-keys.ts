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
 * This module has NO imports, on purpose. Keep it that way.
 */

export type IntegrationPluginId = 'woocommerce' | 'shopify' | 'xero' | 'quickbooks' | 'mintsoft' | 'shiphero'

export const INTEGRATION_PLUGIN_SETTING_KEYS = {
  woocommerce: 'plugin_woocommerce_enabled',
  shopify: 'plugin_shopify_enabled',
  xero: 'plugin_xero_enabled',
  quickbooks: 'plugin_quickbooks_enabled',
  mintsoft: 'plugin_mintsoft_enabled',
  shiphero: 'plugin_shiphero_enabled',
} as const

export type IntegrationPluginState = Record<IntegrationPluginId, boolean>

export const INTEGRATION_PLUGIN_IDS = Object.keys(INTEGRATION_PLUGIN_SETTING_KEYS) as IntegrationPluginId[]

/**
 * Every plugin key, sorted — THE canonical order these rows are locked in.
 *
 * ALL SIX, not just the two accounting ones. Exclusivity spans WooCommerce/Shopify as well as
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
