import { getSettingValues } from '@/lib/settings-store'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'

export type IntegrationPluginId = 'woocommerce' | 'shopify' | 'xero' | 'quickbooks' | 'mintsoft'

const PLUGIN_SETTING_KEYS = {
  woocommerce: 'plugin_woocommerce_enabled',
  shopify: 'plugin_shopify_enabled',
  xero: 'plugin_xero_enabled',
  quickbooks: 'plugin_quickbooks_enabled',
  mintsoft: 'plugin_mintsoft_enabled',
} as const

export type IntegrationPluginState = Record<IntegrationPluginId, boolean>

const DEFAULT_PLUGIN_STATE: IntegrationPluginState = {
  woocommerce: false,
  shopify: false,
  xero: false,
  quickbooks: false,
  mintsoft: false,
}

function parseEnabled(value: string | undefined): boolean {
  if (value == null || value === '') return false
  return value === 'true'
}

export async function getIntegrationPluginState(): Promise<IntegrationPluginState> {
  const values = await getSettingValues(Object.values(PLUGIN_SETTING_KEYS))

  return {
    woocommerce: parseEnabled(values.get(PLUGIN_SETTING_KEYS.woocommerce)),
    shopify: parseEnabled(values.get(PLUGIN_SETTING_KEYS.shopify)),
    xero: parseEnabled(values.get(PLUGIN_SETTING_KEYS.xero)),
    quickbooks: parseEnabled(values.get(PLUGIN_SETTING_KEYS.quickbooks)),
    mintsoft: parseEnabled(values.get(PLUGIN_SETTING_KEYS.mintsoft)),
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
