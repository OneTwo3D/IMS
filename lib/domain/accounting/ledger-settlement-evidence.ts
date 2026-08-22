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

/**
 * Why a settlement question could not be answered. See `SettlementVerdict`'s `unknown` arm.
 *
 *  - `probe-unreadable`      the connector could not be asked at all.
 *  - `record-unmeasurable`   the ledger reported a settlement whose amount or date is unreadable,
 *                            so it cannot be ruled out as this attempt.
 *  - `attempt-undescribable` OUR row does not record what its attempt sent.
 */
export type SettlementUnknownCause = 'probe-unreadable' | 'record-unmeasurable' | 'attempt-undescribable'

export type SettlementVerdict =
  /** Positively established: the ledger holds no settlement matching this attempt. */
  | { outcome: 'clear' }
  /**
   * Positively established: it does. Re-posting would very likely duplicate it — and `matchedId`
   * is what an operator's reconciliation writes back, so the row records WHICH settlement it was
   * rather than merely that one existed.
   */
  | { outcome: 'present'; detail: string; matchedId: string | null }
  /**
   * Not established either way. Treated exactly as `present` by every caller that is judging an
   * attempt which may already have been sent.
   *
   * `cause` says WHICH of the three unknowns it is, because they are not interchangeable to a
   * caller deciding a FIRST post. `probe-unreadable` and `record-unmeasurable` are statements
   * about the LEDGER — something may be there and we cannot see it. `attempt-undescribable` is a
   * statement about OUR OWN ROW — the payload does not pin an amount and a date, so there is
   * nothing to look for. A first attempt in a scope nothing has ever been sent from can safely
   * ignore the third (it has no lost attempt to be uncertain about) and must not ignore the
   * other two. Without the discriminator that distinction can only be made by matching on
   * `reason`, which is prose.
   */
  | { outcome: 'unknown'; reason: string; cause: SettlementUnknownCause }

/** Money compares to the half-penny, the same tolerance the registration guard uses. */
const AMOUNT_EPSILON = 0.005

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/* ------------------------------------------------------------------------------------------- *
 * THE DATE A MONEY POST CARRIES — ONE definition, called by the processors AND by this module.
 * ------------------------------------------------------------------------------------------- */

/**
 * Which payload field a money post takes its date from — and it is NOT the same field for every
 * type, which is the entire reason this table exists (Codex round 6, finding 1).
 *
 *   INVOICE_PAYMENT / BILL_PAYMENT           `paymentDate`   (both connectors)
 *   PURCHASE_CREDIT_NOTE_ALLOCATION          `date`          (Xero only; QuickBooks has no branch)
 *
 * Round 5 wrote a "mirror" that read `paymentDate ?? date` for every type. That is not either
 * processor: it AVERAGES two conventions, and an average is wrong for both wherever they differ.
 * A bill payment carrying a `date` (the bill's own date, months old) was predicted to post on
 * that day when the processor would in fact post TODAY — so the probe looked for a settlement on
 * a day the post will never create, found none, and authorised a second payment onto an invoice
 * a human had already settled today. A mirror that drifts reintroduces exactly the bug it was
 * written to close, which is why there is no longer a mirror: there is one function, and the
 * processors call it.
 *
 * A type missing from this table is UNSENDABLE rather than defaulted. A fourth money-moving type
 * added without a line here fails visibly at the post instead of silently inheriting a
 * convention that may not be its own, and `tests/accounting/ledger-settlement-evidence` asserts
 * the table covers every type `isMoneyMovingSyncType` admits.
 */
const MONEY_POST_DATE_FIELD: Readonly<Record<string, 'paymentDate' | 'date'>> = {
  INVOICE_PAYMENT: 'paymentDate',
  BILL_PAYMENT: 'paymentDate',
  PURCHASE_CREDIT_NOTE_ALLOCATION: 'date',
}

/** Exported for the test that keeps the table in step with the money-moving type set. */
export function moneyPostDateFieldFor(type: string): 'paymentDate' | 'date' | null {
  return MONEY_POST_DATE_FIELD[type] ?? null
}

export type MoneyPostDate =
  /** The payload pins this, and it is the string that will go on the wire verbatim. */
  | { kind: 'pinned'; date: string }
  /** The payload pins nothing, so the post is dated from the wall clock AT POST TIME. */
  | { kind: 'wall-clock' }
  /** No post can be built from this payload at all — see below. */
  | { kind: 'unsendable'; reason: string }

/**
 * What a money post of `type` will date itself, decided from the payload alone.
 *
 * Reproduces `(payload[field] as string)?.slice(0, 10) || today` because that expression WAS the
 * processors, and every one of its corners is load-bearing:
 *
 *  - absent/null  →  `?.` short-circuits, `|| today` fires. `wall-clock`.
 *  - `''`         →  slices to `''`, which is falsy, so `|| today` fires too. `wall-clock`.
 *  - `'2026-08'`  →  slices to `'2026-08'`, which is TRUTHY, so it is sent verbatim. `pinned`,
 *                    and the caller — not this function — decides what can be compared with it.
 *  - a non-string →  `.slice` is not a function and the branch throws before any HTTP call. That
 *                    throw is reported as `unsendable` instead, which fails the row cleanly rather
 *                    than as an unhandled exception, and posts exactly as little money: none.
 *                    (An ARRAY is the one non-string with a `.slice`, so it used to be sent as a
 *                    JSON list where a date belongs. It is now refused with everything else.)
 */
export function moneyPostDate(type: string, payload: unknown): MoneyPostDate {
  const field = moneyPostDateFieldFor(type)
  if (!field) {
    return { kind: 'unsendable', reason: `IMS does not know which payload field dates a ${type} post` }
  }
  const raw = asRecord(payload)[field]
  if (raw === undefined || raw === null) return { kind: 'wall-clock' }
  if (typeof raw !== 'string') {
    return { kind: 'unsendable', reason: `${field} is ${Array.isArray(raw) ? 'a list' : typeof raw}, not a date` }
  }
  const sent = raw.slice(0, 10)
  return sent === '' ? { kind: 'wall-clock' } : { kind: 'pinned', date: sent }
}

/**
 * THE VALUE THE PROCESSORS SEND. Both connectors' money branches call this and put `date` on the
 * wire; nothing else in either processor computes a payment date. That is what makes drift
 * impossible rather than merely unlikely — the probe is not claiming to match the processors, it
 * is asking the same function the same question.
 */
export function moneyPostDateToSend(
  type: string,
  payload: unknown,
  now: Date,
): { ok: true; date: string } | { ok: false; reason: string } {
  const planned = moneyPostDate(type, payload)
  if (planned.kind === 'unsendable') return { ok: false, reason: planned.reason }
  return { ok: true, date: planned.kind === 'pinned' ? planned.date : now.toISOString().slice(0, 10) }
}

/**
 * The sent value, but only when the LEDGER will hold it in a form this module can compare.
 *
 * Knowing exactly what goes on the wire is not the same as knowing what comes back. `'2026-08'`
 * is sent verbatim and Xero stores whatever it makes of it, so comparing the string we sent
 * against the date it reports is a match that can never happen — a false CLEAR with extra steps.
 * Null instead, which reads as `attempt-undescribable`, and the fence answers that by refusing on
 * whatever the ledger visibly holds.
 *
 * EXPORTED so the POST fence can ask it about the date its CALLER already resolved (Codex round 7,
 * HIGH #1). It takes the sent string and nothing else — there is no clock in it — which is what
 * makes it impossible for the fence to arrive at a different day from the post it is authorising.
 */
export function comparableAttemptDate(sent: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(sent) ? sent : null
}

/**
 * The date an attempt ALREADY MADE carries, or null when the row does not pin one.
 *
 * Null for `wall-clock` on purpose: the attempt was dated when it RAN, which may have been days
 * ago, so today is not evidence of anything.
 */
export function pinnedAttemptDate(type: string, payload: unknown): string | null {
  const posted = moneyPostDate(type, payload)
  return posted.kind === 'pinned' ? comparableAttemptDate(posted.date) : null
}

/**
 * THE DATE AN UNSENT ATTEMPT WILL CARRY IS NOT RESOLVED TWICE (Codex round 7, HIGH #1).
 *
 * There used to be a `plannedAttemptDate(type, payload, now)` here, and the POST fence called it
 * with a clock of its own while the processor called `moneyPostDateToSend` with another. One
 * shared function was not enough: its wall-clock arm reads whatever `Date` it is handed, so the
 * two calls straddling a UTC midnight authorised against 2026-08-19 and posted 2026-08-18. A
 * settlement a human made on the 18th was then searched for on the 19th, not found, and a second
 * payment authorised — the weakened match IS the double post, not a harmless imprecision.
 *
 * So the resolver is deliberately absent, and `moneyPostDateToSend` is called ONCE per post, by
 * the processor branch that puts the value on the wire; the fence receives that value as
 * `postingDate` and compares it through `comparableAttemptDate`. There is no second caller to
 * drift from because there is no second call.
 */

export function describeAttempt(
  /** Which money-moving type this row is: the date convention is per type, never per payload. */
  type: string,
  payload: unknown,
  marker?: string | null,
  /**
   * `postingOn` fills in the date ONLY when the payload pins none, and is only sound for an
   * attempt about to be sent — it must be the date that post is ACTUALLY sending, resolved once
   * by the caller (see the note where `plannedAttemptDate` used to be). Callers judging a past
   * attempt must omit it.
   */
  options?: { postingOn?: string | null },
): AttemptDescription {
  const record = asRecord(payload)
  const amount = record.amount
  return {
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    date: pinnedAttemptDate(type, payload) ?? options?.postingOn ?? null,
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
      cause: 'probe-unreadable',
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
      cause: 'attempt-undescribable',
      reason: 'this row does not record the amount and date its attempt sent, so a matching '
        + 'settlement in the ledger cannot be identified',
    }
  }

  for (const record of probe.records) {
    if (record.amount === null || record.date === null) {
      return {
        outcome: 'unknown',
        cause: 'record-unmeasurable',
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
