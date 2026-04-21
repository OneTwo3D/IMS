import { getSettingValues } from '@/lib/settings-store'

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
  switch (module) {
    case 'woocommerce':
      return state.woocommerce
    case 'shopify':
      return state.shopify
    case 'accounting':
      return state.xero || state.quickbooks
    case 'mintsoft':
    case 'wms':
      return state.mintsoft
    default:
      return true
  }
}

export const INTEGRATION_PLUGIN_SETTING_KEYS = PLUGIN_SETTING_KEYS
