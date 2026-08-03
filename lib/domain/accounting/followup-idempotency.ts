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
 *     and therefore preserves every token derived from it — including rows already sitting
 *     FAILED in the database today, which no new payload field can reach.
 *  2. STAMP a stable `_followUpIdempotencyKey` on newly created follow-ups, derived from
 *     the follow-up's LOGICAL identity rather than its row id, so the token survives the
 *     FAILED row being purged by retention (o3d-nepa) or otherwise going missing.
 *
 * Layer 1 alone leaves purged rows exposed; layer 2 alone cannot help a row enqueued
 * before the deploy. Together they close both.
 *
 * WHY NOT REUSE THE EXISTING `_idempotencyKey` FIELD. It is already populated on rows this
 * module does not own: `addPayment` queues an INVOICE_PAYMENT through the generic
 * `queueAccountingSyncTx` with `invoice-payment:payment:<paymentId>`. Xero's payment
 * branches have always IGNORED that field (they never passed `payload` to the builder), so
 * teaching them to read it would have CHANGED the token of every manual-receipt payment
 * already in flight at deploy time — manufacturing the exact double-post window this fix
 * exists to close (Codex review, r1 blocker). A separate field is only ever set by this
 * module, so a pre-existing row keeps deriving its token exactly as it did before.
 */

export type FollowUpPayload = Record<string, unknown>

/** Set ONLY by this module. Never conflated with the generic queue's `_idempotencyKey`. */
export const FOLLOW_UP_IDEMPOTENCY_KEY = '_followUpIdempotencyKey'

/**
 * Follow-ups whose remote call MOVES MONEY, so a duplicate is a real financial error that
 * needs a manual reversal in the ledger. These get the strict treatment: the request body
 * is pinned alongside the token, and an ambiguous history refuses rather than guesses.
 */
const MONEY_MOVING_FOLLOW_UP_TYPES = new Set(['INVOICE_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION'])

export function isMoneyMovingFollowUp(type: string): boolean {
  return MONEY_MOVING_FOLLOW_UP_TYPES.has(type)
}

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

function asPayload(value: unknown): FollowUpPayload | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as FollowUpPayload)
    : null
}

function anchorOf(payload: FollowUpPayload, field: string): string {
  const value = payload[field]
  return typeof value === 'string' ? value.trim() : ''
}

function anchorsOf(payload: FollowUpPayload): string[] {
  return ANCHOR_FIELDS.map((field) => anchorOf(payload, field))
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
  return ['followup', connector, type, referenceType, referenceId, ...anchorsOf(payload)].join(':')
}

/**
 * The follow-up token a connector should derive its remote key from, or undefined when the
 * row predates this module and must keep deriving from its own id.
 */
export function readFollowUpIdempotencyKey(payload: unknown): string | undefined {
  const value = asPayload(payload)?.[FOLLOW_UP_IDEMPOTENCY_KEY]
  // A blank string is not a token — treating it as present would silently drop the row's
  // only stable identity.
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Returns the payload to persist, with a stable follow-up key stamped on it. An existing
 * usable key is never overwritten — rotating a token is the defect, not the fix.
 */
export function withFollowUpIdempotencyKey(identity: FollowUpIdentity): FollowUpPayload {
  if (readFollowUpIdempotencyKey(identity.payload)) return identity.payload
  return { ...identity.payload, [FOLLOW_UP_IDEMPOTENCY_KEY]: buildFollowUpIdempotencySource(identity) }
}

export type FollowUpEnqueuePlan =
  | { action: 'skip' }
  /** An ambiguous history that must not be auto-reposted; the caller warns and stops. */
  | { action: 'refuse'; reason: string }
  | { action: 'reuse'; syncLogId: string; payload: FollowUpPayload; divergedFields: string[] }
  | { action: 'create'; payload: FollowUpPayload }

export type FailedFollowUpRow = { id: string; payload: unknown; createdAt?: Date | null }

export type FollowUpEnqueueInput = FollowUpIdentity & {
  /** A PENDING / PROCESSING / SYNCED row already owns this follow-up. */
  liveRowExists: boolean
  /** Every surviving FAILED row for this scope, newest first. */
  failedRows: FailedFollowUpRow[]
}

/** Fields whose value defines the remote request, so a divergence is worth reporting. */
const REQUEST_DEFINING_FIELDS = [
  'accountingInvoiceId',
  'creditNoteId',
  'bankAccountId',
  'amount',
  'currency',
  'paymentDate',
  'date',
  'method',
  'reference',
  'customerRef',
] as const

function divergedRequestFields(stored: FollowUpPayload, fresh: FollowUpPayload): string[] {
  return REQUEST_DEFINING_FIELDS.filter((field) => {
    const a = stored[field]
    const b = fresh[field]
    if (a === undefined && b === undefined) return false
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  })
}

/**
 * Pure enqueue decision, so the row-id-preservation rule is testable without a database.
 * The caller does the I/O implied by the returned plan.
 */
export function planFollowUpEnqueue(input: FollowUpEnqueueInput): FollowUpEnqueuePlan {
  if (input.liveRowExists) return { action: 'skip' }

  const failedRows = input.failedRows
  if (failedRows.length === 0) return { action: 'create', payload: withFollowUpIdempotencyKey(input) }

  // Pre-fix behaviour created a REPLACEMENT row after every failure, and FAILED rows are
  // outside the live-follow-up unique index, so a scope can already hold several — each
  // with its own token, since a row without a stamped key derives from its own id. Any of
  // them may be the one that ambiguously committed, and picking the newest is a guess. For
  // money movement a guess is not good enough: refuse and let an operator settle it
  // (Codex review, r1 #4).
  if (failedRows.length > 1 && isMoneyMovingFollowUp(input.type)) {
    return {
      action: 'refuse',
      reason: `${failedRows.length} FAILED ${input.type} rows exist for this reference, each posted under a `
        + 'different idempotency token. Any one of them may have committed remotely, so an automatic '
        + 'retry could duplicate it. Reconcile them in the ledger and resolve the rows manually.',
    }
  }

  const failedRow = failedRows[0]!
  const stored = asPayload(failedRow.payload)
  const storedKey = readFollowUpIdempotencyKey(stored)

  // A different target document means the failed attempt cannot have committed the thing
  // we are about to post, so its token must NOT be carried forward — that would make the
  // remote system hand back the OLD document and we would record a settlement that never
  // happened. Stamp a fresh anchored key instead (Codex review, r1 #2).
  // Compared element-wise rather than by joining: an anchor value containing whatever
  // separator was chosen would otherwise make two different targets look identical.
  const freshAnchors = anchorsOf(input.payload)
  const targetChanged = stored !== null
    && anchorsOf(stored).some((anchor, index) => anchor !== freshAnchors[index])
  if (targetChanged) {
    return {
      action: 'reuse',
      syncLogId: failedRow.id,
      payload: withFollowUpIdempotencyKey(input),
      divergedFields: divergedRequestFields(stored, input.payload),
    }
  }

  // Same target: the token is pinned backwards, either explicitly or implicitly via the
  // preserved row id.
  //
  // For a money-moving follow-up the BODY is pinned with it. Posting a recomputed amount
  // under a token the remote system has already seen would return the ORIGINAL payment and
  // we would record a settlement for an amount never posted — local evidence that disagrees
  // with the ledger (Codex review, r1 #3). The divergence is reported so an operator can
  // see a genuine correction was suppressed.
  const divergedFields = stored ? divergedRequestFields(stored, input.payload) : []
  if (stored && isMoneyMovingFollowUp(input.type)) {
    return { action: 'reuse', syncLogId: failedRow.id, payload: stored, divergedFields }
  }

  // Non-money follow-ups (PDF, email, note, attachment) are safe to re-drive with fresh
  // inputs. Carry the stored key if it has one; stamp NOTHING if it does not, because the
  // preserved row id already IS its stable token and stamping would rotate it.
  const { [FOLLOW_UP_IDEMPOTENCY_KEY]: _discarded, ...rest } = input.payload
  const payload: FollowUpPayload = storedKey ? { ...rest, [FOLLOW_UP_IDEMPOTENCY_KEY]: storedKey } : rest
  return { action: 'reuse', syncLogId: failedRow.id, payload, divergedFields }
}
