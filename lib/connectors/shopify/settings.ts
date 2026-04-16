import { getSettingValues } from '@/lib/settings-store'

export type ShopifySettings = {
  shopify_store_domain: string
  shopify_admin_api_access_token: string
  shopify_webhook_secret: string
  shopify_sync_enabled: string
}

export const SHOPIFY_SETTING_KEYS = [
  'shopify_store_domain',
  'shopify_admin_api_access_token',
  'shopify_webhook_secret',
  'shopify_sync_enabled',
] as const

const SHOPIFY_DEFAULTS: ShopifySettings = {
  shopify_store_domain: '',
  shopify_admin_api_access_token: '',
  shopify_webhook_secret: '',
  shopify_sync_enabled: 'false',
}

export async function getShopifySettings(): Promise<ShopifySettings> {
  const map = await getSettingValues([...SHOPIFY_SETTING_KEYS])
  const result = { ...SHOPIFY_DEFAULTS }
  for (const key of Object.keys(result) as (keyof ShopifySettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }
  return result
}
