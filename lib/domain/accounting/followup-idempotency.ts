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
 * HOW LONG "REAL" LASTS (o3d-wahn r2 #1). Xero stores an Idempotency-Key for SIX MINUTES from
 * the first call; a re-enqueue happens minutes-to-days later, so by the time the pinned token
 * goes out the remote system has forgotten it and treats it as a new request. Pinning is still
 * the right thing — it costs nothing, it is correct inside the window, and rotating a token is
 * strictly worse — but it is NOT what makes a re-post safe. That is the `refuse` branch below:
 * where several tokens could each have committed, this module stops and asks for a human. Read
 * lib/domain/accounting/idempotency-retention.ts before adding any claim of remote dedupe here.
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
 * AND A REVIVAL MUST NOT DESTROY THE EVIDENCE OF WHAT WAS ATTEMPTED (Codex round 8, HIGH).
 * The revival is a WRITE OVER a FAILED row's payload, and that payload is where the row's own
 * attempt is recorded: its anchors say which document it targeted, its amount and date say what
 * it sent, and its `_followUpIdempotencyKey` is the token whose mark the ledger carries. Recycling
 * a row that HAD posted therefore rotated a real attempt's token and threw away the only local
 * record that it happened — see the note above the recycle below.
 *
 * AND "UNSTAMPED" ONLY MEANS THAT FOR A ROW NOTHING BUT A STAMPING BINARY HAS HANDLED (Codex
 * rounds 9 and 10, HIGH). The migration's backfill covered the rows that existed when it ran, and a
 * deploy keeps the OLD binary serving for minutes afterwards — so rows land unstamped on the far
 * side of the backfill and were being read as "never attempted". Round 9 answered with a global
 * epoch; round 10 replaced it with a fact the ROW carries, `attemptStampingCustodyAt`, because an
 * instant recorded once could be defeated from outside the row by a clock skew, a cached read or a
 * rollback. See money-attempt-provenance.ts.
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

import {
  accountingOriginRecordsMatch,
  carryAccountingOriginRecord,
} from '@/lib/connectors/accounting-connection-provenance'

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

/**
 * Carry the EXISTING row's record of which organisation it was raised against onto a rebuilt body
 * (o3d-19gy / Codex r1 finding 2, CRITICAL).
 *
 * THE DEFECT THIS REMOVES. The connectors stamp the freshly-rebuilt follow-up payload with whatever
 * connection is live NOW, and then handed that payload to this planner for BOTH outcomes — creating a
 * row, and reviving an existing FAILED one. On a revival the stamp is not a fact about the new work; the
 * row already carries a record of the organisation its earlier attempt was made against, and that record
 * is the only evidence the post-time guard has. Overwriting it with the current tenant does not merely
 * lose the evidence — it FORGES agreement, so a payment first attempted against organisation A, revived
 * while connected to organisation B, and still pinned to A's idempotency token, sails through a guard
 * that is comparing B against B.
 *
 * cvj9's rule, applied literally: a marker may only be written by the row that actually took the action.
 * A repair writes no marker. If the stored row recorded nothing (a row from before stamping shipped),
 * this carries the ABSENCE forward rather than inventing an origin for an attempt it did not witness —
 * and since Codex r3 finding 2 the post-time verdict refuses that (`no-origin-recorded`) rather than
 * waving it through, so the carried nothing is now load-bearing rather than merely honest.
 *
 * The mechanism itself lives in `carryAccountingOriginRecord`, beside the reader and the verdict, and is
 * shared with the connectors' CREATE path (r3 finding 1). Two implementations of "inherit, never mint"
 * is two places for one of them to start minting again.
 */
function withStoredOriginRecord(body: FollowUpPayload, storedPayload: unknown): FollowUpPayload {
  return carryAccountingOriginRecord(body, storedPayload)
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

/**
 * o3d-anu8 — the sync rows an OPERATOR'S ASSERTION cleared out of the way for this plan.
 *
 * Present only on a money-moving `create`/`reuse` that a settled-as-NOT_POSTED row is standing
 * behind. The caller records it, because the alternative is that a money post whose only clearance
 * is a human's belief looks exactly like one the connector's own history cleared.
 */
export type SettlementAssertionReliance = { assertedNotPostedRowIds: string[] }

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
      restsOnAssertion?: SettlementAssertionReliance
    }
  | { action: 'create'; payload: FollowUpPayload; restsOnAssertion?: SettlementAssertionReliance }

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
  /**
   * When a REMOTE MONEY CALL was first made from this row, or null when none ever was.
   *
   * Read straight off the column `authoriseMoneyPost` claims — one conditional write, taken
   * immediately before the call and never cleared, so it survives the retryCount reset that both
   * revival paths perform. That makes it the only sound answer to "could this row's payload be the
   * record of something that reached the ledger?", which is the question the recycle below asks:
   *
   *   not null -> a call left this row. Its payload is evidence and must not be overwritten.
   *   null     -> no call ever left it, so its payload records nothing that happened.
   *
   * Only money-moving types are ever stamped (the fence returns early for the rest, and the
   * backfill in 20260818090000 covered the pre-existing money rows). A PDF or e-mail follow-up
   * therefore reads null forever — correctly, because a duplicate of one is not a settlement and
   * its payload is not evidence of money.
   *
   * NULL ONLY PROVES ANYTHING FOR A ROW A STAMPING BINARY CREATED — see `createdAt` below.
   */
  remoteAttemptedAt: Date | null
  /**
   * When a binary that STAMPS `remoteAttemptedAt` before every money call last took custody of this
   * row — created it, or claimed it — or null when something else has had it (Codex rounds 9
   * and 10, HIGH).
   *
   * This is what says whether the NULL above is evidence of anything, and it is READ AS A
   * PRESENCE, never as an instant. A row is trustworthy because of what handled it, not because of
   * when it appeared:
   *
   *   not null -> everything that created or claimed this row stamps before it posts, so an unset
   *               `remoteAttemptedAt` really does mean no call ever left it.
   *   null     -> a binary that does not stamp created it (the column did not exist for it, so it
   *               wrote nothing) or claimed it (the database's forfeit trigger took custody away).
   *               Its unset stamp says nothing, and its payload may be the record of a payment.
   *
   * WHY NOT A DATE COMPARISON. Round 9 compared `createdAt` against a global epoch. Two clocks —
   * the database's and the app process's — decided which side of that boundary a row fell on, and
   * the wrong side is an attempted row read as never-attempted; and the epoch itself was
   * established once, so a ROLLBACK produced unstamped rows after it that the rule trusted. A fact
   * the row carries has neither failure: no clock is consulted, and a rolled-back binary declares
   * itself simply by not writing the column.
   */
  attemptStampingCustodyAt: Date | null
}

export type FollowUpEnqueueInput = FollowUpIdentity & {
  /** A PENDING / PROCESSING / SYNCED row already owns this follow-up. */
  liveRowExists: boolean
  /**
   * o3d-anu8 — that live row reached SYNCED because an OPERATOR ASSERTED it posted
   * (settlementBasis = OPERATOR_ASSERTION), not because the connector wrote back after a call.
   *
   * Optional, and absent reads as "the connector wrote it" — which is the correct default for every
   * row that predates the settlement action and for every caller that has not been taught to ask.
   */
  liveRowAsserted?: boolean
  /** Every surviving FAILED row for this scope, newest first. */
  failedRows: FailedFollowUpRow[]
  /**
   * o3d-anu8 — rows in this scope an OPERATOR asserted NEVER posted: status CANCELLED,
   * settlementBasis = OPERATOR_ASSERTION.
   *
   * They are deliberately NOT in `failedRows` and must not be: `buildSettlementData` documents that
   * moving a FAILED row to CANCELLED to drop the distinct-token count is the INTENDED unblock for a
   * part-payment history that otherwise refuses for ever. What they are here for is the other half
   * of that — so a plan that only exists because of an assertion can SAY so, instead of being
   * indistinguishable from one where the connector itself established that nothing was sent.
   */
  assertedNotPostedRows?: readonly { id: string }[]
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
  // The SUPPLIER side of the same guard, verified against both connectors rather than assumed from
  // the sales one: xero/sync-processor.ts and quickbooks/sync-processor.ts each open their
  // BILL_PAYMENT case with the identical
  //   if (!accountingInvoiceId || !bankAccountId || amount == null)
  // and return before building any request. Without this entry a FAILED BILL_PAYMENT row would be
  // permanently unknowable even when its stored body could never have been sent, which is the one
  // case that IS provable (o3d-a3wx round 4 #5).
  BILL_PAYMENT: [
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

/**
 * Could this stored body be SENT — i.e. would the connector build a request from it rather than
 * reject it out of hand? Used to choose which body to pin, so `null` (unreadable, but it was a real
 * request once) answers true and falls through to the fresh-body branch, while a body missing a
 * required field answers false because pinning it would strand the payment behind a request that
 * can never succeed.
 */
function bodyCouldHaveReachedTheLedger(type: string, stored: FollowUpPayload | null): boolean {
  const required = REQUIRED_BODY_FIELDS[type]
  if (!required) return true
  if (stored === null) return true
  return required.every(({ field, kind }) => fieldIsPresent(stored[field], kind))
}

/**
 * PROOF that a stored attempt never reached the ledger — the opposite question, and deliberately
 * NOT the negation of `bodyCouldHaveReachedTheLedger` (o3d-qsbs).
 *
 * The two differ on exactly the cases where "no information" must not be read as "no call". A
 * `null` payload is unreadable, and an EMPTY one is indistinguishable from a payload retention
 * compacted away; neither proves anything about what left the process, so neither is proof. Only a
 * body that is present, readable and missing a field the connector rejects PRE-CALL proves it —
 * both connectors validate before they build a request, which is the one sound "this did not post"
 * signal available here, since errorMessage carries no provenance (r3 blocker A) and o3d-ju8t
 * established that FAILED alone proves nothing.
 *
 * Negating `bodyCouldHaveReachedTheLedger` instead would turn a compacted `{}` into a claim that
 * the attempt provably never posted — retention manufacturing evidence about a remote call, which
 * is the one direction that ends in a duplicate payment.
 */
function bodyProvesNoCallLeft(type: string, stored: FollowUpPayload | null): boolean {
  const required = REQUIRED_BODY_FIELDS[type]
  if (!required) return false
  if (stored === null) return false
  if (Object.keys(stored).length === 0) return false
  return !required.every(({ field, kind }) => fieldIsPresent(stored[field], kind))
}

/**
 * DID THIS STORED ATTEMPT MAYBE REACH THE LEDGER? The one answer in this tree, over a raw payload.
 *
 * Exported so the POST-TIME capacity guards — `invoice-payment-capacity.ts` on the sales side and
 * `payment-reversal.ts` on the supplier side — decide what a FAILED money row means using THIS
 * definition rather than a second copy of it. There is exactly one sound "nothing was sent" signal in
 * the system, and two guards deriving it differently would disagree about whether a document still has
 * capacity, which for money is the whole question.
 *
 * IT IS BUILT ON `bodyProvesNoCallLeft`, NOT ON `bodyCouldHaveReachedTheLedger` (o3d-m5qk). Both
 * branches that arrived at this merge had a version of the question and they answer differently on one
 * input: an EMPTY `{}` body. `bodyCouldHaveReachedTheLedger` reads it as "could not have been sent",
 * because it is missing every required field; `bodyProvesNoCallLeft` refuses to read it that way,
 * because retention compacts a payload to `{}` and a compacted body says nothing whatever about what
 * left the process. For choosing which body to PIN the first reading is right and harmless — an empty
 * body genuinely cannot be re-sent. For deciding whether an invoice still has CAPACITY it is a claim
 * that a payment provably never posted, made on evidence retention destroyed, and it ends in a second
 * payment. So this reader takes the stricter one: unproven means it counts against capacity.
 *
 * Returns TRUE for an unreadable, absent or compacted payload: not knowing what was sent is not
 * evidence that nothing was.
 */
export function storedBodyMayHaveReachedTheLedger(type: string, payload: unknown): boolean {
  return !bodyProvesNoCallLeft(type, asPayload(payload))
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
  const moneyMoving = isMoneyMovingFollowUp(input.type)

  if (input.liveRowExists) {
    // A LIVE ROW SUPPRESSES THIS WORK, AND ONLY THE CONNECTOR IS ENTITLED TO (o3d-anu8).
    //
    // The live set is PENDING / PROCESSING / SYNCED, and a SYNCED row means "the ledger was told" —
    // which is why a skip is silent and correct. But `buildSettlementData` also writes SYNCED, from
    // a document id an operator TYPED, and nothing about the resulting row distinguishes it. So for
    // an INVOICE_PAYMENT that row PERMANENTLY suppresses the real registration: the invoice is never
    // settled in the ledger, and the skip logs nothing to say so.
    //
    // WITHHOLD RATHER THAN DECIDE (the third state, o3d-54p). Skipping asserts the ledger holds a
    // payment nobody has checked; enqueuing asserts it does not, and would post a second one if the
    // operator was right. Neither is knowable from here, so the plan refuses — visibly, with a
    // reason an operator can act on — instead of choosing one silently.
    //
    // MONEY-MOVING TYPES ONLY. For a PDF, an e-mail or a note, a suppressed re-drive costs a
    // document nobody received; it does not move money, and turning every asserted row into a
    // repeating warning would bury the ones that do.
    if (moneyMoving && input.liveRowAsserted) {
      return {
        action: 'refuse',
        reason: `the live ${input.type} row for this reference is SYNCED because an OPERATOR asserted it posted, not `
          + 'because the accounting connector confirmed it — IMS made no call and read no document. Skipping would '
          + 'treat that assertion as proof the ledger already holds this money; enqueuing could pay it twice if the '
          + 'assertion is right. Open the asserted document in the accounting system: if it is genuinely there, '
          + 'nothing more is owed; if it is not, correct that row so this can be re-enqueued.',
      }
    }
    return { action: 'skip' }
  }

  const freshAnchors = anchorsOf(input.payload)

  // o3d-anu8 — carried onto every non-refusing plan below. Reaching a `create` or a `reuse` on a
  // money-moving type while a settled-as-NOT_POSTED row sits in this scope means the ambiguity that
  // would otherwise have refused was cleared by a HUMAN'S WORD, and the caller records that. It does
  // not change the decision: freeing this path is the settlement action's stated purpose.
  const assertedNotPostedRowIds = (input.assertedNotPostedRows ?? []).map((row) => row.id)
  const restsOnAssertion: SettlementAssertionReliance | undefined =
    moneyMoving && assertedNotPostedRowIds.length > 0 ? { assertedNotPostedRowIds } : undefined

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
  //
  // ...and only among attempts that could have SENT anything (o3d-qsbs). A stored body missing a
  // field its connector validates before building a request never reached the ledger, so its token
  // was never used remotely and it is not a candidate for "one of these may have committed".
  // Counting it was how an anchorless legacy row — anchorless precisely because it lacks
  // `accountingInvoiceId`, which is also one of the fields that proves it never posted — could make
  // a scope REFUSE for ever, so a genuinely new payment against a replacement invoice was blocked
  // by history that could not have touched it. `carried` is added unconditionally: it is a token
  // this very call has already committed to posting under, not a historical attempt.
  const mayHaveCommitted = couldHaveCommitted.filter(
    (row) => !bodyProvesNoCallLeft(input.type, asPayload(row.payload)),
  )
  const candidateTokens = new Set(mayHaveCommitted.map((row) => row.effectiveToken))
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
  //
  // AND THE TOKEN IS CHOSEN FROM THE SAME SET THE REFUSAL COUNTS (o3d-qsbs, Codex r10 #1). The two
  // predicates are deliberately not negations of each other, and the consequence for TOKEN SELECTION
  // was missed: `couldHaveCommitted[0]` is the NEWEST surviving row whether or not it could ever
  // have sent anything. So a newer row that PROVABLY never posted — a legacy body missing
  // `accountingInvoiceId`, or a body missing `bankAccountId` — displaced the token of an older row
  // that MAY have committed. Nothing refused, because the unsendable row's token is (correctly) not
  // a candidate for having committed; the retry then went out under a token the ledger has never
  // seen while a payment posted under the OTHER token may already stand. That is the duplicate
  // payment this module exists to prevent, reintroduced one branch below the fix for it.
  //
  // So: prefer the newest attempt that may have committed. Falling back to `couldHaveCommitted[0]`
  // only when NONE of them may have — every surviving token was then proven never to leave the
  // process, so any of them reproduces a remote key the ledger has never seen and pinning the
  // newest keeps the row-id reuse (and the `{}`-compacted case, which is never proof, in the
  // may-have-committed set where it belongs).
  const pinnedTokenValue = carried ?? mayHaveCommitted[0]?.effectiveToken ?? couldHaveCommitted[0]?.effectiveToken
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
    //
    // UNLESS THAT BODY CANNOT BE SENT (o3d-qsbs). `pinnable` falls back to the oldest same-token
    // row when NONE of them is postable, and pinning an incomplete body there re-sent a request the
    // connector rejects before it builds anything — for ever, on every retry, with the payment
    // stranded behind it. That fallback contradicted the rule stated two branches up, which is that
    // an incomplete body provably never posted. It provably never posted, so the token it carries
    // was never seen remotely and the RECOMPUTED body is safe to send under it: the token stays
    // pinned (nothing is rotated), only the unusable body is replaced.
    //
    // o3d-gfh: when the stored body IS pinned, `stored` is the existing row's payload, so its origin
    // record travels with it and the freshly-stamped one in `input.payload` is discarded — which is
    // the correct direction. If the row was raised against another organisation the post-time verdict
    // now sees A against B and refuses; before, it saw B against B, because the stamp had been
    // rewritten by the repair itself.
    if (stored && moneyMoving && bodyCouldHaveReachedTheLedger(input.type, stored)) {
      return {
        action: 'reuse',
        syncLogId: pinnable.id,
        payload: pin(stored),
        tokenDisposition: 'pinned',
        bodyDisposition: 'pinned',
        divergedFields,
        ...(restsOnAssertion ? { restsOnAssertion } : {}),
      }
    }

    // Non-money follow-ups (PDF, email, note, attachment) are safe to re-drive with fresh
    // inputs; only the token is carried back. A money-moving row whose stored body could never have
    // been sent lands here too, for the reason given just above.
    //
    // o3d-gfh: since a token is carried, so is the row's record of the organisation that token was
    // spent against. The BODY is fresh; the ORIGIN is the row's own and is not the caller's to rewrite.
    const { [FOLLOW_UP_IDEMPOTENCY_KEY]: _discarded, ...rest } = input.payload
    return {
      action: 'reuse',
      syncLogId: pinnable.id,
      payload: pin(withStoredOriginRecord(rest, pinnable.payload)),
      tokenDisposition: 'pinned',
      bodyDisposition: 'fresh',
      divergedFields,
      ...(restsOnAssertion ? { restsOnAssertion } : {}),
    }
  }

  // Nothing surviving could have committed this document, so the recomputed request goes out
  // under a freshly derived token. Reuse a spent row when one exists rather than accumulating
  // replacements; its id no longer carries the token, so reuse is bookkeeping, not safety.
  //
  // BUT ONLY A ROW THAT IS NOT EVIDENCE (Codex round 8, HIGH). Reuse is a WRITE OVER the chosen
  // row's payload, and reaching here means every surviving FAILED row targets a DIFFERENT external
  // document — that is precisely why nothing could be pinned. So the row this branch used to grab
  // (`failedRows[0]`, the newest) is by construction the record of an attempt against ANOTHER
  // invoice, and overwriting it rotated that attempt's token and discarded its body:
  //
  //   INV-A's payment commits in Xero, the response is lost, the row ends FAILED. The invoice is
  //   voided and re-raised as INV-B, the sweep re-enqueues, and this branch recycles the INV-A row
  //   into an INV-B request. `_followUpIdempotencyKey` is now INV-B's token, the anchors say INV-B,
  //   the amount and date are INV-B's — and the only local trace that anything was ever sent to
  //   INV-A is gone, while `remoteAttemptedAt` stays set and now vouches for the wrong document.
  //   The next enqueue against INV-A finds no attempt, rotates a token, and pays it twice.
  //
  // WHERE THE EVIDENCE LIVES ONCE THIS LEAVES IT ALONE: on the FAILED row itself — its `payload`
  // (anchors, amount, date, `_followUpIdempotencyKey`) and its `remoteAttemptedAt`. THREE READERS
  // depend on it, and all three go blind together when it is overwritten:
  //
  //   1. this planner, through `failedRows` — `couldHaveCommittedThis` pins the attempt's token
  //      back, and the distinct-token count refuses when several could have committed;
  //   2. `authoriseMoneyPost` (accounting-settlement-probe.ts) — its `attemptedSiblings` query
  //      matches on `remoteAttemptedAt` plus the scope/document arms, then judges each rival by
  //      `settlementMarkerFor(effectiveTokenFor(...))`, i.e. by the token in that payload;
  //   3. `planManualRetry` (followup-retry-guard.ts) — the same siblings, the same marks, for the
  //      operator-facing retry.
  //
  // A row that never made a remote call records nothing that happened, so recycling it destroys
  // nothing and the bookkeeping is kept for exactly those. Anything else is left FAILED and a new
  // row is created beside it; the cost is one extra row per distinct document in a scope.
  //
  // AND ONLY A ROW WHOSE UNSTAMPED-NESS IS ITSELF EVIDENCE (Codex rounds 9 and 10, HIGH).
  // `remoteAttemptedAt === null` alone is not that. The stamp is written by `authoriseMoneyPost`,
  // so a NULL means one of two very different things:
  //
  //   - a binary that stamps handled this row and never posted from it -> nothing happened;
  //   - something that does not stamp handled it                       -> the NULL says nothing.
  //
  // The second is not hypothetical and it is not history. It is every deploy window (the migration
  // backfills, then the build runs for minutes with the OLD binary still serving and still posting
  // without stamping), every accidental overlap, and every ROLLBACK. Recycling one of those rows is
  // precisely the evidence destruction this branch was written to stop, reintroduced at each of
  // them: the recycled row's anchors, amount, date and `_followUpIdempotencyKey` are overwritten
  // with another document's, and the payment it may have committed becomes invisible to all three
  // readers listed above.
  //
  // `attemptStampingCustodyAt` separates them, and it does so from the ROW. Round 9 used a global
  // instant instead and Codex round 10 defeated it three ways — a clock skew across the boundary, a
  // cached epoch that ignored the documented reset, and a rollback that landed rows on the trusted
  // side of an epoch established once. Custody has no boundary to fall the wrong side of: a binary
  // that does not stamp cannot write the column when it creates a row, and the database's forfeit
  // trigger takes custody away when it claims one. So the test is a presence check, and every way
  // of losing custody leaves the row here, unrecycled, with its evidence intact.
  const provablyNeverAttempted = (row: FailedFollowUpRow): boolean =>
    row.remoteAttemptedAt === null && row.attemptStampingCustodyAt !== null

  // AND ONLY A ROW THAT RECORDS THE SAME ORIGIN THE NEW WORK WAS RAISED AGAINST (o3d-s36z).
  //
  // The two conditions are joined rather than chosen between, because they refuse for different
  // reasons and each admits rows the other would not:
  //
  //   provablyNeverAttempted   the row is not evidence of a REMOTE CALL, so overwriting its token,
  //                            anchors, amount and date destroys nothing that happened.
  //   same recorded origin     the row is not evidence of an ORGANISATION either. A stamp naming
  //                            organisation A is the only surviving trace that this work was raised
  //                            against A, and it survives an attempt that never left: restamping it
  //                            for B erases that, and carrying A's stamp onto B's work would strand
  //                            B behind a post-time refusal it can never satisfy.
  //
  // `accountingOriginRecordsMatch` also refuses when EITHER record is unreadable, which is the fence
  // failing closed rather than a third state — the same shape as the four never-conflated stamp
  // states it is built on. A brand-new row costs one insert per distinct document in a scope; the
  // alternative costs a payment nobody can trace.
  const rowToReuse = input.failedRows.find(
    (row) => provablyNeverAttempted(row) && accountingOriginRecordsMatch(row.payload, input.payload),
  )
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
      ...(restsOnAssertion ? { restsOnAssertion } : {}),
    }
  }
  return { action: 'create', payload: freshPayload, ...(restsOnAssertion ? { restsOnAssertion } : {}) }
}

/**
 * DOES THIS LIVE ROW ALREADY OWN THE FOLLOW-UP WE ARE ABOUT TO ENQUEUE? (o3d-hbgo)
 *
 * `hasExistingSyncLog` decided that from (connector, type, referenceType, referenceId) alone, and the
 * partial unique index was scoped the same way — neither consulted the external document the follow-up
 * TARGETS. So a SalesOrder whose invoice was deleted and re-posted kept the SYNCED INVOICE_PAYMENT row
 * from the FIRST invoice, the payment follow-up for the SECOND was skipped as already handled, and the
 * new invoice was never settled. Silently: a skip logs nothing.
 *
 * o3d-h2wx had already made the remote TOKEN anchor-aware, so a follow-up targeting a different
 * accountingInvoiceId derives a different Idempotency-Key rather than being deduped by the ledger. This
 * closes the same gap one level down, using the SAME anchors — a row-level dedup that names less than
 * the token it would post under can only ever throw away work the token was ready to distinguish.
 *
 * An unanchored stored payload counts as MATCHING, exactly as `couldHaveCommittedThis` treats it: we
 * cannot tell what it targeted, and skipping a possibly-duplicate payment is recoverable where posting
 * one is not. That is the OPPOSITE of the database index's null handling — the index groups unanchored
 * rows into their own slot — and deliberately so: the application guard may be stricter than the
 * constraint that backs it, never laxer.
 */
export function liveRowOccupiesFollowUpSlot(storedPayload: unknown, freshPayload: FollowUpPayload): boolean {
  return couldHaveCommittedThis(asPayload(storedPayload), anchorsOf(freshPayload))
}
