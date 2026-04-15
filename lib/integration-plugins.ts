import { getSettingValues } from '@/lib/settings-store'

export type IntegrationPluginId = 'woocommerce' | 'xero'

const PLUGIN_SETTING_KEYS = {
  woocommerce: 'plugin_woocommerce_enabled',
  xero: 'plugin_xero_enabled',
} as const

export type IntegrationPluginState = Record<IntegrationPluginId, boolean>

const DEFAULT_PLUGIN_STATE: IntegrationPluginState = {
  woocommerce: false,
  xero: false,
}

function parseEnabled(value: string | undefined): boolean {
  if (value == null || value === '') return false
  return value === 'true'
}

export async function getIntegrationPluginState(): Promise<IntegrationPluginState> {
  const values = await getSettingValues(Object.values(PLUGIN_SETTING_KEYS))

  return {
    woocommerce: parseEnabled(values.get(PLUGIN_SETTING_KEYS.woocommerce)),
    xero: parseEnabled(values.get(PLUGIN_SETTING_KEYS.xero)),
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
    case 'accounting':
      return state.xero
    default:
      return true
  }
}

export const INTEGRATION_PLUGIN_SETTING_KEYS = PLUGIN_SETTING_KEYS
