/**
 * THE MERGED-LINE REMOVAL OBLIGATION.
 *
 * After IMS removes a cancelled order's lines from a merged warehouse order the removal is recorded durably, because the link is closed
 * (CANCELLED) once the removal is verified and a CANCELLED link is never revisited. It is a row in `settings`, one per link, written BEFORE
 * the first remote delete and driven through these states:
 *
 *   intended    written before any delete; the lines named are the ones about to be removed. Not yet known to be removed.
 *   owed        the removal is verified (or the lines are confirmed absent): the operator task "raise a query" is to be raised (and is
 *               raised in the same step), and the link closed.
 *   needs_check a PARTIAL removal (only some of the recorded lines are gone) or one that could not be read. It keeps the link OPEN and stops
 *               the removal being retried over it, until an operator has the warehouse take the rest out and presses Done on its
 *               partial-removal-check task (which re-reads the order, closes the link and deletes this row in one transaction).
 *               `taskRaised` is set once that task exists. (A row left by the earlier posting design, with `verified`, is a verified removal
 *               and is turned into a task and deleted; one without it is a partial removal and gets its task.)
 *
 * IMS writes no comment to the warehouse order any more (the warehouse does not read them), so nothing here tracks a post.
 *
 * NO PERSONAL DATA is kept: ids, SKUs and quantities only. An erased order's obligation is dropped.
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
  /** True once the removal of these lines was VERIFIED on `externalOrderId` (set when it becomes owed). A needs_check row without it came from a PARTIAL interrupted removal and must never close a link. */
  verified?: boolean
  items: RemovalNoteItem[]
  /** Why it needs a check (no personal data). */
  detail?: string
  /** The operator task for this row has been raised (set with needs_check); the sweep does not raise it again. */
  taskRaised?: boolean
}

/**
 * One obligation per (link, warehouse order). The note belongs to the warehouse order the removal was verified on; the dispatch sweep can
 * re-point a link at another warehouse order, and keying by that order keeps an obligation for the old order from ever being mistaken for
 * (or overwritten by) one for the new order.
 */
export function removalNoteKey(connector: string, linkId: string, externalOrderId: string): string {
  return `${REMOVAL_NOTE_KEY_PREFIX}${connector}:${linkId}:${externalOrderId}`
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
    if (!p.state || !states.includes(p.state) || !Array.isArray(p.items)) return null
    const items: RemovalNoteItem[] = []
    for (const item of p.items) {
      if (!item || typeof item.externalItemId !== 'string' || typeof item.sku !== 'string' || typeof item.quantity !== 'number') return null
      items.push({ externalItemId: item.externalItemId, sku: item.sku, quantity: item.quantity })
    }
    return { id: p.id, linkId: p.linkId, orderId: p.orderId, externalOrderId: p.externalOrderId, state: p.state, items, ...(p.verified === true ? { verified: true } : {}), ...(typeof p.detail === 'string' ? { detail: p.detail } : {}), ...(p.taskRaised === true ? { taskRaised: true } : {}) }
  } catch {
    return null
  }
}
