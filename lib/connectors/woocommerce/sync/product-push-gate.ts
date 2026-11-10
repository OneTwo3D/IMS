import { db } from '@/lib/db'

/**
 * Whether IMS may write product fields (name, status, prices, barcode) to WooCommerce.
 *
 * Both Sync-page settings must say so: `wc_sync_product_enabled` is `'true'` AND
 * `wc_sync_product_direction` is `'to_wc'` or `'both'`. The direction default is `from_wc`
 * (WooCommerce is the product master), so an installation that never touched the setting never
 * pushes. A missing, blank or unrecognised value reads as "do not push": a push overwrites live
 * storefront names, prices and publish status, so doubt resolves to not writing.
 */
export type WcProductPushDecision =
  | { allowed: true }
  | { allowed: false; reason: 'disabled' | 'direction_from_wc' | 'direction_unreadable'; message: string }

export function decideWcProductPush(
  enabled: string | null | undefined,
  direction: string | null | undefined,
): WcProductPushDecision {
  if (enabled !== 'true') {
    return { allowed: false, reason: 'disabled', message: 'WooCommerce product sync is disabled (wc_sync_product_enabled); product changes are not pushed' }
  }
  if (direction === 'to_wc' || direction === 'both') return { allowed: true }
  if (direction === 'from_wc' || direction == null || direction === '') {
    return { allowed: false, reason: 'direction_from_wc', message: 'WooCommerce is the product master (wc_sync_product_direction is from_wc or unset); product changes are not pushed' }
  }
  return { allowed: false, reason: 'direction_unreadable', message: `wc_sync_product_direction has an unrecognised value; product changes are not pushed` }
}

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

/**
 * Read both settings and decide. A read failure PROPAGATES to the caller (which refuses the
 * push) rather than being caught and defaulted: an unreadable setting must not read as consent.
 */
export async function readWcProductPushDecision(reader: SettingReader = db as unknown as SettingReader): Promise<WcProductPushDecision> {
  const enabled = await reader.setting.findUnique({ where: { key: 'wc_sync_product_enabled' } })
  const direction = await reader.setting.findUnique({ where: { key: 'wc_sync_product_direction' } })
  return decideWcProductPush(enabled?.value, direction?.value)
}
