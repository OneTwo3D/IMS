import {
  FOLLOW_UP_IDEMPOTENCY_KEY,
  isMoneyMovingFollowUp,
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
 */

export type RetryCandidateRow = {
  id: string
  /** The token this row's attempt actually posted under, as its own connector derives it. */
  effectiveToken: string
  payload: unknown
}

export type ManualRetryPlan =
  | { action: 'allow' }
  | { action: 'refuse'; reason: string; tokenCount: number }

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
  if (!isMoneyMovingFollowUp(type)) return { action: 'allow' }

  const contenders = siblings.filter((row) => couldBeTheSameDocument(row.payload, target.payload))
  const tokens = new Set(contenders.map((row) => row.effectiveToken))
  if (tokens.size <= 1) return { action: 'allow' }

  return {
    action: 'refuse',
    tokenCount: tokens.size,
    reason: `${tokens.size} failed attempts for ${reference} posted under different idempotency keys. `
      + 'Any one of them may have reached the ledger, so retrying could duplicate a payment. '
      + 'Reconcile them in the accounting system, then resolve these rows manually.',
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
    if (typeof generic === 'string' && generic.trim()) return generic
  }
  return row.id
}

export { FOLLOW_UP_IDEMPOTENCY_KEY }
