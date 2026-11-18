import { getSettingValue } from '@/lib/settings-store'

/**
 * The switch for the scoped (mixed-warehouse) push and despatch. OFF BY DEFAULT: only an explicit `true` turns it on. While it is off every
 * pass behaves exactly as it did before scoping existed - the whole order is pushed, a despatch for an order that also holds another
 * warehouse's shipments is refused (fail closed) - and nothing reads the scope columns. An unreadable setting is off.
 *
 * A system-managed key: not on the generic writers' allowlist, set by the operator runbook (help-docs/warehouse.md).
 */
export const WMS_MIXED_WAREHOUSE_PUSH_SETTING = 'wms_mixed_warehouse_push_enabled'

export async function isMixedWarehousePushEnabled(): Promise<boolean> {
  try {
    return (await getSettingValue(WMS_MIXED_WAREHOUSE_PUSH_SETTING)) === 'true'
  } catch {
    return false
  }
}
