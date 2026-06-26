import { getSettingValues } from '@/lib/settings-store'

export type MintsoftSettings = {
  mintsoft_api_key: string
  mintsoft_username: string
  mintsoft_password: string
  mintsoft_webhook_secret: string
  mintsoft_admin_order_url_template: string
  mintsoft_default_courier_service_id: string
  /** JSON map of IMS shipping-service name → Mintsoft CourierServiceId. */
  mintsoft_courier_service_map: string
}

export const MINTSOFT_SETTING_KEYS = [
  'mintsoft_api_key',
  'mintsoft_username',
  'mintsoft_password',
  'mintsoft_webhook_secret',
  'mintsoft_admin_order_url_template',
  'mintsoft_default_courier_service_id',
  'mintsoft_courier_service_map',
] as const

// `{id}` is substituted with the Mintsoft internal order id. Matches the proven
// woo-mintsoft plugin default; override via the setting for other tenants.
export const MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE = 'https://app.fulfillable.co.uk/Order/Details/{id}'

const MINTSOFT_DEFAULTS: MintsoftSettings = {
  mintsoft_api_key: '',
  mintsoft_username: '',
  mintsoft_password: '',
  mintsoft_webhook_secret: '',
  mintsoft_admin_order_url_template: MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
  mintsoft_default_courier_service_id: '',
  mintsoft_courier_service_map: '',
}

export async function getMintsoftSettings(): Promise<MintsoftSettings> {
  const map = await getSettingValues([...MINTSOFT_SETTING_KEYS])
  const result = { ...MINTSOFT_DEFAULTS }

  for (const key of Object.keys(result) as (keyof MintsoftSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }

  return result
}
