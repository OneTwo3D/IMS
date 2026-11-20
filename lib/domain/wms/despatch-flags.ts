import { getSettingValue } from '@/lib/settings-store'

/**
 * Two switches for how a warehouse despatch is applied in IMS. BOTH OFF BY DEFAULT: only an explicit `true` turns one on, an unreadable
 * setting is off, and while a switch is off the despatch is applied exactly as it was before it existed. Both are system-managed keys: not on
 * the generic writers' allowlist, set with `npm run settings:set` (docs/installation.md).
 *
 *  - `wms_despatch_date_enabled`: the shipment, the stock movement and the order flip are dated with the warehouse's own despatch time
 *    (bounded; see lib/domain/sales/despatch-instant.ts) instead of the moment the sweep applied it.
 *  - `wms_despatch_quantity_check_enabled`: the units the warehouse despatched are compared with the units IMS books, and a despatch that
 *    differs is held and raised for a person instead of being applied (see findDespatchQuantityMismatch in lib/fulfillment/despatch-quantity-check.ts).
 */
export const WMS_DESPATCH_DATE_SETTING = 'wms_despatch_date_enabled'
export const WMS_DESPATCH_QUANTITY_CHECK_SETTING = 'wms_despatch_quantity_check_enabled'

async function isOn(key: string): Promise<boolean> {
  try {
    return (await getSettingValue(key)) === 'true'
  } catch {
    return false
  }
}

export const isWmsDespatchDateEnabled = (): Promise<boolean> => isOn(WMS_DESPATCH_DATE_SETTING)
export const isWmsDespatchQuantityCheckEnabled = (): Promise<boolean> => isOn(WMS_DESPATCH_QUANTITY_CHECK_SETTING)
