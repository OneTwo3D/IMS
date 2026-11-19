/**
 * WHAT WOOCOMMERCE SHOWED FOR AN ORDER'S LINES (SalesOrder.wcSeenLines), kept so the order-amendment step can answer two questions the IMS lines cannot:
 *
 *  - "LATEST EDIT WINS": at the first IMS line edit the baseline is what WooCommerce showed THEN (`wcLineBaseline.wcLines`, copied from here), not IMS's own lines. A WooCommerce change that
 *    IMS had not acted on before the edit (unpaid order, flag off, picking started) is then not mistaken for a change made after the edit.
 *  - TWO DELIVERIES IN ONE SECOND: WooCommerce's modified time has one-second resolution, so the stale check cannot order them. Two deliveries with the same time but a different line digest
 *    are ambiguous, and the step acts on neither until a later delivery settles it.
 *
 * Pure. Quantities and WooCommerce item ids only (no name, address or free text).
 */
import { createHash } from 'node:crypto'

export type WcSeenLines = { at: string | null; digest: string; lines: Array<{ externalLineItemId: number; qty: number }> }

type WcLike = { date_modified_gmt?: unknown; date_modified?: unknown; line_items?: unknown }

export function buildWcSeenLines(wcOrder: WcLike): WcSeenLines {
  const byId = new Map<number, number>()
  for (const item of (Array.isArray(wcOrder.line_items) ? wcOrder.line_items : []) as Array<{ id?: unknown; quantity?: unknown }>) {
    if (typeof item?.id === 'number' && typeof item.quantity === 'number') byId.set(item.id, (byId.get(item.id) ?? 0) + item.quantity)
  }
  const lines = [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([externalLineItemId, qty]) => ({ externalLineItemId, qty }))
  const at = String(wcOrder.date_modified_gmt || wcOrder.date_modified || '') || null
  return { at, digest: createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 16), lines }
}

export function parseWcSeenLines(value: unknown): WcSeenLines | null {
  const v = value as { at?: unknown; digest?: unknown; lines?: unknown } | null
  if (!v || typeof v.digest !== 'string' || !Array.isArray(v.lines)) return null
  const lines: WcSeenLines['lines'] = []
  for (const l of v.lines as Array<{ externalLineItemId?: unknown; qty?: unknown }>) {
    if (typeof l?.externalLineItemId === 'number' && typeof l.qty === 'number') lines.push({ externalLineItemId: l.externalLineItemId, qty: l.qty })
  }
  return { at: typeof v.at === 'string' ? v.at : null, digest: v.digest, lines }
}

/**
 * Two deliveries carry the SAME modified time but show different lines: which is newer cannot be told. A delivery with a different time (or the very first one) is not ambiguous.
 * Pure.
 */
export function isSameSecondConflict(previous: WcSeenLines | null, incoming: WcSeenLines): boolean {
  return previous !== null && previous.at !== null && previous.at === incoming.at && previous.digest !== incoming.digest
}

/** True when `incoming` is older than what was already seen (an out-of-order delivery must not overwrite the seen state). */
export function isOlderThanSeen(previous: WcSeenLines | null, incoming: WcSeenLines): boolean {
  if (!previous?.at || !incoming.at) return false
  const a = Date.parse(`${previous.at}${/[zZ]|[+-]\d\d:?\d\d$/.test(previous.at) ? '' : 'Z'}`)
  const b = Date.parse(`${incoming.at}${/[zZ]|[+-]\d\d:?\d\d$/.test(incoming.at) ? '' : 'Z'}`)
  return Number.isFinite(a) && Number.isFinite(b) && b < a
}

/**
 * The WooCommerce quantities to store in the baseline at the first IMS line edit: what WooCommerce showed (the seen lines), or, when nothing was seen yet, IMS's own lines (which equal the import's
 * until an IMS edit, since IMS never adopts a WooCommerce line change). Pure.
 */
export function wcLinesAtEdit(seen: unknown, imsLines: ReadonlyArray<{ externalLineItemId: number | null; qty: unknown }>): Array<{ externalLineItemId: number; qty: number }> {
  const parsed = parseWcSeenLines(seen)
  if (parsed) return parsed.lines
  const byId = new Map<number, number>()
  for (const l of imsLines) if (l.externalLineItemId !== null) byId.set(l.externalLineItemId, (byId.get(l.externalLineItemId) ?? 0) + Number(l.qty))
  return [...byId.entries()].map(([externalLineItemId, qty]) => ({ externalLineItemId, qty }))
}
