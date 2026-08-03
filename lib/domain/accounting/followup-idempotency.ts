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

/**
 * Whether the remote token this attempt will carry is the one a previous attempt used
 * (`pinned`) or a newly derived one (`rotated`). Rotating is only ever safe when no
 * surviving attempt could have committed the thing we are about to post — the caller
 * reports which happened, and treats losing a PINNED row as a hard stop.
 */
export type TokenDisposition = 'pinned' | 'rotated'

export type FollowUpEnqueuePlan =
  | { action: 'skip' }
  /** An ambiguous history that must not be auto-reposted; the caller warns and stops. */
  | { action: 'refuse'; reason: string }
  | {
      action: 'reuse'
      syncLogId: string
      payload: FollowUpPayload
      tokenDisposition: TokenDisposition
      /** `pinned` = the stored request body was kept; `fresh` = the recomputed one is used. */
      bodyDisposition: 'pinned' | 'fresh'
      divergedFields: string[]
    }
  | { action: 'create'; payload: FollowUpPayload }

export type FailedFollowUpRow = {
  id: string
  payload: unknown
}

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
 * True when a surviving attempt could plausibly have committed the very thing we are about
 * to post — i.e. it targeted the SAME external document.
 *
 * An attempt with no recorded anchors at all is treated as MATCHING. We cannot tell what it
 * targeted, and for money movement "unknown" has to read as "possibly this one"; assuming
 * otherwise would rotate the token on exactly the legacy rows least able to survive it.
 */
function couldHaveCommittedThis(stored: FollowUpPayload | null, freshAnchors: string[]): boolean {
  if (stored === null) return true
  const storedAnchors = anchorsOf(stored)
  if (storedAnchors.every((anchor) => anchor === '')) return true
  // Compared element-wise rather than by joining: an anchor value containing whatever
  // separator was chosen would otherwise make two different targets look identical.
  return storedAnchors.every((anchor, index) => anchor === freshAnchors[index])
}

/**
 * Pure enqueue decision, so the row-id-preservation rule is testable without a database.
 * The caller does the I/O implied by the returned plan.
 */
export function planFollowUpEnqueue(input: FollowUpEnqueueInput): FollowUpEnqueuePlan {
  if (input.liveRowExists) return { action: 'skip' }

  const freshAnchors = anchorsOf(input.payload)
  const moneyMoving = isMoneyMovingFollowUp(input.type)

  // Narrow the history to attempts that could have committed THIS document. An attempt
  // against a DIFFERENT external document cannot have posted the one we are about to
  // (Codex review, r2 #2 — the earlier refusal fired on row COUNT alone and so blocked a
  // legitimate payment against a replacement invoice, permanently).
  //
  // An earlier revision ALSO excluded rows whose errorMessage looked like a pre-call
  // validation failure, on the grounds that such an attempt provably never posted. That was
  // REMOVED: errorMessage carries no provenance. Both connectors overwrite `HTTP nnn` with
  // the remote system's own message (quickbooks/api.ts, xero/api.ts), so a remote reply
  // reading "Missing account for PAYMENT" was indistinguishable from our own validation and
  // would have rotated the token of a request that may well have committed (Codex r3
  // blocker A). Inferring "no call was made" from free text is not sound, and the safe
  // reading is the one o3d-ju8t already established: FAILED does not prove nothing posted.
  const couldHaveCommitted = input.failedRows.filter((row) => couldHaveCommittedThis(asPayload(row.payload), freshAnchors))

  // Pre-fix behaviour created a REPLACEMENT row after every failure, and FAILED rows are
  // outside the live-follow-up unique index, so a scope can hold several — each with its own
  // token, since a row without a stamped key derives from its own id. When more than one
  // could have committed THIS document, any of them might be the one that did, and picking
  // the newest is a guess. For money movement a guess is not good enough (Codex r1 #4).
  if (couldHaveCommitted.length > 1 && moneyMoving) {
    return {
      action: 'refuse',
      reason: `${couldHaveCommitted.length} FAILED ${input.type} rows for this reference each targeted this same `
        + 'document under a different idempotency token. Any one of them may have committed remotely, so an '
        + 'automatic retry could duplicate it. Reconcile them in the ledger and resolve the rows manually.',
    }
  }

  const pinnable = couldHaveCommitted[0]
  if (pinnable) {
    // The token is pinned backwards, either explicitly via the stored key or implicitly via
    // the preserved row id.
    const stored = asPayload(pinnable.payload)
    const storedKey = readFollowUpIdempotencyKey(stored)
    const divergedFields = stored ? divergedRequestFields(stored, input.payload) : []

    // For money movement the BODY is pinned with the token. Posting a recomputed amount
    // under a token the remote system has already seen returns the ORIGINAL payment, and we
    // would record a settlement for an amount never posted — local evidence that disagrees
    // with the ledger (Codex r1 #3). A genuinely invalid body is not stranded by this: the
    // connector proves such failures pre-call, which drops the row out of `ambiguous` above
    // and lets the recomputed request through (Codex r2 #3).
    if (stored && moneyMoving) {
      return {
        action: 'reuse',
        syncLogId: pinnable.id,
        payload: stored,
        tokenDisposition: 'pinned',
        bodyDisposition: 'pinned',
        divergedFields,
      }
    }

    // Non-money follow-ups (PDF, email, note, attachment) are safe to re-drive with fresh
    // inputs. Carry the stored key if it has one; stamp NOTHING if it does not, because the
    // preserved row id already IS its stable token and stamping would rotate it.
    const { [FOLLOW_UP_IDEMPOTENCY_KEY]: _discarded, ...rest } = input.payload
    const payload: FollowUpPayload = storedKey ? { ...rest, [FOLLOW_UP_IDEMPOTENCY_KEY]: storedKey } : rest
    return {
      action: 'reuse',
      syncLogId: pinnable.id,
      payload,
      tokenDisposition: 'pinned',
      bodyDisposition: 'fresh',
      divergedFields,
    }
  }

  // Nothing surviving could have committed this document, so the recomputed request goes out
  // under a freshly derived token. Reuse a spent row when one exists rather than accumulating
  // replacements; its id no longer carries the token, so reuse is bookkeeping, not safety.
  const rowToReuse = input.failedRows[0]
  const freshPayload = withFollowUpIdempotencyKey(input)
  if (rowToReuse) {
    const stored = asPayload(rowToReuse.payload)
    // A new-format row already carries a key derived from scope + anchors. If the recomputed
    // key comes out identical, the remote token has not actually changed and reporting
    // `rotated` would tell an operator something untrue (Codex review, r3 #F).
    const storedKey = readFollowUpIdempotencyKey(stored)
    const unchanged = storedKey !== undefined && storedKey === readFollowUpIdempotencyKey(freshPayload)
    return {
      action: 'reuse',
      syncLogId: rowToReuse.id,
      payload: freshPayload,
      tokenDisposition: unchanged ? 'pinned' : 'rotated',
      bodyDisposition: 'fresh',
      divergedFields: stored ? divergedRequestFields(stored, input.payload) : [],
    }
  }
  return { action: 'create', payload: freshPayload }
}
