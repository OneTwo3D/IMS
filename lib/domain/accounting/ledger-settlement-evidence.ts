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

import { payloadExactAmount } from '@/lib/domain/accounting/registered-amount'
import { compareDecimal, ledgerMatchEpsilon, subtractMoney, type Decimal } from '@/lib/domain/math/decimal'

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
  /**
   * In the document's currency, as posted — the EXACT figure, or null when there is not one this
   * module may compare (o3d-78rq).
   *
   * A `Decimal`, and never the connector's wire number. The probes read it through
   * `readLedgerStatedAmount`, which admits a value only when its decimal reading is PROVABLY the
   * figure the ledger stated: below `ledgerAmountMagnitudeBound` two amounts one minor unit apart
   * land on different doubles, and the reading is quantized to the currency's own minor unit, so
   * exactly one stateable token names it. Null therefore covers two different facts and
   * `unreadableAmount` below says which — see it for why the difference is the operator's.
   */
  amount: Decimal | null
  /**
   * o3d-78rq — THE LEDGER DID STATE AN AMOUNT AND THIS CONNECTOR WOULD NOT READ IT, as received.
   *
   * Set only when `amount` is null BECAUSE the figure was refused, never when the ledger reported no
   * amount at all. Both are `record-unmeasurable` and both WITHHOLD, and that is deliberate: the
   * refusal direction is the safe one here, because an unrecognised record of our own payment posts a
   * second one. But they are not the same sentence to a human. "Xero did not state an amount on this
   * payment" sends an operator to Xero; "Xero stated 35184372088832.055, which IMS cannot read as an
   * exact GBP amount" tells them the figure is the problem and stops them reading the hold as
   * evidence the document is unpaid. So the figure is carried, verbatim, for that sentence alone.
   */
  unreadableAmount?: string | null
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
  /**
   * WHAT THIS ATTEMPT SENT, EXACTLY (o3d-78rq) — a `Decimal`, read by `payloadExactAmount`.
   *
   * It was the payload's JSON number, and the band it is measured against became exact and
   * currency-derived in o3d-6yho without either operand following it. An exact tolerance over two
   * doubles decides nothing the tolerance says: our own attempt of `1073741824.0050` against a ledger
   * that holds `1073741824.00` is EXACTLY the band apart and therefore the same payment, and the two
   * doubles are 0.005000114440917969 apart — over it, `clear`, and a second payment posts.
   *
   * The exact figure is the payload's `amountDecimal` where the enqueue wrote one (o3d-1xq8), and
   * otherwise the number's OWN decimal reading, which is exact where the subtraction was not.
   */
  amount: Decimal | null
  /**
   * o3d-6yho (2 of 3) — THE CURRENCY THAT AMOUNT IS IN, which sizes the band the match below runs
   * on. Read from the payload (every money payload states one) or supplied by a caller that holds
   * the document's own. `null` = not stated, and `ledgerMatchEpsilon` resolves that in the direction
   * that WITHHOLDS a post rather than the one that sends a second — see its docblock, which is the
   * only rule in this repository where the finest unit is the wrong default.
   */
  currency: string | null
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

/**
 * `AMOUNT_EPSILON` WAS HERE, AND IS GONE (o3d-6yho, 2 of 3).
 *
 * It was a flat `0.005` — "the half-penny, the same tolerance the registration guard uses" — and both
 * halves of that sentence stopped being true. The registration guard now derives its band from the
 * document's minor unit, and a half-penny is FIVE whole minor units in a Gulf dinar and fifty in CLF,
 * so this test read two payments a ledger states as different amounts as the same one.
 *
 * The replacement is `ledgerMatchEpsilon(attempt.currency)`, which is 0.005 exactly in every
 * two-decimal currency. See its docblock for why this rule, alone in the repository, must not take
 * the finest unit for an unstated currency.
 */

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
  const currency = record.currency
  return {
    // o3d-78rq: the payload's exact decimal, through the one reader that knows how a money payload
    // states its amount. `payloadExactAmount` prefers the `amountDecimal` string the enqueue writes
    // beside the number and falls back to the number's own decimal reading, so a historical row is
    // described exactly as its number always read and a row written since is described as the figure
    // that was actually registered.
    amount: payloadExactAmount(payload),
    // o3d-6yho: from the payload the attempt was built from — every money payload writer states it
    // (both connectors' INVOICE_PAYMENT follow-ups, the receipt enqueue, and markBillPaid's
    // BILL_PAYMENT), so the ordinary row names its own currency and nothing has to be inferred.
    currency: typeof currency === 'string' && currency ? currency : null,
    date: pinnedAttemptDate(type, payload) ?? options?.postingOn ?? null,
    marker: marker ?? null,
  }
}

/**
 * A money figure for an operator sentence — NEVER ROUNDED, and money-shaped where it can be.
 *
 * o3d-78rq. It was `value.toFixed(2)` over a `number`, and o3d-4ozd's finding is that a presentation
 * which rounds can print two figures this verdict tells apart as the same text: a settlement of
 * `1073741824.005` and one of `1073741824.01` are a DIFFERENT payment here, and "the ledger already
 * holds 1073741824.01" would be the wrong figure to go looking for in Xero.
 *
 * So the places are `max(2, the figure's own)`: two is what every operator sentence on this path has
 * always shown and it keeps a whole ten pounds reading as `10.00`, while a figure carrying more than
 * two decimals is shown at ITS OWN scale rather than rounded to fit. `Decimal.toFixed` never uses
 * exponential notation, so a large amount stays readable as digits at either width.
 */
/**
 * o3d-r948 r2 — EXPORTED, because the settlement PROBES print figures too and were rounding them.
 *
 * Their completeness refusals said `applied.toFixed(2)`, which was harmless while their band was a
 * flat half-penny and is not once the band is a fraction of the document's own minor unit: a KWD
 * invoice one fil short produced "Xero reports 0.00 paid against this document but returned no
 * payments" — a sentence that reads as an arithmetic error rather than as the shortfall it is. The
 * rule is the same rule, so it is the same function.
 */
export function formatLedgerMoney(value: Decimal): string {
  return value.toFixed(Math.max(2, value.decimalPlaces()))
}

const money = formatLedgerMoney

/**
 * o3d-r948 r3 (Codex HIGH) — WHAT THE CALLER KNOWS THAT THE RECORD ITSELF CANNOT SAY.
 *
 * A settlement record carries an id the ledger assigned and cannot change, and that id says nothing
 * about WHOSE attempt made it. The fact that turns it into an identity is held by IMS, not by the
 * connector: `AccountingSyncLog.externalTransactionId` is the settlement id a completed money post
 * returned, so the rows for a document name the settlements those rows created.
 *
 * A caller that holds those rows may hand over the ids belonging to attempts OTHER THAN the one
 * being judged, and a record carrying one of them is excluded from the match — see the loop in
 * `classifyLedgerSettlement` for why nothing weaker may exclude anything.
 *
 * THE ATTEMPT'S OWN RECORDED ID MUST NEVER BE IN HERE. It names the settlement this very attempt
 * created; excluding it would skip the one record that proves the post already happened, which is
 * the exact `clear` this whole module exists to prevent. Callers build the set by removing the
 * attempt under judgement from the rows they hold, by identity, not by any field.
 */
export type LedgerSettlementOptions = {
  /**
   * Ledger settlement ids IMS has already recorded against attempts that are NOT the one being
   * judged. Nulls and blanks are ignored, and the comparison is case-folded because a ledger GUID
   * is returned in whatever case the connector feels like.
   */
  settlementsOfOtherAttempts?: Iterable<string | null | undefined>
}

function foldedIdentitySet(ids: Iterable<string | null | undefined> | undefined): ReadonlySet<string> {
  const folded = new Set<string>()
  for (const id of ids ?? []) {
    if (typeof id !== 'string') continue
    const key = id.trim().toLowerCase()
    if (key) folded.add(key)
  }
  return folded
}

/**
 * Decide what the ledger says about ONE attempt. Pure: the probe's I/O is the caller's problem, so
 * the rule that decides whether money may move again is unit-testable without a network.
 */
export function classifyLedgerSettlement(
  attempt: AttemptDescription,
  probe: LedgerSettlementProbe,
  options?: LedgerSettlementOptions,
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

  // o3d-r948 r3 (Codex HIGH) — A RECORD LEAVES THIS LOOP ONLY ON AN IMMUTABLE IDENTITY.
  //
  // WHAT r2 DID AND WHY IT WAS WRONG. r2 skipped a record whose READABLE half already differed from
  // the attempt — a different date, or an amount outside the band — on the reasoning that the match
  // rule is a conjunction, so either half failing rules the record out. The conjunction is right and
  // the conclusion does not follow, because this module's whole model is that AMOUNTS AND DATES ARE
  // MUTABLE: both are editable in both ledgers, which is the reason the mark exists (see
  // `settlementMarkerFor`) and the reason an unreadable figure withholds at all. A record whose date
  // is not this attempt's is therefore NOT proof it is somebody else's — it is equally consistent
  // with OUR OWN payment, edited in the ledger after we made it. r2 turned that ambiguity into
  // permission to post again: skip the only record on the document, fall out of the loop, `clear`,
  // and the retry/re-enqueue caller pays it twice. A discriminator that the ledger can rewrite can
  // never CLEAR; it can only ever match.
  //
  // WHAT AN IDENTITY HAS TO BE TO RULE A RECORD OUT. Assigned by the ledger, and unchangeable there
  // afterwards. Here is what each connector actually puts on a settlement record, and which side of
  // that line it falls:
  //
  //   Xero INVOICE_PAYMENT / BILL_PAYMENT
  //       `Payment.PaymentID`  — IMMUTABLE. Xero mints it and never re-assigns it; a payment can be
  //                              deleted but not renumbered.
  //       `Payment.Reference`  — MUTABLE. It is the operator-visible reference field, editable in
  //                              the Xero UI, and it is where IMS writes its own mark.
  //   QuickBooks INVOICE_PAYMENT / BILL_PAYMENT
  //       `Payment.Id` / `BillPayment.Id` — IMMUTABLE, and read here off the DOCUMENT's own
  //                              `LinkedTxn.TxnId`, so it is QuickBooks' statement about what settles
  //                              this document rather than ours.
  //       `PrivateNote`        — MUTABLE. Editable on the transaction; IMS's mark lives in it.
  //   Xero PURCHASE_CREDIT_NOTE_ALLOCATION
  //       NOTHING. The allocation carries no id this probe reads and no reference field exists on it
  //       at all. This type has no identity, so it can never be ruled out — see below.
  //   QuickBooks PURCHASE_CREDIT_NOTE_ALLOCATION
  //       Never reaches here: `probeQuickBooksSettlement` refuses the type outright.
  //
  // NEITHER CONNECTOR ECHOES OUR REQUEST ID. Xero's `Idempotency-Key` and QuickBooks' `requestid` are
  // request headers/params; neither is stored on, or returned with, the settlement entity. So the
  // only thing IMS can recognise on a record it did not just create is the MARK it wrote into the
  // mutable reference — which is why the mark pass above returns `present` and nothing here uses a
  // reference to return `clear`. The asymmetry is deliberate and it is the whole rule: a mutable
  // field may only ever move a verdict TOWARDS withholding.
  //
  // SO THE ONE EXCLUSION IS: this record's immutable id is one IMS has ALREADY RECORDED as a
  // DIFFERENT attempt's settlement. `AccountingSyncLog.externalTransactionId` holds exactly that for
  // these types — the Xero money branch stores `Payments[0].PaymentID` and the QuickBooks ones store
  // `Payment.Id` / `BillPayment.Id` — so a caller holding the other rows for this document can hand
  // their recorded ids over. A record whose id is in that set was created by an attempt that is not
  // this one, and no edit to its amount, its date or its reference can make it this one.
  //
  // A CALLER THAT CANNOT SUPPLY THE SET PASSES NOTHING, and then nothing is excluded and every
  // unmeasurable record withholds. That is the honest answer rather than a degraded one: the cost of
  // holding a genuine payment back is a visible refusal, and the cost of the alternative is a second
  // payment.
  const excluded = foldedIdentitySet(options?.settlementsOfOtherAttempts)
  for (const record of probe.records) {
    // The identity test, and the ONLY thing in this loop allowed to reach `continue` before the
    // record has been measured. Folded, because a ledger GUID comes back in whatever case it feels
    // like and `4D8A…` is the same payment as `4d8a…`.
    if (typeof record.id === 'string' && excluded.has(record.id.trim().toLowerCase())) continue
    if (record.amount === null || record.date === null) {
      return {
        outcome: 'unknown',
        cause: 'record-unmeasurable',
        // o3d-78rq — AND IT SAYS WHICH, because the two facts send an operator to different places.
        // A figure this connector REFUSED is a statement about the reading, not about the document:
        // the hold is not evidence that nothing has been paid, and the sentence must not let anyone
        // read it that way. See `LedgerSettlementRecord.unreadableAmount`.
        reason: record.unreadableAmount
          ? `the accounting connector reported a settlement${record.id ? ` (${record.id})` : ''} `
            + `stating ${record.unreadableAmount}, which IMS cannot read as an exact amount`
            + `${attempt.currency ? ` in ${attempt.currency}` : ''} — so this attempt cannot be ruled `
            + 'out against it. This says the LEDGER\'S FIGURE is unreadable, NOT that the document '
            + 'is unpaid.'
          : 'the accounting connector returned a settlement whose amount or date could not be '
            + 'read, so it cannot be ruled out as this attempt',
      }
    }
    // o3d-6yho: half one minor unit of the attempt's OWN currency.
    //
    // o3d-78rq — AND BOTH OPERANDS ARE NOW DECIMALS, so the band decides what the band says. It was
    // `Math.abs(record.amount - attempt.amount) <= ledgerMatchEpsilon(...).toNumber()`: an exact,
    // currency-derived tolerance spent back to a double to meet two doubles. Two figures ONE
    // THOUSANDTH apart can decode to doubles a whole ulp apart once the ulp exceeds the band —
    // `35184372088832.0035` decodes to `35184372088832` and `35184372088832.0045` to
    // `35184372088832.0078125`, 0.0078 apart against a 0.005 band — and the failure direction of THIS
    // rule is the one that posts a second payment. Nothing is converted now: the attempt carries its
    // payload's exact decimal, the record carries the ledger's stated figure, and the band stays a
    // `Decimal` all the way into the comparison.
    if (compareDecimal(subtractMoney(record.amount, attempt.amount).abs(), ledgerMatchEpsilon(attempt.currency)) <= 0
      && record.date === attempt.date) {
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
