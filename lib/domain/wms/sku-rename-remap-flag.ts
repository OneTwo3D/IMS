import { getSettingValue } from '@/lib/settings-store'

/**
 * The switch for sending the warehouse's CURRENT SKU for an order line whose snapshot SKU is a known earlier SKU of its product (see sentSkuForLine in
 * sku-rename-hold.ts). OFF BY DEFAULT: only an explicit `true` turns it on. While it is off every line goes out with its own snapshot SKU, exactly as it
 * did before the remap existed (the open-rename-row order hold is independent of this switch and always applies). An unreadable setting is off.
 *
 * It applies to creates AND amendments alike, so an order is always amended with the SKU it was created with. Turn it on when no order created under an
 * older SKU is still open at the warehouse and awaiting an amendment: such an order holds the older SKU, and an amendment would then send the current
 * one. While it is on, the downstream SKU split in help-docs/warehouse.md applies (partial-shipment push forwards the warehouse SKU, the refund-remainder
 * task names the snapshot SKU).
 *
 * A system-managed key: not on the generic writers' allowlist; set with `npm run settings:set` (docs/installation.md).
 */
export const WMS_SKU_RENAME_REMAP_SETTING = 'wms_sku_rename_remap_enabled'

export async function isSkuRenameRemapEnabled(): Promise<boolean> {
  try {
    return (await getSettingValue(WMS_SKU_RENAME_REMAP_SETTING)) === 'true'
  } catch {
    return false
  }
}
