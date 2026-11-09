/**
 * THE `components` CELL OF THE PRODUCTS CSV: `COMPONENT-SKU:qty;OTHER-SKU:qty`.
 *
 * Each part is read strictly. `parseFloat` reads a numeric prefix, so `1,5` loaded as 1, `2 units` as 2 and `3abc` as 3, and a part
 * with no `:` silently took quantity 1: a recipe line with the wrong quantity landed with nothing reported, and a BOM with the wrong
 * quantity under-picks every build. A part is now `SKU:qty` and nothing else; the quantity is a plain positive decimal with at most
 * four decimal places (the column is NUMERIC(12,4)), a point for the decimal mark, no sign, no exponent, no thousands separator.
 * Anything else is refused by name, and the importer then refuses the whole recipe for the row, as it does for an unknown SKU.
 */

export type ComponentCellPart =
  | { ok: true; sku: string; qty: number }
  | { ok: false; sku: string; reason: string }

const PLAIN_QTY = /^\d{1,8}(?:\.\d{1,4})?$/

/** The quantity text of one recipe line as a number, or the reason it is refused. */
export function parseComponentQty(raw: string): { ok: true; qty: number } | { ok: false; reason: string } {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'the quantity is empty' }
  if (!PLAIN_QTY.test(text)) {
    return { ok: false, reason: 'the quantity must be a plain number with a point for the decimal mark and at most 4 decimal places (no sign, no exponent, no comma or text)' }
  }
  const qty = Number(text)
  if (!(qty > 0)) return { ok: false, reason: 'the quantity must be greater than zero' }
  return { ok: true, qty }
}

/** Split a `components` cell into its parts. Blank parts (a trailing `;`) are ignored, as they always were. */
export function parseComponentsCell(cell: string): ComponentCellPart[] {
  const parts = cell.split(';').map((s) => s.trim()).filter(Boolean)
  return parts.map((part): ComponentCellPart => {
    const pieces = part.split(':').map((s) => s.trim())
    const sku = pieces[0] ?? ''
    if (pieces.length !== 2) {
      return { ok: false, sku, reason: pieces.length === 1 ? 'a part must be SKU:qty (no ":" found)' : 'a part must be SKU:qty (more than one ":" found)' }
    }
    if (sku === '') return { ok: false, sku, reason: 'the component SKU is empty' }
    const qty = parseComponentQty(pieces[1]!)
    return qty.ok ? { ok: true, sku, qty: qty.qty } : { ok: false, sku, reason: qty.reason }
  })
}
