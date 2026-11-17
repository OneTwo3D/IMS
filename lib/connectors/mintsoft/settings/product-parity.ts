import { db } from '@/lib/db'

/**
 * THE SWITCHES FOR MINTSOFT PRODUCT SYNC PARITY WITH THE RETIRED PYTHON SYNC (o3d-zvec.20).
 *
 * Mintsoft is a LIVE production warehouse. Both settings read ON only for the exact string 'true': absent, blank, 'false', 'TRUE', a
 * typo all read OFF, and a read failure PROPAGATES (an unreadable setting is neither consent nor a silent "off": the caller is about
 * to decide what to write to a live system).
 *
 * `mintsoft_product_parity_enabled` (default OFF) gates every changed product WRITE:
 *   - the Name is fitted to Mintsoft's 99-character limit (parent cut at a word boundary, variation suffix kept whole),
 *   - the IMS cost is sent as CostPrice,
 *   - a variation inherits its parent's weight and dimensions where its own are missing,
 *   - the trade-data and country-of-origin bulk tools may APPLY (they are dry-run without it).
 *   With it OFF the product payload and its hash are byte-identical to what IMS sent before this setting existed.
 *
 * `mintsoft_parent_sku_delete_enabled` (default OFF) is separate because it is DESTRUCTIVE and cannot be undone: with it ON, a
 * VARIABLE parent's Mintsoft SKU is deleted, but only once every variation is confirmed present in Mintsoft (see
 * sync/parent-sku-deletion.ts). It does nothing unless the parity setting is also on.
 */
export const MINTSOFT_PRODUCT_PARITY_SETTING = 'mintsoft_product_parity_enabled'
export const MINTSOFT_PARENT_SKU_DELETE_SETTING = 'mintsoft_parent_sku_delete_enabled'

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

export function isMintsoftSettingEnabledValue(value: string | null | undefined): boolean {
  return value === 'true'
}

export async function readMintsoftProductParityEnabled(
  reader: SettingReader = db as unknown as SettingReader,
): Promise<boolean> {
  const row = await reader.setting.findUnique({ where: { key: MINTSOFT_PRODUCT_PARITY_SETTING } })
  return isMintsoftSettingEnabledValue(row?.value)
}

/** The destructive switch AND the parity switch: deleting a parent without the rest of the parity behaviour on is refused. */
export async function readMintsoftParentSkuDeleteEnabled(
  reader: SettingReader = db as unknown as SettingReader,
): Promise<boolean> {
  const row = await reader.setting.findUnique({ where: { key: MINTSOFT_PARENT_SKU_DELETE_SETTING } })
  if (!isMintsoftSettingEnabledValue(row?.value)) return false
  return readMintsoftProductParityEnabled(reader)
}
