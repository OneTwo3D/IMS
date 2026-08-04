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
 * THE FIX. Stop deriving the token from anything that can change, and WRITE IT DOWN.
 *
 *  1. A new follow-up is stamped with a `_followUpIdempotencyKey` derived from its LOGICAL
 *     identity — connector, type, reference, and the external document it targets — never
 *     from its row id. Regenerating the row cannot move it.
 *  2. A pre-existing FAILED row has no such key: its token IS its row id. So when one is
 *     reused, the connector resolves the token that row actually posted under and the
 *     planner stamps THAT value onto the payload. The legacy token becomes explicit.
 *
 * Step 2 is what makes the rest simple. Because the token is a value on the payload rather
 * than a property of the row, it survives the row: a re-plan after retention deletes it
 * (o3d-nepa) creates a replacement that posts under the identical remote key. Earlier
 * revisions instead tried to keep the ROW alive — refusing whenever it was lost, then adding
 * a tombstone to make the refusal visible, which could itself be resurrected under a rotated
 * token (Codex reviews r2–r4). Carrying the value removes the whole class.
 *
 * What still refuses is genuine ambiguity: several FAILED rows for the same document, each
 * under a different token, where any one might be the one that committed.
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
  /**
   * The token this row's attempt ACTUALLY posted under, as its own connector would have
   * derived it. Supplied by the connector because the two derive it differently: Xero falls
   * back to the row id, while QuickBooks consults the generic queue's `_idempotencyKey`
   * first. Capturing it here is what lets a pinned token outlive the row it came from —
   * stamping this value onto the payload reproduces the identical remote key even after the
   * original row is gone, which is why losing the row no longer has to refuse (Codex r4).
   */
  effectiveToken: string
}

export type FollowUpEnqueueInput = FollowUpIdentity & {
  /** A PENDING / PROCESSING / SYNCED row already owns this follow-up. */
  liveRowExists: boolean
  /** Every surviving FAILED row for this scope, newest first. */
  failedRows: FailedFollowUpRow[]
}

/**
 * Fields each money-moving follow-up REQUIRES before its connector will attempt a remote
 * call. Both connectors reject a body missing any of these before building a request, so a
 * stored body missing one PROVES that attempt never reached the ledger — the only sound
 * "this did not post" signal available, since errorMessage carries no provenance.
 *
 * Used when several rows share a token: the oldest is normally the one that would have
 * committed, but an incomplete oldest cannot have, and pinning it would strand the payment
 * behind a request that can never succeed (Codex review, r7 #3).
 */
const REQUIRED_BODY_FIELDS: Record<string, readonly { field: string; kind: 'id' | 'amount' }[]> = {
  INVOICE_PAYMENT: [
    { field: 'accountingInvoiceId', kind: 'id' },
    { field: 'bankAccountId', kind: 'id' },
    { field: 'amount', kind: 'amount' },
  ],
  PURCHASE_CREDIT_NOTE_ALLOCATION: [
    { field: 'creditNoteId', kind: 'id' },
    { field: 'accountingInvoiceId', kind: 'id' },
    { field: 'amount', kind: 'amount' },
  ],
}

/**
 * Mirrors the connectors' guards EXACTLY, which are not uniform:
 *
 *   if (!accountingInvoiceId || !bankAccountId || amount == null)
 *
 * An id is rejected when FALSY, so an empty string counts as missing — but an amount is only
 * rejected when null/undefined, so a legitimate zero must NOT. Getting either wrong here
 * misreads whether an attempt could have posted.
 */
function fieldIsPresent(value: unknown, kind: 'id' | 'amount'): boolean {
  return kind === 'amount' ? value !== undefined && value !== null : Boolean(value)
}

function bodyCouldHaveReachedTheLedger(type: string, stored: FollowUpPayload | null): boolean {
  const required = REQUIRED_BODY_FIELDS[type]
  if (!required) return true
  if (stored === null) return true
  return required.every(({ field, kind }) => fieldIsPresent(stored[field], kind))
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

  // A token this call is ALREADY carrying is authoritative. The lost-CAS path re-plans with
  // the previous plan's payload, so `carried` is a token we have already committed to
  // posting under. Letting a newly-appeared FAILED row's token displace it would rotate away
  // from a request that may have committed -- the whole hazard, reintroduced by the recovery
  // path (Codex review, r5 #1).
  const carried = readFollowUpIdempotencyKey(input.payload)

  // Pre-fix behaviour created a REPLACEMENT row after every failure, and FAILED rows are
  // outside the live-follow-up unique index, so a scope can hold several. What makes that
  // dangerous is not the row COUNT but the number of DISTINCT tokens they posted under: if
  // several rows share one token, whichever committed committed under that same token, and
  // pinning it is unambiguous. Refusing on count alone stranded exactly that case -- reruns
  // of one QuickBooks receipt all carry `invoice-payment:payment:<id>` (Codex r5 #3).
  const candidateTokens = new Set(couldHaveCommitted.map((row) => row.effectiveToken))
  if (carried) candidateTokens.add(carried)
  if (candidateTokens.size > 1 && moneyMoving) {
    return {
      action: 'refuse',
      reason: `${candidateTokens.size} different idempotency tokens have been used for ${input.type} against this `
        + 'reference and document. Any one of them may have committed remotely, so an automatic retry could '
        + 'duplicate it. Reconcile them in the ledger and resolve the rows manually.',
    }
  }

  // When several rows share the pinned token, the OLDEST is the one to pin the body from.
  // A shared token means the remote system deduplicates them, so whichever attempt reached
  // it FIRST is the request that stands — pinning a newer row's materially different body
  // (amount, bank account, date) would record a settlement the ledger never made (Codex r6).
  // failedRows arrive newest-first, so the oldest match is the last one.
  const pinnedTokenValue = carried ?? couldHaveCommitted[0]?.effectiveToken
  const sameToken = couldHaveCommitted.filter((row) => row.effectiveToken === pinnedTokenValue)
  // ...but only among bodies that could actually have reached the ledger. An incomplete body
  // is rejected pre-call by both connectors, so it provably never posted and pinning it
  // would strand the request behind one that can never succeed.
  const postable = sameToken.filter((row) => bodyCouldHaveReachedTheLedger(input.type, asPayload(row.payload)))
  const oldest = <T,>(rows: T[]): T | undefined => rows[rows.length - 1]
  const pinnable = oldest(postable) ?? oldest(sameToken) ?? couldHaveCommitted[0]
  if (pinnable) {
    // The token is pinned backwards, and pinned EXPLICITLY: the row's effective token is
    // stamped onto the payload rather than left implicit in the row id.
    //
    // That is the whole point. A legacy row's token is its own id, which dies with the row —
    // so an earlier revision had to refuse whenever retention deleted one, and then needed a
    // tombstone to make the refusal visible, which could itself be resurrected under a
    // rotated token (Codex r4). Writing the value down instead means the token outlives the
    // row: the same string reproduces a byte-identical remote key wherever it is carried,
    // and nothing has to be refused to keep it safe.
    const stored = asPayload(pinnable.payload)
    const divergedFields = stored ? divergedRequestFields(stored, input.payload) : []
    const pin = (body: FollowUpPayload): FollowUpPayload => ({
      ...body,
      [FOLLOW_UP_IDEMPOTENCY_KEY]: pinnedTokenValue ?? pinnable.effectiveToken,
    })

    // For money movement the BODY is pinned with the token. Posting a recomputed amount
    // under a token the remote system has already seen returns the ORIGINAL payment, and we
    // would record a settlement for an amount never posted — local evidence that disagrees
    // with the ledger (Codex r1 #3).
    if (stored && moneyMoving) {
      return {
        action: 'reuse',
        syncLogId: pinnable.id,
        payload: pin(stored),
        tokenDisposition: 'pinned',
        bodyDisposition: 'pinned',
        divergedFields,
      }
    }

    // Non-money follow-ups (PDF, email, note, attachment) are safe to re-drive with fresh
    // inputs; only the token is carried back.
    const { [FOLLOW_UP_IDEMPOTENCY_KEY]: _discarded, ...rest } = input.payload
    return {
      action: 'reuse',
      syncLogId: pinnable.id,
      payload: pin(rest),
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
    // withFollowUpIdempotencyKey leaves a carried token alone, so `freshPayload` still holds
    // it here; comparing against it is what reports the disposition truthfully.
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
