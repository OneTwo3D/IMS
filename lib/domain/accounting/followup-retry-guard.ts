import {
  FOLLOW_UP_IDEMPOTENCY_KEY,
  readFollowUpIdempotencyKey,
  type FollowUpPayload,
} from './followup-idempotency'

/**
 * o3d-0m56 — the manual retry must refuse what the automatic enqueue refuses.
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
 * WHAT IS ALREADY SAFE, and must keep working:
 *
 *   - a single FAILED row in its scope. The retry preserves the row id and payload, so the
 *     token is bit-identical to the one the failed attempt used and the remote deduplicates.
 *   - several FAILED rows that SHARE one token — the ordinary QuickBooks shape, where repeated
 *     receipts all carry `invoice-payment:payment:<paymentId>`. Whichever committed, committed
 *     under that token. Refusing these on row count alone is the mistake o3d-h2wx already
 *     corrected once in the automatic path.
 *   - anything that is not money-moving. A duplicate PDF or email is not a financial error.
 *
 * So the refusal is narrow by construction: money-moving, same target document, more than one
 * distinct token.
 *
 * Ambiguity means UNRESOLVED outcomes, not merely several rows -- see UNRESOLVED_STATUSES.
 */

export type RetryCandidateRow = {
  id: string
  /** The token this row's attempt actually posted under, as its own connector derives it. */
  effectiveToken: string
  payload: unknown
  /** Sync status. Absent is treated as UNRESOLVED, which is the conservative reading. */
  status?: string | null
}

/**
 * Statuses whose remote OUTCOME IS UNKNOWN, and the only ones that create ambiguity.
 *
 *   FAILED      — may have posted before the failure was recorded.
 *   PENDING     — has not been attempted, but will be.
 *   PROCESSING  — may be mid-flight right now.
 *
 * Deliberately NOT here:
 *
 *   CANCELLED — proven never attempted. Counting it permanently blocked a corrected row: a
 *     receipt deleted while still PENDING is safely cancelled without ever reaching the
 *     connector, yet its complete payload and distinct token refused its replacement forever
 *     (Codex review).
 *
 *   SYNCED — its outcome is KNOWN, so it is not ambiguity. This is a reversal of an earlier
 *     revision that counted it as "the strongest evidence available", and the reversal matters:
 *
 *       - retrying a FAILED row preserves its row id and payload, so it re-posts under ITS OWN
 *         token. If that token already reached the ledger the remote deduplicates. A sibling's
 *         success says nothing about whether THIS token posted;
 *       - counting it stranded two ordinary flows permanently, through the only manual route
 *         there is: a PART-PAYMENT history (two genuine payments against one invoice), and a
 *         payment that was reversed in the ledger and legitimately re-posted, where the stale
 *         SYNCED row blocks its own replacement forever (Codex review).
 *
 *     What it cannot distinguish is a SYNCED row that is the same logical payment re-created
 *     under a new token. In that situation the original FAILED row should be resolved rather
 *     than retried — and unlike the cases above, that one is visible to a human looking at the
 *     document.
 */
const UNRESOLVED_STATUSES = new Set(['FAILED', 'PENDING', 'PROCESSING'])

function outcomeIsUnknown(status: string | null | undefined): boolean {
  return status === null || status === undefined || UNRESOLVED_STATUSES.has(status)
}

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
 * Decide whether one manual retry may proceed. Pure, so the rule is testable without a
 * database and cannot drift from the automatic path's definition of ambiguity.
 *
 * `siblings` is every FAILED row in the target's scope, INCLUDING the target itself.
 */
export function planManualRetry(params: {
  type: string
  reference: string
  target: RetryCandidateRow
  siblings: RetryCandidateRow[]
}): ManualRetryPlan {
  const { type, reference, target, siblings } = params
  if (!isMoneyMovingSyncType(type)) return { action: 'allow' }

  const contenders = siblings
    // Only rows whose outcome is UNKNOWN create ambiguity. A CANCELLED row never posted and a
    // SYNCED row's fate is settled -- neither says anything about whether THIS row's token
    // reached the ledger, and counting them stranded legitimate payments permanently.
    .filter((row) => outcomeIsUnknown(row.status))
    // A sibling missing a field its connector requires was rejected BEFORE any HTTP call, so it
    // cannot have committed anything and must not make a valid payment un-retryable. Without
    // this, one malformed row permanently strands the good one through the only manual route
    // available (Codex review).
    .filter((row) => couldHaveReachedTheLedger(type, row.payload))
    .filter((row) => couldBeTheSameDocument(row.payload, target.payload))
  const tokens = new Set(contenders.map((row) => row.effectiveToken))
  if (tokens.size <= 1) return { action: 'allow' }

  return {
    action: 'refuse',
    tokenCount: tokens.size,
    reason: `${tokens.size} unresolved attempts for ${reference} were made under different `
      + 'idempotency keys. Any one of them may have reached the ledger, so retrying could '
      + 'duplicate a payment. Check the ledger for an existing payment against this document, '
      + 'then resolve these rows manually.',
  }
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
