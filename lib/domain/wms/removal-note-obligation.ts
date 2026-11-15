/**
 * THE MERGED-LINE REMOVAL NOTE, AS A DURABLE OBLIGATION.
 *
 * After IMS removes a cancelled order's lines from a merged warehouse order it owes the warehouse ONE note naming them. The link is closed
 * (CANCELLED) once the removal is verified and a CANCELLED link is never revisited, so the note cannot live on the link: it is a row in
 * `settings`, one per link, written BEFORE the first remote delete and driven through these states:
 *
 *   intended    written before any delete; the lines named are the ones about to be removed. Not yet known to be removed.
 *   owed        the removal is verified (or the lines are confirmed absent): the note is to be posted.
 *   needs_check the note may or may not have reached the warehouse (an uncertain answer, a crash after a send, comments that cannot be
 *               read): NEVER re-posted blind; an operator looks at the warehouse order's comments (the sweep raises it once, see below).
 *
 * `attempted` is set (and persisted) BEFORE a send and cleared only by a definite "not sent" answer, so a crash or an uncertain answer
 * after a send leaves it set and the next sweep checks the order's comments for the marker instead of posting again.
 *
 * NO PERSONAL DATA is kept: ids, SKUs and quantities only. The order number is read from the order at post time, and an erased order's
 * obligation is dropped, never posted.
 */

export const REMOVAL_NOTE_KEY_PREFIX = 'wms_order_push_removal_note:'

export type RemovalNoteState = 'intended' | 'owed' | 'needs_check'
export type RemovalNoteItem = { externalItemId: string; sku: string; quantity: number }
export type WmsRemovalNoteObligation = {
  /** Stable for the life of the obligation; part of the marker the note carries. */
  id: string
  linkId: string
  orderId: string
  /** The warehouse order the lines were on: the note is posted there and only there. */
  externalOrderId: string
  state: RemovalNoteState
  /** A send may have gone out (see above). */
  attempted: boolean
  items: RemovalNoteItem[]
  /** Why it needs a check (no personal data). */
  detail?: string
}

export function removalNoteKey(connector: string, linkId: string): string {
  return `${REMOVAL_NOTE_KEY_PREFIX}${connector}:${linkId}`
}

/** The text a note carries so a re-read of the order's comments can prove it was posted. FIRST in the note: the connector truncates a long comment from the end. */
export function removalNoteMarker(note: Pick<WmsRemovalNoteObligation, 'id' | 'linkId'>): string {
  return `[IMS removal-note ${note.linkId}-${note.id}]`
}

export function serializeRemovalNote(note: WmsRemovalNoteObligation): string {
  return JSON.stringify(note)
}

/** Null for anything that is not a well-formed obligation: an unreadable one is never posted. */
export function parseRemovalNote(value: string): WmsRemovalNoteObligation | null {
  try {
    const p = JSON.parse(value) as Partial<WmsRemovalNoteObligation>
    const states: RemovalNoteState[] = ['intended', 'owed', 'needs_check']
    if (typeof p.id !== 'string' || typeof p.linkId !== 'string' || typeof p.orderId !== 'string' || typeof p.externalOrderId !== 'string') return null
    if (!p.state || !states.includes(p.state) || typeof p.attempted !== 'boolean' || !Array.isArray(p.items)) return null
    const items: RemovalNoteItem[] = []
    for (const item of p.items) {
      if (!item || typeof item.externalItemId !== 'string' || typeof item.sku !== 'string' || typeof item.quantity !== 'number') return null
      items.push({ externalItemId: item.externalItemId, sku: item.sku, quantity: item.quantity })
    }
    return { id: p.id, linkId: p.linkId, orderId: p.orderId, externalOrderId: p.externalOrderId, state: p.state, attempted: p.attempted, items, ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) }
  } catch {
    return null
  }
}
