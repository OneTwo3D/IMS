/**
 * THE SHOP'S IOSS NUMBER (one shop-level value) and what an order stores from it (owner decision D5: IMS mirrors, never recomputes).
 *
 * WooCommerce's plugins keep the number in their own configuration, not on the order; IMS keeps it in the `shop_ioss_number` setting
 * (admin-edited, audited). An order's stored IOSS number and delivery term are then READ FROM THE ORDER'S EXISTING EU VAT STAMP
 * (`euVatRegime`, decided once by the IOSS/VOEC/DDP treatment), never decided again here:
 *   - stamped IOSS  -> the shop number (when one is set) and IOSS_DDP;
 *   - stamped DDP   -> DDP, no number (IOSS cannot apply over the threshold);
 *   - anything else (VOEC, a skip, no stamp yet) -> both null. DDU_DAP is never inferred: nothing here proves it.
 */
export const SHOP_IOSS_NUMBER_SETTING = 'shop_ioss_number'

/** IM plus ten digits, as issued. Trimmed and upper-cased; anything else is not a number. */
export function parseShopIossNumber(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase()
  return /^IM\d{10}$/.test(value) ? value : null
}

export type MirroredIossFields = { iossNumber: string | null; deliveryTerm: 'IOSS_DDP' | 'DDP' | null }

export function iossFieldsFromRegime(regime: string | null | undefined, shopIossNumber: string | null): MirroredIossFields {
  if (regime === 'IOSS') return { iossNumber: shopIossNumber, deliveryTerm: 'IOSS_DDP' }
  if (regime === 'DDP') return { iossNumber: null, deliveryTerm: 'DDP' }
  return { iossNumber: null, deliveryTerm: null }
}
