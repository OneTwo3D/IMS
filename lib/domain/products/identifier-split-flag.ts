import { db } from '@/lib/db'

/**
 * The switch for every changed WRITE behaviour of the GTIN/MPN identifier split.
 *
 * The warehouse and the storefront are live production systems. With this setting anything other than the string 'true'
 * (absent, blank, 'false', a typo) reads as OFF and every outbound payload is byte-identical to what IMS sent before
 * the split existed:
 *
 *  - Warehouse: EAN = Product.barcode only, no UPC, no MPN-aware reconciliation of what the warehouse already holds.
 *  - WooCommerce: `global_unique_id` gated on the old all-digits test, and no MPN written.
 *
 * With it ON:
 *  - Warehouse: the GTIN is written to EAN and the MPN to UPC, and the warehouse read classifies EAN/UPC by shape
 *    (isGtin) rather than first-match. A code neither slot can take is raised as a BARCODE_CONFLICT discrepancy for a
 *    human, never dropped, and nothing is written to either field while it is open.
 *  - WooCommerce: `global_unique_id` is sent only for a real GTIN, and the MPN is written to Yoast's product
 *    identifier store, key 'mpn', where the sync plugin writes it.
 *
 * Read-side classification is also behind this flag, because the warehouse read feeds the automatic barcode backfill
 * into Product.barcode, which IMS later pushes back out.
 *
 * A read failure PROPAGATES: an unreadable setting must not read as consent, and it must not read as a silent 'off'
 * either, because the caller is about to decide what to write to a live system.
 */
export const PRODUCT_IDENTIFIER_SPLIT_SETTING = 'product_identifier_split_enabled'

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

export function isProductIdentifierSplitEnabledValue(value: string | null | undefined): boolean {
  return value === 'true'
}

export async function readProductIdentifierSplitEnabled(
  reader: SettingReader = db as unknown as SettingReader,
): Promise<boolean> {
  const row = await reader.setting.findUnique({ where: { key: PRODUCT_IDENTIFIER_SPLIT_SETTING } })
  return isProductIdentifierSplitEnabledValue(row?.value)
}
