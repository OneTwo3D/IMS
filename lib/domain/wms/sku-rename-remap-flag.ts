import { getSettingValue } from '@/lib/settings-store'

/**
 * The switch for sending the warehouse's CURRENT SKU for an order line whose snapshot SKU is a known earlier SKU of its product (see sentSkuForLine in
 * sku-rename-hold.ts). OFF BY DEFAULT: only an explicit `true` turns it on. While it is off every line goes out with its own snapshot SKU, exactly as it
 * did before the remap existed (the open-rename-row order hold is independent of this switch and always applies). An unreadable setting is off.
 *
 * The SKU actually sent for each line is recorded on the push link at create (and refreshed by every applied line amendment); amendments and verifies
 * are built from that record whatever this switch says, so it only decides lines that were never sent. An order created before the record existed has
 * nothing recorded and follows the switch as it stands: turn it on only when no such order is still open at the warehouse and awaiting an amendment, and not
 * off again while one created with it on is. While it is on, the downstream SKU split in help-docs/warehouse.md applies (partial-shipment push forwards the
 * warehouse SKU, the refund-remainder task names the snapshot SKU).
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
