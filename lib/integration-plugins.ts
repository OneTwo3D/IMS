import { getSettingValues } from '@/lib/settings-store'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import {
  INTEGRATION_PLUGIN_SETTING_KEYS as PLUGIN_SETTING_KEYS,
  parseIntegrationPluginEnabled as parseEnabled,
  type IntegrationPluginId,
  type IntegrationPluginState,
} from '@/lib/integration-plugin-keys'

// The keys, the id union and the state shape now live in @/lib/integration-plugin-keys — a module
// with no imports, so the full-chain quiesce harness can name the same keys without pulling Prisma
// in (o3d-osl8 round 6, finding 2). Re-exported here because every existing call site imports them
// from this module and one canonical name per concept is the point of the split.
export type { IntegrationPluginId, IntegrationPluginState }

const DEFAULT_PLUGIN_STATE: IntegrationPluginState = {
  woocommerce: false,
  shopify: false,
  xero: false,
  quickbooks: false,
  mintsoft: false,
  shiphero: false,
}

export async function getIntegrationPluginState(): Promise<IntegrationPluginState> {
  const values = await getSettingValues(Object.values(PLUGIN_SETTING_KEYS))

  return {
    woocommerce: parseEnabled(values.get(PLUGIN_SETTING_KEYS.woocommerce)),
    shopify: parseEnabled(values.get(PLUGIN_SETTING_KEYS.shopify)),
    xero: parseEnabled(values.get(PLUGIN_SETTING_KEYS.xero)),
    quickbooks: parseEnabled(values.get(PLUGIN_SETTING_KEYS.quickbooks)),
    mintsoft: parseEnabled(values.get(PLUGIN_SETTING_KEYS.mintsoft)),
    shiphero: parseEnabled(values.get(PLUGIN_SETTING_KEYS.shiphero)),
  }
}

export async function isIntegrationPluginEnabled(id: IntegrationPluginId): Promise<boolean> {
  const state = await getIntegrationPluginState()
  return state[id]
}

export function isIntegrationModuleVisible(
  module: string,
  state: IntegrationPluginState = DEFAULT_PLUGIN_STATE,
): boolean {
  // Aggregate module groups span multiple connectors; the module is "visible"
  // when any backing connector is enabled. Kept data-driven so a new connector
  // (e.g. a 2nd WMS) is picked up by adding it to the registry list, with no
  // edit here.
  if (module === 'accounting') return state.xero || state.quickbooks
  if (module === 'wms') return WMS_CONNECTOR_IDS.some((id) => state[id])

  // A per-connector module string (e.g. 'woocommerce', 'shopify', or any WMS
  // connector id such as 'mintsoft') maps to that plugin's own enabled flag.
  if (module in state) return state[module as IntegrationPluginId]

  return true
}

export const INTEGRATION_PLUGIN_SETTING_KEYS = PLUGIN_SETTING_KEYS
