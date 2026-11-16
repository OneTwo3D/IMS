/**
 * Product identifier classification: GTIN versus MPN.
 *
 * A port of the WooCommerce/warehouse sync plugin's `is_gtin`, `strip_like_woocommerce`, `_same_code` and
 * `classify_*_codes` functions (the plugin's wc_*_sync.py), with identical semantics, so the plugin, the deployed
 * mu-plugin schema guard (O3D_GTIN_Guard::why_invalid), the Merchant Center feeds and IMS cannot disagree about
 * what a GTIN is.
 *
 * Why the split exists. A GTIN is a digits-only global trade number that scanners and Google Merchant Center read.
 * An MPN is an arbitrary manufacturer part number such as LN00000287 and contains letters. WooCommerce's native
 * `_global_unique_id` is digits-only (`preg_replace('/[^0-9Xx-]/', '', $value)`), so LN00000287 would silently
 * store as 00000287, which does not scan. One field cannot hold both.
 *
 * Pure: no I/O, no settings. Whether any of this changes what IMS WRITES is decided by the caller, behind the
 * `product_identifier_split_enabled` setting (see identifier-split-flag.ts).
 */

const GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14]

/** Python `str(value or '').strip()`: nullish, empty, 0 and false all read as the empty string. */
function toTrimmed(value: unknown): string {
  return value ? String(value).trim() : ''
}

/**
 * True when `value` is a structurally valid GTIN-8/12/13/14. The same three tests as the plugin:
 *  - ASCII digits only, one of the four legal lengths;
 *  - the GS1 mod-10 check digit;
 *  - fewer than four leading zeros. A real GTIN keeps a non-zero GS1 company prefix, so a heavily zero-padded value
 *    is an internal counter that happens to fit (eight such counters passed mod-10 by luck in the audit).
 *
 * A bare number is accepted (the warehouse's JSON has handed back a number for a numeric barcode).
 */
export function isGtin(value: unknown): boolean {
  const v = toTrimmed(value)
  if (!/^[0-9]+$/.test(v) || !GTIN_LENGTHS.includes(v.length)) return false
  if (v.length - v.replace(/^0+/, '').length >= 4) return false
  const digits = [...v].map(Number)
  const body = digits.slice(0, -1).reverse()
  const total = body.reduce((sum, d, i) => sum + d * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (total % 10)) % 10 === digits[digits.length - 1]
}

/**
 * WC_Product::set_global_unique_id()'s own filter, verbatim: `preg_replace('/[^0-9Xx\-]/', '', $value)`. Its
 * purpose is to tell "WooCommerce truncated the code we sent" apart from "WooCommerce holds a different code".
 */
export function stripLikeWooCommerce(value: unknown): string {
  return value ? String(value).replace(/[^0-9Xx-]/g, '') : ''
}

/**
 * Are these two values the same code written two ways? Exactly two cases:
 *  - byte-equal after trimming;
 *  - the GTIN-13/GTIN-14 pair: the 14 is the 13 with a leading zero and BOTH validate as GTINs.
 *
 * Deliberately NOT "equal once leading zeros are stripped", which would fold 00000287 and 287 (two different
 * internal counters) into one code and suppress a real conflict.
 */
export function sameCode(a: unknown, b: unknown): boolean {
  const left = toTrimmed(a)
  const right = toTrimmed(b)
  if (left === right) return true
  const [long, short] = left.length > right.length ? [left, right] : [right, left]
  if (long.length === 14 && short.length === 13 && long === `0${short}`) {
    return isGtin(long) && isGtin(short)
  }
  return false
}

export type IdentifierCodes = {
  /** Goes to WooCommerce's `_global_unique_id`, to Google, and to the warehouse EAN field. */
  gtin: string
  /** Goes to Yoast's 'mpn' (the only WooCommerce field that keeps letters) and to the warehouse UPC field. */
  mpn: string
  /**
   * A THIRD distinct code neither slot could take (two different GTINs, or two different part numbers). Never dropped
   * silently: the caller reports it for a human. Picking a winner between two codes the warehouse may have stock booked
   * under is exactly the decision a sync must not make.
   */
  leftover: string
}

/** One warehouse barcode field as a trimmed string. A boolean, an object or a non-integer number is not a barcode. */
function identifierCode(value: unknown): string {
  if (value == null || typeof value === 'boolean') return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isInteger(value)) return String(value).trim()
  return ''
}

/**
 * Sort a warehouse product's EAN/UPC into (gtin, mpn, leftover).
 *
 * Shape is the veto, the FIELD is the tie-break, and the two slots are chosen INDEPENDENTLY so each gets its own
 * field's preference:
 *
 *   gtin  the first VALID GTIN, EAN offered first
 *   mpn   the first NON-GTIN, UPC offered first
 *
 * Filling mpn with "the first non-GTIN in EAN-then-UPC order" would take EAN=LN00000059 over UPC=LN00000282 on the
 * live record for SKU 74928122361-04, putting the EAN into the slot reserved for the UPC.
 */
export function classifyIdentifierCodes(product: { EAN?: unknown; UPC?: unknown }): IdentifierCodes {
  const ean = identifierCode(product.EAN)
  const upc = identifierCode(product.UPC)

  const codes: string[] = []
  for (const candidate of [ean, upc]) {
    if (candidate && !codes.some((seen) => sameCode(candidate, seen))) codes.push(candidate)
  }

  const gtin = codes.find((c) => isGtin(c)) ?? ''
  const mpn = [upc, ean].find((c) => codes.includes(c) && c !== gtin && !isGtin(c)) ?? ''
  const leftover = codes.find((c) => c !== gtin && c !== mpn) ?? ''
  return { gtin, mpn, leftover }
}
