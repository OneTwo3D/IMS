import {
  buildIntegrationConnectionFingerprint,
  evaluateIntegrationConnectionTestGate,
  integrationConnectionFingerprintSecret,
  type IntegrationConnectionTestGateResult,
  type IntegrationConnectionTestState,
} from '@/lib/integration-connection-test-gate'

export const WC_ENABLE_SETTING_KEYS = [
  'wc_sync_enabled',
  'wc_sync_product_enabled',
  'wc_stock_sync_enabled',
  'wc_fx_push_enabled',
] as const

export type WooCommerceEnableSettingKey = (typeof WC_ENABLE_SETTING_KEYS)[number]

export function buildWooCommerceConnectionFingerprint(input: { url: string; key: string; secret: string }): string {
  return buildIntegrationConnectionFingerprint({
    url: input.url.trim(),
    key: input.key.trim(),
    secret: integrationConnectionFingerprintSecret(input.secret.trim()),
  })
}

export function shouldGateWooCommerceEnable(
  data: Partial<Record<string, unknown>>,
  currentSettings: ReadonlyMap<string, string>,
): boolean {
  return WC_ENABLE_SETTING_KEYS.some((key) => data[key] === 'true' || (data[key] === undefined && currentSettings.get(key) === 'true'))
}

export async function evaluateWooCommerceEnableConnectionGate(
  data: Partial<Record<string, unknown>>,
  deps: {
    getCurrentSettings: (keys: readonly WooCommerceEnableSettingKey[]) => Promise<ReadonlyMap<string, string>>
    getCurrentFingerprint: () => Promise<string>
    getConnectionTestState: () => Promise<IntegrationConnectionTestState>
  },
): Promise<IntegrationConnectionTestGateResult> {
  const currentSettings = await deps.getCurrentSettings(WC_ENABLE_SETTING_KEYS)
  if (!shouldGateWooCommerceEnable(data, currentSettings)) return { ok: true }

  return evaluateIntegrationConnectionTestGate({
    label: 'WooCommerce',
    expectedFingerprint: await deps.getCurrentFingerprint(),
    state: await deps.getConnectionTestState(),
  })
}
