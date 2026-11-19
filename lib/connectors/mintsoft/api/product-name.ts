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
 * The name IMS sends for a variation under the parity setting. IMS stores a variation's name as `<parent name> — <a / b>` (the
 * WooCommerce import's own format). OWNER DECISION 2026-11-18: keep the retired plugin's `<parent> (a, b)` format so nothing already
 * held in Mintsoft is renamed at cutover. So the attributes are re-rendered as ` (a, b)` and that whole text is the suffix that is
 * kept whole while the parent is cut. A name that does not start `<parent> — ` (or a product with no parent) has no separable
 * suffix and is fitted as a plain name, which is what the plugin did for a simple product.
 */
export function fitMintsoftProductName(name: string, parentName: string | null | undefined, sku: string, parentOptionValues?: ReadonlyArray<string>): string {
  const parent = parentName?.trim() ?? ''
  const separator = ' — '
  if (parent && name.startsWith(`${parent}${separator}`) && name.length > parent.length + separator.length) {
    const attributes = splitAttributeValues(name.slice(parent.length + separator.length), parentOptionValues).join(', ')
    if (attributes) return fitMintsoftName(parent, ` (${attributes})`, sku)
  }
  return fitMintsoftName(name, '', sku)
}

/**
 * The attribute values of a stored variation name. IMS joins them with " / ", and a value may itself contain " / " ("Voron 2.4 / Trident"), so a plain split cannot tell the
 * separator from a slash inside a value. The structured values are the parent's option values (`product_options.values`, comma-separated): a run of pieces that
 * together spell a known value is kept as ONE value, longest match first. With no known values (or none matching) each piece stands alone, as before.
 */
export function splitAttributeValues(joined: string, parentOptionValues?: ReadonlyArray<string>): string[] {
  const pieces = joined.split(' / ').map((part) => part.trim()).filter(Boolean)
  const known = new Set((parentOptionValues ?? []).map((value) => value.trim()).filter((value) => value.includes(' / ')))
  if (known.size === 0) return pieces
  const maxRun = Math.max(...[...known].map((value) => value.split(' / ').length))
  const out: string[] = []
  for (let i = 0; i < pieces.length;) {
    let took = 1
    for (let run = Math.min(maxRun, pieces.length - i); run >= 2; run--) {
      if (known.has(pieces.slice(i, i + run).join(' / '))) { took = run; break }
    }
    out.push(pieces.slice(i, i + took).join(' / '))
    i += took
  }
  return out
}
