/**
 * o3d-h2wx — a follow-up's remote idempotency token must survive REGENERATION of its
 * AccountingSyncLog row.
 *
 * THE HAZARD. Both accounting connectors derive the token they send to the remote system
 * from the sync entry's own row id:
 *
 *   QuickBooks  buildQboRequestId(getIdempotencySource(entryId, ...))  -> Request-Id
 *   Xero        buildXeroIdempotencyKey(entryId, operation)            -> Idempotency-Key
 *
 * `hasExistingSyncLog` only counts PENDING / PROCESSING / SYNCED rows, so a FAILED
 * follow-up does not block a re-enqueue — it creates a NEW row with a NEW id, and
 * therefore a token the remote system has never seen. The back-reference repair sweeps in
 * both connectors re-enqueue follow-ups exactly this way.
 *
 * If the FAILED attempt had in fact COMMITTED remotely (response lost, or the local status
 * write failed after the call returned), the replacement posts under the fresh token and a
 * SECOND payment lands against the same invoice. Per-entry idempotency is real; it just
 * does not survive regenerating the entry.
 *
 * THE FIX, in two layers:
 *
 *  1. REUSE the FAILED row instead of creating a replacement. This preserves the row id,
 *     and therefore preserves every token derived from it — including tokens stamped
 *     before this module existed, which is the only thing that can protect rows already
 *     sitting FAILED in the database today.
 *  2. STAMP a stable `_idempotencyKey` on newly created follow-ups, derived from the
 *     follow-up's LOGICAL identity rather than its row id. Both connectors' builders
 *     already prefer `payload._idempotencyKey`, so this survives the FAILED row being
 *     purged by retention (o3d-nepa) or otherwise going missing.
 *
 * Layer 1 alone leaves purged rows exposed; layer 2 alone cannot help a row enqueued
 * before the deploy. Together they close both.
 */

export type FollowUpPayload = Record<string, unknown>

export const FOLLOW_UP_IDEMPOTENCY_KEY = '_idempotencyKey'

/**
 * External-document ids that anchor the token to the thing being acted on. Both are stable
 * across a re-enqueue (the repair sweeps pass the same external id back in), so including
 * them costs no idempotency — but they DO separate a genuinely different target, e.g. an
 * order whose invoice was deleted and re-posted, where reusing the token would make the
 * remote system hand back the payment against the OLD invoice and we would record a
 * settlement that never happened.
 *
 * Deliberately excludes amounts and dates: the case this protects is a RETRY of the same
 * settlement, where a recomputed amount must NOT rotate the token.
 */
const ANCHOR_FIELDS = ['accountingInvoiceId', 'creditNoteId'] as const

export type FollowUpIdentity = {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  payload: FollowUpPayload
}

function anchorOf(payload: FollowUpPayload, field: string): string {
  const value = payload[field]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The stable source string a follow-up's remote token is derived from. Contains no row id
 * by construction — regenerating the row cannot change it.
 *
 * Scoped to (connector, type, referenceType, referenceId), which is exactly the uniqueness
 * the `accounting_sync_logs_followup_live_unique` partial index already enforces for live
 * follow-ups: there is never more than one legitimate follow-up per scope, so a shared
 * token across regenerations is the correct semantics, not an over-broad one.
 */
export function buildFollowUpIdempotencySource(identity: FollowUpIdentity): string {
  const { connector, type, referenceType, referenceId, payload } = identity
  const anchors = ANCHOR_FIELDS.map((field) => anchorOf(payload, field))
  return ['followup', connector, type, referenceType, referenceId, ...anchors].join(':')
}

function hasUsableKey(payload: FollowUpPayload): boolean {
  const existing = payload[FOLLOW_UP_IDEMPOTENCY_KEY]
  // A blank string is not a token — both connectors' builders fall through on it, so
  // treating it as present would leave the row deriving from its row id after all.
  return typeof existing === 'string' && existing.trim().length > 0
}

/**
 * Returns the payload to persist, with a stable `_idempotencyKey` stamped on it. An
 * existing usable key is never overwritten — rotating a token is the defect, not the fix.
 */
export function withFollowUpIdempotencyKey(identity: FollowUpIdentity): FollowUpPayload {
  if (hasUsableKey(identity.payload)) return identity.payload
  return { ...identity.payload, [FOLLOW_UP_IDEMPOTENCY_KEY]: buildFollowUpIdempotencySource(identity) }
}

export type FollowUpEnqueuePlan =
  | { action: 'skip' }
  | { action: 'reuse'; syncLogId: string; payload: FollowUpPayload }
  | { action: 'create'; payload: FollowUpPayload }

export type FollowUpEnqueueInput = FollowUpIdentity & {
  /** A PENDING / PROCESSING / SYNCED row already owns this follow-up. */
  liveRowExists: boolean
  /** The most recent FAILED row for this scope, if one survives. */
  failedRow: { id: string; payload: unknown } | null
}

/**
 * Pure enqueue decision, so the row-id-preservation rule is testable without a database.
 * The caller does the I/O implied by the returned plan.
 */
export function planFollowUpEnqueue(input: FollowUpEnqueueInput): FollowUpEnqueuePlan {
  if (input.liveRowExists) return { action: 'skip' }

  if (input.failedRow) {
    // Reuse. The row id is preserved, so a token derived from it is already stable and
    // must be left exactly as it was: carry the stored key forward if the row has one, and
    // stamp NOTHING if it does not. Stamping a key onto a legacy row would change the
    // token it already posted under and re-open the double-pay window.
    const stored = input.failedRow.payload
    const storedKey = typeof stored === 'object' && stored !== null
      ? (stored as FollowUpPayload)[FOLLOW_UP_IDEMPOTENCY_KEY]
      : undefined
    // The rest of the payload is the FRESH one — only the token is pinned backwards.
    const { [FOLLOW_UP_IDEMPOTENCY_KEY]: _discarded, ...rest } = input.payload
    const payload: FollowUpPayload = typeof storedKey === 'string' && storedKey.trim().length > 0
      ? { ...rest, [FOLLOW_UP_IDEMPOTENCY_KEY]: storedKey }
      : rest
    return { action: 'reuse', syncLogId: input.failedRow.id, payload }
  }

  return { action: 'create', payload: withFollowUpIdempotencyKey(input) }
}
