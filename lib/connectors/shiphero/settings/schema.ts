import { getSettingValues } from '@/lib/settings-store'

/**
 * ShipHero connector settings. Mirrors the Mintsoft settings shape
 * (lib/connectors/mintsoft/settings/schema.ts) but for ShipHero's GraphQL +
 * OAuth refresh-token model. The refresh token is the long-lived secret; the
 * access token is a short-lived bearer cached in `shiphero_access_token`
 * (analogous to Mintsoft's cached `mintsoft_api_key`).
 */
export type ShipheroSettings = {
  /** Long-lived OAuth refresh token — the renewable credential (secret). */
  shiphero_refresh_token: string
  /** Cached short-lived bearer access token (secret, machine-managed). */
  shiphero_access_token: string
  /** Shared secret used to verify inbound ShipHero webhooks (secret). */
  shiphero_webhook_secret: string
  /** Optional ShipHero 3PL customer account id used to scope queries. */
  shiphero_account_id: string
  /** Deep-link template for the sales-order WMS status chip; `{id}` → order id. */
  shiphero_admin_order_url_template: string
}

export const SHIPHERO_SETTING_KEYS = [
  'shiphero_refresh_token',
  'shiphero_access_token',
  'shiphero_webhook_secret',
  'shiphero_account_id',
  'shiphero_admin_order_url_template',
] as const

/** ShipHero's public API host. Stored on WmsConnection.baseUrl; fixed by default. */
export const SHIPHERO_DEFAULT_BASE_URL = 'https://public-api.shiphero.com'
export const SHIPHERO_AUTH_PATH = '/auth/refresh'
export const SHIPHERO_GRAPHQL_PATH = '/graphql'

// `{id}` is substituted with the ShipHero order id. Override per tenant via the setting.
export const SHIPHERO_DEFAULT_ADMIN_ORDER_URL_TEMPLATE = 'https://app.shiphero.com/dashboard/orders/details/{id}'

export const DEFAULT_SHIPHERO_CONNECTION_LABEL = 'Primary'

const SHIPHERO_DEFAULTS: ShipheroSettings = {
  shiphero_refresh_token: '',
  shiphero_access_token: '',
  shiphero_webhook_secret: '',
  shiphero_account_id: '',
  shiphero_admin_order_url_template: SHIPHERO_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
}

export async function getShipheroSettings(): Promise<ShipheroSettings> {
  const map = await getSettingValues([...SHIPHERO_SETTING_KEYS])
  const result = { ...SHIPHERO_DEFAULTS }

  for (const key of Object.keys(result) as (keyof ShipheroSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }

  return result
}
