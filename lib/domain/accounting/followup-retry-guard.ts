import {
  FOLLOW_UP_IDEMPOTENCY_KEY,
  readFollowUpIdempotencyKey,
  type FollowUpPayload,
} from './followup-idempotency'
import {
  classifyLedgerSettlement,
  describeAttempt,
  settlementMarkerFor,
  type LedgerSettlementProbe,
  type SettlementVerdict,
} from './ledger-settlement-evidence'

/**
 * o3d-0m56 — an operator action that looks safe must not be able to post a payment twice.
 *
 * o3d-h2wx routed every AUTOMATIC follow-up enqueue through `planFollowUpEnqueue`, which
 * refuses when several FAILED rows for one reference each posted under a DIFFERENT idempotency
 * token: any of them may have committed remotely, so re-posting picks a token the ledger may
 * never have seen and a second payment lands.
 *
 * The sync UI's retry action bypassed all of it — it flips a chosen FAILED row straight to
 * PENDING. The "Retry All Failed" variant is worse: it drops the id filter entirely, so it
 * re-queues every ambiguous scope at once, each row under its own distinct token.
 *
 * THREE THINGS ARE CHECKED, and a money-moving retry must pass all of them.
 *
 *  1. UNAMBIGUOUS HISTORY. More than one distinct token among the rows that could have posted
 *     this document means any one of them may be the one that committed, and no single token can
 *     be re-sent safely. Same-token rows are NOT ambiguous — whichever committed, committed under
 *     that token — and refusing them on row count alone is the mistake o3d-h2wx already corrected
 *     once in the automatic path.
 *
 *  2. ONE LIVE ROW PER DOCUMENT. A sibling that is PENDING, PROCESSING or SYNCED is either in
 *     flight or already in the ledger. Reviving beside it is a second live attempt at the same
 *     settlement — and for the types covered by `accounting_sync_logs_followup_live_unique` the
 *     database rejects the write outright, which used to abort the whole bulk update and reset
 *     NOTHING, including the unrelated scopes in the same click (Codex review).
 *
 *  3. POSITIVE SETTLEMENT EVIDENCE. This is the one that used to be missing, and the reasoning
 *     that let it be missing was wrong. Re-posting under the original token protects nothing
 *     unless the remote still REMEMBERS that token: Xero retains an Idempotency-Key for minutes,
 *     and a manual retry is minutes to days later. So a lone FAILED Xero payment whose call
 *     COMMITTED but whose response was lost — which FAILED never rules out (o3d-ju8t) — was
 *     re-posted, and nothing refused it because nothing was ambiguous. It is not enough for a
 *     retry to be unambiguous; it must be shown not to have already happened. The caller reads
 *     the target document from the ledger and passes the verdict here; anything short of a
 *     positive `clear` refuses. See ledger-settlement-evidence.ts.
 *
 * Rule 3 applies to the AUTOMATIC path too, where the identical hazard lives: both connectors'
 * `enqueueFollowUpSyncLog` revives a money-moving FAILED row under a pinned token, and now takes
 * the same evidence before it does.
 *
 * WHAT THIS STILL COSTS, stated because it is real. A part-payment history, and a payment
 * reversed in the ledger then legitimately re-posted, can both be refused — the first by a
 * settled sibling's token, the second by a settlement record that matches the amount and date of
 * the very payment being replaced. There is no per-row settlement action yet, so "resolve these
 * rows manually" means editing the ledger and leaving the row. That is the stranding direction:
 * an operator can act on a refusal they can read, and cannot act on a duplicate payment nobody
 * told them about.
 */

export type RetryCandidateRow = {
  id: string
  /** The token this row's attempt actually posted under, as its own connector derives it. */
  effectiveToken: string
  payload: unknown
  /**
   * Sync status. It does NOT exclude a row from the token set (see the note above the contender
   * filter); it is what identifies a LIVE sibling for rule 2, and it names the state in refusals.
   */
  status?: string | null
}

/**
 * EVERY status in the scope counts toward ambiguity. Two attempts I made to narrow this were both
 * wrong, in the dangerous direction, and the reasoning is worth keeping because it is not obvious.
 *
 * I excluded SYNCED on the grounds that its outcome is known, and that retrying a FAILED row
 * re-posts under ITS OWN token which the remote would deduplicate. THE SECOND HALF IS FALSE FOR
 * XERO: Xero retains an Idempotency-Key only for a short, documented window (minutes), after
 * which the same key is processed as a brand-new request. A MANUAL retry is by nature minutes
 * to days after the failure, so it is essentially never inside that window. QuickBooks does
 * replay by `requestid`, so the same-token case is better protected there -- but the guard cannot
 * be correct on one connector only, and the cross-token case (A never landed, replacement B is
 * SYNCED, retrying A posts a second payment beside B) is unprotected on BOTH.
 *
 * I also excluded CANCELLED as "proven never attempted". It is not: a row whose remote call
 * COMMITTED but whose response was lost is returned to PENDING for retry, and deleting the
 * local receipt then cancels that row. A cancelled sibling can therefore represent money that
 * is already in the ledger.
 */
export type ManualRetryPlan =
  | { action: 'allow' }
  | { action: 'refuse'; reason: string; tokenCount: number }

/**
 * Every sync type whose remote call MOVES MONEY.
 *
 * Deliberately BROADER than `isMoneyMovingFollowUp`, which o3d-h2wx scoped to the types its
 * enqueue helper produces. BILL_PAYMENT is not one of those — it is queued elsewhere — but both
 * processors post a real supplier payment for it, and this guard sees every FAILED row an
 * operator can click, not just follow-ups. Using the narrower set let two failed bill payments
 * with distinct tokens sail through, and "Retry All" re-queue both (Codex review).
 */
const MONEY_MOVING_SYNC_TYPES = new Set([
  'INVOICE_PAYMENT',
  'BILL_PAYMENT',
  'PURCHASE_CREDIT_NOTE_ALLOCATION',
])

export function isMoneyMovingSyncType(type: string): boolean {
  return MONEY_MOVING_SYNC_TYPES.has(type)
}

/**
 * The types `accounting_sync_logs_followup_live_unique` covers: a PARTIAL UNIQUE index on
 * (connector, type, referenceType, referenceId) restricted to PENDING/PROCESSING/SYNCED rows.
 *
 * Mirrored here because the retry decides what to revive, and a decision that ignores the index
 * does not fail safely — it fails with a constraint error that rolls back the whole statement.
 * Kept in step with the migration by a test that reads the SQL.
 */
const LIVE_UNIQUE_FOLLOW_UP_TYPES = new Set([
  'INVOICE_PAYMENT',
  'BILL_ATTACHMENT',
  'INVOICE_PDF',
  'INVOICE_EMAIL',
  'WC_INVOICE_NOTE',
  'PURCHASE_CREDIT_NOTE_ALLOCATION',
])

export function isLiveUniqueFollowUpType(type: string): boolean {
  return LIVE_UNIQUE_FOLLOW_UP_TYPES.has(type)
}

/**
 * Types where at most ONE row per scope may be live at a time — either because the database says
 * so, or because two live money rows for one document are two payments.
 *
 * BILL_PAYMENT is in the second group only: the index does not cover it, so nothing would stop
 * "Retry All" reviving two failed bill payments for one bill and posting both.
 */
export function revivesAtMostOnePerScope(type: string): boolean {
  return isMoneyMovingSyncType(type) || isLiveUniqueFollowUpType(type)
}

const LIVE_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED'])

function isLiveStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && LIVE_STATUSES.has(status)
}

/**
 * Fields each money-moving type REQUIRES before its connector will attempt a remote call. Both
 * processors reject a body missing any of these before building a request, so such a row
 * PROVABLY never posted — it carries no token worth defending.
 *
 * This is the only sound "did not post" signal available. o3d-h2wx established that the error
 * MESSAGE cannot be used, because both connectors overwrite `HTTP nnn` with the remote system's
 * own text. Structure can be.
 */
const REQUIRED_BODY_FIELDS: Record<string, readonly { field: string; kind: 'id' | 'amount' }[]> = {
  INVOICE_PAYMENT: [
    { field: 'accountingInvoiceId', kind: 'id' },
    { field: 'bankAccountId', kind: 'id' },
    { field: 'amount', kind: 'amount' },
  ],
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
 * Mirrors the connectors' guards, which are NOT uniform: an id is rejected when FALSY, so an
 * empty string counts as missing, but an amount only when null/undefined, so a legitimate zero
 * does not.
 */
function couldHaveReachedTheLedger(type: string, payload: unknown): boolean {
  const required = REQUIRED_BODY_FIELDS[type]
  if (!required) return true
  const record = asPayload(payload)
  if (record === null) return true
  return required.every(({ field, kind }) => {
    const value = record[field]
    return kind === 'amount' ? value !== undefined && value !== null : Boolean(value)
  })
}

/** Exported for the registration guard, which must judge an unresolved attempt the same way. */
export function attemptCouldHaveReachedTheLedger(type: string, payload: unknown): boolean {
  return couldHaveReachedTheLedger(type, payload)
}

const ANCHOR_FIELDS = ['accountingInvoiceId', 'creditNoteId'] as const

function asPayload(value: unknown): FollowUpPayload | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as FollowUpPayload)
    : null
}

function anchorsOf(payload: unknown): string[] {
  const record = asPayload(payload)
  return ANCHOR_FIELDS.map((field) => {
    const value = record?.[field]
    return typeof value === 'string' ? value.trim() : ''
  })
}

/**
 * Whether two rows could have committed the SAME external document.
 *
 * An attempt against a different invoice cannot have posted the one being retried, so it must
 * not trigger a refusal — refusing on row count alone permanently strands a legitimate payment
 * against a replacement invoice. A row with no recorded anchor is treated as MATCHING, because
 * "unknown target" has to read as "possibly this one" where money is concerned.
 */
function couldBeTheSameDocument(left: unknown, right: unknown): boolean {
  const a = anchorsOf(left)
  const b = anchorsOf(right)
  if (a.every((value) => value === '') || b.every((value) => value === '')) return true
  return a.every((value, index) => value === b[index])
}

/**
 * Exported for the POST fence, which judges the same rival attempts this planner does and must
 * not disagree with it about which of them could have settled the document being posted to.
 */
export function attemptCouldBeTheSameDocument(left: unknown, right: unknown): boolean {
  return couldBeTheSameDocument(left, right)
}

/**
 * Decide whether one manual retry may proceed. Pure, so the rule is testable without a
 * database and cannot drift from the automatic path's definition of ambiguity.
 *
 * `siblings` is every row in the target's scope AT ANY STATUS, including the target itself.
 * `ledger` is one read of the target document, shared by the whole scope: the planner judges the
 * row being retried AND every rival attempt against it, because "which of these committed?" cannot
 * be answered from the row alone.
 */
export function planManualRetry(params: {
  type: string
  reference: string
  target: RetryCandidateRow
  siblings: RetryCandidateRow[]
  /**
   * What the connector's ledger holds against this document, as read once for the whole scope.
   * Required rather than optional so a caller cannot reach `allow` by forgetting to ask — and it
   * is the RECORDS, not a pre-computed verdict, because the planner has to judge every contender
   * against them, not only the row being retried.
   */
  ledger: LedgerSettlementProbe
}): ManualRetryPlan {
  const { type, reference, target, siblings, ledger } = params
  const moneyMoving = isMoneyMovingSyncType(type)
  // Each row is judged by ITS OWN mark: the token a row posted under is what it would have written
  // into the ledger, so a rival attempt is recognised by its own reference, not by this one's.
  const verdictFor = (row: RetryCandidateRow): SettlementVerdict =>
    classifyLedgerSettlement(describeAttempt(type, row.payload, settlementMarkerFor(row.effectiveToken)), ledger)

  const contenders = siblings
    // A sibling missing a field its connector requires was rejected BEFORE any HTTP call, so it
    // cannot have committed anything and must not make a valid payment un-retryable. Without
    // this, one malformed row permanently strands the good one through the only manual route
    // available (Codex review).
    .filter((row) => couldHaveReachedTheLedger(type, row.payload))
    .filter((row) => couldBeTheSameDocument(row.payload, target.payload))
  const tokens = new Set(contenders.map((row) => row.effectiveToken))

  if (moneyMoving && tokens.size > 1) {
    // AMBIGUITY IS ABOUT WHICH ONE COMMITTED — so if the ledger positively shows that NONE of them
    // did, there is nothing to be ambiguous about and the scope is recoverable (Codex round 2).
    // Without this, two attempts that both provably failed made the document permanently
    // un-retryable, with no per-row resolution action to escape through.
    //
    // Two conditions, and the second is not obvious: a SYNCED contender is positive evidence that
    // a payment DID go out under its token. If the ledger does not show it, the payment was
    // reversed or deleted there — and re-posting the other token would restore money a human took
    // out deliberately. That is not a recovery, so it still refuses.
    const unresolved = contenders.filter((row) => verdictFor(row).outcome !== 'clear')
    const settledContender = contenders.some((row) => row.status === 'SYNCED')
    if (unresolved.length > 0 || settledContender) {
      return {
        action: 'refuse',
        tokenCount: tokens.size,
        reason: `${tokens.size} attempts for ${reference} were made under different idempotency `
          + 'keys. Any one of them may have reached the ledger, and a manual retry is too late for '
          + 'the remote to deduplicate it, so retrying could post a second payment. Check the '
          + 'ledger for an existing payment against this document before acting.',
      }
    }
  }

  // Rule 2. A live sibling is an attempt in flight or already posted. For an index-covered type
  // ANY live sibling in the scope blocks the write; for BILL_PAYMENT, which the index does not
  // cover, the money argument is what blocks it, so only a sibling that could be the same
  // document counts.
  if (revivesAtMostOnePerScope(type)) {
    const live = siblings.filter((row) =>
      row.id !== target.id
      && isLiveStatus(row.status)
      && (isLiveUniqueFollowUpType(type) || couldBeTheSameDocument(row.payload, target.payload)))
    if (live.length > 0) {
      return {
        action: 'refuse',
        tokenCount: new Set(live.map((row) => row.effectiveToken)).size,
        reason: `Another entry for ${reference} is already queued or has posted (${live
          .map((row) => `${row.id} ${row.status}`).join(', ')}). Only one live entry per document `
          + 'is allowed, so this row was left failed. Let the live one finish, then retry this if '
          + 'it is still needed.',
      }
    }
  }

  if (!moneyMoving) return { action: 'allow' }

  // Rule 3. Unambiguous is not the same as safe: the remote's deduplication window has closed by
  // the time anyone clicks retry, so the ledger itself has to say this attempt is not in it.
  //
  // A target whose own body is too incomplete for its connector to have built a request is exempt:
  // it provably never posted, so there is nothing to duplicate, and refusing it for want of
  // evidence about a call that was never made would be a refusal with no hazard behind it. It will
  // simply fail the same way again, which is visible and harmless.
  if (!couldHaveReachedTheLedger(type, target.payload)) return { action: 'allow' }

  const settlement = verdictFor(target)
  if (settlement.outcome === 'present') {
    return {
      action: 'refuse',
      tokenCount: tokens.size,
      reason: `The accounting connector already holds a settlement of ${settlement.detail} against `
        + `the document for ${reference}, which matches what this attempt sent. It may have `
        + 'committed before its response was lost, so retrying could post a second payment. Check '
        + 'the ledger and resolve this row by hand.',
    }
  }
  if (settlement.outcome === 'unknown') {
    return {
      action: 'refuse',
      tokenCount: tokens.size,
      reason: `IMS could not establish whether the attempt for ${reference} already reached the `
        + `ledger (${settlement.reason}). A manual retry is too late for the remote to deduplicate `
        + 'it, so retrying could post a second payment. Check the ledger for an existing payment '
        + 'against this document before acting.',
    }
  }

  return { action: 'allow' }
}

/**
 * Split one scope's ALLOWED candidates into the row to revive and the rows that must wait.
 *
 * "Retry All" put every allowed id into a single `updateMany`. Two FAILED INVOICE_PAYMENT rows
 * sharing a token are both allowed — correctly, they are not ambiguous — but reviving both makes
 * two live rows in one scope: PostgreSQL rejects the statement on the partial unique index, and
 * because the statement is atomic NOTHING in that bulk retry is reset, including unrelated safe
 * scopes (Codex review). For BILL_PAYMENT, which the index does not cover, the same input simply
 * posts two supplier payments.
 *
 * `allowed` must arrive OLDEST FIRST. The oldest postable row is chosen for the same reason
 * `planFollowUpEnqueue` pins the oldest postable body: under a shared token the remote returns
 * the request that reached it first, so any other body would record a settlement the ledger never
 * made. A row too incomplete to post is never the canonical one — it would strand the scope
 * behind a request that can only fail.
 */
export function selectRevivableCandidates<T extends { id: string; payload: unknown }>(
  type: string,
  allowed: T[],
): { revive: T[]; deferred: T[] } {
  if (!revivesAtMostOnePerScope(type) || allowed.length <= 1) return { revive: allowed, deferred: [] }
  const canonical = allowed.find((row) => couldHaveReachedTheLedger(type, row.payload)) ?? allowed[0]!
  return { revive: [canonical], deferred: allowed.filter((row) => row.id !== canonical.id) }
}

/** The message a deferred row gets, so an operator is never left with a silent no-op. */
export function deferredRevivalReason(reference: string, kept: string): string {
  return `Only one entry for ${reference} can be queued at a time, so ${kept} was re-queued and the `
    + 'others were left failed. Retry them once it has finished if they are still needed.'
}

/**
 * The token a row actually posted under.
 *
 * Connector-specific ON PURPOSE. QuickBooks has always honoured the generic queue's
 * `_idempotencyKey`; Xero's payment branches have always ignored it and derived from the row
 * id. Folding them together here would misreport one connector's history and could refuse — or
 * worse, allow — the wrong retries.
 */
export function effectiveTokenFor(
  connector: 'xero' | 'quickbooks',
  row: { id: string; payload: unknown },
): string {
  const stamped = readFollowUpIdempotencyKey(row.payload)
  if (stamped) return stamped
  if (connector === 'quickbooks') {
    const generic = asPayload(row.payload)?._idempotencyKey
    // `typeof === 'string'`, NOT a truthiness or trim check — this must mirror
    // getIdempotencySource EXACTLY. That accepts an empty string as the source, so two rows
    // both carrying `_idempotencyKey: ''` post under the SAME token; requiring a non-blank
    // value here gave them their row ids instead, two distinct tokens, and refused a retry
    // that was safe. A guard that reasons about a token the connector will not actually send
    // is worse than no guard, and it fails in the stranding direction.
    if (typeof generic === 'string') return generic
  }
  return row.id
}

export { FOLLOW_UP_IDEMPOTENCY_KEY }
