/**
 * o3d-0m56 — POSITIVE evidence about what a money-moving attempt actually did to the ledger.
 *
 * THE HOLE THIS FILLS. Re-posting a FAILED money row under the token its attempt used is only
 * protective while the remote system still remembers that token. Xero retains an Idempotency-Key
 * for a documented window of MINUTES; a manual retry is by nature minutes to days later, so the
 * key it re-sends is processed as a brand-new request. QuickBooks' `requestid` replay is better
 * behaved, but "better behaved" is a claim about someone else's undocumented retention, and this
 * guard exists precisely because a lost response is indistinguishable from a failed call. So
 * neither connector's deduplication may be treated as a reason to skip the question.
 *
 * The question that CAN be answered is not "did the remote deduplicate?" but "is this attempt in
 * the ledger?". A committed payment is a durable, readable record. So before a previously-attempted
 * money row is re-posted, IMS reads the target document and looks for the settlement that attempt
 * would have created.
 *
 * WHAT COUNTS AS THE SAME SETTLEMENT: same amount, same date. Both are pinned at enqueue time and
 * both are sent verbatim, so if the attempt committed, a record with exactly those values exists.
 * The converse is not true — two genuinely distinct receipts of the same size on the same day are
 * indistinguishable — and that asymmetry is deliberate: a false MATCH strands a payment visibly,
 * a false CLEAR posts a second one silently.
 *
 * FAIL CLOSED, ALWAYS. Three different things can go wrong and all of them mean `unknown`:
 * the probe could not reach the ledger, the ledger returned a record we cannot measure (an
 * absent amount or date), or the ATTEMPT itself cannot be described (no amount, or no date —
 * the processors default a missing date to "today at post time", which is unreconstructable
 * after the fact). `unknown` is never treated as `clear`.
 */

import { createHash } from 'node:crypto'

/**
 * The mark IMS writes into the settlement it creates, so it can recognise its own work later.
 *
 * WHY AMOUNT AND DATE ARE NOT ENOUGH (Codex round 3). Both are editable in both ledgers. Correct a
 * committed payment's date in Xero and it stops matching the attempt that created it, while still
 * paying the invoice — so a retry would add a second one. A mark derived from the attempt's own
 * idempotency token is not editable by accident: it is written once, in the payment's reference
 * field, and a matching mark is proof of authorship in a way that a number and a day never are.
 *
 * Short by design — it shares a user-visible reference field with whatever the operator typed.
 * Twelve hex characters of a SHA-256 is 48 bits, which is not a collision anyone will meet across
 * one organisation's payments, and the token it is built from is already scoped to one document.
 */
export function settlementMarkerFor(effectiveToken: string): string {
  return `IMS-${createHash('sha256').update(effectiveToken).digest('hex').slice(0, 12)}`
}

/** One settlement already recorded against the target document, as the ledger reports it. */
export type LedgerSettlementRecord = {
  /** In the document's currency, as posted. Null when the ledger did not report one. */
  amount: number | null
  /** `YYYY-MM-DD`, normalised by the connector-specific probe. Null when unreadable. */
  date: string | null
  /** The remote id, carried only so a refusal can name it. */
  id?: string | null
  /**
   * The reference/note field IMS writes its mark into (Xero `Payment.Reference`, QuickBooks
   * `PrivateNote`). Null when the ledger does not expose one for this kind of settlement.
   */
  reference?: string | null
}

export type LedgerSettlementProbe =
  | { ok: true; records: LedgerSettlementRecord[] }
  | { ok: false; reason: string }

/** What a row's stored payload says its attempt sent. */
export type AttemptDescription = {
  amount: number | null
  /** `YYYY-MM-DD` as the processor would have sent it, or null when the row does not pin one. */
  date: string | null
  /**
   * The mark this attempt would have written, or null when the caller cannot derive one. Matching
   * it is DEFINITIVE — it survives an edit to the amount or the date, which the pair below does not.
   */
  marker: string | null
}

export type SettlementVerdict =
  /** Positively established: the ledger holds no settlement matching this attempt. */
  | { outcome: 'clear' }
  /**
   * Positively established: it does. Re-posting would very likely duplicate it — and `matchedId`
   * is what an operator's reconciliation writes back, so the row records WHICH settlement it was
   * rather than merely that one existed.
   */
  | { outcome: 'present'; detail: string; matchedId: string | null }
  /** Not established either way. Treated exactly as `present` by every caller. */
  | { outcome: 'unknown'; reason: string }

/** Money compares to the half-penny, the same tolerance the registration guard uses. */
const AMOUNT_EPSILON = 0.005

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * The date the connectors actually send.
 *
 * Both read `paymentDate` (payments) or `date` (allocations) and `.slice(0, 10)` it, falling back
 * to `new Date()` when it is absent. That fallback is why an absent date yields null here rather
 * than today's date: the attempt was dated when it RAN, which may have been days ago, so today is
 * not evidence of anything.
 */
function attemptDate(payload: Record<string, unknown>): string | null {
  for (const field of ['paymentDate', 'date'] as const) {
    const value = payload[field]
    if (typeof value === 'string' && value.trim().length >= 10) return value.slice(0, 10)
  }
  return null
}

export function describeAttempt(payload: unknown, marker?: string | null): AttemptDescription {
  const record = asRecord(payload)
  const amount = record.amount
  return {
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    date: attemptDate(record),
    marker: marker ?? null,
  }
}

function money(value: number): string {
  return value.toFixed(2)
}

/**
 * Decide what the ledger says about ONE attempt. Pure: the probe's I/O is the caller's problem, so
 * the rule that decides whether money may move again is unit-testable without a network.
 */
export function classifyLedgerSettlement(
  attempt: AttemptDescription,
  probe: LedgerSettlementProbe,
): SettlementVerdict {
  if (!probe.ok) {
    return {
      outcome: 'unknown',
      reason: `the accounting connector could not be asked what it already holds (${probe.reason})`,
    }
  }
  // THE MARK FIRST, and on its own terms. A settlement carrying this attempt's mark IS this
  // attempt, whatever has since been done to its amount or its date — which is exactly the case
  // the pair below cannot see. Checked across every record before anything else is judged.
  if (attempt.marker) {
    for (const record of probe.records) {
      if (typeof record.reference === 'string' && record.reference.includes(attempt.marker)) {
        return {
          outcome: 'present',
          matchedId: record.id ?? null,
          detail: `${record.amount === null ? 'a payment' : money(record.amount)}`
            + `${record.date ? ` dated ${record.date}` : ''} carrying this entry's own reference `
            + `${attempt.marker}${record.id ? ` (${record.id})` : ''}`,
        }
      }
    }
  }

  if (attempt.amount === null || attempt.date === null) {
    return {
      outcome: 'unknown',
      reason: 'this row does not record the amount and date its attempt sent, so a matching '
        + 'settlement in the ledger cannot be identified',
    }
  }

  for (const record of probe.records) {
    if (record.amount === null || record.date === null) {
      return {
        outcome: 'unknown',
        reason: 'the accounting connector returned a settlement whose amount or date could not be '
          + 'read, so it cannot be ruled out as this attempt',
      }
    }
    if (Math.abs(record.amount - attempt.amount) <= AMOUNT_EPSILON && record.date === attempt.date) {
      return {
        outcome: 'present',
        matchedId: record.id ?? null,
        detail: `${money(record.amount)} dated ${record.date}`
          + (record.id ? ` (${record.id})` : ''),
      }
    }
  }
  return { outcome: 'clear' }
}
