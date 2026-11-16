import { classifyIdentifierCodes, isGtin, stripLikeWooCommerce } from '@/lib/domain/products/identifiers'

/**
 * Where IMS writes a product's GTIN and MPN on WooCommerce, when the product identifier split is on
 * (`product_identifier_split_enabled`, see lib/domain/products/identifier-split-flag.ts). Pure: no I/O.
 *
 * The GTIN goes to WooCommerce's native `global_unique_id`, which Google reads and which is digits-only
 * (WC_Product::set_global_unique_id() strips everything but [0-9Xx-]). A code with letters, or a zero-padded internal
 * counter, must never go there.
 *
 * The MPN goes where the WooCommerce/warehouse sync plugin writes it: Yoast's product identifier store, a single
 * serialised array {gtin8, gtin12, gtin13, gtin14, isbn, mpn} held in ONE meta key per post type:
 *   - simple/variable products: `wpseo_global_identifier_values`
 *   - variations:               `wpseo_variation_global_identifiers_values`
 * (WooCommerce REST exposes both in `meta_data` as a plain object.) It is the only field on the site that keeps
 * letters, and what zz-o3d-barcode-restore.php and zz-o3d-mc-identifiers.php read. Writing a variation's MPN into
 * the parent key would leave it invisible to every reader, so the key follows the object being written.
 *
 * The store is one array, so the write is read-modify-write: sending just {mpn} would drop a gtin13 sitting beside it.
 */

export const YOAST_PRODUCT_IDENTIFIER_KEY = 'wpseo_global_identifier_values'
export const YOAST_VARIATION_IDENTIFIER_KEY = 'wpseo_variation_global_identifiers_values'
const YOAST_SUBKEYS = ['gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn', 'mpn'] as const

export function yoastIdentifierKey(isVariation: boolean): string {
  return isVariation ? YOAST_VARIATION_IDENTIFIER_KEY : YOAST_PRODUCT_IDENTIFIER_KEY
}

type MetaEntry = { key?: string; value?: unknown }

function getMeta(meta: unknown, key: string): unknown {
  if (!Array.isArray(meta)) return undefined
  for (const entry of meta as MetaEntry[]) {
    if (entry && typeof entry === 'object' && entry.key === key) return entry.value
  }
  return undefined
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The 'mpn' sub-value as a string, or '' when it is not one. */
function mpnOf(store: Record<string, unknown>): string {
  const raw = store.mpn
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw)
  return ''
}

export type WcIdentifierPlan = {
  /** Fields to merge into the product PUT body. */
  payload: { global_unique_id?: string; meta_data?: Array<{ key: string; value: Record<string, unknown> }> }
  /** Why the MPN was NOT written, when there was one to write. Surfaced to the caller, never silent. */
  warning?: string
  /** An identifier this product holds that neither slot could take (two GTINs, or two part numbers). Not written. */
  leftover?: string
}

/**
 * Decide what a push writes for the product's identifiers.
 *
 * @param barcode        Product.barcode, the GTIN slot (but it may hold a part number; classification is by shape)
 * @param mpn            Product.mpn
 * @param currentMeta    `meta_data` of the WooCommerce object as just fetched; the store to merge into
 * @param isVariation    which Yoast key holds this object's identifiers
 */
export function planWcIdentifierWrite(params: {
  barcode: string | null | undefined
  mpn: string | null | undefined
  currentMeta: unknown
  isVariation: boolean
  /** `global_unique_id` of the WooCommerce object as just fetched. */
  currentGlobalUniqueId?: unknown
}): WcIdentifierPlan {
  const codes = classifyIdentifierCodes({ EAN: params.barcode, UPC: params.mpn })
  const plan: WcIdentifierPlan = { payload: {} }

  if (codes.gtin && isGtin(codes.gtin)) {
    plan.payload.global_unique_id = codes.gtin
  } else {
    // Omitting the field does not clear what an earlier push (all-digits barcode, split off) already stored. A stored
    // non-GTIN that is exactly what the old rule would have derived from this product's barcode came from IMS: clear it.
    // Any other non-GTIN has no provable origin: leave it and say so.
    const stored = typeof params.currentGlobalUniqueId === 'string' ? params.currentGlobalUniqueId.trim() : ''
    if (stored && !isGtin(stored)) {
      const fromImsBarcode = stripLikeWooCommerce(params.barcode)
      if (fromImsBarcode && stored === fromImsBarcode) {
        plan.payload.global_unique_id = ''
      } else {
        plan.warning = `WooCommerce's GTIN field holds ${stored}, which is not a valid GTIN and does not match this product's barcode; it was left untouched for review`
      }
    }
  }
  if (codes.leftover) plan.leftover = codes.leftover
  if (!codes.mpn) return plan

  const key = yoastIdentifierKey(params.isVariation)
  const existing = getMeta(params.currentMeta, key)
  let store: Record<string, unknown>
  if (existing === undefined || existing === null || existing === '' || (Array.isArray(existing) && existing.length === 0)) {
    // Absent, or Yoast's own empty placeholder: safe to create.
    store = {}
  } else {
    const object = asPlainObject(existing)
    if (!object) {
      // PRESENT in a shape we do not understand (a legacy serialised string, a list, something a future Yoast writes).
      // Replacing it with our six-key object could destroy a GTIN or ISBN it encodes.
      plan.warning = (plan.warning ? `${plan.warning}; ` : '') + `MPN ${codes.mpn} was not written: ${key} holds a value in an unrecognised shape and was left untouched`
      return plan
    }
    store = object
  }

  if (mpnOf(store) === codes.mpn) return plan // already stored: a repeated push is not a repeated write

  const merged: Record<string, unknown> = {}
  for (const sub of YOAST_SUBKEYS) merged[sub] = store[sub] ?? ''
  for (const [k, v] of Object.entries(store)) if (!(k in merged)) merged[k] = v // anything Yoast added since
  merged.mpn = codes.mpn
  plan.payload.meta_data = [{ key, value: merged }]
  return plan
}

/** True when the PUT response shows the MPN stored, false when it shows something else, null when it cannot tell. */
export function wcResponseConfirmsMpn(response: unknown, key: string, mpn: string): boolean | null {
  const meta = asPlainObject(response)?.meta_data
  if (!Array.isArray(meta)) return null
  const store = asPlainObject(getMeta(meta, key))
  return store ? mpnOf(store) === mpn : false
}

/** What the identifier plan read: the Yoast store for this object's key and the GTIN field. Equal snapshots = nothing changed. */
export function wcIdentifierSnapshot(meta: unknown, globalUniqueId: unknown, isVariation: boolean): string {
  return JSON.stringify({ store: getMeta(meta, yoastIdentifierKey(isVariation)) ?? null, guid: typeof globalUniqueId === 'string' ? globalUniqueId.trim() : null })
}
