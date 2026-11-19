/**
 * The WooCommerce tariff codes the product import MIRRORS (owner decision D5: WooCommerce keeps classifying, IMS never recomputes):
 *
 *   - `pa_us_hs_code`: the US tariff code, a product attribute (`wcUsHsCode`).
 *   - `_dutify_hs_codes`: the per-destination map the wclc / Dutify capture writes, product meta keyed by ISO-2 country, each entry
 *     `{ code, hash, at, source }` (`wcDutifyHsCodes`, stored as `{ "US": "3921905050" }`).
 *
 * PRECEDENCE. `Product.hsCode` (the store's own approved code, mirrored from the `hs_code` attribute under the existing WC-wins trade-field
 * policy, and editable in IMS) is a different thing and is NEVER written from either of these. The two mirrored columns are owned by this
 * import alone: they follow WooCommerce on every sync (a removed code clears), and nothing in IMS edits them.
 */
import type { WcFullProduct } from './types'

export const WC_US_HS_CODE_ATTRIBUTE = 'pa_us_hs_code'
export const WC_DUTIFY_HS_CODES_META_KEY = '_dutify_hs_codes'

export type WcHsCodeMirror = {
  wcUsHsCode: string | null
  wcDutifyHsCodes: Record<string, string> | null
}

const HS_CODE_SHAPE = /^\d[\d. -]{2,16}\d$/

function cleanCode(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return HS_CODE_SHAPE.test(text) ? text : null
}

function normaliseName(name: unknown): string {
  return typeof name === 'string' ? name.toLowerCase().replace(/[_\s-]+/g, '') : ''
}

/** The `pa_us_hs_code` attribute's first option, or null. */
function readUsHsCode(attributes: WcFullProduct['attributes']): string | null {
  const wanted = new Set(['paushscode', 'ushscode'])
  for (const attribute of attributes) {
    const slug = (attribute as { slug?: unknown }).slug
    if (!wanted.has(normaliseName(slug)) && !wanted.has(normaliseName(attribute?.name))) continue
    const options = Array.isArray(attribute.options) ? attribute.options : []
    for (const option of options) {
      const code = cleanCode(option)
      if (code) return code
    }
  }
  return null
}

function readDutifyCodes(meta: WcFullProduct['meta_data']): Record<string, string> | null {
  const raw = meta.find((m) => m?.key === WC_DUTIFY_HS_CODES_META_KEY)?.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [country, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z]{2}$/.test(country)) continue
    const code = cleanCode(entry && typeof entry === 'object' ? (entry as { code?: unknown }).code : entry)
    if (code) out[country.toUpperCase()] = code
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * What to write for the two mirrored columns, per column: `undefined` when the payload does not carry the list that column is read from
 * (attributes / meta_data absent: leave IMS alone), `null` when WooCommerce carries none (clear), else the mirrored value.
 */
export function readWcHsCodeMirror(product: Pick<WcFullProduct, 'attributes' | 'meta_data'>): { wcUsHsCode?: string | null; wcDutifyHsCodes?: Record<string, string> | null } {
  const out: { wcUsHsCode?: string | null; wcDutifyHsCodes?: Record<string, string> | null } = {}
  if (Array.isArray(product.attributes)) out.wcUsHsCode = readUsHsCode(product.attributes)
  if (Array.isArray(product.meta_data)) out.wcDutifyHsCodes = readDutifyCodes(product.meta_data)
  return out
}
