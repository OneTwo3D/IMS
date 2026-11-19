/**
 * THE REVIEWED ACKNOWLEDGEMENT OF STOCK-DRIFT EVENTS (switchover step W, evidence STOCK_DRIFT).
 *
 * The observer (stock-drift.ts) records every storefront stock change nothing explains, and `writers:check` counts the events since the owner's Qoblex
 * confirmation. One manual WooCommerce edit after go-live would otherwise fail the check for good, until a new attestation. An operator who has LOOKED at
 * an event (who edited it, why) acknowledges it here: the event stays in the table with who, when and why, and an activity-log entry is written, but the
 * reader no longer counts it. Acknowledging never deletes an event and never touches the store.
 */
import { logActivity } from '@/lib/activity-log'

export const STOCK_DRIFT_ACK_NOTE_MAX = 500

export type StockDriftAckDb = {
  wcStockDriftEvent: {
    findMany(args: { where: { acknowledgedAt: null; id?: { in: string[] } }; orderBy: { observedAt: 'asc' }; select: { id: true; externalProductId: true; sku: true; fromQuantity: true; toQuantity: true; observedAt: true; acknowledgedAt: true } }): Promise<Array<{ id: string; externalProductId: string; sku: string | null; fromQuantity: number | null; toQuantity: number | null; observedAt: Date }>>
    updateMany(args: { where: { id: { in: string[] }; acknowledgedAt: null }; data: { acknowledgedAt: Date; acknowledgedBy: string; acknowledgedNote: string } }): Promise<{ count: number }>
  }
}

export type StockDriftAckResult = { ok: true; acknowledged: number } | { ok: false; error: string }

/** Acknowledge the given unacknowledged events (or, with `ids` undefined, none: the caller lists first). A reason and a name are required. */
export async function acknowledgeStockDriftEvents(
  db: StockDriftAckDb,
  input: { ids: string[]; by: string; note: string; now?: Date },
  audit: typeof logActivity = logActivity,
): Promise<StockDriftAckResult> {
  const by = input.by.trim()
  const note = input.note.trim()
  if (by === '') return { ok: false, error: 'Say who reviewed the event(s) (--by).' }
  if (note === '') return { ok: false, error: 'Say why the event(s) are explained (--note): an acknowledgement needs a reason.' }
  if (note.length > STOCK_DRIFT_ACK_NOTE_MAX) return { ok: false, error: `The note is longer than ${STOCK_DRIFT_ACK_NOTE_MAX} characters.` }
  if (input.ids.length === 0) return { ok: false, error: 'No event selected.' }
  const events = await db.wcStockDriftEvent.findMany({
    where: { acknowledgedAt: null, id: { in: input.ids } }, orderBy: { observedAt: 'asc' },
    select: { id: true, externalProductId: true, sku: true, fromQuantity: true, toQuantity: true, observedAt: true, acknowledgedAt: true },
  })
  if (events.length === 0) return { ok: false, error: 'None of those events exists or is still unacknowledged.' }
  const at = input.now ?? new Date()
  const { count } = await db.wcStockDriftEvent.updateMany({ where: { id: { in: events.map((event) => event.id) }, acknowledgedAt: null }, data: { acknowledgedAt: at, acknowledgedBy: by, acknowledgedNote: note } })
  await audit({
    entityType: 'SYSTEM', action: 'wc_stock_drift_acknowledged', tag: 'switchover', level: 'WARNING', resolveUser: false,
    description: `${count} WooCommerce stock-drift event(s) acknowledged by ${by}: ${note}`,
    metadata: { by, note, events: events.map((event) => ({ id: event.id, productId: event.externalProductId, sku: event.sku, from: event.fromQuantity, to: event.toQuantity, observedAt: event.observedAt.toISOString() })) },
  })
  return { ok: true, acknowledged: count }
}
