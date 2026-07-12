import { createHash } from 'crypto'

/**
 * ShipHero pushes webhooks (the inverse of Mintsoft's poll model). These pure
 * helpers parse + classify an inbound event and rank its fulfillment status so the
 * writeback can refuse out-of-order regressions.
 *
 * Field names follow ShipHero's documented payloads but several are flagged
 * "verify on live tenant" in the reference plan — extractors therefore accept
 * several spellings/nestings defensively rather than a single hard-coded key.
 */

export const SHIPHERO_WEBHOOK_EVENT_TYPES = [
  'shipment_update',
  'order_allocated',
  'order_canceled',
  'inventory_update',
] as const

export type ShipheroWebhookEventType = (typeof SHIPHERO_WEBHOOK_EVENT_TYPES)[number]

/** Normalize a route/segment or payload event name to the canonical snake_case id. */
export function normalizeShipheroEventType(value: string | null | undefined): ShipheroWebhookEventType | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase().replace(/-/g, '_')
  // Accept the British 'cancelled' spelling for the cancel event.
  const canonical = normalized === 'order_cancelled' ? 'order_canceled' : normalized
  return (SHIPHERO_WEBHOOK_EVENT_TYPES as readonly string[]).includes(canonical)
    ? (canonical as ShipheroWebhookEventType)
    : null
}

export function isShipheroWebhookEventType(value: string | null | undefined): value is ShipheroWebhookEventType {
  return normalizeShipheroEventType(value) != null
}

/**
 * Monotonic rank for ShipHero `fulfillment_status`. Higher = more advanced in the
 * fulfilment lifecycle; the writeback refuses to apply an event whose rank is below
 * the highest already applied for the same order. `canceled` is terminal (ranks
 * highest) so a cancel always wins, even after fulfilment (post-ship cancel/refund).
 */
const FULFILLMENT_STATUS_RANK: Record<string, number> = {
  pending: 0,
  on_hold: 1,
  backorder: 1,
  partially_allocated: 2,
  allocated: 2,
  partially_fulfilled: 3,
  fulfilled: 4,
  canceled: 5,
}

export function normalizeShipheroFulfillmentStatus(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  return normalized === 'cancelled' ? 'canceled' : normalized
}

/** Rank a fulfillment_status, or null when unknown (an unknown status never blocks). */
export function rankShipheroFulfillmentStatus(value: string | null | undefined): number | null {
  const normalized = normalizeShipheroFulfillmentStatus(value)
  if (!normalized) return null
  return normalized in FULFILLMENT_STATUS_RANK ? FULFILLMENT_STATUS_RANK[normalized] : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstId(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** Dedupe key: a remote-provided event id, else a content hash of the raw body. */
export function extractShipheroEventId(payload: unknown, rawBody: string): string {
  const record = asRecord(payload)
  const direct = record ? firstId(record, ['webhook_id', 'event_id', 'id']) : null
  if (direct) return direct
  return createHash('sha256').update(rawBody).digest('hex')
}

/** Order ref (order_id / legacy_id), checking the top level and a nested `order`. */
export function extractShipheroOrderRef(payload: unknown): string | null {
  const record = asRecord(payload)
  if (!record) return null
  const top = firstId(record, ['order_id', 'legacy_id', 'order_legacy_id', 'order_number'])
  if (top) return top
  const order = asRecord(record.order)
  return order ? firstId(order, ['id', 'legacy_id', 'order_number']) : null
}

export function extractShipheroFulfillmentStatus(payload: unknown): string | null {
  const record = asRecord(payload)
  if (!record) return null
  const direct = record.fulfillment_status ?? record.status
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const order = asRecord(record.order)
  const nested = order?.fulfillment_status
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null
}

/**
 * Derive the fulfillment-status rank an event represents, using the event type as a
 * fallback when the payload omits an explicit status (an `order_canceled` event is a
 * cancel even if the body doesn't echo `fulfillment_status`). Returns null for events
 * with no order-status meaning (inventory_update).
 */
export function deriveShipheroStatusRank(eventType: ShipheroWebhookEventType, payload: unknown): number | null {
  if (eventType === 'inventory_update') return null
  const fromPayload = rankShipheroFulfillmentStatus(extractShipheroFulfillmentStatus(payload))
  if (fromPayload != null) return fromPayload
  if (eventType === 'order_canceled') return FULFILLMENT_STATUS_RANK.canceled
  if (eventType === 'order_allocated') return FULFILLMENT_STATUS_RANK.allocated
  return null
}
