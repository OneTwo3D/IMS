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
  /**
   * Our Mintsoft ClientId. REQUIRED to enable the inbound Order/List delta:
   * Mintsoft is a shared 3PL tenant, so an UNSCOPED Order/List returns every
   * client's orders — and an order-number collision could then mark OUR order
   * shipped off a FOREIGN despatch. When blank/invalid the delta stays off and
   * the sweep uses the per-order reconcile. A positive whole number, as a string.
   */
  mintsoft_client_id: string
  /** Optional Mintsoft ChannelId that further scopes the inbound delta. */
  mintsoft_channel_id: string
  /** Optional Mintsoft WarehouseId that further scopes the inbound delta. */
  mintsoft_warehouse_id: string
}

export const MINTSOFT_SETTING_KEYS = [
  'mintsoft_api_key',
  'mintsoft_username',
  'mintsoft_password',
  'mintsoft_webhook_secret',
  'mintsoft_admin_order_url_template',
  'mintsoft_default_courier_service_id',
  'mintsoft_courier_service_map',
  'mintsoft_client_id',
  'mintsoft_channel_id',
  'mintsoft_warehouse_id',
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
  mintsoft_client_id: '',
  mintsoft_channel_id: '',
  mintsoft_warehouse_id: '',
}

/**
 * Parse a Mintsoft scoping id setting (ClientId / ChannelId / WarehouseId) into a
 * positive integer, or null when blank/invalid. Shared by the settings action
 * (validation), the connector (delta scoping), and the sweep (fail-closed gate)
 * so all three agree on what counts as "configured".
 */
export function parseMintsoftPositiveId(value: string | null | undefined): number | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * True when the inbound-delta SCOPE (ClientId / ChannelId / WarehouseId) differs
 * between the incoming values and the persisted settings. A scope change (a tenant
 * correction, a channel/warehouse retarget) invalidates the persisted delta
 * watermark + last-reconcile cursors — they belong to the OLD scope, and reusing
 * them would start the next query from a stale point, so outstanding new-scope
 * orders predating the overlap would never enter the delta. The caller must clear
 * both cursors when this returns true. Compared as already-normalised strings
 * (`''` = unset).
 */
export function mintsoftDeltaScopeChanged(
  next: { clientId: string; channelId: string; warehouseId: string },
  prev: Pick<MintsoftSettings, 'mintsoft_client_id' | 'mintsoft_channel_id' | 'mintsoft_warehouse_id'>,
): boolean {
  return (
    next.clientId !== prev.mintsoft_client_id ||
    next.channelId !== prev.mintsoft_channel_id ||
    next.warehouseId !== prev.mintsoft_warehouse_id
  )
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
