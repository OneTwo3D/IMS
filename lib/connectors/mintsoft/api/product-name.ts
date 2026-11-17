/**
 * THE MINTSOFT PRODUCT NAME LIMIT, PORTED FROM THE RETIRED PYTHON SYNC (`fit_mintsoft_name`).
 *
 * Mintsoft refuses a product Name of 100 or more characters with a bare "Invalid Data!" that does not say which field is wrong
 * (verified live 2026-09-19: six variations whose "Parent (Variant)" names ran 100-105 characters were all refused, the two at
 * 92/93 were accepted, and the longest Name among the tenant's 2,360 products is exactly 99).
 *
 * The rules are the plugin's, exactly:
 *
 *  - `suffix` is the part that tells records apart (a variation's attribute text). It is kept WHOLE; `name` (the parent) is cut.
 *  - The cut is at a word boundary when one is close (at or past half the cut), then trailing ` ,-/` are stripped and `...` added.
 *  - When the suffix alone leaves fewer than 10 characters for the parent, the variation's SKU stands in as the suffix (` (SKU)`),
 *    because truncating from the left would give every variation of a long parent the same Name. With no SKU the TAIL of the
 *    suffix is kept instead of its head.
 *  - Lengths are UTF-16 code units, the way Mintsoft (.NET) counts them. JavaScript strings are UTF-16, so `.length` is that
 *    count; cutting works on code points so a surrogate pair is never split.
 *  - Deterministic and idempotent: `fitMintsoftName(fitMintsoftName(x))` is `fitMintsoftName(x)`, so a name that is compared again
 *    on the next run is not rewritten on every sync.
 *
 * Used only behind `mintsoft_product_parity_enabled` (see settings/product-parity.ts); with it off IMS sends the name unchanged.
 */

export const MINTSOFT_NAME_MAX_LEN = 99
const ELLIPSIS = '...'
// Python's str.isspace(): Unicode whitespace plus the four information separators.
const PY_WHITESPACE = /[\s\u001c-\u001f]/u

function units(text: string): number {
  return text.length
}

function codePoints(text: string): string[] {
  return Array.from(text)
}

/** Longest prefix of `text` within `limit` UTF-16 units (never splits a character). */
function head(text: string, limit: number): string {
  let used = 0
  const out: string[] = []
  for (const ch of text) {
    used += ch.length
    if (used > limit) break
    out.push(ch)
  }
  return out.join('')
}

/** Longest suffix of `text` within `limit` UTF-16 units. */
function tail(text: string, limit: number): string {
  return codePoints(head(codePoints(text).reverse().join(''), limit)).reverse().join('')
}

function rstripSeparators(text: string): string {
  return text.replace(/[ ,\-/]+$/u, '')
}

export function fitMintsoftName(name: string, suffix = '', sku = ''): string {
  const full = `${name}${suffix}`
  if (units(full) <= MINTSOFT_NAME_MAX_LEN) return full

  const room = MINTSOFT_NAME_MAX_LEN - units(suffix) - ELLIPSIS.length
  if (room >= 10) {
    let cut = head(name, room)
    const cutPoints = codePoints(cut)
    const space = cut.lastIndexOf(' ')
    const spacePoints = space < 0 ? -1 : codePoints(cut.slice(0, space)).length
    const nextChar = codePoints(name)[cutPoints.length]
    const nextIsSpace = nextChar !== undefined && PY_WHITESPACE.test(nextChar)
    if (!nextIsSpace && spacePoints >= Math.floor(cutPoints.length / 2)) {
      cut = cut.slice(0, space)
    }
    return `${rstripSeparators(cut)}${ELLIPSIS}${suffix}`
  }

  const skuSuffix = sku ? ` (${sku})` : ''
  if (skuSuffix && suffix !== skuSuffix) return fitMintsoftName(name, skuSuffix)

  const nameHead = rstripSeparators(head(name, 20))
  const suffixTail = tail(suffix, MINTSOFT_NAME_MAX_LEN - units(nameHead) - ELLIPSIS.length)
  return `${nameHead}${ELLIPSIS}${suffixTail}`
}

/**
 * The name IMS sends for a variation under the parity setting. IMS stores a variation's name as `<parent name> — <attributes>`
 * (the WooCommerce import's own format), so the parent is the part that may be cut and ` — <attributes>` is the whole suffix. A
 * name that does not start that way (or a product with no parent) has no separable suffix and is fitted as a plain name, which is
 * what the plugin did for a simple product.
 */
export function fitMintsoftProductName(name: string, parentName: string | null | undefined, sku: string): string {
  const parent = parentName?.trim() ?? ''
  const separator = ' — '
  if (parent && name.startsWith(`${parent}${separator}`) && name.length > parent.length + separator.length) {
    return fitMintsoftName(parent, name.slice(parent.length), sku)
  }
  return fitMintsoftName(name, '', sku)
}
